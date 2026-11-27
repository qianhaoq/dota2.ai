import { describe, expect, it } from 'vitest';
import { createTraceBuilder, runTraceTool } from '../../packages/review-engine/src/trace/index.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { ultimateOf as coachUltimateOf } from '../../lib/coach/chapters.js';
import { ultimateOf, ultimatesOf } from '../../lib/agent/ultimates.js';
import { evaluateHabit } from '../../lib/coach/goals.js';

function makeAbaddonTrace(overrides: any = {}) {
  const n = overrides.n ?? 1600;
  const heroes = [
    { key: 'abaddon', npc: 'npc_dota_hero_abaddon', team: 2, player_index: 0 },
    { key: 'lion', npc: 'npc_dota_hero_lion', team: 3, player_index: 5 },
    { key: 'phantom_assassin', npc: 'npc_dota_hero_phantom_assassin', team: 3, player_index: 6 },
  ];
  const names = [
    ...heroes.map((h) => h.npc),
    'abaddon_borrowed_time',
    'abaddon_aphotic_shield',
    ...(overrides.extraNames ?? []),
  ];
  const dead: Record<string, [number, number][]> = overrides.dead ?? {};
  const states = heroes.map((h) => {
    const ranges = dead[h.key] ?? [];
    const alive = Array.from({ length: n }, (_, s) => (ranges.some(([a, b]) => s >= a && s < b) ? 0 : 1));
    return {
      x: Array(n).fill(h.key === 'abaddon' ? 100 : 300),
      y: Array(n).fill(100),
      hp: Array(n).fill(900),
      max_hp: Array(n).fill(1200),
      mana: Array(n).fill(400),
      mana_peak: Array(n).fill(400),
      level: Array(n).fill(12),
      alive,
    };
  });
  return {
    schema: 'dota2.ai/match-trace@1',
    match_id: 9106357143,
    t0: 0,
    n,
    heroes,
    names,
    states,
    abilities: overrides.abilities ?? [
      {
        abaddon_borrowed_time: {
          levels: [[500, 1], [1100, 2]],
          cd: [],
        },
        abaddon_aphotic_shield: {
          levels: [[10, 1]],
          cd: [],
          mana: 95,
          costs: [[10, 95]],
        },
      },
      {},
      {},
    ],
    items: overrides.items ?? [{}, {}, {}],
    controls: overrides.controls ?? [{}, {}, {}],
    casts: overrides.casts ?? [],
    item_uses: [],
    purchases: [],
    buildings: [],
    modifiers: [],
    damage: overrides.damage ?? [],
    deaths: overrides.deaths ?? [],
    buybacks: [],
    gaps: [],
  };
}

