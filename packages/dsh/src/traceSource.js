import { gunzipSync, gzipSync } from 'node:zlib';
import { createTracePipeline } from '../../../lib/agent/tracePipeline.js';

/**
 * Validate raw bytes (gzipped or proxy-decompressed JSON) as a
 * `dota2.ai/match-trace@1` for `matchId`, returning canonical gzipped bytes.
 */
export function normalizeTraceGzip(bytes, matchId) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length < 2) throw new Error('empty_trace');
  const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;
  const jsonText = isGzip ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  const parsed = JSON.parse(jsonText);
  if (parsed?.schema !== 'dota2.ai/match-trace@1' || String(parsed.match_id) !== String(matchId)) {
    throw new Error('invalid_trace');
  }
  return isGzip ? buf : gzipSync(Buffer.from(jsonText, 'utf8'));
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
    if (!res.ok) return { ok: false, reason: res.status === 404 ? 'extract_failed' : 'download_failed' };
    const arr = await res.arrayBuffer();
    try {
      const gz = normalizeTraceGzip(Buffer.from(arr), id);
      await traceStore.put(id, gz);
      return { ok: true, bytes: gz.length };
    } catch {
      return { ok: false, reason: 'extract_failed' };
    }
  }

  return {
    async run(matchId, { onStage = () => {}, signal } = {}) {
      const id = String(matchId);
      if (!/^[1-9]\d{0,12}$/.test(id)) return { ok: false, reason: 'no_match' };
      const deadline = AbortSignal.timeout(timeoutMs);
      const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;

      try {
        onStage('locating');
        const availRes = await fetchImpl(`${base}/api/agent/${encodeURIComponent(id)}`, { signal: bounded });
        if (!availRes.ok) return { ok: false, reason: availRes.status === 429 ? 'rate_limited' : 'worker_failed' };
        const avail = await availRes.json().catch(() => null);
        if (!avail) return { ok: false, reason: 'worker_failed' };

        if (avail.trace && !avail.trace_outdated) {
          return await downloadAndStore(id, onStage, bounded);
        }
        if (!avail.can_parse && !avail.trace) {
          return { ok: false, reason: 'unavailable' };
        }
        if (avail.parse?.status === 'failed' && avail.parse.final) {
          return { ok: false, reason: avail.parse.reason || 'replay_gone' };
        }

        if (avail.parse?.status !== 'running') {
          const prepRes = await fetchImpl(`${base}/api/agent/${encodeURIComponent(id)}/prepare`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
            signal: bounded,
          });
          const prep = await prepRes.json().catch(() => ({}));
          if (prepRes.status === 429 || prepRes.status === 503) {
            return { ok: false, reason: prep.status === 'unavailable' ? 'unavailable' : 'worker_failed' };
          }
          if (prep.status === 'ready') {
            return await downloadAndStore(id, onStage, bounded);
          }
          if (prep.status === 'failed') {
            return { ok: false, reason: prep.reason || 'extract_failed' };
          }
          if (prep.stage) onStage(prep.stage);
        } else if (avail.parse.stage) {
          onStage(avail.parse.stage);
        }

        for (;;) {
          await sleep(pollIntervalMs, bounded);
          const pollRes = await fetchImpl(`${base}/api/agent/${encodeURIComponent(id)}`, { signal: bounded });
          if (!pollRes.ok) continue;
          const state = await pollRes.json().catch(() => null);
          if (!state) continue;
          if (state.trace) {
            return await downloadAndStore(id, onStage, bounded);
          }
          if (state.parse?.status === 'running' && state.parse.stage) {
            onStage(state.parse.stage);
          } else if (state.parse?.status === 'failed') {
            return { ok: false, reason: state.parse.reason || 'extract_failed' };
          } else if (state.parse?.status === 'none' && avail.trace) {
            // Reparse failed transiently while an older trace still exists on the server: keep the older trace.
            return await downloadAndStore(id, onStage, bounded);
          }
        }
      } catch (error) {
        if (signal?.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError') {
          return { ok: false, reason: 'timeout' };
        }
        log(`dsh trace fetch error match=${id}: ${error?.name ?? 'error'}`);
        return { ok: false, reason: 'worker_failed' };
      }
    },
  };
}
