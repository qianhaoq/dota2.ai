import type { DictKey } from '../i18n/en';
import type { Insight, Objective, Review } from '../review/types';
import { itemDisplayName } from './itemNames';

/**
 * Pure helpers for the evidence sheet/panel. Hard rule (tech-plan §13 PR7):
 * every visible metric string comes from an engine `fact.display`; the helpers
 * below only *select* displays and compute geometry/structure from raw arrays.
 */

/** mm:ss — allowed only for axis/row labels derived from raw `t` seconds. */
export const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

export type Translate = (key: DictKey) => string;

/** Fill `{name}` placeholders in an i18n template. */
export const fill = (template: string, vars: Record<string, string>) =>
  Object.entries(vars).reduce((out, [key, value]) => out.replaceAll(`{${key}}`, value), template);

/** Insight time chip from fact `display.t` anchors only (same rule as InsightCard). */
export function insightTimeChip(review: Review | undefined, insight: Insight): string {
  const anchor = (at: number | undefined) =>
    Object.values(review?.facts ?? {}).find(f => f.t === at && f.display.t)?.display.t;
  const from = anchor(insight.time?.from);
  const to = anchor(insight.time?.to);
  if (from) return to && from !== to ? `${from}–${to}` : from;
  return insight.fact_ids.map(id => review?.facts[id]).find(f => f?.display.t)?.display.t ?? '';
}

export interface Moment {
  t: number;
  kind: 'rosh' | 'up' | 'down' | 'note';
  label: string;
  /** Display time from a fact when one exists, else derived mm:ss (label only). */
  time: string;
  hl: boolean;
}

const BIG_STRUCTURE = /tower[34]|range_rax|melee_rax|fort/;

/**
 * Key moments for claim 0: Roshan kills, big building kills (T3+/rax/fort)
 * from `objectives`, plus the gold-low point as a fact-display note.
 */
export function buildMoments(review: Review, insight: Insight, lang: 'en' | 'zh', t: Translate): Moment[] {
  // Preserve unknown team — never default to Radiant for polarity.
  const playerTeam = review.player?.team ?? null;
  const sideName = (side: string) => t(side === 'radiant' ? 'sideRadiant' : 'sideDire');
  const laneName = (lane: string) => {
    if (lane === 'mid') return t('laneMid');
    if (lane === 'top') return t('laneTop');
    if (lane === 'bot') return t('laneBot');
    return '';
  };
  const moments: Moment[] = [];
  for (const objective of review.objectives ?? []) {
    if (objective.type === 'CHAT_MESSAGE_ROSHAN_KILL') {
      const label = objective.team
        ? fill(t('momRoshan'), { team: sideName(objective.team) })
        : t('momRoshanUnknown');
      moments.push({
        t: objective.t,
        kind: 'rosh',
        label,
        time: factTime(review, objective),
        hl: false,
      });
      continue;
    }
    if (objective.type !== 'building_kill' || !objective.key || !BIG_STRUCTURE.test(objective.key)) continue;
    // The owner is encoded in the key (goodguys = Radiant's structure).
    const owner = objective.key.includes('goodguys') ? 'radiant' : 'dire';
    const lane = /_(mid|top|bot)$/.exec(objective.key)?.[1] ?? '';
    const tier = /tower(\d)/.exec(objective.key)?.[1] ?? '';
    let label: string;
    if (objective.key.includes('fort')) {
      label = fill(t('momAncient'), { team: sideName(owner) });
    } else if (objective.key.includes('melee_rax')) {
      label = fill(t('momRaxMelee'), { team: sideName(owner), lane: laneName(lane) });
    } else if (objective.key.includes('range_rax')) {
      label = fill(t('momRaxRanged'), { team: sideName(owner), lane: laneName(lane) });
    } else if (tier === '4' && !lane) {
      // T4 base towers have no _mid/_top/_bot suffix — do not invent bottom.
      label = fill(t('momTowerBase'), { team: sideName(owner), tier });
    } else {
      label = fill(t('momTower'), { team: sideName(owner), lane: laneName(lane), tier });
    }
    // Unknown player team → neutral polarity (note), not Radiant red/green.
    const kind = !playerTeam ? 'note' : owner === playerTeam ? 'down' : 'up';
    moments.push({ t: objective.t, kind, label, time: factTime(review, objective), hl: false });
  }
  const low = review.facts['gold.low'];
  if (low) {
    moments.push({
      t: low.t ?? 0,
      kind: 'note',
      label: `${t('momGoldLow')}: ${low.display[lang]}`,
      time: low.display.t ?? '',
      hl: false,
    });
  }
  const from = insight.time?.from, to = insight.time?.to;
  return moments
    .sort((a, b) => a.t - b.t)
    .map(m => ({ ...m, hl: from != null && to != null && m.t >= from && m.t <= to }));
}

