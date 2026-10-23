import express from 'express';
import { attachMcp } from '@dota2ai/mcp';
import { buildReview, ENGINE_VERSION, STATIC_HEROES, isMatchParsed, UNPARSED_MATCH_CACHE_TTL_MS, phraseInsight, refusal } from '../../packages/review-engine/src/index.js';
import { createCache, createLimiter, createIpKey, DAY, errorBody, classify, startSse } from './support.js';
import { openapi, llms } from './openapi.js';

const invalid = () => Object.assign(new Error('invalid input'), { code: 'INVALID_INPUT' });
/**
 * Server-side ui_v2 rollout switch: UI_V2 or FF_UI_V2 env ('1'/'true' → true,
 * '0'/'false' → false, anything else ignored; default false). This reports
 * SERVER config only — the frontend bundle is gated by its own build-time
 * VITE_FF_UI_V2, which ops must keep aligned by hand (docs/ROLLBACK.md);
 * the two are NOT guaranteed to be in sync at any given moment.
 */
function uiV2FromEnv(env = process.env) {
  const values = [env.UI_V2, env.FF_UI_V2];
  if (values.some(v => v === '1' || v === 'true')) return true;
  if (values.some(v => v === '0' || v === 'false')) return false;
  return false;
}
function input(req, ask = false) {
  const source = ask ? req.body : req.query;
  if (!source || typeof source !== 'object') throw invalid();
  const id = req.params.matchId;
  if (!/^[1-9]\d*$/.test(id) || Number(id) > 2 ** 40) throw invalid();
  const lang = source.lang ?? 'en';
  if (!['en', 'zh'].includes(lang)) throw invalid();
  let heroId;
  if (source.hero != null && source.hero !== '') {
    const hero = Object.values(STATIC_HEROES).find(h => String(h.id) === String(source.hero) || h.internalSlug === source.hero);
    if (!hero || !['string', 'number'].includes(typeof source.hero)) throw invalid();
    heroId = hero.id;
  }
  return { matchId: Number(id), heroId, lang, key: `review:${Number(id)}:${heroId ?? 'none'}:${ENGINE_VERSION}` };
}
function reviewEvents(review, cache, totalMs) {
  const events = [];
  const add = (event, data) => events.push({ event, data });
  for (const step of ['fetch_match', 'parse_check', 'facts', 'insights', 'phrasing']) add('progress', { step, status: step === 'phrasing' ? 'skipped' : 'done', ms: 0 });
  if (!review.player) add('hero_pick', { roster: review.roster, suggested: null });
  add('card', { kind: 'result_header', payload: { match: review.match, player: review.player, series_ref: 'series' } });
  review.insights.forEach((insight, i) => add('card', { kind: 'insight', index: i + 1, payload: insight, phrasing: 'template' }));
  add('card', { kind: 'followups', payload: review.followups });
  add('done', { review_id: `${review.match.id}:${review.player?.hero_id ?? 'none'}:${ENGINE_VERSION}`, state: review.player ? review.state : 'needs_hero', ...(!review.player ? { needs: 'hero' } : {}), cache, timings: { total_ms: totalMs, total_display: (totalMs / 1000).toFixed(1) }, review });
  return events;
}
/** The cache adapter only needs get(key) and set(key, value, ttlMs). */
export function createV1Router({ fetchMatch, phrasingCompletion, now = Date.now, logger = console, cache = createCache({ now }) }) {
  const router = express.Router();
  const ipKey = createIpKey(now);
  const reviewLimit = createLimiter({ capacity: 30, windowMs: 600000, now });
  const askLimit = createLimiter({ capacity: 20, windowMs: 3600000, now });
  const pending = new Map();
  const bounded = (max, fn) => {
    let active = 0;
    const queue = [];
    return async (...args) => {
      const signal = args[1]?.signal;
      signal?.throwIfAborted();
      if (active >= max) await new Promise((resolve, reject) => {
        const ready = () => { signal?.removeEventListener('abort', abort); resolve(); };
        const abort = () => { queue.splice(queue.indexOf(ready), 1); reject(signal.reason); };
        queue.push(ready);
        signal?.addEventListener('abort', abort, { once: true });
      });
      else active++;
      try { signal?.throwIfAborted(); return await fn(...args); } finally {
        if (queue.length) queue.shift()();
        else active--;
      }
    };
  };
  const fetchBounded = bounded(8, fetchMatch);
  const complete = phrasingCompletion ? bounded(20, phrasingCompletion) : undefined;
  const safeLog = (event, data) => { try { logger.warn?.(JSON.stringify({ event, ...data })); } catch {} };
  const limit = (req, res, limiter) => {
    const retry = limiter(ipKey(req));
    if (retry) { res.set('Retry-After', String(retry)); throw Object.assign(new Error('rate limited'), { code: 'RATE_LIMITED' }); }
  };
  async function load(params, req, res, onStart = () => {}) {
    let entry = await cache.get(params.key);
    const hit = !!entry;
    if (!entry) {
      let task = pending.get(params.key);
      if (task?.controller.signal.aborted) task = undefined;
      if (!task) {
        limit(req, res, reviewLimit);
        task = { controller: new AbortController(), waiters: 0, promise: null, settled: false };
        const current = task;
        task.promise = (async () => {
          const raw = await fetchBounded(params.matchId, { signal: current.controller.signal });
          current.controller.signal.throwIfAborted();
          if (!raw || raw.error || !raw.match_id) throw Object.assign(new Error('missing match'), { code: 'MATCH_NOT_FOUND' });
          const value = { raw, fetchedAt: new Date(now()).toISOString() };
          await cache.set(params.key, value, isMatchParsed(raw) ? 7 * DAY : UNPARSED_MATCH_CACHE_TTL_MS);
          return value;
        })().finally(() => {
          current.settled = true;
          if (pending.get(params.key) === current) pending.delete(params.key);
        });
        pending.set(params.key, task);
      }
      task.waiters++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        if (--task.waiters === 0 && !task.settled) task.controller.abort();
      };
      const onClose = () => { if (!res.writableFinished) release(); };
      res.once('close', onClose);
      if (res.destroyed) onClose();
      onStart();
      try { entry = await task.promise; } finally { res.removeListener('close', onClose); release(); }
    }
    const review = buildReview(entry.raw, { heroId: params.heroId, lang: params.lang, fetchedAt: entry.fetchedAt, presetFollowups: true });
    review.meta.cache = hit ? 'hit' : 'miss';
    return { review, hit };
  }
  const handle = (ask, streaming) => async (req, res) => {
    if (streaming && !ask) res.vary('Accept');
    const stream = streaming && (ask || !req.headers.accept?.includes('application/json'));
    let sse;
    const started = now();
    try {
      const params = input(req, ask);
      let followupId, question;
      if (ask) {
        followupId = req.body.followup_id === '' ? undefined : req.body.followup_id;
        if (followupId != null && (typeof followupId !== 'string' || followupId.length > 100)) throw invalid();
        if (req.body.question != null && typeof req.body.question !== 'string') throw invalid();
        question = req.body.question?.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
        if ((question?.length ?? 0) > 300 || (!followupId && !question) || !params.heroId) throw invalid();
        limit(req, res, askLimit);
      }
      const replayKey = `sse:${params.key}:${params.lang}`;
      if (stream && !ask && req.headers['last-event-id']) {
        if (!/^\d+$/.test(req.headers['last-event-id']) || !Number.isSafeInteger(Number(req.headers['last-event-id']))) throw invalid();
        const replay = await cache.get(replayKey);
        if (replay && Number(req.headers['last-event-id']) <= replay.length) {
          sse = startSse(res);
          replay.forEach(({ event, data }, i) => { if (i + 1 > Number(req.headers['last-event-id'])) sse.send(event, data, i + 1); });
          if (!res.writableEnded) { sse.close(); res.end(); }
          return;
        }
      }
      // Open SSE before upstream work so long fetches receive heartbeats.
      const begin = () => { if (stream && !sse) sse = startSse(res); };
      const { review, hit } = await load(params, req, res, begin);
      begin();
      if (ask) {
        const unsupported = /\b(vision|wards?|position|coordinates|build|items?|baseline|bracket)\b|视野|站位|坐标|位置|出装|同段位/i.test(question ?? '');
        const topic = unsupported ? null : /\b(deaths?|killed|killers?)\b|死亡|击杀者/i.test(question ?? '') ? 'death_list' : /\b(laning|lane|last hits?)\b|对线|补刀/i.test(question ?? '') ? 'laning_0_10' : null;
        const followup = review.followups.find(f => f.id === (followupId ?? topic));
        if (followupId && !followup) throw invalid();
        const answerKey = `ask:${params.key}:${params.lang}:${followupId}`;
        const cacheable = followupId && review.state === 'parsed' && followup?.answerable;
        let answer = cacheable ? await cache.get(answerKey) : undefined;
        if (!answer) {
          // Free questions are deliberately unanswerable unless matched to approved evidence.
          answer = followup ? await phraseInsight({ insight: followup, facts: review.facts, lang: params.lang, complete: process.env.LLM_PHRASING === 'false' ? undefined : complete, roster: review.roster, purchases: review.purchases, dataGaps: review.data_gaps, log: (event, data) => safeLog(event, data) }) : { text: refusal(params.lang), phrasing: 'template' };
          if (cacheable) await cache.set(answerKey, answer, 7 * DAY);
        }
        sse.send('token', { target: 'answer', delta: answer.text });
        sse.send('done', { state: review.state, answer: answer.text, phrasing: answer.phrasing });
      } else if (stream) {
        const events = reviewEvents(review, hit ? 'hit' : 'miss', Math.max(0, now() - started));
        await cache.set(replayKey, events, review.match.parsed ? 7 * DAY : UNPARSED_MATCH_CACHE_TTL_MS);
        events.forEach(({ event, data }, i) => sse.send(event, data, i + 1));
      } else {
        if (review.state === 'parsed') res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
        else res.set('Cache-Control', 'no-store');
        res.json(review);
      }
    } catch (error) {
      const code = classify(error);
      // Log only allowlisted metadata; upstream errors may contain credentials or IPs.
      safeLog('review_error', { code });
      const status = { INVALID_INPUT: 400, MATCH_NOT_FOUND: 404, RATE_LIMITED: 429, UPSTREAM_TIMEOUT: 504, INTERNAL: 500 }[code];
      if (stream) {
        if (!sse) res.status(status);
        sse ??= startSse(res);
        sse.send('error', errorBody(code));
      } else res.status(status).json(errorBody(code));
    }
  };
  attachMcp(router, { reviewForRequest: (req, res) => async args => {
    const params = input({ params: { matchId: String(args.match_id) }, query: { hero: args.hero, lang: args.lang } });
    return (await load(params, req, res)).review;
  } });
  router.use('/api/v1', (req, res, next) => { if (req.method === 'GET') res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Retry-After' }); next(); });
  router.get('/api/v1/config', (req, res) => res.json({ flags: { ui_v2: uiV2FromEnv(), llm_phrasing: process.env.LLM_PHRASING !== 'false' }, versions: { api: '1', engine: ENGINE_VERSION } }));
  router.get('/api/v1/review/:matchId', handle(false, false));
  router.get('/api/v1/review/:matchId/stream', handle(false, true));
  router.post('/api/v1/review/:matchId/ask', handle(true, true));
  router.get('/openapi.json', (req, res) => res.json(openapi));
  router.get('/schema/review.v1.json', (req, res) => res.sendFile(new URL('../../packages/review-engine/src/schema/review.v1.json', import.meta.url).pathname));
  router.get('/llms.txt', (req, res) => res.type('text/plain').send(llms));
  return router;
}
