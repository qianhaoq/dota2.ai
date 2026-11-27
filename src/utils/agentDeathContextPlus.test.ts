import { describe, expect, it } from 'vitest';
import { runTraceTool } from '../../packages/review-engine/src/trace/index.js';
import { ultimateOf } from '../../lib/agent/ultimates.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { evaluateHabit, habitGoal } from '../../lib/coach/goals.js';

function makeTrace(overrides: any = {}) {
  const n = overrides.n ?? 400;
  const heroes = overrides.heroes ?? [
    { key: 'enchantress', npc: 'npc_dota_hero_enchantress', team: 2, player_index: 0 },
    { key: 'sven', npc: 'npc_dota_hero_sven', team: 2, player_index: 1 },
    { key: 'lion', npc: 'npc_dota_hero_lion', team: 3, player_index: 5 },
    { key: 'tidehunter', npc: 'npc_dota_hero_tidehunter', team: 3, player_index: 6 },
    { key: 'lina', npc: 'npc_dota_hero_lina', team: 3, player_index: 7 },
  ];
  const names = [
    ...heroes.map((h: any) => h.npc),
    ...(overrides.extraNames ?? []),
  ];
  const pos = overrides.pos ?? {};
  const dead = overrides.dead ?? {};
  const states = heroes.map((h: any) => {
    const p = pos[h.key] ?? [0, 0];
    const ranges: [number, number][] = dead[h.key] ?? [];
    const alive = Array.from({ length: n }, (_, s) => (ranges.some(([a, b]) => s >= a && s < b) ? 0 : 1));
    return {
      x: Array(n).fill(p[0]),
      y: Array(n).fill(p[1]),
      hp: Array(n).fill(900),
      max_hp: Array(n).fill(1000),
      mana: Array(n).fill(400),
      mana_peak: Array(n).fill(400),
      level: Array(n).fill(10),
      alive,
    };
  });
  return {
    schema: 'dota2.ai/match-trace@1',
    match_id: 9106163189,
    t0: 0,
    n,
    heroes,
    names,
    states,
    abilities: overrides.abilities ?? heroes.map(() => ({})),
    items: overrides.items ?? heroes.map(() => ({})),
    controls: overrides.controls ?? heroes.map(() => ({})),
    casts: overrides.casts ?? [],
    item_uses: overrides.item_uses ?? [],
    purchases: overrides.purchases ?? [],
    buildings: overrides.buildings ?? [],
    modifiers: overrides.modifiers ?? [],
    damage: overrides.damage ?? [],
    deaths: overrides.deaths ?? [],
    buybacks: overrides.buybacks ?? [],
    gaps: overrides.gaps ?? [],
    ...(overrides.roshan_damage ? { roshan_damage: overrides.roshan_damage } : {}),
    ...(overrides.roshan_kills ? { roshan_kills: overrides.roshan_kills } : {}),
  };
}

