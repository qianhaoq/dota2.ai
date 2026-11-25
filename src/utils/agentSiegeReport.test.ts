import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { siegeReport, SIEGE_TOOL } from '../../lib/agent/siegeReport.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { KNOWLEDGE_TOOLS } from '../../lib/agent/knowledgeTools.js';
import { reviewToolkit, deepReviewSystem, verifyReview } from '../../lib/agent/deepReview.js';
import { chatSystem } from '../../lib/agent/chat.js';
import { sieges, SIEGE_NEAR, traceRegion } from '../../packages/review-engine/src/trace/index.js';

/** A real ranked game (9100904020): Beastmaster on Dire, lost in 42:31. */
const trace = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());

/** Heroes stand where `pos` says; `hits` are [second, hero key, building name] rows; `fell` [second, building name]. */
function synth({ n = 300, heroes, pos = {}, hits = [], fell = [], dead = {} }: any) {
  const H = heroes.map(([key, team]: [string, number], i: number) => ({ key, npc: `npc_dota_hero_${key}`, team, player_index: i }));
  const names = [...H.map((h: any) => h.npc)];
  const id = (name: string) => { let i = names.indexOf(name); if (i < 0) { names.push(name); i = names.length - 1; } return i; };
  const damage = hits.map(([s, hero, b]: any) => [s, id(`npc_dota_hero_${hero}`), id(`npc_dota_${b}`), -1, 100]);
  const buildings = fell.map(([s, b]: any) => [s, id(`npc_dota_${b}`), 2, 0]);
  return {
    schema: 'dota2.ai/match-trace@1', match_id: 1, t0: 0, n, heroes: H, names,
    states: H.map((h: any) => {
      const p = pos[h.key] ?? (h.team === 2 ? [-6000, -6000] : [6000, 6000]); const d = dead[h.key];
      return { x: Array(n).fill(p[0]), y: Array(n).fill(p[1]), hp: Array(n).fill(500), max_hp: Array(n).fill(1000), mana: Array(n).fill(500), level: Array(n).fill(10),
        alive: Array.from({ length: n }, (_, i) => (d && i >= d[0] && i < d[1] ? 0 : 1)), mana_peak: Array(n).fill(500) };
    }),
    abilities: H.map(() => ({})), items: H.map(() => ({})), controls: H.map(() => ({})),
    casts: [], item_uses: [], purchases: [], buildings, modifiers: [], damage, deaths: [], net_worth: [], gaps: [],
  };
}
const heroes = [['axe', 2], ['lina', 2], ['sven', 2], ['pudge', 3], ['zuus', 3], ['lion', 3]];

