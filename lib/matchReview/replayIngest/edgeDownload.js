/**
 * Downloading a replay when some of a CDN's edges do not answer (2026-11-27: from Cloud Run asia-east1, some of the
 * Perfect World edges for replayNNN.dota2.com.cn hang for minutes while others answer at once; from elsewhere every
 * edge answers in two seconds).
 *
 * - Candidate edges: every public IPv4 the system resolver gives for the host, then those of the alternate resolvers
 *   (public resolvers in China: the CDN routes by resolver, so they hand out another set of edges). Duplicates once.
 * - Edges that failed recently are tried last (`badEdges`, kept for BAD_FOR_MS).
 * - The first RACE edges are asked at once; the first to send its first bytes within FIRST_BYTE_MS wins and the rest
 *   are cancelled. No answer in time: the next ones.
 * - While streaming, no data for STALL_MS ends that edge: the download resumes from the bytes already written with a
 *   Range request on the next edge. An edge that answers a resume with the whole file (200) restarts it from zero.
 * - 404 or 410 from two edges is a replay that is gone; from one, another edge is asked.
 *
 * Unchanged from download.js: only a Valve or Perfect World replay URL (isReplayUrl), a redirect is never followed,
 * and only a public address is connected to (the IP is chosen here and passed as the connection's lookup, so the
 * name is never resolved a second time).
 *
 * Every attempt is logged as one JSON line (`replay_edge`): host, ip, the resolver it came from, the outcome
 * (ok · first_byte_timeout · stall · http_<code> · connect_error · range_ignored), seconds and bytes — what a
 * log-based metric counts.
 */
import { lookup as systemLookup, promises as dnsPromises } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { createWriteStream } from 'node:fs';
import { isReplayUrl } from './discovery.js';
import { isPublicReplayV4 } from './download.js';

export const RACE = 3;
export const FIRST_BYTE_MS = 10_000;
export const STALL_MS = 15_000;
export const BAD_FOR_MS = 30 * 60_000;
export const ALT_RESOLVERS = ['223.5.5.5', '119.29.29.29'];

/** Edges that failed lately: ip → until (ms). One per process, shared by its downloads. */
export const badEdges = new Map();

const fail = (reason, extra = {}) => Object.assign(new Error(reason), { code: reason, ...extra });

/**
 * Candidate edges for a host: { ip, from } in order, system resolver first, the recently bad ones last.
 * @param {string} host
 * @param {{ resolveSystem?: (host: string) => Promise<string[]>, resolveWith?: (server: string, host: string) => Promise<string[]>, alternates?: string[], now?: () => number }} [o]
 */
export async function candidateEdges(host, o = {}) {
  const now = o.now ?? Date.now;
  const resolveSystem = o.resolveSystem ?? ((h) => new Promise((res) => systemLookup(h, { all: true, family: 4 }, (e, a = []) => res(e ? [] : a.map((x) => x.address)))));
  const resolveWith = o.resolveWith ?? (async (server, h) => { const r = new dnsPromises.Resolver({ timeout: 3000, tries: 1 }); r.setServers([server]); try { return await r.resolve4(h); } catch { return []; } });
  const lists = await Promise.all([resolveSystem(host).then((ips) => ips.map((ip) => ({ ip, from: 'system' }))), ...(o.alternates ?? ALT_RESOLVERS).map((s) => resolveWith(s, host).then((ips) => ips.map((ip) => ({ ip, from: s }))).catch(() => []))]);
  const seen = new Set(); const out = [];
  for (const e of lists.flat()) if (isPublicReplayV4(e.ip) && !seen.has(e.ip)) { seen.add(e.ip); out.push(e); }
  const t = now();
  for (const [ip, until] of badEdges) if (until <= t) badEdges.delete(ip);
  return [...out.filter((e) => !badEdges.has(e.ip)), ...out.filter((e) => badEdges.has(e.ip))];
}

/**
 * One GET to one edge. Resolves with the response once its headers are in; the caller reads the body.
 * @param {string} url @param {string} ip @param {{ signal: AbortSignal, from?: number }} o
 */
export function requestEdge(url, ip, { signal, from = 0 }) {
  if (!isPublicReplayV4(ip)) return Promise.reject(fail('not_public'));
  const lib = url.toLowerCase().startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.get(url, {
      signal,
      // The address is the one chosen here: a public one, never a second resolution of the name.
      lookup: (_host, options, cb) => (options?.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4)),
      headers: from > 0 ? { Range: `bytes=${from}-` } : {},
    }, (res) => resolve(res));
    req.on('error', reject);
  });
}

/**
 * Download `url` into the file `dest`, edge by edge. Resolves with { bytes, edges } or rejects with code
 * replay_gone · download_failed · too_large · timeout (the caller's signal).
 * @param {string} url @param {string} dest
 * @param {{ signal?: AbortSignal, maxBytes?: number, log?: (line: string) => void, request?: typeof requestEdge, edges?: (host: string) => Promise<{ ip: string, from: string }[]>, now?: () => number, firstByteMs?: number, stallMs?: number, race?: number }} [o]
 */
