#!/usr/bin/env node
/**
 * Writes lib/data/constants/patches/<release>.json for every release from
 * 7.40 up to the one before the current — letter releases included (7.41,
 * 7.41a … 7.41f) — and the release list in lib/data/constants/patches/index.json.
 * A game is then told the prices, recipes, item effects and cooldowns of the
 * release it was played on.
 *
 *   git clone https://github.com/odota/dotaconstants <dir>
 *   (cd <dir> && git checkout 0b0b4a6867a8 && npm ci --ignore-scripts)
 *   (the checkout must hold history: the builder as of e7705ee975eb reads game files from before Valve split npc_heroes.txt into #base includes in September 2026)
 *   node scripts/coach-patch-snapshots.mjs --builder <dir>
 *
 * Sources:
 * - Releases and their dates: Valve's patch notes list (dota2.com datafeed).
 * - Game files: github.com/dotabuff/d2vpkr, one commit per game update. A
 *   release's rollout is the first update at or after Valve's date; its data is
 *   that update's. Every later update before the next release whose item or
 *   ability data differs is a hotfix with a snapshot of its own
 *   (<release>.<date>T<hhmm>.json, listed under the release's `hotfixes`), so
 *   a game is told the numbers of the hotfix it was played on. The update's commit time is the rollout time: the
 *   repository is polled every twenty minutes, so the rollout lies in the
 *   twenty minutes before it.
 * - Turning game files into item and ability data: OpenDota's own builder
 *   (github.com/odota/dotaconstants, tasks/updateconstants.ts), run against that
 *   commit instead of the latest. A copy is written next to it with three
 *   changes, each checked to apply: the game-file commit comes from the
 *   environment, only items / abilities / hero_abilities are built, the
 *   neutral-items reader accepts the older file layout, and a facet naming an
 *   ability its hero's file lacks is skipped instead of stopping the build. The copies are compiled
 *   from TypeScript to JavaScript with esbuild (the builder is TypeScript that
 *   only a Node of 22.6 or later runs as is; the site supports Node 20). Game files from before
 *   Valve split npc_heroes.txt into #base includes (September 2026) are read
 *   by the builder as of e7705ee975eb, the last one written for them.
 *
 * Kept per item: name, cost, recipe, numeric stats, active/passive text, hints and notes. Per
 * hero: the ability list (including Aghanim's Scepter and Shard granted abilities) and, per ability,
 * its name, damage type, whether it goes through spell immunity, how it is dispelled and its cooldowns.
 * The newest release is written too, from the latest game update: no release's
 * data is the site's live tables, which a refresh may not have brought to it.
 * Match ids on either side of each rollout are added by scripts/patch-match-ids.mjs.
 */
import { execFileSync } from 'node:child_process';
import { transformSync } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const BUILDER = arg('builder');
if (!BUILDER || !existsSync(join(BUILDER, 'tasks/updateconstants.ts'))) { console.error('usage: node scripts/coach-patch-snapshots.mjs --builder <dotaconstants checkout>'); process.exit(2); }
const FIRST = arg('from', '7.40');
const OUT = new URL('../lib/data/constants/patches/', import.meta.url);
const INDEX = new URL('index.json', OUT);
const CURRENT_MAJOR = JSON.parse(readFileSync(new URL('../lib/coach/data/abilities.json', import.meta.url))).patch;
/** OpenDota's patch numbers, which name majors only. */
const MAJOR_IDS = { '7.39': 58, '7.40': 59, '7.41': 60, '7.42': 61, '7.43': 62 };
const POLL_MINUTES = 20;

const get = async (url) => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch(url, { headers: { 'user-agent': 'dota2.ai patch snapshots', ...(process.env.GITHUB_TOKEN && url.includes('api.github.com') ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } });
    if (res.ok) return res.json();
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw new Error(`${url} failed`);
};
const version = (name) => { const m = /^(\d+)\.(\d+)([a-z]?)$/.exec(name); return m ? [Number(m[1]), Number(m[2]), m[3] ? m[3].charCodeAt(0) - 96 : 0] : null; };
const before = (a, b) => { for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i]; return false; };
const majorOf = (name) => name.replace(/[a-z]$/, '');

