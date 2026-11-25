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
import { buildReleaseNotes } from '../lib/patch/valveNotes.js';

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

const built = buildReleaseNotes({
  version,
  notes: await both(`patchnotes?version=${version}`),
  heroList: (await both('herolist')).en.result.data.heroes,
  abilityLists: await both('abilitylist'),
  itemLists: await both('itemlist'),
});
const { general, heroes, items, creeps } = built;
const count = (parts) => parts.reduce((a, p) => a + p.lines.length, 0);
const out = { version, released: built.released, source: built.source, url: built.url, fetched: new Date().toISOString().slice(0, 10), general, heroes, items, creeps };
writeFileSync(OUT, `${JSON.stringify(out)}\n`);
console.error(`wrote ${OUT.pathname}: ${general.reduce((a, g) => a + g.lines.length, 0)} general lines, ${Object.keys(heroes).length} heroes / ${Object.values(heroes).reduce((a, p) => a + count(p), 0)} lines, ${Object.keys(items).length} items, ${creeps.length} creeps`);
