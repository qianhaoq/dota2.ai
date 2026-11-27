import { describe, expect, it } from 'vitest';
import { inferTeamRolesFromReplay, roleFromReplay } from '../../lib/agent/roleFromReplay.js';
import { buildCheck } from '../../lib/agent/situationTools.js';

// Coordinates inside each lane third (laneFromReplay: d = y - x; |d|<2200 mid(2), d>0 top(3), d<0 bot(1), outside base).
const BOT: [number, number] = [3000, -3000]; // lane 1 (Radiant safe, Dire off)
const MID: [number, number] = [0, 0];        // lane 2
const TOP: [number, number] = [-3000, 3000]; // lane 3 (Radiant off, Dire safe)

function synthGame({ radiantCoords, direCoords, lh = {}, gold = {}, wards = null, itemUses = [], blankHeroIdx = -1, omitFarm = false }: any) {
  const n = 1300;
  const heroes = [
    { key: 'phantom_assassin', npc: 'npc_dota_hero_phantom_assassin', team: 2, player_index: 0 },
    { key: 'lina', npc: 'npc_dota_hero_lina', team: 2, player_index: 1 },
    { key: 'axe', npc: 'npc_dota_hero_axe', team: 2, player_index: 2 },
    { key: 'lion', npc: 'npc_dota_hero_lion', team: 2, player_index: 3 },
    { key: 'disruptor', npc: 'npc_dota_hero_disruptor', team: 2, player_index: 4 },
    { key: 'sven', npc: 'npc_dota_hero_sven', team: 3, player_index: 5 },
    { key: 'storm_spirit', npc: 'npc_dota_hero_storm_spirit', team: 3, player_index: 6 },
    { key: 'beastmaster', npc: 'npc_dota_hero_beastmaster', team: 3, player_index: 7 },
    { key: 'undying', npc: 'npc_dota_hero_undying', team: 3, player_index: 8 },
    { key: 'crystal_maiden', npc: 'npc_dota_hero_crystal_maiden', team: 3, player_index: 9 },
  ];
  const names = [...heroes.map((h) => h.npc), 'item_ward_observer'];
  const coords = [...radiantCoords, ...direCoords];
  const states = heroes.map((_, i) => ({
    x: Array(n).fill(i === blankHeroIdx ? null : coords[i][0]),
    y: Array(n).fill(i === blankHeroIdx ? null : coords[i][1]),
    hp: Array(n).fill(1000),
    max_hp: Array(n).fill(1000),
    mana: Array(n).fill(400),
    mana_peak: Array(n).fill(400),
    level: Array(n).fill(12),
    alive: Array(n).fill(i === blankHeroIdx ? null : 1),
  }));
  const creep_kills: any[] = [];
  const goldRows: any[] = [];
  heroes.forEach((h, i) => {
    const c = lh[h.key] ?? 0;
    if (c > 0) creep_kills.push([550, i, 'l', c, 3000]);
    const g = gold[h.key] ?? 0;
    if (g > 0) {
      goldRows.push([5, i, 13, Math.round(g * 0.4)]);
      goldRows.push([15, i, 13, Math.round(g * 0.6)]);
    }
  });
  return {
    schema: 'dota2.ai/match-trace@1',
    match_id: 9109999999,
    t0: 0,
    n,
    heroes,
    names,
    states,
    abilities: heroes.map(() => ({})),
    items: heroes.map(() => ({})),
    controls: heroes.map(() => ({})),
    casts: [],
    item_uses: itemUses,
    purchases: [],
    buildings: [],
    modifiers: [],
    damage: [],
    deaths: [],
    buybacks: [],
    gaps: [],
    ...(omitFarm ? {} : { creep_kills, gold: goldRows }),
    ...(wards ? { wards } : {}),
  };
}

