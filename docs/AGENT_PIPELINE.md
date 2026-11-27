# Review agent: from a match ID to a review

```text
/r/:matchId  →  pick a hero  →  one click
  POST /api/agent/:id/prepare    replay → trace          (the worker)
  POST /api/agent/:id/review     trace → verified review (the model)
  POST /api/agent/:id/chat       questions, answered from the replay
  POST /api/agent/:id/feedback   a reader's word on one finding (no model)
```

Code: `lib/agent/` (pipeline, stores, service, router, agent, verifier),
`packages/review-engine/src/trace/` (the trace and its query tools),
`scripts/trace-worker.mjs` (the worker), `src/agent/` (the page).

## What runs where

| Piece | Where | Needs |
|---|---|---|
| Site (`server.js`) | the existing Cloud Run service | `DEEPSEEK_API_KEY` (and `KIMI_API_KEY`, `GLM_API_KEY` for the other models), `AGENT_BUCKET`, `TRACE_WORKER_URL`, `TRACE_WORKER_AUDIENCE` |
| Replay worker (`Dockerfile.trace-worker`) | two private Cloud Run services: `dota2-ai-trace-worker` (asia-east1) and the fallback `dota2-ai-trace-worker-hk` (asia-east2), one image; rebuilt and deployed to both on a merge that touches the image (`cloudbuild.trace-worker.yaml`) | the pinned extractor in the image, `AGENT_BUCKET`; the site's `TRACE_WORKER_FALLBACK_URL` / `_AUDIENCE` name the fallback |
| Storage | one GCS bucket, objects under `agent/` | traces (`<id>.trace.json.gz`, ~250 KB), reviews, job markers; under `agent/feedback/`, what readers said of a finding (right / wrong / not useful — `lib/agent/feedback.js`, read with `scripts/feedback-report.mjs`) |

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

### Older games are told their own release's numbers

The site's item and ability tables are the current release's. A game from an
earlier release — letter releases included (7.41b, 7.41c …) — reads prices,
recipes, item effects, cooldowns and spell-immunity flags from
`lib/data/constants/patches/<release>.json`. `scripts/coach-patch-snapshots.mjs`
builds them from Valve's game files (github.com/dotabuff/d2vpkr, one commit per
game update) with OpenDota's own builder, each as it rolled out. Items that did
not exist then are not offered.

Hotfixes between letters change numbers too (7.41f's hotfix of 7 October 2026
raised Necronomicon from 2050 to 2700 gold). Every game update within a release
whose item or ability data differs from the one before is a hotfix with its own
snapshot (`<release>.<date>T<hhmm>.json`, listed under the release's `hotfixes`
in the index, each with its rollout window and match ids), and a game is told
the numbers of the hotfix it was played on (`hotfix` in `data_patch`; the page
names it). An update OpenDota's builder cannot read is listed with `data: null`:
a game played on it is given the update before and told the numbers may differ
(not exact), never that update's numbers as if known. A game that started while
a hotfix was rolling out is in a known release but an unknown hotfix, and the
page says just that. A new hotfix's match ids come only once STRATZ has its
games; until then `ids_checked_to` (the newest match the id search looked at,
with its start) still places every game at or below that id before it, so only
games newer than that are told they may be on either side. Professional item shares stay per letter release (a hotfix
is too short for a pro sample).

`lib/data/constants/patches/index.json` lists the releases: when each rolled out
(the game update's commit; the repository is polled every 20 minutes, so the
rollout lies in the 20 minutes before it) and the match ids on either side
(`scripts/patch-match-ids.mjs`, start times from STRATZ; hotfixes too). A game's release is
read from its start time when the match data has one, else from its match id —
so it is known even when OpenDota is down. A game that started during a
rollout, one older than 7.40, or one known only by OpenDota's patch number
(which names the major patch, not the letter) is flagged as not exact; the
tools then say so (`data_patch`, gaps), and the page shows a warning under the
verdict instead of the release.

After a release: `scripts/refresh-data.mjs --all` (needs a dotaconstants
checkout for the snapshots, see the script), then `scripts/patch-match-ids.mjs`
(needs `STRATZ_API_TOKEN`) once STRATZ has the new games.

