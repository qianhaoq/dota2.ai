/**
 * Valve's patch notes as the patch advisor reads them, built from
 * www.dota2.com/datafeed: one release (7.42, 7.42a, …) at a time, then the
 * major patch and every letter update after it laid one on the other.
 * Used at runtime (lib/patch/liveNotes.js) and by scripts/coach-patch-notes.mjs
 * for the committed fallback snapshot.
 *
 * Nothing is paraphrased: a line is Valve's text with its markup removed. The
 * two languages come as two documents of the same shape; a release whose two
 * documents do not line up is refused, so a Chinese line can never be paired
 * with another line's English.
 *
 * One release:
 *   general: [{ title, lines }]            the release's general sections
 *   heroes:  { <slug>: [{ about, lines }] }  about = hero | talent | ability | unit
 *                                            (an ability carries key + name;
 *                                            unit = a unit of the hero's, e.g. Spirit Bear)
 *   items:   { <key>: { name, lines, tag?, neutral? } }
 *   creeps:  [{ name, lines }]
 * A line is { en, zh } (+ sub: true for a sub-heading inside a section).
 *
 * Merged (mergeReleases): the major's notes as they are, and each later
 * release's added after them with `patch: '<version>'` on the section, hero
 * part, creep, or (for items) as `updates: [{ patch, lines }]`.
 */

export const DATAFEED = 'https://www.dota2.com/datafeed';
const LANGS = { en: 'english', zh: 'schinese' };

