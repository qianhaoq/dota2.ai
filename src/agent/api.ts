/** Client for the review agent (lib/agent/router.js). */
import type { GoalSpec } from '../coach/types';
import { internalHeaders } from '../services/analytics';

export interface AgentHero { hero: string; team: 'radiant' | 'dire'; hero_id: number | null; en: string; zh: string; ru?: string }
/**
 * Where the replay parse stands when there is no trace yet. `final`: trying again will not help (the replay is gone).
 * `retry_in_sec` (a failure that is not final): how long until asking again starts a new parse — sooner, the same
 * failure is answered. 0: now.
 */
export type ParseState = { status: 'none' } | { status: 'running'; stage: string | null } | { status: 'failed'; reason: string; final: boolean; retry_in_sec?: number } | { status: 'ready' } | { status: 'unavailable' };
export interface Availability {
  trace: boolean; model_configured: boolean; can_parse: boolean; heroes: AgentHero[]; parse?: ParseState;
  /** The models a review can be asked from here (ids of lib/agent/models.js), the default first; absent where there is no choice. */
  models?: string[]; default_model?: string | null;
  /** Radiant's net worth lead per game minute, from the replay itself (absent when the trace has no net worth graph). */
  radiant_net_worth_lead?: number[];
  /** Radiant's lead in gold earned per game minute, summed from the replay's combat log (a trace that kept its gold rows); then the net worth lead is absent. */
  radiant_gold_lead?: number[];
}

export interface EvidenceItem { refs: string[]; clock?: string; fact: string }
/** The one rule a finding sends into the next game: a situation the player can see, one action, and how often it came up this game. */
export interface FindingRule { when: string; do: string; this_game?: string; /** What the next game's replay is counted on for this rule (lib/coach/goals.js habitGoal). */ check?: GoalSpec }
export interface ReviewFinding { title: string; claim: string; evidence: EvidenceItem[]; fix: string; rule?: FindingRule }
/** How the game was played as a whole (lib/agent/deepReview.js planOf): only what the check let through. */
export interface GamePlan {
  /** When each side had its chance (window_report). */
  window?: string;
  /** The game read against the plan the player named (only when they named one). */
  against_your_plan?: string;
  line_ups?: string; course?: string; your_part?: string; strengths?: string;
  /** What the course is mostly down to; present only together with the sentence that argues it. */
  main_reason?: 'your_play' | 'team_play' | 'enemy_play' | 'line_ups' | 'unclear'; why?: string;
  evidence: EvidenceItem[];
}
export interface DeepReview {
  /** The plan the player named before the review, if they did (lib/agent/plans.js). */
  plan?: string;
  schema: string; match_id: number; hero: string; lang: 'en' | 'zh' | 'ru';
  verdict: string; mainline: string[]; findings: ReviewFinding[]; did_well: string[]; next_game: string[]; blind_spots: string[];
  game_plan?: GamePlan;
  /** Which patch the review's prices, item effects and cooldowns are from (lib/agent/patchData.js); absent on reviews written before it was kept. */
  data_patch?: { name: string; hotfix?: string; exact: boolean; known_from?: 'match_data' | 'start_time' | 'match_id'; reason?: string };
  /** One thing the next game can be checked on (lib/agent/goal.js), tied to finding `finding` (1-based). */
  goal?: GoalSpec & { finding: number };
}
export interface ToolStep { tool: string; args: Record<string, unknown>; /** What the lookup is about, named for the reader (the patch advisor sends it). */ about?: string }
export type ReviewState =
  | { status: 'none' | 'no_trace' | 'unknown_hero' }
  | { status: 'running'; steps: ToolStep[] }
  | { status: 'ready'; review: DeepReview; /** All pre-generated language variants when stored as a trilingual bundle. */ reviews?: Partial<Record<'en' | 'zh' | 'ru', DeepReview>>; verification: { repaired: boolean; dropped: number }; model: string | null; tool_calls: number; /** The prompt version the review was written under; absent from a server that does not say. */ prompt_version?: number }
  | { status: 'failed'; reason?: string }
  /** `retry_in_sec`: the model account refused a review a moment ago (out of credit, key refused) and none is started until then; it can be tried again. */
  | { status: 'unavailable'; reason?: string; retry_in_sec?: number };

export interface EvidenceRecord { status: 'ok'; ref: string; kind: string; record: any; names: Record<string, string> }

export class AgentApiError extends Error {
  constructor(public code: string, public status: number, public retryAfterSec?: number) { super(code); }
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok && !body.status) throw new AgentApiError(body.code ?? 'failed', res.status, body.retryAfterSec);
  return body as T;
}
const enc = encodeURIComponent;

export const fetchAvailability = (matchId: string, signal?: AbortSignal) =>
  fetch(`/api/agent/${enc(matchId)}`, { signal }).then((r) => json<Availability>(r));

/** Start parsing the replay into a trace (or learn that it is already running / impossible). */
export const prepareMatch = (matchId: string) =>
  fetch(`/api/agent/${enc(matchId)}/prepare`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...internalHeaders() }, body: '{}' }).then((r) => json<ParseState>(r));

/**
 * `plan`: the plan the reader named, if any — a review made for it is its own review.
 * `model`: the model the reader chose, when it is not the default — a review written by it is its own review too.
 */
export const fetchReview = (matchId: string, hero: string, lang: string, signal?: AbortSignal, plan?: string | null, model?: string | null) =>
  fetch(`/api/agent/${enc(matchId)}/review?hero=${enc(hero)}&lang=${lang}${plan ? `&plan=${enc(plan)}` : ''}${model ? `&model=${enc(model)}` : ''}`, { signal }).then((r) => json<ReviewState>(r));

