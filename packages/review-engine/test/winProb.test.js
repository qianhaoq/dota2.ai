import { describe, it, expect } from 'vitest';
import { FEATURES, WIN_PROB_SCHEMA, buildingsAt, featuresOf, stateAt, winProbability } from '../src/value/winProb.js';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { modelInputs, winProbabilityAt, winProbabilitySwing } from '../src/value/fromTrace.js';
import { linkHeroNames } from '../src/trace/index.js';

/** A model with round weights, so the arithmetic can be followed by hand. */
const model = { schema: WIN_PROB_SCHEMA, features: FEATURES, weights: [0, 0.1, 0.5, 0.4] };
const even = { minute: 40, gold: 0, barracks: 0 };

describe('win probability', () => {
  it('an even game is 50%; a lead is more, the same deficit as much less', () => {
    expect(winProbability(model, even)).toBe(0.5);
    const ahead = winProbability(model, { ...even, gold: 5000 });
    const behind = winProbability(model, { ...even, gold: -5000 });
    expect(ahead).toBeGreaterThan(0.5);
    expect(ahead + behind).toBeCloseTo(1, 12);
    // By hand, at 40:00: g = 5, t = 4, √t = 2 → 0.1·5 + 0.5·5/2 = 1.75 → 1 / (1 + e^-1.75).
    expect(ahead).toBeCloseTo(1 / (1 + Math.exp(-1.75)), 12);
    // Barracks: one more of theirs down than of ours is 0.4 on the same scale.
    expect(winProbability(model, { ...even, barracks: 1 })).toBeCloseTo(1 / (1 + Math.exp(-0.4)), 12);
  });

  it('the same gold lead counts for less the later it is', () => {
    const at = (minute) => winProbability(model, { ...even, minute, gold: 5000 });
    expect(at(10)).toBeGreaterThan(at(20));
    expect(at(20)).toBeGreaterThan(at(40));
    // Past the last minute it was fitted on, the minute is held: a 90-minute game reads as a 60-minute one.
    expect(at(90)).toBe(at(60));
    // And the first minute does not divide by nothing.
    expect(Number.isFinite(winProbability(model, { ...even, minute: 0, gold: 300 }))).toBe(true);
  });

  it('features are named in the order of the weights', () => {
    expect(FEATURES).toEqual(['bias', 'gold_k', 'gold_k_per_sqrt_t', 'barracks']);
    expect(featuresOf({ minute: 40, gold: 4000, barracks: -1 })).toEqual([1, 4, 2, -1]);
    // Towers are not read: with or without them, the same features.
    expect(featuresOf({ minute: 40, gold: 4000, barracks: -1, towers: 5 })).toEqual([1, 4, 2, -1]);
  });

  it('a missing number is no probability — never a guess at zero', () => {
    for (const bad of [{ ...even, gold: null }, { ...even, gold: undefined }, { ...even, minute: NaN }, { ...even, barracks: null }, { minute: 20, gold: 0 }, null, undefined]) expect([bad, winProbability(model, bad)]).toEqual([bad, null]);
  });

  it('a model of another shape is not used', () => {
    expect(winProbability({ ...model, schema: 'something/else@1' }, even)).toBeNull();
    expect(winProbability({ ...model, weights: [0, 1] }, even)).toBeNull();
    expect(winProbability({ ...model, features: ['bias', 'gold_k', 'barracks', 'gold_k_per_sqrt_t'] }, even)).toBeNull();
    // The first fit's shape (six features): a file of it is refused, not read by position.
    expect(winProbability({ ...model, features: ['bias', 'gold_k', 'gold_k_per_t', 'towers', 'barracks', 'towers_t'], weights: [0, 0.1, 0.5, 0.2, 0.4, 0.05] }, even)).toBeNull();
    expect(winProbability(null, even)).toBeNull();
  });
});

describe('buildings fallen up to a moment', () => {
  const falls = [
    [600, 'npc_dota_goodguys_tower1_top'], [900, 'npc_dota_badguys_tower1_mid'], [1200, 'npc_dota_badguys_tower2_mid'],
    [1500, 'npc_dota_badguys_tower3_mid'], [1510, 'npc_dota_badguys_melee_rax_mid'], [1520, 'npc_dota_badguys_range_rax_mid'],
    [1800, 'npc_dota_badguys_fillers'], [1900, 'npc_dota_badguys_tower4'], [1900, 'npc_dota_badguys_tower4'], [2000, 'npc_dota_badguys_fort'],
  ];

  it('counts towers and barracks by whose they were: positive is Radiant ahead', () => {
    expect(buildingsAt(falls, 0)).toEqual({ towers: 0, barracks: 0 });
    expect(buildingsAt(falls, 600)).toEqual({ towers: -1, barracks: 0 });
    expect(buildingsAt(falls, 1200)).toEqual({ towers: 1, barracks: 0 });
    expect(buildingsAt(falls, 1515)).toEqual({ towers: 2, barracks: 1 });
    // The two towers by the Ancient share a name and are two towers; fillers and the Ancient are neither.
    expect(buildingsAt(falls, 5000)).toEqual({ towers: 4, barracks: 2 });
  });

  it('a row it cannot read is not counted, and no rows is nothing fallen', () => {
    expect(buildingsAt([[100, null], [200, 'npc_dota_neutral_tower1'], ['x', 'npc_dota_goodguys_tower1_top']], 5000)).toEqual({ towers: 0, barracks: 0 });
    expect(buildingsAt(null, 100)).toEqual({ towers: 0, barracks: 0 });
  });
});

