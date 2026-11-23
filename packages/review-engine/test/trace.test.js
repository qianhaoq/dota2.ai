import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createTraceBuilder, TRACE_SCHEMA, TRACE_TOOLS, runTraceTool, traceSeconds, traceRegion } from '../src/trace/index.js';

/**
 * A real ranked game (9100904020, Beastmaster on Dire, lost in 42:31), built
 * from its replay by scripts/build-trace.mjs. The numbers asserted below were
 * first read off the raw combat log by hand; they are what a reviewer needs
 * the tools to get right.
 */
const trace = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/trace-9100904020.json.gz', import.meta.url))));
const run = (name, args) => runTraceTool(trace, name, args);

describe('trace builder', () => {
  const state = (t, hero, team, extra = {}) => ({ entity_kind: 'real_hero', t, hero, team, player_index: team === 2 ? 0 : 5, x: 100.4, y: -200.6, hp: 500, max_hp: 600, mana: 99.6, level: 3, life_state: 0, abilities: [], items: [], controls: {}, ...extra });
  const ev = (type, t, extra = {}) => ({ type, t, attacker: 'npc_dota_hero_axe', attacker_hero: true, attacker_illusion: false, target: 'npc_dota_hero_lina', target_hero: true, target_illusion: false, inflictor: 'dota_unknown', ...extra });

  it('keeps one sample a second and turns cooldowns, items and controls into intervals', () => {
    const b = createTraceBuilder();
    for (let i = 0; i <= 40; i += 1) {
      const t = i * 0.25;
      b.addState(state(t, 'axe', 2, {
        abilities: [{ name: 'axe_berserkers_call', level: t >= 2 ? 1 : 0, cooldown: t >= 3 && t < 7 ? 7 - t : 0 }, { name: 'special_bonus_x', level: 1, cooldown: 0 }],
        items: [{ name: 'item_blink', slot: 0, cooldown: t >= 5 && t < 6 ? 1 : 0 }, { name: 'item_tango', slot: 7, cooldown: 0 }],
        controls: { stunned: t >= 8 && t < 9, silenced: false },
        life_state: t >= 9.5 ? 2 : 0,
      }));
      b.addState(state(t, 'lina', 3));
    }
    b.addState({ entity_kind: 'illusion', t: 1, hero: 'axe', team: 2 });
    b.addState(state(null, 'axe', 2));
    const tr = b.finish({ match_id: 7 });
    expect(tr.schema).toBe(TRACE_SCHEMA);
    expect(tr).toMatchObject({ match_id: 7, t0: 0, n: 11 });
    expect(tr.heroes).toEqual([{ key: 'axe', npc: 'npc_dota_hero_axe', team: 2, player_index: 0 }, { key: 'lina', npc: 'npc_dota_hero_lina', team: 3, player_index: 5 }]);
    expect(tr.states[0].x[0]).toBe(100);
    expect(tr.states[0].mana[4]).toBe(100);
    expect(tr.states[0].alive.slice(8)).toEqual([1, 1, 0]);
    // A cooldown interval keeps the seconds left when it began (4 at t=3).
    expect(tr.abilities[0]).toEqual({ axe_berserkers_call: { levels: [[2, 1]], cd: [[3, 7, 4]] } });
    // Backpack items are not held; the item on cooldown gets its interval.
    expect(tr.items[0]).toEqual({ item_blink: { held: [[0, 10]], cd: [[5, 6, 1]] } });
    expect(tr.controls[0]).toEqual({ stunned: [[8, 9]] });
  });

  it('keeps the hero-relevant combat log and sums damage per second', () => {
    const b = createTraceBuilder();
    b.addEvent(ev('DOTA_COMBATLOG_ABILITY', 10.04, { inflictor: 'axe_berserkers_call', target: 'dota_unknown' }), 3);
    b.addEvent(ev('DOTA_COMBATLOG_ABILITY', 10.1, { attacker_illusion: true, inflictor: 'x' }), 4);
    b.addEvent(ev('DOTA_COMBATLOG_DAMAGE', 10.2, { value: 40 }), 5);
    b.addEvent(ev('DOTA_COMBATLOG_DAMAGE', 10.9, { value: 60 }), 6);
    b.addEvent(ev('DOTA_COMBATLOG_DAMAGE', 11.1, { value: 5, inflictor: 'axe_counter_helix' }), 7);
    b.addEvent(ev('DOTA_COMBATLOG_DAMAGE', 11.2, { value: 9, target: 'npc_dota_creep_badguys_melee', target_hero: false }), 8);
    b.addEvent(ev('DOTA_COMBATLOG_DAMAGE', 11.3, { value: 70, target: 'npc_dota_badguys_tower1_mid', target_hero: false }), 9);
    b.addEvent(ev('DOTA_COMBATLOG_MODIFIER_ADD', 12, { inflictor: 'modifier_black_king_bar_immune', target: 'npc_dota_hero_axe' }), 10);
    b.addEvent(ev('DOTA_COMBATLOG_MODIFIER_ADD', 12, { inflictor: 'modifier_axe_berserkers_call', stun_duration: 2.4 }), 11);
    b.addEvent(ev('DOTA_COMBATLOG_MODIFIER_ADD', 12, { inflictor: 'modifier_phase_boots_active', target: 'npc_dota_hero_axe' }), 12);
    b.addEvent(ev('DOTA_COMBATLOG_MODIFIER_REMOVE', 14.4, { inflictor: 'modifier_axe_berserkers_call' }), 13);
    b.addEvent(ev('DOTA_COMBATLOG_DEATH', 15, {}), 14);
    b.addEvent(ev('DOTA_COMBATLOG_DEATH', 15, { target_illusion: true }), 15);
    b.addEvent(ev('DOTA_COMBATLOG_TEAM_BUILDING_KILL', 16, { target: 'npc_dota_badguys_tower1_mid', attacker: 'dota_unknown', attacker_team: 2, target_hero: false }), 16);
    b.addEvent(ev('DOTA_COMBATLOG_PURCHASE', -80, { attacker: 'dota_unknown', attacker_hero: false, value_name: 'item_blink' }), 17);
    b.addEvent({ type: 'DOTA_COMBATLOG_GOLD', t: 1 }, 18);
    b.addEvent(null, 19);
    const tr = b.finish();
    const n = (i) => tr.names[i];
    expect(tr.casts.map((c) => [c[0], n(c[1]), n(c[2]), c[3], c[4]])).toEqual([[10, 'npc_dota_hero_axe', 'axe_berserkers_call', -1, 3]]);
    expect(tr.damage.map((d) => [d[0], n(d[2]), d[3] < 0 ? null : n(d[3]), d[4]])).toEqual([[10, 'npc_dota_hero_lina', null, 100], [11, 'npc_dota_hero_lina', 'axe_counter_helix', 5], [11, 'npc_dota_badguys_tower1_mid', null, 70]]);
    expect(tr.modifiers.map((m) => [n(m[2]), m[4], m[5], m[6]])).toEqual([['modifier_black_king_bar_immune', 1, 0, 'i'], ['modifier_axe_berserkers_call', 1, 2.4, 't']]);
    expect(tr.deaths).toHaveLength(1);
    expect(tr.buildings.map((x) => [n(x[1]), x[2], x[3]])).toEqual([['npc_dota_badguys_tower1_mid', 2, 16]]);
    expect(tr.purchases.map((p) => [p[0], n(p[1]), n(p[2])])).toEqual([[-80, 'npc_dota_hero_lina', 'item_blink']]);
    expect(tr.source.event_rows).toBe(17);
    expect(tr.gaps.map((g) => g.topic)).toEqual(['vision', 'creeps', 'roshan', 'ability_immunity', 'unused_free_abilities']);
  });
});

