import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { REFERENCE_TOOLS, heroInfo, heroMatchup, itemInfo, patchChanges } from '../../lib/agent/referenceTools.js';
import { KNOWLEDGE_TOOLS } from '../../lib/agent/knowledgeTools.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { verifyText } from '../../lib/agent/deepReview.js';

const trace = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());
const zh = { lang: 'zh', perspective: 'beastmaster' };

describe('reference tools: knowledge to look up instead of recall (#405)', () => {
  it('item_info: the item on the game\'s patch, by key, English or Chinese name', () => {
    const r: any = itemInfo(trace, { item: 'glimmer_cape' }, zh);
    expect(r).toMatchObject({ ref: 'item_info:glimmer_cape', name: '微光披风', patch: '7.42', patch_exact: true, cost: 2150, components: ['暗影护符', '披巾'], gaps: [] });
    expect(r.abilities[0]).toMatchObject({ type: 'active', title: 'Glimmer' });
    expect(r.abilities[0].text).toContain('375');
    expect((itemInfo(trace, { item: 'Glimmer Cape' }, zh) as any).ref).toBe('item_info:glimmer_cape');
    expect((itemInfo(trace, { item: '微光披风' }, zh) as any).ref).toBe('item_info:glimmer_cape');
    expect(itemInfo(trace, { item: 'item_black_king_bar' }, zh)).toMatchObject({ cost: 4050 });
    expect(itemInfo(trace, { item: 'no such item' }, zh)).toMatchObject({ error: 'unknown_item' });
  });

  it('item_info: a game whose release is not known exactly says so', () => {
    const r: any = itemInfo({ ...trace, match_id: undefined }, { item: 'glimmer_cape' }, zh);
    expect(r).toMatchObject({ patch_exact: false, gaps: [{ topic: 'patch', reason: 'patch_of_this_game_unknown' }] });
  });

  it('hero_info: base numbers with the table\'s patch; a missing number is null, not 0', () => {
    const r: any = heroInfo(trace, { hero: 'sven' }, zh);
    expect(r).toMatchObject({ ref: 'hero_info:sven', name: '斯温', primary_attribute: 'strength', attack_type: 'melee', data_patch: '7.42', gaps: [] });
    expect(r.base).toMatchObject({ attack_range: 150, base_attack_time: 1.9, base_attack_speed: 110, move_speed: 325 });
    expect((heroInfo(trace, { hero: 'Sven' }, zh) as any).ref).toBe('hero_info:sven');
    expect(heroInfo(trace, { hero: 'nobody' }, zh)).toMatchObject({ error: 'unknown_hero' });
  });

  it('hero_matchup: every bracket when the player\'s is not known, with games and the hero\'s own rate beside it', () => {
    const r: any = heroMatchup(trace, { hero: 'beastmaster', against: 'phantom_assassin' }, zh);
    expect(r).toMatchObject({ ref: 'matchup:beastmaster:phantom_assassin', bracket_basis: 'not known: every bracket' });
    expect(r.by_bracket).toHaveLength(4);
    expect(r.by_bracket[0].bracket).toBe('先锋–卫士');
    expect(r.by_bracket[0].win).toMatchObject({ games: expect.any(Number), win_rate: expect.any(Number), own_win_rate: expect.any(Number) });
    expect(r.source).toContain('STRATZ');
  });

  it('hero_matchup: the player\'s bracket from the match data; too few games is a gap, never "even"', () => {
    const match = { players: [{ hero_id: 38, rank_tier: 54 }] };
    const r: any = heroMatchup(trace, { hero: 'beastmaster', against: 'phantom_assassin' }, { ...zh, match });
    expect(r.bracket_basis).toBe('the player\'s medal');
    expect(r.by_bracket).toHaveLength(1);
    // A pairing with no games in the table.
    const none: any = heroMatchup(trace, { hero: 'beastmaster', against: 'beastmaster' }, zh);
    expect(none.by_bracket.every((b: any) => b.win === null && b.lane_when_they_met === null)).toBe(true);
    expect(none.gaps).toEqual([{ topic: 'matchup', reason: 'too_few_games' }]);
  });

  it('patch_changes: a hero\'s lines with the ability named; an item\'s; a hero with none is an empty list from the notes, not unknown', () => {
    const r: any = patchChanges(trace, { hero: 'beastmaster' }, zh);
    expect(r).toMatchObject({ ref: 'patch_notes:beastmaster', notes_of: '7.42', game_patch: '7.42', gaps: [] });
    expect(r.changes.some((c: any) => c.ability === '召唤远古雷肤兽')).toBe(true);
    expect(patchChanges(trace, { item: 'Greater Horn of Battle' }, zh)).toMatchObject({ ref: 'patch_notes:horn_of_battle_greater' });
    expect(patchChanges(trace, {}, zh)).toMatchObject({ error: 'give_hero_or_item' });
  });

  it('every record opens as evidence, and a sentence quoting one is backed', () => {
    for (const ref of ['item_info:glimmer_cape', 'hero_info:sven', 'matchup:beastmaster:phantom_assassin', 'patch_notes:beastmaster', 'patch_notes:horn_of_battle_greater']) {
      expect(resolveRef(trace, ref, { hero: 'beastmaster', lang: 'zh' })?.record, ref).toBeTruthy();
    }
    const item = itemInfo(trace, { item: 'glimmer_cape' }, zh);
    expect(verifyText('微光披风 2150 金，能挡 375 点魔法伤害。', [item]).ok).toBe(true);
  });

  it('the agent has them, after the replay tools', () => {
    expect(KNOWLEDGE_TOOLS.slice(-4).map((t: any) => t.name)).toEqual(REFERENCE_TOOLS.map((t) => t.name));
    expect(REFERENCE_TOOLS.map((t) => t.name)).toEqual(['item_info', 'hero_info', 'hero_matchup', 'patch_changes']);
  });
});
