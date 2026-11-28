import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { CURRENT_PATCH, CURRENT_RELEASE, PATCH_NAMES, RELEASES, fromSnapshot, gamePatch, isBigItemIn, patchData, patchForGame } from '../../lib/agent/patchData.js';
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

// The newest data the site has: the current release at its latest hotfix. The live tables are refreshed to it
// (scheduled refresh), so this — not a release named here — is what they must agree with.
const newest = () => patchData(CURRENT_RELEASE, { hotfix: (release(CURRENT_RELEASE).hotfixes ?? []).filter((h: any) => h.data).at(-1)?.rollout_by ?? null });

describe('the data of the patch a game was played on', () => {
  it('each release has its own data, letters included; the current release is the live tables', () => {
    expect(CURRENT_PATCH).toBe('7.42');
    expect(CURRENT_RELEASE).toBe('7.42a');
    expect(PATCH_NAMES[60]).toBe('7.41');
    expect(RELEASES.map((r) => r.name)).toEqual(['7.40', '7.40b', '7.40c', '7.41', '7.41a', '7.41b', '7.41c', '7.41d', '7.41e', '7.41f', '7.42', '7.42a']);
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
    expect(snap741f).toMatchObject({ release: '7.41f', major: '7.41', major_id: 60, game_files: expect.stringContaining('the release\'s rollout') });
  });

  it('every release\'s data is its own snapshot, the newest one too: never the live tables a refresh may not have reached', () => {
    expect(index.releases.map((r: any) => r.data)).toEqual(index.releases.map((r: any) => `${r.name}.json`));
    expect(index.releases_checked_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    const now = newest();
    expect(now.items).not.toBe(items742);
    // Built from the newest release's own game files, it agrees with the live tables: same prices and recipes.
    for (const [k, v] of Object.entries(now.items) as [string, any][]) if (items742[k]) expect([k, v.cost, v.components]).toEqual([k, items742[k].cost, items742[k].components ?? null]);
    // Only an unknown release falls back to the live tables, and says so.
    expect(patchData(null)).toMatchObject({ exact: false, reason: 'patch_of_this_game_unknown' });
    expect(patchData(null).items.desolator).toEqual(items742.desolator);
    // The whole of Valve's text is kept, notes included.
    expect(now.items.desolator.notes).toBe(items742.desolator.notes);
  });

  it('a full data refresh will not start without the builder that rebuilds the release list', async () => {
    const { spawnSync } = await import('node:child_process');
    const env = { ...process.env }; delete env.DOTACONSTANTS_DIR;
    const r = spawnSync(process.execPath, ['scripts/refresh-data.mjs', '--all'], { env, encoding: 'utf8', timeout: 20_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Nothing was written');
  });

  it('the newest release\'s snapshot shows each hero\'s abilities as the live table does: the same abilities, ultimates and flags', () => {
    const live = JSON.parse(readFileSync(new URL('../../lib/coach/data/abilities.json', import.meta.url), 'utf8'));
    const snap = newest();
    for (const [id, list] of Object.entries(live.heroes) as [string, any[]][]) {
      const got = snap.heroAbilities(Number(id)) ?? [];
      const pick = (x: any) => ({ id: x.id, ult: Boolean(x.ult), dmg: x.dmg ?? null, pierces: x.pierces ?? null, dispel: x.dispel ?? null });
      expect([id, got.map(pick).sort((a, b) => a.id.localeCompare(b.id))]).toEqual([id, list.map(pick).sort((a, b) => a.id.localeCompare(b.id))]);
    }
    // Each hero's main ultimate, its names and cooldowns, as the live table has them — Invoke too, which is not in Invoker's list.
    // A passive ultimate has no cooldown in the game files and [0] in Valve's table: the same thing.
    const cdOf = (cd: any) => (Array.isArray(cd) && cd.some((x: number) => x > 0) ? cd : null);
    for (const [id, u] of Object.entries(live.ultimates) as [string, any][]) {
      const got = snap.ultimate(Number(id));
      expect([id, got && { ...got, cd: cdOf(got.cd) }]).toEqual([id, { key: u.key, en: u.en, zh: u.zh, cd: cdOf(u.cd) }]);
    }
    expect(snap.ultimate(74)).toMatchObject({ key: 'invoker_invoke' });
    // The cases that showed it: Ringmaster's abilities outside the slots, and two ultimates for Dark Willow.
    expect(snap.heroAbilities(131)!.map((a) => a.id)).toEqual(expect.arrayContaining(['ringmaster_funhouse_mirror', 'ringmaster_summon_unicycle']));
    expect(snap.heroAbilities(119)!.filter((a) => a.ult).length).toBe(2);
    expect(snap.ultimate(119)?.key).toBe(live.ultimates['119'].key);
    // An ally buff is not said to go through spell immunity: Valve's table says nothing there, and neither does the snapshot.
    expect(snap.heroAbilities(18)!.find((a) => a.id === 'sven_warcry')).not.toHaveProperty('pierces');
  });

  it('OpenDota\'s patch number names a patch, not its letter: its last release is used, and said to be a guess unless it is the only one', () => {
    expect(patchData(60)).toMatchObject({ name: '7.41f', exact: false, reason: 'letter_release_unknown; 7.41f data used' });
    expect(patchData(61)).toMatchObject({ name: '7.42a', exact: false, reason: 'letter_release_unknown; 7.42a data used' });
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
    // Innates stay out while Shard/Scepter granted abilities present in the historical snapshot are preserved.
    expect(old.heroAbilities(29)!.map((a: any) => a.id)).toEqual(now.heroAbilities(29)!.map((a: any) => a.id));
    expect(now.heroAbilities(29)!.find((a: any) => a.id === 'tidehunter_dead_in_the_water')).toMatchObject({ granted_by: 'shard' });
    expect(old.heroAbilities(29)!.some((a: any) => a.id === 'tidehunter_leviathans_catch')).toBe(false);
    // Enchantress in 7.41f and 7.40 preserves Little Friends and Sproink with snapshot flags/cd,
    // without back-porting 7.42 granted_by or tooltip text (e.g. Meepo's Dig moved from Shard in 7.41f to Scepter in 7.42).
    for (const rel of ['7.40', '7.41f']) {
      const hist = patchData(rel);
      const lf = hist.heroAbilities(58)!.find((a: any) => a.id === 'enchantress_little_friends');
      const sp = hist.heroAbilities(58)!.find((a: any) => a.id === 'enchantress_bunny_hop');
      expect(lf, rel).toMatchObject({ id: 'enchantress_little_friends', en: 'Little Friends', zh: '密友', pierces: false, dispel: 'no', cd: [20] });
      expect(lf, rel).not.toHaveProperty('desc');
      expect(lf, rel).not.toHaveProperty('granted_by');
      expect(sp, rel).toMatchObject({ id: 'enchantress_bunny_hop', en: 'Sproink', zh: '跃动', pierces: false, cd: [10] });
      expect(hist.aghsUpgrades(58, 'zh'), rel).toBeNull();
    }
    // Meepo's Dig was Shard in 7.41f and moved to Scepter in 7.42: 7.42 labels granted_by: 'scepter', 7.41f does not back-port it.
    expect(now.heroAbilities(82)!.find((a: any) => a.id === 'meepo_petrify')).toMatchObject({ granted_by: 'scepter' });
    expect(old.heroAbilities(82)!.find((a: any) => a.id === 'meepo_petrify')).not.toHaveProperty('granted_by');
    // Historical hero_abilities tool preserves granted abilities and reports a gap instead of back-porting 7.42 Scepter/Shard metadata.
    const oldEnch: any = heroAbilities(trace, { hero: 'enchantress' }, { lang: 'zh', match: as741 });
    expect(oldEnch.patch).toBe('7.41f');
    expect(oldEnch.abilities.find((a: any) => a.ability === 'enchantress_little_friends')).toMatchObject({ name: '密友', goes_through_spell_immunity: false, dispelled_by: 'no' });
    expect(oldEnch.aghanims_scepter).toBeNull();
    expect(oldEnch.aghanims_shard).toBeNull();
    expect(oldEnch.gaps).toContainEqual({ topic: 'scepter_shard_upgrades_for_this_patch', reason: 'scepter_shard_metadata_not_in_historical_snapshot_for_7.41f' });
    // Explicit granted_by on a historical snapshot ability (even one removed later) is preserved; missing hero stays null.
    const synthSnap = fromSnapshot({
      major: '7.41',
      items: {},
      heroes: {
        npc_dota_hero_beastmaster: [
          { id: 'beastmaster_drums_of_slom', en: 'Drums of Slom', dmg: 'M', pierces: false, dispel: 'no', granted_by: 'scepter' },
        ],
      },
    });
    expect(synthSnap.heroAbilities(38)).toEqual([
      { id: 'beastmaster_drums_of_slom', en: 'Drums of Slom', zh: 'Drums of Slom', granted_by: 'scepter', dmg: 'M', pierces: false, dispel: 'no' },
    ]);
    expect(synthSnap.heroAbilities(58)).toBeNull();
    expect(synthSnap.aghsUpgrades(38, 'en')).toBeNull();
    expect(old.heroAbilities(99999)).toBeNull();
  });

  it('a big item is judged on the patch\'s own price and recipe', () => {
    const rule = { minCost: KEY_ITEM_MIN_COST, always: ALWAYS_KEY_ITEMS };
    expect(isBigItemIn(patchData('7.41f'), 'heavens_halberd', rule)).toBe(true);
    expect(isBigItemIn(patchData('7.41f'), 'skypiercer', rule)).toBe(false);
    expect(isBigItemIn(patchData('7.42'), 'skypiercer', rule)).toBe(true);
    expect(isBigItemIn(patchData('7.42'), 'recipe_skypiercer', rule)).toBe(false);
    expect(isBigItemIn(patchData('7.42'), 'blink', rule)).toBe(true);
    // Upgraded Dagons are built from a recipe with no component list: still big items, in every release, as in the live tables.
    for (const k of ['dagon_2', 'dagon_3', 'dagon_4', 'dagon_5']) for (const r of ['7.40', '7.41c', '7.42']) expect([k, r, isBigItemIn(patchData(r), k, rule)]).toEqual([k, r, true]);
    // Every item the live tables call big is big in the newest snapshot, and the other way round.
    const live = patchData(null); const snap = newest();
    for (const k of Object.keys(snap.items)) expect([k, isBigItemIn(snap, k, rule)]).toEqual([k, isBigItemIn(live, k, rule)]);
    // Gold on top of a held part uses the patch's prices: Talisman of Evasion went into a 7.41 Halberd, not a 7.42 one.
    expect(goldOnTop(['talisman_of_evasion', 'heavens_halberd'], patchData('7.41f').items)).toEqual([null, 3300 - patchData('7.41f').items.talisman_of_evasion.cost]);
    expect(goldOnTop(['talisman_of_evasion', 'heavens_halberd'], patchData('7.42').items)).toEqual([null, null]);
  });
});

describe('the review tools tell a 7.41 game its own numbers', () => {
  it('build_check: prices and what an item does are 7.41f\'s, and an item 7.41 did not have is not offered', () => {
    const r: any = buildCheck(trace, { hero: 'beastmaster' }, { lang: 'zh', match: as741 });
    expect(r.data_patch).toBe('7.41f');
    // The items pros build against the killers: 7.41f's prices, and none that 7.41f did not have.
    const vs741 = r.answers_to_top_killers.flatMap((k: any) => k.pro_items_against_this_killer ?? []);
    expect(vs741.length).toBeGreaterThan(0);
    for (const i of vs741) { expect(patchData('7.41f').has(i.item)).toBe(true); expect(i.cost).toBe(patchData('7.41f').items[i.item].cost); }
    for (const i of r.most_built_by_pros_on_this_hero.items) expect(patchData('7.41f').has(i.item)).toBe(true);
    // What pros built is from 7.41f games, when they built Helm of the Overlord first — not 7.42's Aghanim's Scepter.
    expect(r.most_built_by_pros_on_this_hero).toMatchObject({ played_on_releases: ['7.41f'] });
    expect(r.most_built_by_pros_on_this_hero.pro_games).toBeGreaterThanOrEqual(30);
    expect(r.most_built_by_pros_on_this_hero.items[0].item).toBe('helm_of_the_overlord');
    // The patch is the game's: no fallback gap, and 7.42 Scepter text is never back-ported onto a 7.41f Scepter purchase.
    expect(r.my_big_items_in_order.find((i: any) => i.item === 'ultimate_scepter')).not.toHaveProperty('for_this_hero');
    expect(r.gaps.map((g: any) => g.topic)).not.toContain('pro_mid_game_items');
    expect(r.gaps.map((g: any) => g.topic)).not.toContain('item_and_ability_data_of_this_game_patch');
    const now: any = buildCheck(trace, { hero: 'beastmaster' }, { lang: 'zh', match: scoreboard });
    expect(now.data_patch).toBe('7.42');
    for (const i of now.answers_to_top_killers.flatMap((k: any) => k.pro_items_against_this_killer ?? [])) expect(i.cost).toBe(patchData(now.data_patch).items[i.item].cost);
    expect(now.most_built_by_pros_on_this_hero.played_on_releases).toEqual(['7.42']);
    const unknown: any = buildCheck(unplaced, { hero: 'beastmaster' }, { lang: 'zh' });
    expect(unknown.gaps).toContainEqual({ topic: 'item_and_ability_data_of_this_game_patch', reason: 'patch_of_this_game_unknown; 7.42a data used' });
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
    expect(pro.mid_game_items.played_on_releases).toEqual(['7.41f']);
    expect(pro).not.toHaveProperty('mid_game_items_in_the_patch_before');
    // The counter items are measured since 7.41: a 7.40 game is told they come from after it.
    const old: any = proItemChoices(trace, { hero: 'beastmaster' }, { lang: 'zh', match: { ...scoreboard, patch: 59, start_time: 1767000000 } });
    expect(old.data_patch).toBe('7.40b');
    expect(old.mid_game_items.played_on_releases.every((x: string) => x.startsWith('7.40'))).toBe(true);
    if (old.built_more_against_these_enemies.length) expect(old.gaps.map((g: any) => g.topic)).toContain('pro_counter_items');
    const card: any = resolveRef(trace, 'build:beastmaster', { hero: 'beastmaster', lang: 'zh', match: as741 });
    expect(card.record.data_patch).toBe('7.41f');
    expect(card.record.answers_to_top_killers).toEqual((buildCheck(trace, { hero: 'beastmaster' }, { lang: 'zh', match: as741 }) as any).answers_to_top_killers);
    expect(deepReviewSystem('zh')).toContain('data_patch');
  });
});

describe('which patch a game was played on, when the match data is not at hand', () => {
  it('the start time first, then the match id; a game during a rollout, older than the data, or known only by its patch number is not called exact', () => {
    const c = release('7.41c');
    expect(c).toMatchObject({ major: '7.41', major_id: 60, data: '7.41c.json', rollout_update: expect.stringContaining('Client') });
    // By start time: before the 20 minutes in which 7.41c rolled out, inside them, after them.
    // The last game before 7.41c was on 7.41b's last hotfix.
    expect(gamePatch(0, { start_time: at(c.rollout_from) - 1 })).toEqual({ release: '7.41b', hotfix: release('7.41b').hotfixes.at(-1).rollout_by, id: 60, how: 'start_time', exact: true });
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
    // OpenDota says a newer patch than the site knows: not placed in the last known release by time or id.
    const later = { patch: 62, start_time: at(release('7.42').rollout_by) + 40 * 86400 };
    expect(gamePatch(9200000000, later)).toEqual({ release: null, id: 62, how: 'match_data', exact: false, reason: 'patch_newer_than_the_site_data' });
    expect(patchForGame(9200000000, later)).toMatchObject({ name: CURRENT_RELEASE, exact: false, how: null, reason: 'patch_newer_than_the_site_data' });
    expect(patchForGame(9200000000, { ...later, patch: 61 })).toMatchObject({ name: '7.42a', exact: true, how: 'start_time' });
    // A newer release whose match ids are not indexed yet (between the two refresh steps): an id past the last
    // indexed boundary may be in it, so it is not called exact — unless OpenDota's patch number names the newer patch.
    const behind = index.releases.map((r: any) => (r.name === '7.42' ? { ...r, last_match_id_before: undefined, first_match_id_after: undefined } : r));
    expect(gamePatch(9100904020, null, { releases: behind })).toEqual({ release: '7.41f', hotfix: release('7.41f').hotfixes.at(-1).rollout_by, id: 60, how: 'match_id', exact: false, reason: 'may_be_7.42_or_later_whose_match_ids_are_not_indexed' });
    expect(gamePatch(9100904020, { patch: 61 }, { releases: behind })).toEqual({ release: null, id: 61, how: 'match_data', exact: false, reason: 'letter_release_unknown' });
    expect(gamePatch(9091400302, null, { releases: behind })).toMatchObject({ release: '7.41f', exact: false });
    // With every boundary indexed, the same games are placed exactly.
    expect(gamePatch(9100904020, null)).toMatchObject({ release: '7.42', exact: true });
    // Neither a start time nor an id it can place: only OpenDota's patch number, which names no letter.
    expect(gamePatch(0, { patch: 60 })).toEqual({ release: null, id: 60, how: 'match_data', exact: false, reason: 'letter_release_unknown' });
    expect(gamePatch('not an id', null)).toMatchObject({ release: null, reason: 'patch_of_this_game_unknown' });
    expect(patchForGame(9091400302, null)).toMatchObject({ name: '7.41f', exact: true, how: 'match_id', reason: null });
    expect(patchForGame(0, { patch: 60 })).toMatchObject({ name: '7.41f', exact: false, how: 'match_data', reason: 'letter_release_unknown; 7.41f data used' });
    expect(patchForGame(0, { patch: 61 })).toMatchObject({ name: '7.42a', exact: false, how: 'match_data', reason: 'letter_release_unknown; 7.42a data used' });
    expect(patchForGame(index.releases[0].last_match_id_before, null)).toMatchObject({ name: CURRENT_RELEASE, exact: false, how: null, reason: 'older_than_7.40' });
  });

  it('the review says which patch its numbers are from, and how that is known', async () => {
    expect(reviewToolkit({ trace, hero: 'beastmaster', lang: 'zh' })!.patch).toEqual({ name: '7.42', exact: true, known_from: 'match_id' });
    // The 7.41f game was played after 7.41f's hotfix of 7 October: the record says so.
    expect(reviewToolkit({ trace, hero: 'beastmaster', lang: 'zh', match: as741 })!.patch).toEqual({ name: '7.41f', hotfix: release('7.41f').hotfixes[0].rollout_by, exact: true, known_from: 'start_time' });
    expect(reviewToolkit({ trace: unplaced, hero: 'beastmaster', lang: 'zh' })!.patch).toEqual({ name: '7.42a', exact: false, reason: 'patch_of_this_game_unknown' });
    const finding = { title: '咆哮', claim: '幻影刺客开了 7 次黑皇杖。', evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 吼进黑皇杖，定住 3.4 秒' }], fix: '留给她。', rule: { when: 'w', do: 'd', this_game: 'x' } };
    const complete = async (o: any) => (o.messages.at(-1).role === 'user'
      ? { toolCalls: [{ id: 'a', name: 'ability_audit', args: { hero: 'beastmaster', ability: 'primal_roar' } }] }
      : { toolCalls: [{ id: 's', name: 'submit_review', args: { verdict: '咆哮没有留给幻影刺客。', mainline: [], findings: [finding], blind_spots: [] } }] });
    const out: any = await runDeepReview({ complete, trace, hero: 'beastmaster', lang: 'zh', match: as741 });
    expect(out.review.data_patch).toEqual({ name: '7.41f', hotfix: release('7.41f').hotfixes[0].rollout_by, exact: true, known_from: 'start_time' });
  });
});

describe('a letter release after the live tables moved on', () => {
  it('7.42a shortened Reaper\'s Scythe: a 7.42 game is told 100 seconds, a 7.42a game 95', () => {
    expect(patchData('7.42').ultimate(36)?.cd).toEqual([100]);
    expect(patchData('7.42a').ultimate(36)?.cd).toEqual([95]);
  });
});

describe('a hotfix within a release has numbers of its own', () => {
  const f = () => release('7.41f');
  it('each hotfix lies within its release, with its own snapshot or a reason there is none', () => {
    for (const [k, r] of index.releases.entries()) {
      const next = index.releases[k + 1];
      let prev = Date.parse(r.rollout_by);
      for (const h of r.hotfixes ?? []) {
        expect(Date.parse(h.rollout_from)).toBeGreaterThanOrEqual(prev);
        if (next) expect(Date.parse(h.rollout_by)).toBeLessThan(Date.parse(next.rollout_from));
        prev = Date.parse(h.rollout_by);
        if (h.data) expect(JSON.parse(readFileSync(new URL(`../../lib/data/constants/patches/${h.data}`, import.meta.url), 'utf8'))).toMatchObject({ release: r.name, hotfix: h.rollout_by });
        else expect(h.reason).toBe('game_files_not_read_by_the_builder');
      }
    }
  });

  it('7.41f\'s hotfix of 7 October raised Necronomicon: a game before it is told 2050 gold, one after it 2700', () => {
    const h = f().hotfixes[0];
    expect(h.rollout_by.slice(0, 10)).toBe('2026-10-07');
    const before = patchForGame(0, { start_time: at(h.rollout_from) - 3600 });
    expect(before).toMatchObject({ name: '7.41f', hotfix: null, exact: true });
    expect(before.items.necronomicon.cost).toBe(2050);
    const after = patchForGame(0, { start_time: at(h.rollout_by) + 3600 });
    expect(after).toMatchObject({ name: '7.41f', hotfix: h.rollout_by, exact: true });
    expect(after.items.necronomicon.cost).toBe(2700);
    // patchData of the release alone is the release as it rolled out.
    expect(patchData('7.41f').items.necronomicon.cost).toBe(2050);
    expect(patchData('7.41f', { hotfix: h.rollout_by }).items.necronomicon.cost).toBe(2700);
    // During the twenty minutes the hotfix was rolling out: the release is known, the hotfix is not.
    const during = patchForGame(0, { start_time: at(h.rollout_from) + 60 });
    expect(during).toMatchObject({ name: '7.41f', exact: false, reason: `started_while_the_${h.rollout_by.slice(0, 16)}_hotfix_was_rolling_out` });
    // The tools say which hotfix their numbers are from.
    const r: any = buildCheck(trace, { hero: 'beastmaster' }, { lang: 'en', match: { ...scoreboard, patch: 60, start_time: at(h.rollout_by) + 3600 } });
    expect(r).toMatchObject({ data_patch: '7.41f', data_hotfix: '2026-10-07' });
    expect(buildCheck(trace, { hero: 'beastmaster' }, { lang: 'en', match: { ...scoreboard, patch: 60, start_time: at(h.rollout_from) - 3600 } })).not.toHaveProperty('data_hotfix');
  });

  it('a hotfix the builder could not read is not filled with its neighbour\'s numbers as if they were its own', () => {
    // None is unread now (the builder skips a facet naming a missing ability): one is made so in a copy of the list.
    const r = release('7.41');
    const releases = RELEASES.map((x: any) => (x.name === '7.41' ? { ...x, hotfixes: x.hotfixes.map((h: any, i: number) => (i === 1 ? { ...h, data: null, reason: 'game_files_not_read_by_the_builder' } : h)) } : x));
    const pd = patchData('7.41', { hotfix: r.hotfixes[1].rollout_by, releases });
    expect(pd).toMatchObject({ name: '7.41', exact: false, hotfix: r.hotfixes[0].rollout_by });
    expect(pd.reason).toContain('data_not_built');
    // With its data, the same hotfix is exact and its own.
    expect(patchData('7.41', { hotfix: r.hotfixes[1].rollout_by })).toMatchObject({ exact: true, hotfix: r.hotfixes[1].rollout_by });
  });

  it('a hotfix whose ids are not found yet: games known to be older than it are still placed exactly', () => {
    // Made from the data: the newest 7.42a hotfix as it was before the ids around it were found (#438 found them,
    // and a test on the live file could no longer see this case). The search had looked at games up to one that
    // started before the hotfix.
    const real: any = RELEASES.find((r: any) => r.name === '7.42a');
    const h: any = real.hotfixes.at(-1);
    const { first_match_id_after: _after, last_match_id_before: lastBefore, ...unfound } = h;
    // The newest game known to be before it: its own id when the data has found it, else the newest the search saw.
    const before = lastBefore ?? index.ids_checked_to.match_id;
    const releases = RELEASES.map((r: any) => (r.name === '7.42a' ? { ...r, hotfixes: [...r.hotfixes.slice(0, -1), unfound] } : r));
    const checked = { match_id: before, started: new Date(Date.parse(h.rollout_from) - 60_000).toISOString() };
    const o = { releases, checked };
    expect(Date.parse(checked.started)).toBeLessThan(Date.parse(h.rollout_from));
    // At or below the newest match the search looked at: started before the hotfix, so on 7.42a as it rolled out.
    expect(gamePatch(real.first_match_id_after, null, o)).toEqual({ release: '7.42a', id: 61, how: 'match_id', exact: true });
    expect(gamePatch(checked.match_id, null, o)).toMatchObject({ release: '7.42a', exact: true });
    expect(gamePatch(checked.match_id, null, o)).not.toHaveProperty('hotfix');
    // Past it: maybe after the hotfix, not called exact.
    expect(gamePatch(checked.match_id + 1, null, o)).toMatchObject({ release: '7.42a', exact: false, reason: `may_be_after_the_${h.rollout_by.slice(0, 16)}_hotfix_whose_match_ids_are_not_indexed` });
    // Without that record nothing is assumed.
    expect(gamePatch(real.first_match_id_after, null, { releases, checked: null })).toMatchObject({ exact: false });
    // The start time, when known, places the game on either side of the hotfix exactly.
    expect(patchForGame(0, { start_time: at(h.rollout_by) + 60 })).toMatchObject({ name: '7.42a', hotfix: h.rollout_by, exact: true });
  });

  it('every update the builder ran on was read: no hotfix is left without its data', () => {
    for (const r of index.releases) for (const h of r.hotfixes ?? []) expect([r.name, h.rollout_by, Boolean(h.data)]).toEqual([r.name, h.rollout_by, true]);
  });

  it('by match id too: each hotfix\'s ids fall on either side of it', () => {
    for (const r of index.releases) for (const [k, h] of (r.hotfixes ?? []).entries()) {
      if (!h.first_match_id_after) continue;
      expect(h.first_match_id_after).toBeGreaterThan(h.last_match_id_before);
      expect(gamePatch(h.first_match_id_after, null)).toMatchObject({ release: r.name, hotfix: h.rollout_by });
      const prior = gamePatch(h.last_match_id_before, null) as any;
      expect(prior.release).toBe(r.name);
      expect(prior.hotfix).toBe(k ? r.hotfixes[k - 1].rollout_by : undefined);
    }
  });
});
