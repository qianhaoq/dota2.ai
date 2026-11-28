/** Client for the review agent (lib/agent/router.js). */
import type { GoalSpec } from '../coach/types';
import { runtimeFetch } from '../runtime/dota2aiRuntime';
import { internalHeaders } from '../services/analytics';

export interface AgentHero { hero: string; team: 'radiant' | 'dire'; hero_id: number | null; en: string; zh: string; ru?: string }
/**
 * Where the replay parse stands when there is no trace yet. `final`: trying again will not help (the replay is gone).
 * `retry_in_sec` (a failure that is not final): how long until asking again starts a new parse — sooner, the same
 * failure is answered. 0: now.
 */
export type ParseState = { status: 'none' } | { status: 'running'; stage: string | null } | { status: 'failed'; reason: string; final: boolean; retry_in_sec?: number } | { status: 'ready' } | { status: 'unavailable' };
export interface ModelMeta { label: string; minutes?: [number, number] | null }
export interface Availability {
  trace: boolean; model_configured: boolean; can_parse: boolean; heroes: AgentHero[]; parse?: ParseState;
  /** The models a review can be asked from here (ids of lib/agent/models.js, or host-supplied ids), the default first; absent where there is no choice. */
  models?: string[]; default_model?: string | null;
  /** Display labels and optional measured wait spans for host-supplied models (such as DSH's configured models). */
  model_meta?: Record<string, ModelMeta>;
  /** Radiant's net worth lead per game minute, from the replay itself (absent when the trace has no net worth graph). */
  radiant_net_worth_lead?: number[];
  /** Radiant's lead in gold earned per game minute, summed from the replay's combat log (a trace that kept its gold rows); then the net worth lead is absent. */
  radiant_gold_lead?: number[];
}

export interface EvidenceItem { refs: string[]; clock?: string; fact: string }
/** One evidence-backed positive from the game that the player can celebrate and replay. */
export interface ReviewHighlight { title: string; detail: string; evidence?: EvidenceItem[] }
export type ChapterTopic = 'draft_and_lanes' | 'laning' | 'skill_build' | 'items' | 'teamfights' | 'macro' | 'other';
export type ChapterAssessment = 'praise' | 'solid' | 'mixed' | 'key_gap';
/** One adaptive coaching chapter examining a game-relevant dimension. */
export interface ReviewChapter {
  topic: ChapterTopic;
  title: string;
  assessment: ChapterAssessment;
  analysis: string;
  takeaway?: string;
  evidence: EvidenceItem[];
}
/** The one rule a finding sends into the next game: a situation the player can see, one action, and how often it came up this game. */
export interface FindingRule { when: string; do: string; this_game?: string; /** Legacy stored reviews may carry a habit spec; new reviews do not emit mechanical quotas. */ check?: GoalSpec }
export interface ReviewFinding { title: string; claim: string; evidence: EvidenceItem[]; fix: string; rule?: FindingRule; /** The link of the story it comes from (1-based), when it named one that held. */ story_link?: number }
/** One link of the story of the game (lib/agent/review/verify.js storyOf, #437 P4): a stretch, what changed, why, whose it mostly was. */
export interface StoryLink { phase: string; what_changed: string; because: string; whose: 'me' | 'team' | 'enemy' | 'draft' | 'unclear'; evidence: EvidenceItem[] }
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
  verdict: string;
  /** Sincere, grounded coach opening contextualizing the match fairly. */
  opening_note?: string;
  /** Concrete, evidence-backed positives from this match. */
  highlights?: ReviewHighlight[];
  /** Adaptive full-dimension coaching chapters tailored to this match. */
  chapters?: ReviewChapter[];
  /** The story as a chain of causes; absent on reviews written before it (they have only mainline). */
  story?: StoryLink[];
  mainline: string[];
  findings: ReviewFinding[];
  did_well: string[];
  next_game: string[];
  /** Sincere, specific closing encouragement from the coach. */
  encouragement?: string;
  blind_spots: string[];
  game_plan?: GamePlan;
  /** Which patch the review's prices, item effects and cooldowns are from (lib/agent/patchData.js); absent on reviews written before it was kept. */
  data_patch?: { name: string; hotfix?: string; exact: boolean; known_from?: 'match_data' | 'start_time' | 'match_id'; reason?: string };
  /** Legacy stored reviews may carry a scoreboard goal; new reviews do not emit mechanical KPIs. */
  goal?: GoalSpec & { finding: number };
}
export interface ToolStep { tool: string; args: Record<string, unknown>; /** What the lookup is about, named for the reader (the patch advisor sends it). */ about?: string }
export interface TokenUsageBreakdown {
  input: number;
  output: number;
  /** Uncached input tokens; null when the provider did not report a cache split. */
  input_uncached: number | null;
  /** Cached input tokens read; null when the provider did not report cache hits. */
  cache_read: number | null;
  /** Cache creation/write input tokens; null when the provider did not report cache writes. */
  cache_write: number | null;
  /** 'provider_usage' when every contributing call reported provider telemetry; null when absent/incomplete. */
  source?: 'provider_usage' | null;
}
export interface StageUsageBreakdown extends TokenUsageBreakdown {
  steps: number;
  tool_calls: number;
  truncation_retries?: number;
}
export interface ReviewUsage extends TokenUsageBreakdown {
  stages?: {
    first?: StageUsageBreakdown;
    repair?: StageUsageBreakdown;
    translate?: StageUsageBreakdown;
  };
}
export interface ReviewRunMeta {
  model?: string | null;
  steps?: number;
  tool_calls?: number;
  repair_rounds?: number;
  truncation_retries?: number;
  usage?: ReviewUsage | null;
  usage_source?: 'provider_usage' | null;
}
export type ReviewState =
  | { status: 'none' | 'no_trace' | 'unknown_hero' }
  | { status: 'running'; steps: ToolStep[] }
  | {
      status: 'ready';
      review: DeepReview;
      /** All pre-generated language variants when stored as a trilingual bundle. */
      reviews?: Partial<Record<'en' | 'zh' | 'ru', DeepReview>>;
      verification: { repaired: boolean; dropped: number };
      model: string | null;
      tool_calls: number;
      steps?: number;
      repair_rounds?: number;
      truncation_retries?: number;
      usage?: ReviewUsage;
      usage_source?: 'provider_usage' | null;
      /** The prompt version the review was written under; absent from a server that does not say. */
      prompt_version?: number;
      /** The server's current prompt version when a compatible earlier cached review is shown. */
      latest_prompt_version?: number;
      /** True when a compatible cached review from an earlier prompt version is shown instead of regenerating. */
      stale_version?: boolean;
      /** True when served directly from cache across prompt versions. */
      cached?: boolean;
    }
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
  runtimeFetch(`/api/agent/${enc(matchId)}`, { signal }).then((r) => json<Availability>(r));

