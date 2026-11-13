import { mkdir, mkdtemp, readFile, writeFile, rename, rm, readdir, stat, statfs } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { adaptReplayEvents, applyReplayArtifact, replayStatusPayload, isVerifiedReplay } from '../../../packages/review-engine/src/replay.js';
import { createParseRequestTracker, createParseRequestBudget } from '../matchParse.js';
import { runExtractor, readReviewEvents, hashFile, readReplaySupplement, extractorMetadata } from './extractor.js';

export {isReplayUrl,replayUrl} from './discovery.js';
import {isReplayUrl,replayUrl} from './discovery.js';
async function diskBytes(dir) {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes:true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? await diskBytes(p) : (await stat(p)).size;
  }
  return total;
}
const fail = status => Object.assign(new Error(status), { replayStatus:status });
/** Explicit, synchronous bounded job. GET never starts work. Per-process budgets
 * plus a filesystem lock serialize disk reservations across workers sharing home. */
export function createReplayIngest({ env = process.env, fetchImpl = fetch, extract = runExtractor,
  tracker = createParseRequestTracker(), budget = createParseRequestBudget({ globalMax:3, perClientMax:1 }),
  maxDownload = 256_000_000, maxDemo = 512_000_000, maxOutput = 512_000_000, diskBudget = 1_500_000_000, timeoutMs = 720000, onPhase = async () => {}, onDownload = async () => {}, strictVerification = false } = {}) {
  const home = env.REPLAY_HOME || '/tmp/dota2ai-replays';
  const bin = env.DOTA_EXTRACT_BIN || env.COACH_EXTRACT_BIN;
  const enabled = env.REPLAY_INGEST_ENABLED === '1' && Boolean(bin);
  const path = id => join(home, `${id}.json`);
  async function read(id) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError('Invalid match ID');
    try {
      if ((await stat(path(id))).size > 8_000_000) return {match_id:id,status:'replay_failed',reason:'artifact_size_limit'};
      const a = JSON.parse(await readFile(path(id), 'utf8'));
      if (a?.match_id !== id) return null;
      if (a.status === 'replay_parsed' && !isVerifiedReplay(a,id)) return {match_id:id,status:'replay_failed',reason:'invalid_artifact'};
      return a;
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      if (e instanceof SyntaxError) return {match_id:id,status:'replay_failed',reason:'invalid_artifact'};
      throw e;
    }
  }
  async function save(id, value) {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > 8_000_000) throw fail('replay_failed');
    await writeFile(`${path(id)}.part`, body, { mode:0o600 });
    await rename(`${path(id)}.part`, path(id));
  }
  return {
    enabled, read,
    async overlay(raw) {
      const artifact = await read(raw.match_id);
      // Availability describes this server, independently of historical evidence.
      return { ...(artifact ? applyReplayArtifact(raw, artifact) : raw), replay_ingest_available: enabled };
    },
    /** @param {object} raw @param {string} client @param {{signal?: AbortSignal, lang?: string}} [options] */
    async submit(raw, client, { signal:caller, lang = 'en' } = {}) {
      if (!enabled) return replayStatusPayload('replay_ingest_disabled', lang);
      const id = raw.match_id;
      const prior = await read(id);
      if (prior?.status === 'replay_parsed') return replayStatusPayload('replay_parsed', lang);
      const active = tracker.active(id);
      if (active) return replayStatusPayload(prior?.status ?? 'replay_pending', lang, active.retryAfterSec);
      const over = budget.tryConsume(client);
      if (over) return replayStatusPayload('throttled', lang, over.retryAfterSec);
      tracker.markRequested(id);
      const stageAbort=new AbortController();let phaseTimer;
      const enterPhase=async(name,ms)=>{clearTimeout(phaseTimer);phaseTimer=setTimeout(()=>stageAbort.abort(new Error('stage_timeout')),ms);await onPhase(name);};
      const signal = AbortSignal.any([stageAbort.signal,...(caller ? [caller] : []), AbortSignal.timeout(timeoutMs)]);
      const url = replayUrl(raw);
      const metadata = { match_id:id, fetched_at:new Date().toISOString(), replay_url_present:Boolean(raw.replay_url), replay_url:url, replay_salt:raw.replay_salt ?? null, cluster:raw.cluster ?? null, opendota_fetched_at:raw.opendota_fetched_at ?? null, status:'replay_pending' };
      let temp, locked = false, phase = 'setup';
      try {
        signal.throwIfAborted();
        await enterPhase('discovering',20000);
        await mkdir(home, { recursive:true, mode:0o700 });
        try { await mkdir(join(home, '.ingest-lock')); locked = true; } catch (e) { if (e.code === 'EEXIST') throw fail('throttled'); throw e; }
        if (await diskBytes(home) + maxDownload + maxDemo + maxOutput + 8_000_000 > diskBudget) throw fail('replay_failed');
        const fs = await statfs(home);
        if (fs.bavail * fs.bsize < maxDownload + maxDemo + maxOutput + 8_000_000) throw fail('replay_failed');
        await save(id, metadata);
        if (!url) throw fail('replay_unavailable');
        if (!isReplayUrl(url)) throw fail('replay_invalid_url');
        metadata.url_host = new URL(url).hostname;
        temp = await mkdtemp(join(home, 'job-'));
        let response; phase = 'download'; await enterPhase('downloading',180000);
        try { response = await fetchImpl(url, { signal, redirect:'error' }); }
        catch (e) { console.error('replay_fetch_failed', metadata.url_host, e?.message); if (signal.aborted) throw e; throw fail('replay_cdn_error'); }
        metadata.http_status = response.status;
        if (!response.ok) {
          console.error('replay_fetch_status', metadata.url_host, response.status);
          await response.body?.cancel();
          throw fail([404,410].includes(response.status) ? 'replay_expired' : 'replay_cdn_error');
        }
        const hash = createHash('sha256'); let bytes = 0, prefix = Buffer.alloc(0);
        const limiter = new Transform({ transform(chunk, encoding, done) {
          bytes += chunk.length;
          if (bytes > maxDownload) { onDownload(chunk.length).then(()=>done(fail('replay_failed')),done); return; }
          if (prefix.length < 4096) prefix = Buffer.concat([prefix, chunk.subarray(0,4096-prefix.length)]);
          hash.update(chunk); onDownload(chunk.length).then(()=>done(null,chunk),done);
        } });
        try { await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(join(temp, 'download')), { signal }); }
        catch (e) { if (signal.aborted || bytes > maxDownload || e.message==='resource_limited' || e.message==='stale_lease') throw e; throw fail('replay_cdn_error'); }
        await enterPhase('verifying',60000);
        Object.assign(metadata, { download_bytes:bytes, download_sha256:hash.digest('hex') });
        if (bytes < 4096 && /expired|replay (?:not found|unavailable)/i.test(prefix.toString('utf8'))) throw fail('replay_expired');
        phase = 'extract';
        const decoded = await extract(bin, [join(temp,'download'), temp, '--decompress-only', '--max-bytes', String(maxDemo)], signal);
        if(decoded.format==='dem')decoded.format='raw';
        if (!['zstd','bz2','raw'].includes(decoded.format) || !Number.isSafeInteger(decoded.bytes) || decoded.bytes <= 19 || decoded.bytes > maxDemo || !/^[a-f0-9]{64}$/.test(decoded.sha256 ?? '')) throw fail('replay_failed');
        const demo = join(temp, 'replay.dem');
        const verified = await hashFile(demo, signal);
        if (verified.bytes !== decoded.bytes || verified.sha256 !== decoded.sha256) throw fail('replay_failed');
        Object.assign(metadata, { compression_format:decoded.format, demo_bytes:verified.bytes, demo_sha256:verified.sha256 });
        await enterPhase('extracting',360000);
        const parsed = await extract(bin, [demo, temp, '--max-bytes', String(maxDemo), '--max-output-bytes', String(maxOutput), '--quiet'], signal);
        const contract = extractorMetadata(parsed, id);
        if(strictVerification && (parsed.match_id!==id||parsed.trace_version!==4||!parsed.clock))throw fail('replay_failed');
        await enterPhase('compacting',60000);
        const trace = await readReviewEvents(join(temp,'trace','events.jsonl'), signal);
        const supplement = await readReplaySupplement(join(temp,'trace'), trace.events, signal);
        const artifact = adaptReplayEvents(raw, trace.events, { ...metadata, parsed_at:new Date().toISOString(), parse_ms:parsed.ms, ...contract, trace_rows:trace.rows }, supplement.metadata, supplement.positions);
        signal.throwIfAborted();
        await save(id, artifact);
        tracker.markResult(id);
        return replayStatusPayload('replay_parsed', lang);
      } catch (e) {
        if (caller?.aborted) { tracker.markAborted(id); if (locked) await save(id, { ...metadata, status:'replay_failed', reason:'client_aborted' }); throw e; }
        const status = e.message==='resource_limited' ? 'resource_limited' : e.replayStatus || (phase === 'download' && signal.aborted ? 'replay_cdn_error' : 'replay_failed');
        if (locked) await save(id, { ...metadata, status });
        tracker.markResult(id, { failed:true });
        return replayStatusPayload(status, lang, status === 'throttled' ? 60 : null);
      } finally {
        clearTimeout(phaseTimer);
        if (temp) await rm(temp, { recursive:true, force:true });
        if (locked) await rm(join(home,'.ingest-lock'), { recursive:true, force:true });
      }
    },
  };
}
