import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { CURRENT_PATCH, PATCH_NAMES, isBigItemIn, patchData } from '../../lib/agent/patchData.js';
import { buildCheck, goldOnTop, powerSpikes } from '../../lib/agent/situationTools.js';
import { heroAbilities, proItemChoices } from '../../lib/agent/knowledgeTools.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { deepReviewSystem } from '../../lib/agent/deepReview.js';
import { ALWAYS_KEY_ITEMS, KEY_ITEM_MIN_COST } from '../../lib/coach/knowledge.js';

const trace = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());
const scoreboard = JSON.parse(readFileSync(new URL('../fixtures/agent/match9100904020.scoreboard.json', import.meta.url), 'utf8'));
const items742 = JSON.parse(readFileSync(new URL('../../lib/data/constants/items.json', import.meta.url), 'utf8'));
const snap741 = JSON.parse(readFileSync(new URL('../../lib/data/constants/patches/7.41.json', import.meta.url), 'utf8'));
/** The fixture game as if it had been played in 7.41 (OpenDota patch 60). */
const as741 = { ...scoreboard, patch: 60 };

describe('the data of the patch a game was played on', () => {
  it('a 7.41 game reads the 7.41 snapshot; a 7.42 game the current tables', () => {
    expect(CURRENT_PATCH).toBe('7.42');
    expect(PATCH_NAMES[60]).toBe('7.41');
    const old = patchData(60);
    expect(old).toMatchObject({ name: '7.41', id: 60, exact: true, reason: null });
    // Heaven's Halberd before 7.42 rebuilt it: 3300 gold, evasion, Talisman in the recipe (Valve's data at the time).
    expect(old.items.heavens_halberd).toMatchObject({ cost: 3300, components: ['talisman_of_evasion', 'splintmail', 'ring_of_health'] });
    expect(old.items.heavens_halberd.attrib).toContainEqual({ key: 'bonus_evasion', value: '25' });
    expect(old.has('skypiercer')).toBe(false);
    expect(old.has('helm_of_the_overlord')).toBe(true);
    const now = patchData(61);
    expect(now).toMatchObject({ name: '7.42', exact: true });
    expect(now.items.heavens_halberd.cost).toBe(items742.heavens_halberd.cost);
    expect(now.has('skypiercer')).toBe(true);
    expect(snap741).toMatchObject({ patch: '7.41', patch_id: 60, next_patch: '7.42', commits: { items: { sha: expect.any(String) } } });
  });

  it('a patch that is not known, not kept or newer than the site falls back to the current tables and says why', () => {
    expect(patchData(null)).toMatchObject({ name: CURRENT_PATCH, exact: false, reason: 'patch_of_this_game_unknown' });
    expect(patchData(undefined)).toMatchObject({ exact: false });
    expect(patchData(40)).toMatchObject({ name: CURRENT_PATCH, exact: false, reason: 'no_data_kept_for_this_patch' });
    expect(patchData(99)).toMatchObject({ name: CURRENT_PATCH, exact: false, reason: 'patch_newer_than_the_site_data' });
  });

  it('abilities: the same kinds of ability as the current table, with the old patch\'s flags and cooldowns', () => {
    const old = patchData(60); const now = patchData(61);
    // Death Prophet's Spirit Siphon: 7.42 made it pierce debuff immunity ("Both effects pierce Debuff Immunity").
    const siphon = (pd: any) => pd.heroAbilities(43).find((a: any) => a.id === 'death_prophet_spirit_siphon');
    expect(siphon(old).pierces).toBe(false);
    expect(siphon(now).pierces).toBe(true);
    expect(old.ultimate(38)).toEqual({ key: 'beastmaster_primal_roar', en: 'Primal Roar', zh: '原始咆哮', cd: [90, 75, 60] });
    // A shard or scepter ability the current table leaves out is left out of the old list too.
    expect(old.heroAbilities(29)!.map((a: any) => a.id)).toEqual(now.heroAbilities(29)!.map((a: any) => a.id));
    expect(old.heroAbilities(99999)).toBeNull();
  });

  it('a big item is judged on the patch\'s own price and recipe', () => {
    const rule = { minCost: KEY_ITEM_MIN_COST, always: ALWAYS_KEY_ITEMS };
    expect(isBigItemIn(patchData(60), 'heavens_halberd', rule)).toBe(true);
    expect(isBigItemIn(patchData(60), 'skypiercer', rule)).toBe(false);
    expect(isBigItemIn(patchData(61), 'skypiercer', rule)).toBe(true);
    expect(isBigItemIn(patchData(61), 'recipe_skypiercer', rule)).toBe(false);
    expect(isBigItemIn(patchData(61), 'blink', rule)).toBe(true);
    // Gold on top of a held part uses the patch's prices: Talisman of Evasion went into a 7.41 Halberd, not a 7.42 one.
    expect(goldOnTop(['talisman_of_evasion', 'heavens_halberd'], patchData(60).items)).toEqual([null, 3300 - patchData(60).items.talisman_of_evasion.cost]);
    expect(goldOnTop(['talisman_of_evasion', 'heavens_halberd'], patchData(61).items)).toEqual([null, null]);
  });
});