/** Start parsing the replay into a trace (or learn that it is already running / impossible). */
export const prepareMatch = (matchId: string) =>
  runtimeFetch(`/api/agent/${enc(matchId)}/prepare`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...internalHeaders() }, body: '{}' }).then((r) => json<ParseState>(r));

/**
 * `plan`: the plan the reader named, if any — a review made for it is its own review.
 * `model`: the model the reader chose, when it is not the default — a review written by it is its own review too.
 */
export const fetchReview = (matchId: string, hero: string, lang: string, signal?: AbortSignal, plan?: string | null, model?: string | null) =>
  runtimeFetch(`/api/agent/${enc(matchId)}/review?hero=${enc(hero)}&lang=${lang}${plan ? `&plan=${enc(plan)}` : ''}${model ? `&model=${enc(model)}` : ''}`, { signal }).then((r) => json<ReviewState>(r));

export const startReview = (matchId: string, hero: string, lang: string, plan?: string | null, model?: string | null, refresh = false) =>
  runtimeFetch(`/api/agent/${enc(matchId)}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...internalHeaders() }, body: JSON.stringify({ hero, lang, ...(plan ? { plan } : {}), ...(model ? { model } : {}), ...(refresh ? { refresh: true } : {}) }) }).then((r) => json<ReviewState>(r));

/** Where the ten heroes were around a game time (lib/agent/moment.js): what the page replays. */
export interface Moment {
  status: 'ok'; t: number; clock: string; from: number; to: number; me: string;
  heroes: { hero: string; side: 'me' | 'ally' | 'enemy' }[];
  /** One per second; `at[i]` is hero i's [x, y, alive], or null for a second the replay has no sample of them. */
  frames: { t: number; at: ([number, number, 0 | 1] | null)[] }[];
  deaths: { t: number; hero: string; killer: string | null; resurrected_by?: 'reincarnation' | 'aegis' }[];
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
export function fetchMoment(matchId: string, hero: string, lang: string, t: number, to?: number): Promise<Moment> {
  const end = to != null && Number.isFinite(to) ? to : undefined;
  const key = `${matchId}|${hero}|${lang}|${t}|${end ?? ''}`;
  let p = momentCache.get(key);
  if (!p) {
    p = runtimeFetch(`/api/agent/${enc(matchId)}/moment?hero=${enc(hero)}&lang=${lang}&t=${t}${end != null ? `&to=${end}` : ''}`).then(async (r) => {
      const out = await json<Moment>(r);
      if (!out || !Array.isArray(out.frames)) throw new AgentApiError('invalid_moment', r.status);
      return out;
    });
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
    const res = await runtimeFetch(`/api/agent/${enc(matchId)}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...internalHeaders() }, body: JSON.stringify(body) });
    return res.ok;
  } catch { return false; }
}

const evidenceCache = new Map<string, Promise<EvidenceRecord>>();
export function clearAgentCaches(): void {
  momentCache.clear();
  evidenceCache.clear();
}
/** The tool record behind a ref. Records are pure functions of the replay, so they are cached for the session. */
export function fetchEvidence(matchId: string, hero: string, lang: string, ref: string): Promise<EvidenceRecord> {
  const key = `${matchId}|${hero}|${lang}|${ref}`;
  let p = evidenceCache.get(key);
  if (!p) {
    p = runtimeFetch(`/api/agent/${enc(matchId)}/evidence?hero=${enc(hero)}&lang=${lang}&ref=${enc(ref)}`).then(async (r) => {
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
  const res = await runtimeFetch(`/api/agent/${enc(matchId)}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...internalHeaders() }, body: JSON.stringify(body), signal });
  return readChatStream(res, ev);
}