describe('the state at a game second', () => {
  const lead = [0, 1000, 3000, 2000];
  it('reads the gold lead between its two minute points', () => {
    expect(stateAt({ lead, falls: [], t: 60 })).toEqual({ minute: 1, gold: 1000, towers: 0, barracks: 0 });
    expect(stateAt({ lead, falls: [], t: 90 })).toEqual({ minute: 1.5, gold: 2000, towers: 0, barracks: 0 });
    // In the last minute there is no later point: the last one stands.
    expect(stateAt({ lead, falls: [], t: 200 })?.gold).toBe(2000);
    expect(stateAt({ lead, falls: [[100, 'npc_dota_badguys_tower1_mid']], t: 120 })).toMatchObject({ gold: 3000, towers: 1 });
  });

  it('no gold lead, a gap in it, or a time outside it: no state', () => {
    expect(stateAt({ lead: null, falls: [], t: 60 })).toBeNull();
    expect(stateAt({ lead: [0], falls: [], t: 0 })).toBeNull();
    expect(stateAt({ lead: [0, null, 3000], falls: [], t: 70 })).toBeNull();
    expect(stateAt({ lead, falls: [], t: 240 })).toBeNull();
    expect(stateAt({ lead, falls: [], t: -5 })).toBeNull();
    expect(stateAt({ lead, falls: [], t: NaN })).toBeNull();
  });
});

describe('read on a parsed replay (9100904020, Radiant won)', () => {
  // The committed trace has only the net worth graph or nothing; the match record gives the gold-earned lead.
  const trace = linkHeroNames(JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/trace-9100904020.json.gz', import.meta.url)))));
  const adv = new Array(44).fill(0); adv[30] = 745; adv[31] = 2995; adv[32] = 4298; adv[33] = 4664;
  const ctx = { match: { radiant_gold_adv: adv } };

  it('takes the gold lead where the tools take it, and the buildings by whose they were', () => {
    const inputs = modelInputs(trace, ctx);
    expect(inputs.source).toBe('match_record');
    expect(inputs.falls[0]).toEqual([1087.9, 'npc_dota_goodguys_tower1_top']);
    const at = winProbabilityAt(model, trace, 1826, ctx);
    // 30:26, the start of the fight Dire lost five heroes in: 745 at 30:00, 2995 at 31:00.
    expect(at).toMatchObject({ minute: 1826 / 60, gold_source: 'match_record' });
    expect(at.gold).toBeCloseTo(745 + (2995 - 745) * (26 / 60), 6);
    expect(at.radiant).toBeGreaterThan(0);
    expect(at.radiant).toBeLessThan(1);
  });

  it('a stretch has both ends and the change; toward Radiant is positive', () => {
    const swing = winProbabilitySwing(model, trace, 1826, 1848 + 120, ctx);
    expect(swing.from.minute).toBeCloseTo(30.43, 2);
    expect(swing.to.gold).toBeGreaterThan(swing.from.gold);
    expect(swing.radiant_change).toBeCloseTo(swing.to.radiant - swing.from.radiant, 12);
    expect(swing.radiant_change).toBeGreaterThan(0);
  });

  it('without a gold-earned lead there is no number, and it says which kind of nothing', () => {
    const bare = { ...trace, net_worth: undefined, gold: undefined };
    expect(winProbabilityAt(model, bare, 1826)).toEqual({ unknown: 'no_gold_lead' });
    // Only the replay's net worth graph: another quantity than the model was fitted on.
    const graph = { ...bare, net_worth: trace.heroes.map((_, i) => Array.from({ length: 44 }, (_, m) => 600 + m * (300 + i * 10))) };
    expect(modelInputs(graph)).toEqual({ unknown: 'net_worth_only' });
    expect(winProbabilityAt(model, graph, 1826)).toEqual({ unknown: 'net_worth_only' });
    expect(winProbabilitySwing(model, graph, 1826, 1968)).toEqual({ unknown: 'net_worth_only' });
    // A second outside the lead, and a model that is not one.
    expect(winProbabilityAt(model, trace, 99999, ctx)).toEqual({ unknown: 'outside_the_gold_lead' });
    expect(winProbabilityAt(model, trace, -30, ctx)).toEqual({ unknown: 'outside_the_gold_lead' });
    expect(winProbabilityAt({ schema: 'x' }, trace, 1826, ctx)).toEqual({ unknown: 'no_model' });
    expect(winProbabilitySwing(model, trace, 1826, 99999, ctx)).toEqual({ unknown: 'outside_the_gold_lead' });
  });
});
