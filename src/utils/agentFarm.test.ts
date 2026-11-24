import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { farmReport } from '../../lib/agent/farmReport.js';
import { windowReport } from '../../lib/agent/windowReport.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { reviewToolkit, verifyReview } from '../../lib/agent/deepReview.js';

const trace = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());
const match = JSON.parse(readFileSync(new URL('../fixtures/agent/match9100904020.scoreboard.json', import.meta.url), 'utf8'));
const ID_OF: Record<string, number> = Object.fromEntries(match.players.map((p: any, i: number) => [trace.heroes[i < 5 ? i : i]?.key, p.hero_id]));
/**
 * Per-minute money for the fixture, as the two sources would give it: a line per hero, steeper for some.
 * Made up for the test — the shape is what matters: OpenDota's gold_t per player, or the trace's net_worth per hero.
 */
const slope = (key: string) => ({ phantom_assassin: 700, sven: 500 } as Record<string, number>)[key] ?? 300;
const series = (key: string) => Array.from({ length: 43 }, (_, m) => m * slope(key));
const withGold = { ...match, players: match.players.map((p: any) => { const key = trace.heroes.find((h: any) => ID_OF[h.key] === p.hero_id)?.key; return { ...p, gold_t: series(key), lh_t: series(key).map((g) => Math.round(g / 100)) }; }) };
const withNetWorth = { ...trace, net_worth: trace.heroes.map((h: any) => series(h.key).map((g) => g + 600)) };

describe('farm_report', () => {
  it('who on each side gained the most in each stretch and inside each window, from the match data\'s gold', () => {
    const r: any = farmReport(trace, { hero: 'beastmaster' }, { match: withGold });
    expect(r).toMatchObject({ ref: 'farm:beastmaster', ref_scope: 'summary', money: 'match_data_gold_earned' });
    expect(r.gained_most_over_the_game).toEqual({ my_team: 'sven', enemy: 'phantom_assassin' });
    expect(r.stretches.map((s: any) => s.clock)).toEqual(['0:00–10:00', '10:00–20:00', '20:00–30:00', '30:00–40:00', '40:00–42:00']);
    expect(r.stretches[1]).toMatchObject({ ref: 'farm:beastmaster:2', gained: { phantom_assassin: 7000, sven: 5000, beastmaster: 3000 }, last_hits: { phantom_assassin: 70 }, gained_total: { my_team: 5000 + 4 * 3000, enemy: 7000 + 4 * 3000 } });
    // Inside the team's window (19:00–29:00): ten minutes of each hero's line.
    const w = r.windows.find((x: any) => x.ahead === 'my_team');
    expect(w).toMatchObject({ ref: 'farm:beastmaster:w2', window: 'window:beastmaster:2', clock: '19:00–29:00', gained: { phantom_assassin: 7000 }, gained_most: { enemy: 'phantom_assassin', my_team: 'sven' } });
    expect(r.gaps.map((g: any) => g.topic)).toEqual(['where_buildings_stand']);
  });

  it('falls back to the replay\'s net worth, says so, and has no last hits then', () => {
    const r: any = farmReport(withNetWorth, { hero: 'beastmaster' }, {});
    expect(r).toMatchObject({ money: 'replay_net_worth', gained_most_over_the_game: { enemy: 'phantom_assassin' } });
    expect(r.money_note).toContain('net worth');
    expect(r.stretches[0]).not.toHaveProperty('last_hits');
    expect(r.gaps.map((g: any) => g.topic)).toContain('last_hits_by_minute');
    // The match data wins when it has all ten; with one player missing it is not used at all.
    const nine = { ...withGold, players: withGold.players.map((p: any, i: number) => (i === 0 ? { ...p, gold_t: undefined } : p)) };
    expect((farmReport(withNetWorth, { hero: 'beastmaster' }, { match: nine }) as any).money).toBe('replay_net_worth');
    expect((farmReport(withNetWorth, { hero: 'beastmaster' }, { match: withGold }) as any).money).toBe('match_data_gold_earned');
  });

  it('with no money by minute it says so, and still tells who was near the buildings the team took', () => {
    const r: any = farmReport(trace, { hero: 'beastmaster' }, { match });
    expect(r.money).toBeNull();
    expect(r.gaps).toEqual([{ topic: 'money_by_minute', reason: 'no_per_minute_gold_in_the_match_data_and_no_net_worth_in_the_replay' }]);
    expect(r).not.toHaveProperty('stretches');
    expect(r.buildings_your_team_took.map((b: any) => [b.ref, b.clock, b.enemy_heroes_alive, b.enemy_heroes_near_your_team])).toEqual([
      ['farm:beastmaster:b1', '18:07', 4, ['axe', 'necrolyte', 'mirana']],
      ['farm:beastmaster:b2', '18:45', 3, []],
      ['farm:beastmaster:b3', '19:46', 5, ['venomancer', 'mirana']],
      ['farm:beastmaster:b4', '25:05', 4, ['axe', 'necrolyte', 'venomancer']],
    ]);
    expect(r.buildings_your_team_took_with_no_enemy_near).toEqual(['18:45']);
    // An enemy whose position was not sampled: who was near is not known, not "nobody".
    const pa = trace.heroes.findIndex((h: any) => h.key === 'phantom_assassin');
    const blind = { ...trace, states: trace.states.map((s: any, i: number) => (i === pa ? { ...s, x: s.x.map(() => null) } : s)) };
    const b2 = (farmReport(blind, { hero: 'beastmaster' }, { match }) as any).buildings_your_team_took[1];
    expect(b2.enemy_heroes_near_your_team).toBeNull();
    // Nor how many of them were alive: she may have been (review of #285).
    expect(b2.enemy_heroes_alive).toBeNull();
    // An ally whose position was not sampled may have stood next to an enemy: "nobody near" is not concluded either.
    const sv = trace.heroes.findIndex((h: any) => h.key === 'sven');
    const allyBlind = { ...trace, states: trace.states.map((s: any, i: number) => (i === sv ? { ...s, x: s.x.map(() => null) } : s)) };
    const a2 = (farmReport(allyBlind, { hero: 'beastmaster' }, { match }) as any).buildings_your_team_took[1];
    expect(a2).toMatchObject({ enemy_heroes_alive: 3, enemy_heroes_near_your_team: null });
    expect((farmReport(blind, { hero: 'beastmaster' }, { match }) as any).buildings_your_team_took_with_no_enemy_near).toEqual([]);
    expect(farmReport(trace, { hero: 'pudge' }, {})).toMatchObject({ error: 'unknown_hero' });
  });

  it('is a tool of the agent; its refs open the same records; a sentence may state their numbers', () => {
    const kit: any = reviewToolkit({ trace, hero: 'beastmaster', lang: 'zh', match: withGold });
    const record = kit.runTool('farm_report', { hero: 'beastmaster' });
    expect(record).toMatchObject({ tool: 'farm_report', ref: 'farm:beastmaster' });
    for (const ref of ['farm:beastmaster:2', 'farm:beastmaster:w2', 'farm:beastmaster:b2']) expect(resolveRef(trace, ref, { hero: 'beastmaster', match: withGold })!.record.ref).toBe(ref);
    expect(resolveRef(trace, 'farm:beastmaster', { hero: 'beastmaster', match: withGold })!.record).not.toHaveProperty('stretches');
    for (const bad of ['farm:beastmaster:w9', 'farm:beastmaster:x1', 'farm', 'farm:pudge']) expect(resolveRef(trace, bad, { hero: 'beastmaster', match: withGold })).toBeNull();
    const ev = (refs: string[], fact: string) => verifyReview({ verdict: 'v', mainline: [], findings: [], game_plan: { course: 'c', evidence: [{ refs, fact }] } }, [record]).problems.filter((p: any) => p.where === 'plan_evidence');
    expect(ev(['farm:beastmaster:w2'], '19:00 到 29:00 你们领先时，幻影刺客多赚了 7000，是对面最多的。')).toEqual([]);
    expect(ev(['farm:beastmaster:b2'], '18:45 拆中路一塔时对面 3 人存活，没有人在你们附近。')).toEqual([]);
    expect(ev(['farm:beastmaster:b2'], '18:45 拆中路一塔时对面 5 人存活。')).toEqual([expect.objectContaining({ kind: 'moment' })]);
  });
});