// 1. Releases from Valve, from FIRST on.
const valve = (await get('https://www.dota2.com/datafeed/patchnoteslist?language=english')).patches
  .map((p) => ({ name: p.patch_name, date: p.patch_timestamp * 1000 })).filter((p) => version(p.name) && !before(version(p.name), version(FIRST)))
  .sort((a, b) => a.date - b.date);
if (!valve.some((p) => majorOf(p.name) === CURRENT_MAJOR)) throw new Error(`Valve's list has no ${CURRENT_MAJOR}`);

// 2. Every update of the game scripts since a week before the first release.
const commits = [];
for (let page = 1; page < 20; page += 1) {
  const batch = await get(`https://api.github.com/repos/dotabuff/d2vpkr/commits?path=dota/scripts/npc&since=${new Date(valve[0].date - 7 * 86400_000).toISOString()}&per_page=100&page=${page}`);
  commits.push(...batch.map((c) => ({ sha: c.sha, at: Date.parse(c.commit.committer.date), build: c.commit.message.split('\n')[0] })));
  if (batch.length < 100) break;
}
commits.sort((a, b) => a.at - b.at);
const releases = valve.map((p) => {
  const rollout = commits.find((c) => c.at >= p.date);
  if (!rollout) throw new Error(`no game update after ${p.name}`);
  return { ...p, rollout };
});
for (let i = 1; i < releases.length; i += 1) if (releases[i].rollout.sha === releases[i - 1].rollout.sha) throw new Error(`${releases[i - 1].name} and ${releases[i].name} map to the same update`);

// 3. The builder copies, with their changes: the current builder, and the one written for the older npc_heroes.txt.
const OLD_BUILDER = 'e7705ee975eb';
function patchBuilder(source, name) {
const swaps = [
  [/"https:\/\/raw\.githubusercontent\.com\/dotabuff\/d2vpkr\/master\/([^"\n]*)"/g, '`https://raw.githubusercontent.com/dotabuff/d2vpkr/${process.env.D2VPKR_REF}/$1`'],
  ['  for (let i = 0; i < sources.length; i++) {\n    const s = sources[i];', "  const only = (process.env.ONLY_KEYS ?? '').split(',').filter(Boolean);\n  for (let i = 0; i < sources.length; i++) {\n    const s = sources[i];\n    if (only.length && !only.includes(s.key)) continue;"],
  ['  // Copy manual json files to build', '  if (only.length) return;\n  // Copy manual json files to build'],
  // A facet that names an ability missing from its hero's script file (two 7.41 updates of March 2026) stopped the
  // whole build; it only feeds the facet's description, which no snapshot keeps.
  ['function getSpecialAttrs(entity: any) {\n', 'function getSpecialAttrs(entity: any) {\n  if (!entity) return null;\n'],
];
let patched = source;
for (const [from, to] of swaps) { const next = patched.replace(from, to); if (next === patched) throw new Error(`builder ${name} changed: ${String(from).slice(0, 60)} not found`); patched = next; }
const neutral = /const getNeutralItemNameTierMap = \(neutrals\) => \{[\s\S]*?\n\};/;
if (!neutral.test(patched)) throw new Error(`builder ${name} changed: getNeutralItemNameTierMap not found`);
patched = patched.replace(neutral, `const getNeutralItemNameTierMap = (neutrals) => {
  const ret = {};
  Object.keys(neutrals.neutral_tiers).forEach((tier) => {
    const t = neutrals.neutral_tiers[tier];
    const names = t.items ? Object.keys(t.items) : Object.values(t.item_pools ?? {}).flatMap((p: any) => Object.keys(p ?? {}));
    names.forEach((n) => { ret[n] = ret[n.replace(/recipe_/gi, "")] = parseInt(tier); });
  });
  return ret;
};`);
return patched;
}
const git = (...a) => execFileSync('git', a, { cwd: BUILDER }).toString();
/** TypeScript to an ES module any supported Node runs; its import of util.ts pointed at the compiled `util`. */
const compile = (ts, util) => {
  const js = transformSync(ts, { loader: 'ts', format: 'esm', target: 'node20' }).code;
  if (util && !js.includes('"./util.ts"')) throw new Error('builder changed: its import of ./util.ts not found');
  return util ? js.replace('"./util.ts"', `"./${util}"`) : js;
};
const BUILT = { current: 'tasks/updateconstants.dota2ai.mjs', old: 'tasks/updateconstants.dota2ai-old.mjs' };
writeFileSync(join(BUILDER, 'tasks/util.dota2ai.mjs'), compile(readFileSync(join(BUILDER, 'tasks/util.ts'), 'utf8')));
writeFileSync(join(BUILDER, BUILT.current), compile(patchBuilder(readFileSync(join(BUILDER, 'tasks/updateconstants.ts'), 'utf8'), 'current'), 'util.dota2ai.mjs'));
// The older builder has its own util.ts.
writeFileSync(join(BUILDER, 'tasks/util.dota2ai-old.mjs'), compile(git('show', `${OLD_BUILDER}:tasks/util.ts`)));
writeFileSync(join(BUILDER, BUILT.old), compile(patchBuilder(git('show', `${OLD_BUILDER}:tasks/updateconstants.ts`), OLD_BUILDER), 'util.dota2ai-old.mjs'));
const splitHeroes = async (sha) => {
  const res = await fetch(`https://raw.githubusercontent.com/dotabuff/d2vpkr/${sha}/dota/scripts/npc/npc_heroes.txt`);
  if (!res.ok) throw new Error(`npc_heroes.txt at ${sha} failed`);
  return (await res.text()).includes('#base');
};