describe('a push is measured from the damage log', () => {
  it('hits 30 s apart or less are one push; three hero-seconds at least; owners within 1800 of the hitters are near', () => {
    const tower = 'badguys_tower1_mid';
    const t: any = synth({
      heroes,
      pos: { axe: [0, 0], lina: [300, 0], sven: [9000, -9000], pudge: [0, 1700], zuus: [0, 2500] },
      // One push 100–130 (axe and lina), a second from 200 (axe alone); a lone hit at 165, 35 s from each, is neither.
      hits: [[100, 'axe', tower], [101, 'lina', tower], [130, 'axe', tower], [165, 'axe', tower], [200, 'axe', tower], [201, 'axe', tower], [202, 'axe', tower]],
      fell: [[210, tower]],
    });
    const s = sieges(t);
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ from: 100, to: 130, fell_at: null, same_name: false });
    expect(s[0].hitters.map((i: number) => t.heroes[i].key)).toEqual(['axe', 'lina']);
    // Pudge 1700 from the hitters is near; Zeus at 2500 is not.
    expect(s[0].near.map((i: number) => t.heroes[i].key)).toEqual(['pudge']);
    expect(SIEGE_NEAR).toBe(1800);
    // Fell 8 s after the second push's last hit: it took the building.
    expect(s[1]).toMatchObject({ from: 200, to: 202, fell_at: 210 });
  });

  it('a hero\'s attack and spell in the same second are one hero-second (review of #302)', () => {
    const tower = 'badguys_tower1_mid';
    // Two seconds of hits, each with two damage rows (an attack and a spell): two hero-seconds, not a push.
    const t: any = synth({ heroes, hits: [[100, 'axe', tower], [100, 'axe', tower], [101, 'axe', tower], [101, 'axe', tower]] });
    t.damage = t.damage.map((row: any[], i: number) => [row[0], row[1], row[2], i % 2 ? 7 : -1, 100]);
    expect(sieges(t)).toEqual([]);
  });

  it('an owner is near when within 1800 of a hitter at the second that hitter hit, wherever the others stood (review of #302)', () => {
    const tower = 'badguys_tower2_top';
    // Axe hits from the west, Lina from the east, 4000 apart: their middle is 2000 from each. Pudge stands 1500 from Axe.
    const t: any = synth({
      heroes,
      pos: { axe: [-2000, 0], lina: [2000, 0], pudge: [-2000, 1500], zuus: [0, 2100] },
      hits: [[100, 'axe', tower], [101, 'lina', tower], [102, 'axe', tower]],
    });
    const near = sieges(t)[0].near.map((i: number) => t.heroes[i].key);
    expect(near).toContain('pudge');
    // Zeus is 2100 from the middle and about 2900 from each hitter: not near.
    expect(near).not.toContain('zuus');
  });

  it('a hero hitting their own side\'s building is not a push, and the two towers by an Ancient are flagged as one name', () => {
    const t: any = synth({ heroes, hits: [[50, 'pudge', 'badguys_tower1_mid'], [51, 'pudge', 'badguys_tower1_mid'], [52, 'pudge', 'badguys_tower1_mid'], [60, 'axe', 'badguys_tower4'], [61, 'axe', 'badguys_tower4'], [62, 'axe', 'badguys_tower4']] });
    const s = sieges(t);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ name: 'npc_dota_badguys_tower4', same_name: true });
    expect((siegeReport(t, { hero: 'axe' }) as any).pushes[0].same_name_as_the_other_tower_by_the_ancient).toBe(true);
  });

  it('the report says where the rest were: a dead owner with their respawn, a pusher far off with distance', () => {
    const tower = 'goodguys_tower2_bot';
    const t: any = synth({
      heroes,
      pos: { pudge: [5000, -5000], zuus: [5200, -5000], lion: [-3000, 3000], axe: [5100, -4600] },
      hits: [[100, 'pudge', tower], [101, 'zuus', tower], [102, 'pudge', tower]],
      fell: [[104, tower]],
      dead: { lina: [80, 130] },
    });
    const r: any = siegeReport(t, { hero: 'axe' });
    expect(r).toMatchObject({ enemy_pushes: 1, enemy_pushes_that_took_it: 1, my_team_pushes: 0, my_buildings_taken_with_me_not_near: 0 });
    const p = r.pushes[0];
    expect(p).toMatchObject({ ref: 'sieges:axe:1', building: 'goodguys_tower2_bot', pushed_by: 'enemy', took_it: true, fell_at: '1:44', hitting: ['pudge', 'zuus'], owners_near: ['axe'], hitting_minus_owners_near: 1, me: 'near' });
    expect(p.owners_not_near).toEqual([{ hero: 'lina', doing: 'dead', respawn_in: 30 }, { hero: 'sven', doing: 'in_own_base', place: 'radiant_base', distance: expect.any(Number) }]);
    expect(p.pushing_side_not_hitting).toEqual([expect.objectContaining({ hero: 'lion', distance: expect.any(Number) })]);
    // No TP held: not said at all (unknown is not "not ready").
    expect('tp_ready' in p.pushing_side_not_hitting[0]).toBe(false);
  });
});