describe('roleFromReplay (P1-2)', () => {
  it('infers exact 1–5 positions on Radiant (bot=safe, top=off) and Dire (top=safe, bot=off) from replay alone', () => {
    const tr = synthGame({
      radiantCoords: [BOT, MID, TOP, TOP, BOT], // PA+Disruptor bot (safe), Lina mid, Axe+Lion top (off)
      direCoords: [TOP, MID, BOT, BOT, TOP],    // Sven+CM top (safe), Storm mid, BM+Undying bot (off)
      lh: { phantom_assassin: 65, lina: 60, axe: 52, lion: 8, disruptor: 4, sven: 70, storm_spirit: 58, beastmaster: 48, undying: 10, crystal_maiden: 5 },
      gold: { phantom_assassin: 10000, lina: 9000, axe: 8000, lion: 4500, disruptor: 3500, sven: 11000, storm_spirit: 9500, beastmaster: 8200, undying: 5000, crystal_maiden: 3800 },
    });
    const rad = inferTeamRolesFromReplay(tr, 2);
    expect(rad.gaps).toEqual([]);
    expect([...rad.roles!.entries()].map(([i, r]) => [tr.heroes[i].key, r.pos, r.kind, r.confidence])).toEqual([
      ['phantom_assassin', 1, 'core', 'high'],
      ['lina', 2, 'core', 'high'],
      ['axe', 3, 'core', 'high'],
      ['disruptor', 5, 'support', 'high'],
      ['lion', 4, 'support', 'high'],
    ]);
    const dire = inferTeamRolesFromReplay(tr, 3);
    expect([...dire.roles!.entries()].map(([i, r]) => [tr.heroes[i].key, r.pos, r.kind])).toEqual([
      ['sven', 1, 'core'],
      ['storm_spirit', 2, 'core'],
      ['beastmaster', 3, 'core'],
      ['crystal_maiden', 5, 'support'],
      ['undying', 4, 'support'],
    ]);
    // build_check on poor pos-5 Disruptor gets role='support', pos=5, economy GPM, and estimated_minutes_of_my_farm on answer items.
    const bc: any = buildCheck(tr, { hero: 'disruptor' }, { lang: 'en' });
    expect(bc).toMatchObject({ my_role: 'support', my_position: 5, role_source: 'replay', played_as: 'support' });
    expect(bc.my_economy).toMatchObject({ source: 'replay_gold_log', gold_per_min: expect.any(Number) });
    const glimmer = bc.items_that_answer_spell_damage.find((i: any) => i.item === 'glimmer_cape');
    const pipe = bc.items_that_answer_spell_damage.find((i: any) => i.item === 'pipe');
    expect(glimmer.estimated_minutes_of_my_farm).toBeLessThan(pipe.estimated_minutes_of_my_farm);
    // Cheap support save items precede expensive aura items like Pipe in magic.support.
    expect(bc.items_that_answer_spell_damage.indexOf(glimmer)).toBeLessThan(bc.items_that_answer_spell_damage.indexOf(pipe));
  });

  it('uses observer wards as tie-breaker when two lane partners have identical early farm', () => {
    const tr = synthGame({
      radiantCoords: [BOT, MID, TOP, TOP, BOT],
      direCoords: [TOP, MID, BOT, BOT, TOP],
      lh: { phantom_assassin: 30, lina: 60, axe: 50, lion: 8, disruptor: 30 },
      // Disruptor placed 2 observer wards, PA placed 0 -> PA is pos 1, Disruptor is pos 5.
      wards: [[100, 460, 2, 'o', 0, 0], [300, 660, 2, 'o', 100, 100]],
      itemUses: [[100, 4, 10, 1], [300, 4, 10, 2]],
    });
    expect(roleFromReplay(tr, 'phantom_assassin')).toMatchObject({ pos: 1, kind: 'core' });
    expect(roleFromReplay(tr, 'disruptor')).toMatchObject({ pos: 5, kind: 'support' });
  });

  it('keeps unknown as null with gaps when positions or farm signals are blanked', () => {
    const noPos = synthGame({
      radiantCoords: [BOT, MID, TOP, TOP, BOT],
      direCoords: [TOP, MID, BOT, BOT, TOP],
      lh: { phantom_assassin: 60 },
      blankHeroIdx: 4, // Disruptor's positions blanked -> Radiant roles unknown
    });
    expect(roleFromReplay(noPos, 'phantom_assassin')).toMatchObject({ pos: null, kind: null, gaps: ['positions_not_known'] });
    // Dire still has all 5 positions sampled -> Dire roles are unaffected!
    expect(roleFromReplay(noPos, 'beastmaster')).toMatchObject({ pos: 3, kind: 'core' });

    const noFarm = synthGame({
      radiantCoords: [BOT, MID, TOP, TOP, BOT],
      direCoords: [TOP, MID, BOT, BOT, TOP],
      omitFarm: true,
    });
    expect(roleFromReplay(noFarm, 'phantom_assassin')).toMatchObject({ pos: null, kind: null, gaps: ['no_farm_signal_in_trace'] });
  });
});
