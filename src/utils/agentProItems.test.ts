import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { MIN_GAMES, RELEASES_WITH_PRO_DATA, coversPatch, proItemsFor } from '../../lib/agent/proItems.js';
import { patchData } from '../../lib/agent/patchData.js';

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
});
