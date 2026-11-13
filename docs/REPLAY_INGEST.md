# First-party replay ingest

Opt-in vertical slice: `POST /api/review/:matchId/replay-ingest` with JSON
`{"lang":"en"}` (or `zh`). The handler gets OpenDota match metadata, validates
the official replay CDN URL, downloads without redirects, hashes the compressed
file, decompresses with the configured extractor, rehashes the dem, and parses
trace versions 3 and 4 only. Extractor `match_id` (when present) must match
the requested match and is retained as `extractor_match_id`; structured `clock`
is retained unchanged. Decompression uses the extractor-reported `format`
(`zstd`, `bz2`, or `raw`), never the URL or downloaded filename suffix. It retains a compact, name/account-free facts artifact. GET and
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
failure have separate bilingual statuses. GET/stream review parse payloads expose `ingest_available`, derived from the
current enabled flag and configured extractor, independently of stored status.
The official action and availability copy require this boolean to be true;
missing signals fail closed. Verified completed artifacts remain usable when
ingest is later disabled. GET review also exposes the stored status;
no separate background worker or polling submit endpoint is introduced.

## Evidence contract

`dota2.ai/replay-facts@1` artifacts record URL availability, salt/cluster,
OpenDota metadata fetch time when known, download time/host/status, compressed
bytes/SHA-256, dem bytes/SHA-256 and parse timing. Only a successful verified
artifact for the same match can override `od_data.has_parsed=false`.

Event/objective timestamps are seconds on the pause-adjusted match clock:
horn is zero and pregame is negative. V4 records the extractor clock formulas
and explicit fort-kill game end; `demo_tick_30hz` is not a match clock. Real hero death events retain
killer, exact event time and event coordinates when present; illusions are
excluded. Purchases require an explicit PURCHASE event and item identifier.
Source paths retain original trace row indices. The current extractor can filter
out purchases; **zero emitted purchase rows means a gap, not proof of no buys**.
Legacy `heroes.jsonl` uses an uncalibrated demo clock; do not align it to combat
logs or infer death coordinates. Metadata supplies only exact-minute LH snapshots; earned gold and XP remain
unavailable. Building-kill events supply observed objectives. Net-worth graphs
with more bins than minutes are retained as `net_worth_t` with
`net_worth_timing=uncalibrated_graph_bins` in the artifact, but omitted from the
review overlay until their sample times are calibrated. They cannot support
minute-specific facts or followups. Unavailable fields carry explicit data gaps;
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

## Reproducible local-file integration QA — 9080127650

```sh
DOTA_EXTRACT_BIN=/workspace/t911u-9080127650-official/bin/dota-extract-5a8e575 \
node scripts/qa-local-replay-ingest.mjs \
  /workspace/t911u-9080127650-official/opendota-9080127650.json \
  /workspace/t911u-9080127650-official/9080127650_1490343705.dem.bz2 \
  /workspace/qh-dsh-dota-coach/packages/coach/fixtures/tiny.dem.bz2 \
  /workspace/t911u-9080127650-official/site-ingest-qa
```

This explicit, non-default QA uses an isolated home and local bytes returned by
`fetchImpl` with HTTP 200. `submit()` writes suffix-less `download`, then invokes
the real extractor for decompression and parsing. The official object has zstd
magic despite its `.dem.bz2` URL. The same binary decompresses real `BZh` bytes
from a suffix-less file; the tiny fixture is header-only, so that check proves
decompression compatibility rather than a playable-match parse.

The script asserts verified hashes, v4 match/clock, hero 60 / slot 132, separate
net worth, real fort kill at 1906.7667847s, missing-evidence refusals and explicit
KB applicability boundaries. It writes artifact, review, contextual review and
evidence JSON outside git. The 63-bin net-worth graph has unverified sample
times, so no minute net-worth claim is made. Exact-minute LH snapshots are also
absent for this match; nearby 599-second snapshots are not relabeled 600.

This proves the **site ingest pipeline on an already-obtained official file**.
It does not prove production Cloud Run can auto-download from the official CDN.
No CDN probe is performed. Production `dota2-ai-00125-5lb` at `45c63132` has no
`REPLAY_INGEST_ENABLED` / `DOTA_EXTRACT_BIN`; its `node:20-alpine` image has no
extractor. Production stays off, with honest scoreboard status where applicable.
