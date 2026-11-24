import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { PLAN_ITEMS, PLAN_ITEM_EFFECT } from '../../lib/agent/planItems.js';
import { PLAN_KEYS } from '../../lib/agent/plans.js';
import { buildForPlan } from '../../lib/agent/buildForPlan.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { reviewToolkit, verifyReview } from '../../lib/agent/deepReview.js';

const ITEMS = JSON.parse(readFileSync(new URL('../../lib/data/constants/items.json', import.meta.url), 'utf8'));
const NAMES = JSON.parse(readFileSync(new URL('../../lib/coach/data/names.json', import.meta.url), 'utf8')).items;
const trace = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());
const match = JSON.parse(readFileSync(new URL('../fixtures/agent/match9100904020.scoreboard.json', import.meta.url), 'utf8'));
const valveText = (key: string) => { const x = ITEMS[key]; return [...(x?.abilities ?? []).map((a: any) => `${a.title}: ${a.description}`), ...(x?.hint ?? []), x?.notes ?? ''].join(' | ').replace(/\s+/g, ' '); };
const run = (hero: string, plan?: string, lang = 'en'): any => buildForPlan(trace, { hero, ...(plan ? { plan } : {}) }, { match, lang });

describe('which plan an item serves', () => {
  it('every entry quotes Valve\'s own text for the item, word for word', () => {
    for (const [key, entry] of Object.entries(PLAN_ITEMS) as [string, any][]) {
      expect(NAMES[key], key).toBeTruthy();
      expect(valveText(key), key).toContain(entry.quote);
      expect(entry.plans.length, key).toBeGreaterThan(0);
      for (const p of entry.plans) expect(PLAN_KEYS).toContain(p);
    }
  });

  it('every plan has items and says what they do', () => {
    for (const p of PLAN_KEYS) {
      expect(Object.values(PLAN_ITEMS).some((e: any) => e.plans.includes(p)), p).toBe(true);
      expect(PLAN_ITEM_EFFECT[p as keyof typeof PLAN_ITEM_EFFECT]).toBeTruthy();
    }
    // An item Valve says does not work on buildings is not filed under taking them.
    expect(valveText('greater_crit')).toContain('does not work against buildings');
    expect(PLAN_ITEMS).not.toHaveProperty('greater_crit');
  });
});

