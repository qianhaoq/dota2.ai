import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createTraceBuilder, linkHeroNames, TRACE_SCHEMA, TRACE_TOOLS, runTraceTool, traceSeconds, traceRegion, goldAdvantage, goldLead, netWorthGraph, realDeaths, resurrections } from '../src/trace/index.js';

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

describe('item uses keep the hero they went to (#358)', () => {
  it('a Force Staff on an ally, a Glimmer Cape on oneself, a ward with no hero: the fifth column is the hero or null', () => {
    const ev = (type, t, extra) => ({ type, t, attacker: 'npc_dota_hero_axe', attacker_hero: true, attacker_illusion: false, target: 'npc_dota_hero_lina', target_hero: true, target_illusion: false, ...extra });
    const b = createTraceBuilder();
    b.addEvent(ev('DOTA_COMBATLOG_ITEM', 20, { inflictor: 'item_force_staff', target: 'npc_dota_hero_lina', target_hero: true }), 1);
    b.addEvent(ev('DOTA_COMBATLOG_ITEM', 21, { inflictor: 'item_glimmer_cape', target: 'npc_dota_hero_axe', target_hero: true }), 2);
    b.addEvent(ev('DOTA_COMBATLOG_ITEM', 22, { inflictor: 'item_ward_observer', target: 'dota_unknown', target_hero: false }), 3);
    b.addEvent(ev('DOTA_COMBATLOG_ITEM', 23, { inflictor: 'item_orchid', target: 'npc_dota_hero_lina', target_hero: true, target_illusion: true }), 4);
    const tr = b.finish();
    const n = (i) => (i == null ? null : tr.names[i]);
    expect(tr.item_uses.map((u) => [u[0], n(u[1]), n(u[2]), u[3], n(u[4])])).toEqual([
      [20, 'npc_dota_hero_axe', 'item_force_staff', 1, 'npc_dota_hero_lina'],
      [21, 'npc_dota_hero_axe', 'item_glimmer_cape', 2, 'npc_dota_hero_axe'],
      [22, 'npc_dota_hero_axe', 'item_ward_observer', 3, null],
      // An illusion is not the hero: kept as one, as casts at illusions are.
      [23, 'npc_dota_hero_axe', 'item_orchid', 4, 'illusion:npc_dota_hero_lina'],
    ]);
  });
});