describe('death_context & ability_audit P1-1 enhancements', () => {
  it('attack modifiers (Enchantress Impetus, etc.) are never flagged as 0 casts or ready_not_cast', () => {
    const extraNames = ['enchantress_impetus', 'enchantress_enchant', 'some_future_orb'];
    const tr = makeTrace({
      extraNames,
      abilities: [
        {
          enchantress_impetus: { levels: [[10, 1]], cd: [[20, 26, 6]], mana: 55, costs: [[10, 55]] },
          enchantress_enchant: { levels: [[10, 1]], cd: [], mana: 70, costs: [[10, 70]] },
          some_future_orb: { levels: [[10, 1]], cd: [], mana: 30, costs: [[10, 30]] },
        },
        {}, {}, {}, {},
      ],
      // Impetus and some_future_orb deal damage with 0 cast rows; enchant has 0 cast rows and 0 damage rows (genuinely unpressed active).
      damage: [
        [50, 0, 2, 5, 180], // enchantress -> lion via enchantress_impetus
        [55, 0, 2, 5, 220],
        [60, 0, 2, 7, 140], // enchantress -> lion via some_future_orb
        [98, 2, 0, -1, 900],
      ],
      deaths: [[100, 0, 2, 1]],
    });
    const dc: any = runTraceTool(tr, 'death_context', { hero: 'enchantress' }, { ultimateOf });
    expect(dc.deaths[0].ready_not_cast).toEqual(['enchantress_enchant']);
    expect(dc.deaths[0].ready_not_cast).not.toContain('enchantress_impetus');
    expect(dc.deaths[0].ready_not_cast).not.toContain('some_future_orb');

    const imp: any = runTraceTool(tr, 'ability_audit', { hero: 'enchantress', ability: 'impetus' });
    expect(imp).toMatchObject({
      casts_logged: false,
      casts_total: null,
      deaths_with_it_ready_and_not_cast_total: null,
      deaths_with_it_ready_and_not_cast: null,
      damage_to_enemy_heroes_total: 400,
      damage_to_enemy_heroes_seconds: 2,
      casts: null,
    });
    expect(imp.gaps.some((g: any) => g.topic === 'ability_casts')).toBe(true);
    // Goal evaluation never calls an unlogged attack modifier "never cast" or builds a bogus died_holding goal.
    expect(habitGoal('died_holding', imp, { hero: 'enchantress', hero_id: 58, ability: 'enchantress_impetus', name: { en: 'Impetus', zh: '推进' } })).toBeNull();
    expect(evaluateHabit({ kind: 'replay_habit', habit: 'died_holding', max: 1, name: { en: 'Impetus', zh: '推进' } }, imp, 30).result).toBe('unknown');
    // Evidence ref for a cast on an unlogged ability safely returns null instead of throwing.
    expect(resolveRef(tr, 'cast:enchantress:impetus:1', { hero: 'enchantress', lang: 'zh' })).toBeNull();
  });

  it('Undying Ceaseless Dirge reports triggered_on_death in ability_audit without hiding real deaths', () => {
    const heroes = [
      { key: 'undying', npc: 'npc_dota_hero_undying', team: 2, player_index: 0 },
      { key: 'lion', npc: 'npc_dota_hero_lion', team: 3, player_index: 5 },
    ];
    const tr = makeTrace({
      n: 1200,
      heroes,
      extraNames: ['undying_ceaseless_dirge'],
      abilities: [
        {
          undying_ceaseless_dirge: {
            levels: [[0.1, 1]],
            // Game-start cooldown [0.1, 390, 389.9], then triggers on the death at 765.1.
            cd: [[0.1, 390, 389.9], [765.2, 1199, 479.9]],
          },
        },
        {},
      ],
      deaths: [[300, 0, 1, 1], [765.1, 0, 1, 2]],
    });
    const dc: any = runTraceTool(tr, 'death_context', { hero: 'undying' });
    // Instant fountain respawn is still a real death on the scoreboard.
    expect(dc.deaths_total).toBe(2);
    const audit: any = runTraceTool(tr, 'ability_audit', { hero: 'undying', ability: 'ceaseless_dirge' });
    expect(audit).toMatchObject({
      triggered_on_death_total: 1,
      triggered_on_death: ['12:45'],
      deaths_with_it_ready_and_not_cast_total: 0,
      deaths_with_it_ready_and_not_cast: [],
    });
  });

  it('detects nearby_fight (pre-fight within 30 s) and respects unknown positions as null', () => {
    const tr = makeTrace({
      pos: { enchantress: [100, 100], sven: [300, 200], lion: [200, 150], tidehunter: [250, 100], lina: [220, 120] },
      // Enchantress dies at 100; a 3-death fight starts (first damage at 120, deaths at 125, 128, 130) nearby.
      damage: [[120, 1, 2, -1, 500], [122, 2, 1, -1, 600]],
      deaths: [
        [100, 0, 2, 1], // pre-fight pick (20 s before engaged_at=120, outside FIGHT_GAP=15 so not in fight.deaths)
        [125, 1, 2, 2],
        [128, 2, 1, 3],
        [130, 3, 1, 4],
      ],
    });
    const dc: any = runTraceTool(tr, 'death_context', { hero: 'enchantress' }, { ultimateOf });
    expect(dc.deaths[0].in_a_fight).toBe(false);
    expect(dc.deaths[0].nearby_fight).toMatchObject({
      ref: 'fight:1',
      relation: 'before_fight',
      seconds_to_engaged: 20,
      my_team_deaths: 1,
      enemy_deaths: 2,
    });
    expect(dc.deaths_where.before_a_nearby_fight_within_30s).toEqual(['1:40']);

    // Blank Enchantress's position around t=99 -> nearby_fight must be null (unknown, never false).
    for (let s = 95; s <= 105; s += 1) { tr.states[0].x[s] = null; tr.states[0].y[s] = null; }
    const blanked: any = runTraceTool(tr, 'death_context', { hero: 'enchantress' }, { ultimateOf });
    expect(blanked.deaths[0].nearby_fight).toBeNull();
    expect(blanked.deaths_not_known.before_a_nearby_fight_within_30s).toBe(1);
    expect(blanked.deaths_where.before_a_nearby_fight_within_30s).toEqual([]);
  });

  it('distinguishes neutral/tower death without enemy hero damage from enemy summon kill and unknown damage log', () => {
    const tr = makeTrace({
      extraNames: ['npc_dota_neutral_tadpole', 'npc_dota_warlock_golem', 'npc_dota_badguys_tower1_bot'],
      damage: [
        [95, 5, 0, -1, 200], // neutral damage
        [195, 6, 0, -1, 300], // warlock golem (enemy summon)
        [295, 2, 0, -1, 150], // enemy hero damage before tower last hit
      ],
      deaths: [
        [100, 0, 5, 1], // pure neutral suicide -> true
        [200, 0, 6, 2], // enemy summon kill -> false
        [300, 0, 7, 3], // tower kill after enemy hero damage -> false
      ],
    });
    const dc: any = runTraceTool(tr, 'death_context', { hero: 'enchantress' });
    expect(dc.deaths.map((d: any) => [d.killer_kind, d.non_hero_death_without_enemy_hero_damage])).toEqual([
      ['neutral', true],
      ['other_unit', false],
      ['tower_or_fountain', false],
    ]);
    expect(dc.deaths_where.non_hero_without_enemy_hero_damage).toEqual(['1:40']);

    // Blank damage log -> unknown (null), never false.
    const noDmg = makeTrace({ extraNames: ['npc_dota_neutral_tadpole'], deaths: [[100, 0, 5, 1]] });
    (noDmg as any).damage = undefined;
    const out: any = runTraceTool(noDmg, 'death_context', { hero: 'enchantress' });
    expect(out.deaths[0].non_hero_death_without_enemy_hero_damage).toBeNull();
    expect(out.deaths_not_known.non_hero_without_enemy_hero_damage).toBe(1);
  });

  it('records absorbed enemy ultimates, merged disable seconds, nearby objective, and allies surviving 10 s (with null on blank sources)', () => {
    const tr = makeTrace({
      pos: { enchantress: [100, 100], sven: [500, 100], lion: [200, 100], tidehunter: [250, 100], lina: [300, 100] },
      extraNames: ['lion_finger_of_death', 'tidehunter_ravage', 'npc_dota_badguys_tower1_mid'],
      controls: [
        { stunned: [[92, 95], [94, 97]], rooted: [[96, 98]] }, // merged [92, 98] = 6.0 s
        {}, {}, {}, {},
      ],
      casts: [[95, 2, 5, 0, 10]], // lion casts finger_of_death on enchantress
      damage: [
        [94, 3, 0, 6, 400], // tidehunter deals ravage damage to enchantress
        [95, 2, 0, 5, 600],
        [105, 1, 7, -1, 300], // sven hits enemy mid T1 tower nearby 5 s after death
      ],
      deaths: [[100, 0, 2, 1]],
    });
    const dc: any = runTraceTool(tr, 'death_context', { hero: 'enchantress' }, { ultimateOf });
    const d = dc.deaths[0];
    expect(d.disable_seconds_in_window).toBe(6);
    expect(d.enemy_ultimates_absorbed).toEqual([
      { hero: 'lion', ability: 'lion_finger_of_death' },
      { hero: 'tidehunter', ability: 'tidehunter_ravage' },
    ]);
    expect(d.allies_near_who_survived_10s).toEqual(['sven']);
    expect(d.nearby_objective).toMatchObject({ kind: 'building', building: 'badguys_tower1_mid', side: 'enemy' });
    expect(dc.deaths_where.absorbed_enemy_ultimate).toEqual(['1:40']);

    // Without ultimateOf in ctx -> enemy_ultimates_absorbed is null (unknown, never []).
    const noUltCtx: any = runTraceTool(tr, 'death_context', { hero: 'enchantress' });
    expect(noUltCtx.deaths[0].enemy_ultimates_absorbed).toBeNull();
    expect(noUltCtx.deaths_not_known.absorbed_enemy_ultimate).toBe(1);

    // Evidence resolution populates localized names for absorbed enemy ultimates.
    const ev = resolveRef(tr, 'death:enchantress:1', { hero: 'enchantress', lang: 'zh' });
    expect(ev?.record.enemy_ultimates_absorbed).toHaveLength(2);
    expect(ev?.names.lion_finger_of_death).toBe('死亡之指');
    expect(ev?.names.tidehunter_ravage).toBe('毁灭');
  });

  it('does not label an isolated cross-map death in the same 15 s window as in_fight, and keeps nearby_objective null when Roshan logs are absent (Codex P1 on #464)', () => {
    const tr = makeTrace({
      // Enchantress dies alone at (-6000, -6000) while 2 other deaths happen at (4000, 4000) within 5 s.
      pos: { enchantress: [-6000, -6000], sven: [4000, 4000], lion: [4100, 4000], tidehunter: [4050, 4050], lina: [4150, 3950] },
      deaths: [
        [100, 0, 2, 1],
        [103, 1, 3, 2],
        [105, 3, 1, 3],
      ],
    });
    const dc: any = runTraceTool(tr, 'death_context', { hero: 'enchantress' }, { ultimateOf });
    expect(dc.deaths[0].in_a_fight).toBe(false);
    expect(dc.deaths[0].nearby_fight).toBe(false);
    // Older trace without roshan_kills / roshan_damage cannot rule out Roshan -> nearby_objective must be null, not false.
    expect(dc.deaths[0].nearby_objective).toBeNull();

    // Modern trace with empty Roshan logs (and no nearby building activity) can establish false.
    const modern = makeTrace({
      pos: { enchantress: [-6000, -6000], sven: [4000, 4000], lion: [4100, 4000], tidehunter: [4050, 4050], lina: [4150, 3950] },
      roshan_kills: [],
      roshan_damage: [],
      deaths: [[100, 0, 2, 1]],
    });
    expect((runTraceTool(modern, 'death_context', { hero: 'enchantress' }, { ultimateOf }) as any).deaths[0].nearby_objective).toBe(false);
  });
});
