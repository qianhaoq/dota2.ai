import { gunzipSync, gzipSync } from 'node:zlib';
import { createTracePipeline } from '../../../lib/agent/tracePipeline.js';

/** Max compressed trace download size (10 MB; typical trace is ~250 KB). */
export const MAX_TRACE_GZIP_BYTES = 10 * 1024 * 1024;
/** Max decompressed trace JSON size (32 MB) to guard against gzip bombs. */
export const MAX_TRACE_JSON_BYTES = 32 * 1024 * 1024;

/**
 * Validate raw bytes (gzipped or proxy-decompressed JSON) as a
 * `dota2.ai/match-trace@1` for `matchId`, returning canonical gzipped bytes.
 */
export function normalizeTraceGzip(bytes, matchId, { maxGzipBytes = MAX_TRACE_GZIP_BYTES, maxJsonBytes = MAX_TRACE_JSON_BYTES } = {}) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length < 2) throw new Error('empty_trace');
  const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;
  if (isGzip && buf.length > maxGzipBytes) throw new Error('trace_too_large');
  if (!isGzip && buf.length > maxJsonBytes) throw new Error('trace_too_large');
  const rawJson = isGzip ? gunzipSync(buf, { maxOutputLength: maxJsonBytes }) : buf;
  const jsonText = rawJson.toString('utf8');
  const parsed = JSON.parse(jsonText);
  if (parsed?.schema !== 'dota2.ai/match-trace@1' || String(parsed.match_id) !== String(matchId)) {
    throw new Error('invalid_trace');
  }
  return isGzip ? buf : gzipSync(Buffer.from(jsonText, 'utf8'));
}

/** Read an HTTP response body into a Buffer with a hard byte cap. */
async function readBoundedBuffer(res, maxBytes) {
  const lenHeader = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(lenHeader) && lenHeader > maxBytes) throw new Error('trace_too_large');
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error('trace_too_large');
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks, total);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error('trace_too_large');
  return buf;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); return; }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  timer.unref?.();
  function onAbort() {
    clearTimeout(timer);
    reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }
  signal?.addEventListener('abort', onAbort, { once: true });
});

const positiveSec = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
};

const retryAfterFrom = (res, body) => (
  positiveSec(body?.retry_in_sec)
  ?? positiveSec(body?.retryAfterSec)
  ?? positiveSec(res?.headers?.get?.('retry-after'))
);

const failResult = (reason, retryIn = null) => ({
  ok: false,
  reason,
  ...(retryIn != null ? { retry_in_sec: retryIn } : {}),
});

/**
 * Hybrid trace pipeline for DSH:
 * - When `extractorBin` is configured, parses the replay locally via `createTracePipeline`.
 * - Otherwise asks `<apiBase>/api/agent/<id>/prepare` to parse on dota2.ai's worker
 *   (inheriting Steam GC discovery & shared trace cache, with zero server LLM cost)
 *   and downloads the ~250 KB `.trace.json.gz` from `<apiBase>/api/agent/<id>/trace`
 *   into `$DSH_HOME/dota2ai/traces/`.
 */
