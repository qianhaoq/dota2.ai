/**
 * Lookup tools of the patch advisor: what the current patch changed (Valve's
 * notes, quoted) and how every hero's public win rate and pick rate moved
 * (STRATZ, before and since the patch). Pure: (args, ctx) → JSON, from the
 * committed snapshots in ./data.js. `ctx.lang` picks the language of names
 * and of the quoted notes (Valve publishes both).
 *
 * Tools report; they do not judge. A number the data cannot give is null and
 * what the data does not cover is listed under `gaps` — unknown, not false.
 */
import {
  BRACKET_NAME, META_SOURCE, PATCH, PATCH_BRACKETS, allHeroMeta, bracketOf, creepNotes, findHero, findNotedItem, generalNotes, heroMeta, heroNotes, notedHeroes, notedItems,
} from './data.js';
import { createRequire } from 'node:module';

const NAMES = createRequire(import.meta.url)('../coach/data/names.json');
const BY_SLUG = new Map(Object.entries(NAMES.heroes).map(([id, h]) => [h.slug, { id: Number(id), ...h }]));

const L = (ctx) => (ctx?.lang === 'zh' ? 'zh' : 'en');
const fail = (error, extra = {}) => ({ error, ...extra });
const MAX_MOVERS = 15;
const MAX_HITS = 40;
const WINDOWS = { before_the_patch: META_SOURCE.before, since_the_patch: META_SOURCE.after };
const META_NOTE = 'Public matches, not filtered by game mode. pick_rate is the share of matches the hero was in. A change since the patch is not proof of a cause: every hero, the items and the map changed at once.';
const META_GAPS = [
  { topic: 'cause_of_a_change', reason: 'a_before_and_after_comparison_does_not_say_why' },
  { topic: 'item_win_rates_and_purchase_rates', reason: 'not_in_data' },
  { topic: 'professional_matches', reason: 'public_matches_only' },
];
const RULE = 'win_rate is "rose" or "fell" when the two windows are at least 1 point and two standard errors apart; pick_rate when it changed by at least 10% of what it was; a hero with under 1000 games in a window has no rate';

/** A hero's notes in one language: [{ about, ability?, name?, lines: [text] }]. */
function notesOf(slug, lang) {
  return (heroNotes(slug) ?? []).map((p) => ({
    about: p.unit && p.about === 'ability' ? 'ability_of_a_unit_of_the_hero' : p.about === 'unit' ? 'a_unit_of_the_hero' : p.about,
    ...(p.key ? { ability: p.key, name: p.name[lang] } : {}),
    lines: p.lines.map((x) => x[lang]),
  }));
}
const heroRow = (m, lang) => ({ hero: m.slug, name: BY_SLUG.get(m.slug)?.[lang] ?? m.slug, win_rate_before: m.win_rate_before, win_rate_after: m.win_rate_after, win_rate_change_in_points: m.win_rate_change_in_points, pick_rate_before: m.pick_rate_before, pick_rate_after: m.pick_rate_after, pick_rate_times: m.pick_rate_times });

/** Heroes ordered by how far a rate moved, the ones the rule calls a move only. */
function movers(bracket, by, direction, limit) {
  const all = allHeroMeta(bracket);
  const verdict = by === 'pick_rate' ? 'pick_rate' : 'win_rate';
  const size = by === 'pick_rate' ? (m) => m.pick_rate_times : (m) => m.win_rate_change_in_points;
  const want = direction === 'down' ? 'fell' : 'rose';
  const hit = all.filter((m) => m[verdict] === want).sort((a, b) => (direction === 'down' ? size(a) - size(b) : size(b) - size(a)));
  return { total: hit.length, list: hit.slice(0, limit) };
}

