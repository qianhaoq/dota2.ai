#!/usr/bin/env node
/**
 * Writes lib/data/constants/patches/<patch>.json for each finished patch from
 * --from (default 7.40) up to the one before the current patch: the item and
 * hero-ability data as it stood at the end of that patch, so a game played
 * then is told its own prices, recipes, item effects and cooldowns.
 *
 *   node scripts/coach-patch-snapshots.mjs [--from 7.40]
 *
 * Source: OpenDota's constants repository (github.com/odota/dotaconstants),
 * built from Valve's game files. For each file the last commit before the next
 * patch was released is taken; that is the patch's final letter release
 * (7.41f for 7.41). A game's patch is known only as OpenDota's patch number,
 * which does not tell the letter releases apart.
 *
 * Kept, per item: name, cost, recipe (components), the numeric stats, and the
 * active/passive text. Per hero: the ability list and, per ability, its name,
 * damage type, whether it goes through spell immunity, how it is dispelled
 * and its cooldowns. Nothing else (lore, images, talents) is kept.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const RAW = 'https://raw.githubusercontent.com/odota/dotaconstants';
const API = 'https://api.github.com/repos/odota/dotaconstants/commits';
const OUT = new URL('../lib/data/constants/patches/', import.meta.url);
const CURRENT = JSON.parse(readFileSync(new URL('../lib/coach/data/abilities.json', import.meta.url))).patch;
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const FROM = arg('from', '7.40');

const get = async (url, as = 'json') => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch(url, { headers: { 'user-agent': 'dota2.ai patch snapshots', ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } });
    if (res.ok) return as === 'json' ? res.json() : res.text();
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw new Error(`${url} failed`);
};
/** The last commit that changed `path` before `until` (ISO date), with its date. */
async function lastCommit(path, until) {
  const [c] = await get(`${API}?path=${encodeURIComponent(path)}&until=${encodeURIComponent(until)}&per_page=1`);
  if (!c) throw new Error(`no commit of ${path} before ${until}`);
  return { sha: c.sha, date: c.commit.committer.date };
}
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const nums = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\s+/) : v == null ? [] : [v]).map(num).filter((n) => n != null);

function pruneItems(all) {
  const out = {};
  for (const [key, it] of Object.entries(all)) {
    if (!it || typeof it !== 'object' || !Number.isFinite(it.cost)) continue;
    const attrib = (it.attrib ?? []).map((a) => ({ key: a?.key, value: a?.value })).filter((a) => typeof a.key === 'string' && num(a.value) != null);
    const abilities = (it.abilities ?? []).filter((a) => a?.title && a?.description).map((a) => ({ type: a.type, title: a.title, description: a.description }));
    out[key] = { dname: it.dname ?? key, cost: it.cost, components: Array.isArray(it.components) && it.components.length ? it.components : null, ...(attrib.length ? { attrib } : {}), ...(abilities.length ? { abilities } : {}) };
  }
  return out;
}
const DMG = { Physical: 'P', Magical: 'M', Pure: 'U' };
const PIERCE = { Yes: true, No: false };
const DISPEL = { 'Strong Dispels Only': 'strong', Yes: 'basic', No: 'no' };
function pruneHeroes(heroAbilities, abilities) {
  const heroes = {};
  for (const [npc, h] of Object.entries(heroAbilities)) {
    const list = (h?.abilities ?? []).filter((k) => typeof k === 'string' && k !== 'generic_hidden' && !k.includes('_empty') && abilities[k]?.dname);
    heroes[npc] = list.map((k) => {
      const a = abilities[k];
      const cd = nums(a.cd);
      return { id: k, en: a.dname, ...(DMG[a.dmg_type] ? { dmg: DMG[a.dmg_type] } : {}), ...(a.bkbpierce in PIERCE ? { pierces: PIERCE[a.bkbpierce] } : {}), ...(DISPEL[a.dispellable] ? { dispel: DISPEL[a.dispellable] } : {}), ...(cd.length ? { cd } : {}) };
    });
  }
  return heroes;
}

const patches = (await get(`${RAW}/master/build/patch.json`)).map((p) => ({ name: p.name, id: p.id, date: p.date })).sort((a, b) => a.id - b.id);
const from = patches.find((p) => p.name === FROM);
const current = patches.find((p) => p.name === CURRENT);
if (!from || !current) throw new Error(`unknown patch ${!from ? FROM : CURRENT}`);
mkdirSync(OUT, { recursive: true });
for (const p of patches.filter((x) => x.id >= from.id && x.id < current.id)) {
  const next = patches.find((x) => x.id > p.id);
  const files = {};
  for (const f of ['items', 'abilities', 'hero_abilities']) {
    const c = await lastCommit(`build/${f}.json`, next.date);
    // A file last rebuilt before this patch came out is the previous patch's: not this one's data.
    if (Date.parse(c.date) < Date.parse(p.date)) throw new Error(`${f}.json was not rebuilt during ${p.name} (last ${c.date})`);
    files[f] = { ...c, data: await get(`${RAW}/${c.sha}/build/${f}.json`) };
  }
  const snapshot = {
    patch: p.name, patch_id: p.id, released: p.date.slice(0, 10), next_patch: next.name,
    source: 'OpenDota constants (github.com/odota/dotaconstants), the last build before the next patch',
    commits: Object.fromEntries(Object.entries(files).map(([f, c]) => [f, { sha: c.sha.slice(0, 12), date: c.date.slice(0, 10) }])),
    items: pruneItems(files.items.data),
    heroes: pruneHeroes(files.hero_abilities.data, files.abilities.data),
  };
  writeFileSync(new URL(`${p.name}.json`, OUT), `${JSON.stringify(snapshot)}\n`);
  console.log(`${p.name}: ${Object.keys(snapshot.items).length} items, ${Object.keys(snapshot.heroes).length} heroes (${Object.entries(snapshot.commits).map(([f, c]) => `${f} ${c.sha} ${c.date}`).join(', ')})`);
}
