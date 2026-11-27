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

    // Innate ability is marked initial: true; real level-1 point (Summon Razorback) is not.
    expect(r.upgrade_timeline.find((u: any) => u.ability === 'beastmaster_inner_beast')).toMatchObject({
      clock: '0:00',
      ability_level: 1,
      initial: true,
    });
    expect(r.upgrade_timeline.find((u: any) => u.ability === 'beastmaster_summon_razorback' && u.ability_level === 1)).not.toHaveProperty('initial');

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

  it('handles multi-ultimate heroes (Dark Willow) and Chinese localization cleanly', () => {
    const dw: any = skillBuild(trace, { hero: 'dark_willow' }, { lang: 'zh' });
    expect(dw.ultimate_levels.map((u: any) => [u.ability, u.level, u.hero_level])).toEqual([
      ['dark_willow_bedlam', 1, 6],
      ['dark_willow_terrorize', 1, 6],
      ['dark_willow_bedlam', 2, 12],
      ['dark_willow_terrorize', 2, 12],
      ['dark_willow_bedlam', 3, 18],
      ['dark_willow_terrorize', 3, 18],
    ]);
    expect(dw.ultimate_levels[0].name).toBe('作祟');

    // Registered in KNOWLEDGE_TOOLS, reviewToolkit, and resolvable via evidence.js with localized names.
    expect(KNOWLEDGE_TOOLS).toContain(SKILL_BUILD_TOOL);
    const kit = reviewToolkit({ trace, hero: 'beastmaster', lang: 'zh' })!;
    expect(kit.tools.map((t: any) => t.name)).toContain('skill_build');
    const ev = resolveRef(trace, 'skill_build:beastmaster', { hero: 'beastmaster', lang: 'zh' })!;
    expect(ev).not.toBeNull();
    expect(ev.kind).toBe('skill_build');
    expect(ev.names.beastmaster_wild_axes).toBe('野性之斧');
    expect(ev.names.beastmaster_primal_roar).toBe('原始咆哮');
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
});