export async function downloadReplay(url, dest, o = {}) {
  if (!isReplayUrl(url)) throw fail('invalid_replay_url');
  const now = o.now ?? Date.now;
  const request = o.request ?? requestEdge;
  const log = o.log ?? ((line) => console.log(line));
  const firstByteMs = o.firstByteMs ?? FIRST_BYTE_MS; const stallMs = o.stallMs ?? STALL_MS; const race = o.race ?? RACE;
  const host = new URL(url).hostname;
  const queue = await (o.edges ?? candidateEdges)(host);
  if (!queue.length) throw fail('download_failed', { why: 'no_public_edge' });
  let bytes = 0; let gone = 0; const tried = [];
  let file = createWriteStream(dest);
  const note = (e, outcome, started, got) => {
    tried.push({ ip: e.ip, outcome });
    if (outcome !== 'ok' && outcome !== 'http_404' && outcome !== 'http_410') badEdges.set(e.ip, now() + BAD_FOR_MS);
    log(JSON.stringify({ event: 'replay_edge', host, ip: e.ip, from: e.from, outcome, seconds: Math.round((now() - started) / 100) / 10, bytes: got }));
  };
  const write = (chunk) => new Promise((res, rej) => file.write(chunk, (err) => (err ? rej(err) : res())));
  try {
    while (queue.length) {
      if (o.signal?.aborted) throw fail('timeout');
      // Ask the next few at once; the first to send data within firstByteMs streams, the rest are cancelled.
      const batch = queue.splice(0, race);
      const ctl = batch.map(() => new AbortController());
      const started = now();
      const offset = bytes;
      const winner = await new Promise((resolve) => {
        let left = batch.length; let done = false;
        const lose = () => { left -= 1; if (left === 0 && !done) { done = true; resolve(null); } };
        batch.forEach((e, i) => {
          const sig = o.signal ? AbortSignal.any([o.signal, ctl[i].signal]) : ctl[i].signal;
          const timer = setTimeout(() => { if (!done) { note(e, 'first_byte_timeout', started, 0); ctl[i].abort(); } }, firstByteMs);
          request(url, e.ip, { signal: sig, from: offset }).then((res) => {
            const code = res.statusCode;
            if (code === 404 || code === 410) { clearTimeout(timer); res.resume(); gone += 1; note(e, `http_${code}`, started, 0); lose(); return; }
            if (code !== 200 && code !== 206) { clearTimeout(timer); res.resume(); note(e, `http_${code}`, started, 0); lose(); return; }
            res.once('data', (first) => {
              // Hold the stream here: what comes next must wait until the writer is listening.
              res.pause();
              clearTimeout(timer);
              if (done) { res.destroy(); return; }
              done = true;
              batch.forEach((_, j) => { if (j !== i) ctl[j].abort(); });
              resolve({ e, res, first, ctl: ctl[i], restart: offset > 0 && code === 200 });
            });
            res.once('error', () => { clearTimeout(timer); if (!done) { note(e, 'connect_error', started, 0); lose(); } });
          }, () => { clearTimeout(timer); if (!done && !ctl[i].signal.aborted) note(e, 'connect_error', started, 0); lose(); });
        });
      });
      if (o.signal?.aborted) throw fail('timeout');
      if (!winner) { if (gone >= 2) throw fail('replay_gone'); continue; }
      // A resume answered with the whole file: start the file over.
      if (winner.restart) { await new Promise((r) => file.end(r)); file = createWriteStream(dest); bytes = 0; note(winner.e, 'range_ignored', started, 0); }
      const got0 = bytes;
      const outcome = await new Promise((resolve) => {
        let stall = null;
        const arm = () => { clearTimeout(stall); stall = setTimeout(() => { winner.ctl.abort(); resolve('stall'); }, stallMs); };
        const take = async (chunk) => {
          winner.res.pause(); arm();
          bytes += chunk.length;
          if (o.maxBytes && bytes > o.maxBytes) { clearTimeout(stall); winner.ctl.abort(); resolve('too_large'); return; }
          try { await write(chunk); } catch { clearTimeout(stall); resolve('write_error'); return; }
          winner.res.resume();
        };
        arm();
        winner.res.on('data', take);
        take(winner.first);
        winner.res.once('end', () => { clearTimeout(stall); resolve('ok'); });
        winner.res.once('error', () => { clearTimeout(stall); resolve(o.signal?.aborted ? 'aborted' : 'stall'); });
      });
      note(winner.e, outcome === 'aborted' ? 'stall' : outcome, started, bytes - got0);
      if (outcome === 'ok') return { bytes, edges: tried };
      if (outcome === 'too_large') throw fail('too_large');
      if (outcome === 'write_error') throw fail('download_failed', { why: 'write_error' });
      if (o.signal?.aborted) throw fail('timeout');
      // A stall: resume from what is written, on the next edges (the one that stalled is not asked again).
    }
    throw fail(gone >= 2 ? 'replay_gone' : 'download_failed', { why: 'every_edge_failed' });
  } finally {
    await new Promise((r) => file.end(r));
  }
}
