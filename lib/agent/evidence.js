/**
 * Evidence for the reader: the tool record behind a `ref`, recomputed from
 * the trace (never taken from the model), with display names for every hero,
 * item and ability key in it. This is what an evidence card shows, so the
 * reader checks a claim against the record itself.
 */
import { createRequire } from 'node:module';
import { STATIC_HEROES } from '../../packages/review-engine/src/staticHeroes.js';
import { runTraceTool } from '../../packages/review-engine/src/trace/index.js';
import { heroAbilities, proItemChoices } from './knowledgeTools.js';

const require = createRequire(import.meta.url);
const ABILITIES = require('../coach/data/abilities.json');
const ITEM_NAMES = require('../coach/data/names.json').items;

const HERO_BY_SLUG = new Map(Object.values(STATIC_HEROES).map((h) => [h.internalSlug, h]));
const ABILITY_BY_ID = new Map(Object.values(ABILITIES.heroes ?? {}).flat().map((a) => [a.id, a]));
const REF = /^[a-z_]+(?::[A-Za-z0-9_-]+){0,3}$/;

/** A tool answer cut down to what its summary ref covers: top-level values and one level of maps, no record lists. */
function summaryOf(result) {
  if (!result) return null;
  return Object.fromEntries(Object.entries(result).filter(([, v]) => !Array.isArray(v)));
}

/** The hero's ultimate key (Valve data), for "where was the ultimate when she went immune". */
export function ultimateOf(heroKey) {
  const id = HERO_BY_SLUG.get(heroKey)?.id;
  return id == null ? null : ABILITIES.ultimates?.[String(id)]?.key ?? null;
}

/** States and map actions the engine names itself: not any hero's ability, so not in the ability data. */
const GENERIC = {
  modifier_stunned: { en: 'Stunned', zh: '眩晕' },
  modifier_bashed: { en: 'Bashed', zh: '重击眩晕' },
  modifier_rooted: { en: 'Rooted', zh: '缠绕' },
  modifier_knockback: { en: 'Knocked back', zh: '击退' },
  modifier_black_king_bar_immune: { en: 'Black King Bar', zh: '黑皇杖' },
  ability_capture: { en: 'Capture', zh: '占领' },
  dota_fountain: { en: 'Fountain', zh: '泉水' },
};
const HERO_SLUGS = [...HERO_BY_SLUG.keys()].sort((a, b) => b.length - a.length);
/**
 * A readable form of an engine key the data has no name for (an ability of a
 * summoned unit, a hero's side modifier): the key itself without its
 * prefixes, in words. English in either language — a name is not made up.
 * Null when the key is not an ability or modifier key.
 */
export function tidyKey(key) {
  let s = key; let known = false;
  for (const p of ['modifier_', 'ability_', 'item_']) if (s.startsWith(p)) { s = s.slice(p.length); known = true; }
  const owner = HERO_SLUGS.find((h) => s.startsWith(`${h}_`));
  if (owner) { s = s.slice(owner.length + 1); known = true; }
  if (!known || !s) return null;
  return s.split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/** Display names for the engine keys found anywhere in `value`: { key: name }. A damage source ("ursa: attacks") is named by its unit. */
export function namesIn(value, lang) {
  const L = lang === 'zh' ? 'zh' : 'en';
  const out = {};
  const see = (s) => {
    if (out[s] !== undefined) return;
    const item = s.replace(/^item_/, '');
    const short = s.replace(/^modifier_/, '');
    if (HERO_BY_SLUG.has(s)) out[s] = L === 'zh' ? HERO_BY_SLUG.get(s).nameZh : HERO_BY_SLUG.get(s).nameEn;
    else if (ABILITY_BY_ID.has(s)) out[s] = ABILITY_BY_ID.get(s)[L] ?? ABILITY_BY_ID.get(s).en;
    else if (ABILITY_BY_ID.has(short)) out[s] = ABILITY_BY_ID.get(short)[L] ?? ABILITY_BY_ID.get(short).en;
    else if (ITEM_NAMES[item]) out[s] = ITEM_NAMES[item][L] ?? ITEM_NAMES[item].en;
    else if (GENERIC[s]) out[s] = GENERIC[s][L];
    else if (tidyKey(s)) out[s] = tidyKey(s);
  };
  const walk = (v) => {
    if (typeof v === 'string') { if (/^[a-z][a-z0-9_]{1,60}$/.test(v)) see(v); } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (/^[a-z][a-z0-9_]{1,60}$/.test(k) && typeof x === 'number') see(k); else if (typeof x === 'number' && /^[a-z][a-z0-9_]{1,60}: /.test(k)) see(k.slice(0, k.indexOf(':'))); walk(x); }
  };
  walk(value);
  return out;
}

