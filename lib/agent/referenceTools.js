/**
 * Reference tools: Dota 2 knowledge the repository already holds, for the model to look up instead of recalling
 * (#405, A). Each answers a question of fact — what an item does on this game's patch, a hero's base numbers, how two
 * heroes do against each other in public games, what this patch changed — with its source and sample. What it means
 * for this game is the model's to judge.
 *
 * - item_info: the item as it was on the game's release (lib/agent/patchData.js): cost, components, bonuses, its
 *   active and passive text, notes.
 * - hero_info: a hero's attribute, attack type, Valve's roles and base numbers (lib/data/constants/heroes.json, the
 *   site's table of the current patch; a game on another patch is told so).
 * - hero_matchup: two heroes against each other in public games by bracket (STRATZ, lib/coach/matchupsRank.js): the
 *   win rate against the hero's own, and the lane against its own lanes. Too few games is no answer, never "even".
 * - patch_changes: what the newest patch's notes (lib/coach/data/patch-notes.json) say about a hero or an item.
 */
import { createRequire } from 'node:module';
import { heroByKey } from '../../packages/review-engine/src/staticHeroes.js';
import { currentAghsUpgrades, patchForGame } from './patchData.js';
import { BRACKETS, BRACKET_LABEL, RANK_SOURCE, heroVsRank, laneVsRank, reviewBracket } from '../coach/matchupsRank.js';

const require = createRequire(import.meta.url);
const ITEM_NAMES = require('../coach/data/names.json').items;
const HEROES = require('../data/constants/heroes.json');
const HEROES_META = require('../data/constants/meta.json');
const NOTES = require('../coach/data/patch-notes.json');

