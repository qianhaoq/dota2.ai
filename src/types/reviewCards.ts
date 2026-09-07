/** 复盘主失误分类 */
export type MistakeCategory =
  | 'fight_timing'
  | 'farm_route';

export type ReviewPhase = 'lane' | 'mid' | 'late';

/** MatchFact 字段引用，用于证据链 */
export interface ReviewEvidence {
  factKey: string;
  label: string;
  value: string;
}

export interface MatchSummaryCard {
  matchId: number;
  heroId?: number;
  durationFormatted: string;
  heroName: string;
  kda: string;
  gpm: number;
  result: 'win' | 'loss';
  resultLabel: string;
  laneLabel?: string;
  laneGrounded?: boolean;
}

export interface PhaseSpineCard {
  phase: ReviewPhase;
  label: string;
  insight: string;
  evidence: ReviewEvidence[];
}

export interface PrimaryMistakeCard {
  category: MistakeCategory;
  categoryLabel: string;
  headline: string;
  explanation: string;
  evidence: ReviewEvidence[];
}

export interface KeyMomentCard {
  timestamp: number;
  timestampLabel: string;
  phase: ReviewPhase;
  headline: string;
  why: string;
  evidence: ReviewEvidence[];
}

export interface ReviewDrillCard {
  duration: string;
  title: string;
  steps: string[];
}

/** 结构化复盘卡片载荷 — Fact → Insight → Drill */
export interface ReviewCardsPayload {
  match_summary?: MatchSummaryCard;
  phases?: PhaseSpineCard[];
  primary_mistake?: PrimaryMistakeCard;
  key_moments?: KeyMomentCard[];
  drill?: ReviewDrillCard;
  followups?: string[];
  mentor_note?: string;
}
