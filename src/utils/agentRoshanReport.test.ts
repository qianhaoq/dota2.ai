import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { roshanReport, aegisTakes, ROSHAN_TOOL, AEGIS_SECONDS, ATTEMPT_GAP, PICKUP_WITHIN, ROSHAN_PITS, PIT_NEAR, pitAt } from '../../lib/agent/roshanReport.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { KNOWLEDGE_TOOLS } from '../../lib/agent/knowledgeTools.js';
import { deepReviewSystem, reviewToolkit, verifyReview } from '../../lib/agent/deepReview.js';
import { chatSystem } from '../../lib/agent/chat.js';

const FIXTURE = new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url);
/** A real ranked game (9100904020): Beastmaster on Dire, lost in 42:31. Radiant took one Roshan. */
const trace = JSON.parse(gunzipSync(readFileSync(FIXTURE)).toString());

/** Where the synthetic games happen: Roshan's Dire-side pit (ROSHAN_PITS). Positions given are relative to it. */
const PIT = [2702, -2693];
/** Heroes at fixed spots; `items` per hero { key: { held: [[from, to]] } }; `deaths` [second, victim]; `fell` [second, building]. */
function synth({ n = 1000, heroes, pos = {}, items = {}, deaths = [], fell = [] }: any) {
  const H = heroes.map(([key, team]: [string, number], i: number) => ({ key, npc: `npc_dota_hero_${key}`, team, player_index: i }));
  const names = [...H.map((h: any) => h.npc)];
  const id = (name: string) => { let i = names.indexOf(name); if (i < 0) { names.push(name); i = names.length - 1; } return i; };
  const buildings = fell.map(([s, b]: any) => [s, id(`npc_dota_${b}`), 2, 0]);
  return {
    schema: 'dota2.ai/match-trace@1', match_id: 1, t0: 0, n, heroes: H, names,
    states: H.map((h: any) => { const q = pos[h.key] ?? [0, 0]; const p = [q[0] + PIT[0], q[1] + PIT[1]]; return { x: Array(n).fill(p[0]), y: Array(n).fill(p[1]), hp: Array(n).fill(500), max_hp: Array(n).fill(1000), mana: Array(n).fill(300), level: Array(n).fill(20), alive: Array(n).fill(1), mana_peak: Array(n).fill(300) }; }),
    abilities: H.map(() => ({})), items: H.map((h: any) => items[h.key] ?? {}), controls: H.map(() => ({})),
    casts: [], item_uses: [], purchases: [], buildings, modifiers: [], damage: [], net_worth: [], gaps: [],
    deaths: deaths.map(([s, v]: any) => [s, names.indexOf(`npc_dota_hero_${v}`), -1, 0]),
  };
}
const heroes = [['axe', 2], ['lina', 2], ['sven', 2], ['pudge', 3], ['zuus', 3]];

describe('a Roshan is an Aegis pickup', () => {
  it('used when the holder dies holding it, expired after 300 s, else the game ended or unknown', () => {
    const t: any = synth({
      heroes,
      items: { axe: { item_aegis: { held: [[100, 250]] } }, pudge: { item_aegis: { held: [[400, 400 + AEGIS_SECONDS]] } }, sven: { item_aegis: { held: [[900, 999]] } } },
      deaths: [[250, 'axe']],
    });
    expect(aegisTakes(t).map((x: any) => [t.heroes[x.holder].key, x.from, x.ended])).toEqual([['axe', 100, 'used'], ['pudge', 400, 'expired'], ['sven', 900, 'game_ended']]);
  });

  it('who stood near the holder, the player\'s place in it, what else dropped, and what each side took in the next 300 s', () => {
    const t: any = synth({
      heroes,
      pos: { axe: [0, 0], lina: [1000, 0], sven: [9000, 9000], pudge: [0, 2000], zuus: [5000, 0] },
      items: { axe: { item_aegis: { held: [[100, 400]] } }, lina: { item_cheese: { held: [[105, 600]] } } },
      fell: [[200, 'badguys_tower2_mid'], [390, 'badguys_tower3_mid'], [401, 'badguys_melee_rax_mid'], [250, 'goodguys_tower1_top']],
    });
    const r: any = roshanReport(t, { hero: 'sven' });
    expect(r).toMatchObject({ roshans_my_team_took: 1, roshans_enemy_took: 0, my_team_aegis_expired: 1, buildings_my_team_took_with_aegis: 2, my_team_roshans_with_no_building_after: 0, roshans_i_was_at: 0 });
    expect(r.takes[0]).toMatchObject({
      ref: 'roshan:sven:1', clock: '1:40', taken_by: 'my_team', aegis_holder: 'axe', taking_side_near: ['lina'], other_side_near: ['pudge'], me: 'not_there',
      also_dropped: [{ item: 'cheese', hero: 'lina' }], aegis: 'expired',
      // 401 is past the 300 s from the pickup at 100.
      buildings_taking_side_took_in_the_next_300s: [{ clock: '3:20', building: 'badguys_tower2_mid' }, { clock: '6:30', building: 'badguys_tower3_mid' }],
      buildings_other_side_took_in_the_next_300s: [{ clock: '4:10', building: 'goodguys_tower1_top' }],
    });
    // From the other side the same take is the enemy's, and the holder's own report says so.
    expect((roshanReport(t, { hero: 'axe' }) as any).takes[0].me).toBe('holder');
    expect((roshanReport(t, { hero: 'pudge' }) as any).takes[0]).toMatchObject({ taken_by: 'enemy', me: 'there' });
  });
});