export function patchOverview(_args = {}, ctx = {}) {
  const lang = L(ctx);
  const items = notedItems();
  const top = (by, direction) => movers('all', by, direction, 5).list.map((m) => heroRow(m, lang));
  return {
    ref: 'patch',
    patch: PATCH.version, released: PATCH.released, notes: PATCH.url,
    general_sections: generalNotes().map((g) => ({ section: g.title[lang], changes: g.lines.filter((x) => !x.sub).length })),
    heroes_changed: notedHeroes().length,
    items_changed: items.filter((i) => !i.neutral).length, neutral_items_changed: items.filter((i) => i.neutral).length,
    // Valve's own label on the entry ("New Item", "Returning Item"), for the items of the shop.
    labelled_items: items.filter((i) => i.tag && !i.neutral).map((i) => ({ item: i.key, name: i.name[lang], label: i.tag[lang] })),
    neutral_creeps_changed: creepNotes().length,
    numbers: { source: META_SOURCE.source, bracket: BRACKET_NAME.all[lang], ...WINDOWS, matches: { before_the_patch: META_SOURCE.games.all[0], since_the_patch: META_SOURCE.games.all[1] } },
    // The five largest moves each way over all brackets; meta_movers gives more, and per bracket.
    win_rate_rose_most: top('win_rate', 'up'), win_rate_fell_most: top('win_rate', 'down'),
    pick_rate_rose_most: top('pick_rate', 'up'), pick_rate_fell_most: top('pick_rate', 'down'),
    rule: RULE, note: META_NOTE, gaps: META_GAPS,
  };
}

export function heroPatch(args = {}, ctx = {}) {
  const lang = L(ctx);
  const hero = findHero(args.hero);
  if (!hero) return fail('unknown_hero');
  const bracket = args.bracket == null ? 'all' : bracketOf(args.bracket);
  if (!bracket) return fail('unknown_bracket', { brackets: PATCH_BRACKETS });
  const notes = notesOf(hero.slug, lang);
  const m = heroMeta(hero.id, bracket);
  // The same hero in every bracket, one map per measure: a change can be one bracket's only.
  const per = (f) => Object.fromEntries(PATCH_BRACKETS.map((b) => { const x = heroMeta(hero.id, b); return [b, x ? f(x) : null]; }));
  return {
    ref: `hero_patch:${hero.slug}${bracket === 'all' ? '' : `:${bracket}`}`,
    hero: hero.slug, name: hero[lang], patch: PATCH.version,
    // Valve's notes for the hero, quoted. An empty list means the patch notes do not list this hero.
    notes, notes_lines_total: notes.reduce((a, p) => a + p.lines.length, 0), notes_source: PATCH.notes_source,
    bracket, bracket_name: BRACKET_NAME[bracket][lang], ...WINDOWS,
    ...(m ?? { games_before: null, games_after: null, win_rate: null, pick_rate: null }),
    win_rate_change_in_points_by_bracket: per((x) => x.win_rate_change_in_points),
    win_rate_after_by_bracket: per((x) => x.win_rate_after),
    pick_rate_after_by_bracket: per((x) => x.pick_rate_after),
    rule: RULE, numbers_source: META_SOURCE.source, note: META_NOTE,
    gaps: [...(m ? [] : [{ topic: 'hero_numbers', reason: 'hero_not_in_the_data' }]), ...(notes.length ? [] : [{ topic: 'hero_notes', reason: 'the_patch_notes_do_not_list_this_hero' }]), ...META_GAPS],
  };
}

export function metaMovers(args = {}, ctx = {}) {
  const lang = L(ctx);
  const by = args.by === 'pick_rate' ? 'pick_rate' : args.by == null || args.by === 'win_rate' ? 'win_rate' : null;
  const direction = args.direction === 'down' ? 'down' : args.direction == null || args.direction === 'up' ? 'up' : null;
  if (!by || !direction) return fail('invalid_arguments', { by: ['win_rate', 'pick_rate'], direction: ['up', 'down'] });
  const bracket = args.bracket == null ? 'all' : bracketOf(args.bracket);
  if (!bracket) return fail('unknown_bracket', { brackets: PATCH_BRACKETS });
  const limit = Math.min(MAX_MOVERS, Math.max(1, Math.round(Number(args.limit)) || 10));
  const { total, list } = movers(bracket, by, direction, limit);
  return {
    ref: `movers:${by}:${direction}:${bracket}`,
    patch: PATCH.version, by, direction, bracket, bracket_name: BRACKET_NAME[bracket][lang], ...WINDOWS,
    // How many heroes the rule calls a move this way in this bracket; the list is the largest of them.
    heroes_total: total,
    heroes: list.map((m) => ({ ...heroRow(m, lang), games_after: m.games_after, changed_in_the_notes: (heroNotes(m.slug) ?? []).length > 0 })),
    rule: RULE, numbers_source: META_SOURCE.source, note: META_NOTE, gaps: META_GAPS,
  };
}

