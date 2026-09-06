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

export interface MatchPlayerFact {
  heroId: number;
  playerSlot: number;
  isRadiant: boolean;
  nameZh: string;
  nameEn: string;
  displayName: string;
  kills: number;
  deaths: number;
  assists: number;
  gpm: number;
  xpm: number;
  netWorth: number;
  heroDamage: number;
  towerDamage: number;
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
  killsLog: Array<{ time: number; target: string }>;
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
  economy: {
    radiantGoldAdv: number[];
    checkpoints: Array<{ minute: number; radiantGoldLead: number }>;
  };
  timeline: Array<{ time: number; type: string; key: string | null; team?: number }>;
  focusHeroId: number | null;
  focusLens: {
    heroId: number;
    displayName: string;
    kda: string;
    gpm: number;
    netWorth: number;
    lane: string;
    laneLabel: string;
    opponents: Array<{ heroId: number; displayName: string; kda: string }>;
    nearby: Array<{ heroId: number; displayName: string }>;
    earlyKills: Array<{ time: number; target: string }>;
    keyTimeline: Array<{ time: number; type: string; key: string | null }>;
    laneSource: string;
    laneConfidence: LaneConfidence;
  } | null;
  grounded: boolean;
}
