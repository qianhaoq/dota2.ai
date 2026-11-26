import { describe, expect, it } from 'vitest';
import { DANGER_BEFORE, DIED_WITHIN, SAVE_TOOL, saveReport } from '../../lib/agent/saveReport.js';
import { KNOWLEDGE_TOOLS } from '../../lib/agent/knowledgeTools.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { deepReviewSystem } from '../../lib/agent/deepReview.js';

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
    expect(r.given.map((g: any) => [g.clock, g.what, g.to, g.in_danger, g.died_within_5s])).toEqual([
      ['1:40', 'glimmer_cape', 'sven', true, false],
      ['3:20', 'force_staff', 'lina', true, true],
      ['5:00', 'glimmer_cape', 'self', false, false],
      // An ally's damage to Sven is not danger; he died 100 s later, not within 5 s.
      ['10:00', 'disruptor_glimpse', 'sven', false, false],
    ]);
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