/**
 * The record a ref points at, told from `hero`'s side, or null.
 * @param {any} trace
 * @param {string} ref
 * @param {{ hero: string, lang?: string, match?: any }} o
 * @returns {{ ref: string, kind: string, record: any, names: Record<string, string> } | null}
 */
export function resolveRef(trace, ref, { hero, lang = 'en', match = null }) {
  if (typeof ref !== 'string' || !REF.test(ref)) return null;
  const ctx = { match, perspective: hero, lang };
  const [kind, a, b, c] = ref.split(':');
  const run = (name, args) => { const r = runTraceTool(trace, name, args, ctx); return r?.error ? null : r; };
  let record = null;
  if (kind === 'overview' && a === undefined) record = run('match_overview', {});
  else if (kind === 'fight') record = run('match_overview', {})?.fights.find((f) => f.ref === ref) ?? null;
  else if (kind === 'building') record = run('match_overview', {})?.buildings.find((x) => x.ref === ref) ?? null;
  else if (kind === 'death' && /^\d{1,3}$/.test(b ?? '') && (c === undefined || /^w\d{1,2}$/.test(c))) record = run('death_context', { hero: a, index: Number(b), ...(c ? { window: Number(c.slice(1)) } : {}) })?.deaths[0] ?? null;
  else if (kind === 'cast' && b) record = run('ability_audit', { hero: a, ability: b })?.casts.find((x) => x.ref === ref) ?? null;
  else if (kind === 'immune') {
    // The ref says which ability was watched, if any ("immune:<hero>:<n>:<watch hero>-<ability>"): resolve the same one.
    const w = typeof c === 'string' ? c.match(/^([a-z_]+)-([a-z0-9_]+)$/) : null;
    if (c !== undefined && !w) return null;
    record = run('immunity_windows', { hero: a, ...(w ? { watch_hero: w[1], watch_ability: w[2] } : {}) })?.windows.find((x) => x.ref === ref) ?? null;
  } else if (kind === 'timeline' && /^-?\d{1,5}-\d{1,5}$/.test(a ?? '')) { const m = a.match(/^(-?\d+)-(\d+)$/); record = run('fight_timeline', { from: Number(m[1]), to: Number(m[2]) }); } else if (kind === 'item' && b) record = run('item_timeline', { hero: a })?.items.find((x) => x.ref === ref) ?? null;
  else if (kind === 'abilities') { const r = heroAbilities(trace, { hero: a }, ctx); record = r.error ? null : r; } else if (kind === 'pro_items') { const r = proItemChoices(trace, { hero: a }, ctx); record = r.error ? null : r; }
  else if (kind === 'audit' && b) record = summaryOf(run('ability_audit', { hero: a, ability: b }));
  else if (kind === 'deaths' && (b === undefined || /^w\d{1,2}$/.test(b))) record = summaryOf(run('death_context', { hero: a, index: 1, ...(b ? { window: Number(b.slice(1)) } : {}) }));
  else if (kind === 'immunity') record = summaryOf(run('immunity_windows', { ...(a === 'radiant' || a === 'dire' ? { team: a } : a === 'all' ? {} : { hero: a }), ...(b && c ? { watch_hero: b, watch_ability: c } : {}) }));
  if (!record || record.ref !== ref) return null;
  const { tool, gaps, ...rest } = record;
  return { ref, kind, record: rest, names: namesIn(rest, lang) };
}
