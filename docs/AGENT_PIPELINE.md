# Review agent: from a match ID to a review

```text
/r/:matchId  →  pick a hero  →  one click
  POST /api/agent/:id/prepare    replay → trace          (the worker)
  POST /api/agent/:id/review     trace → verified review (the model)
  POST /api/agent/:id/chat       questions, answered from the replay
```

Code: `lib/agent/` (pipeline, stores, service, router, agent, verifier),
`packages/review-engine/src/trace/` (the trace and its query tools),
`scripts/trace-worker.mjs` (the worker), `src/agent/` (the page).

## What runs where

| Piece | Where | Needs |
|---|---|---|
| Site (`server.js`) | the existing Cloud Run service | `DEEPSEEK_API_KEY`, `AGENT_BUCKET`, `TRACE_WORKER_URL`, `TRACE_WORKER_AUDIENCE` |
| Replay worker (`Dockerfile.trace-worker`) | a second, private Cloud Run service | the pinned extractor in the image, `AGENT_BUCKET` |
| Storage | one GCS bucket, objects under `agent/` | traces (`<id>.trace.json.gz`, ~250 KB), reviews, job markers |

The site never runs the extractor: its output is hundreds of megabytes of
memory-backed temp files. The worker does one parse at a time.

On one machine (development, or a VM that has the extractor) no worker is
needed: set `DOTA_EXTRACT_BIN`, `AGENT_TRACE_DIR` and `AGENT_REVIEW_DIR` and the
site parses in process.

## Jobs that outlive a deploy

A parse or a deep review takes minutes. Run as a background job of the
instance that took the click, it ends when that instance does (every deploy
replaces it), and Cloud Run gives almost no CPU to work outside a request.

With a queue configured the click only queues the job (Cloud Tasks). The queue
calls the site back at `POST /internal/agent/run`, and the work is done inside
that request, which is answered when the job is over:

- Cloud Run lets a request that is being processed finish when traffic moves
  to a new revision, so a deploy does not end a running review;
- the instance keeps its CPU for as long as the request runs, also after the
  reader closes the page;
- a delivery that fails (the instance crashed, or was stopped: the route
  answers 503) is made again, up to the queue's retry limit.

The route trusts only Google's ID token for the site's own service account
and URL; the service itself stays public. Without the three variables below,
or when queueing fails, jobs run in the background as before.

```bash
gcloud services enable cloudtasks.googleapis.com
gcloud tasks queues create agent-jobs --location "$REGION" \
  --max-attempts 5 --min-backoff 10s --max-backoff 120s --max-concurrent-dispatches 20
# The site queues tasks, and the queue calls back as the site's own service account.
gcloud tasks queues add-iam-policy-binding agent-jobs --location "$REGION" \
  --member "serviceAccount:$SITE_SA" --role roles/cloudtasks.enqueuer
gcloud iam service-accounts add-iam-policy-binding "$SITE_SA" \
  --member "serviceAccount:$SITE_SA" --role roles/iam.serviceAccountUser
# A review may take 15 minutes: the request that carries it must be allowed that long.
gcloud run services update <site-service> --region "$REGION" --timeout 1800 --min 1 \
  --update-env-vars AGENT_TASKS_QUEUE=projects/$PROJECT/locations/$REGION/queues/agent-jobs,AGENT_RUN_URL=$SITE_URL,AGENT_RUN_SA=$SITE_SA
```

### Older games are told their own patch's numbers

The site's item and ability tables are the current patch's. A game from an
earlier patch reads prices, recipes, item effects, cooldowns and spell-immunity
flags from `lib/data/constants/patches/<patch>.json`, written by
`scripts/coach-patch-snapshots.mjs` from OpenDota's constants repository as it
stood at the end of that patch (its last letter release: OpenDota's patch
number does not tell 7.41c from 7.41f). Items that did not exist then are not
offered. The game's patch is OpenDota's patch number when the match data has
it, else the release its start time falls after, else the release its match id
falls after: `lib/data/constants/patches/index.json` holds the ids on either
side of each release (`scripts/patch-match-ids.mjs`, start times from STRATZ),
so the patch is known even when OpenDota is down. An id inside a release's
boundary, or older than the kept patches, is not guessed: the current tables
are used and the tools say so (`data_patch`, gaps). The review records the
patch (`data_patch`) and the page shows it under the verdict, with a warning
when it could not be told. `scripts/refresh-data.mjs --all`
rebuilds the snapshots after a patch; run `scripts/patch-match-ids.mjs` (needs
`STRATZ_API_TOKEN`) a day after a release so the new boundary is in the index. Professional item shares span several
patches and are not split by patch.

