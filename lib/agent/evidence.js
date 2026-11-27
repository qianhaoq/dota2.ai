/**
 * Evidence for the reader: the tool record behind a `ref`, recomputed from
 * the trace (never taken from the model), with display names for every hero,
 * item and ability key in it. This is what an evidence card shows, so the
 * reader checks a claim against the record itself.
 */
import { createRequire } from 'node:module';
import { STATIC_HEROES, HEROES_BY_KEY } from '../../packages/review-engine/src/staticHeroes.js';
import { runTraceTool } from '../../packages/review-engine/src/trace/index.js';
import { heroAbilities, laneReport, lineupTiming, proItemChoices } from './knowledgeTools.js';
import { draftReport } from './draftReport.js';
import { buildCheck, powerSpikes } from './situationTools.js';
import { placeNames } from './places.js';
import { windowReport } from './windowReport.js';
import { buildForPlan } from './buildForPlan.js';
import { farmReport } from './farmReport.js';
import { fightReport, gameState } from './fightReport.js';
import { siegeReport } from './siegeReport.js';
import { roshanReport } from './roshanReport.js';
import { keyMoments } from './keyMoments.js';
import { wardReport } from './wardReport.js';
import { saveReport } from './saveReport.js';
import { heroInfo, heroMatchup, itemInfo, patchChanges } from './referenceTools.js';
import { heroTrack, logRow } from './replayQuery.js';
import { decisionPoints } from './decisionPoints.js';
import { ultimateOf, ultimatesOf } from './ultimates.js';

export { ultimateOf, ultimatesOf };

const require = createRequire(import.meta.url);
const ABILITIES = require('../coach/data/abilities.json');
const ITEM_NAMES = require('../coach/data/names.json').items;

// By the key a replay uses for the hero, which is not always the internal slug ("queen_of_pain" for queenofpain).
const HERO_BY_SLUG = HEROES_BY_KEY;
const ABILITY_BY_ID = new Map(Object.values(ABILITIES.heroes ?? {}).flat().map((a) => [a.id, a]));
const REF = /^[a-z_]+(?::[A-Za-z0-9_-]+){0,3}$/;
/** Every hero, ability and item name the data has in Chinese: a string that is one of these is a real name, whatever it resembles. */
export const KNOWN_ZH_NAMES = new Set([...Object.values(STATIC_HEROES).map((h) => h.nameZh), ...ABILITY_BY_ID.values()].map((v) => (typeof v === 'string' ? v : v?.zh)).concat(Object.values(ITEM_NAMES ?? {}).map((i) => i?.zh)).filter(Boolean));

/** A tool answer cut down to what its summary ref covers: top-level values and one level of maps, no record lists. */
function summaryOf(result) {
  if (!result) return null;
  return Object.fromEntries(Object.entries(result).filter(([, v]) => !Array.isArray(v)));
}

/** An ability's name in both languages from the ability data, or null: a check is not worded with a made-up name. */
export function abilityName(key) {
  const a = ABILITY_BY_ID.get(key);
  return a?.en && a?.zh ? { en: a.en, zh: a.zh } : null;
}

/** Whether the ability data marks this ability as its hero's ultimate. False for a key the data does not hold. */
export const isUltimate = (key) => ABILITY_BY_ID.get(key)?.ult === true;