describe('where the player was when their building fell is not where they were when the push began', () => {
  const tower = 'goodguys_tower1_top';
  // Pudge and Zeus hit a Radiant tower from 100 to 130; it falls at 133.7 (shown as 2:13). Axe, of Radiant, starts in
  // his base and has walked to the middle of the map by the time it falls.
  const game = (change: (t: any) => void = () => {}) => {
    const t: any = synth({ heroes, pos: { pudge: [-5000, 5000], zuus: [-5200, 5000] }, hits: [[100, 'pudge', tower], [101, 'zuus', tower], [115, 'pudge', tower], [130, 'zuus', tower]], fell: [[133.7, tower]] });
    const axe = t.states[0];
    for (let i = 110; i < t.n; i += 1) { axe.x[i] = 0; axe.y[i] = 0; }
    change(t);
    return t;
  };

  it('the rows are from the push\'s start; me_when_it_fell is the player at the second the building fell', () => {
    const p = (siegeReport(game(), { hero: 'axe' }) as any).pushes[0];
    expect(p).toMatchObject({ clock: '1:40', until: '2:10', took_it: true, fell_at: '2:13', pushed_by: 'enemy', me: 'not_near' });
    // When it began (1:40) Axe was in his base…
    expect(p.owners_not_near.find((x: any) => x.hero === 'axe')).toMatchObject({ doing: 'in_own_base', place: 'radiant_base' });
    // …and at 2:13, when it fell, in the middle of the map: the place a "where was I when it fell" is about.
    expect(p.me_when_it_fell).toEqual({ place: traceRegion(0, 0), distance: expect.any(Number) });
    expect(p.me_when_it_fell.place).not.toBe('radiant_base');
    expect('hero' in p.me_when_it_fell).toBe(false);
  });

  it('dead at that second: dead and for how long; no sample at that second: not known, never a place', () => {
    const dead = (siegeReport(game((t) => { for (let i = 125; i < 160; i += 1) t.states[0].alive[i] = 0; }), { hero: 'axe' }) as any).pushes[0];
    expect(dead.me_when_it_fell).toEqual({ doing: 'dead', respawn_in: 27 });
    const gone = (siegeReport(game((t) => { for (let i = 129; i < 139; i += 1) { t.states[0].x[i] = null; t.states[0].y[i] = null; } }), { hero: 'axe' }) as any).pushes[0];
    expect(gone.me_when_it_fell).toEqual({ known: false });
  });

  it('only for the player\'s own building that fell: not for a push that failed, nor for one the player\'s team made', () => {
    const stood: any = game((t) => { t.buildings = []; });
    expect('me_when_it_fell' in (siegeReport(stood, { hero: 'axe' }) as any).pushes[0]).toBe(false);
    // The same push told from the pushing side.
    expect('me_when_it_fell' in (siegeReport(game(), { hero: 'pudge' }) as any).pushes[0]).toBe(false);
  });
});

