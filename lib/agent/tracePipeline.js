/**
 * Match id → stored match trace: find the replay, download it, run the
 * extractor, compact the output, store it. One function, all IO injected.
 *
 *   locating → downloading → extracting → building → storing
 *
 * Safety:
 * - The replay address comes from the match record (OpenDota's replay_url,
 *   or cluster + salt from the GC) and must be a Valve / Perfect World
 *   replay host (discovery.js); the download refuses private addresses and
 *   never follows redirects (download.js). Nothing a visitor sends is part
 *   of that address.
 * - Size caps on the download and on the extractor's input and output
 *   (capacity.js), a deadline per stage, and the working directory is
 *   removed whatever happens.
 * - The extractor must report the match id that was asked for.
 *
 * A failure is a `reason`, never an exception:
 *   no_match · no_replay_url · replay_gone · download_failed · too_large ·
 *   extract_failed · wrong_match · store_failed · timeout
 *
 * `no_replay_url` means "not yet": a game that just ended gets its address a few minutes later, and the reader
 * is told to try again. For a game that ended longer ago than replays are kept, the address is not coming:
 * that is `replay_gone`, said once, instead of a failure on every retry (seen on 2026-11-25: one old game
 * asked for nine times in an hour).
 */
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gzipSync } from 'node:zlib';
import { REPLAY_MAX_DEMO_BYTES, REPLAY_MAX_DOWNLOAD_BYTES, REPLAY_MAX_OUTPUT_BYTES } from '../matchReview/replayIngest/capacity.js';
import { isReplayUrl, replayUrl } from '../matchReview/replayIngest/discovery.js';
import { downloadReplay } from '../matchReview/replayIngest/edgeDownload.js';
import { runExtractor } from '../matchReview/replayIngest/extractor.js';
import { buildTraceFromExtract } from './traceBuild.js';

export const PIPELINE_STAGES = ['locating', 'downloading', 'extracting', 'building', 'storing'];
const DEADLINE_MS = { downloading: 180_000, extracting: 360_000, building: 120_000 };
const EXPIRED_DOWNLOAD_REASONS = new Set(['download_failed', 'timeout']);
const fail = (reason) => ({ ok: false, reason });
const hostOf = (url) => { try { return typeof url === 'string' ? new URL(url).hostname : null; } catch { return null; } };
const elapsedMs = (since, now) => Math.max(0, Math.round(now - since));
const metricNum = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

/**
 * @param {{
 *   getMatchDetail: (id: number) => Promise<any>,
 *   extractorBin: string,
 *   store: { put: (matchId: number | string, body: Buffer) => Promise<void> },
 *   workRoot?: string,
 *   fetchReplayImpl?: (url: string, o: { signal: AbortSignal }) => Promise<any>, (a test's one response; without it the download goes edge by edge)
 *   downloadImpl?: typeof downloadReplay,
 *   runExtractorImpl?: typeof runExtractor,
 *   buildImpl?: typeof buildTraceFromExtract,
 *   maxDownloadBytes?: number,
 *   worker?: string,
 *   log?: (msg: string) => void,
 *   stageLog?: ((line: string) => void) | null,
 *   onMetrics?: ((record: any) => void) | null,
 *   now?: () => number,
 * }} deps
 */
/** Valve keeps a game's replay for about two weeks. */
export const REPLAY_KEPT_DAYS = 14;
/** No game lasts this long: when the record gives no duration, the game ended at most this long after it began. */
export const LONGEST_GAME_HOURS = 24;

/**
 * Did this game end longer ago than replays are kept — for certain? "Gone" is final, so it is said only when
 * the match record's own times prove it:
 * - no start time: not known, so no (the reader may try again);
 * - start and duration: the end is known;
 * - a start with no duration (some sources give none): the end is somewhere within LONGEST_GAME_HOURS of the
 *   start, and it is "gone" only if even the latest possible end is past keeping. A game that began 14 days
 *   and ten minutes ago may have ended inside the two weeks: not said.
 * @param {{ start_time?: number, duration?: number | null } | null | undefined} match  the match record (start_time in Unix seconds)
 * @param {number} nowMs
 */
export function replayPastKeeping(match, nowMs) {
  const start = match?.start_time;
  if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(nowMs)) return false;
  const lasted = Number.isFinite(match.duration) && match.duration > 0 ? match.duration : LONGEST_GAME_HOURS * 3600;
  return nowMs - (start + lasted) * 1000 > REPLAY_KEPT_DAYS * 86_400_000;
}