What professional players built (`pro_item_choices`, `build_check`) is counted
per release too (`scripts/coach-pro-items-by-release.mjs`, run by `--all` after
the snapshots; `lib/agent/proItems.js` reads it): a game is told the pro games
of its own release, with the releases just before it in the same patch added
when that release alone has fewer than 30 games of the hero, and never a later
release. A patch only days old gives what it has, marked `few_games`, and the
patch before is told apart, never mixed in. The counter items against each
enemy hero need many games of each pairing: they are still measured over whole
patches since the previous one, and a game older than that is told so.

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

On this deployment a merge to `main` that touches the worker's files does all of
this (trigger `dota2-ai-trace-worker` → `cloudbuild.trace-worker.yaml`): the
pinned extractor is fetched from the build bucket by its SHA-256 and checked,
the image is built and pushed, and both workers are updated. The steps below
are for a new deployment.

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
| Parses | 5 per caller per 10 min; `AGENT_PARSE_DAILY_MAX` (default 300) a day | `lib/agent/router.js` |
| Deep reviews | 5 per caller per 10 min; 60 an hour; the shared LLM budget | same |
| Deep reviews by a model other than DeepSeek | also `AGENT_MODEL_HOURLY_MAX` (default 20) an hour per model; 25 min to finish instead of 15. Both by what the model is, also when it is the server's default | same, `lib/agent/service.js`, `models.js` `writesSlowly` |
| Chat | 12 turns a minute per caller; 6 tool calls a turn; the shared LLM budget | same, `lib/agent/chat.js` |
| Download | 256 MB; extractor input 512 MB, output 1.5 GB | `replayIngest/capacity.js` |

Measured on one 42-minute game (9100904020): replay 51 MB; worker 22 s from
address to stored trace; deep review with DeepSeek 4.1 Flash (thinking on)
100–130 s, 130–270k input and 17–24k output tokens. A trace and a review are
made once per match / per (match, hero, language) and kept.

## Which model writes the review

The reader picks one on the review page; the default is DeepSeek 4.1 Flash.
`lib/agent/models.js` lists what a page may show (an id, a name, how long the
model took when timed); `lib/agent/providers.js` maps each id to its address,
upstream model name and key, and only the server and the scripts import it.

| id | Key | Offered by default |
|---|---|---|
| `deepseek-flash` | `DEEPSEEK_API_KEY` | yes (the default) |
| `kimi-k3.1-pro` | `KIMI_API_KEY` | yes |
| `glm-5.3-flash` | `GLM_API_KEY` | yes |
| `glm-5.3` | `GLM_API_KEY` | no: `AGENT_MODELS` |
| `glm-5.4` | `GLM_API_KEY` | no: the API answered 1220 (no access) on 2026-11-25 |

A model is offered when its key is set (and `AGENT_MODELS`, a comma separated
list of ids, does not leave it out). The page sends the id only. An id that is
not offered is a 400; a review is never written by a model the reader did not
ask for, and a failed review is not retried with another. Each model's review
of a game is kept on its own (`….m-<id>.review.json`), so the same game can be
read by two models; the key without a model is DeepSeek's, as every review was
stored before there was a choice, and stays DeepSeek's on a server whose
default is another model. A queued review names its model. The chat is
answered by the model whose review is on screen.

Keys: in the server's environment only, on Cloud Run from Secret Manager
(`--update-secrets`, never `--set-env-vars`), never in a `VITE_*` variable.
Every secret the process holds is redacted from its logs by value
(`lib/llmErrors.js` `registerSecretValues`), whatever its shape. A Kimi key is
sent to one of Kimi's four addresses and nowhere else (`KIMI_BASE_URL`): a
Kimi Code membership key (`sk-kimi-…`) to `api.kimi.com/coding/v1`, a Moonshot
platform key to `api.moonshot.cn/v1`.

Timed on 2026-11-25 on one game (9091400302, Tidehunter, Chinese, a 45-minute
game), thinking at each provider's default. "Script" is one run of
`scripts/deep-review.mjs` from a developer machine; "production" is a review
started from the site (DeepSeek: its runs of that game over the day):

