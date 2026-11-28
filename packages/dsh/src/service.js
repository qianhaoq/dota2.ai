import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAgentService } from '../../../lib/agent/service.js';
import { createFileStore, createJsonStore, createTraceStore } from '../../../lib/agent/stores.js';
import { parseChatBody } from '../../../lib/agent/chat.js';
import { parseFeedback } from '../../../lib/agent/feedback.js';
import { planKey } from '../../../lib/agent/plans.js';
import { replayReview, resolveHero } from '../../../lib/agent/replayTool.js';
import { normalizeUiLang } from '../../../lib/aiLanguage.js';
import { buildCoachReport } from '../../../lib/coach/analyze.js';
import { askMessages, fallbackAnswer, FALLBACK_NOTICE, parseAskBody } from '../../../lib/coach/ask.js';
import { buildSurface } from '../../../lib/coach/cards.js';
import { evaluateGoal, habitRef } from '../../../lib/coach/goals.js';
import { matchupBrief, matchupLines } from '../../../lib/coach/matchupBrief.js';
import { aboutOf, runAdvisor, parseAdvisorBody } from '../../../lib/patch/advisor.js';
import { runPatchTool } from '../../../lib/patch/tools.js';
import { createCoachHandlers } from 'dota2ai/handlers';
import { findSeat } from 'dota2ai/coach';
import { normalizeMatchId } from '../../../packages/review-engine/src/parseMatchId.js';
import { createDshModelRegistry } from './llm.js';
import { createDshTracePipeline } from './traceSource.js';

const MATCH_ID = /^[1-9]\d{0,12}$/;
const heroOf = (v) => (typeof v === 'string' && /^[A-Za-z][A-Za-z0-9 _-]{0,39}$/.test(v.trim()) ? v.trim() : null);
/** Strip nested `undefined` so every return/stream value satisfies Typert's lossless JSON check. */
const cleanJson = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

export function resolveDataHome(config = {}, env = process.env) {
  if (config.homeDir && String(config.homeDir).trim()) return String(config.homeDir).trim();
  const base = env.DSH_HOME && String(env.DSH_HOME).trim() ? String(env.DSH_HOME).trim() : join(homedir(), '.dsh');
  return join(base, 'dota2ai');
}

const PATCH_IDS = { '7.39': 58, '7.40': 59, '7.41': 60, '7.42': 61 };

/** Synthesize minimal OpenDota-shaped match metadata from a `CoachReport` when OpenDota itself is unreachable. */
export function synthesizeMatchFromCoachReport(report) {
  if (!report?.match || !Array.isArray(report.players)) return null;
  const goldAdv = Array.isArray(report.timeline?.radiant_gold_adv)
    ? report.timeline.radiant_gold_adv
    : Array.isArray(report.match.gold_adv)
      ? report.match.gold_adv
      : null;
  let radiantIdx = 0;
  let direIdx = 0;
  return {
    match_id: report.match.id,
    start_time: report.match.start_time ?? null,
    duration: report.match.duration ?? null,
    radiant_win: report.match.radiant_win,
    radiant_score: report.match.score?.[0] ?? 0,
    dire_score: report.match.score?.[1] ?? 0,
    ...(PATCH_IDS[report.match.patch] ? { patch: PATCH_IDS[report.match.patch] } : {}),
    ...(report.match.turbo ? { game_mode: 23 } : {}),
    ...(report.match.ranked ? { lobby_type: 7 } : {}),
    ...(goldAdv ? { radiant_gold_adv: goldAdv } : {}),
    players: report.players.map((p) => {
      const isRadiant = Boolean(p.radiant);
      return {
        player_slot: isRadiant ? (radiantIdx += 1) - 1 : 128 + (direIdx += 1) - 1,
        isRadiant,
        account_id: p.account_id ?? null,
        rank_tier: p.rank_tier ?? null,
        hero_id: p.hero?.id ?? 0,
        kills: p.kda?.[0] ?? 0,
        deaths: p.kda?.[1] ?? 0,
        assists: p.kda?.[2] ?? 0,
        net_worth: p.net_worth ?? 0,
        gold_per_min: p.gpm ?? 0,
        xp_per_min: p.xpm ?? 0,
        last_hits: p.last_hits ?? 0,
        denies: p.denies ?? 0,
        hero_damage: p.hero_damage ?? 0,
        tower_damage: p.tower_damage ?? 0,
        ...(p.level != null ? { level: p.level } : {}),
        ...(p.obs_placed != null ? { obs_placed: p.obs_placed } : {}),
        ...(p.benchmarks ? { benchmarks: p.benchmarks } : {}),
      };
    }),
  };
}

/**
 * Create the unified local domain service for the DSH plugin, shared by:
 *   1. `Dota2AiRemote` (the standalone DSH page UI: home, player, match review, chat, patch advisor);
 *   2. `dota2ai_*` conversation tools (so chat tools use the same DSH host model and `$DSH_HOME/dota2ai` cache).
 */