/** Objective facts (`obj.<t>.<i>`) carry display.t in newer engines; fall back to a derived label. */
function factTime(review: Review, objective: Objective): string {
  const display = review.facts[objective.fact_id]?.display.t;
  return display ?? mmss(objective.t);
}

export interface KillerRow {
  slug: string;
  /** Visible count — engine display only; null when the fact is absent. */
  count: string | null;
  /** Derived from raw deaths for bar geometry only (never rendered). */
  share: number;
}

/**
 * Killer bar rows: order/geometry from the raw deaths array, visible counts
 * strictly from `killed_by.<slug>` fact displays.
 */
export function killerRows(review: Review, lang: 'en' | 'zh'): KillerRow[] {
  const counts = new Map<string, number>();
  const playerTeam = review.player?.team;
  const alliedHeroes = new Set(review.roster.filter(h => h.team && h.team === playerTeam).map(h => h.hero));
  for (const death of review.deaths ?? []) {
    if (death.killer && !alliedHeroes.has(death.killer)) counts.set(death.killer, (counts.get(death.killer) ?? 0) + 1);
  }
  const max = Math.max(1, ...counts.values());
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([slug, count]) => ({
      slug,
      count: review.facts[`killed_by.${slug}`]?.display[lang] ?? null,
      share: count / max,
    }));
}

const CONSUMABLE = /^(ward_|tango|branches|blood_grenade|clarity|flask|enchanted_mango|faerie_fire|tpscroll|smoke_of_deceit|dust$|magic_stick$)/;

/** @deprecated Prefer itemDisplayName(slug, lang). Kept as English humanize fallback. */
export const itemName = (slug: string, lang: 'en' | 'zh' = 'en') => itemDisplayName(slug, lang);

/** Item grid rows: real purchases minus consumables/wards and pre-horn buys. */
export function itemRows(review: Review): { item: string; time: string; key: boolean }[] {
  return (review.purchases ?? [])
    .filter(p => p.t >= 0 && !CONSUMABLE.test(p.item))
    .map(p => ({ item: p.item, time: mmss(p.t), key: p.key_item }));
}

export interface SourceRow {
  field: string;
  caption: DictKey;
}

/**
 * Extract OpenDota field tokens from an engine `source_path`
 * (e.g. `players[6].kills_log[0]` → `kills_log`).
 */
export function fieldsFromSourcePath(sourcePath: string | undefined | null): string[] {
  if (!sourcePath) return [];
  const fields: string[] = [];
  for (const part of sourcePath.split(/[;\s]+/).filter(Boolean)) {
    if (/\bkills_log\b/.test(part)) fields.push('kills_log');
    else if (/\bdeaths_log\b/.test(part)) fields.push('deaths_log');
    else if (/\bkilled_by\b/.test(part)) fields.push('killed_by');
    else if (/\bradiant_gold_adv\b/.test(part)) fields.push('radiant_gold_adv');
    else if (/\bradiant_xp_adv\b/.test(part)) fields.push('radiant_xp_adv');
    else if (/\bpurchase_log\b/.test(part)) fields.push('purchase_log');
    else if (/\blh_t\b/.test(part)) fields.push('lh_t');
    else if (/\bobjectives\b/.test(part)) fields.push('objectives');
  }
  return fields;
}