export const majorOf = (name) => String(name ?? '').match(/^\d+\.\d+/)?.[0] ?? null;
const strip = (s) => String(s ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

/**
 * @param {{ version: string, notes: { en: any, zh: any }, heroList: any[], abilityLists: { en: any, zh: any }, itemLists: { en: any, zh: any } }} o
 */
export function buildReleaseNotes({ version, notes, heroList, abilityLists, itemLists }) {
  if (!notes.en?.success || notes.en.patch_number !== version) throw new Error(`Valve has no notes for ${version}`);
  const byId = (lists) => { const m = new Map(); for (const [lang, d] of Object.entries(lists)) for (const a of d.result.data.itemabilities) m.set(a.id, { ...(m.get(a.id) ?? { key: a.name }), [lang]: strip(a.name_loc) || strip(a.name_english_loc) }); return m; };
  const ABILITY = byId(abilityLists); const ITEM = byId(itemLists);
  const HERO = new Map(heroList.map((h) => [h.id, h.name.replace(/^npc_dota_hero_/, '')]));

  /** The same list in both languages, zipped; throws when they are not the same list. */
  function zip(en, zh, what) {
    const a = en ?? []; const b = zh ?? [];
    if (a.length !== b.length) throw new Error(`${what}: ${a.length} English entries, ${b.length} Chinese`);
    return a.map((x, i) => [x, b[i]]);
  }
  const line = ([e, z], what) => {
    if ((e.indent_level ?? 0) !== (z.indent_level ?? 0)) throw new Error(`${what}: the two languages differ in structure`);
    const out = { en: strip(e.note), zh: strip(z.note) };
    // A spacer between groups is empty in both languages and is left out; empty in one only is a mismatch.
    if (!out.en && !out.zh) return null;
    if (!out.en || !out.zh) throw new Error(`${what}: a line that is empty in one language only`);
    // A sub-heading inside a section ("Hero Stats"), not a change.
    if (/class="Subtitle"/.test(e.note)) out.sub = true;
    return out;
  };
  const lines = (en, zh, what) => zip(en, zh, what).map((p) => line(p, what)).filter(Boolean);
  const name = (m, id, what) => { const n = m.get(id); if (!n?.en || !n?.zh || !n.key) throw new Error(`${what}: no name for id ${id}`); return n; };

  const general = zip(notes.en.general_notes, notes.zh.general_notes, 'general notes').map(([e, z]) => ({ title: { en: strip(e.title), zh: strip(z.title) }, lines: lines(e.generic, z.generic, `general "${e.title}"`) }));

  const heroes = {};
  for (const [e, z] of zip(notes.en.heroes, notes.zh.heroes, 'heroes')) {
    if (e.hero_id !== z.hero_id) throw new Error('heroes: the two languages list different heroes');
    // An entry that is not a hero is a unit of one (Lone Druid's Spirit Bear). Valve's data does not name it or
    // say whose it is; its abilities do, by their key ("lone_druid_spirit_bear_…"). Filed under that hero as
    // `unit`, never guessed: with no ability to tell by, the release is refused.
    let slug = HERO.get(e.hero_id);
    const unit = !slug;
    if (unit) {
      const keys = (e.abilities ?? []).map((a) => ABILITY.get(a.ability_id)?.key).filter(Boolean);
      const owners = [...HERO.values()].filter((h) => keys.length && keys.every((k) => k.startsWith(`${h}_`))).sort((a, b) => b.length - a.length);
      if (!owners.length) throw new Error(`heroes: entry ${e.hero_id} is not a hero and its abilities do not say whose unit it is`);
      slug = owners[0];
    }
    const parts = heroes[slug] ?? [];
    const own = lines(e.hero_notes, z.hero_notes, `${slug} hero notes`);
    if (own.length) parts.push({ about: unit ? 'unit' : 'hero', lines: own });
    for (const [ae, az] of zip(e.abilities, z.abilities, `${slug} abilities`)) {
      if (ae.ability_id !== az.ability_id) throw new Error(`${slug}: the two languages list different abilities`);
      const n = name(ABILITY, ae.ability_id, `${slug} ability`);
      parts.push({ about: 'ability', key: n.key, name: { en: n.en, zh: n.zh }, ...(unit ? { unit: true } : {}), lines: lines(ae.ability_notes, az.ability_notes, `${slug} ${n.key}`) });
    }
    const talents = lines(e.talent_notes, z.talent_notes, `${slug} talents`);
    if (talents.length) parts.push({ about: 'talent', lines: talents });
    if (parts.length) heroes[slug] = parts;
  }

  const items = {};
  for (const [kind, neutral] of [['items', false], ['neutral_items', true]]) {
    for (const [e, z] of zip(notes.en[kind], notes.zh[kind], kind)) {
      // A heading between groups of items ("Basic Items"), not an item.
      if (e.is_general_note || e.ability_id < 0) continue;
      if (e.ability_id !== z.ability_id) throw new Error(`${kind}: the two languages list different items`);
      const n = name(ITEM, e.ability_id, kind);
      const key = n.key.replace(/^item_/, '');
      const ls = lines(e.ability_notes, z.ability_notes, `${kind} ${key}`);
      if (!ls.length) continue;
      if (items[key]) { items[key].lines.push(...ls); continue; }
      // Valve's own label on the entry ("New Item", "Returning Item"), when it has one.
      const tag = strip(e.title) && strip(z.title) ? { tag: { en: strip(e.title), zh: strip(z.title) } } : {};
      items[key] = { name: { en: n.en, zh: n.zh }, ...tag, ...(neutral ? { neutral: true } : {}), lines: ls };
    }
  }

  const creeps = zip(notes.en.neutral_creeps, notes.zh.neutral_creeps, 'neutral creeps')
    .filter(([e]) => !e.is_general_note && (e.neutral_creep_notes ?? []).length)
    .map(([e, z]) => ({ name: { en: strip(e.localized_name), zh: strip(z.localized_name) }, lines: lines(e.neutral_creep_notes, z.neutral_creep_notes, `creep ${e.name}`) }));

  return {
    version,
    released: new Date(notes.en.patch_timestamp * 1000).toISOString(),
    source: `Valve patch notes, https://www.dota2.com/patches/${version}`,
    url: `https://www.dota2.com/patches/${version}`,
    general, heroes, items, creeps,
  };
}

/**
 * The major patch and its letter updates, as one: the newest release names it.
 * @param {ReturnType<typeof buildReleaseNotes>[]} releases  major first, then each update in order
 * @param {string} fetched  YYYY-MM-DD
 */
export function mergeReleases(releases, fetched) {
  const [major, ...updates] = releases;
  const latest = releases.at(-1);
  const heroes = Object.fromEntries(Object.entries(major.heroes).map(([k, v]) => [k, [...v]]));
  const items = Object.fromEntries(Object.entries(major.items).map(([k, v]) => [k, { ...v }]));
  const general = [...major.general];
  const creeps = [...major.creeps];
  for (const u of updates) {
    const patch = u.version;
    general.push(...u.general.filter((g) => g.lines.length).map((g) => ({ ...g, patch })));
    for (const [slug, parts] of Object.entries(u.heroes)) heroes[slug] = [...(heroes[slug] ?? []), ...parts.map((p) => ({ ...p, patch }))];
    for (const [key, it] of Object.entries(u.items)) {
      const was = items[key] ?? { name: it.name, ...(it.neutral ? { neutral: true } : {}), lines: [] };
      items[key] = { ...was, updates: [...(was.updates ?? []), { patch, lines: it.lines }] };
    }
    creeps.push(...u.creeps.map((c) => ({ ...c, patch })));
  }
  return {
    version: latest.version,
    major: major.version,
    released: major.released,
    url: latest.url,
    releases: releases.map((r) => ({ version: r.version, released: r.released, url: r.url })),
    source: `Valve patch notes, ${releases.map((r) => r.url).join(', ')}`,
    fetched,
    general, heroes, items, creeps,
  };
}

/** Both languages of a datafeed path. */
export async function fetchBoth(fetchJson, path) {
  const sep = path.includes('?') ? '&' : '?';
  const [en, zh] = await Promise.all([fetchJson(`${DATAFEED}/${path}${sep}language=${LANGS.en}`), fetchJson(`${DATAFEED}/${path}${sep}language=${LANGS.zh}`)]);
  return { en, zh };
}

/** The releases of the newest major patch, from Valve's patch list: ['7.42', '7.42a', …]. */
export function currentReleases(list) {
  const names = (list ?? []).map((p) => p?.patch_name).filter((n) => typeof n === 'string');
  const major = majorOf(names.at(-1));
  const from = names.indexOf(major);
  return major && from >= 0 ? names.slice(from) : [];
}