export function createTracePipeline(deps) {
  const { getMatchDetail, extractorBin, store } = deps;
  const nowMs = deps.now ?? (() => Date.now());
  // A test passes fetchReplayImpl (one response); otherwise the download goes edge by edge (edgeDownload.js).
  const fetchReplayImpl = deps.fetchReplayImpl ?? null;
  const downloadImpl = deps.downloadImpl ?? downloadReplay;
  const runExtractorImpl = deps.runExtractorImpl ?? runExtractor;
  const buildImpl = deps.buildImpl ?? buildTraceFromExtract;
  const maxDownload = deps.maxDownloadBytes ?? REPLAY_MAX_DOWNLOAD_BYTES;
  const worker = typeof deps.worker === 'string' && deps.worker ? deps.worker : 'local';
  const log = deps.log ?? (() => {});
  const stageLog = deps.stageLog === undefined ? log : deps.stageLog;
  const onMetrics = typeof deps.onMetrics === 'function' ? deps.onMetrics : null;

  /** @param {number | string} matchId @param {{ onStage?: (stage: string) => void, signal?: AbortSignal }} [o] */
  async function run(matchId, { onStage = () => {}, signal } = {}) {
    const id = Number(matchId);
    if (!Number.isSafeInteger(id) || id <= 0) return fail('no_match');
    const started = nowMs();
    let dir = null;
    let host = null;
    let locatingMs = null;
    let downloadingMs = null;
    let extractingMs = null;
    let buildingMs = null;
    let storingMs = null;
    let demoBytes = null;
    let traceBytes = null;
    const finish = (ok, reason = null, detail = null) => {
      const totalMs = elapsedMs(started, nowMs());
      const record = {
        event: 'trace_pipeline',
        match: id,
        ok,
        host,
        worker,
        locating_ms: locatingMs,
        downloading_ms: downloadingMs,
        extracting_ms: extractingMs,
        building_ms: buildingMs,
        storing_ms: storingMs,
        total_ms: totalMs,
        demo_bytes: demoBytes,
        trace_bytes: traceBytes,
        reason,
        ...(detail ? { detail } : {}),
      };
      onMetrics?.(record);
      stageLog?.(JSON.stringify(record));
      return ok ? { ok: true, bytes: traceBytes, ms: totalMs } : fail(reason);
    };
    const within = (stage) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(DEADLINE_MS[stage])]) : AbortSignal.timeout(DEADLINE_MS[stage]));
    try {
      onStage('locating');
      const locateBegan = nowMs();
      let raw;
      try { raw = await getMatchDetail(id); } catch { locatingMs = elapsedMs(locateBegan, nowMs()); return finish(false, 'no_match'); }
      locatingMs = elapsedMs(locateBegan, nowMs());
      const pastKeeping = replayPastKeeping(raw, nowMs());
      const url = raw ? replayUrl(raw) : null;
      if (!url || !isReplayUrl(url)) return finish(false, pastKeeping ? 'replay_gone' : 'no_replay_url', pastKeeping ? 'past_keeping' : null);
      host = hostOf(url);

      onStage('downloading');
      dir = await mkdtemp(join(deps.workRoot ?? tmpdir(), 'trace-'));
      // The extractor sniffs bzip2 / zstd / raw from the content, not the name.
      const demo = join(dir, 'replay.dem');
      const dlBegan = nowMs();
      let bytes = 0;
      try {
        const s = within('downloading');
        if (!fetchReplayImpl) {
          try { bytes = (await downloadImpl(url, demo, { signal: s, maxBytes: maxDownload, log })).bytes; } catch (error) {
            downloadingMs = elapsedMs(dlBegan, nowMs());
            if (error?.code === 'replay_gone' || error?.code === 'too_large') return finish(false, error.code, error?.why ?? null);
            if (signal?.aborted) return finish(false, 'timeout', 'caller_aborted');
            const baseReason = s.aborted ? 'timeout' : 'download_failed';
            const reason = pastKeeping && error?.why !== 'write_error' ? 'replay_gone' : baseReason;
            log(`trace download failed match=${id} host=${host ?? 'unknown'}: ${error?.code ?? error?.name ?? 'error'}${error?.why ? ` (${error.why})` : ''}`);
            return finish(false, reason, reason === 'replay_gone' ? 'past_keeping' : (error?.why ?? null));
          }
        } else {
          const res = await fetchReplayImpl(url, { signal: s });
          if (res.status === 404 || res.status === 410) { await res.body?.cancel?.(); downloadingMs = elapsedMs(dlBegan, nowMs()); return finish(false, 'replay_gone', `http_${res.status}`); }
          if (!res.ok || !res.body) { await res.body?.cancel?.(); downloadingMs = elapsedMs(dlBegan, nowMs()); return finish(false, pastKeeping ? 'replay_gone' : 'download_failed', pastKeeping ? 'past_keeping' : `http_${res.status ?? 'error'}`); }
          const cap = new Transform({ transform(chunk, _enc, cb) { bytes += chunk.length; cb(bytes > maxDownload ? Object.assign(new Error('too_large'), { code: 'too_large' }) : null, chunk); } });
          await pipeline(Readable.fromWeb(res.body), cap, createWriteStream(demo), { signal: s });
        }
      } catch (error) {
        downloadingMs = elapsedMs(dlBegan, nowMs());
        if (error?.code === 'too_large') return finish(false, 'too_large');
        if (signal?.aborted) return finish(false, 'timeout', 'caller_aborted');
        const baseReason = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'download_failed';
        const reason = pastKeeping ? 'replay_gone' : baseReason;
        log(`trace download failed match=${id} host=${host ?? 'unknown'}: ${error?.name ?? 'error'}`);
        return finish(false, reason, reason === 'replay_gone' ? 'past_keeping' : null);
      }
      downloadingMs = elapsedMs(dlBegan, nowMs());
      demoBytes = bytes;
      if (bytes < 1024) return finish(false, pastKeeping ? 'replay_gone' : 'download_failed', pastKeeping ? 'past_keeping' : 'too_small');

      onStage('extracting');
      const out = join(dir, 'out');
      const extractBegan = nowMs();
      let summary;
      try {
        summary = await runExtractorImpl(extractorBin, [demo, out, '--max-bytes', String(REPLAY_MAX_DEMO_BYTES), '--max-output-bytes', String(REPLAY_MAX_OUTPUT_BYTES), '--quiet'], within('extracting'));
      } catch (error) {
        extractingMs = elapsedMs(extractBegan, nowMs());
        log(`trace extract failed match=${id}: ${error?.message ?? 'error'}`);
        return finish(false, signal?.aborted ? 'timeout' : 'extract_failed');
      }
      extractingMs = elapsedMs(extractBegan, nowMs());
      if (Number(summary?.match_id) !== id) return finish(false, 'wrong_match');

      onStage('building');
      const buildBegan = nowMs();
      let body;
      try {
        const trace = await buildImpl(out, { match_id: id, extractor: { trace_version: summary.trace_version ?? null, clock: summary.clock ?? null } }, within('building'));
        if (trace.heroes.length !== 10 || trace.n < 60) { buildingMs = elapsedMs(buildBegan, nowMs()); return finish(false, 'extract_failed'); }
        body = gzipSync(JSON.stringify(trace));
      } catch (error) {
        buildingMs = elapsedMs(buildBegan, nowMs());
        log(`trace build failed match=${id}: ${error?.name ?? 'error'}`);
        return finish(false, 'extract_failed');
      }
      buildingMs = elapsedMs(buildBegan, nowMs());
      traceBytes = body.length;

      onStage('storing');
      const storeBegan = nowMs();
      try { await store.put(id, body); } catch { storingMs = elapsedMs(storeBegan, nowMs()); return finish(false, 'store_failed'); }
      storingMs = elapsedMs(storeBegan, nowMs());
      const res = finish(true);
      log(`trace ready match=${id} host=${host ?? 'unknown'} demo_bytes=${bytes} trace_bytes=${body.length} ms=${res.ms}`);
      return res;
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return { run };
}

