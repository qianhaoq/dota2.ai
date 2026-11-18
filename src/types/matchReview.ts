import type { ReplayFailureStatus } from '../../lib/matchReview/replayIngest/types';

export type LaneConfidence = 'high' | 'medium' | 'low';

export interface LaneHeroRef {
  heroId: number;
  confidence: LaneConfidence;
  source: string;
}

export interface ResolvedLanePlayer {
  heroId: number;
  playerSlot: number;
  isRadiant: boolean;
  laneLabel: string;
  clusterId: number;
  allies: LaneHeroRef[];
  opponents: LaneHeroRef[];
  nearby: LaneHeroRef[];
  source: string;
  confidence: LaneConfidence;
  confidenceScore: number;
}

export interface MatchLaneGroup {
  clusterId: number;
  laneLabel: string;
  laneLabelZh: string;
  laneLabelEn: string;
  radiantHeroIds: number[];
  direHeroIds: number[];
  radiantNames: string[];
  direNames: string[];
  source: string;
  confidence: LaneConfidence;
}

/** A death of a hero, derived by inverting every player's kills_log. */
export interface DeathTimelineEvent {
  time: number;
  minute: number;
  killerHeroId: number | null;
  killerIsRadiant: boolean | null;
  /** Gold lead of the victim's team at that minute (null when radiant_gold_adv is unavailable). */
  teamGoldLeadAtT: number | null;
}

/** Advantage reversal summary from radiant_gold_adv (null when the array is too short). */
export interface AdvantageSwing {
  loserSide: 'radiant' | 'dire';
  loserPeakLead: number;
  loserPeakMinute: number;
  /**
   * First minute after the peak where the winner's lead also reached
   * LEAD_FLIP_THRESHOLD (~1000 gold) — both sides must hold a real lead for a
   * flip to count. Null when either side never did.
   */
  crossoverMinute: number | null;
  comeback: boolean;
  /**
   * Which advantage series produced the swing: earned gold when present,
   * otherwise the replay's 60 s net-worth buckets (never presented as gold).
   */
  basis: 'radiant_gold_adv' | 'radiant_net_worth_adv';
  /** Present only on the net-worth basis: bucket semantics caveat. */
  bucket_note?: string;
}

export interface MatchPlayerFact {
  heroId: number;
  playerSlot: number;
  isRadiant: boolean;
  nameZh: string;
  nameEn: string;
  /** URL-friendly hero slug (e.g. "faceless_void"); used by the v2 ?hero= param. */
  internalSlug?: string;
  displayName: string;
  /** Player's display name (personaname) when OpenDota provides one. */
  personName: string | null;
  kills: number;
  deaths: number;
  assists: number;
  gpm: number;
  xpm: number;
  netWorth: number;
  heroDamage: number;
  towerDamage: number;
  /** Last hits / hero level when replay-parse data provides them. */
  lastHits: number | null;
  level: number | null;
  lane: string;
  laneLabelZh: string;
  laneLabelEn: string;
  allies: LaneHeroRef[];
  opponents: LaneHeroRef[];
  nearby: LaneHeroRef[];
  laneSource: string;
  laneConfidence: LaneConfidence;
  laneConfidenceScore: number;
  goldTimeline: number[];
  lhTimeline: number[];
  xpTimeline: number[];
  timeBuckets: number[];
  /** Enemy kills from parsed kills_log; same-team entries (denies/self-kills) are dropped when built. */
  killsLog: Array<{ time: number; target: string }>;
  /** Deaths derived by inverting kills_log; [] when the replay is not parsed. */
  deathEvents: DeathTimelineEvent[];
  /** Derived death count vs the reported scoreboard deaths (see deathTimeline coverage). */
  deathsDerivedCount: number;
}

/** One fact-derived evidence line backing a conclusion. */
export interface ConclusionEvidence {
  /** Localized timestamp label (e.g. "18:32"), null when not time-bound. */
  time: string | null;
  text: string;
  source: string;
}

export type ReviewConclusionStatus = 'ok' | 'insufficient';

export interface ReviewConclusion {
  status: ReviewConclusionStatus;
  /** Backend title — the review surface renders its own product labels instead. */
  title: string;
  summary: string;
  evidence: ConclusionEvidence[];
}