/** Per-claim source list — only fields that actually back the rendered data. */
export function sourcesFor(review: Review, claim: number): SourceRow[] {
  const rows: SourceRow[] = [];
  const captions: Record<string, DictKey> = {
    radiant_gold_adv: 'srcPerMinute',
    radiant_xp_adv: 'srcPerMinute',
    objectives: 'srcObjectives',
    deaths_log: 'srcDeathsLog',
    kills_log: 'srcKillsLog',
    killed_by: 'srcKilledBy',
    lh_t: 'srcLhTimeline',
    purchase_log: 'srcPurchaseLog',
  };
  const seen = new Set<string>();
  const add = (field: string, caption = captions[field]) => {
    if (seen.has(field)) return;
    seen.add(field);
    rows.push({ field, caption });
  };
  const consider = (sourcePath?: string | null) => {
    for (const field of fieldsFromSourcePath(sourcePath)) add(field);
  };
  for (const id of review.insights[claim]?.fact_ids ?? []) {
    consider(review.facts[id]?.source_path);
  }

  if (claim === 0) {
    if (review.series.radiant_gold_adv.length) add('radiant_gold_adv');
    if (review.series.radiant_xp_adv.length) add('radiant_xp_adv');
    if (review.objectives?.length) add('objectives');
  } else if (claim === 1) {
    // Death rows may be rebuilt from opponents' kills_log.
    for (const death of review.deaths ?? []) {
      consider(death.fact_id ? review.facts[death.fact_id]?.source_path : null);
    }
    consider(review.facts['deaths.total']?.source_path);
    consider(review.facts['killed_by']?.source_path);
    // Gold provenance alone does not explain where the death rows came from.
    if (review.deaths?.length && !['deaths_log', 'kills_log', 'killed_by'].some(field => seen.has(field))) {
      add('deaths', 'srcDeathsLog');
    }
  } else if (review.purchases?.length) {
    add('purchase_log');
  }
  return rows;
}

export interface ChartLabelBox {
  key: string;
  /** Horizontal center of the rendered text (after anchoring), in px. */
  cx: number;
  /** Baseline y of the rendered text, in px. */
  y: number;
  width: number;
}

const LABEL_HEIGHT = 12;

/**
 * Low-point label collision avoidance (handoff §6): the global-low label is
 * end-anchored at the point; any other marker whose box overlaps a previous
 * one is nudged downward until clear.
 */
export function dodgeLabels<T extends ChartLabelBox>(labels: T[]): T[] {
  const placed = labels.map(l => ({ ...l }));
  const overlaps = (a: ChartLabelBox, b: ChartLabelBox) =>
    Math.abs(a.cx - b.cx) * 2 < a.width + b.width + 4 && Math.abs(a.y - b.y) < LABEL_HEIGHT;
  for (let i = 1; i < placed.length; i++) {
    let guard = 0;
    while (guard++ < 4 && placed.slice(0, i).some(other => overlaps(other, placed[i]))) {
      placed[i] = { ...placed[i], y: placed[i].y + LABEL_HEIGHT + 2 };
    }
  }
  return placed;
}

/** Gap topics registered in review.data_gaps. */
export const gapRegistered = (review: Review, topic: string) =>
  (review.data_gaps ?? []).some(g => g.topic === topic);

export const gapReason = (review: Review, topic: string) =>
  (review.data_gaps ?? []).find(g => g.topic === topic)?.reason;

/**
 * Orient radiant_* series to the selected player's perspective.
 * Engine keeps arrays in Radiant perspective; facts like gold.low are already flipped.
 */
export function seriesForPlayer(series: Review['series']): {
  gold: (number | null)[];
  xp: (number | null)[];
} {
  const flip = series.perspective === 'dire' ? -1 : 1;
  const map = (arr: (number | null)[] | undefined) =>
    (arr ?? []).map(v => (v == null || !Number.isFinite(v) ? null : (v as number) * flip));
  return {
    gold: map(series.radiant_gold_adv as (number | null)[]),
    xp: map(series.radiant_xp_adv as (number | null)[]),
  };
}

/**
 * Build an SVG path that breaks (moves) across non-finite / null samples
 * instead of coercing them to zero.
 */
export function seriesPath(
  arr: (number | null | undefined)[],
  X: (i: number) => number,
  Y: (v: number) => number,
): string {
  const parts: string[] = [];
  let drawing = false;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v == null || !Number.isFinite(v)) {
      drawing = false;
      continue;
    }
    parts.push(`${drawing ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`);
    drawing = true;
  }
  return parts.join(' ');
}
