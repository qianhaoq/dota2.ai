import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { CURRENT_PATCH, CURRENT_RELEASE, PATCH_NAMES, RELEASES, gamePatch, isBigItemIn, patchData, patchForGame } from '../../lib/agent/patchData.js';
import { buildCheck, goldOnTop, powerSpikes } from '../../lib/agent/situationTools.js';
import { heroAbilities, proItemChoices } from '../../lib/agent/knowledgeTools.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { deepReviewSystem, reviewToolkit, runDeepReview } from '../../lib/agent/deepReview.js';
import { ALWAYS_KEY_ITEMS, KEY_ITEM_MIN_COST } from '../../lib/coach/knowledge.js';

const trace = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());
const scoreboard = JSON.parse(readFileSync(new URL('../fixtures/agent/match9100904020.scoreboard.json', import.meta.url), 'utf8'));
const items742 = JSON.parse(readFileSync(new URL('../../lib/data/constants/items.json', import.meta.url), 'utf8'));
const snap741f = JSON.parse(readFileSync(new URL('../../lib/data/constants/patches/7.41f.json', import.meta.url), 'utf8'));
/** The fixture game with no match id the site can place: its patch is not known. */
const unplaced = { ...trace, match_id: 0 };
const index = JSON.parse(readFileSync(new URL('../../lib/data/constants/patches/index.json', import.meta.url), 'utf8'));
/** The fixture game as if it had been played in 7.41f: OpenDota's patch 60, and a start time in 7.41f (that of match 9091400302). */
const as741 = { ...scoreboard, patch: 60, start_time: 1794747997 };
const release = (name: string) => index.releases.find((r: any) => r.name === name);
const at = (iso: string) => Date.parse(iso) / 1000;

describe('the data of the patch a game was played on', () => {
  it('each release has its own data, letters included; the current release is the live tables', () => {
    expect(CURRENT_PATCH).toBe('7.42');
    expect(CURRENT_RELEASE).toBe('7.42');
    expect(PATCH_NAMES[60]).toBe('7.41');
    expect(RELEASES.map((r) => r.name)).toEqual(['7.40', '7.40b', '7.40c', '7.41', '7.41a', '7.41b', '7.41c', '7.41d', '7.41e', '7.41f', '7.42']);
    // Valve's notes: 7.41c "Recipe cost increased from 600 to 700. Total cost increased from 5100g to 5200g" (Heart of Tarrasque);
    // 7.41d "Recipe cost decreased from 1150 to 1100" (Dagon).
    expect(patchData('7.41b').items.heart.cost).toBe(5100);
    expect(patchData('7.41c').items.heart.cost).toBe(5200);
    expect(patchData('7.41c').items.recipe_dagon.cost).toBe(1150);
    expect(patchData('7.41d').items.recipe_dagon.cost).toBe(1100);
    const f = patchData('7.41f');
    expect(f).toMatchObject({ name: '7.41f', major: '7.41', id: 60, exact: true, reason: null });
    // Heaven's Halberd before 7.42 rebuilt it: 3300 gold, evasion, Talisman in the recipe.
    expect(f.items.heavens_halberd).toMatchObject({ cost: 3300, components: ['talisman_of_evasion', 'splintmail', 'ring_of_health'] });
    expect(f.items.heavens_halberd.attrib).toContainEqual({ key: 'bonus_evasion', value: '25' });
    expect(f.has('skypiercer')).toBe(false);
    expect(f.has('helm_of_the_overlord')).toBe(true);
    const now = patchData('7.42');
    expect(now).toMatchObject({ name: '7.42', major: '7.42', id: 61, exact: true });
    expect(now.items.heavens_halberd.cost).toBe(items742.heavens_halberd.cost);
    expect(now.has('skypiercer')).toBe(true);
    expect(snap741f).toMatchObject({ release: '7.41f', major: '7.41', major_id: 60, game_files: expect.stringContaining('the last game update before 7.42') });
  });

  it('OpenDota\'s patch number names a patch, not its letter: its last release is used, and said to be a guess unless it is the only one', () => {
    expect(patchData(60)).toMatchObject({ name: '7.41f', exact: false, reason: 'letter_release_unknown; 7.41f data used' });
    expect(patchData(61)).toMatchObject({ name: '7.42', exact: true, reason: null });
    expect(patchData(null)).toMatchObject({ name: CURRENT_RELEASE, exact: false, reason: 'patch_of_this_game_unknown' });
    expect(patchData(undefined)).toMatchObject({ exact: false });
    expect(patchData(40)).toMatchObject({ name: CURRENT_RELEASE, exact: false, reason: 'no_data_kept_for_this_patch' });
    expect(patchData(99)).toMatchObject({ name: CURRENT_RELEASE, exact: false, reason: 'patch_newer_than_the_site_data' });
    expect(patchData('7.39e')).toMatchObject({ name: CURRENT_RELEASE, exact: false, reason: 'no_data_kept_for_this_release' });
  });

  it('abilities: the same kinds of ability as the current table, with the old patch\'s flags and cooldowns', () => {
    const old = patchData('7.41f'); const now = patchData('7.42');
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
    expect(isBigItemIn(patchData('7.41f'), 'heavens_halberd', rule)).toBe(true);
    expect(isBigItemIn(patchData('7.41f'), 'skypiercer', rule)).toBe(false);
    expect(isBigItemIn(patchData('7.42'), 'skypiercer', rule)).toBe(true);
    expect(isBigItemIn(patchData('7.42'), 'recipe_skypiercer', rule)).toBe(false);
    expect(isBigItemIn(patchData('7.42'), 'blink', rule)).toBe(true);
    // Gold on top of a held part uses the patch's prices: Talisman of Evasion went into a 7.41 Halberd, not a 7.42 one.
    expect(goldOnTop(['talisman_of_evasion', 'heavens_halberd'], patchData('7.41f').items)).toEqual([null, 3300 - patchData('7.41f').items.talisman_of_evasion.cost]);
    expect(goldOnTop(['talisman_of_evasion', 'heavens_halberd'], patchData('7.42').items)).toEqual([null, null]);
  });
});

