# Replay state write scheduling

GCS state instances sharing a bucket handle and object key use one in-process
writer. Reads and snapshots take the same mutex as mutations. Queued mutations
share a CAS snapshot/save; callbacks run against isolated copies so a rejected
lease check cannot change another mutation. CAS conflicts replay the callbacks
against a fresh snapshot and only resolve callers after a successful commit.

Production defaults enforce at least 1000ms between saves (including failed
attempts). Byte thresholds trigger an awaited flush, providing download
backpressure; changing CDN chunk sizes does not change this write floor.
`GcsJobStore` options can set `minWriteIntervalMs: 0` for instantaneous tests.
FileState continues to use local flock with no write-rate floor.

The JSON API retries 429/503 up to six total attempts, with exponential delays
starting at one second and respecting longer Retry-After seconds or HTTP dates.
Retries stay inside the writer mutex. Compact `replay_store_request` diagnostics
include only object key, operation, status, attempt, and Retry-After. Exhaustion
stops ingestion; recoverable failure recording uses job `store_error` and public
`replay_store_error`, independently of an official CDN HTTP 200 response.

Synthetic injected-JSON-API tests cover two chunk sizes totaling 28,442,608 bytes,
write spacing, coalesced budget/heartbeat/phase mutations, CAS, retry delay,
exhaustion, and committed resource limits. Worker tests verify store failure
classification and bounded consumption of an otherwise unbounded synthetic body.
No official CDN request is needed. Cross-process races still use GCS generation
preconditions; this process cannot schedule another instance's writes.

Validation for this change (2026-11-15): `npm test` passed 112 files / 1641 tests;
`npx tsc --noEmit`, `node --check server.js`, and `npm run build` passed.
