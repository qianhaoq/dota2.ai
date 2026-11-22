# Self-hosted replay parsing

"Parse this match" normally asks OpenDota to parse the replay. When OpenDota
is down, the site can do it itself:

```text
POST /api/review/:id/parse-request
  → Steam GC retriever     scoreboard + cluster + replay_salt   (services/steam-retriever)
  → Valve CDN (HEAD)       is the replay still there?
  → odota/parser /blob     downloads and parses the replay       (this document)
  → merge                  scoreboard + parse, in OpenDota's match shape
  → match cache            memory, and GCS when MATCH_CACHE_BUCKET is set
```

The page's existing 20-second polling picks the parsed match up. Code:
`lib/upstream/odotaParser.js`, `lib/matchReview/selfHostedParse.js`.

## When it is used

Only when both `ODOTA_PARSER_URL` and the Steam GC retriever
(`STEAM_RETRIEVER_URL` + `STEAM_RETRIEVER_SECRET`) are configured, and one of:

- `UPSTREAM_PRIMARY=steam_gc`;
- OpenDota's outage breaker is open (three failures in a row);
- the copy of the match the site holds already came from the GC, because
  OpenDota could not serve it.

Otherwise the request goes to OpenDota as before. Both paths share the same
limits: one request per match per five minutes, `PARSE_BUDGET_PER_CLIENT_MAX`
(3) and `PARSE_BUDGET_GLOBAL_MAX` (10) per ten minutes.

## What a self-parsed match has, and has not

Has: everything read from the replay (gold and XP timelines, purchases,
kills and deaths, team fights, wards, lanes). Checked against OpenDota's copy
of the same real match: lane, lane role, roaming, time dead, purchase and kill
logs and team fights come out identical (`src/utils/odotaParser.test.ts`).

Has not, and the report says so under "what the coach cannot see":

- percentile comparisons (`benchmarks`): OpenDota computes them across all
  games; they are left absent, never estimated;
- rank brackets and player names.

A self-parsed copy is stored like any parsed match. When OpenDota is the
primary source and answering again, the site asks it for the match and uses
OpenDota's parsed copy if there is one; otherwise ours stands.

## The one hard rule

The parser downloads whatever URL it is given. The site only ever sends
addresses of the form

```text
http://replay<cluster>.valve.net/570/<match_id>_<replay_salt>.dem.bz2
```

built from GC data and checked by `isAllowedValveReplayUrl` immediately before
the request. Nothing a visitor sends becomes part of that URL. Keep the parser
private (below) so nobody else can hand it other URLs.

## Deploying the parser (Cloud Run)

The parser is OpenDota's, unmodified: <https://github.com/odota/parser>
(image `odota/parser` on Docker Hub, port 5600). It keeps no state.

```bash
REGION=asia-east1

gcloud run deploy odota-parser \
  --image docker.io/odota/parser:latest \
  --region "$REGION" --port 5600 \
  --memory 4Gi --cpu 2 --concurrency 2 \
  --min-instances 0 --max-instances 2 --timeout 300 \
  --no-allow-unauthenticated

PARSER_URL=$(gcloud run services describe odota-parser --region "$REGION" --format 'value(status.url)')

# Let the site's service account call it.
SITE_SA=$(gcloud run services describe <site-service> --region "$REGION" --format 'value(spec.template.spec.serviceAccountName)')
gcloud run services add-iam-policy-binding odota-parser --region "$REGION" \
  --member "serviceAccount:${SITE_SA}" --role roles/run.invoker

gcloud run services update <site-service> --region "$REGION" \
  --update-env-vars "ODOTA_PARSER_URL=${PARSER_URL},ODOTA_PARSER_AUDIENCE=${PARSER_URL}"
```

If Cloud Run will not pull from Docker Hub in your project, build the image
from the repository instead (`gcloud run deploy odota-parser --source .` in a
clone of odota/parser).

Sizing, measured locally on a 30-minute ranked game: 44 s for a cold parse
including the download, about 770 MB of memory. The parser holds the whole
replay in memory, which is why `--concurrency 2` and the client's own limit
(two at once, four waiting) exist.

On one machine instead (for example next to the retriever):

```bash
docker run -d --name odota-parser --restart unless-stopped --memory 4g \
  -p 127.0.0.1:5600:5600 odota/parser
# site: ODOTA_PARSER_URL=http://<private address>:5600   (no ODOTA_PARSER_AUDIENCE)
```

Never publish port 5600 to the internet: the parser has no authentication of
its own.

## Settings (site)

| Variable | |
|---|---|
| `ODOTA_PARSER_URL` | Base URL of the parser. Unset: self-hosted parsing is off |
| `ODOTA_PARSER_AUDIENCE` | Set to the parser's Cloud Run URL to send a Google ID token (private service). Leave unset for a parser on a private network |

## Check it

```bash
curl -s https://<site>/api/health/upstream | jq '.parser, .steamGc.configured, .sources'
# parser.configured: true, parser.usable: true (usable = the retriever is configured too)

# With UPSTREAM_PRIMARY=steam_gc, on a match from the last few days:
curl -s -X POST -H 'content-type: application/json' -d '{"lang":"en"}' \
  https://<site>/api/review/<match_id>/parse-request
# {"status":"requested","provider":"self_hosted",...}
# a minute later:
curl -s https://<site>/api/coach/<match_id> | jq '.match.parsed, .match.source'
# true, "steam_gc"
```

`parser` in the health output counts parses, successes, replays that were
gone, failures and "busy" refusals on this instance.

## Answers the page gets

| `status` | Meaning |
|---|---|
| `requested` | accepted; the parse is running |
| `pending` | a parse of this match is already running |
| `throttled` | over the request budget; `retryAfterSec` says when |
| `failed` | it did not go through; may be retried after a minute |
| `failed` + `reason: "replay_gone"` | Valve no longer has the replay (kept about two weeks); remembered for six hours, asking again costs nothing |
| `parsed` | already parsed |

## Known limits

- The parse runs after the HTTP response. On Cloud Run with request-based
  billing the CPU is throttled between requests; the page's polling keeps the
  instance busy, and the work is mostly waiting on the parser. This has been
  run end to end locally, not yet on Cloud Run. If parses stall there, give
  the site service `--no-cpu-throttling`.
- Request limits and "replay gone" memory are per instance.
- Valve hides some very high-rank games and removes replays after about two
  weeks. Those cannot be parsed this way.
