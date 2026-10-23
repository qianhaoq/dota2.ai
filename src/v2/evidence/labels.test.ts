import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildReview } from '../../../packages/review-engine/src/index.js';
import { en } from '../i18n/en';
import {
  buildMoments,
  dodgeLabels,
  fieldsFromSourcePath,
  insightTimeChip,
  itemName,
  itemRows,
  killerRows,
  mmss,
  seriesForPlayer,
  seriesPath,
  sourcesFor,
} from './labels';
import type { Review } from '../review/types';

const raw = JSON.parse(readFileSync('src/fixtures/match9035042364.parsed.json', 'utf8'));
const review = buildReview(raw, { heroId: 14, lang: 'en', fetchedAt: '2026-10-17T00:00:00Z' }) as unknown as Review;
const t = (key: keyof typeof en) => en[key];

describe('evidence labels', () => {
  it('mmss formats axis/row labels from raw seconds', () => {
    expect(mmss(191)).toBe('3:11');
    expect(mmss(3715)).toBe('61:55');
  });

  it('insightTimeChip anchors to fact display.t, never derived numbers', () => {
    expect(insightTimeChip(review, review.insights[0])).toBe('40:00–45:00');
    expect(insightTimeChip(review, review.insights[1])).toBe('3:11–50:46');
    expect(insightTimeChip({ ...review, facts: {} }, review.insights[0])).toBe('');
  });

  it('buildMoments maps Roshan/buildings/gold-low and highlights the insight window', () => {
    const moments = buildMoments(review, review.insights[0], 'en', t);
    expect(moments.some(m => m.kind === 'rosh' && m.label === 'Dire took Roshan')).toBe(true);
    expect(moments.some(m => m.kind === 'rosh' && m.label === 'Radiant took Roshan')).toBe(true);
    expect(moments.some(m => m.label === 'Radiant mid T3 tower destroyed')).toBe(true);
    expect(moments.some(m => m.label === 'Radiant mid ranged barracks destroyed')).toBe(true);
    expect(moments.some(m => m.label === 'Radiant Ancient destroyed')).toBe(true);
    // Low-point label is the engine display, never a hardcoded −28,965.
    const low = review.facts['gold.low'];
    expect(moments.some(m => m.kind === 'note' && m.label === `Gold gap at its lowest: ${low.display.en}` && m.time === '46:00')).toBe(true);
    // Tier-1/2 towers are curated out.
    expect(moments.some(m => m.label.includes('T1'))).toBe(false);
    expect(moments.some(m => m.label.includes('T2'))).toBe(false);
    // Highlight = inside the 40:00–45:00 insight window (mid T3 + ranged rax).
    const highlighted = moments.filter(m => m.hl).map(m => m.label);
    expect(highlighted).toEqual(expect.arrayContaining(['Radiant mid T3 tower destroyed', 'Radiant mid ranged barracks destroyed']));
    expect(moments.find(m => m.label === 'Radiant Ancient destroyed')?.hl).toBe(false);
    // zh localizes team/lane names.
    const zhT = ((key: string) => ({ sideRadiant: '天辉', sideDire: '夜魇', laneMid: '中路', laneTop: '上路', laneBot: '下路' } as Record<string, string>)[key] ?? en[key as keyof typeof en] ?? key) as typeof t;
    const zhMoments = buildMoments(review, review.insights[0], 'zh', zhT);
    expect(zhMoments.some(m => m.label.includes('天辉'))).toBe(true);
  });

  it('labels lane-less T4 towers without inventing bottom', () => {
    const moments = buildMoments(review, review.insights[0], 'en', t);
    const t4 = moments.filter(m => /T4/.test(m.label));
    expect(t4.length).toBeGreaterThan(0);
    expect(t4.every(m => !/bot|Bot|bottom/i.test(m.label))).toBe(true);
    expect(t4.some(m => m.label === 'Radiant T4 tower destroyed')).toBe(true);
  });

  it('does not attribute teamless Roshan to Dire', () => {
    const withNullRosh = {
      ...review,
      objectives: [
        { t: 100, type: 'CHAT_MESSAGE_ROSHAN_KILL', key: null, team: null, fact_id: 'obj.100.0' },
      ],
    } as Review;
    const moments = buildMoments(withNullRosh, review.insights[0], 'en', t);
    const rosh = moments.find(m => m.kind === 'rosh');
    expect(rosh?.label).toBe('Roshan taken');
    expect(rosh?.label).not.toMatch(/Dire|Radiant/);
  });

  it('killerRows orders by raw deaths but shows counts only from fact displays', () => {
    const rows = killerRows(review, 'en');
    expect(rows.map(r => r.slug)).toEqual(['skeleton_king', 'doom_bringer', 'hoodwink', 'sniper']);
    expect(rows.map(r => r.count)).toEqual(['8', '5', '4', '2']);
    expect(rows[0].share).toBe(1);
    expect(rows[1].share).toBeCloseTo(5 / 8);
    const noFacts = { ...review, facts: {} };
    expect(killerRows(noFacts, 'en').map(r => r.slug)).toEqual(rows.map(r => r.slug));
    expect(killerRows(noFacts, 'en').every(r => r.count === null)).toBe(true);
  });

  it('excludes allied denies and self-kills while retaining non-hero killers', () => {
    const ally = review.roster.find(h => h.team === review.player?.team && h.hero !== review.player?.hero)!;
    const deaths = [ally.hero, review.player!.hero, 'tower', 'unknown'].flatMap(killer =>
      Array.from({ length: 10 }, (_, t) => ({ t, killer, team_gold_diff_at_t: null })));
    const withDenies = { ...review, deaths: [...deaths, ...(review.deaths ?? [])] };
    for (const facts of [review.facts, {}]) {
      const rows = killerRows({ ...withDenies, facts }, 'en');
      expect(rows.map(r => r.slug)).toEqual(['tower', 'unknown', 'skeleton_king', 'doom_bringer', 'hoodwink', 'sniper']);
      expect(rows[0].share).toBe(1);
      expect(rows.find(r => r.slug === 'skeleton_king')?.share).toBeCloseTo(8 / 10);
    }
  });

  it('itemRows drops consumables/wards and pre-horn buys, keeps mm:ss labels', () => {
    const rows = itemRows(review);
    expect(rows.some(r => r.item.startsWith('ward_'))).toBe(false);
    expect(rows.some(r => r.item === 'tango')).toBe(false);
    expect(rows.some(r => r.time.startsWith('-'))).toBe(false);
    expect(rows).toContainEqual({ item: 'blink', time: '21:00', key: false });
    expect(rows).toContainEqual({ item: 'black_king_bar', time: '44:33', key: false });
  });

  it('itemName localizes bilingual labels', () => {
    expect(itemName('black_king_bar', 'en')).toBe('Black King Bar');
    expect(itemName('black_king_bar', 'zh')).toBe('黑皇杖');
    expect(itemName('blink', 'zh')).toBe('闪烁匕首');
    expect(itemName('unknown_widget_xyz', 'en')).toBe('Unknown widget xyz');
  });

  it('sourcesFor lists only fields backing the rendered claim', () => {
    expect(sourcesFor(review, 0).map(s => s.field)).toEqual(['radiant_gold_adv', 'radiant_xp_adv', 'objectives']);
    // Fixture deaths are rebuilt from opponents' kills_log — do not advertise absent deaths_log.
    expect(sourcesFor(review, 1).map(s => s.field)).toEqual(['kills_log']);
    expect(sourcesFor(review, 2).map(s => s.field)).toEqual(['lh_t', 'purchase_log']);
    const { 'deaths.total': _dt, killed_by: _kb, ...restFacts } = review.facts;
    const sparse = { ...review, objectives: [], deaths: [], purchases: [], facts: restFacts } as unknown as Review;
    expect(sourcesFor(sparse, 1).map(s => s.field)).toEqual([]);
  });

  it('fieldsFromSourcePath extracts OpenDota field tokens', () => {
    expect(fieldsFromSourcePath('players[6].kills_log[0]')).toEqual(['kills_log']);
    expect(fieldsFromSourcePath('players[0].deaths_log[1]')).toEqual(['deaths_log']);
    expect(fieldsFromSourcePath('players[1].kills_log[0]; players[2].kills_log[3]')).toEqual(['kills_log', 'kills_log']);
  });

  it('dodgeLabels nudges overlapping marker labels downward', () => {
    const [a, b, c] = dodgeLabels([
      { key: 'low', cx: 200, y: 100, width: 90 },
      { key: 'clash', cx: 220, y: 104, width: 60 },
      { key: 'clear', cx: 400, y: 100, width: 60 },
    ]);
    expect(a.y).toBe(100);
    expect(b.y).toBeGreaterThan(104);
    expect(c.y).toBe(100);
    // Non-overlapping labels are returned untouched.
    const spaced = dodgeLabels([{ key: 'a', cx: 10, y: 10, width: 20 }, { key: 'b', cx: 300, y: 10, width: 20 }]);
    expect(spaced.map(l => l.y)).toEqual([10, 10]);
  });

  it('seriesForPlayer flips Dire perspective and preserves nulls', () => {
    const dire = seriesForPlayer({ radiant_gold_adv: [100, null, -50], radiant_xp_adv: [10], perspective: 'dire' });
    expect(dire.gold).toEqual([-100, null, 50]);
    expect(dire.xp).toEqual([-10]);
    const radiant = seriesForPlayer({ radiant_gold_adv: [100, null], radiant_xp_adv: [], perspective: 'radiant' });
    expect(radiant.gold).toEqual([100, null]);
  });

  it('seriesPath breaks at null/non-finite samples instead of plotting zero', () => {
    const X = (i: number) => i * 10;
    const Y = (v: number) => v;
    expect(seriesPath([1, null, 3], X, Y)).toBe('M0.0 1.0 M20.0 3.0');
    expect(seriesPath([1, 2, 3], X, Y)).toBe('M0.0 1.0 L10.0 2.0 L20.0 3.0');
    expect(seriesPath([null, NaN, undefined], X, Y)).toBe('');
  });
});
