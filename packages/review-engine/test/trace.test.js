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
    expect(d.at_window_start.abilities).toEqual([{ ability: 'axe_culling_blade', level: 1, cooldown_left: 95 }]);
    expect(d.ready_not_cast).toEqual([]);
  });

  it('an active ability the player never pressed still shows as ready and not used', () => {
    const b = createTraceBuilder();
    for (let t = 0; t <= 30; t += 0.25) {
      b.addState(state(t, { abilities: [{ name: 'axe_berserkers_call', level: 1, cooldown: 0, mana_cost: 80 }, { name: 'axe_counter_helix', level: 1, cooldown: 0, mana_cost: 0 }] }));
      b.addState(lina(t));
    }
    b.addEvent({ type: 'DOTA_COMBATLOG_DEATH', t: 25, target: 'npc_dota_hero_axe', target_hero: true, target_illusion: false, attacker: 'npc_dota_hero_lina', attacker_hero: true, attacker_illusion: false }, 1);
    const out = runTraceTool(b.finish(), 'death_context', { hero: 'axe' });
    expect(out.deaths[0].at_window_start.abilities).toEqual([{ ability: 'axe_berserkers_call', level: 1, cooldown_left: 0 }]);
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

  it('an ability that leaves the hero is no longer ready-and-unused', () => {
    const b = createTraceBuilder();
    for (let t = 0; t <= 30; t += 0.25) {
      b.addState(state(t, { abilities: [{ name: 'axe_berserkers_call', level: 1, cooldown: 0, mana_cost: 80 }, ...(t <= 4 ? [{ name: 'lina_laguna_blade', level: 1, cooldown: t >= 2 ? 50 - t : 0, mana_cost: 250 }] : [])] }));
      b.addState(lina(t));
    }
    b.addEvent({ type: 'DOTA_COMBATLOG_DEATH', t: 25, target: 'npc_dota_hero_axe', target_hero: true, target_illusion: false, attacker: 'npc_dota_hero_lina', attacker_hero: true, attacker_illusion: false }, 1);
    const tr = b.finish();
    expect(tr.abilities[0].lina_laguna_blade).toEqual({ levels: [[0, 1], [4.3, 0]], cd: [[2, 4.3, 48]], mana: 250 });
    const d = runTraceTool(tr, 'death_context', { hero: 'axe' }).deaths[0];
    expect(d.at_window_start.abilities.map((a) => a.ability)).toEqual(['axe_berserkers_call']);
    expect(d.ready_not_cast).toEqual(['axe_berserkers_call']);
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
  it('lists five tools with JSON-schema inputs', () => {
    expect(TRACE_TOOLS.map((t) => t.name)).toEqual(['match_overview', 'death_context', 'ability_audit', 'immunity_windows', 'fight_timeline']);
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