const fail = (error, extra = {}) => ({ error, ...extra });
const pct = (x) => Math.round(x * 1000) / 10;
const norm = (s) => String(s ?? '').trim().toLowerCase();
const slug = (s) => norm(s).replace(/^npc_dota_hero_/, '').replace(/^item_/, '').replace(/[\s'-]+/g, '_');
const pick = (o, lang) => (o && typeof o === 'object' ? o[lang] ?? o.en ?? null : o ?? null);
const majorOf = (name) => (typeof name === 'string' ? name.match(/^\d+\.\d+/)?.[0] ?? null : null);

/** The hero a model names: by key ("sven", "npc_dota_hero_sven"), or by its English or Chinese name. */
function heroOf(x) {
  const k = slug(x);
  const direct = heroByKey(k);
  if (direct) return direct;
  const n = norm(x);
  for (const h of Object.values(HEROES)) {
    const key = String(h.name).replace(/^npc_dota_hero_/, '');
    const s = heroByKey(key);
    if (s && (norm(h.localized_name) === n || norm(s.nameZh) === n || (h.aliases ?? []).includes(n))) return s;
  }
  return null;
}

/** The item a model names: by key ("black_king_bar", "item_black_king_bar") or its English or Chinese name. */
function itemKeyOf(x, items) {
  const k = slug(x);
  if (items[k]) return k;
  const n = norm(x);
  for (const [key, it] of Object.entries(items)) if (norm(it?.dname) === n || norm(ITEM_NAMES[key]?.zh) === n || norm(ITEM_NAMES[key]?.en) === n) return key;
  return null;
}

export function itemInfo(trace, args = {}, ctx = {}) {
  const pd = patchForGame(trace.match_id, ctx.match);
  const key = itemKeyOf(args.item, pd.items);
  if (!key) return fail('unknown_item', { hint: 'use the item key as the replay or build_check names it, e.g. "black_king_bar", or its English name' });
  const it = pd.items[key];
  const lang = ctx.lang === 'zh' ? 'zh' : 'en';
  return {
    ref: `item_info:${key}`, item: key, name: ITEM_NAMES[key]?.[lang] ?? it.dname ?? key,
    patch: pd.name, patch_exact: pd.exact,
    cost: Number.isFinite(it.cost) ? it.cost : null,
    components: Array.isArray(it.components) ? it.components.map((c) => ITEM_NAMES[c]?.[lang] ?? c) : [],
    bonuses: (it.attrib ?? []).filter((a) => a?.key && a.key !== 'max_level' && a.key !== 'model_scale').map((a) => ({ key: a.key, value: a.value })),
    // Valve's own text for what it does (English: the game files').
    abilities: (it.abilities ?? []).map((a) => ({ type: a.type, title: a.title, text: a.description })),
    ...(typeof it.notes === 'string' && it.notes ? { notes: it.notes } : {}),
    // Valve's hint lines: what a number means where the bonuses alone mislead (Witless Shako reduces max mana).
    ...(Array.isArray(it.hint) && it.hint.length ? { hint: it.hint.filter((x) => typeof x === 'string') } : typeof it.hint === 'string' && it.hint ? { hint: [it.hint] } : {}),
    ...(Number.isFinite(it.cd) ? { cooldown: it.cd } : {}),
    ...(Number.isFinite(it.mc) ? { mana_cost: it.mc } : {}),
    gaps: pd.exact ? [] : [{ topic: 'patch', reason: pd.reason ?? 'release_not_known_exactly' }],
  };
}

export function heroInfo(trace, args = {}, ctx = {}) {
  const s = heroOf(args.hero);
  if (!s) return fail('unknown_hero');
  const h = HEROES[String(s.id)] ?? Object.values(HEROES).find((x) => x.id === s.id);
  if (!h) return fail('no_data_for_hero');
  // The game's patch only when it is established: a fallback to the current table is not the game's patch.
  const pg = patchForGame(trace.match_id, ctx.match);
  const game = pg.exact ? majorOf(pg.name) : null;
  const lang = ctx.lang === 'zh' ? 'zh' : 'en';
  const aghs = currentAghsUpgrades(s.id, lang, ctx.abilitiesData);
  const num = (v) => (Number.isFinite(v) ? v : null);
  return {
    ref: `hero_info:${s.internalSlug ?? slug(s.internalName)}`, hero: s.internalSlug ?? slug(s.internalName),
    name: lang === 'zh' ? s.nameZh : s.nameEn,
    primary_attribute: { str: 'strength', agi: 'agility', int: 'intelligence', all: 'universal' }[h.primary_attr] ?? h.primary_attr ?? null,
    attack_type: h.attack_type ? norm(h.attack_type) : null,
    roles: h.roles ?? [],
    base: {
      health: num(h.base_health), mana: num(h.base_mana), armor: num(h.base_armor), magic_resistance: num(h.base_mr),
      attack_damage: num(h.base_attack_min) != null && num(h.base_attack_max) != null ? [h.base_attack_min, h.base_attack_max] : null,
      // OpenDota's table: attack_rate is the base attack time (seconds), base_attack_time the base attack speed.
      attack_range: num(h.attack_range), base_attack_time: num(h.attack_rate), base_attack_speed: num(h.base_attack_time), attack_point: num(h.attack_point),
      move_speed: num(h.move_speed), day_vision: num(h.day_vision), night_vision: num(h.night_vision),
      strength: num(h.base_str), agility: num(h.base_agi), intelligence: num(h.base_int),
      gain_per_level: { strength: num(h.str_gain), agility: num(h.agi_gain), intelligence: num(h.int_gain) },
    },
    aghanims_scepter: aghs.scepter,
    aghanims_shard: aghs.shard,
    data_patch: HEROES_META.patch,
    // Full per-ability flags and patch-specific cooldowns: hero_abilities.
    gaps: [
      ...(!game ? [{ topic: 'patch', reason: `the game's patch is not established (${pg.reason ?? 'unknown'}); base numbers and Scepter/Shard text are of ${HEROES_META.patch}` }]
        : game !== HEROES_META.patch ? [{ topic: 'patch', reason: `base numbers and Scepter/Shard text are of ${HEROES_META.patch}; the game was on ${game}` }] : []),
      ...(aghs.scepter == null ? [{ topic: 'aghanims_scepter', reason: 'not_in_valve_ability_data' }] : []),
      ...(aghs.shard == null ? [{ topic: 'aghanims_shard', reason: 'not_in_valve_ability_data' }] : []),
    ],
  };
}

export function heroMatchup(trace, args = {}, ctx = {}) {
  const a = heroOf(args.hero); const b = heroOf(args.against);
  if (!a || !b) return fail('unknown_hero');
  const keyA = a.internalSlug ?? slug(a.internalName); const keyB = b.internalSlug ?? slug(b.internalName);
  // The player's bracket when the match data has public medals; else every bracket.
  const view = trace.heroes.find((h) => h.key === ctx.perspective) ?? null;
  const me = view ? (ctx.match?.players ?? []).find((p) => p && p.hero_id === heroByKey(view.key)?.id) : null;
  const known = ctx.match ? reviewBracket(ctx.match.players ?? [], me ?? {}) : null;
  const brackets = known ? [known.key] : BRACKETS;
  const row = (br) => {
    const w = heroVsRank(a.id, b.id, br); const l = laneVsRank(a.id, b.id, br);
    return {
      bracket: pick(BRACKET_LABEL[br], ctx.lang === 'zh' ? 'zh' : 'en'),
      win: w ? { games: w.n, win_rate: pct(w.wr), own_win_rate: pct(w.base), reading: w.verdict } : null,
      lane_when_they_met: l ? { lanes: l.n, won: pct(l.won), even: pct(l.even), lost: pct(l.lost), own_lanes_won: pct(l.base.won), own_lanes_lost: pct(l.base.lost), reading: l.verdict } : null,
    };
  };
  const rows = brackets.map(row);
  return {
    ref: `matchup:${keyA}:${keyB}`, hero: keyA, against: keyB,
    bracket_basis: known ? (known.basis === 'player' ? 'the player\'s medal' : 'the median public medal of the match') : 'not known: every bracket',
    by_bracket: rows,
    source: `${RANK_SOURCE.attribution?.en ?? 'STRATZ'}; public matches of ${RANK_SOURCE.patch}, ${RANK_SOURCE.weeks?.count ?? '?'} weeks to ${RANK_SOURCE.weeks?.to ?? '?'}`,
    reading_rule: 'win_rate is hero against that enemy, own_win_rate the hero against everyone; "reading" is favoured / unfavoured only two standard errors away from its own (100+ games, 50+ lanes). It is public games, not this game.',
    gaps: rows.every((r) => !r.win && !r.lane_when_they_met) ? [{ topic: 'matchup', reason: 'too_few_games' }] : [],
  };
}

export function patchChanges(trace, args = {}, ctx = {}) {
  const lang = ctx.lang === 'zh' ? 'zh' : 'en';
  const pg = patchForGame(trace.match_id, ctx.match);
  // Null when the game's patch is not established (the lookup fell back to the current table).
  const game = pg.exact ? pg.name : null;
  const lines = (list) => (list ?? []).flatMap((g) => (g.lines ?? []).map((l) => ({ ...(g.about ? { about: g.about } : {}), ...(g.name ? { ability: pick(g.name, lang) } : {}), text: pick(l, lang) })));
  let about; let found;
  if (args.hero != null) {
    const s = heroOf(args.hero);
    if (!s) return fail('unknown_hero');
    about = s.internalSlug ?? slug(s.internalName);
    found = NOTES.heroes?.[about] ?? null;
    found = found ? lines(found) : [];
  } else if (args.item != null) {
    // An item the site knows (this patch's data or the notes): a name nobody knows is an error, never "no changes".
    const known = itemKeyOf(args.item, pg.items) ?? (NOTES.items?.[slug(args.item)] ? slug(args.item) : null)
      ?? Object.entries(NOTES.items ?? {}).find(([, v]) => norm(v?.name?.en) === norm(args.item) || norm(v?.name?.zh) === norm(args.item))?.[0] ?? null;
    if (!known) return fail('unknown_item', { hint: 'use the item key as the replay or build_check names it, or its English name' });
    about = known;
    const it = NOTES.items?.[about] ?? Object.entries(NOTES.items ?? {}).find(([, v]) => norm(v?.name?.en) === norm(args.item) || norm(v?.name?.zh) === norm(args.item))?.[1] ?? null;
    if (it && !NOTES.items?.[about]) about = Object.entries(NOTES.items).find(([, v]) => v === it)[0];
    found = it ? [...(it.tag ? [{ text: pick(it.tag, lang) }] : []), ...(it.lines ?? []).map((l) => ({ text: pick(l, lang) }))] : [];
  } else return fail('give_hero_or_item');
  return {
    ref: `patch_notes:${about}`, about, notes_of: NOTES.version, game_patch: game,
    changes: found,
    source: NOTES.url,
    gaps: !game ? [{ topic: 'patch', reason: `the game's patch is not established (${pg.reason ?? 'unknown'}); these are the notes of ${NOTES.version}` }]
      // The notes are of one release: a game on a later letter release or after a hotfix may have changes they do not list.
      : game !== NOTES.version || pg.hotfix ? [{ topic: 'patch', reason: `these are the notes of ${NOTES.version}; the game was on ${game}${pg.hotfix ? ` after the hotfix of ${pg.hotfix}` : ''}, whose later changes they do not list` }] : [],
  };
}

const ANY_HERO = { type: 'string', description: 'Hero key as in match_overview (e.g. "sven"), or its English name. Any hero, not only this match\'s.' };
export const REFERENCE_TOOLS = [
  {
    name: 'item_info',
    description: 'What an item is on this game\'s patch: cost, components, bonuses, and Valve\'s text for its active and passive. Look an item up here before saying what it does or what it is for.',
    input_schema: { type: 'object', properties: { item: { type: 'string', description: 'Item key (e.g. "black_king_bar", as build_check and item_timeline name items) or its English name.' } }, required: ['item'], additionalProperties: false },
    run: itemInfo,
  },
  {
    name: 'hero_info',
    description: 'A hero\'s primary attribute, attack type, Valve\'s roles, base numbers (health, armor, attack, range, speed, vision, attribute gain), and official Aghanim\'s Scepter and Aghanim\'s Shard effects (granted abilities and upgrades). For full per-ability flags and patch-specific cooldowns use hero_abilities.',
    input_schema: { type: 'object', properties: { hero: ANY_HERO }, required: ['hero'], additionalProperties: false },
    run: heroInfo,
  },
  {
    name: 'hero_matchup',
    description: 'How one hero does against another in public games (STRATZ), in the player\'s bracket when known: win rate with the other on the enemy team against its own, and how their lanes went when they met. Public games, not this game; too few games gives no answer.',
    input_schema: { type: 'object', properties: { hero: ANY_HERO, against: ANY_HERO }, required: ['hero', 'against'], additionalProperties: false },
    run: heroMatchup,
  },
  {
    name: 'patch_changes',
    description: 'What the newest patch notes say about one hero (abilities, talents, numbers) or one item. Says which patch the notes are of and which the game was on.',
    input_schema: { type: 'object', properties: { hero: ANY_HERO, item: { type: 'string', description: 'Item key or English name.' } }, additionalProperties: false },
    run: patchChanges,
  },
];
