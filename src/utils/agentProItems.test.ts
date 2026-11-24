import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { MIN_GAMES, RELEASES_WITH_PRO_DATA, coversPatch, proItemsFor } from '../../lib/agent/proItems.js';
import { patchData, patchForGame } from '../../lib/agent/patchData.js';
import { gunzipSync } from 'node:zlib';
import { proItemChoices } from '../../lib/agent/knowledgeTools.js';
import { buildCheck } from '../../lib/agent/situationTools.js';
import { goalFromReview } from '../../lib/agent/goal.js';

const trace = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());

const DATA = JSON.parse(readFileSync(new URL('../../lib/coach/data/pro-items-by-release.json', import.meta.url), 'utf8'));
const order = DATA.releases.map((r: any) => r.name);
const row = (release: string, hero: number) => DATA.releases.find((r: any) => r.name === release).heroes[String(hero)];
const BEASTMASTER = 38; const TIDEHUNTER = 29; const PHANTOM_ASSASSIN = 44;

describe('pro items by the release a game was played on', () => {
  it('the data covers every release the site has item data for, each with its own window', () => {
    const index = JSON.parse(readFileSync(new URL('../../lib/data/constants/patches/index.json', import.meta.url), 'utf8'));
    expect([...RELEASES_WITH_PRO_DATA].sort()).toEqual(index.releases.map((r: any) => r.name).sort());
    // One release ends before the next begins: a game in a rollout window is in neither.
    for (let i = 1; i < DATA.releases.length; i++) expect(Date.parse(DATA.releases[i - 1].to)).toBeLessThan(Date.parse(DATA.releases[i].from));
    expect(DATA.releases.at(-1).to).toBeNull();
  });

  it('a release with enough games of the hero is told alone: Beastmaster pros went from Aghanim\'s Scepter to Helm of the Overlord', () => {
    const f = proItemsFor(BEASTMASTER, patchData('7.41f'))!;
    expect(f).toEqual({ releases: ['7.41f'], ...row('7.41f', BEASTMASTER) });
    expect(f.items[0][0]).toBe('helm_of_the_overlord');
    expect(proItemsFor(BEASTMASTER, patchData('7.40c'))!.items[0][0]).toBe('ultimate_scepter');
  });

  it('a release with few games adds the releases just before it in the same patch, never a later one', () => {
    // A hero with too few games in 7.41e alone and enough with 7.41d.
    const hero = Number(Object.keys(DATA.releases.find((r: any) => r.name === '7.41e').heroes).find((h) => row('7.41e', +h).games < MIN_GAMES && (row('7.41d', +h)?.games ?? 0) + row('7.41e', +h).games >= MIN_GAMES));
    expect(hero).toBeGreaterThan(0);
    const e = proItemsFor(hero, patchData('7.41e'))!;
    expect(e.releases).toEqual(['7.41d', '7.41e']);
    expect(e.games).toBe(row('7.41d', hero).games + row('7.41e', hero).games);
    const summed = (k: string) => [row('7.41d', hero), row('7.41e', hero)].reduce((a: number, r: any) => a + (r.items.find((x: any) => x[0] === k)?.[1] ?? 0), 0);
    for (const [k, n] of e.items) expect(n).toBe(summed(k));
    for (const name of order) for (const h of [BEASTMASTER, TIDEHUNTER, PHANTOM_ASSASSIN, hero]) {
      const s = proItemsFor(h, patchData(name));
      for (const r of s?.releases ?? []) expect(order.indexOf(r)).toBeLessThanOrEqual(order.indexOf(name));
      for (const r of s?.releases ?? []) expect(patchData(r).major).toBe(patchData(name).major);
    }
  });

  it('a patch days old: its own few games, and the patch before apart, never mixed in', () => {
    // A hero with some but fewer than MIN_GAMES pro games in 7.42 (the data grows as the patch ages: found, not named).
    const few = Number(Object.keys(DATA.releases.at(-1).heroes).find((h) => row('7.42', +h).games < MIN_GAMES));
    expect(few).toBeGreaterThan(0);
    const t = proItemsFor(few, patchData('7.42'))!;
    expect(t).toMatchObject({ releases: ['7.42'], games: row('7.42', few).games, few_games: true });
    expect(t.before_this_patch!.releases.at(-1)).toBe('7.41f');
    expect(t.before_this_patch!.releases.every((r) => patchData(r).major === '7.41')).toBe(true);
    // The first release of a patch does not borrow from the patch before either: 7.41 had too few Tidehunter games.
    expect(row('7.41', TIDEHUNTER).games).toBeLessThan(MIN_GAMES);
    const first = proItemsFor(TIDEHUNTER, patchData('7.41'))!;
    expect(first).toMatchObject({ releases: ['7.41'], games: row('7.41', TIDEHUNTER).games, few_games: true });
    expect(first.before_this_patch!.releases.at(-1)).toBe('7.40c');
  });

  it('a release without pro data is no sample, and a whole-patch measure says whether it covers the game', () => {
    expect(proItemsFor(BEASTMASTER, { name: '7.39' })).toBeNull();
    expect(proItemsFor(BEASTMASTER, null)).toBeNull();
    expect(coversPatch('7.41', patchData('7.41f'))).toBe(true);
    expect(coversPatch('7.41', patchData('7.42'))).toBe(true);
    expect(coversPatch('7.41', patchData('7.40c'))).toBe(false);
  });

  it('a game whose release is not known is given no release\'s pro sample, not the current one as if it were its own', () => {
    // Older than the first release the site has: patchForGame falls back to the current release's data.
    const old = patchForGame(trace.match_id, { patch: 58, start_time: 1750000000 });
    expect(old.exact).toBe(false);
    expect(proItemsFor(BEASTMASTER, old)).toBeNull();
    const r: any = proItemChoices(trace, { hero: 'beastmaster' }, { lang: 'en', match: { patch: 58, start_time: 1750000000 } });
    expect(r.mid_game_items).toBeNull();
    expect(r.gaps.find((g: any) => g.topic === 'pro_mid_game_items').reason).toContain('release_of_this_game_not_known');
    expect((buildCheck(trace, { hero: 'beastmaster' }, { lang: 'en', match: { patch: 58, start_time: 1750000000 } }) as any).most_built_by_pros_on_this_hero).toBeNull();
    // A newer patch than the data knows is not placed either; a rollout window still names one of its two releases.
    expect(proItemsFor(BEASTMASTER, patchForGame(trace.match_id, { patch: 99 }))).toBeNull();
    const rolling = patchForGame(0, { start_time: Date.parse(DATA.releases.find((x: any) => x.name === '7.41f').from) / 1000 - 600 });
    expect(rolling.exact).toBe(false);
    expect(proItemsFor(BEASTMASTER, rolling)).not.toBeNull();
  });

  it('a next-game goal may name an item offered from the patch before, as both build tools offer it', () => {
    // Skywrath Mage has almost no 7.42 pro games: its items come from the patch before, told apart.
    const pro: any = proItemChoices(trace, { hero: 'skywrath_mage' }, { lang: 'en' });
    expect(pro.mid_game_items_in_the_patch_before).toBeTruthy();
    const item = pro.mid_game_items_in_the_patch_before.items.find((i: any) => i.player_first_held == null && !(pro.mid_game_items?.items ?? []).some((x: any) => x.item === i.item) && !pro.built_more_against_these_enemies.some((x: any) => x.item === i.item));
    expect(item).toBeTruthy();
    const goal: any = goalFromReview({ finding: 1, kind: 'hold_item', items: [item.item] }, { trace, hero: 'skywrath_mage', findings: 1 });
    expect(goal?.spec).toMatchObject({ kind: 'hold_item', items: [item.item] });
  });
});