describe('siege_report on a real game', () => {
  const r: any = siegeReport(trace, { hero: 'beastmaster' });

  it('counts each side\'s pushes and what they took; the other side reads the mirror', () => {
    expect(r).toMatchObject({ my_team_pushes: 5, my_team_pushes_that_took_it: 4, enemy_pushes: 19, enemy_pushes_that_took_it: 17 });
    const other: any = siegeReport(trace, { hero: 'axe' });
    expect(other).toMatchObject({ my_team_pushes: 19, my_team_pushes_that_took_it: 17, enemy_pushes: 5, enemy_pushes_that_took_it: 4 });
    expect(other.pushes.map((p: any) => p.hitting)).toEqual(r.pushes.map((p: any) => p.hitting));
    for (const p of r.pushes) expect(p.hitting.length + p.pushing_side_not_hitting.length).toBe(5);
  });

  it('the mid tier-1 at 20:02: Phantom Assassin alone, none of Dire near, every Dire hero 7000 or more away', () => {
    const p = r.pushes.find((x: any) => x.building === 'badguys_tower1_mid' && x.took_it);
    expect(p).toMatchObject({ clock: '19:59', fell_at: '20:02', pushed_by: 'enemy', hitting: ['phantom_assassin'], owners_near: [], me: 'not_near' });
    expect(p.owners_not_near).toHaveLength(5);
    expect(Math.min(...p.owners_not_near.map((x: any) => x.distance))).toBeGreaterThan(7000);
  });

  it('push 18 (the tower by the Ancient at 40:26): all five of Dire were near one of the four hitters (review of #302)', () => {
    const p = r.pushes[17];
    expect(p).toMatchObject({ ref: 'sieges:beastmaster:18', building: 'badguys_tower4', clock: '40:26', hitting: ['phantom_assassin', 'mirana', 'venomancer', 'necrolyte'] });
    expect([...p.owners_near].sort()).toEqual(['beastmaster', 'dark_willow', 'skywrath_mage', 'sven', 'undying']);
  });

  it('a player on the pushing side who did not hit is "not_hitting", not absent: Necrophos 114 from the hitter at 35:49 (review of #302)', () => {
    const n: any = siegeReport(trace, { hero: 'necrolyte' });
    const p = n.pushes[10];
    expect(p).toMatchObject({ ref: 'sieges:necrolyte:11', clock: '35:49', pushed_by: 'my_team', me: 'not_hitting' });
    // Where he was is in his row: close by, and fighting.
    expect(p.pushing_side_not_hitting.find((x: any) => x.hero === 'necrolyte')).toMatchObject({ doing: 'trading_damage_with_enemy_heroes' });
    expect(n.pushes.every((x: any) => (x.pushed_by === 'my_team' ? ['hitting', 'not_hitting'] : ['near', 'not_near']).includes(x.me))).toBe(true);
  });

  it('each push states its counts, and who was dead when it began even if they came near later (review of #302)', () => {
    const p = r.pushes[17];
    expect(p).toMatchObject({ hitting_count: 4, owners_near_count: 5, hitting_minus_owners_near: -1, owners_dead_when_it_began: 3 });
    // A correct count of those near is backed by the push's own record.
    const record = reviewToolkit({ trace, hero: 'beastmaster', lang: 'zh' })!.runTool('siege_report', { hero: 'beastmaster' });
    const ev = (fact: string) => verifyReview({ verdict: 'v', mainline: [], findings: [], game_plan: { course: 'c', evidence: [{ refs: ['sieges:beastmaster:18'], fact }] } }, [record]).problems.filter((x: any) => x.where === 'plan_evidence');
    expect(ev('40:26 守方有 5 人在附近，4 人在打塔。')).toEqual([]);
    expect(ev('40:26 守方有 3 人阵亡。')).toEqual([]);
  });

  it('refs resolve, places are named, and one push\'s facts need that push\'s ref', () => {
    const one = resolveRef(trace, r.pushes[0].ref, { hero: 'beastmaster', lang: 'zh' });
    expect(one?.record.building).toBe(r.pushes[0].building);
    for (const x of [...r.pushes[0].owners_not_near, ...r.pushes[0].pushing_side_not_hitting]) if (x.place) expect(one?.names[x.place]).toMatch(/[一-鿿]/);
    expect(resolveRef(trace, 'sieges:beastmaster', { hero: 'beastmaster' })?.record).toMatchObject({ my_team_pushes: 5, enemy_pushes: 19 });
    expect(resolveRef(trace, 'sieges:beastmaster', { hero: 'beastmaster' })?.record).not.toHaveProperty('pushes');
    expect(resolveRef(trace, `sieges:beastmaster:${r.pushes.length + 1}`, { hero: 'beastmaster' })).toBeNull();
    const record = reviewToolkit({ trace, hero: 'beastmaster', lang: 'en' })!.runTool('siege_report', { hero: 'beastmaster' });
    const ev = (refs: string[], fact: string) => verifyReview({ verdict: 'v', mainline: [], findings: [], game_plan: { course: 'c', evidence: [{ refs, fact }] } }, [record]).problems.filter((p: any) => p.where === 'plan_evidence');
    const mid = r.pushes.indexOf(r.pushes.find((x: any) => x.building === 'badguys_tower1_mid' && x.took_it)) + 1;
    expect(ev(['sieges:beastmaster'], 'The mid tower fell at 20:02.')).not.toEqual([]);
    expect(ev([`sieges:beastmaster:${mid}`], 'The mid tower fell at 20:02.')).toEqual([]);
    expect(ev(['sieges:beastmaster'], 'They pushed 19 times and took 17.')).toEqual([]);
  });

  it('me_when_it_fell agrees with game_state at fell_at on every Dire building that fell, and differs from the push\'s start', () => {
    const kit = reviewToolkit({ trace, hero: 'beastmaster', lang: 'en' })!;
    const fell = r.pushes.filter((p: any) => p.pushed_by === 'enemy' && p.took_it);
    expect(fell).toHaveLength(17);
    for (const p of fell) {
      const me = (kit.runTool('game_state', { hero: 'beastmaster', at: p.fell_at }) as any).my_team.heroes.find((x: any) => x.hero === 'beastmaster');
      expect(p.me_when_it_fell).toMatchObject(me.alive ? { place: me.place } : { doing: 'dead', respawn_in: me.respawn_in });
    }
    for (const p of r.pushes.filter((x: any) => !(x.pushed_by === 'enemy' && x.took_it))) expect('me_when_it_fell' in p).toBe(false);
    // 38:12–38:24, the bottom tier 2: fighting in Dire mid when the push began, in the Dire top jungle when it fell.
    const t2 = r.pushes[12];
    expect(t2).toMatchObject({ building: 'badguys_tower2_bot', clock: '38:12', fell_at: '38:24' });
    expect(t2.owners_not_near.find((x: any) => x.hero === 'beastmaster')).toMatchObject({ place: 'dire_mid', doing: 'trading_damage_with_enemy_heroes' });
    expect(t2.me_when_it_fell).toMatchObject({ place: 'dire_top_jungle' });
    // 39:54–40:49, the top tier 3: dead when it began, alive in base when it fell 55 s later.
    const t3 = r.pushes[13];
    expect(t3.owners_not_near.find((x: any) => x.hero === 'beastmaster')).toMatchObject({ doing: 'dead', respawn_in: 48 });
    expect(t3.me_when_it_fell).toMatchObject({ doing: 'in_own_base', place: 'dire_base' });
    // The place at the fall is named like any other in the evidence.
    expect(resolveRef(trace, t2.ref, { hero: 'beastmaster', lang: 'zh' })?.names.dire_top_jungle).toMatch(/[一-鿿]/);
  });

  it('the tool, the review and the chat all say the rows are from the push\'s start', () => {
    expect(SIEGE_TOOL.description).not.toMatch(/when its own buildings fell/);
    expect(SIEGE_TOOL.description).toMatch(/doing when the push began/);
    expect(SIEGE_TOOL.description).toMatch(/use game_state at fell_at/);
    expect(r.rule).toMatch(/as they were when the push began \(clock\), not when the building fell/);
    expect(deepReviewSystem('en')).toMatch(/where everyone else was when it began/);
    expect(deepReviewSystem('en')).toMatch(/"me_when_it_fell"/);
    expect(chatSystem('en')).toMatch(/never give them as where a hero was when the building fell/);
  });

  it('the review and the chat get the tool and are told how to read it', () => {
    expect(KNOWLEDGE_TOOLS).toContain(SIEGE_TOOL);
    expect(deepReviewSystem('zh')).toContain('siege_report for the player');
    expect(deepReviewSystem('zh')).toMatch(/does not say they defended it/);
    expect(chatSystem('zh')).toContain('siege_report for the player');
  });
});