### A review that was cut off continues

A request that is being processed is normally left to finish, but an instance
can still stop or crash mid-review. A running review therefore saves a
checkpoint after every finished round of lookups (`<review key>.checkpoint.json`:
the conversation so far and which tools were asked, not their answers). When
the review is started or delivered again it continues after that round instead
of asking the model for the whole investigation a second time; the tools'
answers are computed again from the replay, and the checkpoint is used only if
every one of them still reads as the model read it (same replay, same tools),
for the same hero, language and model, and less than an hour old. The
checkpoint is removed when the review is stored or fails.

`--min 1` keeps one instance warm (no cold start for the first reader after
a quiet spell or a deploy). The build trigger skips pushes that change only
tests, docs and CI files (`ignoredFiles` on the Cloud Build trigger), so a
merge that cannot change the running site does not roll a new revision.

## Deploying

The extractor is built from the companion repository and its checksum is
pinned there (`docs/REPLAY_EXTRACTOR_PIN.md`). Copy the verified binary into
the build context; the image never downloads one.

```bash
REGION=asia-east1
BUCKET=<agent-bucket>            # may be the match-cache bucket; objects go under agent/

# 1. Worker image, with the pinned extractor
mkdir -p vendor && cp /path/to/verified/dota-extract vendor/dota-extract
sha256sum vendor/dota-extract    # must match the pin
gcloud builds submit --tag "$REGION-docker.pkg.dev/$PROJECT/dota2ai/trace-worker" \
  --dockerfile Dockerfile.trace-worker .        # or: docker build -f Dockerfile.trace-worker

# 2. Worker service: private, one parse at a time
gcloud run deploy trace-worker \
  --image "$REGION-docker.pkg.dev/$PROJECT/dota2ai/trace-worker" \
  --region "$REGION" --memory 4Gi --cpu 2 --concurrency 1 \
  --min-instances 0 --max-instances 2 --timeout 900 \
  --no-allow-unauthenticated \
  --set-env-vars AGENT_BUCKET=$BUCKET

WORKER_URL=$(gcloud run services describe trace-worker --region "$REGION" --format 'value(status.url)')
WORKER_SA=$(gcloud run services describe trace-worker --region "$REGION" --format 'value(spec.template.spec.serviceAccountName)')
SITE_SA=$(gcloud run services describe <site-service> --region "$REGION" --format 'value(spec.template.spec.serviceAccountName)')

# 3. Permissions: the site may call the worker; both may use the bucket
gcloud run services add-iam-policy-binding trace-worker --region "$REGION" \
  --member "serviceAccount:$SITE_SA" --role roles/run.invoker
for SA in "$WORKER_SA" "$SITE_SA"; do
  gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
    --member "serviceAccount:$SA" --role roles/storage.objectAdmin
done

# 4. Point the site at them
gcloud run services update <site-service> --region "$REGION" \
  --update-env-vars AGENT_BUCKET=$BUCKET,TRACE_WORKER_URL=$WORKER_URL,TRACE_WORKER_AUDIENCE=$WORKER_URL
```

`--max-instances 2` on the worker with `--concurrency 1` is two parses at once;
a third caller gets "busy" from Cloud Run and the page offers to try again.

## What is deployed (2026-11-22)

Verified on Google Cloud, project `aegis-assistant-488913`, region `asia-east1`:

