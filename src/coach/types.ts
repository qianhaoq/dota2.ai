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
  action: Bi;
  /** Pre-1.2.0 reports (HTTP-cached for up to 5 min across a deploy). */
  ask?: Bi;
  evidence: Evidence[];
  caveat?: Bi | null;
  window?: [number, number];
  /** Engine >= 1.3.0: a check the next game can pass or fail. */
  goal?: GoalSpec;
}

/** lib/coach/goals.js goalFor() output. */
export type GoalSpec = { label: Bi; role_kind?: 'core' | 'support' } & (
  | { kind: 'deaths_per10_max'; max: number }
  | { kind: 'bench_min'; key: string; min: number }
  | { kind: 'answer_item'; tag: string; items: string[] }
  | { kind: 'obs_per10_min'; min: number }
  | { kind: 'lane_not_lost' }
  /** Engine >= 1.9: deaths to enemies who already owned one of `items` (gap closers). */
  | { kind: 'deaths_to_gap_closer_max'; max: number; items: string[] }
);

export interface Role { pos: number | null; kind: 'core' | 'support'; confidence: string; source: 'lanes' | 'farm' | 'user'; label: Bi; farm_rank?: number }

export interface Review {
  slot: number;
  role: Role;
  won: boolean;
  headline: Bi;
  threats: { tag: string; label: Bi; heroes: number[]; score: number }[];
  /** Engine >= 1.3.0: every threat tag the enemy brought (threats is a shortlist). */
  threat_tags?: string[];
  primary_threat: number | null;
  opponent: number | null;
  /** Engine >= 1.7: your hero against each enemy hero in pro games; nulls when the sample is too small. */
  matchups?: HeroMatchup[];
  /** Engine >= 1.10: the bracket the public-game numbers are read at — your medal, else the match's median medal. */
  bracket?: { key: RankBracket; basis: 'player' | 'match'; known: number; label: Bi } | null;
  /** Engine >= 1.8: finished items pros on your hero buy clearly more often against each enemy hero. */
  counter_items?: { hero: number; items: { item: ItemRef; rate: number; base: number; n: number }[] }[];
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
  /** The killer's latest finished key item at that moment (parsed replays). */
  killer_item?: { item: ItemRef; time: number } | null;
}

export interface Chapters {
  story: {
    phases: {
      key: 'early' | 'mid' | 'late'; label: Bi; from: number; to: number; lead_start: number; lead_end: number; swing: number;
      buildings: [number, number]; roshan: number; fights: [number, number] | null; my_kd: [number | null, number | null];
    }[];
    peak: { min: number; v: number } | null;
    low: { min: number; v: number } | null;
    /** Engine >= 1.3.0: where the gap came from, biggest first (lib/coach/why.js). */
    why?: WhyCause[] | null;
    read: Bi; note: Bi; takeaway: Bi; points: Bi[];
  } | null;
  laning: {
    lane: 'top' | 'mid' | 'bot';
    rows: { slot: number; hero: number; ally: boolean; lh5: number | null; lh10: number | null; dn10: number | null; gold10: number | null; xp10: number | null }[];
    gold: [number, number]; diff: number; outcome: 'stomp' | 'won' | 'draw' | 'lost' | 'stomped'; outcome_label: Bi;
    deaths: number | null; towers: { ours: number | null; theirs: number | null };
    /** The same core matchup in pro games, and where this lane sat against it. */
    baseline?: LaneBaseline | null;
    /** Engine >= 1.10: your hero's lanes against their lane core in public games at your bracket (STRATZ). */
    rank_lane?: { bracket: RankBracket; hero: number; vs: number; n: number; won: number; even: number; lost: number; stomped: number; usual_won: number; usual_lost: number; verdict: MatchupVerdict } | null;
    read: Bi; note: Bi; takeaway: Bi; points: Bi[];
  } | null;
  deaths: {
    rows: DeathRow[];
    summary: { deaths: number; recorded: number; time_dead: number | null; share_dead: number | null; gold_lost: number; top_killer: {
      hero: number; deaths: number;
      /** Deaths to this killer split by their first gap closer (or first key item) in this replay. */
      spike?: { item: ItemRef; time: number; before: number; after: number } | null;
    } | null };
    read: Bi; note: Bi; takeaway: Bi; points: Bi[];
  } | null;
  items: {
    rows: { time: number; item: ItemRef; phase: string; vs: ('physical' | 'magic')[] }[];
    damage: { total: number; types: { physical: number; magic: number; pure: number; other: number } | null; by_hero: { hero: number; amount: number; share: number }[] } | null;
    read: Bi; note: Bi; takeaway: Bi; points: Bi[];
  } | null;
  fights: {
    rows: FightRow[];
    ultimate: { key: string; en: string; zh: string } | null;
    summary: { fights: number; present: number; won: number; lost: number; ult_in: number | null; ult_unused: number; ult_cooldown: number; silent: number };
    read: Bi; note: Bi; takeaway: Bi; points: Bi[];
  } | null;
  plan: { key: string; title: Bi; why: Bi; check: Bi }[];
}