/** States and map actions the engine names itself: not any hero's ability, so not in the ability data. */
const GENERIC = {
  modifier_stunned: { en: 'Stunned', zh: '眩晕', ru: 'Оглушение' },
  modifier_bashed: { en: 'Bashed', zh: '重击眩晕', ru: 'Баш' },
  modifier_rooted: { en: 'Rooted', zh: '缠绕', ru: 'Оцепенение' },
  modifier_knockback: { en: 'Knocked back', zh: '击退', ru: 'Отталкивание' },
  modifier_black_king_bar_immune: { en: 'Black King Bar', zh: '黑皇杖', ru: 'Black King Bar' },
  ability_capture: { en: 'Capture', zh: '占领', ru: 'Захват' },
  dota_fountain: { en: 'Fountain', zh: '泉水', ru: 'Фонтан' },
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
  const L = lang === 'zh' ? 'zh' : lang === 'ru' ? 'ru' : 'en';
  const out = {};
  const see = (s) => {
    if (out[s] !== undefined) return;
    const item = s.replace(/^item_/, '');
    const short = s.replace(/^modifier_/, '');
    if (HERO_BY_SLUG.has(s)) out[s] = L === 'zh' ? HERO_BY_SLUG.get(s).nameZh : HERO_BY_SLUG.get(s).nameEn;
    else if (ABILITY_BY_ID.has(s)) out[s] = ABILITY_BY_ID.get(s)[L] ?? ABILITY_BY_ID.get(s).en;
    else if (ABILITY_BY_ID.has(short)) out[s] = ABILITY_BY_ID.get(short)[L] ?? ABILITY_BY_ID.get(short).en;
    else if (ITEM_NAMES[item]) out[s] = ITEM_NAMES[item][L] ?? ITEM_NAMES[item].en;
    else if (GENERIC[s]) out[s] = GENERIC[s][L] ?? GENERIC[s].en;
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
 * @param {{ hero: string, lang?: string, match?: any, bracketData?: any }} o
 * @returns {{ ref: string, kind: string, record: any, names: Record<string, string> } | null}
 */
export function resolveRef(trace, ref, { hero, lang = 'en', match = null, bracketData }) {
  if (typeof ref !== 'string' || !REF.test(ref)) return null;
  const ctx = { match, perspective: hero, lang, ultimateOf, ultimatesOf, ...(bracketData ? { bracketData } : {}) };
  const [kind, a, b, c] = ref.split(':');
  const run = (name, args) => { const r = runTraceTool(trace, name, args, ctx); return r?.error ? null : r; };
  let record = null;
  if (kind === 'overview' && a === undefined) record = run('match_overview', {});
  else if (kind === 'fight') record = run('match_overview', {})?.fights.find((f) => f.ref === ref) ?? null;
  else if (kind === 'building') record = run('match_overview', {})?.buildings.find((x) => x.ref === ref) ?? null;
  else if (kind === 'death' && /^\d{1,3}$/.test(b ?? '') && (c === undefined || /^w\d{1,2}$/.test(c))) record = run('death_context', { hero: a, index: Number(b), ...(c ? { window: Number(c.slice(1)) } : {}) })?.deaths[0] ?? null;
  else if (kind === 'resurrection' && /^\d{1,3}$/.test(b ?? '') && c === undefined) record = run('death_context', { hero: a })?.resurrections?.find((x) => x.ref === ref) ?? null;
  else if (kind === 'cast' && b) record = run('ability_audit', { hero: a, ability: b })?.casts?.find((x) => x.ref === ref) ?? null;
  else if (kind === 'immune') {
    // The ref says which ability was watched, if any ("immune:<hero>:<n>:<watch hero>-<ability>"): resolve the same one.
    const w = typeof c === 'string' ? c.match(/^([a-z_]+)-([a-z0-9_]+)$/) : null;
    if (c !== undefined && !w) return null;
    record = run('immunity_windows', { hero: a, ...(w ? { watch_hero: w[1], watch_ability: w[2] } : {}) })?.windows.find((x) => x.ref === ref) ?? null;
  } else if (kind === 'timeline' && /^-?\d{1,5}-\d{1,5}$/.test(a ?? '')) { const m = a.match(/^(-?\d+)-(\d+)$/); record = run('fight_timeline', { from: Number(m[1]), to: Number(m[2]) }); } else if (kind === 'item' && b) record = run('item_timeline', { hero: a })?.items.find((x) => x.ref === ref) ?? null;
  else if (kind === 'abilities') { const r = heroAbilities(trace, { hero: a }, ctx); record = r.error ? null : r; } else if (kind === 'pro_items') { const r = proItemChoices(trace, { hero: a }, ctx); record = r.error ? null : r; }
  else if (kind === 'lane' && b === undefined) { const r = laneReport(trace, { hero: a }, ctx); record = r.error ? null : r; }
  else if (kind === 'draft' && a && b === undefined) { const r = draftReport(trace, { hero: a }, ctx); record = r.error ? null : r; }
  else if (kind === 'lineup_timing' && a === undefined) record = lineupTiming(trace, {}, ctx);
  else if ((kind === 'build' || kind === 'spikes') && b === undefined) { const r = (kind === 'build' ? buildCheck : powerSpikes)(trace, { hero: a }, ctx); record = r.error ? null : r; }
  else if (kind === 'farm' && a && (b === undefined || /^[wb]?\d{1,2}$/.test(b)) && c === undefined) {
    // Told from the hero in the ref: the summary, a stretch (farm:<hero>:<n>), a window (…:w<n>) or a building the team took (…:b<n>).
    const r = farmReport(trace, { hero: a }, ctx);
    record = r.error ? null : b === undefined ? summaryOf(r) : [...(r.stretches ?? []), ...(r.windows ?? []), ...(r.buildings_your_team_took ?? [])].find((x) => x.ref === ref) ?? null;
  } else if (kind === 'build_plan' && a && c === undefined) {
    // The player's items against the plans, with the plan in the ref when one was named.
    const r = buildForPlan(trace, { hero: a, ...(b ? { plan: b } : {}) }, ctx);
    record = r.error ? null : summaryOf(r);
  } else if (kind === 'window' && a && (b === undefined || /^\d{1,2}$/.test(b)) && c === undefined) {
    // The whole game's lead (the summary) or one window, told from the hero in the ref: the same game read
    // from the other side is another record.
    const r = windowReport(trace, { hero: a }, ctx);
    record = r.error ? null : b === undefined ? summaryOf(r) : (r.windows ?? []).find((w) => w.ref === ref) ?? null;
  } else if (kind === 'fights' && a && (b === undefined || /^\d{1,2}$/.test(b)) && c === undefined) {
    // Every fight read from the state before it, told from the hero in the ref: the totals, or one fight.
    const r = fightReport(trace, { hero: a }, ctx);
    record = r.error ? null : b === undefined ? summaryOf(r) : (r.fights ?? []).find((f) => f.ref === ref) ?? null;
  } else if (kind === 'sieges' && a && (b === undefined || /^\d{1,3}$/.test(b)) && c === undefined) {
    // Every push on a building, told from the hero in the ref: the totals, or one push.
    const r = siegeReport(trace, { hero: a });
    record = r.error ? null : b === undefined ? summaryOf(r) : (r.pushes ?? []).find((p) => p.ref === ref) ?? null;
  } else if (kind === 'decision' && a && (b === undefined || /^\d{1,3}$/.test(b)) && c === undefined) {
    // The moments a side had a choice, told from the hero in the ref: the totals, or one moment.
    const r = decisionPoints(trace, { hero: a }, ctx);
    record = r.error ? null : b === undefined ? summaryOf(r) : (r.points ?? []).find((x) => x.ref === ref) ?? null;
  } else if (kind === 'saves' && a && (b === undefined || /^\d{1,3}$/.test(b)) && c === undefined) {
    // What the hero in the ref used on allies: the counts, or one use (saves:<hero>:<n>).
    const r = saveReport(trace, { hero: a });
    record = r.error ? null : b === undefined ? summaryOf(r) : (r.given ?? []).find((x) => x.ref === ref) ?? null;
  } else if (kind === 'wards' && a && (b === undefined || /^\d{1,3}$/.test(b)) && c === undefined) {
    // The wards the hero in the ref placed and killed: the counts, or one placement (wards:<hero>:<n>).
    const r = wardReport(trace, { hero: a });
    record = r.error ? null : b === undefined ? summaryOf(r) : (r.placements ?? []).find((x) => x.ref === ref) ?? null;
  } else if (kind === 'log' && a && /^\d{1,6}$/.test(b ?? '') && c === undefined) {
    // One row of the replay's log (replayQuery.js).
    record = logRow(trace, a, Number(b));
  } else if (kind === 'track' && a && /^-?\d{1,5}$/.test(b ?? '') && /^-?\d{1,5}$/.test(c ?? '')) {
    const r = heroTrack(trace, { hero: a, from: Number(b), to: Number(c) });
    record = r.error ? null : r;
  } else if (kind === 'item_info' && a && b === undefined) {
    // Knowledge, not the replay: what an item is on this game's patch (referenceTools.js).
    const r = itemInfo(trace, { item: a }, ctx);
    record = r.error ? null : r;
  } else if (kind === 'hero_info' && a && b === undefined) {
    const r = heroInfo(trace, { hero: a }, ctx);
    record = r.error ? null : r;
  } else if (kind === 'matchup' && a && b && c === undefined) {
    const r = heroMatchup(trace, { hero: a, against: b }, ctx);
    record = r.error ? null : r;
  } else if (kind === 'patch_notes' && a && b === undefined) {
    // A hero or an item: the notes of either (a key is never both).
    const r = patchChanges(trace, heroInfo(trace, { hero: a }, ctx).error ? { item: a } : { hero: a }, ctx);
    record = r.error ? null : r;
  } else if (kind === 'moments' && a && b === undefined) {
    // The fights that moved the chance most, told from the hero in the ref: the totals and the stretch (the fights themselves are fight:N).
    const r = keyMoments(trace, { hero: a }, { match });
    record = r.error ? null : summaryOf(r);
  } else if (kind === 'roshan' && a && (b === undefined || /^t?\d{1,2}$/.test(b)) && c === undefined) {
    // Every Roshan, told from the hero in the ref: the totals, one take, or one Tormentor kill (`t<n>`).
    const r = roshanReport(trace, { hero: a });
    record = r.error ? null : b === undefined ? summaryOf(r) : (b.startsWith('t') ? r.tormentors ?? [] : r.takes ?? []).find((x) => x.ref === ref) ?? null;
  } else if (kind === 'state' && a && /^-?\d{1,5}$/.test(b ?? '') && c === undefined) {
    // Before the horn too (a trace keeps pre-horn seconds, as negative game times).
    const r = gameState(trace, { hero: a, at: Number(b) }, ctx);
    record = r.error ? null : r;
  } else if (kind === 'tempo' && b === undefined) record = summaryOf(run('tempo_report', { hero: a }));
  else if (kind === 'phase' && /^\d{1,2}$/.test(b ?? '') && c === undefined) record = run('tempo_report', { hero: a })?.phases.find((x) => x.ref === ref) ?? null;
  else if (kind === 'audit' && b) record = summaryOf(run('ability_audit', { hero: a, ability: b }));
  else if (kind === 'deaths' && (b === undefined || /^w\d{1,2}$/.test(b))) // No index: a hero who never died still has a summary (every count zero), which is what a next-game check reads.
  record = summaryOf(run('death_context', { hero: a, ...(b ? { window: Number(b.slice(1)) } : {}) }));
  else if (kind === 'immunity') record = summaryOf(run('immunity_windows', { ...(a === 'radiant' || a === 'dire' ? { team: a } : a === 'all' ? {} : { hero: a }), ...(b && c ? { watch_hero: b, watch_ability: c } : {}) }));
  if (!record || record.ref !== ref) return null;
  const { tool, gaps, ...rest } = record;
  // A stretch of the game names the places the hero spent it in: those are the tools' region keys, named like any other key.
  // So do a fight's and a moment's records: where each hero not in it, or at that second, stood.
  const places = kind === 'phase' || kind === 'fights' || kind === 'state' || kind === 'sieges' || kind === 'death' || kind === 'resurrection' || kind === 'roshan' || kind === 'decision' || kind === 'lane' ? placeNames(lang) : null;
  const placed = kind === 'phase' ? (rest.hero_most_time_in ?? []).map((x) => x.place)
    : kind === 'fights' ? [rest.my_team, rest.enemy].flatMap((s) => (s?.not_in_it ?? []).map((x) => x.place))
      : kind === 'state' ? [rest.my_team, rest.enemy].flatMap((s) => (s?.heroes ?? []).map((x) => x.place))
        : kind === 'sieges' ? [...(rest.pushing_side_not_hitting ?? []), ...(rest.owners_not_near ?? []), ...(rest.me_when_it_fell ? [rest.me_when_it_fell] : [])].map((x) => x.place)
          : kind === 'resurrection' ? [rest.at?.region]
              : kind === 'roshan' ? [rest.place, ...(rest.attempt?.other_side_when_it_began ?? []).map((x) => x.place)]
                : kind === 'decision' ? [rest.my_place]
                  : kind === 'lane' ? (rest.how_the_lane_went?.my_rotations_before_10_00?.trips ?? []).map((x) => x.destination_region) : [];
  return { ref, kind, record: rest, names: { ...namesIn(rest, lang), ...(places ? Object.fromEntries(placed.filter(Boolean).map((p) => [p, places[p] ?? p])) : {}) } };
}
