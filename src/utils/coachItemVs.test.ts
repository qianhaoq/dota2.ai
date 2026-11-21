import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCoachReport } from '../../lib/coach/analyze.js';
import { ANSWERS } from '../../lib/coach/knowledge.js';
import { answersByPro, itemLifts, proItemsLine } from '../../lib/coach/matchups.js';

const DATA = JSON.parse(readFileSync(path.join(process.cwd(), 'lib/coach/data/item-vs.json'), 'utf8'));
const NAMES = JSON.parse(readFileSync(path.join(process.cwd(), 'lib/coach/data/names.json'), 'utf8'));
const load = (name: string) => JSON.parse(readFileSync(path.join(process.cwd(), 'src/fixtures/coach', name), 'utf8'));
const TIDE = 29; const URSA = 70; const AXE = 2; const BANE = 3; const SPECTRE = 67;

describe('item-vs.json snapshot', () => {
  it('keeps only real lifts, biggest first, at most four per pair', () => {
    const { min_games: minN, min_lift: minLift, top } = DATA.rule;
    for (const [h, row] of Object.entries(DATA.item_vs) as [string, Record<string, [string, number, number, number][]>][]) {
      expect(NAMES.heroes[h], h).toBeTruthy();
      for (const [v, list] of Object.entries(row)) {
        expect(NAMES.heroes[v], v).toBeTruthy();
        expect(list.length).toBeLessThanOrEqual(top);
        list.forEach(([, rate, base, n], i) => {
          expect(n).toBeGreaterThanOrEqual(minN);
          expect(rate - base).toBeGreaterThanOrEqual(minLift - 0.001); // rates are rounded to 3 places
          if (i) expect(list[i - 1][1] - list[i - 1][2]).toBeGreaterThanOrEqual(rate - base - 0.001);
        });
      }
    }
  });
});

describe('itemLifts / answersByPro', () => {
  it("reads pro Tidehunter's Eul's Scepter against Ursa from the snapshot", () => {
    const [key, rate, base, n] = DATA.item_vs[TIDE][URSA][0];
    expect(key).toBe('cyclone');
    expect(itemLifts(TIDE, URSA)[0]).toEqual({ key, rate, base, n });
    expect(itemLifts(TIDE, 99999)).toEqual([]);
    expect(proItemsLine(NAMES.heroes[TIDE], NAMES.heroes[URSA], itemLifts(TIDE, URSA))!.zh)
      .toBe(`职业比赛里潮汐猎人对上熊战士（${DATA.since} 以来 ${n} 场）：${Math.round(rate * 100)}% 出了Eul的神圣法杖（平时 ${Math.round(base * 100)}%）`);
  });

  it('moves the answer pros measurably reach for to the front, and adds nothing that is not an answer', () => {
    const answers = ANSWERS.disable.core;
    expect(answers.indexOf('lotus_orb')).toBeGreaterThan(0);
    const { ordered, lifted } = answersByPro(AXE, [{ id: BANE }], answers);
    expect(ordered[0]).toBe('lotus_orb');
    expect(lifted.get('lotus_orb')).toMatchObject({ key: 'lotus_orb', vs: { id: BANE } });
    expect([...ordered].sort()).toEqual([...answers].sort());
    // No pro data for the pair: the curated order stands.
    expect(answersByPro(AXE, [{ id: 99999 }], answers).ordered).toEqual(answers);
  });
});

describe('report: the counter items pros actually build', () => {
  const parsed = load('match9091400302.parsed.json');
  const r = buildCoachReport(parsed) as any;

  it("ends Tidehunter's fight-carrier advice with pro Tidehunter's Eul's Scepter against Ursa", () => {
    const c = r.reviews[0].chapters.story.why.find((x: any) => x.id === 'fights.carrier');
    expect(c.fix.zh).toContain('职业潮汐猎人对上熊战士时明显更常出Eul的神圣法杖（37%，平时 8%）');
    expect(c.evidence.map((e: any) => e.zh)).toContain(proItemsLine(NAMES.heroes[TIDE], NAMES.heroes[URSA], itemLifts(TIDE, URSA))!.zh);
  });

  it('drops the suggestion when you already bought the item', () => {
    const m = structuredClone(parsed);
    m.players[0].purchase_log.push({ time: 1500, key: 'cyclone' });
    const c = (buildCoachReport(m) as any).reviews[0].chapters.story.why.find((x: any) => x.id === 'fights.carrier');
    expect(c.fix.zh).not.toContain('明显更常出');
  });

  it('lists counter items per enemy hero, only where pros show a real lift', () => {
    const ci = r.reviews[0].counter_items;
    const vsUrsa = ci.find((x: any) => x.hero === URSA);
    expect(vsUrsa.items[0]).toMatchObject({ item: expect.objectContaining({ key: 'cyclone' }), n: DATA.item_vs[TIDE][URSA][0][3] });
    const spectre = r.players.findIndex((p: any) => p.hero.id === SPECTRE);
    for (const x of r.reviews[spectre].counter_items) expect(x.items.length).toBeGreaterThan(0);
    expect(r.baselines.item_rule).toEqual(DATA.rule);
  });
});