// 4. Each release but the current one: the last update before the next release rolled out.
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const nums = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\s+/) : v == null ? [] : [v]).map(num).filter((n) => n != null);
function pruneItems(all) {
  const out = {};
  for (const [key, it] of Object.entries(all)) {
    if (!it || typeof it !== 'object' || !Number.isFinite(it.cost)) continue;
    const attrib = (it.attrib ?? []).map((a) => ({ key: a?.key, value: a?.value })).filter((a) => typeof a.key === 'string' && num(a.value) != null);
    const abilities = (it.abilities ?? []).filter((a) => a?.title && a?.description).map((a) => ({ type: a.type, title: a.title, description: a.description }));
    // Valve's hints and notes too: the tools read an item's whole text ("Armor reduction works on buildings." is a note).
    const hint = (Array.isArray(it.hint) ? it.hint : []).filter((h) => typeof h === 'string' && h.trim());
    out[key] = { dname: it.dname ?? key, cost: it.cost, components: Array.isArray(it.components) && it.components.length ? it.components : null, ...(attrib.length ? { attrib } : {}), ...(abilities.length ? { abilities } : {}), ...(hint.length ? { hint } : {}), ...(typeof it.notes === 'string' && it.notes.trim() ? { notes: it.notes } : {}),
      // Built from a recipe: Dagon 2–5 are, with no component list (an upgrade of the item itself).
      ...(it.created === true ? { created: true } : {}) };
  }
  return out;
}
// The abilities the site's hero table lists outside the numbered slots (Ringmaster's wheel: Funhouse Mirror,
// Strongman Tonic …, plus any Scepter/Shard granted abilities absent from numbered slots) are added wherever
// the release's data has them.
const SITE_ABILITIES = JSON.parse(readFileSync(new URL('../lib/coach/data/abilities.json', import.meta.url))).heroes;
const { STATIC_HEROES } = await import('../packages/review-engine/src/staticHeroes.js');
const SITE_BY_NPC = Object.fromEntries(Object.values(STATIC_HEROES).map((h) => [h.internalName, (SITE_ABILITIES[String(h.id)] ?? []).map((a) => a.id)]));
const DMG = { Physical: 'P', Magical: 'M', Pure: 'U' };
const PIERCE = { Yes: true, No: false };
const DISPEL = { 'Strong Dispels Only': 'strong', Yes: 'basic', No: 'no' };
function pruneHeroes(heroAbilities, abilities) {
  const heroes = {};
  for (const [npc, h] of Object.entries(heroAbilities)) {
    const slots = (h?.abilities ?? []).filter((k) => typeof k === 'string' && k !== 'generic_hidden' && !k.includes('_empty') && abilities[k]?.dname);
    const list = [...slots, ...(SITE_BY_NPC[npc] ?? []).filter((k) => !slots.includes(k) && abilities[k]?.dname)];
    heroes[npc] = list.map((k) => {
      const a = abilities[k]; const cd = nums(a.cd);
      return { id: k, en: a.dname, ...(DMG[a.dmg_type] ? { dmg: DMG[a.dmg_type] } : {}), ...(a.bkbpierce in PIERCE ? { pierces: PIERCE[a.bkbpierce] } : {}), ...(DISPEL[a.dispellable] ? { dispel: DISPEL[a.dispellable] } : {}), ...(cd.length ? { cd } : {}) };
    });
  }
  return heroes;
}
mkdirSync(OUT, { recursive: true });
const iso = (t) => new Date(t).toISOString();
const old = existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, 'utf8')) : { releases: [] };
const index = [];
/** The item and ability data of one game update, as the builder reads its game files. */
async function build(c) {
  const split = await splitHeroes(c.sha);
  execFileSync(process.execPath, [split ? BUILT.current : BUILT.old], { cwd: BUILDER, env: { ...process.env, D2VPKR_REF: c.sha, ONLY_KEYS: 'items,abilities,hero_abilities' }, stdio: ['ignore', 'ignore', 'pipe'] });
  const read = (f) => JSON.parse(readFileSync(join(BUILDER, 'build', `${f}.json`), 'utf8'));
  return { built_with: `odota/dotaconstants tasks/updateconstants.ts at ${split ? git('rev-parse', '--short=12', 'HEAD').trim() : OLD_BUILDER}`, items: pruneItems(read('items')), heroes: pruneHeroes(read('hero_abilities'), read('abilities')) };
}
/** "2026-10-07T00:40" as a file-name part: 2026-10-07T0040. */
const stamp = (t) => iso(t).slice(0, 16).replace(':', '');
for (const [i, r] of releases.entries()) {
  const next = releases[i + 1];
  const entry = {
    name: r.name, major: majorOf(r.name), major_id: MAJOR_IDS[majorOf(r.name)] ?? null,
    rollout_by: iso(r.rollout.at), rollout_from: iso(r.rollout.at - POLL_MINUTES * 60_000), rollout_update: `${r.rollout.build} (${r.rollout.sha.slice(0, 12)})`,
  };
  // Every game update of this release, from its rollout to the last before the next release (to the latest for the
  // newest): a hotfix between letters changes prices and numbers too. An update whose item and ability data is the
  // same as the one before (a cosmetic or unit change) is not a step of its own.
  const updates = commits.filter((c) => c.at >= r.rollout.at && (!next || c.at < next.rollout.at));
  const steps = [];
  let last = null;
  for (const c of updates) {
    let data;
    try { data = await build(c); } catch (e) {
      // OpenDota's builder cannot read every intermediate update's files: such an update is a step whose data is not
      // known, so games played on it are told so rather than given the update before.
      console.warn(`${r.name}: update ${c.sha.slice(0, 12)} (${iso(c.at)}) could not be built: ${String(e.stderr ?? e.message).split('\n').find((l) => /Error/.test(l)) ?? ''}`);
      if (steps.length === 0) throw e;
      if (last !== null) { steps.push({ c, data: null }); last = null; }
      continue;
    }
    const same = JSON.stringify({ items: data.items, heroes: data.heroes });
    if (same === last) continue;
    last = same;
    steps.push({ c, data });
  }
  const hotfixes = [];
  // Match ids found earlier for the same hotfix are kept (an unread one too: its ids are still where it rolled out).
  const keptIds = (h) => {
    const kept = old.releases?.find((x) => x.name === r.name)?.hotfixes?.find((x) => x.rollout_by === h.rollout_by);
    return kept?.first_match_id_after ? { ...h, last_match_id_before: kept.last_match_id_before, first_match_id_after: kept.first_match_id_after } : h;
  };
  for (const [n, { c, data }] of steps.entries()) {
    if (!data) {
      hotfixes.push(keptIds({ update: `${c.build} (${c.sha.slice(0, 12)})`, rollout_by: iso(c.at), rollout_from: iso(c.at - POLL_MINUTES * 60_000), data: null, reason: 'game_files_not_read_by_the_builder' }));
      continue;
    }
    const file = n === 0 ? `${r.name}.json` : `${r.name}.${stamp(c.at)}.json`;
    const later = steps[n + 1]?.c ?? next?.rollout;
    const snapshot = {
      release: r.name, major: entry.major, major_id: entry.major_id,
      ...(n ? { hotfix: iso(c.at) } : {}),
      game_files: `dotabuff/d2vpkr ${c.sha.slice(0, 12)} (${c.build}, ${iso(c.at).slice(0, 10)}): ${n ? 'a hotfix' : 'the release\'s rollout'}, in force until ${later ? `${later === next?.rollout ? next.name : 'the next hotfix'} (${iso(later.at).slice(0, 10)})` : 'a later game update'}`,
      // When it was built: the weekly refresh leaves a file whose only change is this date as it was.
      fetched: iso(Date.now()).slice(0, 10),
      built_with: data.built_with, items: data.items, heroes: data.heroes,
    };
    writeFileSync(new URL(file, OUT), `${JSON.stringify(snapshot)}\n`);
    if (n === 0) entry.data = file;
    else {
      hotfixes.push(keptIds({ update: `${c.build} (${c.sha.slice(0, 12)})`, rollout_by: iso(c.at), rollout_from: iso(c.at - POLL_MINUTES * 60_000), data: file }));
    }
  }
  if (hotfixes.length) entry.hotfixes = hotfixes;
  console.log(`${r.name}: rolled out by ${iso(r.rollout.at)}; ${updates.length} game updates, ${steps.length - 1} hotfixes with other data (${hotfixes.map((h) => h.rollout_by.slice(0, 16)).join(', ')})`);
  // Match ids found earlier for the same rollout are kept; a moved rollout needs scripts/patch-match-ids.mjs again.
  const kept = old.releases?.find((x) => x.name === r.name && x.rollout_by === entry.rollout_by);
  if (kept?.first_match_id_after) Object.assign(entry, { last_match_id_before: kept.last_match_id_before, first_match_id_after: kept.first_match_id_after });
  index.push(entry);
}
writeFileSync(INDEX, `${JSON.stringify({
  source: 'Releases: Valve patch notes. Rollout: the first game update at or after the release date in dotabuff/d2vpkr, which is polled every 20 minutes, so the rollout lies between rollout_from and rollout_by. Match ids on either side (scripts/patch-match-ids.mjs): from STRATZ start times. A game started before rollout_from is in the earlier release, one started at or after rollout_by in this one; in between is not told. hotfixes: the game updates within a release that changed item or ability data, each with its own data and rollout window, read the same way.',
  // Valve's list was read then: a release out since is not in it, and its games are placed in the last one here.
  releases_checked_at: iso(Date.now()),
  // The newest match the id search looked at (scripts/patch-match-ids.mjs), kept across rebuilds.
  ...(old.ids_checked_to ? { ids_checked_to: old.ids_checked_to } : {}),
  releases: index,
}, null, 2)}\n`);
