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
import { fetchReplay } from '../matchReview/replayIngest/download.js';
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
 *   fetchReplayImpl?: typeof fetchReplay,
 *   runExtractorImpl?: typeof runExtractor,
 *   buildImpl?: typeof buildTraceFromExtract,
 *   maxDownloadBytes?: number,
 *   log?: (msg: string) => void,
 * }} deps
 */
export function createTracePipeline(deps) {
  const { getMatchDetail, extractorBin, store } = deps;
  const fetchReplayImpl = deps.fetchReplayImpl ?? fetchReplay;
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
      if (!url || !isReplayUrl(url)) return fail('no_replay_url');

      onStage('downloading');
      dir = await mkdtemp(join(deps.workRoot ?? tmpdir(), 'trace-'));
      // The extractor sniffs bzip2 / zstd / raw from the content, not the name.
      const demo = join(dir, 'replay.dem');
      let bytes = 0;
      try {
        const s = within('downloading');
        const res = await fetchReplayImpl(url, { signal: s });
        if (res.status === 404 || res.status === 410) { await res.body?.cancel?.(); return fail('replay_gone'); }
        if (!res.ok || !res.body) { await res.body?.cancel?.(); return fail('download_failed'); }
        const cap = new Transform({ transform(chunk, _enc, cb) { bytes += chunk.length; cb(bytes > maxDownload ? Object.assign(new Error('too_large'), { code: 'too_large' }) : null, chunk); } });
        await pipeline(Readable.fromWeb(res.body), cap, createWriteStream(demo), { signal: s });
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
 * The same pipeline on a private worker service (scripts/trace-worker.mjs):
 * the web instance has neither the extractor nor the memory for it. The web
 * side finds the replay address (it has the match sources); the worker
 * checks that address again before fetching it. `auth` returns the
 * Authorization header (a Google ID token for Cloud Run).
 * @param {{ url: string, getMatchDetail: (id: number) => Promise<any>, auth?: () => Promise<string>, fetchImpl?: typeof fetch, timeoutMs?: number }} o
 */
export function createRemotePipeline({ url, getMatchDetail, auth, fetchImpl = (...a) => fetch(...a), timeoutMs = 840_000 }) {
  const endpoint = new URL('/run', url).toString();
  return {
    /** @param {number | string} matchId @param {{ onStage?: (stage: string) => void, signal?: AbortSignal }} [o] */
    async run(matchId, { onStage = () => {}, signal } = {}) {
      const id = Number(matchId);
      onStage('locating');
      let raw;
      try { raw = await getMatchDetail(id); } catch { return fail('no_match'); }
      const replay = raw ? replayUrl(raw) : null;
      if (!replay || !isReplayUrl(replay)) return fail('no_replay_url');
      onStage('downloading');
      try {
        const res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: await auth() } : {}) },
          body: JSON.stringify({ match_id: id, replay_url: replay }),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        });
        const body = await res.json().catch(() => null);
        if (body && typeof body.ok === 'boolean') return body.ok ? { ok: true, bytes: body.bytes ?? null } : fail(typeof body.reason === 'string' ? body.reason.slice(0, 40) : 'extract_failed');
        return fail('worker_failed');
      } catch { return fail('worker_failed'); }
    },
  };
}

/** A replay address must be for the match it is said to be for. */
export const replayUrlIsFor = (url, matchId) => typeof url === 'string' && isReplayUrl(url) && new RegExp(`/570/${Number(matchId)}_\\d{1,12}\\.dem(\\.bz2)?$`).test(new URL(url).pathname);
