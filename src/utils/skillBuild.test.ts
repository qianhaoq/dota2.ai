import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { linkHeroNames } from '../../packages/review-engine/src/trace/index.js';
import { SKILL_BUILD_TOOL, skillBuild } from '../../lib/agent/skillBuild.js';
import { KNOWLEDGE_TOOLS } from '../../lib/agent/knowledgeTools.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { reviewToolkit } from '../../lib/agent/review/toolkit.js';

const fixture = (name: string) => JSON.parse(gunzipSync(readFileSync(new URL(`../../packages/review-engine/test/fixtures/${name}`, import.meta.url))).toString());
const trace = linkHeroNames(fixture('trace-9100904020.json.gz'));

describe('skill_build on real replay 9100904020', () => {
  it('extracts chronological upgrades, level-6/10 distributions, maxed order, ultimate levels, and filters map abilities', () => {
    const r: any = skillBuild(trace, { hero: 'beastmaster' }, { lang: 'en' });
    expect(r).toMatchObject({
      ref: 'skill_build:beastmaster',
      hero: 'beastmaster',
      data_patch: '7.42',
      talents: null,
    });
    // Generic map abilities (ability_capture, ability_lamp_use) are excluded.
    const abilities = r.upgrade_timeline.map((u: any) => u.ability);
    expect(abilities).not.toContain('ability_capture');
    expect(abilities).not.toContain('ability_lamp_use');
    expect(abilities).not.toContain('twin_gate_portal_warp');

    // Innate ability is marked initial: true & innate: true; real level-1 point (Summon Razorback) is not.
    expect(r.upgrade_timeline.find((u: any) => u.ability === 'beastmaster_inner_beast')).toMatchObject({
      clock: '0:00',
      ability_level: 1,
      initial: true,
      innate: true,
    });
    expect(r.upgrade_timeline.find((u: any) => u.ability === 'beastmaster_summon_razorback' && u.ability_level === 1)).not.toHaveProperty('initial');
    expect(r.upgrade_timeline.find((u: any) => u.ability === 'beastmaster_summon_razorback' && u.ability_level === 1)).not.toHaveProperty('innate');
    // Scepter-granted ability learned when Beastmaster finishes Aghanim's Scepter at 16:48 carries granted_by: 'scepter'.
    expect(r.upgrade_timeline.find((u: any) => u.ability === 'beastmaster_summon_thunderhide')).toMatchObject({
      clock: '16:48',
      ability_level: 1,
      granted_by: 'scepter',
    });

    // Exact 6-point distribution at level 6 (2-3-0-1) and 10-point distribution at level 10 (4-4-1-1).
    expect(r.at_level_6).toEqual({
      clock: '7:28',
      abilities: {
        beastmaster_wild_axes: 2,
        beastmaster_summon_razorback: 3,
        beastmaster_primal_roar: 1,
      },
    });
    expect(r.at_level_10).toEqual({
      clock: '14:53',
      abilities: {
        beastmaster_wild_axes: 4,
        beastmaster_summon_razorback: 4,
        beastmaster_summon_raptor: 1,
        beastmaster_primal_roar: 1,
      },
    });

    // Chronological maxed order (non-ultimate level 4) and ultimate levels.
    expect(r.maxed_order).toEqual([
      { ability: 'beastmaster_wild_axes', name: 'Wild Axes', level: 4, clock: '12:13', hero_level: 8 },
      { ability: 'beastmaster_summon_razorback', name: 'Summon Razorback', level: 4, clock: '14:56', hero_level: 10 },
      { ability: 'beastmaster_summon_raptor', name: 'Summon Raptors', level: 4, clock: '23:14', hero_level: 14 },
    ]);
    expect(r.ultimate_levels).toEqual([
      { ability: 'beastmaster_primal_roar', name: 'Primal Roar', level: 1, clock: '7:30', hero_level: 6 },
      { ability: 'beastmaster_primal_roar', name: 'Primal Roar', level: 2, clock: '18:42', hero_level: 12 },
      { ability: 'beastmaster_primal_roar', name: 'Primal Roar', level: 3, clock: '30:27', hero_level: 18 },
    ]);
    expect(r.gaps).toContainEqual({ topic: 'talents', reason: 'not_in_trace_or_match_data' });
  });

  it('handles linked dual-ultimate heroes (Dark Willow) without double counting, and localizes Chinese cleanly', async () => {
    const { namesIn } = await import('../../lib/agent/evidence.js');
    const dw: any = skillBuild(trace, { hero: 'dark_willow' }, { lang: 'zh' });
    expect(dw.ultimate_levels.map((u: any) => [u.ability, u.level, u.hero_level])).toEqual([
      ['dark_willow_bedlam', 1, 6],
      ['dark_willow_terrorize', 1, 6],
      ['dark_willow_bedlam', 2, 12],
      ['dark_willow_terrorize', 2, 12],
      ['dark_willow_bedlam', 3, 18],
      ['dark_willow_terrorize', 3, 18],
    ]);
    expect(dw.ultimate_levels[0]).toMatchObject({ name: '作祟', linked_with: ['dark_willow_terrorize'] });
    expect(dw.ultimate_levels[1]).toMatchObject({ name: '恐吓', linked_with: ['dark_willow_bedlam'] });
    expect(dw.linked_ultimates).toEqual([['dark_willow_bedlam', 'dark_willow_terrorize']]);

    // Shared dual ultimate is counted ONCE in at_level_6 (sum = 6, not 7) and at_level_10 (sum = 9, 10th point was talent).
    expect(dw.at_level_6).toEqual({
      clock: '8:36',
      abilities: {
        dark_willow_bramble_maze: 1,
        dark_willow_shadow_realm: 3,
        dark_willow_cursed_crown: 1,
        'dark_willow_bedlam+dark_willow_terrorize': 1,
      },
    });
    expect(Object.values(dw.at_level_6.abilities as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(6);
    expect(dw.at_level_10).toEqual({
      clock: '19:07',
      abilities: {
        dark_willow_bramble_maze: 3,
        dark_willow_shadow_realm: 4,
        dark_willow_cursed_crown: 1,
        'dark_willow_bedlam+dark_willow_terrorize': 1,
      },
    });
    expect(Object.values(dw.at_level_10.abilities as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(9);
    // Single-ultimate hero carries no linked_ultimates or linked_with.
    const bm: any = skillBuild(trace, { hero: 'beastmaster' }, { lang: 'en' });
    expect(bm.linked_ultimates).toBeUndefined();
    expect(bm.ultimate_levels[0]).not.toHaveProperty('linked_with');

    // Linked ultimates upgrading within 1 s group cleanly; separate upgrade timings stay unlinked.
    const level = Array.from({ length: 800 }, (_, s) => (s < 300 ? 5 : 6));
    const nearLinked: any = skillBuild({
      match_id: 9100904020, t0: 0, n: 800,
      heroes: [{ key: 'dark_willow', npc: 'npc_dota_hero_dark_willow', team: 3 }],
      states: [{ level }],
      abilities: [{
        dark_willow_bramble_maze: { levels: [[0, 1]] },
        dark_willow_shadow_realm: { levels: [[60, 1], [120, 2], [240, 3]] },
        dark_willow_cursed_crown: { levels: [[180, 1]] },
        dark_willow_bedlam: { levels: [[300.0, 1]] },
        dark_willow_terrorize: { levels: [[300.8, 1]] },
      }],
    }, { hero: 'dark_willow' });
    expect(nearLinked.at_level_6.abilities['dark_willow_bedlam+dark_willow_terrorize']).toBe(1);
    expect(Object.values(nearLinked.at_level_6.abilities as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(6);

    const separateUlts: any = skillBuild({
      match_id: 9100904020, t0: 0, n: 800,
      heroes: [{ key: 'dark_willow', npc: 'npc_dota_hero_dark_willow', team: 3 }],
      states: [{ level }],
      abilities: [{
        dark_willow_bramble_maze: { levels: [[0, 1]] },
        dark_willow_bedlam: { levels: [[300.0, 1]] },
        dark_willow_terrorize: { levels: [[350.0, 1]] },
      }],
    }, { hero: 'dark_willow' });
    expect(separateUlts.linked_ultimates).toBeUndefined();
    expect(separateUlts.at_level_6.abilities).toEqual({ dark_willow_bramble_maze: 1, dark_willow_bedlam: 1 });

    // Registered in KNOWLEDGE_TOOLS, reviewToolkit, and resolvable via evidence.js with localized names for combined keys.
    expect(KNOWLEDGE_TOOLS).toContain(SKILL_BUILD_TOOL);
    const kit = reviewToolkit({ trace, hero: 'beastmaster', lang: 'zh' })!;
    expect(kit.tools.map((t: any) => t.name)).toContain('skill_build');
    const ev = resolveRef(trace, 'skill_build:beastmaster', { hero: 'beastmaster', lang: 'zh' })!;
    expect(ev).not.toBeNull();
    expect(ev.kind).toBe('skill_build');
    expect(ev.names.beastmaster_wild_axes).toBe('野性之斧');
    expect(ev.names.beastmaster_primal_roar).toBe('原始咆哮');
    const dwEv = resolveRef(trace, 'skill_build:dark_willow', { hero: 'dark_willow', lang: 'zh' })!;
    expect(dwEv.names.dark_willow_bedlam).toBe('作祟');
    expect(dwEv.names.dark_willow_terrorize).toBe('恐吓');
    expect(namesIn({ abilities: { 'dark_willow_bedlam+dark_willow_terrorize': 1 } }, 'en')).toEqual({
      dark_willow_bedlam: 'Bedlam',
      dark_willow_terrorize: 'Terrorize',
    });
  });

  it('parses string special_bonus_* talents when present, and stays null for numeric OpenDota IDs (never guesses)', () => {
    const withStrings: any = skillBuild(trace, { hero: 'beastmaster' }, {
      match: { players: [{ hero_id: 38, ability_upgrades_arr: ['special_bonus_unique_beastmaster_2'] }] },
    });
    expect(withStrings.talents).toEqual([{ ability: 'special_bonus_unique_beastmaster_2', name: expect.any(String) }]);
    expect(withStrings.gaps.some((g: any) => g.topic === 'talents')).toBe(false);

    const withNumeric: any = skillBuild(trace, { hero: 'beastmaster' }, {
      match: { players: [{ hero_id: 38, ability_upgrades_arr: [5168, 5169, 6088] }] },
    });
    expect(withNumeric.talents).toBeNull();
    expect(withNumeric.gaps).toContainEqual({ topic: 'talents', reason: 'not_in_trace_or_match_data' });
  });
});

describe('skill_build unknown-is-not-false blank-source checks', () => {
  it('returns null fields with stated gap when trace.abilities for the hero is missing or empty', () => {
    const bmIdx = trace.heroes.findIndex((h: any) => h.key === 'beastmaster');
    const blankAb = { ...trace, abilities: trace.abilities.map((a: any, i: number) => (i === bmIdx ? {} : a)) };
    const r: any = skillBuild(blankAb, { hero: 'beastmaster' });
    expect(r).toMatchObject({
      ref: 'skill_build:beastmaster',
      hero: 'beastmaster',
      upgrade_timeline: null,
      at_level_6: null,
      at_level_10: null,
      maxed_order: null,
      ultimate_levels: null,
      talents: null,
    });
    expect(r.gaps).toContainEqual({ topic: 'skill_build', reason: 'no_ability_levels_in_trace' });
    expect(r.gaps).toContainEqual({ topic: 'talents', reason: 'not_in_trace_or_match_data' });

    expect(skillBuild(trace, { hero: 'unknown_fake_hero' })).toMatchObject({ error: 'unknown_hero' });
  });

  it('returns null hero_level and at_level_6 / at_level_10 when level samples are missing or blanked before crossing', () => {
    const bmIdx = trace.heroes.findIndex((h: any) => h.key === 'beastmaster');
    // 1. All level samples blanked.
    const noLevels = {
      ...trace,
      states: trace.states.map((st: any, i: number) => (i === bmIdx ? { ...st, level: st.level.map(() => null) } : st)),
    };
    const r1: any = skillBuild(noLevels, { hero: 'beastmaster' });
    expect(r1.upgrade_timeline.length).toBeGreaterThan(0);
    expect(r1.upgrade_timeline.every((u: any) => u.hero_level === null)).toBe(true);
    expect(r1.at_level_6).toBeNull();
    expect(r1.at_level_10).toBeNull();
    expect(r1.gaps).toContainEqual({ topic: 'hero_levels', reason: 'level_samples_missing_in_trace' });

    // 2. Level samples blanked in [440..460] right across crossing level 6 -> at_level_6 must be null (timing unknown), while at_level_10 still resolves.
    const gapLv6 = {
      ...trace,
      states: trace.states.map((st: any, i: number) => (i === bmIdx
        ? { ...st, level: st.level.map((v: any, k: number) => (k >= 440 && k <= 460 ? null : v)) }
        : st)),
    };
    const r2: any = skillBuild(gapLv6, { hero: 'beastmaster' });
    expect(r2.at_level_6).toBeNull();
    expect(r2.at_level_10).not.toBeNull();

    // 3. Hero never reaches level 10 (capped at 7) -> at_level_6 populated, at_level_10 null.
    const cap7 = {
      ...trace,
      states: trace.states.map((st: any, i: number) => (i === bmIdx
        ? { ...st, level: st.level.map((v: any) => (v != null && v > 7 ? 7 : v)) }
        : st)),
    };
    const r3: any = skillBuild(cap7, { hero: 'beastmaster' });
    expect(r3.at_level_6).not.toBeNull();
    expect(r3.at_level_10).toBeNull();
  });

  it('keeps an unupgraded level-1 starting skill (e.g. Lion Earth Spike) in at_level_6 and at_level_10, while excluding metadata-established innates', () => {
    const n = 1200;
    const level = Array.from({ length: n }, (_, s) => (s < 300 ? 1 : s < 400 ? 6 : s < 800 ? 9 : 10));
    const lionTrace: any = {
      match_id: 9100904020, // exact 7.42 patch metadata
      t0: 0,
      n,
      heroes: [{ key: 'lion', npc: 'npc_dota_hero_lion', team: 2 }],
      states: [{ level }],
      abilities: [{
        // Normal starting skill left at level 1 for the entire game: MUST stay in at_level_6 and at_level_10.
        lion_impale: { levels: [[0, 1]] },
        // Innate ability excluded from Valve's learnable list: excluded from point distributions and marked innate: true.
        lion_to_hell_and_back: { levels: [[0, 1]] },
        lion_voodoo: { levels: [[100, 1], [200, 2], [450, 3], [650, 4]] },
        lion_mana_drain: { levels: [[150, 1], [250, 2], [550, 3], [750, 4]] },
        lion_finger_of_death: { levels: [[301, 1]] },
      }],
    };
    const r: any = skillBuild(lionTrace, { hero: 'lion' });
    const impaleEntry = r.upgrade_timeline.find((u: any) => u.ability === 'lion_impale');
    expect(impaleEntry).toBeDefined();
    expect(impaleEntry).not.toHaveProperty('initial');
    expect(impaleEntry).not.toHaveProperty('innate');
    expect(r.upgrade_timeline.find((u: any) => u.ability === 'lion_to_hell_and_back')).toMatchObject({
      ability_level: 1,
      initial: true,
      innate: true,
    });
    expect(r.at_level_6.abilities).toEqual({
      lion_impale: 1,
      lion_voodoo: 2,
      lion_mana_drain: 2,
      lion_finger_of_death: 1,
    });
    expect(r.at_level_10.abilities).toEqual({
      lion_impale: 1,
      lion_voodoo: 4,
      lion_mana_drain: 4,
      lion_finger_of_death: 1,
    });
    expect(r.gaps.some((g: any) => g.topic === 'innate_abilities')).toBe(false);

    // When patch metadata is not exact (unknown patch), never silently drop an unclassified ability — keep it and record a gap.
    const unknownPatch: any = { ...lionTrace, match_id: 1 };
    const rUncertain: any = skillBuild(unknownPatch, { hero: 'lion' });
    expect(rUncertain.at_level_6.abilities).toMatchObject({ lion_impale: 1, lion_to_hell_and_back: 1 });
    expect(rUncertain.at_level_10.abilities).toMatchObject({ lion_impale: 1, lion_to_hell_and_back: 1 });
    expect(rUncertain.gaps).toContainEqual({ topic: 'innate_abilities', reason: 'innate_metadata_unavailable_for_patch' });
  });

  it('uses actual ability level caps for maxed_order (Invoker orbs cap at 7, never falsely maxed at 4)', () => {
    const n = 1500;
    const level = Array.from({ length: n }, (_, s) => Math.min(20, 1 + Math.floor(s / 60)));
    const invokerTrace: any = {
      match_id: 9100904020,
      t0: 0,
      n,
      heroes: [{ key: 'invoker', npc: 'npc_dota_hero_invoker', team: 2 }],
      states: [{ level }],
      abilities: [{
        // Quas hits level 4 FIRST (at 300s), but Wex hits its actual cap of 7 FIRST (at 840s) before Quas hits 7 (at 1020s).
        // Exort stops at level 4 and is never maxed. Invoked spells (Cold Snap, Tornado, EMP) are generated by Invoke,
        // NOT skill-point abilities, and must NOT appear in upgrade_timeline, at_level_6, at_level_10, or maxed_order.
        invoker_quas: { levels: [[0, 1], [100, 2], [200, 3], [300, 4], [700, 5], [900, 6], [1020, 7]] },
        invoker_wex: { levels: [[60, 1], [180, 2], [360, 3], [480, 4], [600, 5], [720, 6], [840, 7]] },
        invoker_exort: { levels: [[120, 1], [420, 2], [540, 3], [660, 4]] },
        invoker_cold_snap: { levels: [[130, 1]] },
        invoker_tornado: { levels: [[220, 1]] },
        invoker_emp: { levels: [[260, 1]] },
      }],
    };
    const r: any = skillBuild(invokerTrace, { hero: 'invoker' });
    expect(r.maxed_order).toEqual([
      { ability: 'invoker_wex', name: 'Wex', level: 7, clock: '14:00', hero_level: 15 },
      { ability: 'invoker_quas', name: 'Quas', level: 7, clock: '17:00', hero_level: 18 },
    ]);
    const timelineKeys = r.upgrade_timeline.map((u: any) => u.ability);
    expect(timelineKeys).not.toContain('invoker_cold_snap');
    expect(timelineKeys).not.toContain('invoker_tornado');
    expect(timelineKeys).not.toContain('invoker_emp');
    expect(r.at_level_6.abilities).toEqual({ invoker_quas: 4, invoker_wex: 2, invoker_exort: 1 });
    expect(r.at_level_10.abilities).toEqual({ invoker_quas: 4, invoker_wex: 4, invoker_exort: 3 });

    // A non-Invoker ability whose trace upgrades past 4 without an explicit max_level in metadata must NOT be falsely recorded as maxed at 4.
    const over4Trace: any = {
      match_id: 9100904020,
      t0: 0,
      n,
      heroes: [{ key: 'lion', npc: 'npc_dota_hero_lion', team: 2 }],
      states: [{ level }],
      abilities: [{
        lion_impale: { levels: [[0, 1], [100, 2], [200, 3], [300, 4], [400, 5]] },
      }],
    };
    const rOver: any = skillBuild(over4Trace, { hero: 'lion' });
    expect(rOver.maxed_order).toEqual([]);
    expect(rOver.gaps).toContainEqual({ topic: 'maxed_order', reason: 'ability_max_level_unknown' });
  });

  it('preserves uncertainty when an individual hero ability is missing level samples (blanking Primal Roar levels on 9100904020)', () => {
    const bmIdx = trace.heroes.findIndex((h: any) => h.key === 'beastmaster');
    const missingUltLevels = {
      ...trace,
      abilities: trace.abilities.map((ab: any, i: number) => (i === bmIdx
        ? { ...ab, beastmaster_primal_roar: { ...ab.beastmaster_primal_roar, levels: undefined } }
        : ab)),
    };
    const r: any = skillBuild(missingUltLevels, { hero: 'beastmaster' });
    expect(r.at_level_6).toBeNull();
    expect(r.at_level_10).toBeNull();
    expect(r.maxed_order).toBeNull();
    expect(r.ultimate_levels).toBeNull();
    expect(r.gaps).toContainEqual({
      topic: 'skill_build',
      reason: 'incomplete_ability_level_samples',
      abilities: ['beastmaster_primal_roar'],
    });

    // Blanking a non-ultimate ability's levels still nulls distributions/maxed_order, while keeping ultimate_levels intact.
    const missingAxesLevels = {
      ...trace,
      abilities: trace.abilities.map((ab: any, i: number) => (i === bmIdx
        ? { ...ab, beastmaster_wild_axes: { ...ab.beastmaster_wild_axes, levels: null } }
        : ab)),
    };
    const rAxes: any = skillBuild(missingAxesLevels, { hero: 'beastmaster' });
    expect(rAxes.at_level_6).toBeNull();
    expect(rAxes.at_level_10).toBeNull();
    expect(rAxes.maxed_order).toBeNull();
    expect(rAxes.ultimate_levels).toHaveLength(3);
    expect(rAxes.gaps).toContainEqual({
      topic: 'skill_build',
      reason: 'incomplete_ability_level_samples',
      abilities: ['beastmaster_wild_axes'],
    });
  });

  it('tracks Enchantress Scepter (Little Friends) and Shard (Sproink, Hidden behavior) in upgrade_timeline without distorting skill-point distributions', () => {
    const n = 1600;
    const level = Array.from({ length: n }, (_, s) => (s < 300 ? 1 : s < 400 ? 6 : s < 800 ? 9 : s < 1000 ? 10 : 15));
    const enchTrace: any = {
      match_id: 9106070129, // 7.42a exact
      t0: 0,
      n,
      heroes: [{ key: 'enchantress', npc: 'npc_dota_hero_enchantress', team: 2 }],
      states: [{ level }],
      abilities: [{
        enchantress_impetus: { levels: [[0, 1], [120, 2], [240, 3], [480, 4]] },
        enchantress_enchant: { levels: [[60, 1], [600, 2], [720, 3], [900, 4]] },
        enchantress_natures_attendants: { levels: [[180, 1], [540, 2]] },
        enchantress_untouchable: { levels: [[301, 1]] },
        enchantress_rabblerouser: { levels: [[0, 1]] },
        // Shard at 4:10 (250s, before level 6) and Scepter at 22:00 (1320s) — neither consumes skill points.
        enchantress_bunny_hop: { levels: [[250, 1]] },
        enchantress_little_friends: { levels: [[1320, 1]] },
      }],
    };
    const r: any = skillBuild(enchTrace, { hero: 'enchantress' }, { lang: 'zh' });
    expect(r.upgrade_timeline.find((u: any) => u.ability === 'enchantress_little_friends')).toMatchObject({
      clock: '22:00',
      name: '密友',
      ability_level: 1,
      granted_by: 'scepter',
    });
    expect(r.upgrade_timeline.find((u: any) => u.ability === 'enchantress_bunny_hop')).toMatchObject({
      clock: '4:10',
      name: '跃动',
      ability_level: 1,
      granted_by: 'shard',
    });
    expect(r.upgrade_timeline.find((u: any) => u.ability === 'enchantress_rabblerouser')).toMatchObject({
      initial: true,
      innate: true,
    });
    // Neither innate nor Shard/Scepter granted skills appear in at_level_6, at_level_10, or maxed_order.
    expect(r.at_level_6.abilities).toEqual({
      enchantress_impetus: 3,
      enchantress_enchant: 1,
      enchantress_natures_attendants: 1,
      enchantress_untouchable: 1,
    });
    expect(r.maxed_order.map((m: any) => m.ability)).toEqual(['enchantress_impetus', 'enchantress_enchant']);
    expect(r.gaps.some((g: any) => g.topic === 'granted_abilities' || g.topic === 'innate_abilities')).toBe(false);

    // When patch metadata is not exact (e.g. match_id: 0 -> pd.exact === false), never silently treat a Scepter/Shard-granted
    // skill like Sproink as a confirmed learnable basic skill: preserve an explicit uncertainty gap and omit unconfirmed granted_by.
    const inexactNoInnate: any = {
      ...enchTrace,
      match_id: 0,
      abilities: [{
        enchantress_impetus: { levels: [[0, 1], [120, 2], [240, 3], [480, 4]] },
        enchantress_enchant: { levels: [[60, 1], [600, 2], [720, 3], [900, 4]] },
        enchantress_natures_attendants: { levels: [[180, 1], [540, 2]] },
        enchantress_untouchable: { levels: [[301, 1]] },
        enchantress_bunny_hop: { levels: [[250, 1]] },
      }],
    };
    const rInexact: any = skillBuild(inexactNoInnate, { hero: 'enchantress' }, { lang: 'en' });
    expect(rInexact.at_level_6.abilities).toMatchObject({
      enchantress_impetus: 3,
      enchantress_enchant: 1,
      enchantress_natures_attendants: 1,
      enchantress_untouchable: 1,
      enchantress_bunny_hop: 1,
    });
    expect(rInexact.upgrade_timeline.find((u: any) => u.ability === 'enchantress_bunny_hop')).not.toHaveProperty('granted_by');
    expect(rInexact.gaps).toContainEqual({ topic: 'granted_abilities', reason: 'granted_ability_metadata_unavailable_for_patch' });
    expect(rInexact.gaps.some((g: any) => g.topic === 'maxed_order')).toBe(false);

    // On an exact older major patch whose snapshot lacks granted_by (e.g. 7.41f), keep Sproink and Little Friends visible
    // with an explicit granted_abilities uncertainty gap instead of silently dropping Sproink or treating them as confirmed basic skills.
    const olderMajor: any = { ...inexactNoInnate, match_id: 9076000000 };
    const rOlder: any = skillBuild(olderMajor, { hero: 'enchantress' }, { lang: 'en' });
    expect(rOlder.data_patch).toBe('7.41f');
    expect(rOlder.upgrade_timeline.some((u: any) => u.ability === 'enchantress_bunny_hop')).toBe(true);
    expect(rOlder.upgrade_timeline.find((u: any) => u.ability === 'enchantress_bunny_hop')).not.toHaveProperty('granted_by');
    expect(rOlder.gaps).toContainEqual({ topic: 'granted_abilities', reason: 'granted_ability_metadata_unavailable_for_patch' });
  });
});
