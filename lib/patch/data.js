/**
 * The current patch as data: Valve's notes — live from Valve's datafeed, the
 * major patch and every letter update after it (lib/patch/liveNotes.js calls
 * useLiveNotes), else the committed snapshot data/patch-notes.json (written by
 * scripts/coach-patch-notes.mjs) — and every hero's public win rate and pick
 * rate before and since the patch (data/patch-meta.json from STRATZ, written
 * by scripts/coach-patch-meta.mjs). Pure lookups: nothing is fetched here.
 *
 * Notes are Valve's lines, never reworded. The numbers follow the rule of the
 * other baselines — no claim on noise:
 * - a window with fewer than MIN_GAMES games of the hero has no rate (null);
 * - a win rate "rose" or "fell" only when the two windows are at least
 *   WIN_MIN_GAP apart and two standard errors of that difference;
 * - a pick rate "rose" or "fell" only when it changed by at least
 *   PICK_MIN_RATIO of what it was.
 *   Otherwise "about_the_same"; with too few games, null — never "the same".
 *
 * A change after a patch is not a change because of the hero's own notes:
 * every other hero, the items and the map changed in the same patch.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let NOTES = require('../coach/data/patch-notes.json');
const META = require('../coach/data/patch-meta.json');
const NAMES = require('../coach/data/names.json');

const patchOf = (n) => Object.freeze({
  // The newest release (7.42a), the major patch it updates (7.42), and every release whose notes are in.
  version: n.version, major: n.major ?? n.version, released: n.released, url: n.url,
  releases: n.releases ?? [{ version: n.version, released: n.released, url: n.url }],
  notes_source: n.source, notes_fetched: n.fetched,
});
/** A live binding: importers see the notes now in use. */
export let PATCH = patchOf(NOTES);
let revision = 0;
/** Goes up each time the notes are replaced; caches built from them key on it. */
export const notesRevision = () => revision;
/** Use these notes from now on (valveNotes.mergeReleases' shape). */
export function useLiveNotes(notes) {
  NOTES = notes;
  PATCH = patchOf(notes);
  revision += 1;
}
export const META_SOURCE = Object.freeze({ source: META.source, attribution: META.attribution, patch: META.patch, before: META.before, after: META.after, fetched: META.fetched, games: META.games });
/** Rank brackets the numbers exist for; `all` is every bracket together (unranked players included). */
export const PATCH_BRACKETS = Object.freeze([...META.brackets]);
export const BRACKET_NAME = Object.freeze({
  all: { en: 'all brackets', zh: '全部分段' }, hg: { en: 'Herald–Guardian', zh: '先锋–卫士' }, ca: { en: 'Crusader–Archon', zh: '中军–统帅' },
  la: { en: 'Legend–Ancient', zh: '传奇–万古' }, di: { en: 'Divine–Immortal', zh: '超凡–冠绝' },
});

const MIN_GAMES = 1000;
const WIN_MIN_GAP = 0.01;
const PICK_MIN_RATIO = 0.1;
const r3 = (n) => Math.round(n * 1000) / 1000;
const r4 = (n) => Math.round(n * 10000) / 10000;
const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s_'’.-]/g, '');

const HEROES = Object.entries(NAMES.heroes).map(([id, h]) => ({ id: Number(id), slug: h.slug, en: h.en, zh: h.zh }));
/** A hero by id, slug, English or Chinese name; null when unknown. */
export function findHero(query) {
  if (query == null || query === '') return null;
  const q = norm(query);
  return HEROES.find((h) => String(h.id) === q || norm(h.slug) === q || norm(h.en) === q || h.zh === String(query).trim()) ?? null;
}
/** An item the patch notes mention, by key, English or Chinese name; null when the notes do not have it. */
export function findNotedItem(query) {
  if (query == null || query === '') return null;
  const q = norm(String(query).replace(/^item_/, ''));
  const hit = Object.entries(NOTES.items).find(([key, it]) => norm(key) === q || norm(it.name.en) === q || it.name.zh === String(query).trim());
  return hit ? { key: hit[0], ...hit[1] } : null;
}
export const bracketOf = (b) => (PATCH_BRACKETS.includes(b) ? b : null);

/**
 * The same, from the four counts themselves: [games before, wins before, games after, wins after] and the
 * matches of the two windows.
 * @param {number[] | null | undefined} row
 * @param {number[] | null | undefined} matches
 */
export function metaFromCounts(row, matches) {
  if (!Array.isArray(row) || row.length !== 4 || !Array.isArray(matches) || !(matches[0] > 0) || !(matches[1] > 0)) return null;
  const [gb, wb, ga, wa] = row;
  const enough = gb >= MIN_GAMES && ga >= MIN_GAMES;
  const p1 = gb >= MIN_GAMES ? wb / gb : null; const p2 = ga >= MIN_GAMES ? wa / ga : null;
  // The verdicts are taken from the numbers as they are stated (the change to a tenth of a point, the ratio to
  // two decimals), so what a reader is shown and what it is called never disagree at the edge.
  let win = null; let points = null;
  if (enough) {
    const diff = p2 - p1;
    points = Math.round(diff * 1000) / 10;
    const se = Math.sqrt((p1 * (1 - p1)) / gb + (p2 * (1 - p2)) / ga);
    win = Math.abs(points) >= WIN_MIN_GAP * 100 && Math.abs(diff) >= 2 * se ? (diff > 0 ? 'rose' : 'fell') : 'about_the_same';
  }
  const k1 = gb / matches[0]; const k2 = ga / matches[1];
  // Picked more or less is a statement about a rate that existed: with too few games on either side, none is made.
  const times = enough && k1 > 0 ? Math.round((k2 / k1) * 100) / 100 : null;
  return {
    games_before: gb, games_after: ga,
    win_rate_before: p1 == null ? null : r3(p1), win_rate_after: p2 == null ? null : r3(p2),
    win_rate_change_in_points: points, win_rate: win,
    pick_rate_before: r4(k1), pick_rate_after: r4(k2),
    pick_rate_times: times,
    pick_rate: times == null ? null : Math.round(Math.abs(times - 1) * 100) >= PICK_MIN_RATIO * 100 ? (times > 1 ? 'rose' : 'fell') : 'about_the_same',
  };
}

/**
 * Hero h's games, win rate and pick rate before and since the patch in bracket b.
 * Pick rate is the share of matches the hero was in.
 * @param {number | string} h  hero id
 * @param {string} [b]  one of PATCH_BRACKETS
 */
export function heroMeta(h, b = 'all') {
  return metaFromCounts(META.heroes?.[b]?.[h], META.games?.[b]);
}

/** Every hero's numbers in bracket b: [{ id, slug, ...heroMeta }], heroes the data lacks left out. */
export function allHeroMeta(b = 'all') {
  return HEROES.map((h) => { const m = heroMeta(h.id, b); return m ? { id: h.id, slug: h.slug, ...m } : null; }).filter(Boolean);
}

/** Valve's notes for a hero: [{ about, key?, name?, unit?, patch?, lines: [{ en, zh }] }] (patch: from that letter update), or null when no release lists the hero. */
export const heroNotes = (slug) => NOTES.heroes?.[slug] ?? null;
export const generalNotes = () => NOTES.general;
export const notedItems = () => Object.entries(NOTES.items).map(([key, it]) => ({ key, ...it }));
export const creepNotes = () => NOTES.creeps;
export const notedHeroes = () => Object.keys(NOTES.heroes);