export function createDshService({
  ctx,
  config = {},
  env = process.env,
  fetchImpl = globalThis.fetch,
  llmPrimitives,
  openDotaBase = 'https://api.opendota.com/api',
  openDotaTimeoutMs = 4_000,
  openDotaCooldownMs = 5 * 60_000,
  apiTimeoutMs = 20_000,
  prepareGraceMs = 1_500,
  reviewDocs: customReviewDocs = null,
  now = () => Date.now(),
  log = () => {},
}) {
  const apiBase = String(config.apiBase || 'https://dota2.ai').replace(/\/+$/, '');
  const home = resolveDataHome(config, env);

  const traceBlobs = createFileStore(join(home, 'traces'));
  const traces = createTraceStore(traceBlobs);
  const reviewDocs = customReviewDocs ?? createJsonStore(createFileStore(join(home, 'reviews')));
  const feedbackDocs = createJsonStore(createFileStore(join(home, 'feedback')));
  const matchDocs = createJsonStore(createFileStore(join(home, 'matches')));
  const rootDocs = createJsonStore(createFileStore(home));

  const models = createDshModelRegistry({ ctx, primitives: llmPrimitives });

  // Short-TTL in-memory match cache + in-flight dedup + OpenDota outage cooldown so CN/blocked networks
  // never stall repeatedly for 15s on api.opendota.com when dota2.ai (/api/coach/:id) is reachable.
  const MATCH_MEMO_TTL_MS = 5 * 60_000;
  const MATCH_MEMO_MAX = 128;
  const matchMemo = new Map();
  const matchInFlight = new Map();
  let openDotaBackoffUntil = 0;

  const memoPut = (id, data) => {
    matchMemo.set(id, { data, expiresAt: now() + MATCH_MEMO_TTL_MS });
    while (matchMemo.size > MATCH_MEMO_MAX) matchMemo.delete(matchMemo.keys().next().value);
  };

  /** Fetch and cache raw match detail (fast-bounded OpenDota first, falling back cleanly to apiBase coach report). */
  async function getMatchDetail(matchId) {
    const id = normalizeMatchId(matchId);
    if (!id) throw Object.assign(new Error('Invalid match ID'), { code: 'INVALID_INPUT', status: 400 });
    const cached = await matchDocs.get(`${id}.raw.json`);
    if (cached && Number(cached.match_id) === Number(id)) return cached;

    const memoHit = matchMemo.get(id);
    if (memoHit && memoHit.expiresAt > now()) return memoHit.data;
    if (memoHit) matchMemo.delete(id);

    const existingFlight = matchInFlight.get(id);
    if (existingFlight) return existingFlight;

    const task = (async () => {
      if (now() >= openDotaBackoffUntil) {
        try {
          const res = await fetchImpl(`${openDotaBase}/matches/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(openDotaTimeoutMs) });
          if (res.ok) {
            const raw = await res.json();
            if (raw && Number(raw.match_id) === Number(id) && Array.isArray(raw.players) && raw.players.length > 0) {
              // Cache on disk once OpenDota has per-minute gold (`gold_t`), and memoize unparsed games in memory.
              if (Array.isArray(raw.players[0]?.gold_t)) await matchDocs.put(`${id}.raw.json`, raw);
              memoPut(id, raw);
              return raw;
            }
          } else if (res.status === 429 || res.status >= 500) {
            openDotaBackoffUntil = now() + openDotaCooldownMs;
          }
        } catch {
          // OpenDota timed out or is unreachable (common on CN networks): cool down and fall through to apiBase.
          openDotaBackoffUntil = now() + openDotaCooldownMs;
        }
      }

      const report = await fetchCoachReportRemote(id);
      const synth = synthesizeMatchFromCoachReport(report);
      if (synth) memoPut(id, synth);
      return synth;
    })().finally(() => {
      if (matchInFlight.get(id) === task) matchInFlight.delete(id);
    });

    matchInFlight.set(id, task);
    return task;
  }

  async function fetchCoachReportRemote(matchId, query = '', signal) {
    const id = normalizeMatchId(matchId);
    if (!id) throw Object.assign(new Error('Invalid match ID'), { code: 'INVALID_INPUT', status: 400 });
    const cacheKey = `${id}${query ? `.${query.replace(/[^A-Za-z0-9_-]/g, '_')}` : ''}.coach.json`;
    if (!query) {
      const hit = await matchDocs.get(cacheKey);
      if (hit?.schema && hit.match?.parsed) return hit;
    }
    const timeoutSig = AbortSignal.timeout(apiTimeoutMs);
    const bounded = signal ? AbortSignal.any([signal, timeoutSig]) : timeoutSig;
    const res = await fetchImpl(`${apiBase}/api/coach/${encodeURIComponent(id)}${query ? `?${query}` : ''}`, { signal: bounded });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), {
        code: body.code ?? (res.status === 404 ? 'NOT_FOUND' : res.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM'),
        status: res.status,
        retryAfterSec: body.retryAfterSec,
      });
    }
    if (!query && body?.match?.parsed) await matchDocs.put(cacheKey, body);
    return body;
  }

  const rawPipeline = createDshTracePipeline({
    apiBase,
    fetchImpl,
    traceStore: traces,
    getMatchDetail,
    extractorBin: config.extractorBin || env.DOTA_EXTRACT_BIN || '',
    log,
  });
  const inFlightParse = new Map();
  const pipeline = {
    run(matchId, opts) {
      const id = String(matchId);
      const p = rawPipeline.run(id, opts);
      inFlightParse.set(id, p);
      p.finally(() => { if (inFlightParse.get(id) === p) inFlightParse.delete(id); });
      return p;
    },
  };

  const agent = createAgentService({
    traces,
    docs: reviewDocs,
    feedback: feedbackDocs,
    pipeline,
    reparseOldTraces: true,
    getMatchDetail,
    resolveModels: () => models.catalog(),
    now,
    log,
  });

  // Profile persistence across random `dsh web` ports and DSH chat tools.
  const EMPTY_PROFILE = { accountId: null, reviewed: [], seenUntil: null, goal: null, goalChecks: [] };
  async function getProfile() {
    const stored = await rootDocs.get('profile.json');
    return stored && typeof stored === 'object' ? { ...EMPTY_PROFILE, ...stored } : { ...EMPTY_PROFILE };
  }
  async function saveProfile(patch = {}) {
    const cur = await getProfile();
    const next = {
      accountId: patch.accountId !== undefined ? patch.accountId : cur.accountId,
      reviewed: Array.isArray(patch.reviewed) ? patch.reviewed.slice(-200) : cur.reviewed,
      seenUntil: patch.seenUntil !== undefined ? patch.seenUntil : cur.seenUntil,
      goal: patch.goal !== undefined ? patch.goal : cur.goal,
      goalChecks: Array.isArray(patch.goalChecks) ? patch.goalChecks.slice(-60) : cur.goalChecks,
    };
    await rootDocs.put('profile.json', next);
    return next;
  }

  /** Answer a follow-up question on a CoachReport using DSH's host model (with deterministic fallback). */
  async function askReportWithHostModel({ report, slot, lang, question, history = [], signal }) {
    const complete = models.defaultComplete();
    if (!complete) {
      return { text: fallbackAnswer({ report, slot, lang, question }), fallback: true, notice: FALLBACK_NOTICE[lang] };
    }
    try {
      const msgs = askMessages({ report, slot, lang, question, history });
      const system = msgs.find((m) => m.role === 'system')?.content ?? '';
      const rest = msgs.filter((m) => m.role !== 'system');
      const reply = await complete({ system, messages: rest, tools: [], signal });
      const text = String(reply?.text ?? '').trim();
      if (!text) return { text: fallbackAnswer({ report, slot, lang, question }), fallback: true, notice: FALLBACK_NOTICE[lang] };
      return { text, fallback: false, ...(reply?.usage ? { usage: reply.usage } : {}) };
    } catch {
      return { text: fallbackAnswer({ report, slot, lang, question }), fallback: true, notice: FALLBACK_NOTICE[lang] };
    }
  }

  /** Best-effort replay trace availability check for `dota2ai_coach_cases` unparsed-match guidance (local first, then remote apiBase). */
  async function replayAvailabilityForCases(matchId) {
    const id = normalizeMatchId(matchId);
    if (!id) return null;
    const local = await agent.availability(id);
    if (local.trace) return { trace: true, can_parse: true };
    if (config.extractorBin || env.DOTA_EXTRACT_BIN) {
      return { trace: false, can_parse: Boolean(local.can_parse) };
    }
    try {
      const res = await fetchImpl(`${apiBase}/api/agent/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(3_000) });
      if (!res.ok) return { trace: null, can_parse: local.can_parse ? true : null };
      const remote = await res.json().catch(() => null);
      if (!remote || typeof remote !== 'object') return { trace: null, can_parse: local.can_parse ? true : null };
      return {
        trace: typeof remote.trace === 'boolean' ? remote.trace : null,
        can_parse: typeof remote.can_parse === 'boolean' ? (remote.can_parse || Boolean(remote.trace)) : (local.can_parse ? true : null),
      };
    } catch {
      return { trace: null, can_parse: local.can_parse ? true : null };
    }
  }

  // Base coach handlers (recent_matches, coach_report, coach_cases, hero_matchup) with local Host LLM overrides!
  const baseCoach = createCoachHandlers({
    env: { ...env, DOTA2AI_API_BASE: apiBase },
    fetchImpl,
    surface: 'native_dsh',
    toolPrefix: 'dota2ai_',
    replayAvailability: replayAvailabilityForCases,
  });
  const coach = {
    ...baseCoach,
    hero_matchup: async (args) => {
      const brief = matchupBrief(String(args?.hero ?? ''), String(args?.vs ?? ''), { rank: args?.rank ? String(args.rank) : null });
      if (brief.error) throw Object.assign(new Error(brief.error), { code: 'INVALID_INPUT' });
      return { ...brief, lines: { en: matchupLines(brief, 'en'), zh: matchupLines(brief, 'zh') } };
    },
    coach_ask: async (args, signal) => {
      const lang = normalizeUiLang(args?.lang);
      const question = String(args?.question ?? '').trim();
      if (!question || question.length > 500) throw Object.assign(new Error('Invalid question'), { code: 'INVALID_INPUT' });
      const matchId = normalizeMatchId(args?.match_id);
      if (!matchId) throw Object.assign(new Error(`Not a match id: ${String(args?.match_id ?? '').trim() || '(empty)'}`), { code: 'INVALID_INPUT' });
      // Prefer deep replay-backed chat (`runChat` + 20+ trace tools + `verifyText`) when this match's trace is cached!
      const avail = await agent.availability(matchId);
      const resolvedHero = avail.trace ? resolveHero(avail.heroes, args?.hero) : null;
      if (avail.trace && resolvedHero && models.isConfigured()) {
        const out = await agent.chat({ matchId, hero: resolvedHero.hero, lang, question, history: [], signal });
        if (out.status === 'ok') {
          return {
            match_id: Number(matchId),
            hero: resolvedHero.hero,
            lang,
            answer: out.text,
            source: 'replay',
            surface: 'native_dsh',
            unverified: out.unverified,
            ...(out.usage ? { usage: out.usage } : {}),
            ...('usage_source' in out ? { usage_source: out.usage_source } : {}),
          };
        }
      }
      const report = await fetchCoachReportRemote(matchId, '', signal);
      const seat = findSeat(report, args?.hero);
      const res = await askReportWithHostModel({ report, slot: seat, lang, question, signal });
      return { match_id: report.match.id, seat, lang, surface: 'native_dsh', answer: res.text, ...(res.usage ? { usage: res.usage } : {}), ...(res.fallback ? { fallback: true } : {}) };
    },
    goal_check: async (args) => {
      const matchId = normalizeMatchId(args?.match_id);
      if (!matchId) throw Object.assign(new Error(`Not a match id: ${String(args?.match_id ?? '').trim() || '(empty)'}`), { code: 'INVALID_INPUT' });
      let goal = args?.goal;
      if (!goal || (typeof goal === 'object' && Object.keys(goal).length === 0)) {
        const profile = await getProfile();
        goal = profile.goal?.goal ?? null;
      }
      if (!goal || typeof goal !== 'object') {
        throw Object.assign(new Error('No goal provided and no active goal saved in DSH'), { code: 'INVALID_INPUT' });
      }
      const report = await fetchCoachReportRemote(matchId);
      const seat = findSeat(report, args?.hero);
      let replaySummary = null;
      if (goal.kind === 'replay_habit') {
        const avail = await agent.availability(matchId);
        if (avail.trace) {
          const heroCandidate = report.players?.[seat]?.hero?.id ?? report.players?.[seat]?.hero?.slug ?? args?.hero;
          const resolvedHero = resolveHero(avail.heroes, heroCandidate);
          const ref = resolvedHero ? habitRef(goal, resolvedHero.hero) : null;
          if (ref) {
            const ev = await agent.evidence(matchId, resolvedHero.hero, 'en', ref);
            if (ev.status === 'ok') replaySummary = ev.record;
          }
        }
      }
      return { match_id: report.match.id, seat, ...evaluateGoal(goal, report, seat, replaySummary) };
    },
  };

  /**
   * A finished review here was written by the user's own model and is kept on this machine: the public
   * dota2.ai page does not have it (and asking for it there would spend the site's model). Say where it is read
   * instead — the dota2.ai panel's route for it — and never hand out the public link.
   */
  const localReview = (out) => {
    if (out?.status !== 'ready') return out;
    const { url: _public, ...rest } = out;
    const staleHint = out.stale_version && out.refresh_failed && typeof out.refresh_failed === 'object'
      ? ` Updating this cached${Number.isInteger(out.prompt_version) ? ` v${out.prompt_version}` : ''} review${Number.isInteger(out.latest_prompt_version) ? ` to v${out.latest_prompt_version}` : ''} failed${out.refresh_failed.reason ? ` (${out.refresh_failed.reason})` : ''}; returning the saved review instead. Call dota2ai_replay_review with refresh: true and retry: true only if the user explicitly wants to retry regenerating it (this counts as a new start).`
      : out.stale_version && Number.isInteger(out.prompt_version)
        ? ` This cached review was written under coach v${out.prompt_version}${Number.isInteger(out.latest_prompt_version) ? ` (latest is v${out.latest_prompt_version})` : ''}; call dota2ai_replay_review with refresh: true only if the user explicitly wants to regenerate it.`
        : '';
    return {
      ...rest,
      surface: 'native_dsh',
      cache_scope: 'dsh_local',
      panel_route: `/r/${out.match_id}?hero=${encodeURIComponent(out.hero)}&lang=${out.lang}`,
      note: `Times and numbers were checked against the replay. Quote them as given and say what the review cannot see (blind_spots). It was written on the user's own DSH model and is kept on this machine (local private DSH cache, separate from the public dota2.ai web cache; replay traces can be reused, while local reviews are never auto-published): point them to the dota2.ai panel in the DSH sidebar (the tool card's button opens it at panel_route), which has every piece of evidence and a coach to ask. The public dota2.ai link would not show this review.${staleHint}`,
    };
  };

  // Local `replay_review` tool handler backed by our local `AgentService` + DSH host model!
  const replay = {
    async review(args) {
      await models.refresh();
      return localReview(await replayReview({
        surface: 'native_dsh',
        toolName: 'dota2ai_replay_review',
        coachToolName: 'dota2ai_coach_report',
        read: () => ({ ok: true }),
        validMatch: (id) => MATCH_ID.test(String(id)),
        availability: (id) => agent.availability(String(id)),
        status: (id, hero, lang) => agent.status(String(id), hero, normalizeUiLang(lang), null, null),
        lastFailure: (id, hero, lang) => agent.lastFailure(String(id), hero, normalizeUiLang(lang), null, null),
        prepare: async (id) => {
          const matchId = String(id);
          const out = await agent.prepare(matchId);
          // Brief grace window when a remote trace is already ready on dota2.ai (~300ms download)
          // or fails immediately (e.g. replay_gone / rate_limited / no_replay_url), avoiding a bogus 20s poll wait.
          if (out.status === 'running' && prepareGraceMs > 0) {
            const deadline = Date.now() + prepareGraceMs;
            const pending = inFlightParse.get(matchId);
            if (pending) {
              let timer;
              await Promise.race([
                pending.then(() => true, () => true),
                new Promise((r) => { timer = setTimeout(() => r(false), Math.max(0, deadline - Date.now())); timer.unref?.(); }),
              ]);
              clearTimeout(timer);
            }
            // Wait (bounded by `deadline`) for `executeParse` to finish updating state and flushing
            // `<id>.parse.json` after `pipeline.run()` resolves (disk writes can lag on busy runners).
            let after = await agent.availability(matchId);
            while (!after.trace && after.parse?.status === 'running' && Date.now() < deadline) {
              await new Promise((r) => {
                const t = setTimeout(r, Math.min(10, Math.max(1, deadline - Date.now())));
                t.unref?.();
              });
              after = await agent.availability(matchId);
            }
            if (after.trace) return { status: 200, body: { status: 'ready' } };
            if (after.parse?.status === 'failed') return { status: 200, body: after.parse };
            if (after.parse?.status === 'running') return { status: 202, body: after.parse };
          }
          return { status: out.status === 'running' ? 202 : out.status === 'unavailable' ? 503 : 200, body: out };
        },
        start: async (id, hero, lang, opts) => {
          const out = await agent.start(String(id), hero, normalizeUiLang(lang), opts?.refresh ? { refresh: true } : undefined);
          return { status: out.status === 'running' ? 202 : out.status === 'unavailable' ? 503 : 200, body: out };
        },
      }, args));
    },
  };

  /**
   * Handle a non-streaming `/api/*` request from the DSH standalone UI (`runtimeFetch`).
   * Returns `{ status: number, body: unknown, retryAfterSec?: number }`.
   */
  async function handleRequest( { method = 'GET', url: rawUrl, body: rawBody = null }, signal) {
    const u = new URL(rawUrl, 'http://dota2ai.local');
    const path = u.pathname;
    const m = method.toUpperCase();
    const parseBody = () => {
      if (rawBody == null || rawBody === '') return {};
      if (typeof rawBody === 'object') return rawBody;
      try { return JSON.parse(String(rawBody)); } catch { return {}; }
    };

    try {
      // --- /api/agent/* ---
      let match;
      if ((match = path.match(/^\/api\/agent\/([^/]+)$/))) {
        const id = decodeURIComponent(match[1]);
        if (!MATCH_ID.test(id)) return { status: 400, body: { code: 'invalid_match_id', error: 'Invalid match ID' } };
        await models.refresh();
        return { status: 200, body: await agent.availability(id) };
      }
      if (m === 'POST' && (match = path.match(/^\/api\/agent\/([^/]+)\/prepare$/))) {
        const id = decodeURIComponent(match[1]);
        if (!MATCH_ID.test(id)) return { status: 400, body: { code: 'invalid_match_id', error: 'Invalid match ID' } };
        const avail = await agent.availability(id);
        if (avail.trace && !avail.trace_outdated) return { status: 200, body: { status: 'ready' } };
        if (!avail.can_parse) return avail.trace ? { status: 200, body: { status: 'ready' } } : { status: 503, body: { status: 'unavailable' } };
        const out = await agent.prepare(id);
        return { status: out.status === 'running' ? 202 : 200, body: out };
      }
      if ((match = path.match(/^\/api\/agent\/([^/]+)\/review$/))) {
        const id = decodeURIComponent(match[1]);
        if (!MATCH_ID.test(id)) return { status: 400, body: { code: 'invalid_match_id', error: 'Invalid match ID' } };
        await models.refresh();
        if (m === 'GET') {
          const hero = heroOf(u.searchParams.get('hero'));
          if (!hero) return { status: 400, body: { code: 'invalid_hero', error: 'hero is required' } };
          const planRaw = u.searchParams.get('plan');
          const plan = planRaw == null || planRaw === '' ? null : planKey(planRaw) ?? false;
          if (plan === false) return { status: 400, body: { code: 'invalid_plan', error: 'Unknown plan' } };
          const modelRaw = u.searchParams.get('model');
          const model = modelRaw == null || modelRaw === '' ? null : agent.modelOf(modelRaw);
          if (model === false) return { status: 400, body: { code: 'invalid_model', error: 'Unknown model' } };
          return { status: 200, body: await agent.status(id, hero, normalizeUiLang(u.searchParams.get('lang')), plan, model) };
        }
        if (m === 'POST') {
          const b = parseBody();
          const hero = heroOf(b.hero);
          if (!hero) return { status: 400, body: { code: 'invalid_hero', error: 'hero is required' } };
          const plan = b.plan == null || b.plan === '' ? null : planKey(b.plan) ?? false;
          if (plan === false) return { status: 400, body: { code: 'invalid_plan', error: 'Unknown plan' } };
          const model = b.model == null || b.model === '' ? null : agent.modelOf(b.model);
          if (model === false) return { status: 400, body: { code: 'invalid_model', error: 'Unknown model' } };
          const refresh = b.refresh === true || b.force === true;
          const out = await agent.start(id, hero, normalizeUiLang(b.lang), { plan, model, ...(refresh ? { refresh: true } : {}) });
          return { status: out.status === 'running' ? 202 : out.status === 'unavailable' ? 503 : 200, body: out };
        }
      }
      if (m === 'GET' && (match = path.match(/^\/api\/agent\/([^/]+)\/evidence$/))) {
        const id = decodeURIComponent(match[1]);
        const hero = heroOf(u.searchParams.get('hero'));
        const ref = (u.searchParams.get('ref') ?? '').slice(0, 120);
        if (!MATCH_ID.test(id) || !hero || !ref) return { status: 400, body: { code: 'invalid_input', error: 'hero and ref are required' } };
        const out = await agent.evidence(id, hero, normalizeUiLang(u.searchParams.get('lang')), ref);
        return out.status === 'ok' ? { status: 200, body: out } : { status: 404, body: { code: out.status, error: 'No such evidence' } };
      }
      if (m === 'GET' && (match = path.match(/^\/api\/agent\/([^/]+)\/moment$/))) {
        const id = decodeURIComponent(match[1]);
        const hero = heroOf(u.searchParams.get('hero'));
        const t = Number(u.searchParams.get('t'));
        const toParam = u.searchParams.get('to');
        const to = toParam != null && toParam !== '' ? Number(toParam) : null;
        if (!MATCH_ID.test(id) || !hero || !Number.isFinite(t) || (to != null && (!Number.isFinite(to) || to < t))) {
          return { status: 400, body: { code: 'invalid_input', error: 'Invalid moment parameters' } };
        }
        const out = await agent.moment(id, hero, normalizeUiLang(u.searchParams.get('lang')), t, to);
        return out.status === 'ok' ? { status: 200, body: out } : { status: 404, body: { code: out.status, error: 'No such moment' } };
      }
      if (m === 'GET' && (match = path.match(/^\/api\/agent\/([^/]+)\/track$/))) {
        const id = decodeURIComponent(match[1]);
        const hero = heroOf(u.searchParams.get('hero'));
        const viewerParam = u.searchParams.get('viewer');
        const hasViewer = viewerParam != null && viewerParam !== '';
        const viewer = hasViewer ? heroOf(viewerParam) : null;
        const numParam = (v) => (typeof v === 'string' && /^-?\d{1,6}(\.\d{1,3})?$/.test(v) ? Number(v) : NaN);
        const fromParam = u.searchParams.get('from');
        const toParam = u.searchParams.get('to');
        const hasFrom = fromParam != null && fromParam !== '';
        const hasTo = toParam != null && toParam !== '';
        const from = hasFrom ? numParam(fromParam) : null;
        const to = hasTo ? numParam(toParam) : null;
        if (!MATCH_ID.test(id) || !hero || (hasViewer && !viewer) || (hasFrom && !Number.isFinite(from)) || (hasTo && !Number.isFinite(to)) || (from != null && to != null && from > to)) {
          return { status: 400, body: { code: 'invalid_input', error: 'Invalid track parameters' } };
        }
        const out = await agent.track(id, hero, normalizeUiLang(u.searchParams.get('lang')), { from, to, viewer });
        if (out.status === 'invalid_window') return { status: 400, body: { code: out.status, error: 'Invalid time window' } };
        return out.status === 'ok' ? { status: 200, body: out } : { status: 404, body: { code: out.status, error: 'No such track' } };
      }
      if (m === 'POST' && (match = path.match(/^\/api\/agent\/([^/]+)\/feedback$/))) {
        const id = decodeURIComponent(match[1]);
        const b = parseBody();
        const hero = heroOf(b.hero);
        const value = parseFeedback(b);
        if (!MATCH_ID.test(id) || !hero || !value) return { status: 400, body: { code: 'invalid_input', error: 'Invalid feedback' } };
        const plan = b.plan == null || b.plan === '' ? null : planKey(b.plan) ?? false;
        const model = b.model == null || b.model === '' ? null : agent.modelOf(b.model);
        if (plan === false || model === false) return { status: 400, body: { code: 'invalid_input', error: 'Invalid plan or model' } };
        const out = await agent.feedback(id, hero, normalizeUiLang(b.lang), { plan, model, value });
        return out.status === 'ok' ? { status: 200, body: { status: 'ok' } } : { status: 404, body: { code: out.status } };
      }

      // --- /api/coach/* ---
      if (m === 'GET' && path === '/api/coach/matchup') {
        const hero = u.searchParams.get('hero') ?? '';
        const vs = u.searchParams.get('vs') ?? '';
        const rank = u.searchParams.get('rank');
        const brief = matchupBrief(hero, vs, { rank });
        if (brief.error) return { status: 400, body: { code: 'invalid_input', error: brief.error } };
        return { status: 200, body: { ...brief, lines: { en: matchupLines(brief, 'en'), zh: matchupLines(brief, 'zh') } } };
      }
      if (m === 'GET' && (match = path.match(/^\/api\/coach\/players\/([^/]+)\/recent$/))) {
        const accountId = decodeURIComponent(match[1]);
        const res = await fetchImpl(`${apiBase}/api/coach/players/${encodeURIComponent(accountId)}/recent`, { signal });
        const b = await res.json().catch(() => ({}));
        return { status: res.status, body: b, retryAfterSec: b.retryAfterSec };
      }
      if (m === 'GET' && (match = path.match(/^\/api\/coach\/([^/]+)\/cases$/))) {
        const id = decodeURIComponent(match[1]);
        const res = await fetchImpl(`${apiBase}/api/coach/${encodeURIComponent(id)}/cases${u.search}`, { signal });
        const b = await res.json().catch(() => ({}));
        return { status: res.status, body: b, retryAfterSec: b.retryAfterSec };
      }
      if (m === 'GET' && (match = path.match(/^\/api\/coach\/([^/]+)\/cards$/))) {
        const id = decodeURIComponent(match[1]);
        const seat = Number(u.searchParams.get('seat'));
        if (!Number.isInteger(seat) || seat < 0 || seat > 9) return { status: 400, body: { code: 'invalid_seat', error: 'seat must be 0-9' } };
        const report = await fetchCoachReportRemote(id, '', signal);
        return { status: 200, body: buildSurface(report, seat) };
      }
      if (m === 'GET' && (match = path.match(/^\/api\/coach\/([^/]+)$/))) {
        const id = decodeURIComponent(match[1]);
        const rawCached = await matchDocs.get(`${id}.raw.json`);
        if (rawCached && Array.isArray(rawCached.players?.[0]?.gold_t)) {
          const overrides = {};
          if (u.searchParams.has('slot') && u.searchParams.has('pos')) {
            overrides[Number(u.searchParams.get('slot'))] = Number(u.searchParams.get('pos'));
          }
          return { status: 200, body: buildCoachReport(rawCached, { roleOverrides: overrides }) };
        }
        const report = await fetchCoachReportRemote(id, u.searchParams.toString(), signal);
        return { status: 200, body: report };
      }
      if (m === 'POST' && (match = path.match(/^\/api\/review\/([^/]+)\/parse-request$/))) {
        const id = decodeURIComponent(match[1]);
        const res = await fetchImpl(`${apiBase}/api/review/${encodeURIComponent(id)}/parse-request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody ?? {}),
          signal,
        });
        const b = await res.json().catch(() => ({}));
        return { status: res.status, body: b };
      }

      // --- /api/patch/* ---
      if (m === 'GET' && path === '/api/patch') {
        await models.refresh();
        const out = runPatchTool('patch_overview', {}, { lang: normalizeUiLang(u.searchParams.get('lang')) });
        const { tool: _tool, ...rest } = out;
        return { status: 200, body: { ...rest, advisor: models.isConfigured() } };
      }
      if (m === 'GET' && path === '/api/patch/news') {
        const res = await fetchImpl(`${apiBase}/api/patch/news`, { signal });
        if (!res.ok) return { status: res.status, body: { code: 'patch_news_unavailable' } };
        return { status: 200, body: await res.json() };
      }

      return { status: 404, body: { code: 'not_found', error: `Unknown route ${path}` } };
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 502;
      return {
        status,
        body: { code: error?.code ?? 'upstream', error: error?.message ?? 'Request failed', ...(error?.retryAfterSec ? { retryAfterSec: error.retryAfterSec } : {}) },
        ...(error?.retryAfterSec ? { retryAfterSec: error.retryAfterSec } : {}),
      };
    }
  }

  /**
   * Handle a streaming SSE `/api/*` request (`/api/agent/:id/chat`, `/api/coach/:id/ask`, `/api/patch/chat`).
   * Yields JSON frame objects (`{ step }`, `{ text, unverified? }`, `{ error }`, `{ done: true }`).
   */
  async function* handleStream({ url: rawUrl, body: rawBody = null }, signal) {
    const u = new URL(rawUrl, 'http://dota2ai.local');
    const path = u.pathname;
    let parsed = {};
    try { parsed = typeof rawBody === 'string' ? JSON.parse(rawBody) : (rawBody ?? {}); } catch { parsed = {}; }

    // Async queue so synchronous `onEvent({ type: 'tool_start' })` callbacks stream live as yields!
    async function* runWithSteps(runner) {
      const queue = [];
      let wake = null;
      let finished = false;
      let outcome = null;
      let thrown = null;

      const push = (frame) => {
        queue.push(frame);
        if (wake) { const w = wake; wake = null; w(); }
      };

      const task = runner(push)
        .then((res) => { outcome = res; })
        .catch((err) => { thrown = err; })
        .finally(() => {
          finished = true;
          if (wake) { const w = wake; wake = null; w(); }
        });

      while (!finished || queue.length > 0) {
        while (queue.length > 0) yield queue.shift();
        if (!finished) await new Promise((r) => { wake = r; });
      }
      await task;
      if (thrown) throw thrown;
      return outcome;
    }

    let match;
    if ((match = path.match(/^\/api\/agent\/([^/]+)\/chat$/))) {
      const id = decodeURIComponent(match[1]);
      const body = parseChatBody(parsed);
      if (!MATCH_ID.test(id) || body.error || !heroOf(body.hero)) {
        yield { error: body.error || 'invalid_input' };
        yield { done: true };
        return;
      }
      await models.refresh();
      const model = body.model == null || body.model === '' ? null : agent.modelOf(body.model);
      if (model === false) {
        yield { error: 'invalid_model' };
        yield { done: true };
        return;
      }
      const avail = await agent.availability(id);
      const cannot = !avail.trace ? 'no_trace' : !avail.heroes.some((h) => h.hero === body.hero.trim().toLowerCase().replace(/[\s-]+/g, '_')) ? 'unknown_hero' : !avail.model_configured ? 'unavailable' : null;
      if (cannot) {
        yield { error: cannot };
        yield { done: true };
        return;
      }
      try {
        let out;
        for await (const frame of runWithSteps(async (push) => {
          out = await agent.chat({
            matchId: id,
            hero: body.hero,
            lang: body.lang,
            plan: body.plan,
            model,
            question: body.question,
            history: body.history,
            signal,
            onEvent: (e) => { if (e.type === 'tool_start') push({ step: { tool: e.name, args: e.args } }); },
          });
        })) {
          yield frame;
        }
        if (out?.status === 'ok') yield { text: out.text, ...(out.unverified?.length ? { unverified: out.unverified } : {}) };
        else yield { error: out?.status ?? 'failed' };
      } catch {
        if (!signal?.aborted) yield { error: 'failed' };
      }
      yield { done: true };
      return;
    }

    if ((match = path.match(/^\/api\/coach\/([^/]+)\/ask$/))) {
      const id = decodeURIComponent(match[1]);
      const body = parseAskBody(parsed);
      if (!MATCH_ID.test(id) || body.error) {
        yield { notice: body.error || 'invalid_input', done: true };
        return;
      }
      await models.refresh();
      try {
        const qs = body.pos != null ? `slot=${body.slot}&pos=${body.pos}` : '';
        const report = await fetchCoachReportRemote(id, qs, signal);
        const ans = await askReportWithHostModel({
          report,
          slot: body.slot,
          lang: body.lang,
          question: body.question,
          history: body.history,
          signal,
        });
        yield { text: ans.text, ...(ans.fallback ? { fallback: true } : {}) };
        if (ans.notice) yield { notice: ans.notice };
      } catch {
        if (!signal?.aborted) yield { notice: FALLBACK_NOTICE[body.lang] ?? FALLBACK_NOTICE.en };
      }
      yield { done: true };
      return;
    }

    if (path === '/api/patch/chat') {
      const body = parseAdvisorBody(parsed);
      if (body.error) {
        yield { error: body.error };
        yield { done: true };
        return;
      }
      await models.refresh();
      const complete = models.defaultComplete();
      if (!complete) {
        yield { error: 'unavailable' };
        yield { done: true };
        return;
      }
      try {
        let out;
        for await (const frame of runWithSteps(async (push) => {
          out = await runAdvisor({
            complete,
            lang: body.lang,
            question: body.question,
            history: body.history,
            signal,
            onEvent: (e) => {
              if (e.type === 'tool_start') {
                const about = aboutOf(e.name, e.args, body.lang);
                push({ step: { tool: e.name, args: e.args, ...(about ? { about } : {}) } });
              }
            },
          });
        })) {
          yield frame;
        }
        if (out?.status === 'ok') yield { text: out.text, ...(out.unverified?.length ? { unverified: out.unverified } : {}) };
        else yield { error: out?.status ?? 'failed' };
      } catch {
        if (!signal?.aborted) yield { error: 'failed' };
      }
      yield { done: true };
      return;
    }

    yield { error: 'not_found' };
    yield { done: true };
  }

  return {
    home,
    models,
    agent,
    coach,
    replay,
    getProfile: async () => cleanJson(await getProfile()),
    saveProfile: async (patch) => cleanJson(await saveProfile(patch)),
    handleRequest: async (req, signal) => cleanJson(await handleRequest(req, signal)),
    handleStream: async function* (req, signal) {
      for await (const frame of handleStream(req, signal)) {
        yield cleanJson(frame);
      }
    },
    shutdown: () => agent.shutdown(),
  };
}
