/**
 * The agent as a service: where traces come from, deep-review jobs, and the
 * cache of finished reviews. All IO is injected, so it runs offline in tests.
 *
 * - A trace store answers `get(matchId)` with a `dota2.ai/match-trace@1` or
 *   null. createFileTraceStore reads `<dir>/<matchId>.trace.json.gz` (what
 *   scripts/build-trace.mjs writes); the replay worker's store plugs in the
 *   same way later.
 * - A deep review is a background job: `start` returns at once, `status`
 *   reports running (with the tool steps so far) / ready / failed. One job
 *   per (match, hero, language); a finished review is kept in memory and,
 *   when a review directory is configured, on disk across restarts.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DEEP_REVIEW_PROMPT_VERSION, runDeepReview } from './deepReview.js';
import { runChat } from './chat.js';
import { resolveRef } from './evidence.js';
import { STATIC_HEROES } from '../../packages/review-engine/src/staticHeroes.js';

const HERO_BY_SLUG = new Map(Object.values(STATIC_HEROES).map((h) => [h.internalSlug, h]));

const MATCH_ID = /^[1-9]\d{0,14}$/;
const MAX_KEPT_JOBS = 200;

/** Traces from a directory, the few most recent kept parsed in memory. */
export function createFileTraceStore(dir, { keep = 4, read = readFile } = {}) {
  const cache = new Map();
  return {
    async get(matchId) {
      const id = String(matchId);
      if (!dir || !MATCH_ID.test(id)) return null;
      if (cache.has(id)) { const t = cache.get(id); cache.delete(id); cache.set(id, t); return t; }
      let trace;
      try {
        const body = await read(join(dir, `${id}.trace.json.gz`));
        trace = JSON.parse(gunzipSync(body).toString('utf8'));
      } catch { return null; }
      if (trace?.schema !== 'dota2.ai/match-trace@1' || String(trace.match_id) !== id) return null;
      cache.set(id, trace);
      while (cache.size > keep) cache.delete(cache.keys().next().value);
      return trace;
    },
  };
}

/**
 * @param {{
 *   traces: { get: (matchId: number | string) => Promise<any> },
 *   complete: Function | null,
 *   model?: string,
 *   getMatchDetail?: (id: number) => Promise<any>,
 *   reviewDir?: string | null,
 *   log?: (msg: string) => void,
 *   fs?: { readFile: Function, writeFile: Function, mkdir: Function },
 * }} deps
 */