describe('review findings on #232', () => {
  const state = (t, extra = {}) => ({ entity_kind: 'real_hero', t, hero: 'axe', team: 2, player_index: 0, x: 0, y: 0, hp: 500, max_hp: 600, mana: 100, level: 6, life_state: 0, abilities: [], items: [], controls: {}, ...extra });
  const lina = (t) => ({ ...state(t), hero: 'lina', team: 3, player_index: 5 });

  it('time left on a cooldown is the sampled value counted down, not the distance to where the interval was cut', () => {
    const b = createTraceBuilder();
    // A 100 s cooldown, but the trace ends at t=10.
    for (let t = 0; t <= 10; t += 0.25) { b.addState(state(t, { abilities: [{ name: 'axe_culling_blade', level: 1, cooldown: 100 - t, mana_cost: 60 }] })); b.addState(lina(t)); }
    b.addEvent({ type: 'DOTA_COMBATLOG_DEATH', t: 9, target: 'npc_dota_hero_axe', target_hero: true, target_illusion: false, attacker: 'npc_dota_hero_lina', attacker_hero: true, attacker_illusion: false }, 1);
    const tr = b.finish();
    expect(tr.abilities[0].axe_culling_blade.cd).toEqual([[0, 10, 100]]);
    const d = runTraceTool(tr, 'death_context', { hero: 'axe', window: 4 }).deaths[0];
    expect(d.at_window_start.abilities).toEqual([{ ability: 'axe_culling_blade', level: 1, cooldown_left: 95, mana_cost: 60 }]);
    expect(d.ready_not_cast).toEqual([]);
  });

  it('a running cooldown that an effect cuts short counts down from the cut value', () => {
    const b = createTraceBuilder();
    // 100 s, cut to 35 at t=5 (a cooldown-reducing effect), then running on.
    for (let t = 0; t <= 10; t += 0.25) { b.addState(state(t, { abilities: [{ name: 'axe_culling_blade', level: 1, cooldown: t < 5 ? 100 - t : 35 - (t - 5), mana_cost: 60 }] })); b.addState(lina(t)); }
    b.addEvent({ type: 'DOTA_COMBATLOG_DEATH', t: 10, target: 'npc_dota_hero_axe', target_hero: true, target_illusion: false, attacker: 'npc_dota_hero_lina', attacker_hero: true, attacker_illusion: false }, 1);
    const tr = b.finish();
    expect(tr.abilities[0].axe_culling_blade.cd).toEqual([[0, 5, 100], [5, 10, 35]]);
    expect(runTraceTool(tr, 'death_context', { hero: 'axe', window: 4 }).deaths[0].at_window_start.abilities).toEqual([{ ability: 'axe_culling_blade', level: 1, cooldown_left: 34, mana_cost: 60 }]);
  });

  it('an active ability the player never pressed still shows as ready and not used', () => {
    const b = createTraceBuilder();
    for (let t = 0; t <= 30; t += 0.25) {
      b.addState(state(t, { abilities: [{ name: 'axe_berserkers_call', level: 1, cooldown: 0, mana_cost: 80 }, { name: 'axe_counter_helix', level: 1, cooldown: 0, mana_cost: 0 }] }));
      b.addState(lina(t));
    }
    b.addEvent({ type: 'DOTA_COMBATLOG_DEATH', t: 25, target: 'npc_dota_hero_axe', target_hero: true, target_illusion: false, attacker: 'npc_dota_hero_lina', attacker_hero: true, attacker_illusion: false }, 1);
    const out = runTraceTool(b.finish(), 'death_context', { hero: 'axe' });
    expect(out.deaths[0].at_window_start.abilities).toEqual([{ ability: 'axe_berserkers_call', level: 1, cooldown_left: 0, mana_cost: 80 }]);
    expect(out.deaths[0].ready_not_cast).toEqual(['axe_berserkers_call']);
    // The free one cannot be told from a passive: said, not guessed.
    expect(out.gaps.map((g) => g.topic)).toContain('unused_free_abilities');
  });

  it('a cast seconds before the immunity is not a cast during it', () => {
    const b = createTraceBuilder();
    for (let t = 0; t <= 12; t += 0.25) { b.addState(state(t, { abilities: [{ name: 'axe_culling_blade', level: 1, cooldown: t >= 3 && t < 8 ? 8 - t : 0, mana_cost: 60 }] })); b.addState(lina(t)); }
    const ev = (type, t, extra) => ({ type, t, attacker: 'npc_dota_hero_axe', attacker_hero: true, attacker_illusion: false, target: 'npc_dota_hero_lina', target_hero: true, target_illusion: false, ...extra });
    b.addEvent(ev('DOTA_COMBATLOG_ABILITY', 3, { inflictor: 'axe_culling_blade' }), 1);
    b.addEvent(ev('DOTA_COMBATLOG_MODIFIER_ADD', 5, { inflictor: 'modifier_black_king_bar_immune', attacker: 'npc_dota_hero_lina' }), 2);
    b.addEvent(ev('DOTA_COMBATLOG_ABILITY', 9, { inflictor: 'axe_culling_blade' }), 3);
    b.addEvent(ev('DOTA_COMBATLOG_MODIFIER_REMOVE', 9.5, { inflictor: 'modifier_black_king_bar_immune', attacker: 'npc_dota_hero_lina' }), 4);
    const w = runTraceTool(b.finish(), 'immunity_windows', { hero: 'lina', watch_hero: 'axe', watch_ability: 'culling_blade' }).windows[0].watched;
    expect(w.cast_on_this_hero_during).toEqual([{ t: 9, clock: '0:09', row: 3 }]);
    expect(w.cast_on_this_hero_in_the_3s_before).toEqual([{ t: 3, clock: '0:03', seconds_before: 2, row: 1 }]);
  });

  it('ability readiness is counted to the end of the game, not of the samples', () => {
    // The fixture's samples run 145 s past the Ancient's fall (42:31).
    expect(trace.t0 + trace.n - 1).toBeGreaterThan(2551 + 100);
    const a = run('ability_audit', { hero: 'beastmaster', ability: 'primal_roar' });
    expect(a.learned_at.t).toBe(450.1);
    // Alive seconds can be at most the game's seconds since the ability was learned.
    expect(a.seconds_alive_since_learned).toBeLessThanOrEqual(2551 - 450);
    expect(a.seconds_alive_and_ready).toBeLessThan(a.seconds_alive_since_learned);
  });

  it('a cast in the tenth of a second the immunity ended is after it, in both tools', () => {
    // Phantom Assassin's BKB is removed at 2373.6 (row 88320); Skywrath's Arcane Bolt on her is the next row, same rounded time.
    const w = run('immunity_windows', { hero: 'phantom_assassin', watch_hero: 'skywrath_mage', watch_ability: 'arcane_bolt' }).windows.find((x) => x.to === 2373.6);
    expect(w).toBeTruthy();
    expect(w.watched.cast_on_this_hero_during.map((c) => c.t)).not.toContain(2373.6);
    const bolt = run('ability_audit', { hero: 'skywrath_mage', ability: 'arcane_bolt' }).casts.find((c) => c.t === 2373.6 && c.target === 'phantom_assassin');
    expect(bolt.target_spell_immune).toBe(false);
  });

  it('a cast at an illusion is not a cast at the real hero', () => {
    const b = createTraceBuilder();
    for (let t = 0; t <= 12; t += 0.25) { b.addState(state(t, { abilities: [{ name: 'axe_culling_blade', level: 1, cooldown: 0, mana_cost: 60 }] })); b.addState(lina(t)); }
    const ev = (type, t, extra) => ({ type, t, attacker: 'npc_dota_hero_axe', attacker_hero: true, attacker_illusion: false, target: 'npc_dota_hero_lina', target_hero: true, target_illusion: false, ...extra });
    b.addEvent(ev('DOTA_COMBATLOG_MODIFIER_ADD', 2, { inflictor: 'modifier_black_king_bar_immune', attacker: 'npc_dota_hero_lina' }), 1);
    b.addEvent(ev('DOTA_COMBATLOG_ABILITY', 3, { inflictor: 'axe_culling_blade', target_illusion: true }), 2);
    b.addEvent(ev('DOTA_COMBATLOG_ABILITY', 4, { inflictor: 'axe_culling_blade' }), 3);
    b.addEvent(ev('DOTA_COMBATLOG_DEATH', 9, { attacker: 'npc_dota_hero_axe' }), 4);
    const tr = b.finish();
    const casts = runTraceTool(tr, 'ability_audit', { hero: 'axe', ability: 'culling_blade' }).casts;
    expect(casts.map((c) => [c.target, c.target_spell_immune, c.target_hp])).toEqual([['illusion:lina', null, null], ['lina', true, { hp: 500, max_hp: 600 }]]);
    expect(runTraceTool(tr, 'ability_audit', { hero: 'axe', ability: 'culling_blade' }).by_target).toEqual({ 'illusion:lina': 1, lina: 1 });
    // Only the cast at the real hero is a cast on her during her immunity, or a cast on her before she died.
    expect(runTraceTool(tr, 'immunity_windows', { hero: 'lina', watch_hero: 'axe', watch_ability: 'culling_blade' }).windows[0].watched.cast_on_this_hero_during.map((c) => c.t)).toEqual([4]);
    expect(runTraceTool(tr, 'death_context', { hero: 'lina' }).deaths[0].enemy_casts_on_me.map((c) => c.row)).toEqual([3]);
  });

  it('damage by an illusion is not damage by the hero', () => {
    const b = createTraceBuilder();
    for (let t = 0; t <= 12; t += 0.25) { b.addState(state(t)); b.addState(lina(t)); }
    const hit = (t, value, extra = {}) => ({ type: 'DOTA_COMBATLOG_DAMAGE', t, value, attacker: 'npc_dota_hero_lina', attacker_hero: true, attacker_illusion: false, target: 'npc_dota_hero_axe', target_hero: true, target_illusion: false, inflictor: 'dota_unknown', ...extra });
    b.addEvent(hit(5, 100), 1);
    b.addEvent(hit(5.2, 30, { attacker_illusion: true }), 2);
    b.addEvent({ type: 'DOTA_COMBATLOG_DEATH', t: 6, target: 'npc_dota_hero_axe', target_hero: true, target_illusion: false, attacker: 'npc_dota_hero_lina', attacker_hero: true, attacker_illusion: false }, 3);
    const tr = b.finish();
    expect(runTraceTool(tr, 'death_context', { hero: 'axe', window: 4 }).deaths[0].damage_taken).toEqual([{ from: 'lina', by: 'attack', value: 100 }, { from: 'illusion:lina', by: 'attack', value: 30 }]);
    expect(runTraceTool(tr, 'fight_timeline', { from: 0, to: 10 }).damage_to_heroes_by_unit).toEqual([{ unit: 'lina', value: 100 }, { unit: 'illusion:lina', value: 30 }]);
  });

  it('an ability that leaves the hero is no longer ready-and-unused', () => {
    const b = createTraceBuilder();
    for (let t = 0; t <= 30; t += 0.25) {
      b.addState(state(t, { abilities: [{ name: 'axe_berserkers_call', level: 1, cooldown: 0, mana_cost: 80 }, ...(t <= 4 ? [{ name: 'lina_laguna_blade', level: 1, cooldown: t >= 2 ? 50 - t : 0, mana_cost: 250 }] : [])] }));
      b.addState(lina(t));
    }
    b.addEvent({ type: 'DOTA_COMBATLOG_DEATH', t: 25, target: 'npc_dota_hero_axe', target_hero: true, target_illusion: false, attacker: 'npc_dota_hero_lina', attacker_hero: true, attacker_illusion: false }, 1);
    const tr = b.finish();
    expect(tr.abilities[0].lina_laguna_blade).toEqual({ levels: [[0, 1], [4.3, 0]], cd: [[2, 4.3, 48]], mana: 250, costs: [[1, 250]] });
    const d = runTraceTool(tr, 'death_context', { hero: 'axe' }).deaths[0];
    expect(d.at_window_start.abilities.map((a) => a.ability)).toEqual(['axe_berserkers_call']);
    expect(d.ready_not_cast).toEqual(['axe_berserkers_call']);
  });

  it('off cooldown without the mana for it is not ready: the cost is the one at the level it had then', () => {
    const run = (mana, extra = {}) => {
      const b = createTraceBuilder();
      for (let t = 0; t <= 60; t += 0.25) {
        // Level 1 costs 80 until 40 s, level 2 costs 110 after: the hero dies at 25 s, at level 1.
        b.addState(state(t, { mana, abilities: [{ name: 'axe_berserkers_call', level: t < 40 ? 1 : 2, cooldown: 0, mana_cost: t < 40 ? 80 : 110 }], ...extra }));
        b.addState(lina(t));
      }
      b.addEvent({ type: 'DOTA_COMBATLOG_DEATH', t: 25, target: 'npc_dota_hero_axe', target_hero: true, target_illusion: false, attacker: 'npc_dota_hero_lina', attacker_hero: true, attacker_illusion: false }, 1);
      return b.finish();
    };
    const poor = run(60);
    expect(poor.abilities[0].axe_berserkers_call).toMatchObject({ mana: 110, costs: [[1, 80], [2, 110]] });
    const d = runTraceTool(poor, 'death_context', { hero: 'axe' }).deaths[0];
    expect(d).toMatchObject({ most_mana_in_window: 60, ready_not_cast: [], off_cooldown_without_the_mana: ['axe_berserkers_call'] });
    expect(d.at_window_start.abilities[0].mana_cost).toBe(80);
    expect(runTraceTool(poor, 'ability_audit', { hero: 'axe', ability: 'berserkers_call' }).deaths_with_it_ready_and_not_cast_total).toBe(0);
    // 90 mana pays for level 1 (80), though not for the highest cost the game saw (110).
    const rich = run(90);
    expect(runTraceTool(rich, 'death_context', { hero: 'axe' }).deaths[0]).toMatchObject({ ready_not_cast: ['axe_berserkers_call'], off_cooldown_without_the_mana: [] });
    expect(runTraceTool(rich, 'ability_audit', { hero: 'axe', ability: 'berserkers_call' }).deaths_with_it_ready_and_not_cast_total).toBe(1);
    // Mana that was there for a quarter of a second between the kept samples was still there: 100 at 20.25 s pays for it.
    const spike = createTraceBuilder();
    for (let t = 0; t <= 30; t += 0.25) { spike.addState(state(t, { mana: t === 20.25 ? 100 : 60, abilities: [{ name: 'axe_berserkers_call', level: 1, cooldown: 0, mana_cost: 80 }] })); spike.addState(lina(t)); }
    spike.addEvent({ type: 'DOTA_COMBATLOG_DEATH', t: 25, target: 'npc_dota_hero_axe', target_hero: true, target_illusion: false, attacker: 'npc_dota_hero_lina', attacker_hero: true, attacker_illusion: false }, 1);
    const sp = spike.finish();
    expect(sp.states[0].mana[20]).toBe(60);
    expect(sp.states[0].mana_peak[20]).toBe(100);
    expect(runTraceTool(sp, 'death_context', { hero: 'axe' }).deaths[0]).toMatchObject({ most_mana_in_window: 100, ready_not_cast: ['axe_berserkers_call'], off_cooldown_without_the_mana: [] });
    expect(runTraceTool(sp, 'ability_audit', { hero: 'axe', ability: 'berserkers_call' }).deaths_with_it_ready_and_not_cast_total).toBe(1);
    // A trace that kept one sample a second cannot rule a peak out: nothing is moved out of "ready".
    const flat = run(60); delete flat.states[0].mana_peak;
    expect(runTraceTool(flat, 'death_context', { hero: 'axe' }).deaths[0]).toMatchObject({ most_mana_in_window: null, ready_not_cast: ['axe_berserkers_call'], off_cooldown_without_the_mana: [] });
    // A trace made before costs were kept per level: the cost at level 1 is unknown, and unknown is not "could not".
    const old = run(60); delete old.abilities[0].axe_berserkers_call.costs;
    const od = runTraceTool(old, 'death_context', { hero: 'axe' }).deaths[0];
    expect(od.at_window_start.abilities[0].mana_cost).toBeNull();
    expect(od).toMatchObject({ ready_not_cast: ['axe_berserkers_call'], off_cooldown_without_the_mana: [] });
  });

  it('a passive with a cooldown is not an unused ability', () => {
    // Counter Helix has a cooldown and no mana cost, and is never cast.
    const axe = run('death_context', { hero: 'axe' });
    expect(axe.deaths.length).toBeGreaterThan(5);
    for (const d of axe.deaths) expect(d.ready_not_cast).not.toContain('axe_counter_helix');
    expect(axe.deaths.some((d) => d.at_window_start.abilities.some((a) => a.ability === 'axe_berserkers_call'))).toBe(true);
  });

  it('an immunity with no logged end stays open: a later cast on that hero is during it', () => {
    const b = createTraceBuilder();
    for (let t = 0; t <= 12; t += 0.25) { b.addState(state(t, { abilities: [{ name: 'axe_culling_blade', level: 1, cooldown: 0, mana_cost: 60 }] })); b.addState(lina(t)); }
    const ev = (type, t, extra) => ({ type, t, attacker: 'npc_dota_hero_axe', attacker_hero: true, attacker_illusion: false, target: 'npc_dota_hero_lina', target_hero: true, target_illusion: false, ...extra });
    b.addEvent(ev('DOTA_COMBATLOG_MODIFIER_ADD', 5, { inflictor: 'modifier_black_king_bar_immune', attacker: 'npc_dota_hero_lina' }), 1);
    b.addEvent(ev('DOTA_COMBATLOG_ABILITY', 7, { inflictor: 'axe_culling_blade' }), 2);
    const tr = b.finish();
    const w = runTraceTool(tr, 'immunity_windows', { hero: 'lina', watch_hero: 'axe', watch_ability: 'culling_blade' }).windows[0];
    expect(w).toMatchObject({ to: null, seconds: null });
    expect(w.watched.cast_on_this_hero_during).toEqual([{ t: 7, clock: '0:07', row: 2 }]);
    // ability_audit reads the same cast the same way.
    expect(runTraceTool(tr, 'ability_audit', { hero: 'axe', ability: 'culling_blade' }).casts[0].target_spell_immune).toBe(true);
  });

  it('events in the same tenth of a second keep the combat log\'s order', () => {
    // Axe's Culling Blade on Sven (row 59214) comes before Sven's death (row 59236); both round to 27:48.4.
    const rows = run('fight_timeline', { from: '27:45', to: '27:50' }).events.filter((e) => e.clock === '27:48');
    const cull = rows.findIndex((e) => e.kind === 'cast' && e.ability === 'axe_culling_blade');
    const death = rows.findIndex((e) => e.kind === 'death' && e.hero === 'sven');
    expect(cull).toBeGreaterThanOrEqual(0);
    expect(cull).toBeLessThan(death);
    const all = run('fight_timeline', { from: '30:05', to: '31:00' }).events;
    for (let i = 1; i < all.length; i += 1) if (all[i].t === all[i - 1].t && all[i].row != null && all[i - 1].row != null) expect(all[i].row).toBeGreaterThan(all[i - 1].row);
  });
});