describe('Smoke of Deceit and runes on heroes (#405)', () => {
  const ev = (type, t, extra) => ({ type, t, attacker: 'npc_dota_hero_axe', attacker_hero: true, attacker_illusion: false, target: 'npc_dota_hero_axe', target_hero: true, target_illusion: false, ...extra });
  it('each hero smoked: from, who used it, until; a rune: from, kind, until; summons and illusions are not heroes', () => {
    const b = createTraceBuilder();
    b.addEvent(ev('DOTA_COMBATLOG_MODIFIER_ADD', 100, { inflictor: 'modifier_smoke_of_deceit' }), 1);
    b.addEvent(ev('DOTA_COMBATLOG_MODIFIER_ADD', 100.2, { inflictor: 'modifier_smoke_of_deceit', target: 'npc_dota_hero_lina' }), 2);
    b.addEvent(ev('DOTA_COMBATLOG_MODIFIER_ADD', 100.3, { inflictor: 'modifier_smoke_of_deceit', target: 'npc_dota_beastmaster_boar', target_hero: false }), 3);
    b.addEvent(ev('DOTA_COMBATLOG_MODIFIER_ADD', 100.4, { inflictor: 'modifier_smoke_of_deceit', target: 'npc_dota_hero_lina', target_illusion: true }), 4);
    b.addEvent(ev('DOTA_COMBATLOG_MODIFIER_REMOVE', 110, { inflictor: 'modifier_smoke_of_deceit', target: 'npc_dota_hero_lina' }), 5);
    b.addEvent(ev('DOTA_COMBATLOG_MODIFIER_ADD', 200, { inflictor: 'modifier_rune_doubledamage' }), 6);
    b.addEvent(ev('DOTA_COMBATLOG_MODIFIER_REMOVE', 245, { inflictor: 'modifier_rune_doubledamage' }), 7);
    b.addEvent(ev('DOTA_COMBATLOG_MODIFIER_ADD', 300, { inflictor: 'modifier_rune_invis' }), 8);
    const tr = b.finish();
    const n = (i) => tr.names[i];
    // Axe's smoke never removed in the log: still on at the end (null), not a made-up end.
    expect(tr.smokes.map((r) => [r[0], n(r[1]), n(r[2]), r[3]])).toEqual([[100, 'npc_dota_hero_axe', 'npc_dota_hero_axe', null], [100.2, 'npc_dota_hero_lina', 'npc_dota_hero_axe', 110]]);
    expect(tr.runes.map((r) => [r[0], n(r[1]), r[2], r[3]])).toEqual([[200, 'npc_dota_hero_axe', 'doubledamage', 245], [300, 'npc_dota_hero_axe', 'invis', null]]);
    // Neither is a control effect.
    expect(tr.modifiers).toEqual([]);
  });
  it('a trace built from no such rows has empty lists (the builder reads them: none, not unknown)', () => {
    const tr = createTraceBuilder().finish();
    expect([tr.smokes, tr.runes]).toEqual([[], []]);
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
    expect(tr.abilities[0].lina_laguna_blade).toEqual({ levels: [[0, 1], [4.3, 0]], cd: [[2, 4.3, 48]], mana: 250, costs: [[0, 250]] });
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
    expect(poor.abilities[0].axe_berserkers_call).toMatchObject({ mana: 110, costs: [[0, 80], [40, 110]] });
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
    // A cost that changes without a level (100 until 10 s, 80 after): 90 mana pays for it in a window where it cost 80.
    const sale = createTraceBuilder();
    for (let t = 0; t <= 30; t += 0.25) { sale.addState(state(t, { mana: 90, abilities: [{ name: 'axe_berserkers_call', level: 1, cooldown: 0, mana_cost: t < 10 ? 100 : 80 }] })); sale.addState(lina(t)); }
    sale.addEvent({ type: 'DOTA_COMBATLOG_DEATH', t: 25, target: 'npc_dota_hero_axe', target_hero: true, target_illusion: false, attacker: 'npc_dota_hero_lina', attacker_hero: true, attacker_illusion: false }, 1);
    const sl = sale.finish();
    expect(sl.abilities[0].axe_berserkers_call.costs).toEqual([[0, 100], [10, 80]]);
    expect(runTraceTool(sl, 'death_context', { hero: 'axe' }).deaths[0]).toMatchObject({ ready_not_cast: ['axe_berserkers_call'], off_cooldown_without_the_mana: [] });
    expect(runTraceTool(sl, 'death_context', { hero: 'axe' }).deaths[0].at_window_start.abilities[0].mana_cost).toBe(80);
    expect(runTraceTool(sl, 'ability_audit', { hero: 'axe', ability: 'berserkers_call' }).deaths_with_it_ready_and_not_cast_total).toBe(1);
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

describe('what a hero killed, gold by reason, Roshan', () => {
  const state = (t, hero, team) => ({ entity_kind: 'real_hero', t, hero, team, player_index: team === 2 ? 0 : 5, x: 0, y: 0, hp: 500, max_hp: 600, mana: 100, level: 3, life_state: 0, abilities: [], items: [], controls: {} });
  const kill = (t, target, extra = {}) => ({ type: 'DOTA_COMBATLOG_DEATH', t, attacker: 'npc_dota_hero_axe', attacker_hero: true, attacker_illusion: false, attacker_team: 2, target, target_hero: false, target_illusion: false, target_team: 3, last_hits: 7, networth: 1234.4, ...extra });
  const gold = (t, target, reason, value) => ({ type: 'DOTA_COMBATLOG_GOLD', t, target, gold_reason: reason, value });
  const named = (tr, rows) => rows.map(([t, who, ...rest]) => [t, who < 0 ? null : tr.names[who], ...rest]);

  it('names what was killed: lane creep, deny, neutral, enemy ward, enemy courier, or something else', () => {
    const b = createTraceBuilder();
    b.addEvent(kill(60.04, 'npc_dota_creep_badguys_melee'));
    b.addEvent(kill(61, 'npc_dota_creep_goodguys_ranged', { target_team: 2, last_hits: 7 }));
    b.addEvent(kill(62, 'npc_dota_badguys_siege', { last_hits: 8 }));
    b.addEvent(kill(63, 'npc_dota_neutral_satyr_soulstealer', { target_team: 4, last_hits: 9 }));
    b.addEvent(kill(64, 'npc_dota_observer_wards'));
    b.addEvent(kill(65, 'npc_dota_sentry_wards'));
    b.addEvent(kill(66, 'npc_dota_courier'));
    b.addEvent(kill(67, 'npc_dota_venomancer_plague_ward', { last_hits: 10 }));
    const tr = b.finish();
    expect(named(tr, tr.creep_kills)).toEqual([
      [60, 'npc_dota_hero_axe', 'l', 7, 1234], [61, 'npc_dota_hero_axe', 'd', 7, 1234], [62, 'npc_dota_hero_axe', 'l', 8, 1234], [63, 'npc_dota_hero_axe', 'n', 9, 1234],
      [64, 'npc_dota_hero_axe', 'o', 7, 1234], [65, 'npc_dota_hero_axe', 's', 7, 1234], [66, 'npc_dota_hero_axe', 'c', 7, 1234], [67, 'npc_dota_hero_axe', 'x', 10, 1234],
    ]);
  });

  it('a side the log does not give is not guessed: a lane creep is "u", a ward or courier is not counted as the enemy\'s', () => {
    const b = createTraceBuilder();
    b.addEvent(kill(1, 'npc_dota_creep_badguys_melee', { attacker_team: undefined }));
    b.addEvent(kill(2, 'npc_dota_creep_badguys_melee', { target_team: 0 }));
    b.addEvent(kill(3, 'npc_dota_observer_wards', { target_team: undefined }));
    b.addEvent(kill(4, 'npc_dota_observer_wards', { target_team: 2 }));
    b.addEvent(kill(5, 'npc_dota_courier', { attacker_team: null }));
    expect(b.finish().creep_kills.map((k) => k[2])).toEqual(['u', 'u', 'x', 'x', 'x']);
  });

  it('a row\'s running numbers are kept only when the log has them', () => {
    const b = createTraceBuilder();
    b.addEvent(kill(1, 'npc_dota_neutral_kobold', { last_hits: undefined, networth: null }));
    b.addEvent(kill(2, 'npc_dota_neutral_kobold', { last_hits: -1, networth: -5 }));
    b.addEvent(kill(3, 'npc_dota_neutral_kobold', { last_hits: 2.5, networth: 'x' }));
    b.addEvent(kill(4, 'npc_dota_neutral_kobold', { last_hits: 0, networth: 0 }));
    expect(b.finish().creep_kills.map((k) => [k[3], k[4]])).toEqual([[null, null], [null, null], [null, null], [0, 0]]);
  });

  it('an illusion\'s kill is the hero\'s; a kill by a unit that is no hero, and the death of a hero or of its illusion, are not rows', () => {
    const b = createTraceBuilder();
    b.addEvent(kill(1, 'npc_dota_creep_badguys_melee', { attacker_illusion: true }));
    b.addEvent(kill(2, 'npc_dota_creep_badguys_melee', { attacker: 'npc_dota_beastmaster_boar', attacker_hero: false }));
    b.addEvent(kill(3, 'npc_dota_hero_lina', { target_hero: true }));
    b.addEvent(kill(4, 'npc_dota_hero_lina', { target_hero: true, target_illusion: true }));
    const tr = b.finish();
    expect(named(tr, tr.creep_kills)).toEqual([[1, 'npc_dota_hero_axe', 'l', 7, 1234]]);
    expect(tr.deaths).toHaveLength(1);
  });

  it('gold is summed per game minute, hero and reason code; a loss is negative', () => {
    const b = createTraceBuilder();
    b.addEvent(gold(-90, 'npc_dota_hero_axe', 0, 600));
    b.addEvent(gold(61, 'npc_dota_hero_axe', 13, 40));
    b.addEvent(gold(119.9, 'npc_dota_hero_axe', 13, 38));
    b.addEvent(gold(120, 'npc_dota_hero_axe', 13, 41));
    b.addEvent(gold(65, 'npc_dota_hero_axe', 14, 22));
    b.addEvent(gold(65, 'npc_dota_hero_lina', 13, 36));
    // Dying for 19 gold, as the log writes it.
    b.addEvent(gold(70, 'npc_dota_hero_lina', 1, 4294967277));
    // A reason the builder has no name for is kept as it is.
    b.addEvent(gold(71, 'npc_dota_hero_lina', 23, 160));
    const tr = b.finish();
    expect(named(tr, tr.gold.map(([m, who, reason, v]) => [m, who, reason, v]))).toEqual([
      [-2, 'npc_dota_hero_axe', 0, 600], [1, 'npc_dota_hero_axe', 13, 78], [2, 'npc_dota_hero_axe', 13, 41], [1, 'npc_dota_hero_axe', 14, 22],
      [1, 'npc_dota_hero_lina', 13, 36], [1, 'npc_dota_hero_lina', 1, -19], [1, 'npc_dota_hero_lina', 23, 160],
    ]);
  });

  it('gold rows that name no hero, no reason or no amount are not counted; an extract without gold rows has no gold field', () => {
    const b = createTraceBuilder();
    b.addEvent(gold(1, 'npc_dota_creep_badguys_melee', 13, 40));
    b.addEvent(gold(1, undefined, 13, 40));
    b.addEvent(gold(1, 'npc_dota_hero_axe', undefined, 40));
    b.addEvent(gold(1, 'npc_dota_hero_axe', 13, undefined));
    b.addEvent(kill(2, 'npc_dota_neutral_kobold'));
    const tr = b.finish();
    // Unknown, not "no gold": the field is absent, as it is in a trace built before gold was kept.
    expect('gold' in tr).toBe(false);
    // The deaths were read: one kill, and an empty list would have meant none.
    expect(tr.creep_kills).toHaveLength(1);
    expect(createTraceBuilder().finish().creep_kills).toEqual([]);
  });

  it('a Roshan a hero killed: when, by whom, which side, the row, and the log\'s visibility flags as written', () => {
    const b = createTraceBuilder();
    b.addEvent(kill(1938.2, 'npc_dota_roshan', { attacker: 'npc_dota_hero_phantom_assassin', visible_radiant: true, visible_dire: null }), 69415);
    b.addEvent(kill(2500, 'npc_dota_roshan', { attacker: 'npc_dota_hero_sven', attacker_team: 3, visible_radiant: false, visible_dire: true }), 80000);
    b.addEvent(kill(2600, 'npc_dota_roshan', { attacker: 'npc_dota_hero_sven', attacker_team: undefined }), 80001);
    const tr = b.finish();
    expect(named(tr, tr.roshan_kills)).toEqual([
      [1938.2, 'npc_dota_hero_phantom_assassin', 2, 69415, 1, null],
      [2500, 'npc_dota_hero_sven', 3, 80000, 0, 1],
      [2600, 'npc_dota_hero_sven', 0, 80001, null, null],
    ]);
    // Roshan is not a creep kill.
    expect(tr.creep_kills).toEqual([]);
  });

  it('Roshan gold alone is not a Roshan: the Tormentor pays the same reason code', () => {
    const b = createTraceBuilder();
    for (const t of [0, 1]) { b.addState(state(t, 'axe', 2)); b.addState(state(t, 'lina', 3)); }
    // 9102345221 at 22:02: five heroes are paid 125 each under reason 15, and what died was the Tormentor.
    b.addEvent(gold(1322.03, 'npc_dota_hero_axe', 15, 125));
    const tr = b.finish();
    expect(tr.roshan_kills).toEqual([]);
    expect(tr.tormentor_kills).toEqual([]);
    // The gold itself is kept, under its code.
    expect(tr.gold).toEqual([[22, tr.names.indexOf('npc_dota_hero_axe'), 15, 125]]);
  });

  it('Roshan gold in the second of a hero\'s kill is that kill, not another one', () => {
    const b = createTraceBuilder();
    b.addState(state(0, 'axe', 2));
    b.addEvent(kill(900, 'npc_dota_roshan'), 5);
    b.addEvent(gold(900, 'npc_dota_hero_axe', 15, 284));
    b.addEvent(gold(900.9, 'npc_dota_hero_axe', 15, 125));
    expect(b.finish().roshan_kills).toHaveLength(1);
  });

  it('a Tormentor a hero killed is its own row: not a Roshan, and not among the creep kills', () => {
    const b = createTraceBuilder();
    b.addEvent(kill(1322, 'npc_dota_miniboss', { attacker: 'npc_dota_hero_lina', attacker_team: 3 }), 40000);
    b.addEvent(gold(1322, 'npc_dota_hero_lina', 15, 125));
    b.addEvent(kill(2029, 'npc_dota_miniboss', { attacker_team: undefined }), 50000);
    b.addEvent(kill(2100, 'npc_dota_miniboss', { attacker: 'npc_dota_beastmaster_boar', attacker_hero: false }), 50001);
    const tr = b.finish();
    expect(named(tr, tr.tormentor_kills)).toEqual([[1322, 'npc_dota_hero_lina', 3, 40000], [2029, 'npc_dota_hero_axe', 0, 50000]]);
    expect(tr.roshan_kills).toEqual([]);
    expect(tr.creep_kills).toEqual([]);
  });

  it('damage to Roshan is summed per second and hero, apart from the damage to heroes and buildings', () => {
    const b = createTraceBuilder();
    const hit = (t, extra = {}) => ({ type: 'DOTA_COMBATLOG_DAMAGE', t, attacker: 'npc_dota_hero_axe', attacker_hero: true, attacker_illusion: false, target: 'npc_dota_roshan', target_hero: false, value: 100, ...extra });
    b.addEvent(hit(1912.1)); b.addEvent(hit(1912.8, { value: 50 })); b.addEvent(hit(1913, { attacker_illusion: true, value: 20 }));
    b.addEvent(hit(1913.5, { attacker: 'npc_dota_hero_lina' }));
    b.addEvent(hit(1914, { attacker: 'npc_dota_beastmaster_boar', attacker_hero: false }));
    b.addEvent(hit(1914, { value: 0 }));
    const tr = b.finish();
    expect(named(tr, tr.roshan_damage.map(([sec, who, v]) => [sec, who, v]))).toEqual([[1912, 'npc_dota_hero_axe', 150], [1913, 'npc_dota_hero_axe', 20], [1913, 'npc_dota_hero_lina', 100]]);
    expect(tr.damage).toEqual([]);
  });

  it('the tools still tell the model what they told it before: these fields are read by none of them yet', () => {
    const b = createTraceBuilder();
    b.addEvent(kill(1, 'npc_dota_roshan')); b.addEvent(kill(2, 'npc_dota_neutral_kobold')); b.addEvent(gold(3, 'npc_dota_hero_axe', 13, 40));
    expect(b.finish().gaps.map((g) => `${g.topic}:${g.reason}`)).toEqual(['vision:no_fog_of_war_in_trace', 'creeps:creep_kills_only_not_where_the_waves_stood', 'roshan:no_reliable_roshan_event', 'ability_immunity:only_item_spell_immunity_modifiers_tracked', 'unused_free_abilities:an_ability_never_cast_with_no_mana_cost_cannot_be_told_from_a_passive']);
  });
});

describe('net worth from the replay\'s match metadata', () => {
  const state = (t, hero, team) => ({ entity_kind: 'real_hero', t, hero, team, player_index: team === 2 ? 0 : 5, x: 0, y: 0, hp: 500, max_hp: 600, mana: 100, level: 1, life_state: 0, abilities: [], items: [], controls: {} });
  const built = (metadataRows) => {
    const b = createTraceBuilder();
    // A game of 2:30: points for 0:00, 1:00 and 2:00 at most.
    for (const t of [0, 1, 150]) { b.addState(state(t, 'axe', 2)); b.addState(state(t, 'lina', 3)); }
    for (const row of metadataRows) b.addMetadata(row);
    return b.finish({ match_id: 7 });
  };
  // The graph is in tens of gold (seen in 9100904020: first point 60 = the 600 starting purse; ×10 at the
  // end is within 0.3% of every player's scoreboard net worth).
  const meta = (axe, lina) => ({ players: [{ dota_team: 2, hero_key: 'npc_dota_hero_axe', graph_net_worth: axe }, { dota_team: 3, hero_key: 'npc_dota_hero_lina', graph_net_worth: lina }] });

  it('keeps each hero\'s net worth per minute, in gold, in hero order; the last metadata row wins', () => {
    const tr = built([meta([60, 61], [60, 62]), meta([60, 66.26462, 81.43333], [59.800003, 63.987694, 82.04603])]);
    expect(tr.net_worth).toEqual([[600, 663, 814], [598, 640, 820]]);
    // Radiant's lead: the teams' sums minute by minute.
    expect(goldAdvantage(tr, {})).toEqual([2, 23, -6]);
  });

  it('a graph whose first point is no starting purse is not trusted: no net worth, so no team lead (the tools then name the gap)', () => {
    const tr = built([meta([600, 663], [598, 640])]);
    expect(tr.net_worth).toBeUndefined();
    expect(goldAdvantage(tr, {})).toBeNull();
    // No metadata at all (an older extract): the same.
    expect(built([]).net_worth).toBeUndefined();
  });

  it('a graph denser than one point a minute is not read as minutes: nothing is kept, and the trace says why', () => {
    // 9080127650's graphs: 63 points for a 31:47 game. Here: six points for 2:30.
    const tr = built([meta([60, 61, 62, 63, 64, 65], [60, 61, 62, 63, 64, 65])]);
    expect(tr.net_worth).toBeUndefined();
    expect(tr.gaps).toContainEqual({ topic: 'net_worth', reason: 'metadata_graph_denser_than_one_point_a_minute' });
    expect(goldAdvantage(tr, {})).toBeNull();
    // One point a minute for the minutes played is fine, and so is a graph that stops early.
    expect(built([meta([60, 61, 62], [60, 61, 62])]).net_worth).toEqual([[600, 610, 620], [600, 610, 620]]);
    expect(built([meta([60, 61, 62, 63], [60, 61, 62, 63])]).net_worth).toBeUndefined();
  });

  it('a hero whose state name has underscores the metadata name lacks still gets its graph', () => {
    // Seen in 9102724734, 9101399999 and 9099013525: the states say queen_of_pain, vengeful_spirit, anti_mage,
    // the metadata npc_dota_hero_queenofpain, npc_dota_hero_vengefulspirit, npc_dota_hero_antimage.
    const b = createTraceBuilder();
    for (const t of [0, 1, 150]) { b.addState(state(t, 'queen_of_pain', 2)); b.addState(state(t, 'anti_mage', 3)); }
    b.addMetadata({ players: [{ dota_team: 2, hero_key: 'npc_dota_hero_queenofpain', graph_net_worth: [60, 70] }, { dota_team: 3, hero_key: 'npc_dota_hero_antimage', graph_net_worth: [60, 65] }] });
    const tr = b.finish({ match_id: 7 });
    expect(tr.net_worth).toEqual([[600, 700], [600, 650]]);
    expect(goldAdvantage(tr, {})).toEqual([0, 50]);
  });

  it('a metadata player with no hero name is matched by player id and team (9016476539 names no hero)', () => {
    const tr = built([{ players: [{ dota_team: 2, game_player_id: 0, hero_key: null, graph_net_worth: [60, 70] }, { dota_team: 3, game_player_id: 5, hero_key: null, graph_net_worth: [60, 64] }] }]);
    expect(tr.net_worth).toEqual([[600, 700], [600, 640]]);
    expect(goldAdvantage(tr, {})).toEqual([0, 60]);
    // The id on the other team is someone else: no graph.
    expect(built([{ players: [{ dota_team: 3, game_player_id: 0, hero_key: null, graph_net_worth: [60, 70] }] }]).net_worth).toEqual([null, null]);
  });

  it('a hero the metadata does not name has no graph, and then there is no team lead', () => {
    const tr = built([{ players: [{ dota_team: 2, hero_key: 'npc_dota_hero_axe', graph_net_worth: [60, 70] }, { dota_team: 3, hero_key: null, graph_net_worth: [60, 70] }] }]);
    expect(tr.net_worth).toEqual([[600, 700], null]);
    expect(goldAdvantage(tr, {})).toBeNull();
  });

  it('the match record\'s curve is used when the caller has it; the tools fall back to the replay\'s', () => {
    expect(goldAdvantage({ heroes: [], net_worth: [] }, { match: { radiant_gold_adv: [0, 5] } })).toEqual([0, 5]);
    // The real game with a net worth graph and no match record: the overview's fights carry a gold lead, and no gap says it is missing.
    const minutes = Math.ceil((trace.t0 + trace.n) / 60) + 1;
    const withWorth = { ...trace, net_worth: trace.heroes.map((h) => Array.from({ length: minutes }, (_, m) => (h.team === 2 ? 1000 : 600) * (m + 1))) };
    const ov = runTraceTool(withWorth, 'match_overview', {}, { perspective: 'beastmaster' });
    expect(ov.gaps.map((g) => g.topic)).not.toContain('gold_advantage');
    const f = ov.fights[0];
    expect(f.my_team_gold_lead_before).toBe(-2000 * (Math.floor(f.from / 60) + 1));
    // Without either, as before.
    expect(runTraceTool(trace, 'match_overview', {}, { perspective: 'beastmaster' }).gaps.map((g) => g.topic)).toContain('gold_advantage');
  });
});

describe('the gold lead, and where it is read from', () => {
  // The committed trace of 9100904020 was built before gold rows were kept. These are the rows today's builder
  // keeps for the same game, and the match record's lead (OpenDota's radiant_gold_adv) for it.
  const real = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/gold-9100904020.json.gz', import.meta.url))));
  const withGold = { ...trace, gold: real.gold.map(([m, npc, reason, sum]) => [m, trace.names.indexOf(npc), reason, sum]) };
  const tiny = (gold, extra = {}) => ({ t0: 0, n: 181, names: ['npc_dota_hero_axe', 'npc_dota_hero_lina'], buildings: [], heroes: [{ key: 'axe', npc: 'npc_dota_hero_axe', team: 2 }, { key: 'lina', npc: 'npc_dota_hero_lina', team: 3 }], gold, ...extra });

  it('summed from the combat log it is the match record\'s lead, minute for minute, on a real game', () => {
    expect(withGold.gold).toHaveLength(988);
    expect(withGold.gold.every((g) => g[1] >= 0)).toBe(true);
    const g = goldLead(withGold, {});
    expect(g.source).toBe('replay_gold_log');
    expect(g.lead).toHaveLength(real.radiant_gold_adv.length);
    const off = g.lead.map((v, m) => Math.abs(v - real.radiant_gold_adv[m]));
    expect(Math.max(...off)).toBe(48);
    expect(off.reduce((a, b) => a + b, 0) / off.length).toBeLessThan(18);
    // The wipe at 30:26: Radiant 745 ahead going in and 4298 two minutes on by the record; 778 and 4331 by the log.
    expect([real.radiant_gold_adv[30], g.lead[30], real.radiant_gold_adv[32], g.lead[32]]).toEqual([745, 778, 4298, 4331]);
  });

  it('counts every gain but an item sold; a loss is not a gain; gold from before the horn is there at 0:00', () => {
    const g = goldLead(tiny([
      [-2, 0, 0, 600], [-2, 1, 0, 625],   // before the horn: both purses, and a rune for Dire
      [0, 0, 13, 100], [0, 1, 13, 40],    // 0:00–0:59
      [1, 0, 6, 500],                     // an item sold: money moved, not earned
      [1, 1, 1, -200],                    // lost on death: not a gain, and not a loss of what was earned
      [2, 1, 12, 300],                    // 2:00–2:59
      [5, 0, 13, 999],                    // after the last second of the trace
      [0, 7, 13, 5000],                   // not one of the ten heroes
    ]), {});
    expect(g).toEqual({ lead: [-25, 35, 35, -265], source: 'replay_gold_log' });
    expect(goldAdvantage(tiny([[0, 0, 13, 100]]), {})).toEqual([0, 100, 100, 100]);
  });

  it('best first: the match record, then the combat log, then the net worth graph — and each is named', () => {
    const graph = [[600, 700, 800, 900], [600, 650, 700, 750]];
    const both = tiny([[0, 0, 13, 100]], { net_worth: graph });
    expect(goldLead(both, { match: { radiant_gold_adv: [0, 5, 9, 12] } })).toEqual({ lead: [0, 5, 9, 12], source: 'match_record' });
    expect(goldLead(both, {}).source).toBe('replay_gold_log');
    // A trace built before the gold rows were kept does not know them: the graph, as before.
    const older = tiny(undefined, { net_worth: graph });
    expect(goldLead(older, {})).toEqual({ lead: [0, 50, 100, 150], source: 'replay_net_worth' });
    // An empty list is not a game in which nobody earned anything.
    expect(goldLead(tiny([], { net_worth: graph }), {}).source).toBe('replay_net_worth');
    expect(goldLead(tiny(undefined), {})).toBeNull();
    expect(goldLead(tiny([]), {})).toBeNull();
    expect(goldAdvantage(tiny(undefined), {})).toBeNull();
  });

  it('match_overview says which it read, to a player and to no one; with none it says nothing and the gap stands', () => {
    const told = (t, ctx) => runTraceTool(t, 'match_overview', {}, ctx);
    const fromLog = told(withGold, { perspective: 'beastmaster' });
    expect(fromLog.gold_lead_source).toBe('replay_gold_log_lead');
    expect(fromLog.fights.find((f) => f.clock.startsWith('30:'))).toMatchObject({ my_team_gold_lead_before: -778, my_team_gold_lead_2min_after: -4331 });
    expect(fromLog.gaps.map((g) => g.topic)).not.toContain('gold_advantage');
    expect(told(withGold, {}).gold_lead_source).toBe('replay_gold_log_lead');
    expect(told(withGold, { perspective: 'beastmaster', match: { radiant_gold_adv: real.radiant_gold_adv } })).toMatchObject({ gold_lead_source: 'match_data_gold_lead' });
    const minutes = Math.floor(trace.buildings.at(-1)[0] / 60) + 1;
    const graph = { ...trace, net_worth: trace.heroes.map((h) => Array.from({ length: minutes }, (_, m) => (h.team === 2 ? 1000 : 600) * (m + 1))) };
    expect(told(graph, { perspective: 'beastmaster' }).gold_lead_source).toBe('replay_net_worth_lead');
    const none = told(trace, { perspective: 'beastmaster' });
    expect(none).not.toHaveProperty('gold_lead_source');
    expect(none.gaps.map((g) => g.topic)).toContain('gold_advantage');
  });

  it('a net worth graph that is not one point a minute is not read as minutes', () => {
    // 9099561801: 36 points for a game of 73:37. Read as minutes, minute 49's net worth stood at minute 24.
    const minutes = Math.floor(trace.buildings.at(-1)[0] / 60) + 1;
    expect(minutes).toBe(43);
    const graphOf = (points) => ({ ...trace, net_worth: trace.heroes.map((h) => Array.from({ length: points }, (_, m) => (h.team === 2 ? 1000 : 600) * (m + 1))) });
    // The per-minute graphs of the corpus are 0 to 3 points short of the game's minutes.
    for (const points of [43, 42, 40]) expect([points, netWorthGraph(graphOf(points)) != null, goldLead(graphOf(points), {})?.source]).toEqual([points, true, 'replay_net_worth']);
    // Fifteen percent of 43 minutes is 6.45 points: 37 is still read, 36 is not.
    expect(netWorthGraph(graphOf(37))).not.toBeNull();
    for (const points of [36, 21, 1]) expect([points, netWorthGraph(graphOf(points)), goldLead(graphOf(points), {})]).toEqual([points, null, null]);
    const sparse = runTraceTool(graphOf(21), 'match_overview', {}, { perspective: 'beastmaster' });
    expect(sparse.fights[0]).not.toHaveProperty('my_team_gold_lead_before');
    expect(sparse.gaps).toContainEqual({ topic: 'gold_advantage', reason: 'not_in_trace' });
    // One hero without a graph, or a trace without the field: no graph.
    expect(netWorthGraph({ ...graphOf(43), net_worth: graphOf(43).net_worth.map((g, i) => (i === 3 ? null : g)) })).toBeNull();
    expect(netWorthGraph(trace)).toBeNull();
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
    expect(TRACE_TOOLS.map((t) => t.name)).toEqual(['match_overview', 'death_context', 'ability_audit', 'immunity_windows', 'fight_timeline', 'item_timeline', 'tempo_report']);
    for (const t of TRACE_TOOLS) expect(t.input_schema).toMatchObject({ type: 'object', additionalProperties: false });
  });

  it('match_overview: the line-ups, the result, and the fight that turned the game', () => {
    const o = run('match_overview');
    expect(o).toMatchObject({ match_id: 9100904020, winner: 'radiant', duration: { clock: '42:31' } });
    expect(o.heroes.find((h) => h.hero === 'beastmaster')).toEqual({ hero: 'beastmaster', team: 'dire', deaths: 11, deaths_before_10: 4, final_level: 21 });
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
    // First blood: against two before the creeps met. Allies near are not told (owner, 2026-11-27).
    const first = all.deaths[0];
    expect(first.snapshots[0]).toMatchObject({ enemies: [expect.objectContaining({ hero: 'phantom_assassin' }), expect.objectContaining({ hero: 'venomancer' })] });
    expect(first.snapshots[0]).not.toHaveProperty('allies');

    // Control-chain and cast-opportunity windows (#482): Beastmaster death #9 had 8.1–8.6 s unblocked before
    // the 3.4 s Axe Call -> Bash -> Scythe spell-block chain to death.
    expect(d.control_intervals).toEqual([
      { kind: 'taunted', blocks_spells: true, from_dt: -3.4, to_dt: -0.4, seconds: 3 },
      { kind: 'stunned', blocks_spells: true, from_dt: -2, to_dt: 0, seconds: 2 },
    ]);
    expect(d.spell_blocked_intervals).toEqual([
      { from_dt: -3.4, to_dt: 0, seconds: 3.4, kinds: ['taunted', 'stunned'] },
    ]);
    expect(d.continuous_spell_block_to_death_seconds).toBe(3.4);
    expect(d.unblocked_seconds_from_first_damage).toEqual({ min: 8.1, max: 8.6 });
    expect(d.spell_blocked_at_first_damage).toBe(false);

    // Dark Willow death #4 (28:15): taunted into stunned continuously from first enemy damage until death (0 s cast window).
    const dw4 = run('death_context', { hero: 'dark_willow', index: 4 }).deaths[0];
    expect(dw4).toMatchObject({
      clock: '28:15',
      continuous_spell_block_to_death_seconds: 3.2,
      unblocked_seconds_from_first_damage: { min: 0, max: 0 },
      spell_blocked_at_first_damage: true,
      spell_blocked_intervals: [{ from_dt: -3.2, to_dt: 0, seconds: 3.2, kinds: ['taunted', 'stunned'] }],
    });

    // Sven death #3 (17:32): rooted first (blocks_spells: false), then stunned to death (2.9 s);
    // stun begins 0.1 s after the 1 s first-damage bucket, so spell_blocked_at_first_damage stays null (ambiguous).
    const sven3 = run('death_context', { hero: 'sven', index: 3 }).deaths[0];
    expect(sven3.control_intervals).toEqual([
      { kind: 'rooted', blocks_spells: false, from_dt: -4.8, to_dt: -2.9, seconds: 1.9 },
      { kind: 'stunned', blocks_spells: true, from_dt: -2.9, to_dt: 0, seconds: 2.9 },
    ]);
    expect(sven3).toMatchObject({
      spell_blocked_intervals: [{ from_dt: -2.9, to_dt: 0, seconds: 2.9, kinds: ['stunned'] }],
      continuous_spell_block_to_death_seconds: 2.9,
      unblocked_seconds_from_first_damage: { min: 0.1, max: 1.1 },
      spell_blocked_at_first_damage: null,
    });

    // Sven death #4 (27:48): self-damage (Sabatons) & ally Soul Rip before enemy hero damage do not shift enemy-damage cast window.
    const sven4 = run('death_context', { hero: 'sven', index: 4 }).deaths[0];
    expect(sven4).toMatchObject({
      continuous_spell_block_to_death_seconds: 0.9,
      unblocked_seconds_from_first_damage: { min: 6.5, max: 7.5 },
      spell_blocked_at_first_damage: false,
    });

    // Axe death #9 (30:33): rooted only — never treated as spell-blocked.
    const axe9 = run('death_context', { hero: 'axe', index: 9 }).deaths[0];
    expect(axe9).toMatchObject({
      control_intervals: [{ kind: 'rooted', blocks_spells: false, from_dt: -1.8, to_dt: 0, seconds: 1.8 }],
      spell_blocked_intervals: [],
      continuous_spell_block_to_death_seconds: 0,
      unblocked_seconds_from_first_damage: { min: 4, max: 5 },
      spell_blocked_at_first_damage: false,
    });

    // Skywrath Mage death #8 (40:31): two separate stuns with an unblocked spell-casting gap between them (rooted only during gap).
    const sky8 = run('death_context', { hero: 'skywrath_mage', index: 8 }).deaths[0];
    expect(sky8.spell_blocked_intervals).toEqual([
      { from_dt: -5.8, to_dt: -4.2, seconds: 1.6, kinds: ['stunned'] },
      { from_dt: -3.1, to_dt: 0, seconds: 3.1, kinds: ['stunned'] },
    ]);
    expect(sky8).toMatchObject({
      continuous_spell_block_to_death_seconds: 3.1,
      unblocked_seconds_from_first_damage: { min: 1.2, max: 2.2 },
      spell_blocked_at_first_damage: null,
    });
  });

  it('fight_timeline: the 30:11 mid fight in order', () => {
    const f = run('fight_timeline', { from: '30:05', to: '31:00' });
    expect(f.events.filter((e) => e.kind === 'death').map((e) => e.hero)).toEqual(['necrolyte', 'venomancer', 'axe', 'skywrath_mage', 'sven', 'undying', 'beastmaster', 'dark_willow']);
    expect(f.events.find((e) => e.kind === 'spell_immune')).toMatchObject({ hero: 'phantom_assassin', clock: '30:34' });
    expect(f.damage_to_heroes_by_unit[0]).toMatchObject({ unit: 'phantom_assassin' });
    expect(f.positions_at_start).toHaveLength(10);
    // The sides' losses are counted by the tool (Beastmaster is Dire): eight hero deaths, five of them his team's.
    expect(f.hero_deaths_in_window).toEqual({ radiant: 3, dire: 5 });
    expect(runTraceTool(trace, 'fight_timeline', { from: '30:05', to: '31:00' }, { perspective: 'beastmaster' }).hero_deaths_in_window).toEqual({ my_team: 5, enemy: 3 });
    expect(run('fight_timeline', { from: '1:00', to: '1:20' }).hero_deaths_in_window).toEqual({ radiant: 0, dire: 0 });
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
      // By game time: that is how a death is named to a player.
      // Noisy low-HP habit buckets are omitted from default LLM output unless include_legacy_habit_counts: true.
      three_or_more_enemy_heroes_dealing_damage: ['8:27', '22:06', '25:30', '30:42', '36:05'],
      // Nine of the eleven deaths were in a fight (three or more hero deaths close together, an ally near before).
      // 2:51 falls inside such a group by time, but no ally was within 2200: picked off alone, not in the fight.
      in_a_fight: ['6:13', '8:27', '11:03', '22:06', '25:30', '30:42', '36:05', '39:21', '41:57'],
      outside_fights: ['0:47', '2:51'],
      // Every death to three or more enemies was in a fight: outside them the count is none.
      three_or_more_enemy_heroes_dealing_damage_outside_fights: [],
      nothing_cast_and_no_item_used: [],
      // What the hero was doing and which way they were heading. This trace keeps no creep kills: whether a death
      // began farming is unknown, so none is listed. 0:47 and 11:03 came 1500 or more closer to the fountain.
      farming_at_window_start: [],
      heading_home_1500_or_more: ['0:47', '11:03'],
      heading_away_1500_or_more: [],
      // An enemy hero died within 15 s of seven of them; the four others bought nothing. 2:51, the one alone, was traded.
      traded_within_15s: ['2:51', '6:13', '8:27', '22:06', '25:30', '30:42', '39:21'],
      not_traded_within_15s: ['0:47', '11:03', '36:05', '41:57'],
      // This trace was built before wards and buybacks were read: unknown, so no death is in these lists.
      no_own_observer_within_1600: [],
      enemy_observer_within_1600: [],
      bought_back: [],
      before_a_nearby_fight_within_30s: [],
      non_hero_without_enemy_hero_damage: [],
      absorbed_enemy_ultimate: [],
    });
    expect(all.deaths.map((d) => d.in_a_fight)).toEqual([false, false, true, true, true, true, true, true, true, true, true]);
    expect([...all.deaths_where.in_a_fight, ...all.deaths_where.outside_fights]).toHaveLength(all.deaths_total);
    // Every death here had its health and position sampled: nothing a count could be missing (ultimateOf was not passed, so absorbed_enemy_ultimate is unknown for all 11).
    expect(all.deaths_not_known).toEqual({ health_at_window_start: 0, in_a_fight: 0, three_or_more_enemy_heroes_dealing_damage_outside_fights: 0, before_a_nearby_fight_within_30s: 0, non_hero_without_enemy_hero_damage: 0, absorbed_enemy_ultimate: 11 });
    // Legacy habit counts remain available when explicitly opted in (for saved browser goals).
    const legacy = run('death_context', { hero: 'beastmaster', include_legacy_habit_counts: true });
    expect(legacy.deaths_where.health_below_half_at_window_start).toEqual([]);
    expect(legacy.deaths_where.health_below_half_at_window_start_outside_fights).toEqual([]);
    expect(legacy.deaths_not_known.health_below_half_at_window_start_outside_fights).toBe(0);
    // Phantom Assassin's attacks are the largest single source: 44% of everything taken in the eleven windows.
    expect(all.damage_in_death_windows_total).toBe(23757);
    expect(Object.entries(all.damage_share_in_death_windows)[0]).toEqual(['phantom_assassin: attacks', 0.44]);
    expect(Object.keys(all.damage_in_death_windows)).toHaveLength(6);
    expect(all.deaths[1]).toMatchObject({ health_share_at_window_start: 0.75 });
    expect(all.deaths[1]).not.toHaveProperty('allies_within_2200');
    // Every second is looked at, not only the snapshots: with a 26 s window Undying is within 2200 at −25 s of the 2:51 death.
    const long = run('death_context', { hero: 'beastmaster', window: 26 });
    // Every second still tells a fight from a pick-off: the 2:51 death, with Undying within 2200 at −25 s of it, is
    // outside a fight with the default window.
    expect(all.deaths[1].in_a_fight).toBe(false);
    // Who was near is not told, as a count or per death (owner, 2026-11-27: meaningless).
    const pa = run('death_context', { hero: 'phantom_assassin', window: 16 });
    expect(pa.deaths[0].snapshots[0]).not.toHaveProperty('allies');
    expect(pa.deaths[0]).not.toHaveProperty('allies_within_2200');
    expect(pa.deaths_where).not.toHaveProperty('no_ally_within_2200_throughout');
    const mirana = run('death_context', { hero: 'mirana' });
    expect(mirana.deaths[3]).not.toHaveProperty('allies_within_2200');
    expect(mirana.deaths_where).not.toHaveProperty('no_ally_within_2200_at_death');
    // The working list behind the totals is not part of a record.
    expect(all.deaths.every((d) => !('damage_sources' in d))).toBe(true);
    // The counts are over the window asked for, so another window is another summary, with its own ref.
    expect(all.ref).toBe('deaths:beastmaster');
    const short = run('death_context', { hero: 'beastmaster', window: 4, include_legacy_habit_counts: true });
    expect(short).toMatchObject({ ref: 'deaths:beastmaster:w4', damage_in_death_windows_total: 18106 });
    expect(short.deaths_where.health_below_half_at_window_start).toHaveLength(4);
    // A fractional window is a whole number of seconds, so its refs resolve; 495 of 1000 health is below half though it rounds to 0.5.
    expect(run('death_context', { hero: 'beastmaster', window: 4.4 })).toMatchObject({ ref: 'deaths:beastmaster:w4', window: 4 });
    const m13 = run('death_context', { hero: 'mirana', window: 13, include_legacy_habit_counts: true });
    expect(m13.deaths[1]).toMatchObject({ clock: '13:21', health_share_at_window_start: 0.5, below_half_health_at_window_start: true });
    expect(m13.deaths_where.health_below_half_at_window_start).toContain('13:21');
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

  it('who won is whose Ancient fell, not who landed the last hit on it', () => {
    // In 7 of 32 parsed games the Ancient's kill row names no side (taker 0). Read off the taker, both teams
    // were told they lost and a reader with no side was told nobody won.
    const fortAt = trace.buildings.findIndex((b) => /_fort$/.test(trace.names[b[1]]));
    expect(trace.names[trace.buildings[fortAt][1]]).toBe('npc_dota_badguys_fort');
    const with_ = (taker) => ({ ...trace, buildings: trace.buildings.map((b, i) => (i === fortAt ? [b[0], b[1], taker, b[3]] : b)) });
    for (const taker of [2, 0, 3, null]) {
      const t = with_(taker);
      expect([taker, runTraceTool(t, 'match_overview', {}, { perspective: 'beastmaster' }).result]).toEqual([taker, 'my_team_lost']);
      expect([taker, runTraceTool(t, 'match_overview', {}, { perspective: 'axe' }).result]).toEqual([taker, 'my_team_won']);
      expect([taker, runTraceTool(t, 'match_overview', {}, {}).winner]).toEqual([taker, 'radiant']);
    }
    // The other Ancient: the other answer.
    const names = trace.names.map((n) => (n === 'npc_dota_badguys_fort' ? 'npc_dota_goodguys_fort' : n));
    expect(runTraceTool({ ...with_(0), names }, 'match_overview', {}, { perspective: 'beastmaster' }).result).toBe('my_team_won');
    expect(runTraceTool({ ...with_(0), names }, 'match_overview', {}, {}).winner).toBe('dire');
    // No Ancient fell in the trace (a replay cut short): nobody is said to have won or lost.
    const cut = { ...trace, buildings: trace.buildings.filter((_, i) => i !== fortAt) };
    expect(runTraceTool(cut, 'match_overview', {}, { perspective: 'beastmaster' })).toMatchObject({ result: null, duration: null });
    expect(runTraceTool(cut, 'match_overview', {}, {}).winner).toBeNull();
  });

  it('told from a player, sides replace Radiant/Dire and the gold sign', () => {
    const adv = new Array(45).fill(0); adv[30] = 745; adv[32] = 4298;
    const ctx = { perspective: 'beastmaster', match: { radiant_gold_adv: adv } };
    const o = runTraceTool(trace, 'match_overview', {}, ctx);
    expect(o).toMatchObject({ told_from: { hero: 'beastmaster' }, result: 'my_team_lost', fights_total: 16, fights_tally: { my_team_lost_fewer: 6, enemy_lost_fewer: 9, even: 1 } });
    expect(o).not.toHaveProperty('winner');
    expect(o.heroes.find((h) => h.hero === 'beastmaster')).toEqual({ hero: 'beastmaster', side: 'me', deaths: 11, deaths_before_10: 4, final_level: 21 });
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

  it('tempo_report: who took the map and when, whether fights became buildings, and where the hero was', () => {
    const r = runTraceTool(trace, 'tempo_report', { hero: 'Beastmaster' }, { perspective: 'beastmaster' });
    expect(r).toMatchObject({ ref: 'tempo:beastmaster', ref_scope: 'summary', hero: 'beastmaster', side: 'me', duration: { clock: '42:31' }, phases_total: 5, fights_total: 16 });
    // Read off the building kills of the combat log: Dire took the three outer Radiant towers at 18:07–19:46 and one more; Radiant took everything after 20:02.
    expect(r.buildings_total).toEqual({ team_took: 4, opponents_took: 18 });
    expect(r.first_building_taken).toEqual({ by_team: '18:07', by_opponents: '20:02' });
    expect(r.buildings_team_took_by_phase).toEqual({ '0:00–10:00': 0, '10:00–20:00': 3, '20:00–30:00': 1, '30:00–40:00': 0, '40:00–42:31': 0 });
    expect(r.buildings_opponents_took_by_phase).toEqual({ '0:00–10:00': 0, '10:00–20:00': 0, '20:00–30:00': 3, '30:00–40:00': 3, '40:00–42:31': 12 });
    // The filler buildings around the base are not objectives.
    expect(trace.buildings.filter((b) => /fillers/.test(trace.names[b[1]]))).not.toHaveLength(0);
    expect(JSON.stringify(r)).not.toMatch(/fillers/);
    // Every real hero death of the game is in exactly one stretch; Phantom Assassin's Aegis revival at 36:43 is in resurrections, not hero deaths.
    const sum = (m) => Object.values(m).reduce((a, b) => a + b, 0);
    const o = runTraceTool(trace, 'match_overview', {}, { perspective: 'beastmaster' });
    expect(sum(r.team_hero_deaths_by_phase) + sum(r.opponents_hero_deaths_by_phase)).toBe(realDeaths(trace).length);
    expect(realDeaths(trace).length).toBe(o.heroes.reduce((n, h) => n + h.deaths, 0));
    expect(realDeaths(trace).length + resurrections(trace).length).toBe(trace.deaths.length);
    expect(resurrections(trace)).toMatchObject([{ by: 'aegis', t: 2203.2 }]);
    // The same fights as match_overview, by when they began: six with fewer lost, nine with more, one even.
    expect(r.fights_where.team_lost_fewer_heroes).toHaveLength(o.fights_tally.my_team_lost_fewer);
    expect(r.fights_where.opponents_lost_fewer_heroes).toHaveLength(o.fights_tally.enemy_lost_fewer);
    // One of the six became a building within two minutes; five of the enemy's nine did.
    expect(r.fights_where.team_lost_fewer_heroes_and_took_a_building_within_120s).toEqual(['22:57']);
    expect(r.fights_where.opponents_lost_fewer_heroes_and_took_a_building_within_120s).toEqual(['25:25', '30:26', '35:40', '39:16', '41:57']);
    expect(r.fights_where.hero_was_not_there).toEqual(['37:46']);
    expect(r.fights_where.hero_was_there).toHaveLength(15);
    expect(r.fights_where.hero_presence_not_known).toEqual([]);
    expect(r.buildings_team_took_where).toEqual({ hero_damaged_it: ['18:45', '19:46', '25:05'], hero_did_not_damage_it: ['18:07'], not_known: [] });
    expect(r.team_heroes_damage_to_buildings).toEqual({ skywrath_mage: 512, undying: 137, dark_willow: 242, sven: 480, beastmaster: 540 });

    const p3 = r.phases[2];
    expect(p3).toMatchObject({ ref: 'phase:beastmaster:3', from: 1200, to: 1800, clock: '20:00–30:00', buildings_team_took: 1, buildings_opponents_took: 3, team_hero_deaths: 10, opponents_hero_deaths: 9, hero_deaths: 2 });
    expect(p3.buildings.map((b) => [b.building, b.clock, b.taken_by])).toEqual([['badguys_tower1_mid', '20:02', 'opponents'], ['badguys_tower1_bot', '24:28', 'opponents'], ['goodguys_tower2_top', '25:05', 'team'], ['badguys_tower1_top', '25:59', 'opponents']]);
    expect(p3.buildings[2]).toMatchObject({ hero_damaged_it: true, heroes_who_damaged_it: ['undying', 'beastmaster', 'skywrath_mage'] });
    expect(p3.buildings[0]).not.toHaveProperty('hero_damaged_it');
    // A fight inside a stretch is not a record of its own: it says which fight of match_overview it is, and has no ref.
    expect(p3.fights.map((f) => f.overview_fight)).toEqual(['fight:7', 'fight:8', 'fight:9', 'fight:10']);
    expect(p3.fights.some((f) => 'ref' in f)).toBe(false);
    // Shares are of the seconds alive, and the three sides of the map add up to all of them.
    expect(p3.hero_alive_seconds + p3.hero_dead_seconds).toBe(600);
    expect(r.phases.map((p) => p.hero_seconds_not_sampled)).toEqual([0, 0, 0, 0, 0]);
    const s = p3.hero_share_of_alive_time;
    // Dire's side of the map is his own: the first ten minutes in his own bottom lane, the end in his base.
    expect(r.phases.map((p) => p.hero_share_of_alive_time.on_own_side_of_the_map)).toEqual([0.75, 0.51, 0.44, 0.76, 1]);
    expect(s).toEqual({ on_own_side_of_the_map: 0.44, around_the_river: 0.22, on_the_opponents_side: 0.34, with_three_or_more_opponents_within_2200: 0.19 });
    expect(s.on_own_side_of_the_map + s.around_the_river + s.on_the_opponents_side).toBeCloseTo(1, 1);
    expect(p3.hero_most_time_in[0]).toEqual({ place: 'radiant_top_lane', share_of_alive_time: 0.32 });
    // The last stretch is cut at the Ancient's fall, which belongs to it.
    expect(r.phases.at(-1)).toMatchObject({ clock: '40:00–42:31', to: 2551, buildings_opponents_took: 12 });
    expect(r.phases.at(-1).buildings.at(-1)).toMatchObject({ building: 'badguys_fort', clock: '42:31' });
    expect(sum(Object.fromEntries(r.phases.map((p) => [p.ref, p.hero_damage_to_buildings])))).toBe(540);
    // The stretches and the whole game are sums over the same damage rows, for either side — the second the Ancient fell included.
    for (const hero of ['beastmaster', 'axe']) {
      const x = runTraceTool(trace, 'tempo_report', { hero });
      expect(x.phases.reduce((a, p) => a + p.team_heroes_damage_to_buildings, 0)).toBe(sum(x.team_heroes_damage_to_buildings));
      expect(x.phases.reduce((a, p) => a + p.hero_damage_to_buildings, 0)).toBe(x.team_heroes_damage_to_buildings[hero]);
    }
    expect(runTraceTool(trace, 'tempo_report', { hero: 'axe' }).team_heroes_damage_to_buildings.axe).toBe(1065);
    // No gold in the trace: a stated gap, and no lead in the stretches. With the match's per-minute lead, each stretch has it from the hero's side.
    expect(r.gaps.map((g) => g.topic)).toEqual(['vision', 'creeps', 'roshan', 'building_damage_by_summoned_units_and_illusions', 'gold_advantage']);
    expect(p3).not.toHaveProperty('team_gold_lead');
    const adv = new Array(45).fill(0); adv[20] = 1200; adv[30] = 745;
    const g = runTraceTool(trace, 'tempo_report', { hero: 'beastmaster' }, { match: { radiant_gold_adv: adv } });
    expect(g.phases[2].team_gold_lead).toEqual({ at_start: -1200, at_end: -745 });
    expect(g.phases.at(-1).team_gold_lead).toEqual({ at_start: -0, at_end: -0 });
    expect(g.gaps.map((x) => x.topic)).not.toContain('gold_advantage');
    expect(g).not.toHaveProperty('side');
  });

  it('tempo_report is told from the hero asked about, whoever is reading', () => {
    const pa = runTraceTool(trace, 'tempo_report', { hero: 'phantom_assassin' }, { perspective: 'beastmaster' });
    expect(pa).toMatchObject({ ref: 'tempo:phantom_assassin', side: 'enemy', buildings_total: { team_took: 18, opponents_took: 4 }, first_building_taken: { by_team: '20:02', by_opponents: '18:07' } });
    expect(pa.fights_where.team_lost_fewer_heroes).toHaveLength(9);
    expect(pa.team_heroes_damage_to_buildings.phantom_assassin).toBe(18231);
    // The two towers beside the Ancient share a name: who hit which is not known, and is in neither list.
    expect(pa.buildings_team_took_where.not_known).toEqual(['41:46', '41:52']);
    expect(pa.buildings_team_took_where.hero_damaged_it).toHaveLength(16);
    const t4 = pa.phases.at(-1).buildings.find((b) => b.building === 'badguys_tower4');
    expect(t4.hero_damaged_it).toBeNull();
    expect(t4).not.toHaveProperty('heroes_who_damaged_it');
  });

  it('tempo_report does not turn what was not sampled into an answer', () => {
    // Beastmaster's positions gone: no share of time anywhere, and no claim about which fights he was at.
    const h = trace.heroes.findIndex((x) => x.key === 'beastmaster');
    const blank = { ...trace, states: trace.states.map((s, i) => (i === h ? { ...s, x: s.x.map(() => null), y: s.y.map(() => null) } : s)) };
    const r = runTraceTool(blank, 'tempo_report', { hero: 'beastmaster' });
    expect(r.phases[1]).toMatchObject({ hero_alive_seconds: 0, hero_dead_seconds: 0, hero_seconds_not_sampled: 600, hero_most_time_in: null });
    expect(Object.values(r.phases[1].hero_share_of_alive_time)).toEqual([null, null, null, null]);
    // He died in some of them (that is in the combat log); for the rest nothing can be said.
    expect(r.fights_where.hero_was_not_there).toEqual([]);
    expect(r.fights_where.hero_was_there.length + r.fights_where.hero_presence_not_known.length).toBe(16);
    expect(r.fights_where.hero_presence_not_known.length).toBeGreaterThan(0);
    // One sample of his own left in a stretch: a share of the one second seen is not a share of the stretch. None is stated.
    const keep = 1500 - trace.t0;
    const sliver = { ...trace, states: trace.states.map((s, i) => (i === h ? { ...s, x: s.x.map((v, j) => (j >= 1200 - trace.t0 && j < 1800 - trace.t0 && j !== keep ? null : v)) } : s)) };
    const thin = runTraceTool(sliver, 'tempo_report', { hero: 'beastmaster' }).phases[2];
    // A sample stands for the two seconds either side of it, as everywhere in the trace tools: five seconds around
    // 25:00, and two at each end of the stretch from the samples just outside it.
    expect(thin).toMatchObject({ hero_alive_seconds: 9, hero_seconds_not_sampled: 591, hero_most_time_in: null });
    expect(Object.values(thin.hero_share_of_alive_time)).toEqual([null, null, null, null]);
    // The stretches around it were sampled throughout and keep their shares.
    expect(runTraceTool(sliver, 'tempo_report', { hero: 'beastmaster' }).phases[1]).toMatchObject({ hero_seconds_not_sampled: 0, hero_share_of_alive_time: { on_own_side_of_the_map: 0.51 } });
    // The other heroes' positions gone, his own kept: where he was is known, who was near him is not — not "alone".
    const others = { ...trace, states: trace.states.map((s, i) => (i === h ? s : { ...s, x: s.x.map(() => null), y: s.y.map(() => null) })) };
    const lone = runTraceTool(others, 'tempo_report', { hero: 'beastmaster' }).phases[2];
    expect(lone.hero_alive_seconds).toBe(504);
    expect(lone.hero_share_of_alive_time).toEqual({ on_own_side_of_the_map: 0.44, around_the_river: expect.any(Number), on_the_opponents_side: expect.any(Number), with_three_or_more_opponents_within_2200: null });
    // One ally unsampled: the opponents were all sampled, so that share stands.
    const sven = trace.heroes.findIndex((x) => x.key === 'sven');
    const oneGone = { ...trace, states: trace.states.map((s, i) => (i === sven ? { ...s, x: s.x.map(() => null), y: s.y.map(() => null) } : s)) };
    const partial = runTraceTool(oneGone, 'tempo_report', { hero: 'beastmaster' }).phases[2].hero_share_of_alive_time;
    expect(partial).toMatchObject({ with_three_or_more_opponents_within_2200: 0.19 });
    // Sampled far from the first death of a fight and not at all at the later ones: he may have been at those. Unknown, not absent.
    expect(runTraceTool(trace, 'tempo_report', { hero: 'beastmaster' }).fights_where.hero_was_not_there).toEqual(['37:46']);
    const i0 = 2270 - trace.t0; const i1 = 2280 - trace.t0;
    const partly = { ...trace, states: trace.states.map((s, i) => (i === h ? { ...s, x: s.x.map((v, j) => (j >= i0 && j <= i1 ? null : v)) } : s)) };
    const half = runTraceTool(partly, 'tempo_report', { hero: 'beastmaster' }).fights_where;
    expect(half.hero_was_not_there).toEqual([]);
    expect(half.hero_presence_not_known).toEqual(['37:46']);
    expect(half.hero_was_there).toHaveLength(15);
    // One tower beside the Ancient left in the log (the other never fell): damage to either is under the one name, so who hit this one is still not known.
    const t4 = trace.buildings.findIndex((b) => /badguys_tower4$/.test(trace.names[b[1]]));
    const single = { ...trace, buildings: trace.buildings.filter((_, i) => i !== t4) };
    const one = runTraceTool(single, 'tempo_report', { hero: 'phantom_assassin' });
    expect(one.buildings_team_took_where.not_known).toEqual(['41:52']);
    expect(one.phases.at(-1).buildings.find((b) => b.building === 'badguys_tower4')).toMatchObject({ hero_damaged_it: null });
    // A building its own side destroyed is nobody's objective.
    const b0 = trace.buildings.findIndex((b) => /goodguys_tower1_top/.test(trace.names[b[1]]));
    const denied = { ...trace, buildings: trace.buildings.map((b, i) => (i === b0 ? [b[0], b[1], 2, b[3]] : b)) };
    expect(runTraceTool(denied, 'tempo_report', { hero: 'beastmaster' }).buildings_total).toEqual({ team_took: 3, opponents_took: 18 });
    expect(runTraceTool(trace, 'tempo_report', { hero: 'pudge' })).toMatchObject({ error: 'unknown_hero' });
    expect(runTraceTool(trace, 'tempo_report', {})).toMatchObject({ error: 'unknown_hero' });
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

describe('a hero the states name differently from the combat log', () => {
  // Seen in 9102724734: the states say queen_of_pain, the combat log npc_dota_hero_queenofpain. Her 4 deaths
  // and 522 casts were not hers, and match_overview said she never died.
  const state = (t, hero, team, player_index) => ({ entity_kind: 'real_hero', t, hero, team, player_index, x: 0, y: 0, hp: 500, max_hp: 600, mana: 100, level: 1, life_state: 0, abilities: [], items: [], controls: {} });
  const build = () => {
    const b = createTraceBuilder();
    for (const t of [0, 1, 100]) { b.addState(state(t, 'queen_of_pain', 2, 0)); b.addState(state(t, 'anti_mage', 3, 5)); }
    b.addEvent({ t: 50, type: 'DOTA_COMBATLOG_DEATH', target: 'npc_dota_hero_queenofpain', target_hero: true, attacker: 'npc_dota_hero_antimage', attacker_hero: true });
    b.addEvent({ t: 40, type: 'DOTA_COMBATLOG_ABILITY', attacker: 'npc_dota_hero_queenofpain', attacker_hero: true, inflictor: 'queenofpain_blink', target: 'npc_dota_hero_queenofpain' });
    return b.finish({ match_id: 7 });
  };

  it('takes the combat log name, so the hero\'s deaths and casts are hers', () => {
    const tr = build();
    expect(tr.heroes.map((h) => h.npc)).toEqual(['npc_dota_hero_queenofpain', 'npc_dota_hero_antimage']);
    const overview = runTraceTool(tr, 'match_overview', { hero: 'queen_of_pain' });
    expect(overview.heroes.find((h) => h.hero === 'queen_of_pain').deaths).toBe(1);
  });

  it('a trace stored before this is linked when read, and a hero the log never names keeps its own name', () => {
    const old = build();
    old.heroes[0].npc = 'npc_dota_hero_queen_of_pain';
    expect(runTraceTool(old, 'match_overview', { hero: 'queen_of_pain' }).heroes.find((h) => h.hero === 'queen_of_pain').deaths).toBe(0);
    const linked = linkHeroNames(old);
    expect(linked.heroes.map((h) => h.npc)).toEqual(['npc_dota_hero_queenofpain', 'npc_dota_hero_antimage']);
    expect(runTraceTool(linked, 'match_overview', { hero: 'queen_of_pain' }).heroes.find((h) => h.hero === 'queen_of_pain').deaths).toBe(1);
    const quiet = { names: ['npc_dota_hero_queenofpain'], heroes: [{ key: 'void_spirit', npc: 'npc_dota_hero_void_spirit' }] };
    expect(linkHeroNames(quiet).heroes[0].npc).toBe('npc_dota_hero_void_spirit');
  });
});