describe('build_for_plan on a real game', () => {
  it('lists the big items in order with their price and the plan each serves', () => {
    const r = run('beastmaster');
    expect(r).toMatchObject({ ref: 'build_plan:beastmaster', ref_scope: 'summary', hero: 'beastmaster', big_items_total: 3, gold_in_big_items: 13050, measured_at: ['15:00', '25:00'] });
    expect(r.items.map((i: any) => [i.first_held, i.item, i.cost, i.serves])).toEqual([['16:48', 'ultimate_scepter', 4200, []], ['29:08', 'pipe', 3725, []], ['38:58', 'assault', 5125, ['push']]]);
    expect(r.items[2]).toMatchObject({ item: 'assault', valve_says: 'decreases nearby enemy unit and structure armor' });
    // No item_timeline refs inside: that record would not show the price, gold or Valve's line these items carry (review of #284).
    expect(JSON.stringify(r)).not.toMatch(/"ref":"item:/);
    expect(r.items[0]).not.toHaveProperty('valve_says');
    expect(r.gold_in_items_for_each_plan).toEqual({ push: 5125, gank: 0, split: 0, late: 0 });
    expect(r.gold_in_items_for_each_plan_by_25_00).toEqual({ push: 0, gank: 0, split: 0, late: 0 });
    expect(r.first_item_for_each_plan).toEqual({ push: '38:58', gank: null, split: null, late: null });
    // With no plan named there is nothing to read it against.
    expect(r).not.toHaveProperty('stated_plan');
  });

  it('an item built from one already counted adds only what it costs on top (review of #284)', () => {
    // Sven's Armlet (2500) went into Berserker's Sabatons (5950): the Sabatons add 3450, so the total is 14950, not 17450.
    const sven = run('sven');
    expect(sven.items.map((i: any) => [i.item, i.cost, i.gold])).toEqual([['echo_sabre', 2700, 2700], ['armlet', 2500, 2500], ['berserkers_sabatons', 5950, 3450], ['blink', 2250, 2250], ['black_king_bar', 4050, 4050]]);
    expect(sven.items[2]).toMatchObject({ gold_on_top_of_items_already_counted: 3450 });
    expect(sven.items[0]).not.toHaveProperty('gold_on_top_of_items_already_counted');
    expect(sven.gold_in_big_items).toBe(14950);
    // Phantom Assassin's Skull Basher went into Abyssal Blade.
    const pa = run('phantom_assassin');
    expect(pa.items.find((i: any) => i.item === 'abyssal_blade')).toMatchObject({ cost: 6150, gold: 3275 });
    expect(pa.gold_in_big_items).toBe(pa.items.reduce((a: number, i: any) => a + i.gold, 0));
  });

  it('an item is classified only by the text of this game\'s patch (review of #284)', () => {
    // Desolator's "Armor reduction works on buildings." is 7.42's text; 7.41's says otherwise.
    const older = { ...match, patch: 60 };
    const r: any = buildForPlan(trace, { hero: 'phantom_assassin', plan: 'push' }, { match: older });
    expect(r.data_patch).toBe('7.41');
    expect(r.items.find((i: any) => i.item === 'desolator')).toMatchObject({ serves: [], effect_text_differs_in_this_patch: true });
    expect(r.items.find((i: any) => i.item === 'desolator')).not.toHaveProperty('valve_says');
    expect(r.stated_plan).toMatchObject({ first_item_for_it: null });
    expect(r.gaps).toContainEqual({ topic: 'items_whose_effect_text_differs_in_this_patch', reason: 'not_classified: desolator' });
    // Battle Fury's text is the same in 7.41: still read as farming.
    expect(r.items.find((i: any) => i.item === 'bfury')).toMatchObject({ serves: ['late'] });
    // In the current patch the Desolator is read as before.
    expect(run('phantom_assassin', 'push').stated_plan).toMatchObject({ first_item_for_it: 'desolator' });
  });

  it('with the plan the player named: the first item for it, what came before it, and its share', () => {
    const r = run('beastmaster', 'push', 'zh');
    expect(r.ref).toBe('build_plan:beastmaster:push');
    expect(r.stated_plan).toMatchObject({ plan: 'push', name: '线优转推进', first_item_for_it: 'assault', first_item_for_it_name: '强袭胸甲', first_item_for_it_at: '38:58', gold_in_other_big_items_before_it: 7925, share_of_big_item_gold_for_it: 0.39 });
    // Sven never bought an item for pushing: none, all his big-item gold went elsewhere.
    expect(run('sven', 'push').stated_plan).toMatchObject({ items_for_it: [], first_item_for_it: null, first_item_for_it_at: null, gold_in_other_big_items_before_it: 14950, share_of_big_item_gold_for_it: 0 });
    // Phantom Assassin's Battle Fury at 15:47 is her first item for farming; Sven's Blink at 26:17 his first for ganks.
    expect(run('phantom_assassin', 'late').stated_plan).toMatchObject({ first_item_for_it: 'bfury', first_item_for_it_at: '15:47', gold_in_other_big_items_before_it: 0 });
    expect(run('sven', 'gank').stated_plan).toMatchObject({ first_item_for_it: 'blink', first_item_for_it_at: '26:17' });
    expect(buildForPlan(trace, { hero: 'beastmaster', plan: 'cheese' }, { match })).toMatchObject({ error: 'unknown_plan', plans: PLAN_KEYS });
    expect(buildForPlan(trace, { hero: 'pudge' }, { match })).toMatchObject({ error: 'unknown_hero' });
  });

  it('is a tool of the agent, its refs open the same record, and a sentence may state its numbers', () => {
    const kit: any = reviewToolkit({ trace, hero: 'beastmaster', lang: 'zh', match });
    const record = kit.runTool('build_for_plan', { hero: 'beastmaster', plan: 'push' });
    expect(record).toMatchObject({ tool: 'build_for_plan', ref: 'build_plan:beastmaster:push' });
    const opened: any = resolveRef(trace, 'build_plan:beastmaster:push', { hero: 'beastmaster', lang: 'zh', match });
    expect(opened.record).toMatchObject({ stated_plan: { first_item_for_it_at: '38:58' } });
    expect(opened.record).not.toHaveProperty('items');
    expect(resolveRef(trace, 'build_plan:beastmaster', { hero: 'beastmaster', match })!.record).not.toHaveProperty('stated_plan');
    for (const bad of ['build_plan:beastmaster:cheese', 'build_plan:pudge', 'build_plan:beastmaster:push:1', 'build_plan']) expect(resolveRef(trace, bad, { hero: 'beastmaster', match })).toBeNull();
    const review = (fact: string) => ({ verdict: 'v', mainline: [], findings: [], game_plan: { against_your_plan: 'a', course: 'c', evidence: [{ refs: ['build_plan:beastmaster:push'], fact }] } });
    const problems = (fact: string) => verifyReview(review(fact), [record]).problems.filter((p: any) => p.where === 'plan_evidence');
    expect(problems('你说要线优转推进：第一件推进装强袭胸甲 38:58 才出，之前已经有 7925 金花在别的大件上，推进装只占大件金额的 39%。')).toEqual([]);
    expect(problems('第一件推进装 25:00 就出了。')).toEqual([]);
    expect(problems('第一件推进装 31:16 才出。')).toEqual([expect.objectContaining({ kind: 'moment' })]);
  });
});