describe('a Roshan read from its kill', () => {
  /** A synthetic game with kill rows: `kills` [second, killer, side], `hits` [second, hero, damage], `tormentors` [second, killer, side]. */
  const withKills = (o: any, { kills = [], hits = [], tormentors = [] }: any) => {
    const t: any = synth(o);
    const idx = (key: string) => t.names.indexOf(`npc_dota_hero_${key}`);
    return { ...t, roshan_kills: kills.map(([sec, who, side]: any) => [sec, idx(who), side, 0, null, null]), roshan_damage: hits.map(([sec, who, dmg]: any) => [sec, idx(who), dmg]), tormentor_kills: tormentors.map(([sec, who, side]: any) => [sec, idx(who), side, 0]) };
  };
  const pos = { axe: [0, 0], lina: [1000, 0], sven: [9000, 9000], pudge: [0, 2000], zuus: [5000, 0] };

  it('the kill, the attempt behind it, who hit it, where the other side stood, and the pickup that followed', () => {
    const t = withKills({ heroes, pos, items: { lina: { item_aegis: { held: [[204, 504]] } } }, deaths: [[150, 'zuus']] }, {
      kills: [[200, 'axe', 2]],
      // An earlier poke at 120 (more than ATTEMPT_GAP before the next hit) is not this attempt.
      hits: [[120, 'axe', 300], [170, 'axe', 900], [176, 'lina', 400], [185, 'axe', 1200], [190, 'pudge', 150], [199, 'axe', 800]],
    });
    const r: any = roshanReport(t, { hero: 'sven' });
    expect(r).toMatchObject({ read_from: 'roshan_kills_and_aegis_pickups', roshan_kills_in_the_trace: 1, roshans_my_team_took: 1, roshans_enemy_took: 0, my_team_roshans_i_hit: 0, roshans_the_other_side_also_hit: 1 });
    expect(r.takes).toHaveLength(1);
    expect(r.takes[0]).toMatchObject({
      ref: 'roshan:sven:1', clock: '3:20', taken_by: 'my_team', seen_by: 'kill_and_aegis_pickup', killed_by: 'axe',
      aegis_holder: 'lina', aegis_picked_up_at: '3:24', aegis: 'expired', me: 'not_there',
      attempt: {
        started: '2:50', seconds: 30,
        heroes_hitting: [{ hero: 'axe', damage: 2900 }, { hero: 'lina', damage: 400 }],
        other_side_hitting: [{ hero: 'pudge', damage: 150 }],
        // Where Radiant's opponents stood at 2:50, and how far from where Roshan died (the killer's place).
        other_side_when_it_began: [{ hero: 'pudge', place: expect.any(String), distance: 2000 }, { hero: 'zuus', place: expect.any(String), distance: 5000 }],
        i_hit_it: false,
      },
    });
    expect(ATTEMPT_GAP).toBe(10);
    // Told from a hero who hit it, and from the other side.
    expect((roshanReport(t, { hero: 'lina' }) as any)).toMatchObject({ my_team_roshans_i_hit: 1, takes: [{ me: 'holder', attempt: { i_hit_it: true } }] });
    expect((roshanReport(t, { hero: 'pudge' }) as any).takes[0]).toMatchObject({ taken_by: 'enemy', me: 'there', attempt: { i_hit_it: true } });
    // What followed is counted from the pickup, as before.
    expect(r.takes[0].buildings_taking_side_took_count).toBe(0);
  });

  it('a hero of the other side who was dead, or had no position, when it began is said so — not placed', () => {
    const t = withKills({ heroes, pos, deaths: [[150, 'zuus']] }, { kills: [[200, 'axe', 2]], hits: [[195, 'axe', 500]] });
    const zuus = t.heroes.findIndex((h: any) => h.key === 'zuus'); const pudge = t.heroes.findIndex((h: any) => h.key === 'pudge');
    t.states[zuus].alive.fill(0, 150, 260);
    t.states[pudge].x.fill(null, 0, 1000); t.states[pudge].y.fill(null, 0, 1000);
    const a = (roshanReport(t, { hero: 'sven' }) as any).takes[0].attempt;
    expect(a.other_side_when_it_began).toEqual([{ hero: 'pudge', place: null }, { hero: 'zuus', dead: true }]);
  });

  it('a kill with no pickup by the killing side within 30 s is a take whose Aegis was not seen picked up', () => {
    // Radiant kills at 200; Dire's Pudge picks the Aegis up at 210 (a steal), and Radiant's Lina only at 300.
    const t = withKills({ heroes, pos, items: { pudge: { item_aegis: { held: [[210, 510]] } } } }, { kills: [[200, 'axe', 2]], hits: [[198, 'axe', 500]] });
    const r: any = roshanReport(t, { hero: 'sven' });
    expect(PICKUP_WITHIN).toBe(30);
    expect(r.takes.map((x: any) => [x.clock, x.taken_by, x.seen_by, x.aegis, x.aegis_holder ?? null])).toEqual([
      ['3:20', 'my_team', 'kill', 'no_pickup_seen_within_30s', null],
      // The other side's pickup is its own take: an Aegis in their hands, with no kill of theirs behind it.
      ['3:30', 'enemy', 'aegis_pickup', 'expired', 'pudge'],
    ]);
    expect(r).toMatchObject({ roshans_my_team_took: 1, roshans_enemy_took: 1, roshan_kills_in_the_trace: 1 });
  });

  it('a pickup with no kill row (the last hit was not a hero\'s) is still a take; two kills each keep their own pickup', () => {
    const t = withKills({ heroes, pos, items: { axe: { item_aegis: { held: [[100, 250], [705, 900]] } }, pudge: { item_aegis: { held: [[400, 700]] } } }, deaths: [[250, 'axe']] }, {
      kills: [[398, 'pudge', 3], [700, 'axe', 2]], hits: [[395, 'pudge', 900], [698, 'axe', 900]],
    });
    const r: any = roshanReport(t, { hero: 'sven' });
    expect(r.takes.map((x: any) => [x.ref, x.clock, x.taken_by, x.seen_by, x.aegis_holder, x.aegis])).toEqual([
      ['roshan:sven:1', '1:40', 'my_team', 'aegis_pickup', 'axe', 'used'],
      ['roshan:sven:2', '6:38', 'enemy', 'kill_and_aegis_pickup', 'pudge', 'expired'],
      ['roshan:sven:3', '11:40', 'my_team', 'kill_and_aegis_pickup', 'axe', expect.any(String)],
    ]);
    expect(r.takes[0]).not.toHaveProperty('attempt');
    expect(r.roshan_kills_in_the_trace).toBe(2);
  });

  it('Tormentors a hero killed are listed apart; a trace built before any of this was kept does not know', () => {
    const t = withKills({ heroes, pos }, { tormentors: [[1200, 'lina', 2], [1500, 'pudge', 3], [1700, 'zuus', 0]] });
    const r: any = roshanReport(t, { hero: 'sven' });
    expect(r).toMatchObject({ tormentors_my_team_took: 1, tormentors_enemy_took: 2, roshan_kills_in_the_trace: 0 });
    // Each with its own ref, so one can be cited and opened (Codex on #384).
    expect(r.tormentors).toEqual([{ ref: 'roshan:sven:t1', clock: '20:00', taken_by: 'my_team', killed_by: 'lina' }, { ref: 'roshan:sven:t2', clock: '25:00', taken_by: 'enemy', killed_by: 'pudge' }, { ref: 'roshan:sven:t3', clock: '28:20', taken_by: 'enemy', killed_by: 'zuus' }]);
    expect(r.gaps.filter((g: any) => g.topic === 'roshan')).toEqual([{ topic: 'roshan', reason: expect.stringContaining('who could see an attempt is not in the replay data') }]);
    // The older shape: pickups only, and every count that needs kills is null — unknown, not zero.
    const older: any = roshanReport(synth({ heroes, pos, items: { axe: { item_aegis: { held: [[100, 400]] } } } }), { hero: 'sven' });
    expect(older).toMatchObject({ read_from: 'aegis_pickups_only', roshan_kills_in_the_trace: null, my_team_roshans_i_hit: null, roshans_the_other_side_also_hit: null, tormentors_my_team_took: null, tormentors_enemy_took: null, roshans_my_team_took: 1 });
    expect(older).not.toHaveProperty('tormentors');
    expect(older.takes[0]).toMatchObject({ seen_by: 'aegis_pickup', clock: '1:40', aegis_holder: 'axe' });
    expect(older.takes[0]).not.toHaveProperty('killed_by');
    expect(older.gaps.find((g: any) => g.topic === 'roshan').reason).toContain('built before kills were kept');
  });

  it('on the real game: Phantom Assassin killed it at 32:18 after 26 seconds, with Mirana, and nobody of the player\'s team near', () => {
    // The rows today's builder keeps for the committed game (packages/review-engine/test/fixtures/roshan-9100904020.json).
    const rows = JSON.parse(readFileSync(new URL('../../packages/review-engine/test/fixtures/roshan-9100904020.json', import.meta.url), 'utf8'));
    const idx = (npc: string | null) => (npc == null ? -1 : trace.names.indexOf(npc));
    const withRows = { ...trace, roshan_kills: rows.roshan_kills.map((x: any[]) => [x[0], idx(x[1]), ...x.slice(2)]), roshan_damage: rows.roshan_damage.map((x: any[]) => [x[0], idx(x[1]), x[2]]), tormentor_kills: rows.tormentor_kills };
    const r: any = roshanReport(withRows, { hero: 'beastmaster' });
    expect(r).toMatchObject({ read_from: 'roshan_kills_and_aegis_pickups', roshan_kills_in_the_trace: 1, roshans_enemy_took: 1, roshans_my_team_took: 0, my_team_roshans_i_hit: 0, roshans_the_other_side_also_hit: 0, tormentors_my_team_took: 0, tormentors_enemy_took: 0 });
    expect(r.takes).toHaveLength(1);
    expect(r.takes[0]).toMatchObject({
      clock: '32:18', taken_by: 'enemy', seen_by: 'kill_and_aegis_pickup', killed_by: 'phantom_assassin', aegis_holder: 'phantom_assassin', aegis_picked_up_at: '32:18', aegis: 'used', me: 'not_there',
      attempt: { started: '31:52', seconds: 26, heroes_hitting: [{ hero: 'phantom_assassin', damage: 8840 }, { hero: 'mirana', damage: 1765 }], other_side_hitting: [], i_hit_it: false },
    });
    // The player's team when it began: Sven dead, the nearest of the others 4,331 from the pit (Phantom Assassin
    // stood about 180 from its middle as Roshan died; distances are from the pit, not from the killer).
    const others = r.takes[0].attempt.other_side_when_it_began;
    expect(others.find((x: any) => x.hero === 'sven')).toEqual({ hero: 'sven', dead: true });
    expect(others.filter((x: any) => !x.dead).map((x: any) => [x.hero, x.place, x.distance])).toEqual([['beastmaster', 'dire_base', 9783], ['undying', 'dire_top_lane', 4331], ['skywrath_mage', 'dire_mid', 5828], ['dark_willow', 'dire_mid', 7697]]);
    // The same Roshan read from the pickup alone (the committed trace) is the same take, without the attempt.
    const old: any = roshanReport(trace, { hero: 'beastmaster' });
    expect(old.takes[0]).toMatchObject({ clock: '32:18', taken_by: 'enemy', seen_by: 'aegis_pickup', aegis_holder: 'phantom_assassin', aegis: 'used' });
    expect(old.takes[0].buildings_taking_side_took_in_the_next_300s).toEqual(r.takes[0].buildings_taking_side_took_in_the_next_300s);
  });
});