export interface Player {
  slot: number;
  radiant: boolean;
  hero: HeroRef;
  name: string | null;
  account_id?: number | null;
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
  /** Engine >= 1.3.0; null before a parse. */
  obs_placed?: number | null;
  items: ItemRef[];
  benchmarks: Record<string, { raw: number; pct: number }> | null;
}

export interface CoachReport {
  schema: string;
  engine: string;
  match: {
    id: number; duration: number; radiant_win: boolean; score: [number, number]; patch: string | null;
    mode: Bi; ranked: boolean; start_time: number | null; parsed: boolean; replay_available: boolean; turbo: boolean;
    /** 'stratz' / 'steam_gc' when OpenDota was unavailable and the data came from there. */
    source?: 'opendota' | 'stratz' | 'steam_gc';
  };
  players: Player[];
  reviews: Review[];
  timeline: { radiant_gold_adv: number[] } | null;
  /** Per slot: finished key items and Aegis pickups from the replay; null when not parsed. */
  spikes?: (PowerSpikes | null)[] | null;
  /** Where the pro baselines come from (engine >= 1.7). */
  baselines?: {
    source: string; since: string; games: number; fetched: string; item_rule?: { min_games: number; min_lift: number; se: number; top: number };
    /** Engine >= 1.10: public games by rank bracket. Show `attribution` wherever these numbers appear. */
    rank?: { source: string; attribution: { en: string; url: string }; patch: string; weeks: { from: string; to: string; count: number }; fetched: string };
  };
  data_gaps: Bi[];
}

export interface PowerSpikes {
  slot: number;
  items: { time: number; item: ItemRef }[];
  /** Pickups only: the replay does not record when an Aegis was used. */
  aegis: { time: number }[];
}

/* ------------------------------------------------ case studies (/cases) */

export interface CaseCard {
  match_id: number;
  slot: number;
  hero: { id: number; en: string; zh: string; img: string | null; icon: string | null };
  same_hero: boolean;
  who: Bi;
  teams: Bi | null;
  league: string | null;
  won: boolean;
  kda: number[];
  duration: number;
  start_time: number | null;
}

export interface CaseMetric {
  key: string;
  label: Bi;
  mine: Bi | null;
  positive: Bi | null;
  negative: Bi | null;
  better: 'lower' | 'higher';
}

export interface CaseTheme {
  key: 'deaths' | 'fights' | 'laning' | 'items' | 'tempo';
  title: Bi;
  metrics: CaseMetric[];
  positive: CaseCard | null;
  negative: CaseCard | null;
  analysis: Bi[];
  summary: Bi[];
}

export interface CaseStudies {
  key_enemy: number | null;
  damage_type: string | null;
  pool: { total: number; same_hero: number };
  themes: CaseTheme[];
  note: Bi;
}

export interface RecentMatch {
  match_id: number;
  start_time: number | null;
  duration: number | null;
  hero: { id: number; en: string; zh: string; icon: string | null };
  /** Seat 0-9; null when the source does not say (Steam GC history). */
  slot: number | null;
  radiant: boolean | null;
  won: boolean | null;
  /** null when the source has no K/D/A (Steam GC history): never 0/0/0. */
  kda: [number, number, number] | null;
  mode: Bi | null;
  ranked: boolean;
}
/** `source: 'steam_web_api'`: the fallback list while OpenDota is unavailable (no result, K/D/A or duration). */
export interface RecentMatches { account_id: number; matches: RecentMatch[]; empty_hint: string | null; source?: 'opendota' | 'steam_web_api' }

export interface WhyCause {
  id: string;
  phase: 'early' | 'mid' | 'late';
  /** The cause is in your lane or on you; `fix` is then written for your seat. */
  mine: boolean;
  impact: number;
  title: Bi;
  evidence: Bi[];
  fix: Bi | null;
  /** Your lane only: replay positions from before the horn to 10:00, yours and one opponent's ([x, y, samples] on 128-unit cells). */
  heat?: LaneHeat;
  /** Lane causes: the same core matchup in pro games. */
  baseline?: LaneBaseline;
}

export type MatchupVerdict = 'favoured' | 'unfavoured' | 'even';

export type RankBracket = 'hg' | 'ca' | 'la' | 'di';

/** Engine >= 1.10: the same pair in public games at the review's bracket (STRATZ). */
export interface RankMatchup {
  bracket: RankBracket;
  n: number | null; wr: number | null; base: number | null; verdict: MatchupVerdict | null;
  /** usual_*: the hero's own lanes against everyone at that bracket — the verdict is relative to these. */
  lane: { n: number; won: number; even: number; lost: number; stomped: number; usual_won: number; usual_lost: number; verdict: MatchupVerdict } | null;
}

export interface HeroMatchup {
  hero: number; n: number | null; wr: number | null; base: number | null; verdict: MatchupVerdict | null;
  rank?: RankMatchup | null;
}

export interface LaneBaseline {
  hero: number; vs: number; n: number; mean: number; p25: number; p75: number; ahead: number;
  verdict: MatchupVerdict; actual: number; standing: 'worse' | 'typical' | 'better';
}

export interface LaneHeat {
  radiant: boolean;
  me: { hero: HeroRef; cells: [number, number, number][] };
  opp: { hero: HeroRef; cells: [number, number, number][] };
}