export function itemPatch(args = {}, ctx = {}) {
  const lang = L(ctx);
  const item = findNotedItem(args.item);
  if (!item) return fail('item_not_in_the_patch_notes', { detail: 'Only items the notes of this patch mention can be looked up; search_notes finds lines by their words.' });
  return {
    ref: `item_patch:${item.key}`,
    item: item.key, name: item.name[lang], patch: PATCH.version,
    ...(item.tag ? { label: item.tag[lang] } : {}), ...(item.neutral ? { neutral_item: true } : {}),
    notes: item.lines.map((x) => x[lang]), notes_source: PATCH.notes_source,
    gaps: [{ topic: 'item_win_rates_and_purchase_rates', reason: 'not_in_data' }],
  };
}

export function generalChanges(args = {}, ctx = {}) {
  const lang = L(ctx);
  const q = typeof args.section === 'string' ? args.section.trim().toLowerCase() : '';
  const all = generalNotes();
  const picked = q ? all.filter((g) => g.title.en.toLowerCase().includes(q) || g.title.zh.includes(args.section.trim())) : all;
  if (!picked.length) return fail('unknown_section', { sections: all.map((g) => g.title[lang]) });
  return {
    ref: 'general_changes', patch: PATCH.version,
    // A line with `heading` opens a group inside its section; the others are changes, quoted.
    sections: picked.map((g) => ({ section: g.title[lang], lines: g.lines.map((x) => (x.sub ? { heading: x[lang] } : x[lang])) })),
    notes_source: PATCH.notes_source,
  };
}

/** Every line of the notes with where it stands, for searching. Built once. */
let INDEX = null;
function index() {
  if (INDEX) return INDEX;
  const out = [];
  for (const g of generalNotes()) for (const x of g.lines) if (!x.sub) out.push({ in: 'general', where: g.title, line: x });
  for (const slug of notedHeroes()) for (const p of heroNotes(slug)) for (const x of p.lines) out.push({ in: 'hero', hero: slug, ...(p.name ? { ability: p.name } : {}), line: x });
  for (const i of notedItems()) for (const x of i.lines) out.push({ in: i.neutral ? 'neutral_item' : 'item', item: i.key, where: i.name, line: x });
  for (const c of creepNotes()) for (const x of c.lines) out.push({ in: 'neutral_creep', where: c.name, line: x });
  INDEX = out;
  return out;
}

export function searchNotes(args = {}, ctx = {}) {
  const lang = L(ctx);
  const raw = typeof args.query === 'string' ? args.query.trim() : '';
  if (raw.length < 2) return fail('query_too_short');
  // Every word must be in the line, in either language: the notes are searched as Valve wrote them.
  const words = raw.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  const scope = ['general', 'hero', 'item', 'neutral_item', 'neutral_creep'].includes(args.in) ? args.in : null;
  const hits = index().filter((r) => (!scope || r.in === scope) && words.every((w) => r.line.en.toLowerCase().includes(w) || r.line.zh.toLowerCase().includes(w)));
  return {
    ref: 'search', patch: PATCH.version, query: raw, ...(scope ? { in: scope } : {}),
    lines_total: hits.length,
    lines: hits.slice(0, MAX_HITS).map((r) => ({
      in: r.in,
      ...(r.hero ? { hero: r.hero, name: BY_SLUG.get(r.hero)?.[lang] ?? r.hero } : {}),
      ...(r.ability ? { ability: r.ability[lang] } : {}),
      ...(r.item ? { item: r.item } : {}),
      ...(r.where ? { where: r.where[lang] } : {}),
      line: r.line[lang],
    })),
    ...(hits.length > MAX_HITS ? { truncated: `the first ${MAX_HITS} of ${hits.length}; narrow the query or set "in"` } : {}),
    notes_source: PATCH.notes_source,
  };
}

