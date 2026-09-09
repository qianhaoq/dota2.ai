/**
 * Internal Dota coaching-domain contract (A2UI-inspired).
 *
 * `dota-coach-ui/1` is an internal domain model, NOT the official A2UI wire
 * protocol. Component model, framework implementation and the existing SSE
 * transport stay isolated; a formal protocol adapter is a separate deliverable.
 * See docs/design/tactical-coach-v3/docs/A2UI.md.
 */

/** How a statement is backed. Facts are never synthesized from user memory. */
export type Authority = 'fact' | 'inference' | 'user_report' | 'hypothesis' | 'demo';

export type CoachSurfaceComponent =
  | 'CoachBrief'
  | 'TacticalMap'
  | 'DraftBoard'
  | 'ItemTradeoff'
  | 'DecisionFork'
  | 'TrainingDrill'
  | 'EvidenceLens'
  | 'KnowledgeLens'
  | 'PracticeCommit';

/** demo = teaching scene; diagram = relation/lane sketch; nonspatial = timeline. */
export type CoachSurfacePresentation = 'demo' | 'diagram' | 'nonspatial';

/** A trusted-catalog surface. Extra/unknown props are rejected by the runtime. */
export interface CoachSurface {
  id: string;
  component: CoachSurfaceComponent;
  revision: number;
  presentation: CoachSurfacePresentation;
  title: string;
}

export interface CoachPatch {
  contextId: string;
  contextRevision: number;
  runId: number;
  surface: CoachSurface;
}

export type CoachAnswerValue = 'seen' | 'unseen' | 'unknown';

/** Player-supplied memory. Applied as `user_report`, never upgraded to fact. */
export interface CoachAnswerEvent {
  id: string;
  action: 'answer';
  contextId: string;
  contextRevision: number;
  value: CoachAnswerValue;
}

/** Saved action (not a whole report): trigger + behavior + check method. */
export interface JournalNote {
  key: string;
  title: string;
  trigger: string;
  action: string;
  check: string;
  contextId: string;
  authority: Authority;
  done: boolean;
}

export interface CoachRuntimeState {
  contextId: string;
  contextRevision: number;
  runId: number;
  busy: boolean;
  surfaces: Record<string, CoachSurface>;
  seenEventIds: string[];
  answers: {
    visibility?: { value: CoachAnswerValue; authority: 'user_report' };
  };
  notes: JournalNote[];
}

/** Coaching-session context (production design target, see A2UI.md). */
export interface CoachContext {
  sessionId: string;
  contextId: string;
  contextRevision: number;
  mode: 'review' | 'draft' | 'practice';
  subject: { matchId?: number; playerSlot?: number; heroId?: number };
  source: 'live_facts' | 'teaching_demo';
}

/** Fixed 5+5 draft slots; a slot number is an entry position, not a position role. */
export interface DraftSlots {
  radiant: Array<number | null>;
  dire: Array<number | null>;
}

/**
 * What the current MatchFact layer can honestly support. Existing facts carry
 * stats, lane inference, economy and objective events — no time-indexed
 * coordinates or vision, so spatial capabilities stay false.
 */
export interface ReviewCapabilities {
  roster: boolean;
  timeline: boolean;
  tacticalMap: boolean;
  vision: boolean;
  replayPlayback: boolean;
}