describe('the review tools tell a 7.41 game its own numbers', () => {
  it('build_check: prices and what an item does are 7.41f\'s, and an item 7.41 did not have is not offered', () => {
    const r: any = buildCheck(trace, { hero: 'beastmaster' }, { lang: 'zh', match: as741 });
    expect(r.data_patch).toBe('7.41f');
    const halberd = r.items_that_answer_attack_damage.find((x: any) => x.item === 'heavens_halberd');
    expect(halberd).toMatchObject({ cost: 3300, gives: { armor: 9, evasion_percent: 25 } });
    expect(r.items_that_answer_attack_damage.some((x: any) => x.item === 'skypiercer')).toBe(false);
    expect([...r.items_that_answer_attack_damage, ...r.items_that_answer_spell_damage].some((x: any) => x.item === 'caduceus')).toBe(false);
    for (const i of r.most_built_by_pros_on_this_hero.items) expect(patchData('7.41f').has(i.item)).toBe(true);
    // The pro sample's gap is said, and the patch is the game's: no fallback gap.
    expect(r.gaps.map((g: any) => g.topic)).toContain('pro_items_removed_since_this_game_patch');
    expect(r.gaps.map((g: any) => g.topic)).not.toContain('item_and_ability_data_of_this_game_patch');
    const now: any = buildCheck(trace, { hero: 'beastmaster' }, { lang: 'zh', match: scoreboard });
    expect(now.data_patch).toBe('7.42');
    expect(now.items_that_answer_attack_damage.find((x: any) => x.item === 'heavens_halberd')).toMatchObject({ cost: items742.heavens_halberd.cost });
    expect(now.gaps.map((g: any) => g.topic)).not.toContain('pro_items_removed_since_this_game_patch');
    const unknown: any = buildCheck(unplaced, { hero: 'beastmaster' }, { lang: 'zh' });
    expect(unknown.gaps).toContainEqual({ topic: 'item_and_ability_data_of_this_game_patch', reason: 'patch_of_this_game_unknown; 7.42 data used' });
  });

  it('power_spikes, hero_abilities and pro_item_choices answer for the game\'s patch, and the evidence card reads the same', () => {
    expect(powerSpikes(trace, { hero: 'beastmaster' }, { lang: 'zh', match: as741 })).toMatchObject({ data_patch: '7.41f', me: { ultimate: { cooldown_by_level: [90, 75, 60] } } });
    expect(heroAbilities(trace, { hero: 'beastmaster' }, { lang: 'zh', match: as741 })).toMatchObject({ patch: '7.41f', patch_known_from: 'start_time', source: expect.stringContaining('game files of that release') });
    expect(heroAbilities(trace, { hero: 'beastmaster' }, { lang: 'zh', match: scoreboard })).toMatchObject({ patch: '7.42' });
    expect((heroAbilities(unplaced, { hero: 'beastmaster' }, { lang: 'zh' }) as any).gaps[0].topic).toBe('ability_data_of_this_game_patch');
    // Without match data the patch comes from the match id: the fixture (9100904020) was played in 7.42.
    expect(heroAbilities(trace, { hero: 'beastmaster' }, { lang: 'zh' })).toMatchObject({ patch: '7.42', patch_known_from: 'match_id' });
    const pro: any = proItemChoices(trace, { hero: 'beastmaster' }, { lang: 'zh', match: as741 });
    expect(pro.data_patch).toBe('7.41f');
    for (const i of [...pro.mid_game_items.items, ...pro.built_more_against_these_enemies]) expect(patchData('7.41f').has(i.item)).toBe(true);
    const card: any = resolveRef(trace, 'build:beastmaster', { hero: 'beastmaster', lang: 'zh', match: as741 });
    expect(card.record.data_patch).toBe('7.41f');
    expect(card.record.items_that_answer_attack_damage.find((x: any) => x.item === 'heavens_halberd').cost).toBe(3300);
    expect(deepReviewSystem('zh')).toContain('data_patch');
  });
});