describe('Abaddon Borrowed Time auto-trigger & 0-mana recognition', () => {
  it('recognizes cooldown-detected auto-triggered Borrowed Time with 0 manual casts across ability_audit, death_context, fight_timeline, and evidence resolution', () => {
    const tr = makeAbaddonTrace({
      abilities: [
        {
          abaddon_borrowed_time: {
            levels: [[500, 1], [1100, 2]],
            // 3 auto-triggered activations (zero rows in trace.casts).
            cd: [
              [600.2, 685.2, 85],
              [800.4, 885.4, 84.9],
              [1200.5, 1275.5, 74.9],
            ],
          },
          abaddon_aphotic_shield: {
            levels: [[10, 1]],
            cd: [],
            mana: 95,
            costs: [[10, 95]],
          },
        },
        {},
        {},
      ],
      // Death 1 at 807.0: Borrowed Time auto-triggered at 800.4 (-6.6s) -> NOT ready_not_cast.
      // Death 2 at 1050.0: Borrowed Time was ready and never triggered (e.g. burst/Break) -> IS ready_not_cast.
      damage: [
        [800, 2, 0, -1, 900],
        [806, 2, 0, -1, 600],
        [1049, 2, 0, -1, 1200],
      ],
      deaths: [
        [807.0, 0, 2, 10],
        [1050.0, 0, 2, 20],
      ],
      dead: { abaddon: [[807, 840], [1050, 1090]] },
    });

    const audit: any = runTraceTool(tr, 'ability_audit', { hero: 'abaddon', ability: 'borrowed_time' });
    expect(audit).toMatchObject({
      casts_total: 3,
      manual_casts_total: 0,
      auto_triggered_total: 3,
      deaths_with_it_ready_and_not_cast_total: 1,
    });
    expect(audit.deaths_with_it_ready_and_not_cast).toHaveLength(1);
    expect(audit.deaths_with_it_ready_and_not_cast[0].clock).toBe('17:30');
    expect(audit.casts.map((c: any) => [c.ref, c.clock, c.trigger])).toEqual([
      ['cast:abaddon:borrowed_time:1', '10:00', 'auto'],
      ['cast:abaddon:borrowed_time:2', '13:20', 'auto'],
      ['cast:abaddon:borrowed_time:3', '20:00', 'auto'],
    ]);

    const dc: any = runTraceTool(tr, 'death_context', { hero: 'abaddon' }, { ultimateOf, ultimatesOf });
    // Borrowed Time is included in at_window_start.abilities even with 0 mana and 0 manual casts.
    expect(dc.deaths[0].at_window_start.abilities.map((a: any) => a.ability)).toContain('abaddon_borrowed_time');
    // Death 1 (807.0): auto-triggered at 800.4 -> listed under auto_triggered, NOT ready_not_cast.
    expect(dc.deaths[0].ready_not_cast).not.toContain('abaddon_borrowed_time');
    expect(dc.deaths[0].auto_triggered).toEqual([{ dt: -6.6, clock: '13:20', ability: 'abaddon_borrowed_time' }]);
    // Death 2 (1050.0): genuinely died holding Borrowed Time -> listed under ready_not_cast.
    expect(dc.deaths[1].ready_not_cast).toContain('abaddon_borrowed_time');
    expect(dc.deaths[1].auto_triggered).toBeUndefined();

    // fight_timeline emits an auto_trigger event for Borrowed Time.
    const tl: any = runTraceTool(tr, 'fight_timeline', { from: 790, to: 815 }, { perspective: 'abaddon' });
    expect(tl.events.some((e: any) => e.kind === 'auto_trigger' && e.hero === 'abaddon' && e.ability === 'abaddon_borrowed_time' && e.clock === '13:20')).toBe(true);

    // Evidence resolution resolves both the audit summary and each auto-triggered cast ref.
    const evAudit = resolveRef(tr, 'audit:abaddon:borrowed_time', { hero: 'abaddon', lang: 'zh' });
    expect(evAudit?.record).toMatchObject({ casts_total: 3, manual_casts_total: 0, auto_triggered_total: 3 });
    expect(evAudit?.names.abaddon_borrowed_time).toBe('回光返照');

    const evCast = resolveRef(tr, 'cast:abaddon:borrowed_time:2', { hero: 'abaddon', lang: 'zh' });
    expect(evCast?.record).toMatchObject({ clock: '13:20', trigger: 'auto', row: null });
  });

  it('pairs manual casts with their cooldown starts without double counting, and ignores mid-cooldown reduction splits while counting immediate re-triggers and refreshes', () => {
    const tr = makeAbaddonTrace({
      abilities: [
        {
          abaddon_borrowed_time: {
            levels: [[500, 1], [1100, 2]],
            cd: [
              // 1) Manual cast at 600.0 -> cd at 600.1, then cut twice mid-cooldown by The Quickening (-6s each).
              [600.1, 610.0, 85],
              [610.0, 615.0, 69.0], // expected 75.1 -> cut by 6.1s (NOT a new activation)
              [615.0, 673.0, 58.0], // expected 64.0 -> cut by 6.0s (NOT a new activation)
              // 2) Auto-trigger right after cooldown finishes (0.3s gap, prevRem = 0 -> IS a new activation).
              [673.3, 758.3, 85],
              // 3) Refresher Orb resets mid-cooldown at 768.0 -> immediately auto-triggers with full 85s cd (IS a new activation).
              [768.0, 853.0, 85],
              // 4) Manual cast at 1200.0 -> cd at 1200.2.
              [1200.2, 1275.2, 75],
            ],
          },
        },
        {},
        {},
      ],
      casts: [
        [600.0, 0, 3, -1, 101],
        [1200.0, 0, 3, -1, 202],
      ],
      // Death at 612.0 (12s window starts at 600.0): manual cast at 600.0 was paired with cd at 600.1 -> not auto_triggered and not ready_not_cast.
      // Death at 680.0: auto-trigger at 673.3 -> in auto_triggered, not ready_not_cast.
      deaths: [
        [612.0, 0, 2, 30],
        [680.0, 0, 2, 40],
      ],
    });

    const audit: any = runTraceTool(tr, 'ability_audit', { hero: 'abaddon', ability: 'borrowed_time' });
    expect(audit).toMatchObject({
      casts_total: 4,
      manual_casts_total: 2,
      auto_triggered_total: 2,
      deaths_with_it_ready_and_not_cast_total: 0,
    });
    expect(audit.casts.map((c: any) => [c.clock, c.trigger])).toEqual([
      ['10:00', 'manual'],
      ['11:13', 'auto'],
      ['12:48', 'auto'],
      ['20:00', 'manual'],
    ]);

    const dc: any = runTraceTool(tr, 'death_context', { hero: 'abaddon' });
    expect(dc.deaths[0].ready_not_cast).not.toContain('abaddon_borrowed_time');
    expect(dc.deaths[0].auto_triggered).toBeUndefined();
    expect(dc.deaths[1].ready_not_cast).not.toContain('abaddon_borrowed_time');
    expect(dc.deaths[1].auto_triggered).toEqual([{ dt: -6.7, clock: '11:13', ability: 'abaddon_borrowed_time' }]);
  });

  it('keeps counts unknown (null) with a gap when cooldown samples are blanked in the trace', () => {
    const tr = makeAbaddonTrace({
      abilities: [
        {
          abaddon_borrowed_time: {
            levels: [[500, 1]],
            // Blanked cd (missing array) -> cannot determine auto-triggers or readiness.
          },
        },
        {},
        {},
      ],
      deaths: [[700.0, 0, 2, 50]],
    });

    const audit: any = runTraceTool(tr, 'ability_audit', { hero: 'abaddon', ability: 'borrowed_time' });
    expect(audit).toMatchObject({
      casts_total: null,
      manual_casts_total: 0,
      auto_triggered_total: null,
      seconds_alive_and_ready: null,
      deaths_with_it_ready_and_not_cast_total: null,
      deaths_with_it_ready_and_not_cast: null,
    });
    expect(audit.gaps.some((g: any) => g.reason === 'auto_triggered_cooldowns_missing_in_trace')).toBe(true);
    expect(evaluateHabit({ kind: 'replay_habit', habit: 'died_holding', max: 1, name: { en: 'Borrowed Time', zh: '回光返照' } }, audit, 30).result).toBe('unknown');

    const dc: any = runTraceTool(tr, 'death_context', { hero: 'abaddon' });
    const bt = dc.deaths[0].at_window_start.abilities.find((a: any) => a.ability === 'abaddon_borrowed_time');
    expect(bt.cooldown_left).toBeNull();
    expect(dc.deaths[0].ready_not_cast).not.toContain('abaddon_borrowed_time');
    expect(dc.gaps.some((g: any) => g.topic === 'ability_casts' && g.reason === 'auto_triggered_cooldowns_missing_in_trace')).toBe(true);

    // fight_timeline also propagates the missing-cooldown gap when Borrowed Time is learned in the window.
    const tl: any = runTraceTool(tr, 'fight_timeline', { from: 680, to: 720 }, { perspective: 'abaddon' });
    expect(tl.gaps.some((g: any) => g.topic === 'ability_casts' && g.reason === 'auto_triggered_cooldowns_missing_in_trace')).toBe(true);
    // Before Borrowed Time was learned, no missing-cooldown gap is emitted.
    const tlEarly: any = runTraceTool(tr, 'fight_timeline', { from: 100, to: 200 }, { perspective: 'abaddon' });
    expect(tlEarly.gaps.some((g: any) => g.reason === 'auto_triggered_cooldowns_missing_in_trace')).toBe(false);
  });

  it('distinguishes level-up + Refresher activations (with or without a zero-cooldown sample) from continuous cooldown cuts via createTraceBuilder', () => {
    const b = createTraceBuilder();
    const sample = (t: number, level: number, cooldown: number) => b.addState({
      entity_kind: 'real_hero',
      hero: 'abaddon',
      team: 2,
      player_index: 0,
      t,
      x: 100,
      y: 100,
      hp: 800,
      max_hp: 1200,
      mana: 400,
      level: 12,
      life_state: 0,
      abilities: [{ name: 'abaddon_borrowed_time', level, cooldown, mana_cost: 0 }],
      items: [],
      controls: {},
    });
    // 1) Level-1 auto-trigger at 600, upgraded to level 2 at 602, Refresher zero-cd at 606, level-2 auto-trigger at 606.25.
    sample(599, 1, 0);
    sample(600, 1, 85);
    sample(602, 2, 83);
    sample(606, 2, 0);
    sample(606.25, 2, 75);
    sample(681.3, 2, 0);
    // 2) Same-tick Refresher reset + immediate level-2 auto-trigger (no cd=0 sample between 700 and 706, item_refresher logged at 705.8).
    sample(700, 1, 85);
    sample(702, 2, 83);
    b.addEvent({ type: 'DOTA_COMBATLOG_ITEM', t: 705.8, attacker: 'npc_dota_hero_abaddon', attacker_hero: true, inflictor: 'item_refresher' }, 50);
    sample(706, 2, 75);
    sample(781, 2, 0);
    const built = b.finish();

    const audit: any = runTraceTool(built, 'ability_audit', { hero: 'abaddon', ability: 'borrowed_time' });
    expect(audit).toMatchObject({ casts_total: 4, manual_casts_total: 0, auto_triggered_total: 4 });
    expect(audit.casts.map((c: any) => c.t)).toEqual([600, 606.3, 700, 706]);

    const tl: any = runTraceTool(built, 'fight_timeline', { from: 595, to: 620 }, { perspective: 'abaddon' });
    const autoTimes = tl.events.filter((e: any) => e.kind === 'auto_trigger' && e.ability === 'abaddon_borrowed_time').map((e: any) => e.t);
    expect(autoTimes).toEqual([600, 606.3]);
  });

  it('preserves unknown proximity (null + gap) when Abaddon or another hero has missing position samples around an auto-trigger', () => {
    const tr = makeAbaddonTrace({
      abilities: [
        {
          abaddon_borrowed_time: {
            levels: [[500, 1]],
            cd: [
              [600.2, 685.2, 85],
              [900.2, 985.2, 85],
              [1200.2, 1285.2, 85],
            ],
          },
        },
        {},
        {},
      ],
      // Add an ally (index 3) so both sides are exercised independently.
    });
    tr.heroes.push({ key: 'sven', npc: 'npc_dota_hero_sven', team: 2, player_index: 1 });
    tr.names.push('npc_dota_hero_sven');
    tr.states.push({
      x: Array(tr.n).fill(150),
      y: Array(tr.n).fill(100),
      hp: Array(tr.n).fill(900),
      max_hp: Array(tr.n).fill(1200),
      mana: Array(tr.n).fill(400),
      mana_peak: Array(tr.n).fill(400),
      level: Array(tr.n).fill(12),
      alive: Array(tr.n).fill(1),
    });
    tr.abilities.push({});
    tr.items.push({});
    tr.controls.push({});

    // Activation 1 (600.2): blank Abaddon's position around 600 -> me: null, allies & enemies both null.
    for (let s = 595; s <= 605; s += 1) {
      tr.states[0].x[s] = null;
      tr.states[0].y[s] = null;
    }
    // Activation 2 (900.2): blank enemy Lion (index 1) around 900 while alive -> enemies null, allies still known (['sven']).
    for (let s = 895; s <= 905; s += 1) {
      tr.states[1].x[s] = null;
      tr.states[1].y[s] = null;
    }
    // Activation 3 (1200.2): Lion is confirmed dead with blanked position, PA is far away -> enemies known ([]), allies known (['sven']).
    for (let s = 1195; s <= 1205; s += 1) {
      tr.states[1].alive[s] = 0;
      tr.states[1].x[s] = null;
      tr.states[1].y[s] = null;
      tr.states[2].x[s] = 5000;
    }

    const audit: any = runTraceTool(tr, 'ability_audit', { hero: 'abaddon', ability: 'borrowed_time' });
    expect(audit.casts_total).toBe(3);
    expect(audit.casts[0]).toMatchObject({ me: null, allies_within_1300: null, enemies_within_1300: null });
    expect(audit.casts[1]).toMatchObject({ allies_within_1300: ['sven'], enemies_within_1300: null });
    expect(audit.casts[1].me).not.toBeNull();
    expect(audit.casts[2]).toMatchObject({ allies_within_1300: ['sven'], enemies_within_1300: [] });
    expect(audit.gaps.some((g: any) => g.topic === 'hero_positions' && g.reason === 'position_samples_missing_around_auto_trigger')).toBe(true);
  });

  it('does not misread basic-attack damage (-1) as ability damage when abaddon_borrowed_time is absent from trace.names', () => {
    const tr = makeAbaddonTrace({
      abilities: [
        {
          abaddon_borrowed_time: {
            levels: [[500, 1]],
            cd: [[600.2, 685.2, 85]],
          },
        },
        {},
        {},
      ],
      damage: [[605, 0, 2, -1, 150]],
    });
    // Remove abaddon_borrowed_time from trace.names so nameId returns -1 (as in 0-manual-cast replays).
    tr.names = tr.names.filter((n: string) => n !== 'abaddon_borrowed_time');
    const audit: any = runTraceTool(tr, 'ability_audit', { hero: 'abaddon', ability: 'borrowed_time' });
    expect(audit.casts_total).toBe(1);
    expect(audit.auto_triggered_total).toBe(1);
    expect(audit.casts_not_known).toBeUndefined();
    expect(audit.casts_where.no_hero_target_near_enemies_at_most_one_damaged_and_none_died).toBeUndefined();
  });

  it('scoreboard-only coach chapters never audit Borrowed Time as an unused fight ultimate', () => {
    expect(coachUltimateOf(102)).toBeNull();
  });
});
