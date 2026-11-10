# First-party replay ingest

Opt-in vertical slice: `POST /api/review/:matchId/replay-ingest` with JSON
`{"lang":"en"}` (or `zh`). The handler gets OpenDota match metadata, validates
the official replay CDN URL, downloads without redirects, hashes the compressed
file, decompresses with the configured extractor, rehashes the dem, and parses
trace version 3. It retains a compact, name/account-free facts artifact. GET and
stream requests only read artifacts; they never download or submit a job.

Set **both** `REPLAY_INGEST_ENABLED=1` and `DOTA_EXTRACT_BIN` (fallback
`COACH_EXTRACT_BIN`) to enable. `REPLAY_HOME` defaults to
`/tmp/dota2ai-replays`. Without these settings, production keeps its existing
honest OpenDota summary. No binary is bundled or required for CI.

The explicit request is synchronous, aborts when its client disconnects, and has
a 180-second total timeout. Work directories are removed on success, failure,
and cancellation. Limits per job: 256 MB download, 512 MB decompressed dem,
512 MB trace, 8 MB artifact. The 1.5 GB home budget reserves all maxima before
work and checks free disk. A filesystem lock serializes jobs sharing the home;
other jobs receive throttled. A hard process crash can leave a lock/work dir:
an operator must verify no worker is running before removing these. Artifacts
have no automatic eviction; a full budget fails closed until operator cleanup.
Limits/timeouts are injectable in the service for tests/operator integrations;
they are not silently applied to Cloud Run resource configuration.

Per-instance submission budgets reuse the parse-request budget/tracker pattern:
3 jobs globally and 1 per client per 10 minutes, 5-minute match cooldown,
1-minute failure/abort cooldown. These are **not fleet-wide quotas**. The API
uses the existing CSRF guard and trusted-proxy client identity. Missing URL,
404/410/expired response, network/5xx, invalid URL, disabled ingest and extractor
failure have separate bilingual statuses. GET review exposes the stored status;
no separate background worker or polling submit endpoint is introduced.

## Evidence contract

`dota2.ai/replay-facts@1` artifacts record URL availability, salt/cluster,
OpenDota metadata fetch time when known, download time/host/status, compressed
bytes/SHA-256, dem bytes/SHA-256 and parse timing. Only a successful verified
artifact for the same match can override `od_data.has_parsed=false`.

Combat log timestamps are relative to game start. Real hero death events retain
killer, exact event time and event coordinates when present; illusions are
excluded. Purchases require an explicit PURCHASE event and item identifier.
Source paths retain original trace row indices. The current extractor can filter
out purchases; **zero emitted purchase rows means a gap, not proof of no buys**.
Legacy `heroes.jsonl` uses an uncalibrated demo clock; do not align it to combat
logs or infer death coordinates. Current traces do not provide reliable minute
LH/gold/XP or calibrated objectives. These fields are omitted with data gaps;
no interpolation or inferred purchase from inventory is allowed.

Replay timeline citations use provider `replay`, dem SHA-256, fetch time and
`trace/events.jsonl` paths. OpenDota remains the scoreboard provider. Individual
events remain reviewable even when death counts do not match scoreboard deaths;
counts only become complete facts when coverage matches. A death/purchase is an
observation, not proof of a bad decision. General KB entries still require
explicit `kbContextIds`. Attached material is labeled contextual learning with
empty support/contradiction lists until a match-specific evaluator exists;
it is never presented as a verified match recommendation. Player slot is never
used to assign role. No patch name is inferred from OpenDota's numeric patch ID.

## Local evidence tool

```sh
DOTA_EXTRACT_BIN=/path/to/dota-extract node scripts/review-from-demo.mjs \
  match.json match.dem 60 zh /tmp/review-evidence [existing-extract-directory]
```

The tool writes a redacted review and evidence JSON (counts, bytes, hash, elapsed
time, gaps). An existing extract is an explicit operator-supplied pairing; it
records `existing_extract=true` and does not claim a fresh parse or download.
The compact `replay-8985182860.redacted.json` fixture contains two real observed
Axe deaths; `replay-events.json` is synthetic for coordinates/purchase/illusion
edge cases absent from that real trace. Neither contains identities.

## Production enablement decision

Keep ingest **off** on Cloud Run `dota2-ai` in `asia-east1`. The present
`node:20-alpine` image has no extractor or persistent volume. Before enabling,
the operator must choose an Alpine-compatible extractor build/image integration,
measure parser memory and ephemeral-disk consumption (Cloud Run writable disk
uses instance memory), provision an explicit storage budget and retention policy,
allow sufficient HTTP/request timeout, verify official CDN egress from asia-east1,
and decide fleet-wide concurrency/budgets and artifact persistence. This change
does not change the Dockerfile, Cloud Run resources, deployment or secrets.
A Steam login or Web API JSON is not a substitute for a dem.

On this box, match 9080127650 metadata is available, but the official CN replay
CDN returns HTTP 500 through sandbox egress. Its detailed review is **not
complete**; the CDN failure keeps the scoreboard summary. No DNS/proxy bypass
is attempted. A successful local 8985182860 parse demonstrates the pipeline,
not availability or analysis of 9080127650.
