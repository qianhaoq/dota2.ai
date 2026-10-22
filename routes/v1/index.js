import express from 'express';
import { buildReview, ENGINE_VERSION, STATIC_HEROES, isMatchParsed, UNPARSED_MATCH_CACHE_TTL_MS, phraseInsight, refusal } from '../../packages/review-engine/src/index.js';
import { createCache, createLimiter, createIpKey, DAY, errorBody, classify, startSse } from './support.js';
import { openapi, llms } from './openapi.js';

const invalid = () => Object.assign(new Error('invalid input'), { code: 'INVALID_INPUT' });
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
function reviewEvents(review, cache) {
  const events = [];
  const add = (event, data) => events.push({ event, data });
  for (const step of ['fetch_match', 'parse_check', 'facts', 'insights', 'phrasing']) add('progress', { step, status: step === 'phrasing' ? 'skipped' : 'done', ms: 0 });
  if (!review.player) add('hero_pick', { roster: review.roster, suggested: null });
  add('card', { kind: 'result_header', payload: { match: review.match, player: review.player, series_ref: 'series' } });
  review.insights.forEach((insight, i) => add('card', { kind: 'insight', index: i + 1, payload: insight, phrasing: 'template' }));
  add('card', { kind: 'followups', payload: review.followups });
  add('done', { review_id: `${review.match.id}:${review.player?.hero_id ?? 'none'}:${ENGINE_VERSION}`, state: review.player ? review.state : 'needs_hero', ...(!review.player ? { needs: 'hero' } : {}), cache, timings: {}, review });
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
      if (active >= max) await new Promise(resolve => queue.push(resolve));
      else active++;
      try { return await fn(...args); } finally {
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
      if (!pending.has(params.key)) {
        limit(req, res, reviewLimit);
        const promise = (async () => {
          onStart();
          const raw = await fetchBounded(params.matchId);
          if (!raw || raw.error || !raw.match_id) throw Object.assign(new Error('missing match'), { code: 'MATCH_NOT_FOUND' });
          const value = { raw, fetchedAt: new Date(now()).toISOString() };
          await cache.set(params.key, value, isMatchParsed(raw) ? 7 * DAY : UNPARSED_MATCH_CACHE_TTL_MS);
          return value;
        })();
        pending.set(params.key, promise);
      }
      const promise = pending.get(params.key);
      onStart();
      try { entry = await promise; } finally { if (pending.get(params.key) === promise) pending.delete(params.key); }
    }
    return { review: buildReview(entry.raw, { heroId: params.heroId, lang: params.lang, fetchedAt: entry.fetchedAt, presetFollowups: true }), hit };
  }
  const handle = (ask, streaming) => async (req, res) => {
    const stream = streaming && (ask || !req.headers.accept?.includes('application/json'));
    let sse;
    try {
      const params = input(req, ask);
      let followupId, question;
      if (ask) {
        followupId = req.body.followup_id;
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
        let answer = followupId ? await cache.get(answerKey) : undefined;
        if (!answer) {
          // Free questions are deliberately unanswerable unless matched to approved evidence.
          answer = followup ? await phraseInsight({ insight: followup, facts: review.facts, lang: params.lang, complete: process.env.LLM_PHRASING === 'false' ? undefined : complete, roster: review.roster, purchases: review.purchases, dataGaps: review.data_gaps, log: (event, data) => safeLog(event, data) }) : { text: refusal(params.lang), phrasing: 'template' };
          if (followupId) await cache.set(answerKey, answer, 7 * DAY);
        }
        sse.send('token', { target: 'answer', delta: answer.text });
        sse.send('done', { state: review.state, answer: answer.text, phrasing: answer.phrasing });
      } else if (stream) {
        const events = reviewEvents(review, hit ? 'hit' : 'miss');
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
  router.use('/api/v1', (req, res, next) => { if (req.method === 'GET') res.set('Access-Control-Allow-Origin', '*'); next(); });
  router.get('/api/v1/config', (req, res) => res.json({ flags: { ui_v2: false, llm_phrasing: process.env.LLM_PHRASING !== 'false' }, versions: { api: '1', engine: ENGINE_VERSION } }));
  router.get('/api/v1/review/:matchId', handle(false, false));
  router.get('/api/v1/review/:matchId/stream', handle(false, true));
  router.post('/api/v1/review/:matchId/ask', handle(true, true));
  router.get('/openapi.json', (req, res) => res.json(openapi));
  router.get('/schema/review.v1.json', (req, res) => res.sendFile(new URL('../../packages/review-engine/src/schema/review.v1.json', import.meta.url).pathname));
  router.get('/llms.txt', (req, res) => res.type('text/plain').send(llms));
  return router;
}