| Model | Where | Time | Input / output tokens | Rounds, lookups | Findings | Dropped by the check |
|---|---|---|---|---|---|---|
| DeepSeek 4.1 Flash | production | 2.1–2.5 min | 244–538k / 22–27k | 5–10, 16 | 3 | 0 |
| Kimi K3.1 Pro | script | 13.4 min | 502k / 25k | 8, 26 | 3 | 0 |
| Kimi K3.1 Pro | production | 13.0 min | 541k / 25k | 9, 25 | 3 | 0 |
| GLM-5.3 Flash | script | 11.2 min | 359k / 35k | 7, 16 | 3 | 0 (one plan evidence line left out) |
| GLM-5.3 Flash | production | 13.2 min | 562k / 39k | 9, 16 | 3 | 0 (one plan evidence line left out) |
| GLM-5.3 | script | 23.6 min | 1,000k / 59k | 13, 21 | 3 | 0 |

These times are what the page tells a reader to expect (`models.js`
`minutes`, shown on each model's button, before the start and while the review
is being written): change them there when a model is timed again.

All of them named the same two things to change (staying in lane at low
health; magic resistance bought before Blink against a hero who kills with
attacks). The third finding differed: deaths away from the team that bought
nothing (DeepSeek, GLM), or fighting on outnumbered after Ravage (Kimi). In
the production runs GLM-5.3 Flash listed no blind spots and gave no main
reason, where the other two did. One game is not a ranking of their judgment;
it does show that the other models take five to ten times as long, which is
why the page states the wait and GLM-5.3 is not offered by default.

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
| `replay_gone` | Valve no longer has the replay (about two weeks): the download answered 404 / 410, **or no source has an address and the match record's own times prove the game ended more than 14 days ago** (start + duration; with no duration, only when it began more than 15 days ago; with no start time, never) | says so; scoreboard only; no retry |
| `no_replay_url` | no source has an address — the match record has none and the game coordinator was not configured, had no budget left, or does not know the match — for a game that ended within 14 days, or whose end time the record does not give | "not ready yet", retry |
| `download_failed`, `extract_failed`, `worker_failed`, `timeout` | transient | "could not be read", retry |
| `too_large`, `wrong_match` | over the caps; the file is not that match | final |

A failure that is not final is answered with `retry_in_sec`: until then, asking again gets the same failure and
starts nothing (60 s after `no_replay_url`, 10 s after anything else). An address that was not there a second ago is
not there now, and a double click must not start two downloads — on 2026-11-25 one old game was asked for nine times
in an hour, each a fresh parse that failed within a second. After five minutes the failure is forgotten.

A review that fails records why, from the model error's HTTP status and class only (the provider's text is never
logged or passed on; the class is read off the prototype chain, since the SDK's errors all have the name "Error"):

| Reason | From | What follows |
|---|---|---|
| `model_out_of_credit` | 402 | no review is started for 5 minutes: `unavailable` with this reason and `retry_in_sec`, at once; the page keeps its retry button |
| `model_refused_the_key` | 401, 403 | the same |
| `model_rate_limited` | 429 | that review failed; the next one is tried |
| `model_unavailable` | 5xx, the SDK's `APIConnectionError` | the same |
| `timeout` | the SDK's `APIConnectionTimeoutError` or `APIUserAbortError` (the review's own deadline), a `TimeoutError` / `AbortError` | the same |
| `error` | anything else | the same |

The log line is `deep-review error match=… hero=… : reason=<reason> status=<status> (<error class>)`.

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
is a starting purse and the graph is not denser than one point a game minute
(some replays hold about two a minute — 9080127650 has 63 for 31:47; then
nothing is kept and the trace's `gaps` says so). The tools use OpenDota's `radiant_gold_adv` when the match
record has it, else the teams' summed net worth from the trace; the review page
draws the same curve, labelled as coming from the replay. A trace built before
this has no `net_worth`: it appears after the worker is redeployed and the
match is parsed again.
