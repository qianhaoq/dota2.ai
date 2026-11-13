# Replay worker: offline implementation and production declarations

Phase D has **not** run. No official CDN was probed, no replay was downloaded
again, no resources were created, no APIs were enabled, and production Web and
its ingest/auto flags remain unchanged. Firestore and Cloud Tasks APIs are **NOT
enabled** on this project; Cloud Scheduler is also not enabled. The default
cloud design uses Cloud Run + GCS, without Firestore, Tasks, Scheduler or NAT.

## Local operation

Set `REPLAY_HOME` to a private writable directory, `DOTA_EXTRACT_BIN` to the
verified static extractor, and `REPLAY_INGEST_ENABLED=1` in a local process only.
POST `/api/review/:matchId/replay-ingest` returns 202 with a string `jobId`.
It persists an outbox entry before enqueueing; client disconnection cannot
cancel the worker. A duplicate active or ready match attaches to the same job.
GET/review/SSE only read artifacts; they never download or start extraction.

Run `node scripts/replay-worker.mjs --once` to reconcile and drain once, or omit
`--once` for a supervised local polling worker. The filesystem adapter requires
Linux `flock` (util-linux): the kernel releases the transaction lock on process
death. JSON replacements are atomic; immutable artifacts are addressed by
match, generation and SHA-256. A worker must heartbeat its lease, and every
state update/publication checks the lease's fencing token. Queue entries survive
worker death and are acknowledged only after a terminal state. A retry after
lease expiry gets a new token; a late worker cannot publish. Failures cannot
replace a successful pointer.

`REPLAY_AUTO_ENABLED=0` is the default. Only the explicitly server-exposed
`ingest_available && replay_auto_enabled` flags enable automatic submission.
Manual POST is independent of this UI flag. Review, SSE and answer caches include
the artifact generation; expired artifacts are not returned from a stale pointer.

## Offline acceptance run

Use already-held official bytes, with `fetchImpl` injected by the QA script:

```bash
DOTA_EXTRACT_BIN=/path/to/pinned/dota-extract \
  node scripts/qa-local-replay-ingest.mjs \
  /workspace/t911u-9080127650-official/opendota-9080127650.json \
  /workspace/t911u-9080127650-official/9080127650_1490343705.dem.bz2 \
  /path/to/coach/packages/coach/fixtures/tiny.dem.bz2 /tmp/replay-qa
```

This runs submit → durable queue → worker → FileArtifactStore → review. It
checks zstd magic, compressed/demo hashes, extractor match ID, v4 clock, hero
60/slot 132, eight deaths, skeleton killer, purchase versus both BKB windows,
fort at 1906.7668 seconds, five cited moments, no internal field names in copy,
and one download/parse despite duplicate submits. The tiny bzip2 fixture also
exercises decompression. It makes no official CDN requests.

## Stores and cloud host

JobStore, ArtifactStore and Queue are injected interfaces. File implementations
are the default when `REPLAY_HOME` is configured. Setting `REPLAY_GCS_BUCKET`
explicitly selects GCS implementations with object-generation preconditions and
workload-identity authentication. No cloud clients are constructed in offline
tests. `CloudTasksQueue` is an optional injected adapter only; it is not selected
by default and does not enable the API.

The GCS queue is a durable object backed outbox. The private worker's
`POST /run` reconciles and drains it, holding the request open for CPU allocation.
Until separately approved dispatch is provisioned in Phase D, an authorized
operator/supervisor invokes `/run` again after a crash or pending outbox alert.
No claim is made that a cloud queue/trigger currently exists. GET `/health` is
read-only. Cloud Run IAM must authenticate invocations; never allow `allUsers`.

`Dockerfile.replay-worker` accepts `EXTRACTOR_PATH` relative to the build context.
Copy a locally verified pinned extractor there before building; do not fetch a
mutable binary during the build. Runtime is non-root and carries no AI/Steam
secrets. Required sizing: **4Gi memory, 2 CPU, concurrency 1, maxScale 1,
minScale 0**, application deadline 720 seconds and host deadline 900 seconds.
Stage allocation is discovery 20 / download 180 / decode 60 / extraction 360 /
publication 60 seconds, with remaining cleanup allowance. The parser enforces the overall deadline and individual stage abort timers.

New artifacts require extractor match ID, v4 clock in horn-relative seconds and
hero+slot agreement with extractor metadata. `dem` decompression format is
normalized to site `raw` for old pinned extractors. Fort versus match duration
within 5 seconds permits full timing; greater difference/missing fort marks a
partial timeline awaiting verification, keeping original clocks unchanged.
Legacy baked artifacts remain readable under their previous validation contract.

Connection-level DNS lookup allows only public IPv4 addresses and official
replay hostnames; it rejects redirects, credentials, custom ports and private
addresses. Tests inject bytes instead of resolving official hosts.

## Budgets and retention

Defaults are injected into JobStore and enforced in persistent state: **100 new
jobs/day, 3 new matches/10 minutes/IP, 60 new jobs/hour, 150 attempts/day,
25.6GB actual compressed bytes/day, 72,000 worker seconds/day**. Duplicates do
not consume a new-job budget. Downloads charge bytes as chunks arrive; workers
charge elapsed runtime during heartbeats and at completion. Exceeding a hard
budget stops work, and counters retain failed attempt usage. A receiving chunk
may cross the byte threshold before it can be rejected. Raising limits needs
owner budget approval. Queue age is an independent operational alert.

Compact artifacts retain 90 days. Completed job details retain 30 days; keep
publication pointers through artifact expiry. Raw replay/trace files are deleted
in `finally` and have no cloud retention. The declared bucket lifecycle applies
only to `artifacts/`; never apply a blanket 30-day lifecycle to the shared job
state object. Reconciliation handles details/pointer expiry in application code.

`infra/replay-worker.yaml`, `infra/replay-bucket-lifecycle.json` and
`infra/replay-iam-notes.yaml` are declarations only, with explicit placeholders.
No bucket, service, IAM binding, registry image or API changes were applied.
Before Phase D: approve costs/region/egress, provision private storage and worker,
wire authenticated dispatch, verify alerts, then explicitly approve flag changes.
The baked production replay must be removed from the runtime image only after
its replacement shared artifact and read path are verified; production bake
exit remains a Phase D acceptance condition.
