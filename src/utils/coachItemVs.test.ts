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

describe('item-vs.json: only items still sold in the current patch (review #199)', () => {
  it('filters at generation by what current-patch pro games bought; removed items never appear', () => {
    expect(DATA.source).toMatch(/finished items seen in \d+\.\d+ pro matches/);
    expect(DATA.available_in).toBe(NAMES.patch);
    const listed = new Set(Object.values(DATA.item_vs).flatMap((row: any) => Object.values(row).flatMap((l: any) => l.map((x: any) => x[0]))));
    // Removed in 7.42 but still in names.json (historical entries are kept there).
    expect(NAMES.items.helm_of_the_overlord).toBeTruthy();
    expect(listed.has('helm_of_the_overlord')).toBe(false);
    expect(itemLifts(38, 3).map((x) => x.key)).not.toContain('helm_of_the_overlord'); // Beastmaster vs Bane, the case from review
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

  it('a pro answer on the other role\'s list comes first; an item on no answer list never does (owner, 2026-11-27)', () => {
    // Eul's is on the physical support list only: a core Tidehunter's list leaves it out, and pros build it against Ursa.
    const core = ANSWERS.physical.core; const pool = [...new Set([...ANSWERS.physical.core, ...ANSWERS.physical.support])];
    expect(core).not.toContain('cyclone');
    expect(pool).toContain('cyclone');
    expect(answersByPro(TIDE, [{ id: URSA }], core).ordered[0]).not.toBe('cyclone');
    const withPool = answersByPro(TIDE, [{ id: URSA }], core, pool);
    expect(withPool.ordered[0]).toBe('cyclone');
    expect(withPool.ordered.slice(1)).toEqual(core);
    // Helm of the Dominator is built more by pro Beastmasters against Necrophos, but it answers nothing on any list.
    expect(itemLifts(38, 36).map((x) => x.key)).toContain('helm_of_the_dominator');
    const all = Object.values(ANSWERS).flatMap((r: any) => [...r.core, ...r.support]);
    expect(all).not.toContain('helm_of_the_dominator');
    expect(answersByPro(38, [{ id: 36 }], ANSWERS.magic.core, [...ANSWERS.magic.core, ...ANSWERS.magic.support]).ordered).not.toContain('helm_of_the_dominator');
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

  it('without an answer of his own, core Tidehunter is told Eul\'s first against Ursa, not a core-list armor item', () => {
    const m = structuredClone(parsed);
    const p = m.players.find((x: any) => x.hero_id === TIDE);
    const ghost = JSON.parse(readFileSync(path.join(process.cwd(), 'lib/data/constants/items.json'), 'utf8')).ghost.id;
    for (const k of ['item_0', 'item_1', 'item_2', 'item_3', 'item_4', 'item_5', 'backpack_0', 'backpack_1', 'backpack_2']) if (p[k] === ghost) p[k] = 0;
    p.purchase_log = (p.purchase_log ?? []).filter((x: any) => x.key !== 'ghost');
    const c = (buildCoachReport(m) as any).reviews[0].chapters.story.why.find((x: any) => x.id === 'fights.carrier');
    expect(c.fix.zh).toContain('在下一波大团前做出 Eul的神圣法杖、');
    expect(c.fix.zh).not.toContain('希瓦');
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