const HERO = { type: 'string', description: 'A hero: engine key ("antimage"), English or Chinese name.' };
const BRACKET = { type: 'string', enum: [...PATCH_BRACKETS], description: 'Rank bracket: all (default), hg Herald–Guardian, ca Crusader–Archon, la Legend–Ancient, di Divine–Immortal.' };

/** @type {{ name: string, description: string, input_schema: object, run: (args?: any, ctx?: any) => any }[]} */
export const PATCH_TOOLS = [
  {
    name: 'patch_overview',
    description: 'The current patch at a glance: version and date, how many heroes and items the notes change, the items Valve labels new or returning, the days the numbers cover, and the five heroes whose public win rate and pick rate rose and fell most since the patch. Start here for "what changed" or "who is strong now".',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    run: patchOverview,
  },
  {
    name: 'hero_patch',
    description: "One hero in this patch: Valve's notes for the hero, quoted line by line (stats, each ability, talents), next to the hero's public win rate and pick rate before and since the patch, in one bracket and across all of them. Look here before saying anything about a hero.",
    input_schema: { type: 'object', properties: { hero: HERO, bracket: BRACKET }, required: ['hero'], additionalProperties: false },
    run: heroPatch,
  },
  {
    name: 'meta_movers',
    description: 'The heroes whose public win rate or pick rate moved most since the patch, up or down, in one bracket: before and after, the change, and whether the notes change the hero at all. Up to 15.',
    input_schema: { type: 'object', properties: { by: { type: 'string', enum: ['win_rate', 'pick_rate'] }, direction: { type: 'string', enum: ['up', 'down'] }, bracket: BRACKET, limit: { type: 'integer', minimum: 1, maximum: MAX_MOVERS } }, additionalProperties: false },
    run: metaMovers,
  },
  {
    name: 'item_patch',
    description: "Valve's notes for one item in this patch, quoted: a new item's recipe and effects, or what changed on an existing one. Only items the notes mention. There are no win or purchase rates for items.",
    input_schema: { type: 'object', properties: { item: { type: 'string', description: 'An item: key ("skypiercer"), English or Chinese name.' } }, required: ['item'], additionalProperties: false },
    run: itemPatch,
  },
  {
    name: 'general_changes',
    description: "The patch's general changes, quoted: global mechanics (hero stats, gold and experience, damage rules), lane creeps, towers and bases, map objectives (Roshan, Tormentor), terrain. Without `section`, all of them.",
    input_schema: { type: 'object', properties: { section: { type: 'string', description: 'Part of a section title, e.g. "Map Objectives".' } }, additionalProperties: false },
    run: generalChanges,
  },
  {
    name: 'search_notes',
    description: 'Find lines of the patch notes by their words (every word must be in the line; English or Chinese): which heroes had a stun shortened, where "Spell Amplification" changed, every line that mentions Roshan. Returns the lines with the hero, ability or item they belong to. `in` narrows it to general, hero, item, neutral_item or neutral_creep.',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, in: { type: 'string', enum: ['general', 'hero', 'item', 'neutral_item', 'neutral_creep'] } }, required: ['query'], additionalProperties: false },
    run: searchNotes,
  },
];

/** Run a tool by name. Unknown names and thrown errors come back as `{ error }`, never an exception. */
export function runPatchTool(name, args = {}, ctx = {}) {
  const tool = PATCH_TOOLS.find((t) => t.name === name);
  if (!tool) return fail('unknown_tool', { tools: PATCH_TOOLS.map((t) => t.name) });
  try { return { tool: name, ...tool.run(args ?? {}, ctx) }; } catch { return fail('tool_failed', { tool: name }); }
}