export function createAgentService(deps) {
  const { traces, complete } = deps;
  const log = deps.log ?? (() => {});
  const fs = deps.fs ?? { readFile, writeFile, mkdir };
  /** @type {Map<string, any>} */
  const jobs = new Map();
  const keyOf = (matchId, hero, lang) => `${matchId}.${hero}.${lang}.p${DEEP_REVIEW_PROMPT_VERSION}`;
  const fileOf = (key) => (deps.reviewDir ? join(deps.reviewDir, `${key}.review.json`) : null);

  /** The scoreboard-level match, best effort: the review works without it. */
  async function matchOf(matchId) {
    if (!deps.getMatchDetail) return null;
    try { return await deps.getMatchDetail(Number(matchId)); } catch { return null; }
  }

  async function seatOf(matchId, hero) {
    const trace = await traces.get(matchId);
    if (!trace) return { trace: null, key: null };
    const k = String(hero ?? '').trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s-]+/g, '_');
    return { trace, key: trace.heroes.some((h) => h.key === k) ? k : null };
  }

  async function stored(key) {
    const file = fileOf(key);
    if (!file) return null;
    try { const r = JSON.parse(await fs.readFile(file, 'utf8')); return r?.review?.schema ? r : null; } catch { return null; }
  }

  /** What exists for this match: the heroes a review can be made for, or no trace. */
  async function availability(matchId) {
    const trace = await traces.get(matchId);
    return trace ? { trace: true, model_configured: Boolean(complete), heroes: trace.heroes.map((h) => ({ hero: h.key, team: h.team === 2 ? 'radiant' : 'dire', hero_id: HERO_BY_SLUG.get(h.key)?.id ?? null, en: HERO_BY_SLUG.get(h.key)?.nameEn ?? h.key, zh: HERO_BY_SLUG.get(h.key)?.nameZh ?? h.key })) } : { trace: false, model_configured: Boolean(complete), heroes: [] };
  }

  async function status(matchId, hero, lang) {
    const { trace, key } = await seatOf(matchId, hero);
    if (!trace) return { status: 'no_trace' };
    if (!key) return { status: 'unknown_hero', heroes: trace.heroes.map((h) => h.key) };
    const id = keyOf(matchId, key, lang);
    const job = jobs.get(id);
    if (job?.state === 'running') return { status: 'running', steps: job.steps };
    if (job?.state === 'ready') return { ...job.result, status: 'ready' };
    const disk = await stored(id);
    if (disk) { jobs.set(id, { state: 'ready', result: disk }); return { ...disk, status: 'ready' }; }
    if (job?.state === 'failed') return { status: 'failed', reason: job.reason };
    return { status: 'none' };
  }

  /**
   * Start (or join) the review job. Never throws; never waits for the model.
   * Two requests arriving together share one start: the claim is taken
   * before the first await, so both cannot see "none" and both begin.
   */
  const starting = new Map();
  function start(matchId, hero, lang) {
    const claim = `${matchId}|${String(hero ?? '').trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s-]+/g, '_')}|${lang}`;
    const pending = starting.get(claim);
    if (pending) return pending;
    const p = begin(matchId, hero, lang).finally(() => starting.delete(claim));
    starting.set(claim, p);
    return p;
  }
  async function begin(matchId, hero, lang) {
    const now = await status(matchId, hero, lang);
    if (now.status !== 'none' && now.status !== 'failed') return now;
    if (!complete) return { status: 'unavailable', reason: 'model_not_configured' };
    const { trace, key } = await seatOf(matchId, hero);
    const id = keyOf(matchId, key, lang);
    const job = { state: 'running', steps: [] };
    jobs.set(id, job);
    while (jobs.size > MAX_KEPT_JOBS) { const oldest = [...jobs].find(([, j]) => j.state !== 'running'); if (!oldest) break; jobs.delete(oldest[0]); }
    (async () => {
      try {
        const out = await runDeepReview({ complete, trace, hero: key, lang, match: await matchOf(matchId), onEvent: (e) => { if (e.type === 'tool_start') job.steps.push({ tool: e.name, args: e.args }); } });
        if (out.status !== 'ok') { job.state = 'failed'; job.reason = out.status; log(`deep-review failed match=${matchId} hero=${key} reason=${out.status}`); return; }
        const result = { review: out.review, verification: { repaired: out.verification.repaired, dropped: out.verification.dropped }, model: deps.model ?? null, tool_calls: out.tool_calls.length };
        // Saved before it is announced, so "ready" always means it survives a restart (when a directory is set).
        const file = fileOf(id);
        if (file) { try { await fs.mkdir(deps.reviewDir, { recursive: true }); await fs.writeFile(file, JSON.stringify(result)); } catch { log(`deep-review not saved match=${matchId}`); } }
        job.result = result; job.state = 'ready';
        log(`deep-review ready match=${matchId} hero=${key} steps=${out.steps} in=${out.usage.input} out=${out.usage.output} dropped=${out.verification.dropped}`);
      } catch (error) {
        job.state = 'failed'; job.reason = 'error';
        log(`deep-review error match=${matchId} hero=${key}: ${error?.name ?? 'error'}`);
      }
    })();
    return { status: 'running', steps: job.steps };
  }

  /** One chat turn. `onEvent` gets the tool steps as they happen. */
  async function chat({ matchId, hero, lang, question, history, signal, onEvent }) {
    const { trace, key } = await seatOf(matchId, hero);
    if (!trace) return { status: 'no_trace' };
    if (!key) return { status: 'unknown_hero' };
    if (!complete) return { status: 'unavailable' };
    const ready = jobs.get(keyOf(matchId, key, lang));
    const review = ready?.state === 'ready' ? ready.result.review : (await stored(keyOf(matchId, key, lang)))?.review ?? null;
    return runChat({ complete, trace, hero: key, lang, match: await matchOf(matchId), review, question, history, signal, onEvent });
  }

  /** The tool record behind a ref, recomputed from the trace, with display names. */
  async function evidence(matchId, hero, lang, ref) {
    const { trace, key } = await seatOf(matchId, hero);
    if (!trace) return { status: 'no_trace' };
    if (!key) return { status: 'unknown_hero' };
    const out = resolveRef(trace, ref, { hero: key, lang, match: await matchOf(matchId) });
    return out ? { status: 'ok', ...out } : { status: 'unknown_ref' };
  }

  return { availability, status, start, chat, evidence };
}