describe('what the review found on #384', () => {
  const withKills = (o: any, { kills = [], hits = [], tormentors = [] }: any) => {
    const t: any = synth(o);
    const idx = (key: string) => t.names.indexOf(`npc_dota_hero_${key}`);
    return { ...t, roshan_kills: kills.map(([sec, who, side]: any) => [sec, idx(who), side, 0, null, null]), roshan_damage: hits.map(([sec, who, dmg]: any) => [sec, idx(who), dmg]), tormentor_kills: tormentors.map(([sec, who, side]: any) => [sec, idx(who), side, 0]) };
  };
  const pos = { axe: [0, 0], lina: [1000, 0], sven: [9000, 9000], pudge: [0, 2000], zuus: [5000, 0] };

  it('the pits, measured on the corpus; a position is at one within PIT_NEAR', () => {
    expect([ROSHAN_PITS, PIT_NEAR]).toEqual([[[-3100, 2254], [2702, -2693]], 1200]);
    expect(pitAt({ x: -2937, y: 2265 })).toMatchObject({ x: -3100, y: 2254 });
    expect(pitAt({ x: 2702 + 1199, y: -2693 })).toMatchObject({ x: 2702, y: -2693 });
    expect(pitAt({ x: 2702 + 1201, y: -2693 })).toBeNull();
    expect(pitAt(null)).toBeNull();
  });

  it('a killer standing at neither pit (their illusion landed the hit) says nothing of who was near or how far', () => {
    // Axe is credited with the kill but stands 6,000 from the pit; Lina and Pudge are at it.
    const t = withKills({ heroes, pos: { ...pos, axe: [6000, 0] }, deaths: [] }, { kills: [[200, 'axe', 2]], hits: [[190, 'axe', 800], [195, 'lina', 900], [200, 'axe', 700]] });
    const take: any = (roshanReport(t, { hero: 'axe' }) as any).takes[0];
    expect(take).toMatchObject({ killed_by: 'axe', where_not_known: true, taking_side_near: null, other_side_near: null, me: null });
    expect(take).not.toHaveProperty('place');
    expect(take.attempt.other_side_when_it_began.every((x: any) => !('distance' in x))).toBe(true);
    // The killer at the pit: placed, and distances read from the pit.
    const there: any = (roshanReport(withKills({ heroes, pos, deaths: [] }, { kills: [[200, 'axe', 2]], hits: [[195, 'axe', 900]] }), { hero: 'axe' }) as any).takes[0];
    expect(there).not.toHaveProperty('where_not_known');
    expect(there.other_side_near).toEqual(['pudge']);
    expect(there.attempt.other_side_when_it_began.find((x: any) => x.hero === 'zuus').distance).toBe(5000);
  });

  it('a kill with no Aegis pickup does not count toward buildings taken "with the Aegis"', () => {
    const t = withKills({ heroes, pos, fell: [[300, 'badguys_tower2_mid']] }, { kills: [[200, 'axe', 2]], hits: [[195, 'axe', 900]] });
    const r: any = roshanReport(t, { hero: 'sven' });
    expect(r.takes[0]).toMatchObject({ aegis: 'no_pickup_seen_within_30s', buildings_taking_side_took_count: 1 });
    expect(r.buildings_my_team_took_with_aegis).toBe(0);
    // With the pickup, it does.
    const held: any = roshanReport(withKills({ heroes, pos, fell: [[300, 'badguys_tower2_mid']], items: { axe: { item_aegis: { held: [[205, 505]] } } } }, { kills: [[200, 'axe', 2]], hits: [[195, 'axe', 900]] }), { hero: 'sven' });
    expect(held.buildings_my_team_took_with_aegis).toBe(1);
  });

  it('one Tormentor kill resolves by its own ref, and a review citing its time keeps it', () => {
    const t = withKills({ heroes, pos }, { tormentors: [[1200, 'lina', 2]] });
    const ev: any = resolveRef(t, 'roshan:sven:t1', { hero: 'sven', lang: 'en' });
    expect(ev.record).toMatchObject({ ref: 'roshan:sven:t1', clock: '20:00', taken_by: 'my_team', killed_by: 'lina' });
    expect(resolveRef(t, 'roshan:sven:t2', { hero: 'sven', lang: 'en' })).toBeNull();
  });

  it('in Chinese, where the other side stood when it began is named in Chinese', () => {
    const rows = JSON.parse(readFileSync(new URL('../../packages/review-engine/test/fixtures/roshan-9100904020.json', import.meta.url), 'utf8'));
    const idx = (npc: string | null) => (npc == null ? -1 : trace.names.indexOf(npc));
    const withRows = { ...trace, roshan_kills: rows.roshan_kills.map((x: any[]) => [x[0], idx(x[1]), ...x.slice(2)]), roshan_damage: rows.roshan_damage.map((x: any[]) => [x[0], idx(x[1]), x[2]]), tormentor_kills: rows.tormentor_kills };
    const ev: any = resolveRef(withRows, 'roshan:beastmaster:1', { hero: 'beastmaster', lang: 'zh' });
    for (const place of ['dire_base', 'dire_top_lane', 'dire_mid']) expect([place, typeof ev.names[place] === 'string' && /[\u4e00-\u9fff]/.test(ev.names[place])]).toEqual([place, true]);
  });
});