export function createDshTracePipeline({
  apiBase = 'https://dota2.ai',
  fetchImpl = globalThis.fetch,
  traceStore,
  getMatchDetail,
  extractorBin = '',
  workRoot,
  pollIntervalMs = 2500,
  timeoutMs = 840_000,
  maxConsecutivePollErrors = 5,
  log = () => {},
}) {
  if (extractorBin && String(extractorBin).trim()) {
    return createTracePipeline({
      getMatchDetail,
      extractorBin: String(extractorBin).trim(),
      store: traceStore,
      workRoot,
      log,
    });
  }

  const base = String(apiBase || 'https://dota2.ai').replace(/\/+$/, '');

  async function downloadAndStore(id, onStage, signal) {
    onStage('storing');
    const res = await fetchImpl(`${base}/api/agent/${encodeURIComponent(id)}/trace`, { signal });
    if (!res.ok) {
      if (res.status === 429) {
        const body = await res.json().catch(() => ({}));
        return failResult('rate_limited', retryAfterFrom(res, body));
      }
      return failResult(res.status === 404 ? 'extract_failed' : 'download_failed');
    }
    try {
      const raw = await readBoundedBuffer(res, MAX_TRACE_JSON_BYTES);
      const gz = normalizeTraceGzip(raw, id);
      await traceStore.put(id, gz);
      return { ok: true, bytes: gz.length };
    } catch (error) {
      return failResult(error?.message === 'trace_too_large' || error?.code === 'ERR_BUFFER_TOO_LARGE' ? 'too_large' : 'extract_failed');
    }
  }

  return {
    async run(matchId, { onStage = () => {}, signal } = {}) {
      const id = String(matchId);
      if (!/^[1-9]\d{0,12}$/.test(id)) return failResult('no_match');
      const deadline = AbortSignal.timeout(timeoutMs);
      const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;

      try {
        onStage('locating');
        const availRes = await fetchImpl(`${base}/api/agent/${encodeURIComponent(id)}`, { signal: bounded });
        if (!availRes.ok) {
          const body = await availRes.json().catch(() => ({}));
          const retryIn = retryAfterFrom(availRes, body);
          if (availRes.status === 429) return failResult('rate_limited', retryIn);
          if (availRes.status === 503) {
            return failResult(body?.status === 'unavailable' ? 'unavailable' : body?.code === 'busy' ? 'busy' : 'worker_failed', retryIn);
          }
          return failResult('worker_failed', retryIn);
        }
        const avail = await availRes.json().catch(() => null);
        if (!avail) return failResult('worker_failed');

        if (avail.trace && !avail.trace_outdated) {
          return await downloadAndStore(id, onStage, bounded);
        }

        const hadLocalTrace = Boolean(await traceStore.get(id));

        if (!avail.can_parse) {
          if (!hadLocalTrace && avail.trace) return await downloadAndStore(id, onStage, bounded);
          return failResult('unavailable');
        }
        if (avail.parse?.status === 'failed' && avail.parse.final) {
          // Server already holds a usable (older) trace whose reparse permanently failed (e.g. replay_gone > 14d):
          // download that existing trace if we do not have one locally, matching Web availability.
          if (!hadLocalTrace && avail.trace) return await downloadAndStore(id, onStage, bounded);
          return failResult(avail.parse.reason || 'replay_gone');
        }
        if (avail.parse?.status === 'failed' && !avail.parse.final && positiveSec(avail.parse.retry_in_sec) != null) {
          if (!hadLocalTrace && avail.trace) return await downloadAndStore(id, onStage, bounded);
          return failResult(avail.parse.reason || 'extract_failed', positiveSec(avail.parse.retry_in_sec));
        }

        if (avail.parse?.status !== 'running') {
          const prepRes = await fetchImpl(`${base}/api/agent/${encodeURIComponent(id)}/prepare`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
            signal: bounded,
          });
          const prep = await prepRes.json().catch(() => ({}));
          const retryIn = retryAfterFrom(prepRes, prep);
          if (!prepRes.ok) {
            // Reparse was refused/rate-limited/errored, but server already has a valid trace we lack locally: download it!
            if (!hadLocalTrace && avail.trace) return await downloadAndStore(id, onStage, bounded);
            if (prepRes.status === 429) return failResult('rate_limited', retryIn);
            if (prepRes.status === 503) {
              return failResult(prep.status === 'unavailable' ? 'unavailable' : prep.code === 'busy' ? 'busy' : 'worker_failed', retryIn);
            }
            return failResult('worker_failed', retryIn);
          }
          if (prep.status === 'ready') {
            if (!avail.trace_outdated) {
              return await downloadAndStore(id, onStage, bounded);
            }
            // Server finished or declined reparsing an outdated trace: check whether it was actually upgraded.
            const checkRes = await fetchImpl(`${base}/api/agent/${encodeURIComponent(id)}`, { signal: bounded });
            const check = checkRes.ok ? await checkRes.json().catch(() => null) : null;
            if (check?.trace && !check.trace_outdated) {
              return await downloadAndStore(id, onStage, bounded);
            }
            if (!hadLocalTrace && (check?.trace ?? avail.trace)) {
              return await downloadAndStore(id, onStage, bounded);
            }
            return failResult(check?.parse?.reason || 'replay_gone');
          }
          if (prep.status === 'failed') {
            if (!hadLocalTrace && avail.trace) {
              return await downloadAndStore(id, onStage, bounded);
            }
            return failResult(prep.reason || 'extract_failed', retryIn);
          }
          if (prep.status === 'unavailable') {
            if (!hadLocalTrace && avail.trace) return await downloadAndStore(id, onStage, bounded);
            return failResult('unavailable');
          }
          if (prep.status !== 'running') {
            if (!hadLocalTrace && avail.trace) return await downloadAndStore(id, onStage, bounded);
            return failResult('worker_failed');
          }
          if (prep.stage) onStage(prep.stage);
        } else if (avail.parse.stage) {
          onStage(avail.parse.stage);
        }

        let consecutiveErrors = 0;
        let lastPollReason = 'worker_failed';
        let lastRetryIn = null;
        for (;;) {
          await sleep(pollIntervalMs, bounded);
          let pollRes;
          try {
            pollRes = await fetchImpl(`${base}/api/agent/${encodeURIComponent(id)}`, { signal: bounded });
          } catch (error) {
            if (bounded.aborted || signal?.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError') throw error;
            consecutiveErrors += 1;
            lastPollReason = 'worker_failed';
            lastRetryIn = null;
            if (consecutiveErrors >= maxConsecutivePollErrors) {
              if (!hadLocalTrace && avail.trace) return await downloadAndStore(id, onStage, bounded);
              return failResult(lastPollReason, lastRetryIn);
            }
            continue;
          }
          if (!pollRes.ok) {
            const errBody = await pollRes.json().catch(() => ({}));
            consecutiveErrors += 1;
            lastRetryIn = retryAfterFrom(pollRes, errBody);
            lastPollReason = pollRes.status === 429
              ? 'rate_limited'
              : pollRes.status === 503 && errBody?.code === 'busy'
                ? 'busy'
                : 'worker_failed';
            if (consecutiveErrors >= maxConsecutivePollErrors) {
              if (!hadLocalTrace && avail.trace) return await downloadAndStore(id, onStage, bounded);
              return failResult(lastPollReason, lastRetryIn);
            }
            continue;
          }
          const state = await pollRes.json().catch(() => null);
          if (!state) {
            consecutiveErrors += 1;
            lastPollReason = 'worker_failed';
            lastRetryIn = null;
            if (consecutiveErrors >= maxConsecutivePollErrors) {
              if (!hadLocalTrace && avail.trace) return await downloadAndStore(id, onStage, bounded);
              return failResult(lastPollReason, lastRetryIn);
            }
            continue;
          }
          consecutiveErrors = 0;
          if (state.trace && !state.trace_outdated) {
            return await downloadAndStore(id, onStage, bounded);
          }
          if (state.parse?.status === 'running') {
            if (state.parse.stage) onStage(state.parse.stage);
            continue;
          }
          if (state.parse?.status === 'failed' || state.parse?.status === 'none') {
            // Reparse ended without producing a current trace: if we have no local trace yet, keep the server's older one;
            // otherwise report failure so `createAgentService` records the reparse backoff instead of thinking it upgraded.
            if (!hadLocalTrace && state.trace) {
              return await downloadAndStore(id, onStage, bounded);
            }
            return failResult(state.parse?.reason || 'extract_failed', positiveSec(state.parse?.retry_in_sec));
          }
          // Malformed/unknown state object: bound retries so we never spin until timeout.
          consecutiveErrors += 1;
          if (consecutiveErrors >= maxConsecutivePollErrors) {
            if (!hadLocalTrace && (state.trace || avail.trace)) return await downloadAndStore(id, onStage, bounded);
            return failResult('worker_failed');
          }
        }
      } catch (error) {
        if (signal?.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError') {
          return failResult('timeout');
        }
        log(`dsh trace fetch error match=${id}: ${error?.name ?? 'error'}`);
        return failResult('worker_failed');
      }
    },
  };
}
