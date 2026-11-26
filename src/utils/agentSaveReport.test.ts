import { describe, expect, it } from 'vitest';
import { DANGER_BEFORE, DIED_WITHIN, SAVE_TOOL, saveReport } from '../../lib/agent/saveReport.js';
import { KNOWLEDGE_TOOLS } from '../../lib/agent/knowledgeTools.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { deepReviewSystem, verifyText } from '../../lib/agent/deepReview.js';

/** save_report (#358 item 2) on a synthetic game: what the support used on whom, and what followed. */
function game({ casts = [], items = [], damage = [], deaths = [], itemTargets = true }: any) {
  const heroes = [['disruptor', 2], ['sven', 2], ['lina', 2], ['axe', 3], ['pudge', 3]].map(([key, team], i) => ({ key, npc: `npc_dota_hero_${key}`, team, player_index: i }));
  const names = [...heroes.map((h) => h.npc), 'disruptor_glimpse', 'item_glimmer_cape', 'item_force_staff', 'axe_culling_blade'];
  const n = (s: string) => names.indexOf(s.startsWith('npc_') || s.startsWith('item_') || s.includes('_') && !heroes.some((h) => h.key === s) ? s : `npc_dota_hero_${s}`);
  return {
    t0: 0, n: 1200, heroes, names,
    casts: casts.map(([t, who, what, to]: any) => [t, n(who), n(what), n(to), 0]),
    item_uses: items.map(([t, who, what, to]: any) => (itemTargets ? [t, n(who), n(what), 0, to == null ? null : n(to)] : [t, n(who), n(what), 0])),
    damage: damage.map(([s, from, to, v]: any) => [s, n(from), n(to), n('axe_culling_blade'), v]),
    deaths: deaths.map(([t, who]: any) => [t, n(who), n('axe'), 0]),
  };
}