describe('roshan_report on a real game', () => {
  const r: any = roshanReport(trace, { hero: 'beastmaster' });

  it('Radiant\'s Roshan at 32:18: Phantom Assassin held it with Axe and Mirana near, used it at 36:43, and took the top tier-2', () => {
    expect(r).toMatchObject({ roshans_my_team_took: 0, roshans_enemy_took: 1, buildings_enemy_took_with_aegis: 1 });
    expect(r.takes[0]).toMatchObject({
      clock: '32:18', taken_by: 'enemy', aegis_holder: 'phantom_assassin', taking_side_near: ['axe', 'mirana'], other_side_near: [], me: 'not_there',
      aegis: 'used', aegis_used_at: '36:43', buildings_taking_side_took_in_the_next_300s: [{ clock: '36:22', building: 'badguys_tower2_top' }],
    });
  });

  it('refs resolve with the place named; one take\'s facts need its own ref; the model gets the tool and the rule', () => {
    const one = resolveRef(trace, 'roshan:beastmaster:1', { hero: 'beastmaster', lang: 'zh' })!;
    expect(one.record.aegis_holder).toBe('phantom_assassin');
    expect(one.names.river_top_jungle).toMatch(/[一-鿿]/);
    expect(resolveRef(trace, 'roshan:beastmaster', { hero: 'beastmaster' })?.record).not.toHaveProperty('takes');
    expect(resolveRef(trace, 'roshan:beastmaster:2', { hero: 'beastmaster' })).toBeNull();
    const record = reviewToolkit({ trace, hero: 'beastmaster', lang: 'zh' })!.runTool('roshan_report', { hero: 'beastmaster' });
    const ev = (refs: string[], fact: string) => verifyReview({ verdict: 'v', mainline: [], findings: [], game_plan: { course: 'c', evidence: [{ refs, fact }] } }, [record]).problems.filter((p: any) => p.where === 'plan_evidence');
    expect(ev(['roshan:beastmaster'], '32:18 对面打掉肉山。')).not.toEqual([]);
    expect(ev(['roshan:beastmaster:1'], '32:18 对面打掉肉山，36:43 盾用掉。')).toEqual([]);
    expect(KNOWLEDGE_TOOLS).toContain(ROSHAN_TOOL);
    expect(deepReviewSystem('zh')).toContain('roshan_report for the player');
    expect(deepReviewSystem('zh')).toMatch(/never say a side took no Roshan/);
    expect(chatSystem('zh')).toContain('roshan_report for the player');
  });

  it('the other tools\' Roshan gap points at roshan_report, and the prompt no longer forbids Roshan timings (a real review put a known Roshan among its blind spots)', () => {
    const kit = reviewToolkit({ trace, hero: 'beastmaster', lang: 'zh' })!;
    const gap = kit.runTool('match_overview', {}).gaps.find((g: any) => g.topic === 'roshan');
    expect(gap.reason).toMatch(/roshan_report reads each Roshan from the Aegis pickup/);
    expect(kit.runTool('roshan_report', { hero: 'beastmaster' }).gaps.find((g: any) => g.topic === 'roshan').reason).toMatch(/a take is an Aegis pickup/);
    const system = deepReviewSystem('zh');
    expect(system).toContain('6c. Always call roshan_report for the player');
    expect(system).toContain('Roshan is not a blind spot when it lists a take');
    expect(system).not.toMatch(/Roshan timings/);
    expect(chatSystem('zh')).toContain('Roshan is known from roshan_report');
  });

  it('the calibration script counts the Roshans and what followed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roshan-'));
    copyFileSync(FIXTURE, join(dir, '9100904020.trace.json.gz'));
    const out = JSON.parse(execFileSync('node', ['scripts/calibrate.mjs', dir, '--json'], { encoding: 'utf8' }));
    expect(out.roshans).toMatchObject({ takes: 1, aegis: { used: 1, expired: 0, game_ended: 0 }, buildings_in_the_next_300s: { taking_side: 1, other_side: 0 }, takes_with_no_building_after: 0 });
  });
});