/**
 * Fact-derived three-conclusion payload attached to GET/POST /api/review/:id
 * responses as a sibling of matchFact (absent on older payloads — fall back
 * to the classic card layout then).
 */
export interface ThreeConclusions {
  /** Focus side outcome derived from facts; null when unknown. */
  outcome?: 'win' | 'loss' | null;
  turningPoint: ReviewConclusion;
  topMistake: ReviewConclusion;
  nextGameRule: ReviewConclusion;
  /** 2–3 fact-tailored preset follow-up questions (localized server-side). */
  followUps: string[];
}

export type FieldEmptyReason =
  | 'not_parsed_yet'
  | 'no_data'
  | 'incomplete_hero_map'
  /** Replay trace has no earned-gold series; the shown buckets are net worth. */
  | 'earned_gold_not_in_replay'
  /** Replay path expected net-worth buckets but none survived verification. */
  | 'net_worth_missing'
  /** Net-worth buckets exist but stop before game end. */
  | 'metadata_graph_truncated';

export interface FieldReason {
  reason: FieldEmptyReason;
  message: string;
}

/**
 * OpenDota replay parse status returned by /api/review (GET facts + POST
 * stream) and POST /api/review/:matchId/parse-request. 'unparsed' means the
 * server never auto-submits a parse (facts load is read-only) — the user can
 * request one via requestMatchParse.
 */
export interface ReviewParseStatus {
  /** Current server capability; absent on older payloads means unavailable. */
  ingest_available?: boolean;
  status: 'requested' | 'pending' | 'parsed' | 'unparsed' | 'failed' | 'throttled' | ReplayFailureStatus | 'replay_ingest_disabled' | 'replay_pending' | 'replay_parsed';
  jobId: number | null;
  retryAfterSec: number | null;
  message: string;
}

export interface MatchFact {
  summary: {
    matchId: number;
    duration: number;
    durationFormatted: string;
    radiantWin: boolean;
    winner: 'radiant' | 'dire';
    winnerLabelZh: string;
    winnerLabelEn: string;
    gameMode?: number;
    startTime?: number;
  };
  players: MatchPlayerFact[];
  lanes: MatchLaneGroup[];
  laneInferenceLabelZh: string;
  laneInferenceLabelEn: string;
  laneSource: string;
  laneDataAvailable: boolean;
  economy: {
    radiantGoldAdv: number[];
    /** Replay-derived 60 s net-worth buckets; separate series, never earned gold. */
    radiantNetWorthAdv: number[];
    netWorthSource: string | null;
    netWorthDerivation: string | null;
    netWorthTruncated: boolean;
    /** Leads may be null when one of the two series lacks that minute. */
    checkpoints: Array<{ minute: number; radiantGoldLead: number | null; radiantNetWorthLead: number | null }>;
  };
  timeline: Array<{
    time: number;
    type: string;
    key: string | null;
    team?: number;
    carrierName?: string | null;
    aegisStolen?: boolean;
  }>;
  /**
   * True when the death timeline is usable: kills_log data exists, or the match
   * is parsed with 0 hero kills (an available-but-empty timeline, 0 deaths).
   */
  deathTimelineAvailable: boolean;
  advantageSwing: AdvantageSwing | null;
  focusHeroId: number | null;
  focusLens: {
    heroId: number;
    displayName: string;
    kda: string;
    gpm: number;
    netWorth: number;
    lane: string;
    laneLabel: string;
    laneGrounded: boolean;
    opponents: Array<{ heroId: number; displayName: string; kda: string }>;
    nearby: Array<{ heroId: number; displayName: string }>;
    earlyKills: Array<{ time: number; target: string }>;
    deathEvents: DeathTimelineEvent[];
    keyTimeline: Array<{ time: number; type: string; key: string | null }>;
    laneSource: string;
    laneConfidence: LaneConfidence;
  } | null;
  focusLaneGrounded: boolean;
  grounded: boolean;
  /** True when OpenDota replay data (lanes/timeline/economy) is available. */
  parsed?: boolean;
  /** Reasons for empty fields (lanes/timeline/economy/focusLane/deaths/earnedGold/netWorth), localized per lang. */
  fieldReasons?: Partial<Record<'lanes' | 'timeline' | 'economy' | 'focusLane' | 'deaths' | 'earnedGold' | 'netWorth', FieldReason>>;
}