/**
 * What sends a job to the fallback worker: the first could not download the replay (`download_failed`, or `timeout`
 * when its download stage ran out), or did not answer. Both runs share one deadline (`timeoutMs`): the fallback gets
 * what is left, and is not asked with less than FALLBACK_MIN_MS — so a parse never outlives the site's limit on it.
 */
export const FALLBACK_ON = new Set(['download_failed', 'worker_failed', 'timeout']);
export const FALLBACK_MIN_MS = 180_000;
/** Default ceiling on the first worker call when a fallback exists, leaving room for the fallback to run. */
export const PRIMARY_FALLBACK_MAX_MS = 420_000;
const CN_REPLAY_HOST = /^replay\d+\.dota2\.com\.cn$/i;
const isCnReplayUrl = (url) => { try { return CN_REPLAY_HOST.test(new URL(url).hostname); } catch { return false; } };

/**
 * The same pipeline on a private worker service (scripts/trace-worker.mjs):
 * the web instance has neither the extractor nor the memory for it. The web
 * side finds the replay address (it has the match sources); the worker
 * checks that address again before fetching it. `auth` returns the
 * Authorization header (a Google ID token for Cloud Run).
 *
 * `fallback` ({ url, auth }): a second worker in another region (2026-11-27: some CDN edges never answer one
 * region's egress). When the first worker could not download the replay, or did not answer, the same job goes to
 * it once. A replay that is gone, too large, or another match's is not asked again: no worker would do better.
 * When `preferFallbackForCn` is set, Perfect World replay hosts (`replayNNN.dota2.com.cn`) try the fallback
 * worker first (e.g. asia-east2) and fall back to the primary on failure.
 * @param {{ url: string, getMatchDetail: (id: number) => Promise<any>, auth?: () => Promise<string>, fallback?: { url: string, auth?: () => Promise<string> } | null, preferFallbackForCn?: boolean, primaryTimeoutMs?: number, fetchImpl?: typeof fetch, timeoutMs?: number, now?: () => number, log?: (line: string) => void, stageLog?: ((line: string) => void) | null, onMetrics?: ((record: any) => void) | null }} o
 */