| Thing | Value |
|---|---|
| Worker | Cloud Run `dota2-ai-trace-worker`, private (anonymous calls get 403), 4 Gi / 2 CPU / concurrency 1, runs as the existing `dota2-ai-replay-worker-t348u` service account |
| Bucket | `aegis-assistant-488913-replay-facts-t348u`, objects under `agent/`; the site's, the preview's and the worker's service accounts already hold `objectAdmin` on it |
| Preview | `dota2-ai-preview`, revision tag `agent` (its own URL; the service's main traffic was left on its old revision), with `AGENT_BUCKET`, `TRACE_WORKER_URL`, `TRACE_WORKER_AUDIENCE` |
| Production site (`dota2-ai`) | **not changed.** It needs the same three variables (step 4 above) before a build containing the new match page is deployed, and `roles/run.invoker` on the worker for its service account |

Measured there on match 9100904020: worker alone 47 s (cold start included);
from the preview revision, prepare → trace in 36 s through the worker with a
metadata-server ID token, deep review 123 s with DeepSeek 4.1 Flash, chat fine.

**CPU outside requests.** The site service throttles CPU when no request is in
flight (`run.googleapis.com/cpu-throttling: true`). A parse or a review is a
background job on the instance that accepted the click; it advances while the
page polls every 2.5 s, which is the normal case. If every tab watching it is
closed, the job stalls until the next request to that instance, and after 10
(review) or 15 (parse) minutes its marker counts as dead, so the next visitor
is offered a fresh start. To make jobs independent of the page, deploy the
site with `--no-cpu-throttling` (billed for idle CPU) or move the review job to
the worker.

## Limits and cost

| What | Limit | Where |
|---|---|---|
| Parses | 3 per caller per 10 min; `AGENT_PARSE_DAILY_MAX` (default 300) a day | `lib/agent/router.js` |
| Deep reviews | 3 per caller per 10 min; 60 an hour; the shared LLM budget | same |
| Chat | 12 turns a minute per caller; 6 tool calls a turn; the shared LLM budget | same, `lib/agent/chat.js` |
| Download | 256 MB; extractor input 512 MB, output 1.5 GB | `replayIngest/capacity.js` |

Measured on one 42-minute game (9100904020): replay 51 MB; worker 22 s from
address to stored trace; deep review with DeepSeek 4.1 Flash (thinking on)
100–130 s, 130–270k input and 17–24k output tokens. A trace and a review are
made once per match / per (match, hero, language) and kept.

## Where the replay address comes from

`lib/agent/replaySource.js`. The match record first (OpenDota's `replay_url`,
or cluster + salt when the record came from the game coordinator). OpenDota
has an address only for games it has already dealt with, which most games
just played are not: then, if the Steam GC retriever is configured
(`STEAM_RETRIEVER_URL`), the coordinator is asked for cluster and salt. A GC
request is scarce (about a hundred a day per Steam account), so it is made
only when the record has no address.

## What can go wrong, and what the page says

| Reason | Meaning | Page |
|---|---|---|
| `replay_gone` | Valve no longer has the replay (about two weeks) | says so; scoreboard only; no retry |
| `no_replay_url` | no source has an address: the match record has none and the game coordinator was not configured, had no budget left, or does not know the match | "not ready yet", retry |
| `download_failed`, `extract_failed`, `worker_failed`, `timeout` | transient | "could not be read", retry (allowed again after 5 min) |
| `too_large`, `wrong_match` | over the caps; the file is not that match | final |

A running job leaves a marker in the store, so another instance reports
"running" instead of offering a second start; a marker older than 15 minutes
(parse) or 10 minutes (review) is treated as dead.

## Known follow-ups

- **A parse is claimed per instance, not across instances.** Two site
  instances that get a prepare for the same match in the same moment can both
  start it. The result is the same trace written twice, and each start counts
  against the caller's and the day's limits. Closing it needs a create-only
  write in the blob store plus an expiry rule for claims left by an instance
  that died.
- **Jobs depend on the page while CPU is throttled** (see above).
- **The chat answer arrives whole**, after the tool steps, not token by token.
- The older replay ingest (`lib/matchReview/replayIngest` job store, queue,
  `scripts/replay-worker.mjs`, the `dota2-ai-replay-worker` service) is not
  used by this path beyond its download, discovery, extractor and capacity
  modules, and can be retired.

## The rules that must not be weakened

- The replay address comes from the match record, must be a Valve / Perfect
  World replay host for that match, is fetched without following redirects and
  never from a private address (`replayIngest/discovery.js`, `download.js`,
  `replayUrlIsFor`). The worker checks it again.
- The worker is never public.
- A review states only what the tools returned: `verifyReview`
  (`lib/agent/deepReview.js`). Evidence shown to the reader is recomputed from
  the trace, not taken from the model (`lib/agent/evidence.js`).
- What the replay does not hold (vision, creeps, Roshan) is a stated gap.

## Net worth from the replay

The extractor's `trace/metadata.jsonl` carries the replay's match metadata,
including each player's `graph_net_worth`: one point per game minute, in tens
of gold (on 9100904020 the first point is 60, the 600 starting purse, and ×10
at the end is within 0.3% of every scoreboard net worth). The trace builder
keeps it as `net_worth` (gold, per hero, per minute) only when the first point
is a starting purse. The tools use OpenDota's `radiant_gold_adv` when the match
record has it, else the teams' summed net worth from the trace; the review page
draws the same curve, labelled as coming from the replay. A trace built before
this has no `net_worth`: it appears after the worker is redeployed and the
match is parsed again.