describe('save_report', () => {
  const t = game({
    items: [[100, 'disruptor', 'item_glimmer_cape', 'sven'], [200, 'disruptor', 'item_force_staff', 'lina'], [300, 'disruptor', 'item_glimmer_cape', 'disruptor'], [400, 'sven', 'item_force_staff', 'lina']],
    casts: [[500, 'disruptor', 'disruptor_glimpse', 'axe'], [600, 'disruptor', 'disruptor_glimpse', 'sven']],
    damage: [[99, 'axe', 'sven', 400], [198, 'pudge', 'lina', 200], [600, 'lina', 'sven', 50]],
    deaths: [[203, 'lina'], [700, 'sven']],
  });

  it('lists what the player used on allies, in danger or not, and whether they died within 5 s; self apart; enemies and others\' uses left out', () => {
    expect([DANGER_BEFORE, DIED_WITHIN]).toEqual([3, 5]);
    const r: any = saveReport(t, { hero: 'disruptor' });
    expect(r).toMatchObject({ ref: 'saves:disruptor', given_to_allies: 3, given_to_allies_in_danger: 2, of_those_the_ally_died_within_5s: 1, used_on_self: 1, by_ally: { sven: 2, lina: 1 }, gaps: [] });
    // Uses on allies, each its own record; uses on oneself apart.
    expect(r.given.map((g: any) => [g.ref, g.clock, g.what, g.to, g.in_danger, g.died_within_5s])).toEqual([
      ['saves:disruptor:1', '1:40', 'glimmer_cape', 'sven', true, false],
      ['saves:disruptor:2', '3:20', 'force_staff', 'lina', true, true],
      // An ally's damage to Sven is not danger; he died 100 s later, not within 5 s.
      ['saves:disruptor:3', '10:00', 'disruptor_glimpse', 'sven', false, false],
    ]);
    expect(r.self_uses.map((g: any) => [g.clock, g.what])).toEqual([['5:00', 'glimmer_cape']]);
  });

  it('a hero the combat log never names is nobody: an untargeted cast (target -1) is not given to them (Codex on #399)', () => {
    const t0 = game({ casts: [[100, 'disruptor', 'disruptor_glimpse', 'lina']] });
    // Sven has state samples but no name in the log; Disruptor's cast has no target (-1).
    const svenGone = { ...t0, names: t0.names.map((n: string) => (n === 'npc_dota_hero_sven' ? 'npc_dota_hero_sven_not_logged' : n)), casts: [[100, t0.names.indexOf('npc_dota_hero_disruptor'), t0.names.indexOf('disruptor_glimpse'), -1, 0]], item_uses: [[110, t0.names.indexOf('npc_dota_hero_disruptor'), t0.names.indexOf('item_force_staff'), 0, -1]] };
    const r: any = saveReport(svenGone, { hero: 'disruptor' });
    expect([r.given_to_allies, r.by_ally]).toEqual([0, {}]);
    // The player unnamed: nothing is read, and the gap says why.
    expect(saveReport(svenGone, { hero: 'sven' })).toMatchObject({ gaps: [{ topic: 'items_given', reason: 'hero_not_named_in_the_combat_log' }] });
  });

  it('one use is a record of its own: a sentence citing its clock and damage is backed, and the evidence opens it (Codex on #399)', () => {
    const r: any = saveReport(t, { hero: 'disruptor' });
    const check = verifyText('1:40 给斯温的微光披风，当时他 3 秒内挨了 400 伤害。', [{ tool: 'save_report', ...r }]);
    expect(check.ok).toBe(true);
    const ev: any = resolveRef(t, 'saves:disruptor:1', { hero: 'disruptor', lang: 'zh' });
    expect(ev.record).toMatchObject({ clock: '1:40', what: 'glimmer_cape', to: 'sven', enemy_damage_taken_before: 400 });
    expect(resolveRef(t, 'saves:disruptor:9', { hero: 'disruptor', lang: 'zh' })).toBeNull();
  });

  it('no damage rows, or no death rows: danger and what followed are not known — not "no" (Codex on #399)', () => {
    const { damage, deaths, ...rest } = t as any;
    const r: any = saveReport(rest, { hero: 'disruptor' });
    expect(r).toMatchObject({ given_to_allies: 3, given_to_allies_in_danger: null, of_those_the_ally_died_within_5s: null });
    expect(r.given[0]).toMatchObject({ in_danger: null, enemy_damage_taken_before: null, died_within_5s: null });
    expect(r.gaps).toEqual([{ topic: 'danger', reason: 'no_damage_rows_in_trace' }, { topic: 'died_within_5s', reason: 'no_death_rows_in_trace' }]);
    // Damage known, deaths not: danger is read, what followed is not.
    const d: any = saveReport({ ...rest, damage }, { hero: 'disruptor' });
    expect([d.given_to_allies_in_danger, d.of_those_the_ally_died_within_5s, d.given[0].in_danger, d.given[0].died_within_5s]).toEqual([2, null, true, null]);
  });

  it('uses on oneself do not crowd uses on allies out of the list (Codex on #399)', () => {
    const many = game({ items: [...Array.from({ length: 30 }, (_, k) => [10 + k * 10, 'disruptor', 'item_glimmer_cape', 'disruptor']), [400, 'disruptor', 'item_force_staff', 'sven']], damage: [[399, 'axe', 'sven', 300]] });
    const r: any = saveReport(many, { hero: 'disruptor' });
    expect([r.given_to_allies, r.used_on_self, r.self_uses.length]).toEqual([1, 30, 10]);
    expect(r.given).toEqual([expect.objectContaining({ ref: 'saves:disruptor:1', clock: '6:40', what: 'force_staff', to: 'sven', in_danger: true })]);
  });

  it('a trace without item targets: abilities still read, items not known — said, never "none given"', () => {
    const old = game({ items: [[100, 'disruptor', 'item_glimmer_cape', 'sven']], itemTargets: false, casts: [[600, 'disruptor', 'disruptor_glimpse', 'sven']] });
    const r: any = saveReport(old, { hero: 'disruptor' });
    expect(r.given_to_allies).toBe(1);
    expect(r.gaps).toEqual([{ topic: 'items_given', reason: 'item_targets_not_in_trace' }]);
  });

  it('is offered to the model, resolves as evidence, and the prompt forbids "saved" and "failed to save"', () => {
    expect(KNOWLEDGE_TOOLS.map((x: any) => x.name)).toContain('save_report');
    expect(SAVE_TOOL.description).toContain('does not judge whether it was a save');
    const ev: any = resolveRef(t, 'saves:disruptor', { hero: 'disruptor', lang: 'en' });
    expect(ev.record).toMatchObject({ given_to_allies: 3 });
    expect(deepReviewSystem('en')).toContain('never that a cast saved someone or failed to');
  });
});