export function createRemotePipeline({ url, getMatchDetail, auth, fallback = null, preferFallbackForCn = false, primaryTimeoutMs, fetchImpl = (...a) => fetch(...a), timeoutMs = 840_000, now = () => Date.now(), log = () => {}, stageLog = null, onMetrics = null }) {
  const primary = { name: 'primary', endpoint: new URL('/run', url).toString(), auth };
  const spare = fallback?.url ? { name: 'fallback', endpoint: new URL('/run', fallback.url).toString(), auth: fallback.auth } : null;
  // When a fallback exists, bound the first worker so a hanging primary cannot consume the entire deadline and
  // starve the fallback (always reserving at least FALLBACK_MIN_MS when timeoutMs allows).
  const firstBudgetMs = spare
    ? Math.max(1, Math.min(
      timeoutMs,
      Number.isFinite(primaryTimeoutMs) && primaryTimeoutMs > 0
        ? primaryTimeoutMs
        : Math.min(PRIMARY_FALLBACK_MAX_MS, Math.max(FALLBACK_MIN_MS, timeoutMs - FALLBACK_MIN_MS - 30_000)),
    ))
    : timeoutMs;
  const parseWorkerMetrics = (m) => (m && typeof m === 'object' ? {
    downloading_ms: metricNum(m.downloading_ms),
    extracting_ms: metricNum(m.extracting_ms),
    building_ms: metricNum(m.building_ms),
    storing_ms: metricNum(m.storing_ms),
    demo_bytes: metricNum(m.demo_bytes),
  } : null);
  const ask = async (target, id, replay, signal, budgetMs) => {
    const t0 = now();
    try {
      const res = await fetchImpl(target.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(target.auth ? { Authorization: await target.auth() } : {}) },
        body: JSON.stringify({ match_id: id, replay_url: replay }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(budgetMs)]) : AbortSignal.timeout(budgetMs),
      });
      const body = await res.json().catch(() => null);
      const workerMs = elapsedMs(t0, now());
      if (body && typeof body.ok === 'boolean') {
        const result = body.ok ? { ok: true, bytes: body.bytes ?? null } : fail(typeof body.reason === 'string' ? body.reason.slice(0, 40) : 'extract_failed');
        const rawDetail = typeof body.detail === 'string' ? body.detail : (typeof body.metrics?.detail === 'string' ? body.metrics.detail : null);
        const detail = rawDetail && /^[a-z0-9_]{1,40}$/i.test(rawDetail) ? rawDetail : null;
        return { result, workerMs, metrics: parseWorkerMetrics(body.metrics), detail };
      }
      return { result: fail('worker_failed'), workerMs, metrics: null, detail: null };
    } catch { return { result: fail('worker_failed'), workerMs: elapsedMs(t0, now()), metrics: null, detail: null }; }
  };
  return {
    /** @param {number | string} matchId @param {{ onStage?: (stage: string) => void, signal?: AbortSignal }} [o] */
    async run(matchId, { onStage = () => {}, signal } = {}) {
      const id = Number(matchId);
      const started = now();
      let host = null;
      let locatingMs = null;
      const emit = (result, { worker = null, workerMs = null, metrics = null, fallbackTried = false, firstWorker = null, firstReason = null, detail = null } = {}) => {
        const record = {
          event: 'trace_pipeline',
          match: id,
          ok: result.ok,
          host,
          worker,
          locating_ms: locatingMs,
          downloading_ms: metrics?.downloading_ms ?? null,
          extracting_ms: metrics?.extracting_ms ?? null,
          building_ms: metrics?.building_ms ?? null,
          storing_ms: metrics?.storing_ms ?? null,
          worker_ms: workerMs,
          total_ms: elapsedMs(started, now()),
          demo_bytes: metrics?.demo_bytes ?? null,
          trace_bytes: result.ok ? (result.bytes ?? null) : null,
          reason: result.ok ? null : result.reason,
          ...(fallbackTried ? { fallback_tried: true, first_worker: firstWorker, first_reason: firstReason } : {}),
          ...(detail ? { detail } : {}),
        };
        if (typeof onMetrics === 'function') onMetrics(record);
        stageLog?.(JSON.stringify(record));
        return result;
      };
      onStage('locating');
      const locateBegan = now();
      let raw;
      try { raw = await getMatchDetail(id); } catch { locatingMs = elapsedMs(locateBegan, now()); return emit(fail('no_match')); }
      locatingMs = elapsedMs(locateBegan, now());
      const pastKeeping = replayPastKeeping(raw, now());
      const replay = raw ? replayUrl(raw) : null;
      if (!replay || !isReplayUrl(replay)) return emit(fail(pastKeeping ? 'replay_gone' : 'no_replay_url'), { detail: pastKeeping ? 'past_keeping' : null });
      host = hostOf(replay);
      onStage('downloading');
      const cnFirst = Boolean(preferFallbackForCn && spare && isCnReplayUrl(replay));
      const firstTarget = cnFirst ? spare : primary;
      const secondTarget = cnFirst ? primary : spare;
      const began = now();
      const shouldUpgradeExpired = (call) => !call.result.ok && !signal?.aborted && pastKeeping && EXPIRED_DOWNLOAD_REASONS.has(call.result.reason) && call.detail !== 'write_error';
      const firstCall = await ask(firstTarget, id, replay, signal, firstBudgetMs);
      const first = firstCall.result;
      // An already-expired match whose first replay download failed on the CDN is gone: do not burn the fallback
      // worker or retry loop on it. Local worker write failures (`write_error`) stay retryable and may fall back.
      if (shouldUpgradeExpired(firstCall)) {
        return emit(fail('replay_gone'), { worker: firstTarget.name, workerMs: firstCall.workerMs, metrics: firstCall.metrics, detail: 'past_keeping' });
      }
      if (first.ok || !secondTarget || signal?.aborted || !FALLBACK_ON.has(first.reason)) {
        return emit(first, { worker: firstTarget.name, workerMs: firstCall.workerMs, metrics: firstCall.metrics, detail: firstCall.detail });
      }
      // One deadline for both: the second worker gets what the first left, or is not asked.
      const left = timeoutMs - (now() - began);
      if (left < FALLBACK_MIN_MS) {
        log(`trace fallback match=${id} skipped: ${Math.round(left / 1000)} s left`);
        return emit(first, { worker: firstTarget.name, workerMs: firstCall.workerMs, metrics: firstCall.metrics, detail: 'fallback_skipped_low_budget' });
      }
      log(`trace fallback match=${id} after=${first.reason}${cnFirst ? ' from=cn_fallback' : ''}`);
      const secondCall = await ask(secondTarget, id, replay, signal, left);
      const upgradedSecond = shouldUpgradeExpired(secondCall);
      const second = upgradedSecond ? fail('replay_gone') : secondCall.result;
      log(`trace fallback match=${id} -> ${second.ok ? 'ok' : second.reason}`);
      return emit(second, {
        worker: secondTarget.name,
        workerMs: secondCall.workerMs,
        metrics: secondCall.metrics,
        fallbackTried: true,
        firstWorker: firstTarget.name,
        firstReason: first.reason,
        detail: upgradedSecond ? 'past_keeping' : secondCall.detail,
      });
    },
  };
}

/** A replay address must be for the match it is said to be for. */
export const replayUrlIsFor = (url, matchId) => typeof url === 'string' && isReplayUrl(url) && new RegExp(`/570/${Number(matchId)}_\\d{1,12}\\.dem(\\.bz2)?$`).test(new URL(url).pathname);
