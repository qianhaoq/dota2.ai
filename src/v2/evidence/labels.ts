import type { DictKey } from '../i18n/en';
import type { Insight, Objective, Review } from '../review/types';

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
  const playerTeam = review.player?.team ?? 'radiant';
  const sideName = (side: string) => t(side === 'radiant' ? 'sideRadiant' : 'sideDire');
  const laneName = (lane: string) => t(lane === 'mid' ? 'laneMid' : lane === 'top' ? 'laneTop' : 'laneBot');
  const moments: Moment[] = [];
  for (const objective of review.objectives ?? []) {
    if (objective.type === 'CHAT_MESSAGE_ROSHAN_KILL') {
      moments.push({
        t: objective.t,
        kind: 'rosh',
        label: fill(t('momRoshan'), { team: sideName(objective.team ?? 'dire') }),
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
    const label = objective.key.includes('fort')
      ? fill(t('momAncient'), { team: sideName(owner) })
      : objective.key.includes('melee_rax')
        ? fill(t('momRaxMelee'), { team: sideName(owner), lane: laneName(lane) })
        : objective.key.includes('range_rax')
          ? fill(t('momRaxRanged'), { team: sideName(owner), lane: laneName(lane) })
          : fill(t('momTower'), { team: sideName(owner), lane: laneName(lane), tier });
    moments.push({ t: objective.t, kind: owner === playerTeam ? 'down' : 'up', label, time: factTime(review, objective), hl: false });
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
  for (const death of review.deaths ?? []) {
    if (death.killer) counts.set(death.killer, (counts.get(death.killer) ?? 0) + 1);
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

/** Humanize an item slug for display (`blade_mail` → `Blade mail`). Not a metric. */
export const itemName = (slug: string) => {
  const words = slug.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

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

/** Per-claim source list — only fields that actually back the rendered data. */
export function sourcesFor(review: Review, claim: number): SourceRow[] {
  const rows: SourceRow[] = [];
  if (claim === 0) {
    if (review.series.radiant_gold_adv.length) rows.push({ field: 'radiant_gold_adv', caption: 'srcPerMinute' });
    if (review.series.radiant_xp_adv.length) rows.push({ field: 'radiant_xp_adv', caption: 'srcPerMinute' });
    if (review.objectives?.length) rows.push({ field: 'objectives', caption: 'srcObjectives' });
  } else if (claim === 1) {
    if (review.deaths?.length) rows.push({ field: 'deaths_log', caption: 'srcDeathsLog' });
    if (review.facts['killed_by']) rows.push({ field: 'killed_by', caption: 'srcKilledBy' });
  } else {
    if (review.facts['lh_at_10']) rows.push({ field: 'lh_t', caption: 'srcLhTimeline' });
    if (review.purchases?.length) rows.push({ field: 'purchase_log', caption: 'srcPurchaseLog' });
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
