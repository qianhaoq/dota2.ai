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
  deaths: { time: number; killer: number | null; in_fight: boolean | null; converted: boolean | null }[] | null;
  item_timeline: { time: number; item: ItemRef }[] | null;
  chapters?: Chapters | null;
}

export type FightResult = 'won' | 'lost' | 'even';

export interface FightRow {
  start: number; end: number; result: FightResult; gold_edge: number; kills: [number, number];
  present: boolean; damage: number; died: boolean; ult_used: boolean | null; ult_casts: number | null;
  ult_state: 'used' | 'cooldown' | 'unused' | null;
}

export interface DeathRow {
  time: number; killer: number | null; phase: 'early' | 'mid' | 'late';
  context: 'lane' | 'caught' | 'fight_won' | 'fight_lost' | 'fight_even' | 'fight' | 'unknown';
  gold_lost: number | null; time_dead: number | null; converted: boolean | null;
}

export interface Chapters {
  story: {
    phases: {
      key: 'early' | 'mid' | 'late'; label: Bi; from: number; to: number; lead_start: number; lead_end: number; swing: number;
      buildings: [number, number]; roshan: number; fights: [number, number] | null; my_kd: [number, number];
    }[];
    peak: { min: number; v: number } | null;
    low: { min: number; v: number } | null;
    read: Bi; note: Bi;
  } | null;
  laning: {
    lane: 'top' | 'mid' | 'bot';
    rows: { slot: number; hero: number; ally: boolean; lh5: number | null; lh10: number | null; dn10: number | null; gold10: number | null; xp10: number | null }[];
    gold: [number, number]; diff: number; outcome: 'stomp' | 'won' | 'draw' | 'lost' | 'stomped'; outcome_label: Bi;
    deaths: number | null; towers: { ours: number | null; theirs: number | null };
    read: Bi; note: Bi;
  } | null;
  deaths: {
    rows: DeathRow[];
    summary: { deaths: number; recorded: number; time_dead: number; share_dead: number | null; gold_lost: number; top_killer: { hero: number; deaths: number } | null };
    read: Bi; note: Bi;
  } | null;
  items: {
    rows: { time: number; item: ItemRef; phase: string; vs: ('physical' | 'magic')[] }[];
    damage: { total: number; types: { physical: number; magic: number; pure: number; other: number } | null; by_hero: { hero: number; amount: number; share: number }[] } | null;
    read: Bi; note: Bi;
  } | null;
  fights: {
    rows: FightRow[];
    ultimate: { key: string; en: string; zh: string } | null;
    summary: { fights: number; present: number; won: number; lost: number; ult_in: number | null; ult_unused: number; ult_cooldown: number; silent: number };
    read: Bi; note: Bi;
  } | null;
  plan: { key: string; title: Bi; why: Bi; check: Bi }[];
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
