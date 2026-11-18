/** Client mirror of `dota2.ai/coach-report@1` (lib/coach/analyze.js). */
export interface Bi { en: string; zh: string }

export interface HeroRef { id: number; en: string; zh: string; slug: string; img: string | null; icon: string | null; roles: string[] }
export interface ItemRef { key: string; en: string; zh: string; cost: number; img: string | null }

export interface Evidence { k: Bi; v?: string; sub?: Bi; items?: string[]; heroes?: number[] }

export interface Finding {
  id: string;
  area: 'items' | 'farm' | 'deaths' | 'fights' | 'objectives' | 'team' | 'laning' | 'vision';
  tone: 'fix' | 'good';
  severity: 1 | 2 | 3;
  confidence: 'high' | 'medium' | 'low';
  tier: 'basic' | 'parsed';
  shared?: boolean;
  title: Bi;
  body: Bi;
  ask: Bi;
  evidence: Evidence[];
  caveat?: Bi | null;
  window?: [number, number];
}

export interface Role { pos: number | null; kind: 'core' | 'support'; confidence: string; source: 'lanes' | 'farm' | 'user'; label: Bi; farm_rank?: number }

export interface Review {
  slot: number;
  role: Role;
  won: boolean;
  headline: Bi;
  threats: { tag: string; label: Bi; heroes: number[]; score: number }[];
  primary_threat: number | null;
  opponent: number | null;
  findings: Finding[];
  deaths: { time: number; killer: number | null; in_fight: boolean; converted: boolean }[] | null;
  item_timeline: { time: number; item: ItemRef }[] | null;
}

export interface Player {
  slot: number;
  radiant: boolean;
  hero: HeroRef;
  name: string | null;
  rank_tier: number | null;
  kda: [number, number, number];
  last_hits: number;
  denies: number;
  gpm: number;
  xpm: number;
  net_worth: number;
  hero_damage: number;
  tower_damage: number;
  level: number | null;
  items: ItemRef[];
  benchmarks: Record<string, { raw: number; pct: number }> | null;
}

export interface CoachReport {
  schema: string;
  engine: string;
  match: {
    id: number; duration: number; radiant_win: boolean; score: [number, number]; patch: string | null;
    mode: Bi; ranked: boolean; start_time: number | null; parsed: boolean; replay_available: boolean; turbo: boolean;
  };
  players: Player[];
  reviews: Review[];
  timeline: { radiant_gold_adv: number[] } | null;
  data_gaps: Bi[];
}
