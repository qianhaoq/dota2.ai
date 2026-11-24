/** Client for the review agent (lib/agent/router.js). */
import type { GoalSpec } from '../coach/types';

export interface AgentHero { hero: string; team: 'radiant' | 'dire'; hero_id: number | null; en: string; zh: string }
/** Where the replay parse stands when there is no trace yet. `final`: trying again will not help (the replay is gone). */
export type ParseState = { status: 'none' } | { status: 'running'; stage: string | null } | { status: 'failed'; reason: string; final: boolean } | { status: 'ready' } | { status: 'unavailable' };
export interface Availability {
  trace: boolean; model_configured: boolean; can_parse: boolean; heroes: AgentHero[]; parse?: ParseState;
  /** Radiant's net worth lead per game minute, from the replay itself (absent when the trace has no net worth graph). */
  radiant_net_worth_lead?: number[];
}

export interface EvidenceItem { refs: string[]; clock?: string; fact: string }
/** The one rule a finding sends into the next game: a situation the player can see, one action, and how often it came up this game. */
export interface FindingRule { when: string; do: string; /** Why the action is better, by mechanism. */ why?: string; /** The conditions it holds under. */ depends_on?: string; this_game?: string; /** What the next game's replay is counted on for this rule (lib/coach/goals.js habitGoal). */ check?: GoalSpec }
export interface ReviewFinding { title: string; claim: string; evidence: EvidenceItem[]; fix: string; rule?: FindingRule; /** A judgment beyond what the tools state. */ inference?: string; /** What the data cannot show that the finding rests on. */ unknown?: string }
/** One thing to learn from professionals (lib/agent/deepReview.js learnOf). */
export interface LearnEntry { topic: 'hero_choice' | 'items' | 'skills' | 'lane' | 'macro'; advice: string; why: string; applies_when: string; trade_off: string; refs: string[] }
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
  schema: string; match_id: number; hero: string; lang: 'en' | 'zh';
  verdict: string; mainline: string[]; findings: ReviewFinding[]; did_well: string[]; next_game: string[]; blind_spots: string[];
  game_plan?: GamePlan;
  learn_from_pros?: LearnEntry[];
  /** Which patch the review's prices, item effects and cooldowns are from (lib/agent/patchData.js); absent on reviews written before it was kept. */
  data_patch?: { name: string; exact: boolean; known_from?: 'match_data' | 'start_time' | 'match_id'; reason?: string };
  /** One thing the next game can be checked on (lib/agent/goal.js), tied to finding `finding` (1-based). */
  goal?: GoalSpec & { finding: number };
}
export interface ToolStep { tool: string; args: Record<string, unknown>; /** What the lookup is about, named for the reader (the patch advisor sends it). */ about?: string }
export type ReviewState =
  | { status: 'none' | 'no_trace' | 'unknown_hero' }
  | { status: 'running'; steps: ToolStep[] }
  | { status: 'ready'; review: DeepReview; verification: { repaired: boolean; dropped: number }; model: string | null; tool_calls: number }
  | { status: 'failed'; reason?: string }
  | { status: 'unavailable'; reason?: string };

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
  fetch(`/api/agent/${enc(matchId)}/prepare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => json<ParseState>(r));

/** `plan`: the plan the reader named, if any — a review made for it is its own review. */
export const fetchReview = (matchId: string, hero: string, lang: string, signal?: AbortSignal, plan?: string | null) =>
  fetch(`/api/agent/${enc(matchId)}/review?hero=${enc(hero)}&lang=${lang}${plan ? `&plan=${enc(plan)}` : ''}`, { signal }).then((r) => json<ReviewState>(r));

export const startReview = (matchId: string, hero: string, lang: string, plan?: string | null) =>
  fetch(`/api/agent/${enc(matchId)}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hero, lang, ...(plan ? { plan } : {}) }) }).then((r) => json<ReviewState>(r));

const evidenceCache = new Map<string, Promise<EvidenceRecord>>();
/** The tool record behind a ref. Records are pure functions of the replay, so they are cached for the session. */
export function fetchEvidence(matchId: string, hero: string, lang: string, ref: string): Promise<EvidenceRecord> {
  const key = `${matchId}|${hero}|${lang}|${ref}`;
  let p = evidenceCache.get(key);
  if (!p) {
    p = fetch(`/api/agent/${enc(matchId)}/evidence?hero=${enc(hero)}&lang=${lang}&ref=${enc(ref)}`).then((r) => json<EvidenceRecord>(r));
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
export async function askAgent(matchId: string, body: { hero: string; lang: string; question: string; history: ChatTurn[]; plan?: string }, ev: ChatEvents, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`/api/agent/${enc(matchId)}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  return readChatStream(res, ev);
}
