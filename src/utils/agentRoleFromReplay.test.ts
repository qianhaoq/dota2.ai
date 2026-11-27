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
    // build_check on poor pos-5 Disruptor gets role='support', pos=5 and economy GPM (estimated_minutes_of_my_farm on the
    // items pros build against a killer is checked in agentSituation.test.ts: this synthetic game has no deaths).
    const bc: any = buildCheck(tr, { hero: 'disruptor' }, { lang: 'en' });
    expect(bc).toMatchObject({ my_role: 'support', my_position: 5, role_source: 'replay', played_as: 'support' });
    expect(bc.my_economy).toMatchObject({ source: 'replay_gold_log', gold_per_min: expect.any(Number) });
    expect(bc.answers_to_top_killers).toEqual([]);
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

  it('uses a common scoreboard metric when some players lack last_hits and stays unknown when no shared metric exists (Codex P1 on #465)', () => {
    const legacy = synthGame({
      radiantCoords: [BOT, MID, TOP, TOP, BOT],
      direCoords: [TOP, MID, BOT, BOT, TOP],
      omitFarm: true,
    });
    // Dire heroes: sven(18), storm_spirit(17), beastmaster(38), undying(85), crystal_maiden(5).
    const players = [
      { hero_id: 18, last_hits: 300, gold_per_min: 620 },
      { hero_id: 17, last_hits: 250, gold_per_min: 560 },
      { hero_id: 38, gold_per_min: 480 }, // Beastmaster missing last_hits, has GPM -> all 5 share GPM!
      { hero_id: 85, last_hits: 60, gold_per_min: 310 },
      { hero_id: 5, last_hits: 40, gold_per_min: 280 },
    ];
    // Previously substituting 0 for missing last_hits dropped Beastmaster (480) below Undying (600+310=910) to pos 4.
    expect(roleFromReplay(legacy, 'beastmaster', { players })).toMatchObject({ pos: 3, kind: 'core', source: 'replay_lanes_and_scoreboard' });

    // If neither last_hits nor gold_per_min is present for all 5 teammates, role stays unknown (null).
    const splitMissing = players.map((p) => (p.hero_id === 85 ? { hero_id: 85, last_hits: 60 } : p));
    expect(roleFromReplay(legacy, 'beastmaster', { players: splitMissing })).toMatchObject({ pos: null, kind: null, gaps: ['no_farm_signal_in_trace'] });
  });

  it('keeps GPM unknown on net-worth-only traces and preserves 20-minute gold provenance & gaps (Codex P1 on #465)', () => {
    const nwOnly: any = synthGame({
      radiantCoords: [BOT, MID, TOP, TOP, BOT],
      direCoords: [TOP, MID, BOT, BOT, TOP],
      omitFarm: true,
    });
    nwOnly.net_worth = nwOnly.heroes.map((_: any, i: number) => Array.from({ length: 22 }, (_, m) => (i === 4 ? m * 250 : m * 500)));
    const bcNw: any = buildCheck(nwOnly, { hero: 'disruptor' }, { lang: 'en' });
    expect(bcNw.my_economy).toEqual({ source: 'replay_net_worth', gold_per_min: null, net_worth: 5250, net_worth_at_20_00: 5000 });
    expect(bcNw.gaps).toContainEqual({ topic: 'economy_gpm', reason: 'net_worth_only_not_income_rate' });

    // Unparsed scoreboard (GPM, no gold_t) + trace.gold -> gold_at_20_00 carries replay_gold_log provenance and passive-gold gap.
    const withGold = synthGame({
      radiantCoords: [BOT, MID, TOP, TOP, BOT],
      direCoords: [TOP, MID, BOT, BOT, TOP],
      lh: { phantom_assassin: 65, lina: 60, axe: 52, lion: 8, disruptor: 4 },
      gold: { phantom_assassin: 10000, lina: 9000, axe: 8000, lion: 4500, disruptor: 3500 },
    });
    const unparsedMatch = { duration: 1300, players: [{ hero_id: 87, gold_per_min: 320, net_worth: 6000 }] };
    const bcUnparsed: any = buildCheck(withGold, { hero: 'disruptor' }, { lang: 'en', match: unparsedMatch });
    expect(bcUnparsed.my_economy).toMatchObject({ source: 'match_record', gold_per_min: 320, gold_at_20_00: 3500, gold_at_20_00_source: 'replay_gold_log' });
    expect(bcUnparsed.gaps).toContainEqual({ topic: 'economy', reason: 'passive_gold_not_in_replay_gold_log' });

    // Unparsed scoreboard (GPM, no gold_t) + net_worth only (no trace.gold) -> gold_at_20_00 stays null, net_worth_at_20_00 labeled separately.
    const bcScoreNw: any = buildCheck(nwOnly, { hero: 'disruptor' }, { lang: 'en', match: unparsedMatch });
    expect(bcScoreNw.my_economy).toEqual({ source: 'match_record', gold_per_min: 320, net_worth: 6000, gold_at_20_00: null, net_worth_at_20_00: 5000 });
  });

  it('rejects incomparable creep_kills rows lacking running counts and rejects sparse net_worth graphs (Codex P1 on #465)', () => {
    // 1. One hero's creep_kills rows lack r[3] running last-hit count while teammates have it -> never mix logged count vs running LH.
    const mixed: any = synthGame({
      radiantCoords: [BOT, MID, TOP, TOP, BOT],
      direCoords: [TOP, MID, BOT, BOT, TOP],
      omitFarm: true,
    });
    mixed.creep_kills = [
      [550, 0, 'l', 60, 3000],
      [550, 1, 'l', 55, 3000],
      [550, 2, 'l', null, 3000], // Axe missing running LH count
      [550, 3, 'l', 8, 1200],
      [550, 4, 'l', 5, 1000],
    ];
    // Without another farm signal -> stays unknown rather than dropping Axe below Lion.
    expect(roleFromReplay(mixed, 'axe')).toMatchObject({ pos: null, kind: null, gaps: ['no_farm_signal_in_trace'] });
    // With trace.gold available -> falls through cleanly to uniform gold signal.
    mixed.gold = [
      [5, 0, 13, 2800], [5, 1, 13, 2500], [5, 2, 13, 2200], [5, 3, 13, 600], [5, 4, 13, 400],
    ];
    expect(roleFromReplay(mixed, 'axe')).toMatchObject({ pos: 3, kind: 'core', source: 'replay' });

    // 2. Sparse net_worth metadata graph (40-min game with only 15 points) fails netWorthGraph cadence check -> unknown (not misread as minute 10).
    const sparse: any = synthGame({
      radiantCoords: [BOT, MID, TOP, TOP, BOT],
      direCoords: [TOP, MID, BOT, BOT, TOP],
      omitFarm: true,
    });
    sparse.n = 2400; // 40 min -> game = 41 points expected, 15 points rejected by netWorthGraph
    sparse.net_worth = sparse.heroes.map((_: any, i: number) => Array.from({ length: 15 }, (_, m) => (i === 4 ? m * 100 : m * 500)));
    expect(roleFromReplay(sparse, 'phantom_assassin')).toMatchObject({ pos: null, kind: null, gaps: ['no_farm_signal_in_trace'] });

    // Proper per-minute cadence net_worth with minute 10 present succeeds.
    const dense = { ...sparse, net_worth: sparse.heroes.map((_: any, i: number) => Array.from({ length: 41 }, (_, m) => (i === 4 || i === 3 || i === 8 || i === 9 ? m * 150 : m * 450))) };
    expect(roleFromReplay(dense, 'phantom_assassin')).toMatchObject({ pos: 1, kind: 'core', source: 'replay' });
    expect(roleFromReplay(dense, 'disruptor')).toMatchObject({ pos: 5, kind: 'support', source: 'replay' });
  });
});
