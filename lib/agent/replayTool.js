/**
 * MCP `replay_review`: the deep replay review (lib/agent) for an agent, one call at a time. A first review takes
 * a few minutes (fetch the replay, parse it, the coach goes through it), longer than an agent's tool call should
 * block. So a call never waits: it starts what is missing and says where things stand, and the agent calls
 * again after `poll_after_sec` until `status` is `ready`.
 *
 *   pick_hero         no hero, or one not in this game: ask the user which they played (`heroes` when known)
 *   parsing           the replay is being fetched and read
 *   reviewing         the coach is going through it (`steps`: lookups so far)
 *   ready             the review: verdict, findings with their replay evidence, what to do next game, the page
 *   failed            the coach could not finish a review it could back; started again only with `retry: true`
 *                     (a poll must not spend the caller's review slots on the same failure, over and over)
 *   replay_unavailable / unavailable    nothing to review here, and why
 *
 * Starts count against the same per-caller and global limits as the web page's (lib/agent/router.js
 * forRequest); a refusal is an error that says when to come back. Pure apart from `api`.
 */
import { heroByKey } from '../../packages/review-engine/src/staticHeroes.js';
import { normalizeUiLang } from '../aiLanguage.js';

export const POLL_AFTER_SEC = 20;
const SITE = 'https://dota2.ai';

export class ReplayToolError extends Error {
  /** @param {'INVALID_INPUT' | 'RATE_LIMITED'} code */
  constructor(code, message) { super(message); this.code = code; }
}

const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s'-]+/g, '_');

/** The hero of `heroes` (availability's list) that `input` names: its key, English or Chinese name, or hero id. */
export function resolveHero(heroes, input) {
  if (input == null || input === '') return null;
  const raw = String(input).trim();
  const n = norm(raw);
  const id = /^\d{1,4}$/.test(raw) ? Number(raw) : heroByKey(n)?.id ?? null;
  return heroes.find((h) => h.hero === n || norm(h.en) === n || h.zh === raw || (id != null && h.hero_id === id)) ?? null;
}

const roster = (heroes) => heroes.map((h) => ({ hero: h.hero, team: h.team, en: h.en, zh: h.zh }));

/** The stored review, as an agent should quote it: every clock and number in it was checked against the replay. */
export function shapeReview(matchId, hero, lang, state) {
  const r = state.review ?? {};
  // The language is always in the link: reviews are kept per language, and without it the page opens in the
  // reader's own last choice and asks for a review that may not exist.
  const url = `${SITE}/r/${matchId}?hero=${encodeURIComponent(hero)}&lang=${lang}`;
  return {
    status: 'ready',
    match_id: String(matchId), hero, lang, url,
    verdict: r.verdict ?? null,
    mainline: r.mainline ?? [],
    findings: (r.findings ?? []).map((f) => ({
      title: f.title, claim: f.claim, fix: f.fix ?? null,
      evidence: (f.evidence ?? []).map((e) => ({ clock: e.clock ?? null, fact: e.fact })),
      ...(f.rule ? { rule: { when: f.rule.when, do: f.rule.do } } : {}),
    })),
    did_well: r.did_well ?? [],
    next_game: r.next_game ?? [],
    blind_spots: r.blind_spots ?? [],
    checked: { against: 'replay records', removed_for_lack_of_evidence: state.verification?.dropped ?? 0 },
    note: 'Times and numbers were checked against the replay. Quote them as given, say what the review cannot see (blind_spots), and link the url: it has every piece of evidence and a coach to ask.',
  };
}

const refusal = (r) => {
  const after = r.body?.retryAfterSec ?? 60;
  return new ReplayToolError('RATE_LIMITED', r.status === 429
    ? `Too many reviews started by this caller; try again in ${after} s.`
    : `The coach is at capacity; try again in ${after} s.`);
};

/**
 * @param {{ read: Function, validMatch: Function, availability: Function, status: Function, prepare: Function, start: Function }} api
 *   lib/agent/router.js forRequest(req)
 * @param {{ match_id: string | number, hero?: string | number, lang?: 'en' | 'zh', retry?: boolean }} args
 */
