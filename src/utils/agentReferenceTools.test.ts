import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { REFERENCE_TOOLS, heroInfo, heroMatchup, itemInfo, patchChanges } from '../../lib/agent/referenceTools.js';
import { KNOWLEDGE_TOOLS } from '../../lib/agent/knowledgeTools.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { verifyReview, verifyText } from '../../lib/agent/deepReview.js';

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

  it('hero_info: exposes official Aghanim\'s Scepter and Shard effects (granted abilities + upgrades) and keeps missing data null with gaps', () => {
    const enchZh: any = heroInfo(trace, { hero: 'enchantress' }, zh);
    expect(enchZh.gaps).toEqual([]);
    expect(enchZh.aghanims_scepter).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'granted_ability', granted_by: 'scepter', ability: 'enchantress_little_friends', name: '密友', description: expect.stringContaining('缠绕') }),
      expect.objectContaining({ kind: 'upgrade', ability: 'enchantress_enchant', name: '魅惑' }),
    ]));
    expect(enchZh.aghanims_shard).toEqual([
      expect.objectContaining({ kind: 'granted_ability', granted_by: 'shard', ability: 'enchantress_bunny_hop', name: '跃动' }),
    ]);

    const svenEn: any = heroInfo(trace, { hero: 'sven' }, { lang: 'en' });
    expect(svenEn.aghanims_scepter).toEqual([expect.objectContaining({ kind: 'upgrade', ability: 'sven_storm_bolt', name: 'Storm Hammer', description: expect.stringContaining('780') })]);
    expect(svenEn.aghanims_shard).toEqual([expect.objectContaining({ kind: 'upgrade', ability: 'sven_warcry', name: 'Warcry', description: expect.stringContaining('350') })]);

    // Blanked source data: never [] or fabricated text — null + gaps.
    const blanked: any = heroInfo(trace, { hero: 'enchantress' }, { ...zh, abilitiesData: { heroes: {}, innate_upgrades: {} } });
    expect(blanked.aghanims_scepter).toBeNull();
    expect(blanked.aghanims_shard).toBeNull();
    expect(blanked.gaps).toEqual([
      { topic: 'aghanims_scepter', reason: 'not_in_valve_ability_data' },
      { topic: 'aghanims_shard', reason: 'not_in_valve_ability_data' },
    ]);
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

  it('an evidence item citing one of these records is checked against the whole record (Codex on #409)', () => {
    const item = itemInfo(trace, { item: 'glimmer_cape' }, zh);
    const matchup: any = heroMatchup(trace, { hero: 'beastmaster', against: 'phantom_assassin' }, zh);
    const notes: any = patchChanges(trace, { hero: 'beastmaster' }, zh);
    const games = matchup.by_bracket[0].win.games;
    const review = { verdict: 'v', mainline: [], blind_spots: [], findings: [{ title: 't', claim: '微光披风。', fix: 'x', evidence: [
      { refs: ['item_info:glimmer_cape'], fact: '微光披风能挡 375 点魔法伤害，2150 金。' },
      { refs: ['matchup:beastmaster:phantom_assassin'], fact: `先锋–卫士段位 ${games} 局里，兽王对幻影刺客的胜率是 ${matchup.by_bracket[0].win.win_rate}%。` },
      { refs: ['patch_notes:beastmaster'], fact: '本版本改了召唤远古雷肤兽。' },
    ] }] };
    const check = verifyReview(review, [item, matchup, notes]);
    expect(check.problems.filter((p: any) => p.where === 'evidence' || p.where === 'finding')).toEqual([]);
    expect(check.unsupported.findings.size).toBe(0);
    // A number the record does not hold still fails.
    const wrong = { ...review, findings: [{ ...review.findings[0], evidence: [{ refs: ['item_info:glimmer_cape'], fact: '微光披风能挡 999 点魔法伤害。' }] }] };
    expect(verifyReview(wrong, [item]).problems.some((p: any) => p.kind === 'number' || p.kind === 'moment')).toBe(true);
  });

  it('a game whose patch is not established: hero_info and patch_changes say so, never the current patch as the game\'s (Codex on #409)', () => {
    const old = { ...trace, match_id: 8000000000 };
    const h: any = heroInfo(old, { hero: 'sven' }, zh);
    expect(h.gaps).toEqual([{ topic: 'patch', reason: expect.stringContaining('not established (older_than_7.40)') }]);
    const n: any = patchChanges(old, { hero: 'beastmaster' }, zh);
    expect(n.game_patch).toBeNull();
    expect(n.gaps).toEqual([{ topic: 'patch', reason: expect.stringContaining('not established (older_than_7.40)') }]);
    const i: any = itemInfo(old, { item: 'glimmer_cape' }, zh);
    expect(i).toMatchObject({ patch_exact: false, gaps: [{ topic: 'patch', reason: 'older_than_7.40' }] });
  });

  it('patch_changes: a name nobody knows is an error, never "no changes"; a known item with none is an empty list (Codex on #409)', () => {
    expect(patchChanges(trace, { item: 'Blink Dager' }, zh)).toMatchObject({ error: 'unknown_item' });
    expect(patchChanges(trace, { item: 'blink' }, zh)).toMatchObject({ ref: 'patch_notes:blink', changes: expect.any(Array), gaps: [] });
  });

  it('patch_changes: a game on a later letter release than the notes is told the notes may miss its changes (Codex on #409)', () => {
    const match = { start_time: Date.UTC(2026, 10, 25, 12) / 1000 };
    const r: any = patchChanges(trace, { item: 'Greater Horn of Battle' }, { ...zh, match });
    expect(r.game_patch).toBe('7.42a');
    expect(r.gaps).toEqual([{ topic: 'patch', reason: expect.stringContaining('these are the notes of 7.42; the game was on 7.42a') }]);
  });

  it('item_info carries Valve\'s hint where the numbers alone mislead (Codex on #409)', () => {
    expect(itemInfo(trace, { item: 'witless_shako' }, zh)).toMatchObject({ hint: ["Increases the wearer's max health, while reducing their max mana."] });
    expect(itemInfo(trace, { item: 'glimmer_cape' }, zh)).not.toHaveProperty('hint');
  });

  it('the agent has them, after the replay tools', () => {
    expect(KNOWLEDGE_TOOLS.slice(-4).map((t: any) => t.name)).toEqual(REFERENCE_TOOLS.map((t) => t.name));
    expect(REFERENCE_TOOLS.map((t) => t.name)).toEqual(['item_info', 'hero_info', 'hero_matchup', 'patch_changes']);
  });
});
