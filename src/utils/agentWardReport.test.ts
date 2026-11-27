import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { linkHeroNames } from '../../packages/review-engine/src/trace/index.js';
import { PLACED_WITHIN, WARD_REFERENCE, WARD_TOOL, wardPlacers, wardReport } from '../../lib/agent/wardReport.js';
import { KNOWLEDGE_TOOLS } from '../../lib/agent/knowledgeTools.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { deepReviewSystem } from '../../lib/agent/deepReview.js';

/** ward_report (#358 item 1): who placed each ward, read off the item uses; a synthetic game keeps every case visible. */
function game({ uses = [], wards = [], kills = [] }: any) {
  const heroes = [['disruptor', 2], ['sniper', 2], ['sven', 2], ['axe', 3], ['lina', 3]].map(([key, team], i) => ({ key, npc: `npc_dota_hero_${key}`, team, player_index: i }));
  const names = [...heroes.map((h) => h.npc), 'item_ward_observer', 'item_ward_sentry', 'item_ward_dispenser', 'item_blink'];
  const n = (s: string) => names.indexOf(s);
  return {
    t0: 0, n: 1800, heroes, names,
    item_uses: uses.map(([t, hero, item]: any) => [t, n(`npc_dota_hero_${hero}`), n(item), 0]),
    wards: wards.map(([t, team, kind, x, y]: any) => [t, null, team, kind, x, y]),
    creep_kills: kills.map(([t, hero, kind]: any) => [t, n(`npc_dota_hero_${hero}`), kind, null, null]),
  };
}

describe('who placed a ward', () => {
  it('the hero of the ward\'s side who used a ward item within 0.2 s; two of them at once is not known', () => {
    expect(PLACED_WITHIN).toBe(0.2);
    const t = game({
      uses: [[100, 'disruptor', 'item_ward_observer'], [200.1, 'sniper', 'item_ward_dispenser'], [300, 'disruptor', 'item_ward_sentry'], [300.1, 'sniper', 'item_ward_sentry'], [400, 'axe', 'item_ward_observer'], [500, 'disruptor', 'item_blink']],
      wards: [[100, 2, 'o', 0, 0], [200, 2, 's', 0, 0], [300, 2, 's', 0, 0], [400, 2, 'o', 0, 0], [500, 2, 'o', 0, 0], [null, 2, 'o', 0, 0]],
    });
    // A ward-item use of the other side, a blink, or a ward with no creation time: nobody.
    expect(wardPlacers(t)).toEqual([0, 1, null, null, null, null]);
    expect(wardPlacers({ ...t, item_uses: undefined })).toBeUndefined();
  });
});

describe('ward_report', () => {
  const t = game({
    uses: [[100, 'disruptor', 'item_ward_observer'], [700, 'disruptor', 'item_ward_observer'], [710, 'disruptor', 'item_ward_sentry'], [800, 'sniper', 'item_ward_observer'], [900, 'disruptor', 'item_ward_sentry'], [900.1, 'sven', 'item_ward_sentry']],
    wards: [[100, 2, 'o', -3000, 2000], [700, 2, 'o', 3000, -2000], [710, 2, 's', 0, 0], [800, 2, 'o', 0, 0], [900, 2, 's', 0, 0]],
    kills: [[650, 'disruptor', 'o'], [1200, 'disruptor', 's'], [1300, 'disruptor', 'l']],
  });

  it('counts, ten-minute stretches, placements in order, the team, the other side\'s wards killed, and the reference', () => {
    const r: any = wardReport(t, { hero: 'disruptor' });
    expect(r).toMatchObject({ ref: 'wards:disruptor', ref_scope: 'summary', read: true, observers_placed: 2, sentries_placed: 1, observers_killed: 1, sentries_killed: 1, my_team_wards_placer_not_known: 1, reference: WARD_REFERENCE });
    expect(r.placed_by_ten_minutes.slice(0, 2)).toEqual([{ from: '0:00', to: '10:00', observers: 1, sentries: 0 }, { from: '10:00', to: '20:00', observers: 1, sentries: 1 }]);
    expect(r.placements.map((p: any) => [p.ref, p.clock, p.kind])).toEqual([['wards:disruptor:1', '1:40', 'observer'], ['wards:disruptor:2', '11:40', 'observer'], ['wards:disruptor:3', '11:50', 'sentry']]);
    // One placement opens as its own record (Codex on #399).
    expect((resolveRef(t, 'wards:disruptor:2', { hero: 'disruptor', lang: 'en' }) as any).record).toMatchObject({ clock: '11:40', kind: 'observer' });
    expect(r.my_team_by_observers_placed).toEqual([{ hero: 'disruptor', observers: 2 }, { hero: 'sniper', observers: 1 }, { hero: 'sven', observers: 0 }]);
    expect(r.killed_at).toEqual([{ clock: '10:50', kind: 'observer' }, { clock: '20:00', kind: 'sentry' }]);
    expect(r.gaps).toEqual([{ topic: 'vision', reason: 'ward_placements_only_not_what_each_side_saw' }]);
  });

  it('unknown, not none: no placements or no item uses in the trace; no creep kills leaves the wards killed unknown', () => {
    expect(wardReport({ ...t, wards: undefined }, { hero: 'disruptor' })).toMatchObject({ read: false, gaps: [{ topic: 'wards', reason: 'no_ward_placements_in_trace' }] });
    expect(wardReport({ ...t, item_uses: undefined }, { hero: 'disruptor' })).toMatchObject({ read: false, gaps: [{ topic: 'wards', reason: 'no_item_uses_in_trace' }] });
    const r: any = wardReport({ ...t, creep_kills: undefined }, { hero: 'disruptor' });
    expect([r.observers_killed, r.sentries_killed, 'killed_at' in r]).toEqual([null, null, false]);
    expect(r.gaps).toContainEqual({ topic: 'wards_killed', reason: 'no_creep_kills_in_trace' });
  });

  it('is offered to the model, resolves as evidence, and the prompt keeps it to counts — never sight', () => {
    expect(KNOWLEDGE_TOOLS.map((x: any) => x.name)).toContain('ward_report');
    expect(WARD_TOOL.description).toContain('Never what anyone could see');
    const ev: any = resolveRef(t, 'wards:disruptor', { hero: 'disruptor', lang: 'en' });
    expect(ev.record).toMatchObject({ observers_placed: 2, sentries_placed: 1 });
    expect(ev.record).not.toHaveProperty('placements');
    const s = deepReviewSystem('en');
    expect(s).toContain('ward_report');
    expect(s).toContain('a reference across all ranks is context, not a bracket average or quota');
    expect(s).toContain('show placement, never who saw whom');
    // A paid run wrote "34 个假眼" for 34 sentries, and called the corpus "本段位".
    expect(s).toContain('Use 假眼 for observer, 真眼 for sentry');
  });
});
