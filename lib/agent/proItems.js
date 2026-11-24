/**
 * What professional players built on a hero, from the games of the release a
 * match was played on (lib/coach/data/pro-items-by-release.json).
 *
 * A letter release alone often has too few pro games of a hero, so the
 * releases before it within the same patch are added, newest first, until
 * there are MIN_GAMES. Releases after the game are never used: they did not
 * exist when it was played. When the whole patch up to the game has too few
 * (a patch days old), what it has is given with `few_games`, and the last
 * releases of the patch before are given apart, never mixed in, so the
 * answer can say "before this patch".
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DATA = require('../coach/data/pro-items-by-release.json');

export const MIN_GAMES = 30;
/** Below MIN_GAMES but at least this many: the game's own patch is still used for what pros build first, marked few_games. */
export const MIN_FEW_GAMES = 10;
export const PRO_ITEMS_SOURCE = Object.freeze({ source: DATA.source, fetched: DATA.fetched, window: DATA.window });
const RELEASES = DATA.releases;

/** Sums the rows of `releases` for `heroId`: { games, items: [[key, n]] } (biggest first), or null. */
function pooled(releases, heroId) {
  let games = 0;
  const items = new Map();
  for (const r of releases) {
    const row = r.heroes[String(heroId)];
    if (!row) continue;
    games += row.games;
    for (const [k, n] of row.items) items.set(k, (items.get(k) ?? 0) + n);
  }
  return games ? { games, items: [...items].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])) } : null;
}

/** Newest first from `index` within `major`, until the hero has MIN_GAMES. */
function backFrom(index, major, heroId) {
  const used = [];
  let sample = null;
  for (let i = index; i >= 0 && RELEASES[i].major === major; i--) {
    used.unshift(RELEASES[i]);
    sample = pooled(used, heroId);
    if (sample && sample.games >= MIN_GAMES) break;
  }
  return sample ? { ...sample, releases: used.filter((r) => r.heroes[String(heroId)]).map((r) => r.name) } : null;
}

/**
 * The pro sample for `heroId` in the game's release `pd` (patchForGame).
 * @returns {{ releases: string[], games: number, items: [string, number][], few_games?: true,
 *   before_this_patch?: { releases: string[], games: number, items: [string, number][] } } | null}
 *   null when the release has no pro data at all (older than the data, or unknown).
 */
export function proItemsFor(heroId, pd) {
  if (!releaseIsPlaced(pd)) return null;
  const index = RELEASES.findIndex((r) => r.name === pd?.name);
  if (index < 0) return null;
  const major = RELEASES[index].major;
  const own = backFrom(index, major, heroId);
  if (own && own.games >= MIN_GAMES) return own;
  // Too few in this patch so far: the patch before, apart.
  const lastBefore = RELEASES.findLastIndex((r, i) => i < index && r.major !== major);
  const before = lastBefore >= 0 ? backFrom(lastBefore, RELEASES[lastBefore].major, heroId) : null;
  if (!own && !before) return null;
  return { ...(own ?? { releases: [], games: 0, items: [] }), few_games: true, ...(before ? { before_this_patch: before } : {}) };
}

/**
 * Whether `pd` names the game's own release (or one of the two a rollout or an unindexed id leaves open), not the
 * current release used as a fallback for a game that is older than the data, newer than it, or not placed at all.
 */
export function releaseIsPlaced(pd) {
  if (!pd?.name) return false;
  if (pd.exact) return true;
  return pd.how != null && !/^(patch_newer|no_data_kept|older_than|patch_of_this_game_unknown)/.test(String(pd.reason ?? ''));
}

/** The release names this file has pro games of. */
export const RELEASES_WITH_PRO_DATA = new Set(RELEASES.map((r) => r.name));

/** Whether a whole-patch pro measure taken "since <patch>" covers the game's patch (`pd` from patchForGame). */
export const coversPatch = (since, pd) => Boolean(pd?.major && since) && String(pd.major).localeCompare(String(since), 'en', { numeric: true }) >= 0;