describe('trace helpers', () => {
  it('reads times and names regions', () => {
    expect([traceSeconds('30:11'), traceSeconds('-1:30'), traceSeconds(12.5), traceSeconds('90'), traceSeconds('1:75'), traceSeconds(''), traceSeconds(null)]).toEqual([1811, -90, 12.5, 90, null, null, null]);
    expect([traceRegion(6000, 6000), traceRegion(-6000, -6000), traceRegion(0, 0), traceRegion(-6600, 300), traceRegion(6100, -2200)]).toEqual(['dire_base', 'radiant_base', 'river_mid', 'radiant_top_lane', 'dire_bot_lane']);
  });
});

describe('trace tools on a real game', () => {
  it('lists the tools with JSON-schema inputs', () => {
    expect(TRACE_TOOLS.map((t) => t.name)).toEqual(['match_overview', 'death_context', 'ability_audit', 'immunity_windows', 'fight_timeline', 'item_timeline']);
    for (const t of TRACE_TOOLS) expect(t.input_schema).toMatchObject({ type: 'object', additionalProperties: false });
  });

  it('match_overview: the line-ups, the result, and the fight that turned the game', () => {
    const o = run('match_overview');
    expect(o).toMatchObject({ match_id: 9100904020, winner: 'radiant', duration: { clock: '42:31' } });
    expect(o.heroes.find((h) => h.hero === 'beastmaster')).toEqual({ hero: 'beastmaster', team: 'dire', deaths: 11, final_level: 21 });
    expect(o.heroes.filter((h) => h.team === 'radiant').map((h) => h.hero).sort()).toEqual(['axe', 'mirana', 'necrolyte', 'phantom_assassin', 'venomancer']);
    const wipe = o.fights.find((f) => f.clock.startsWith('30:'));
    expect(wipe).toMatchObject({ deaths: { radiant: 3, dire: 5 }, fewer_deaths: 'radiant' });
    expect(o.buildings.at(-1)).toMatchObject({ building: 'badguys_fort', taken_by: 'radiant' });
    // The trace has no gold: without the match's scoreboard this stays a stated gap.
    expect(o.gaps.map((g) => g.topic)).toContain('gold_advantage');
    expect(wipe).not.toHaveProperty('radiant_gold_adv_before');
    const adv = new Array(45).fill(0); adv[30] = 745; adv[32] = 4298;
    expect(runTraceTool(trace, 'match_overview', {}, { match: { radiant_gold_adv: adv } }).fights.find((f) => f.clock.startsWith('30:'))).toMatchObject({ radiant_gold_adv_before: 745, radiant_gold_adv_2min_after: 4298 });
  });

  it('ability_audit: ten Primal Roars, four on Phantom Assassin, three deaths with it ready', () => {
    const a = run('ability_audit', { hero: 'beastmaster', ability: 'primal_roar' });
    expect(a).toMatchObject({ ability: 'beastmaster_primal_roar', casts_total: 10, by_target: { phantom_assassin: 4, axe: 3, venomancer: 1, mirana: 1, necrolyte: 1 } });
    expect(a.deaths_with_it_ready_and_not_cast.map((d) => d.clock)).toEqual(['11:03', '36:05', '41:57']);
    expect(a.casts.filter((c) => c.target_spell_immune).map((c) => c.clock)).toEqual(['27:27', '37:56']);
    // The one that worked: cast into her Black King Bar, she died 11 seconds later.
    expect(a.casts.find((c) => c.clock === '27:27').deaths_within_12s.map((d) => d.hero)).toContain('phantom_assassin');
    // The one before the wipe: spent on a hero who died a second later.
    expect(a.casts.find((c) => c.clock === '30:25')).toMatchObject({ target: 'necrolyte', deaths_within_12s: expect.arrayContaining([expect.objectContaining({ hero: 'necrolyte', dt: 0.9 })]) });
    expect(a.seconds_alive_and_ready).toBeLessThan(a.seconds_alive_since_learned);
    // Hero prefix and spaces are both accepted.
    expect(run('ability_audit', { hero: 'Beastmaster', ability: 'beastmaster_primal_roar' }).casts_total).toBe(10);
  });

  it('immunity_windows: seven Black King Bars on Phantom Assassin, and where the roar was for each', () => {
    const w = run('immunity_windows', { hero: 'phantom_assassin', watch_hero: 'beastmaster', watch_ability: 'primal_roar' });
    expect(w.windows.map((x) => x.clock)).toEqual(['22:04', '27:27', '30:34', '33:37', '37:51', '39:26', '41:56']);
    expect(w.windows.map((x) => x.watched.state)).toEqual(['on_cooldown', 'ready', 'on_cooldown', 'on_cooldown', 'ready', 'dead', 'ready']);
    expect(w.windows[2].watched).toMatchObject({ last_cast: { clock: '30:25', target: 'necrolyte' }, cast_on_this_hero_during: [] });
    expect(w.windows[1].watched.cast_on_this_hero_during).toHaveLength(1);
    expect(w.windows[6].watched.cast_on_this_hero_during).toEqual([]);
    expect(run('immunity_windows', { team: 'dire' }).windows.every((x) => x.team === 'dire' && x.hero === 'sven')).toBe(true);
  });

  it('death_context: eleven deaths; the 36:05 one was a chain of disables at full health with the ultimate ready', () => {
    const all = run('death_context', { hero: 'beastmaster' });
    expect(all.deaths_total).toBe(11);
    expect(all.deaths.filter((d) => d.killer === 'phantom_assassin')).toHaveLength(7);
    const d = run('death_context', { hero: 'beastmaster', index: 9 }).deaths[0];
    expect(d).toMatchObject({ n: 9, clock: '36:05', killer: 'necrolyte' });
    expect(d.snapshots[0].me).toMatchObject({ hp: 2915, max_hp: 2915 });
    expect(d.ready_not_cast).toContain('beastmaster_primal_roar');
    expect(d.controls_on_me.map((c) => c.modifier)).toEqual(expect.arrayContaining(['modifier_axe_berserkers_call', 'modifier_bashed', 'modifier_necrolyte_reapers_scythe']));
    expect(d.damage_taken[0]).toMatchObject({ from: 'phantom_assassin', by: 'attack' });
    expect(d.at_window_start.items.map((i) => i.item)).toEqual(expect.arrayContaining(['pipe', 'ultimate_scepter']));
    // First blood: alone against two before the creeps met.
    const first = all.deaths[0];
    expect(first.snapshots[0]).toMatchObject({ allies: [], enemies: [expect.objectContaining({ hero: 'phantom_assassin' }), expect.objectContaining({ hero: 'venomancer' })] });
  });

  it('fight_timeline: the 30:11 mid fight in order', () => {
    const f = run('fight_timeline', { from: '30:05', to: '31:00' });
    expect(f.events.filter((e) => e.kind === 'death').map((e) => e.hero)).toEqual(['necrolyte', 'venomancer', 'axe', 'skywrath_mage', 'sven', 'undying', 'beastmaster', 'dark_willow']);
    expect(f.events.find((e) => e.kind === 'spell_immune')).toMatchObject({ hero: 'phantom_assassin', clock: '30:34' });
    expect(f.damage_to_heroes_by_unit[0]).toMatchObject({ unit: 'phantom_assassin' });
    expect(f.positions_at_start).toHaveLength(10);
    expect(f.events.length).toBeLessThanOrEqual(150);
    for (let i = 1; i < f.events.length; i += 1) expect(f.events[i].t).toBeGreaterThanOrEqual(f.events[i - 1].t);
  });

  it('ability_audit says whether the stun landed, including through spell immunity', () => {
    const a = run('ability_audit', { hero: 'beastmaster', ability: 'primal_roar' });
    expect(a).toMatchObject({ casts_on_spell_immune_target: 2, of_those_target_was_stunned: 2, deaths_with_it_ready_and_not_cast_total: 3 });
    expect(a.casts.find((c) => c.clock === '27:27')).toMatchObject({ target_spell_immune: true, target_stunned_seconds: 3.4 });
    expect(a.casts.every((c) => c.target_stunned_seconds > 0)).toBe(true);
  });

  it('every moment record carries a ref a review can cite', () => {
    const a = run('ability_audit', { hero: 'beastmaster', ability: 'primal_roar' });
    expect(a.casts.map((c) => c.ref)).toEqual(Array.from({ length: 10 }, (_, i) => `cast:beastmaster:primal_roar:${i + 1}`));
    expect(a.deaths_with_it_ready_and_not_cast.map((d) => d.ref)).toEqual(['death:beastmaster:5', 'death:beastmaster:9', 'death:beastmaster:11']);
    expect(run('death_context', { hero: 'beastmaster', index: 9 }).deaths[0].ref).toBe('death:beastmaster:9');
    // A window keeps its number whatever the filter: the necrolyte's only window is his first.
    expect(run('immunity_windows', { team: 'radiant' }).windows.map((w) => w.ref)).toEqual([...Array.from({ length: 7 }, (_, i) => `immune:phantom_assassin:${i + 1}`), 'immune:necrolyte:1']);
    const o = run('match_overview');
    expect(o.fights.map((f) => f.ref)).toEqual(o.fights.map((_, i) => `fight:${i + 1}`));
    expect(o.buildings.at(-1).ref).toBe('building:badguys_fort');
    expect(run('fight_timeline', { from: '30:05', to: '31:00' }).ref).toBe('timeline:1805-1860');
    expect(run('item_timeline', { hero: 'phantom_assassin' }).items.find((i) => i.item === 'black_king_bar').ref).toBe('item:phantom_assassin:black_king_bar');
  });

  it('a stun counts for a cast only when the combat log attributes it to the caster', () => {
    // 27:27: Beastmaster's roar stunned Phantom Assassin. Skywrath's Arcane Bolt hit her in the same second and did not.
    const bolts = run('ability_audit', { hero: 'skywrath_mage', ability: 'arcane_bolt' }).casts.filter((c) => c.target === 'phantom_assassin' && Math.abs(c.t - 1647.4) < 3);
    expect(bolts.length).toBeGreaterThan(0);
    for (const c of bolts) expect(c.target_stunned_seconds).toBe(0);
    expect(run('ability_audit', { hero: 'beastmaster', ability: 'primal_roar' }).casts.find((c) => c.clock === '27:27').target_stunned_seconds).toBe(3.4);
  });

  it('a projectile\'s stun lands after the cast and still belongs to it', () => {
    // Sven casts Storm Bolt on Necrophos at 427.8; the log has Sven's stun on him at 428.6.
    const bolt = run('ability_audit', { hero: 'sven', ability: 'storm_bolt' }).casts.find((c) => c.t === 427.8);
    expect(bolt.target).toBe('necrolyte');
    expect(bolt.target_stunned_seconds).toBeGreaterThan(0);
  });

  it('a tool\'s totals carry a summary ref', () => {
    expect(run('ability_audit', { hero: 'beastmaster', ability: 'primal_roar' })).toMatchObject({ ref: 'audit:beastmaster:primal_roar', ref_scope: 'summary' });
    expect(run('death_context', { hero: 'beastmaster', index: 1 })).toMatchObject({ ref: 'deaths:beastmaster', ref_scope: 'summary' });
    expect(run('immunity_windows', { hero: 'phantom_assassin' })).toMatchObject({ ref: 'immunity:phantom_assassin', ref_scope: 'summary' });
    // What was watched is in the ref.
    expect(run('immunity_windows', { hero: 'phantom_assassin', watch_hero: 'beastmaster', watch_ability: 'beastmaster_primal_roar' }).ref).toBe('immunity:phantom_assassin:beastmaster:primal_roar');
    expect(run('immunity_windows', { team: 'dire' }).ref).toBe('immunity:dire');
    expect(run('immunity_windows', {}).ref).toBe('immunity:all');
    expect(run('match_overview')).toMatchObject({ ref: 'overview', ref_scope: 'summary' });
  });

  it('a death record asked for with another window says so in its ref', () => {
    expect(run('death_context', { hero: 'beastmaster', index: 2 }).deaths[0].ref).toBe('death:beastmaster:2');
    const wide = run('death_context', { hero: 'beastmaster', index: 2, window: 30 }).deaths[0];
    expect(wide.ref).toBe('death:beastmaster:2:w30');
    expect(wide.snapshots[0].dt).toBe(-30);
  });

  it('a timeline asked for with fractional bounds covers the whole seconds its ref names', () => {
    const f = run('fight_timeline', { from: 80.6, to: 100.6 });
    expect(f).toMatchObject({ ref: 'timeline:80-101', from: 80, to: 101 });
    // The same window from its ref gives the same events.
    expect(run('fight_timeline', { from: 80, to: 101 }).events).toEqual(f.events);
    expect(run('fight_timeline', { from: 80.2, to: 80.4 })).toMatchObject({ ref: 'timeline:80-81' });
  });

  it('the deaths come in a fixed order of what the hero still had, the same however they are asked for', () => {
    const all = run('death_context', { hero: 'beastmaster' });
    expect(all.most_left_unused.map((r) => r.death)).toEqual([9, 11, 8, 10, 6, 5, 7, 3, 4, 2, 1]);
    expect(all.most_left_unused[0]).toEqual({
      death: 9, clock: '36:05', killer: 'necrolyte',
      // Capturing an outpost is ready at every death: it is not something left unused.
      ready_not_cast: ['beastmaster_wild_axes', 'beastmaster_summon_thunderhide', 'beastmaster_primal_roar'],
      health_share_at_window_start: 1, seconds_before_first_disable: 8.4, enemy_heroes_dealing_damage: 4,
    });
    expect(all.most_left_unused_rule).toMatch(/^most own abilities ready/);
    // Asking for one death does not change the order: it is over all of them.
    const one = run('death_context', { hero: 'beastmaster', index: 5 });
    expect(one.deaths.map((d) => d.n)).toEqual([5]);
    expect(one.most_left_unused).toEqual(all.most_left_unused);
    expect(run('death_context', { hero: 'beastmaster', index: 12 })).toMatchObject({ error: 'no_such_death' });
    // Enemy heroes that dealt damage are counted over the whole window, wherever they stood (30:42: three).
    expect(all.most_left_unused.find((r) => r.death === 8).enemy_heroes_dealing_damage).toBe(3);
    expect(all.deaths[7].enemy_heroes_dealing_damage).toBe(3);
    // Only the hero's own abilities count as left unused: a twin gate being ready is not one.
    const sven = run('death_context', { hero: 'sven' });
    expect(sven.most_left_unused.flatMap((r) => r.ready_not_cast).every((k) => k.startsWith('sven_'))).toBe(true);
    const at = (n) => sven.most_left_unused.findIndex((r) => r.death === n);
    expect(at(3)).toBeLessThan(at(6));
    // Silenced since before the window began (39:16): no free time, not "10.9 s before the first disable".
    expect(sven.most_left_unused.find((r) => r.death === 8).seconds_before_first_disable).toBe(0);
    // A row is not a record of its own: it must not carry a ref that would stand in for the death's.
    expect(all.most_left_unused.every((r) => !('ref' in r))).toBe(true);
  });

  it('death_context counts what the deaths have in common and where the damage came from', () => {
    const all = run('death_context', { hero: 'beastmaster' });
    expect(all.deaths_where).toEqual({
      health_below_half_at_window_start: [],
      no_ally_within_2200_throughout: [2],
      no_ally_within_2200_at_death: [2],
      three_or_more_enemy_heroes_dealing_damage: [4, 6, 7, 8, 9],
      nothing_cast_and_no_item_used: [],
    });
    // Phantom Assassin's attacks are the largest single source: 44% of everything taken in the eleven windows.
    expect(all.damage_in_death_windows_total).toBe(23757);
    expect(Object.entries(all.damage_share_in_death_windows)[0]).toEqual(['phantom_assassin: attacks', 0.44]);
    expect(Object.keys(all.damage_in_death_windows)).toHaveLength(6);
    expect(all.deaths[1]).toMatchObject({ health_share_at_window_start: 0.75, allies_within_2200: { at_window_start: 0, at_death: 0, most_in_any_second: 0 } });
    // Every second is looked at, not only the snapshots: with a 26 s window Undying is within 2200 at −25 s of the 2:51 death.
    const long = run('death_context', { hero: 'beastmaster', window: 26 });
    expect(long.deaths[1].snapshots.every((x) => x.allies.length === 0)).toBe(true);
    expect(long.deaths[1].allies_within_2200).toMatchObject({ at_death: 0, most_in_any_second: 1 });
    expect(long.deaths_where.no_ally_within_2200_throughout).not.toContain(2);
    // Allies who arrive in the last second were there at the death: Mirana's fourth (35:43) was not alone, though every snapshot before it was.
    const mirana = run('death_context', { hero: 'mirana' });
    expect(mirana.deaths[3]).toMatchObject({ clock: '35:43', allies_within_2200: { at_window_start: 0, at_death: 2, most_in_any_second: 2 } });
    expect(mirana.deaths_where.no_ally_within_2200_at_death).not.toContain(4);
    expect(mirana.deaths_where.no_ally_within_2200_throughout).not.toContain(4);
    // The working list behind the totals is not part of a record.
    expect(all.deaths.every((d) => !('damage_sources' in d))).toBe(true);
    // The counts are over the window asked for, so another window is another summary, with its own ref.
    expect(all.ref).toBe('deaths:beastmaster');
    const short = run('death_context', { hero: 'beastmaster', window: 4 });
    expect(short).toMatchObject({ ref: 'deaths:beastmaster:w4', damage_in_death_windows_total: 18106 });
    expect(short.deaths_where.health_below_half_at_window_start).toHaveLength(4);
    // A fractional window is a whole number of seconds, so its refs resolve; 495 of 1000 health is below half though it rounds to 0.5.
    expect(run('death_context', { hero: 'beastmaster', window: 4.4 })).toMatchObject({ ref: 'deaths:beastmaster:w4', window: 4 });
    const m13 = run('death_context', { hero: 'mirana', window: 13 });
    expect(m13.deaths[1]).toMatchObject({ clock: '13:21', health_share_at_window_start: 0.5, below_half_health_at_window_start: true });
    expect(m13.deaths_where.health_below_half_at_window_start).toContain(2);
    // The same for one death asked for: the counts are over all of them.
    expect(run('death_context', { hero: 'beastmaster', index: 3 }).deaths_where).toEqual(all.deaths_where);
  });

  it('ability_audit names the enemy heroes a cast damaged, for an ability that deals damage', () => {
    const axes = run('ability_audit', { hero: 'beastmaster', ability: 'wild_axes' });
    expect(axes.casts[0]).toMatchObject({ clock: '2:33', enemy_heroes_damaged_within_15s: ['phantom_assassin', 'venomancer'] });
    expect(axes.casts[2]).toMatchObject({ clock: '2:51', enemy_heroes_damaged_within_15s: ['phantom_assassin'] });
    // Damage that starts seconds after the cast is still the cast's: a maze walked into five seconds later (3:08 → 3:14).
    const maze = run('ability_audit', { hero: 'dark_willow', ability: 'bramble_maze' }).casts.find((c) => c.clock === '3:08');
    expect(maze.enemy_heroes_damaged_within_15s).toEqual(['mirana']);
    // Damage is kept per whole second: the second a recast falls in belongs to the recast, not to both casts.
    const two = createTraceBuilder();
    const hs = (t, hero, team, i) => ({ entity_kind: 'real_hero', t, hero, team, player_index: i, x: 0, y: 0, hp: 500, max_hp: 600, mana: 300, level: 6, life_state: 0, abilities: hero === 'axe' ? [{ name: 'axe_battle_hunger', level: 1, cooldown: 0, mana_cost: 50 }] : [], items: [], controls: {} });
    for (let t = 0; t <= 30; t += 0.25) { two.addState(hs(t, 'axe', 2, 0)); two.addState(hs(t, 'lina', 3, 5)); two.addState(hs(t, 'sven', 3, 6)); }
    const castAt = (t, row) => two.addEvent({ type: 'DOTA_COMBATLOG_ABILITY', t, attacker: 'npc_dota_hero_axe', attacker_hero: true, attacker_illusion: false, inflictor: 'axe_battle_hunger' }, row);
    const hurt = (t, target, row) => two.addEvent({ type: 'DOTA_COMBATLOG_DAMAGE', t, attacker: 'npc_dota_hero_axe', attacker_hero: true, attacker_illusion: false, target: `npc_dota_hero_${target}`, target_hero: true, target_illusion: false, inflictor: 'axe_battle_hunger', value: 40 }, row);
    castAt(10.2, 1); hurt(10.3, 'lina', 2); castAt(20.2, 3); hurt(20.3, 'sven', 4);
    expect(runTraceTool(two.finish(), 'ability_audit', { hero: 'axe', ability: 'battle_hunger' }).casts.map((c) => c.enemy_heroes_damaged_within_15s)).toEqual([['lina'], ['sven']]);
    // An ability the damage log never names says nothing about whom it damaged.
    const b = createTraceBuilder();
    const st = (t, hero, team) => ({ entity_kind: 'real_hero', t, hero, team, player_index: team === 2 ? 0 : 5, x: 0, y: 0, hp: 500, max_hp: 600, mana: 300, level: 6, life_state: 0, abilities: hero === 'axe' ? [{ name: 'axe_berserkers_call', level: 1, cooldown: 0, mana_cost: 80 }] : [], items: [], controls: {} });
    for (let t = 0; t <= 10; t += 0.25) { b.addState(st(t, 'axe', 2)); b.addState(st(t, 'lina', 3)); }
    b.addEvent({ type: 'DOTA_COMBATLOG_ABILITY', t: 3, attacker: 'npc_dota_hero_axe', attacker_hero: true, attacker_illusion: false, inflictor: 'axe_berserkers_call' }, 1);
    expect('enemy_heroes_damaged_within_15s' in runTraceTool(b.finish(), 'ability_audit', { hero: 'axe', ability: 'berserkers_call' }).casts[0]).toBe(false);
  });

  it('counts are stated by the tools, not left to the reader', () => {
    expect(run('death_context', { hero: 'beastmaster', index: 1 }).killed_by).toEqual({ venomancer: 1, phantom_assassin: 7, mirana: 1, necrolyte: 2 });
    expect(run('immunity_windows', { hero: 'phantom_assassin', watch_hero: 'beastmaster', watch_ability: 'primal_roar' })).toMatchObject({ windows_total: 7, watched_state_when_window_opened: { on_cooldown: 3, ready: 3, dead: 1 }, windows_with_a_cast_on_the_immune_hero: 2 });
  });

  it('item_timeline: when a hero first held each item, for the player and for an enemy', () => {
    const mine = run('item_timeline', { hero: 'beastmaster' }).items;
    const at = (list, item) => list.find((i) => i.item === item)?.first_held.clock;
    expect([at(mine, 'ultimate_scepter'), at(mine, 'pipe'), at(mine, 'assault')]).toEqual(['16:48', '29:08', '38:58']);
    expect(mine.find((i) => i.item === 'assault').held_at_end).toBe(true);
    expect(mine.find((i) => i.item === 'ogre_axe')).toMatchObject({ held_at_end: false, last_held: { clock: expect.any(String) } });
    for (const never of ['blink', 'black_king_bar', 'tango', 'tpscroll']) expect(at(mine, never)).toBeUndefined();
    const pa = run('item_timeline', { hero: 'phantom_assassin' }).items;
    expect([at(pa, 'bfury'), at(pa, 'black_king_bar')]).toEqual(['15:47', '21:29']);
  });

  it('told from a player, sides replace Radiant/Dire and the gold sign', () => {
    const adv = new Array(45).fill(0); adv[30] = 745; adv[32] = 4298;
    const ctx = { perspective: 'beastmaster', match: { radiant_gold_adv: adv } };
    const o = runTraceTool(trace, 'match_overview', {}, ctx);
    expect(o).toMatchObject({ told_from: { hero: 'beastmaster' }, result: 'my_team_lost', fights_total: 16, fights_tally: { my_team_lost_fewer: 6, enemy_lost_fewer: 9, even: 1 } });
    expect(o).not.toHaveProperty('winner');
    expect(o.heroes.find((h) => h.hero === 'beastmaster')).toEqual({ hero: 'beastmaster', side: 'me', deaths: 11, final_level: 21 });
    expect(o.heroes.filter((h) => h.side === 'enemy')).toHaveLength(5);
    // The wipe: five of mine for three of theirs, and a lead of -745 became -4298.
    expect(o.fights.find((f) => f.clock.startsWith('30:'))).toMatchObject({ my_team_deaths: 5, enemy_deaths: 3, lost_fewer_heroes: 'enemy', my_team_gold_lead_before: -745, my_team_gold_lead_2min_after: -4298 });
    expect(o.buildings[0]).toMatchObject({ building: 'goodguys_tower1_top', lost_by: 'enemy' });
    expect(o.buildings.at(-1)).toMatchObject({ building: 'badguys_fort', lost_by: 'my_team' });
    expect(JSON.stringify(o)).not.toMatch(/"radiant"|"dire"|radiant_gold/);
    // A Radiant player reads the same fight the other way round.
    expect(runTraceTool(trace, 'match_overview', {}, { ...ctx, perspective: 'axe' }).fights.find((f) => f.clock.startsWith('30:'))).toMatchObject({ my_team_deaths: 3, enemy_deaths: 5, lost_fewer_heroes: 'my_team', my_team_gold_lead_before: 745 });
    const f = runTraceTool(trace, 'fight_timeline', { from: '30:05', to: '31:00' }, ctx);
    expect(f.positions_at_start.find((p) => p.hero === 'sven').side).toBe('ally');
    expect(f.events.filter((e) => e.kind === 'death').map((e) => e.side)).toEqual(['enemy', 'enemy', 'enemy', 'ally', 'ally', 'ally', 'me', 'ally']);
    expect(runTraceTool(trace, 'ability_audit', { hero: 'beastmaster', ability: 'primal_roar' }, ctx).casts[3].deaths_within_12s).toEqual([expect.objectContaining({ hero: 'beastmaster', side: 'me' })]);
    // An unknown perspective is ignored, not guessed.
    expect(runTraceTool(trace, 'match_overview', {}, { perspective: 'pudge' })).toHaveProperty('winner', 'radiant');
  });

  it('answers bad input with an error object, never a guess', () => {
    expect(run('death_context', { hero: 'pudge' })).toMatchObject({ error: 'unknown_hero', heroes: expect.arrayContaining(['beastmaster']) });
    expect(run('death_context', { hero: 'beastmaster', index: 12 })).toMatchObject({ error: 'no_such_death', deaths: 11 });
    expect(run('ability_audit', { hero: 'beastmaster', ability: 'hook' })).toMatchObject({ error: 'unknown_ability', abilities: expect.arrayContaining(['beastmaster_primal_roar']) });
    expect(run('fight_timeline', { from: '10:00', to: '9:00' })).toMatchObject({ error: 'invalid_window' });
    expect(run('fight_timeline', { from: 0, to: 600 })).toMatchObject({ error: 'window_too_long' });
    expect(run('nope')).toMatchObject({ error: 'unknown_tool' });
    expect(runTraceTool({ schema: 'other' }, 'match_overview')).toEqual({ error: 'invalid_trace' });
  });
});
