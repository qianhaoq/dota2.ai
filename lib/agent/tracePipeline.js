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
const fail = (reason) => ({ ok: false, reason });

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
 *   log?: (msg: string) => void,
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
  const log = deps.log ?? (() => {});

  /** @param {number | string} matchId @param {{ onStage?: (stage: string) => void, signal?: AbortSignal }} [o] */
  async function run(matchId, { onStage = () => {}, signal } = {}) {
    const id = Number(matchId);
    if (!Number.isSafeInteger(id) || id <= 0) return fail('no_match');
    const started = Date.now();
    let dir = null;
    const within = (stage) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(DEADLINE_MS[stage])]) : AbortSignal.timeout(DEADLINE_MS[stage]));
    try {
      onStage('locating');
      let raw;
      try { raw = await getMatchDetail(id); } catch { return fail('no_match'); }
      const url = raw ? replayUrl(raw) : null;
      if (!url || !isReplayUrl(url)) return fail(replayPastKeeping(raw, nowMs()) ? 'replay_gone' : 'no_replay_url');

      onStage('downloading');
      dir = await mkdtemp(join(deps.workRoot ?? tmpdir(), 'trace-'));
      // The extractor sniffs bzip2 / zstd / raw from the content, not the name.
      const demo = join(dir, 'replay.dem');
      let bytes = 0;
      try {
        const s = within('downloading');
        if (!fetchReplayImpl) {
          try { bytes = (await downloadImpl(url, demo, { signal: s, maxBytes: maxDownload, log })).bytes; } catch (error) {
            if (error?.code === 'replay_gone' || error?.code === 'too_large') return fail(error.code);
            if (signal?.aborted) return fail('timeout');
            log(`trace download failed match=${id}: ${error?.code ?? error?.name ?? 'error'}${error?.why ? ` (${error.why})` : ''}`);
            return fail(s.aborted ? 'timeout' : 'download_failed');
          }
        } else {
        const res = await fetchReplayImpl(url, { signal: s });
        if (res.status === 404 || res.status === 410) { await res.body?.cancel?.(); return fail('replay_gone'); }
        if (!res.ok || !res.body) { await res.body?.cancel?.(); return fail('download_failed'); }
        const cap = new Transform({ transform(chunk, _enc, cb) { bytes += chunk.length; cb(bytes > maxDownload ? Object.assign(new Error('too_large'), { code: 'too_large' }) : null, chunk); } });
        await pipeline(Readable.fromWeb(res.body), cap, createWriteStream(demo), { signal: s });
        }
      } catch (error) {
        if (error?.code === 'too_large') return fail('too_large');
        if (signal?.aborted) return fail('timeout');
        log(`trace download failed match=${id}: ${error?.name ?? 'error'}`);
        return fail(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'download_failed');
      }
      if (bytes < 1024) return fail('download_failed');

      onStage('extracting');
      const out = join(dir, 'out');
      let summary;
      try {
        summary = await runExtractorImpl(extractorBin, [demo, out, '--max-bytes', String(REPLAY_MAX_DEMO_BYTES), '--max-output-bytes', String(REPLAY_MAX_OUTPUT_BYTES), '--quiet'], within('extracting'));
      } catch (error) {
        log(`trace extract failed match=${id}: ${error?.message ?? 'error'}`);
        return fail(signal?.aborted ? 'timeout' : 'extract_failed');
      }
      if (Number(summary?.match_id) !== id) return fail('wrong_match');

      onStage('building');
      let body;
      try {
        const trace = await buildImpl(out, { match_id: id, extractor: { trace_version: summary.trace_version ?? null, clock: summary.clock ?? null } }, within('building'));
        if (trace.heroes.length !== 10 || trace.n < 60) return fail('extract_failed');
        body = gzipSync(JSON.stringify(trace));
      } catch (error) {
        log(`trace build failed match=${id}: ${error?.name ?? 'error'}`);
        return fail('extract_failed');
      }

      onStage('storing');
      try { await store.put(id, body); } catch { return fail('store_failed'); }
      log(`trace ready match=${id} demo_bytes=${bytes} trace_bytes=${body.length} ms=${Date.now() - started}`);
      return { ok: true, bytes: body.length, ms: Date.now() - started };
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
 * @param {{ url: string, getMatchDetail: (id: number) => Promise<any>, auth?: () => Promise<string>, fallback?: { url: string, auth?: () => Promise<string> } | null, preferFallbackForCn?: boolean, primaryTimeoutMs?: number, fetchImpl?: typeof fetch, timeoutMs?: number, now?: () => number, log?: (line: string) => void }} o
 */
export function createRemotePipeline({ url, getMatchDetail, auth, fallback = null, preferFallbackForCn = false, primaryTimeoutMs, fetchImpl = (...a) => fetch(...a), timeoutMs = 840_000, now = () => Date.now(), log = () => {} }) {
  const primary = { endpoint: new URL('/run', url).toString(), auth };
  const spare = fallback?.url ? { endpoint: new URL('/run', fallback.url).toString(), auth: fallback.auth } : null;
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
  const ask = async (target, id, replay, signal, budgetMs) => {
    try {
      const res = await fetchImpl(target.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(target.auth ? { Authorization: await target.auth() } : {}) },
        body: JSON.stringify({ match_id: id, replay_url: replay }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(budgetMs)]) : AbortSignal.timeout(budgetMs),
      });
      const body = await res.json().catch(() => null);
      if (body && typeof body.ok === 'boolean') return body.ok ? { ok: true, bytes: body.bytes ?? null } : fail(typeof body.reason === 'string' ? body.reason.slice(0, 40) : 'extract_failed');
      return fail('worker_failed');
    } catch { return fail('worker_failed'); }
  };
  return {
    /** @param {number | string} matchId @param {{ onStage?: (stage: string) => void, signal?: AbortSignal }} [o] */
    async run(matchId, { onStage = () => {}, signal } = {}) {
      const id = Number(matchId);
      onStage('locating');
      let raw;
      try { raw = await getMatchDetail(id); } catch { return fail('no_match'); }
      const replay = raw ? replayUrl(raw) : null;
      if (!replay || !isReplayUrl(replay)) return fail(replayPastKeeping(raw, now()) ? 'replay_gone' : 'no_replay_url');
      onStage('downloading');
      const cnFirst = Boolean(preferFallbackForCn && spare && isCnReplayUrl(replay));
      const firstTarget = cnFirst ? spare : primary;
      const secondTarget = cnFirst ? primary : spare;
      const began = now();
      const first = await ask(firstTarget, id, replay, signal, firstBudgetMs);
      if (first.ok || !secondTarget || signal?.aborted || !FALLBACK_ON.has(first.reason)) return first;
      // One deadline for both: the second worker gets what the first left, or is not asked.
      const left = timeoutMs - (now() - began);
      if (left < FALLBACK_MIN_MS) { log(`trace fallback match=${id} skipped: ${Math.round(left / 1000)} s left`); return first; }
      log(`trace fallback match=${id} after=${first.reason}${cnFirst ? ' from=cn_fallback' : ''}`);
      const second = await ask(secondTarget, id, replay, signal, left);
      log(`trace fallback match=${id} -> ${second.ok ? 'ok' : second.reason}`);
      return second;
    },
  };
}

/** A replay address must be for the match it is said to be for. */
export const replayUrlIsFor = (url, matchId) => typeof url === 'string' && isReplayUrl(url) && new RegExp(`/570/${Number(matchId)}_\\d{1,12}\\.dem(\\.bz2)?$`).test(new URL(url).pathname);