describe('the review tools tell a 7.41 game its own numbers', () => {
  it('build_check: prices and what an item does are 7.41\'s, and an item 7.41 did not have is not offered', () => {
    const r: any = buildCheck(trace, { hero: 'beastmaster' }, { lang: 'zh', match: as741 });
    expect(r.data_patch).toBe('7.41');
    const halberd = r.items_that_answer_attack_damage.find((x: any) => x.item === 'heavens_halberd');
    expect(halberd).toMatchObject({ cost: 3300, gives: { armor: 9, evasion_percent: 25 } });
    expect(r.items_that_answer_attack_damage.some((x: any) => x.item === 'skypiercer')).toBe(false);
    expect([...r.items_that_answer_attack_damage, ...r.items_that_answer_spell_damage].some((x: any) => x.item === 'caduceus')).toBe(false);
    for (const i of r.most_built_by_pros_on_this_hero.items) expect(patchData(60).has(i.item)).toBe(true);
    // The pro sample's gap is said, and the patch is the game's: no fallback gap.
    expect(r.gaps.map((g: any) => g.topic)).toContain('pro_items_removed_since_this_game_patch');
    expect(r.gaps.map((g: any) => g.topic)).not.toContain('item_and_ability_data_of_this_game_patch');
    const now: any = buildCheck(trace, { hero: 'beastmaster' }, { lang: 'zh', match: scoreboard });
    expect(now.data_patch).toBe('7.42');
    expect(now.items_that_answer_attack_damage.find((x: any) => x.item === 'heavens_halberd')).toMatchObject({ cost: items742.heavens_halberd.cost });
    expect(now.gaps.map((g: any) => g.topic)).not.toContain('pro_items_removed_since_this_game_patch');
    const unknown: any = buildCheck(trace, { hero: 'beastmaster' }, { lang: 'zh' });
    expect(unknown.gaps).toContainEqual({ topic: 'item_and_ability_data_of_this_game_patch', reason: 'patch_of_this_game_unknown; 7.42 data used' });
  });

  it('power_spikes, hero_abilities and pro_item_choices answer for the game\'s patch, and the evidence card reads the same', () => {
    expect(powerSpikes(trace, { hero: 'beastmaster' }, { lang: 'zh', match: as741 })).toMatchObject({ data_patch: '7.41', me: { ultimate: { cooldown_by_level: [90, 75, 60] } } });
    expect(heroAbilities(trace, { hero: 'beastmaster' }, { lang: 'zh', match: as741 })).toMatchObject({ patch: '7.41', source: expect.stringContaining('end of that patch') });
    expect(heroAbilities(trace, { hero: 'beastmaster' }, { lang: 'zh', match: scoreboard })).toMatchObject({ patch: '7.42' });
    expect((heroAbilities(trace, { hero: 'beastmaster' }, { lang: 'zh' }) as any).gaps[0].topic).toBe('ability_data_of_this_game_patch');
    const pro: any = proItemChoices(trace, { hero: 'beastmaster' }, { lang: 'zh', match: as741 });
    expect(pro.data_patch).toBe('7.41');
    for (const i of [...pro.mid_game_items.items, ...pro.built_more_against_these_enemies]) expect(patchData(60).has(i.item)).toBe(true);
    const card: any = resolveRef(trace, 'build:beastmaster', { hero: 'beastmaster', lang: 'zh', match: as741 });
    expect(card.record.data_patch).toBe('7.41');
    expect(card.record.items_that_answer_attack_damage.find((x: any) => x.item === 'heavens_halberd').cost).toBe(3300);
    expect(deepReviewSystem('zh')).toContain('data_patch');
  });
});
