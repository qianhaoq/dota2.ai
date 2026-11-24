#!/usr/bin/env node
/**
 * Regenerates lib/coach/data/patch-notes.json: Valve's own notes for one
 * patch, in English and Simplified Chinese, line for line.
 *
 *   node scripts/coach-patch-notes.mjs 7.42
 *
 * Source: https://www.dota2.com/datafeed/patchnotes?version=<v>&language=…
 * (the data behind https://www.dota2.com/patches/<v>), with hero, ability and
 * item names from Valve's herolist / abilitylist / itemlist in the same two
 * languages. Nothing is paraphrased: a line is Valve's text with its markup
 * removed. The two languages come as two documents of the same shape; the
 * script stops without writing when they do not line up, so a Chinese line
 * can never be paired with another line's English.
 *
 * Shape:
 *   general: [{ title, lines }]            the patch's general sections
 *   heroes:  { <slug>: [{ about, lines }] }  about = hero | talent | ability | unit
 *                                            (an ability carries key + name;
 *                                            unit = a unit of the hero's, e.g. Spirit Bear)
 *   items:   { <key>: { name, lines, tag?, neutral? } }
 *   creeps:  [{ name, lines }]
 * A line is { en, zh } (+ sub: true for a sub-heading inside a section).
 * No key is needed.
 */
import { writeFileSync } from 'node:fs';

const version = process.argv[2];
if (!/^\d+\.\d+[a-z]?$/.test(version ?? '')) { console.error('usage: node scripts/coach-patch-notes.mjs <version, e.g. 7.42>'); process.exit(2); }
const OUT = new URL('../lib/coach/data/patch-notes.json', import.meta.url);
const LANGS = { en: 'english', zh: 'schinese' };

async function get(path) {
  const url = `https://www.dota2.com/datafeed/${path}`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch(url, { headers: { 'user-agent': 'dota2.ai data refresh' } });
    if (res.ok) return res.json();
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw new Error(`${path} failed`);
}
const both = async (path) => Object.fromEntries(await Promise.all(Object.entries(LANGS).map(async ([k, lang]) => [k, await get(`${path}${path.includes('?') ? '&' : '?'}language=${lang}`)])));

const notes = await both(`patchnotes?version=${version}`);
if (!notes.en?.success || notes.en.patch_number !== version) throw new Error(`Valve has no notes for ${version}`);
const heroList = (await both('herolist')).en.result.data.heroes;
const abilityLists = await both('abilitylist');
const itemLists = await both('itemlist');

const strip = (s) => String(s ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
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
  // `unit`, never guessed: with no ability to tell by, the run stops.
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

const count = (parts) => parts.reduce((a, p) => a + p.lines.length, 0);
const out = {
  version,
  released: new Date(notes.en.patch_timestamp * 1000).toISOString(),
  source: `Valve patch notes, https://www.dota2.com/patches/${version}`,
  url: `https://www.dota2.com/patches/${version}`,
  fetched: new Date().toISOString().slice(0, 10),
  general, heroes, items, creeps,
};
writeFileSync(OUT, `${JSON.stringify(out)}\n`);
console.error(`wrote ${OUT.pathname}: ${general.reduce((a, g) => a + g.lines.length, 0)} general lines, ${Object.keys(heroes).length} heroes / ${Object.values(heroes).reduce((a, p) => a + count(p), 0)} lines, ${Object.keys(items).length} items, ${creeps.length} creeps`);
