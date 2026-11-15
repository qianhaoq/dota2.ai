# Replay state write scheduling

GCS state instances sharing a bucket handle and object key use one in-process
writer. Reads and snapshots take the same mutex as mutations. Queued mutations
share a CAS snapshot/save; callbacks run against isolated copies so a rejected
lease check cannot change another mutation. CAS conflicts replay the callbacks
against a fresh snapshot and only resolve callers after a successful commit.

Production defaults enforce at least 1000ms between saves (including failed
attempts) within each writer. Before saving, the writer also waits until at
least 1000ms after the snapshot object’s GCS `updated` timestamp. A CAS
conflict reloads metadata and repeats that wait. First creation has no object
timestamp floor. The worker passes the store's write interval to the byte charger.
After the first immediate flush, a 1MiB threshold reached before the floor
schedules a flush and lets the stream continue. The next charge includes all
bytes received during that interval: a 1.6MiB/s stream writes about 1.6MiB each
second, rather than stalling at 1MiB/s. Only uncharged usage above 16MiB
(including an in-flight ticket) backpressures the stream, bounding lost charges
on crash. Final flushes await all pending charges; saves remain serialized.
The charger defaults to a zero write interval for local stores and direct callers.
The download phase allows 300000ms for the 256e6-byte cap at a healthy official
rate plus margin; other phase and worker deadlines are unchanged.
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
No official CDN request is needed. Cross-process spacing relies on object
metadata plus generation preconditions, together with the in-process mutex;
there is no distributed lock.

Byte batches and elapsed-time intervals retain stable charge tickets across
uncertain saves. Each job remembers its latest 32 applied tickets, so a retry
of a committed mutation succeeds without adding usage or raising another
resource limit. Clearly rejected writes can still apply on a later retry.

Validation (2026-11-15): `npm test` passed 112 files / 1659 tests, including
commit-then-throw and rejected-save byte/seconds retries, bounded ticket history,
independent-handle metadata/CAS spacing, nonblocking chunk pumps, the 16MiB
high watermark, overlapping final-flush retries, and scheduled resource-limit propagation. `npx tsc --noEmit`,
`node --check server.js`, and `npm run build` passed.