describe('which patch a game was played on, when the match data is not at hand', () => {
  it('the start time first, then the match id; a game during a rollout, older than the data, or known only by its patch number is not called exact', () => {
    const c = release('7.41c');
    expect(c).toMatchObject({ major: '7.41', major_id: 60, data: '7.41c.json', rollout_update: expect.stringContaining('Client') });
    // By start time: before the 20 minutes in which 7.41c rolled out, inside them, after them.
    expect(gamePatch(0, { start_time: at(c.rollout_from) - 1 })).toEqual({ release: '7.41b', id: 60, how: 'start_time', exact: true });
    expect(gamePatch(0, { start_time: at(c.rollout_from) + 60 })).toEqual({ release: '7.41c', id: 60, how: 'start_time', exact: false, reason: 'started_while_7.41c_was_rolling_out' });
    expect(gamePatch(0, { start_time: at(c.rollout_by) })).toEqual({ release: '7.41c', id: 60, how: 'start_time', exact: true });
    expect(gamePatch(0, { start_time: at(release('7.40').rollout_from) - 1 })).toMatchObject({ release: null, reason: 'older_than_7.40' });
    // The start time wins over OpenDota's patch number.
    expect(gamePatch(9091400302, { patch: 61, start_time: 1794747997 })).toMatchObject({ release: '7.41f', how: 'start_time' });
    // By match id: each release's ids are in order, and both sides of each boundary fall as they should.
    for (const [k, r] of index.releases.entries()) {
      expect(r.first_match_id_after).toBeGreaterThan(r.last_match_id_before);
      if (k) expect(r.last_match_id_before).toBeGreaterThanOrEqual(index.releases[k - 1].first_match_id_after);
      expect(gamePatch(r.first_match_id_after, null)).toMatchObject({ release: r.name, how: 'match_id', exact: true });
      if (k) expect(gamePatch(r.last_match_id_before, null)).toMatchObject({ release: index.releases[k - 1].name, exact: true });
      if (r.first_match_id_after - r.last_match_id_before > 1) expect(gamePatch(r.last_match_id_before + 1, null)).toMatchObject({ release: r.name, exact: false, reason: `started_while_${r.name}_was_rolling_out` });
    }
    // The games this site has reviewed, against OpenDota's patch numbers for them.
    expect(gamePatch(9091400302, null)).toMatchObject({ release: '7.41f', id: 60, how: 'match_id', exact: true });
    for (const id of [9099561801, 9100904020, 9102822298]) expect(gamePatch(id, null)).toMatchObject({ release: '7.42', id: 61, how: 'match_id', exact: true });
    expect(gamePatch(index.releases[0].last_match_id_before, null)).toMatchObject({ release: null, reason: 'older_than_7.40' });
    // Neither a start time nor an id it can place: only OpenDota's patch number, which names no letter.
    expect(gamePatch(0, { patch: 60 })).toEqual({ release: null, id: 60, how: 'match_data', exact: false, reason: 'letter_release_unknown' });
    expect(gamePatch('not an id', null)).toMatchObject({ release: null, reason: 'patch_of_this_game_unknown' });
    expect(patchForGame(9091400302, null)).toMatchObject({ name: '7.41f', exact: true, how: 'match_id', reason: null });
    expect(patchForGame(0, { patch: 60 })).toMatchObject({ name: '7.41f', exact: false, how: 'match_data', reason: 'letter_release_unknown; 7.41f data used' });
    expect(patchForGame(0, { patch: 61 })).toMatchObject({ name: '7.42', exact: true, how: 'match_data', reason: null });
    expect(patchForGame(index.releases[0].last_match_id_before, null)).toMatchObject({ name: CURRENT_RELEASE, exact: false, how: null, reason: 'older_than_7.40' });
  });

  it('the review says which patch its numbers are from, and how that is known', async () => {
    expect(reviewToolkit({ trace, hero: 'beastmaster', lang: 'zh' })!.patch).toEqual({ name: '7.42', exact: true, known_from: 'match_id' });
    expect(reviewToolkit({ trace, hero: 'beastmaster', lang: 'zh', match: as741 })!.patch).toEqual({ name: '7.41f', exact: true, known_from: 'start_time' });
    expect(reviewToolkit({ trace: unplaced, hero: 'beastmaster', lang: 'zh' })!.patch).toEqual({ name: '7.42', exact: false, reason: 'patch_of_this_game_unknown' });
    const finding = { title: '咆哮', claim: '幻影刺客开了 7 次黑皇杖。', evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 吼进黑皇杖，定住 3.4 秒' }], fix: '留给她。', rule: { when: 'w', do: 'd', this_game: 'x' } };
    const complete = async (o: any) => (o.messages.at(-1).role === 'user'
      ? { toolCalls: [{ id: 'a', name: 'ability_audit', args: { hero: 'beastmaster', ability: 'primal_roar' } }] }
      : { toolCalls: [{ id: 's', name: 'submit_review', args: { verdict: '咆哮没有留给幻影刺客。', mainline: [], findings: [finding], blind_spots: [] } }] });
    const out: any = await runDeepReview({ complete, trace, hero: 'beastmaster', lang: 'zh', match: as741 });
    expect(out.review.data_patch).toEqual({ name: '7.41f', exact: true, known_from: 'start_time' });
  });
});