export const startReview = (matchId: string, hero: string, lang: string, plan?: string | null, model?: string | null) =>
  fetch(`/api/agent/${enc(matchId)}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...internalHeaders() }, body: JSON.stringify({ hero, lang, ...(plan ? { plan } : {}), ...(model ? { model } : {}) }) }).then((r) => json<ReviewState>(r));

/** Where the ten heroes were around a game time (lib/agent/moment.js): what the page replays. */
export interface Moment {
  status: 'ok'; t: number; clock: string; from: number; to: number; me: string;
  heroes: { hero: string; side: 'me' | 'ally' | 'enemy' }[];
  /** One per second; `at[i]` is hero i's [x, y, alive], or null for a second the replay has no sample of them. */
  frames: { t: number; at: ([number, number, 0 | 1] | null)[] }[];
  deaths: { t: number; hero: string; killer: string | null }[];
  /** The square of the map to show, in world units from its lower-left corner. */
  box: { x: number; y: number; size: number };
  /** Never near the player in the window, and the replay shows it for every second; `not_known`: not seen near, with a second the replay cannot speak for. */
  away: string[]; not_known: string[];
  /** Where on the map the player stood at the moment, in the reader's words; null without a sample. */
  place: string | null; place_name: string | null;
  names: Record<string, string>;
  /** The game's own name for each hero, which its minimap icon is filed under. */
  icons: Record<string, string>;
  /** Abilities cast in the window by the player and the heroes near them; null (or absent) when the replay data has no list of casts. */
  casts?: { t: number; hero: string; ability: string; target: string | null; ultimate?: boolean }[] | null;
  /** Wards standing inside the square during the window, by whose they were; null (or absent) when the replay data has no list of wards. A ward is a place, not what it showed. */
  wards?: { x: number; y: number; side: 'mine' | 'enemy'; kind: 'observer' | 'sentry'; from: number | null; to: number | null }[] | null;
}
const momentCache = new Map<string, Promise<Moment>>();
/** A moment is a pure function of the replay, so it is fetched once a session. */
export function fetchMoment(matchId: string, hero: string, lang: string, t: number): Promise<Moment> {
  const key = `${matchId}|${hero}|${lang}|${t}`;
  let p = momentCache.get(key);
  if (!p) {
    p = fetch(`/api/agent/${enc(matchId)}/moment?hero=${enc(hero)}&lang=${lang}&t=${t}`).then((r) => json<Moment>(r));
    p.catch(() => momentCache.delete(key));
    momentCache.set(key, p);
  }
  return p;
}

export type FindingRating = 'right' | 'wrong' | 'useless';
/** Why a finding was wrong (fact, judgment, not_mine) or not useful (knew, vague, minor): lib/agent/feedback.js. */
export type FindingReason = 'fact' | 'judgment' | 'not_mine' | 'knew' | 'vague' | 'minor';
/**
 * The reader's word on one finding of the review on screen. `id` is made up by the page for this finding: the
 * same id again replaces what was said. True when the server kept it.
 */
export async function sendFindingFeedback(matchId: string, body: { hero: string; lang: string; version: number; finding: number; title: string; rating: FindingRating; reason: FindingReason | null; id: string; plan?: string; model?: string }): Promise<boolean> {
  try {
    const res = await fetch(`/api/agent/${enc(matchId)}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...internalHeaders() }, body: JSON.stringify(body) });
    return res.ok;
  } catch { return false; }
}

const evidenceCache = new Map<string, Promise<EvidenceRecord>>();
/** The tool record behind a ref. Records are pure functions of the replay, so they are cached for the session. */
export function fetchEvidence(matchId: string, hero: string, lang: string, ref: string): Promise<EvidenceRecord> {
  const key = `${matchId}|${hero}|${lang}|${ref}`;
  let p = evidenceCache.get(key);
  if (!p) {
    p = fetch(`/api/agent/${enc(matchId)}/evidence?hero=${enc(hero)}&lang=${lang}&ref=${enc(ref)}`).then(async (r) => {
      const out = await json<EvidenceRecord>(r);
      if (!out || typeof out !== 'object' || !('record' in out) || !out.record) throw new AgentApiError('invalid_evidence', r.status);
      return out;
    });
    p.catch(() => evidenceCache.delete(key));
    evidenceCache.set(key, p);
  }
  return p;
}

/** `clean`: the answer came back with nothing unsupported; only such answers back a later one (lib/agent/chat.js). */
export interface ChatTurn { q: string; a: string; clean: boolean }
export interface ChatEvents { onStep: (step: ToolStep) => void; onText: (text: string, unverified: { kind: string; text: string }[]) => void; onError: (code: string) => void }

/** Read a chat answer sent as SSE: `{step}` frames while the agent looks things up, then `{text}` (or `{error}`), then `{done}`. */
export async function readChatStream(res: Response, ev: ChatEvents): Promise<void> {
  if (!res.ok || !res.body) { const b = await res.json().catch(() => ({})); throw new AgentApiError(b.code ?? 'failed', res.status, b.retryAfterSec); }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
      if (!frame.startsWith('data: ')) continue;
      let msg: any;
      try { msg = JSON.parse(frame.slice(6)); } catch { continue; }
      if (msg.step) ev.onStep(msg.step);
      else if (typeof msg.text === 'string') ev.onText(msg.text, msg.unverified ?? []);
      else if (msg.error) ev.onError(String(msg.error));
    }
  }
}

/** One chat turn about a match. */
export async function askAgent(matchId: string, body: { hero: string; lang: string; question: string; history: ChatTurn[]; plan?: string; model?: string }, ev: ChatEvents, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`/api/agent/${enc(matchId)}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...internalHeaders() }, body: JSON.stringify(body), signal });
  return readChatStream(res, ev);
}