export async function replayReview(api, args) {
  const matchId = String(args?.match_id ?? '').trim();
  if (!api.validMatch(matchId)) throw new ReplayToolError('INVALID_INPUT', 'match_id must be a Dota 2 match ID (digits).');
  const lang = normalizeUiLang(args?.lang);
  const g = api.read();
  if (!g.ok) throw new ReplayToolError('RATE_LIMITED', `Too many requests; try again in ${g.retryAfterSec} s.`);
  const avail = await api.availability(matchId);

  if (!avail.trace) {
    if (!avail.can_parse) return { status: 'unavailable', reason: 'replay_parsing_off', message: 'This server cannot fetch replays, so it cannot review this game.' };
    const p = avail.parse ?? { status: 'none' };
    if (p.status === 'failed' && p.final) return replayGone(p.reason);
    // A hero is needed for the review, not for the parse: start the parse now either way, and ask while it runs.
    if (p.status !== 'running') {
      const r = await api.prepare(matchId);
      if (r.status === 429 || (r.status === 503 && r.body?.retryAfterSec)) throw refusal(r);
      if (r.body?.status === 'failed' && r.body.final) return replayGone(r.body.reason);
      if (r.body?.status === 'unavailable') return { status: 'unavailable', reason: 'replay_parsing_off', message: 'This server cannot fetch replays, so it cannot review this game.' };
    }
    return {
      status: 'parsing', match_id: matchId,
      message: 'Fetching and reading the replay (a minute or two). Call replay_review again with the same arguments.',
      ...(args?.hero == null || args.hero === '' ? { ask_user: 'Which hero did the user play in this game? (coach_report without hero lists the roster.)' } : {}),
      poll_after_sec: POLL_AFTER_SEC,
    };
  }

  const hero = resolveHero(avail.heroes, args?.hero);
  if (!hero) {
    return {
      status: 'pick_hero', match_id: matchId,
      message: args?.hero == null || args.hero === '' ? 'The review is written for one player: ask the user which hero they played.' : `"${String(args.hero).slice(0, 40)}" is not in this game: ask the user which hero they played.`,
      heroes: roster(avail.heroes),
    };
  }
  let state = await api.status(matchId, hero.hero, lang);
  // "none" can also be a failure the page no longer calls one (a minute on), or one another instance ran:
  // only a retry the agent asked for starts it again.
  if (state.status === 'none' && args?.retry !== true && api.lastFailure) {
    const f = await api.lastFailure(matchId, hero.hero, lang);
    if (f) state = { status: 'failed', reason: f.reason };
  }
  if (state.status === 'failed' && args?.retry !== true) {
    return {
      status: 'failed', match_id: matchId, hero: hero.hero, lang, reason: state.reason ?? null,
      message: 'The coach could not finish a review it could back with the replay. It often works on a second try: call replay_review again with retry: true (this counts as a new start).',
    };
  }
  if (state.status === 'none' || state.status === 'failed') {
    if (!avail.model_configured) return { status: 'unavailable', reason: 'model_not_configured', message: 'The coach is not available on this server right now.' };
    const r = await api.start(matchId, hero.hero, lang);
    if (r.status === 429 || (r.status === 503 && r.body?.retryAfterSec)) throw refusal(r);
    if (r.status === 503) return { status: 'unavailable', reason: 'model_not_configured', message: 'The coach is not available on this server right now.' };
    state = r.body;
  }
  if (state.status === 'ready') return shapeReview(matchId, hero.hero, lang, state);
  return {
    status: 'reviewing', match_id: matchId, hero: hero.hero, lang,
    steps: Array.isArray(state.steps) ? state.steps.length : 0,
    message: 'The coach is going through the replay (two to three minutes in all). Call replay_review again with the same arguments.',
    poll_after_sec: POLL_AFTER_SEC,
  };
}

function replayGone(reason) {
  return reason === 'replay_gone'
    ? { status: 'replay_unavailable', reason, message: 'Valve keeps replays for about two weeks; this one is gone, so there is nothing to review honestly. coach_report still has the scoreboard-level review.' }
    : { status: 'replay_unavailable', reason: reason ?? 'parse_failed', message: 'The replay could not be fetched or read. coach_report still has the scoreboard-level review.' };
}