describe('farm_report when a money source does not reach the end of the game (review of #285)', () => {
  // One hero's match-data gold stops at 10:00.
  const short = { ...withGold, players: withGold.players.map((p: any, i: number) => (i === 0 ? { ...p, gold_t: p.gold_t.slice(0, 11), lh_t: p.lh_t.slice(0, 11) } : p)) };
  it('a complete source is preferred to one that stops early', () => {
    const r: any = farmReport(withNetWorth, { hero: 'beastmaster' }, { match: short });
    expect(r.money).toBe('replay_net_worth');
    expect(r.windows.find((w: any) => w.ahead === 'my_team').gained.phantom_assassin).toBe(7000);
  });
  it('with none complete, gains after its end are unknown, and no one is named as gaining most', () => {
    const r: any = farmReport(trace, { hero: 'beastmaster' }, { match: short });
    expect(r.money).toBe('match_data_gold_earned');
    expect(r.gaps).toContainEqual({ topic: 'money_by_minute', reason: 'ends_at_10:00; gains after it are unknown' });
    expect(r.stretches[0].gained.phantom_assassin).toBe(7000);
    // 19:00–29:00 lies after the end: unknown, not zero, and nobody gained most.
    const w = r.windows.find((x: any) => x.ahead === 'my_team');
    expect(Object.values(w.gained)).toEqual(Array(10).fill(null));
    expect(w.gained_most).toEqual({ my_team: null, enemy: null });
    expect(w.gained_total).toEqual({ my_team: null, enemy: null });
    expect(r.gained_most_over_the_game).toEqual({ my_team: null, enemy: null });
  });
  it('every stretch and window record says what it measured', () => {
    const r: any = farmReport(withNetWorth, { hero: 'beastmaster' }, {});
    for (const x of [...r.stretches, ...r.windows]) expect(x.money).toBe('replay_net_worth');
    expect(resolveRef(withNetWorth, 'farm:beastmaster:2', { hero: 'beastmaster' })!.record.money).toBe('replay_net_worth');
  });
});

describe('window_report without the match data\'s gold', () => {
  it('draws its windows from the replay\'s net worth, and says that is what it read', () => {
    const r: any = windowReport(withNetWorth, { hero: 'beastmaster' }, {});
    expect(r.lead_source).toBe('replay_net_worth_lead');
    expect(r.windows.length).toBeGreaterThan(0);
    expect((windowReport(trace, { hero: 'beastmaster' }, { match }) as any).lead_source).toBe('match_data_gold_lead');
    expect((windowReport(trace, { hero: 'beastmaster' }, {}) as any).windows).toBeNull();
  });
});
