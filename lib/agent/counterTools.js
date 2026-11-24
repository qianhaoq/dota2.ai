/**
 * Counter tools for the review agent: what answers what, and why — hero ↔
 * hero, ability ↔ hero/ability, item ↔ hero/ability — for the release this
 * game was played on.
 *
 * - ability_counters: an ability's Valve flags in this game's release (damage
 *   type, "Pierces Debuff Immunity", how it is dispelled, behaviour) and, per
 *   mechanism, the items and the abilities of this match's heroes that answer
 *   it, those that do not (and why), and what is unknown; who in this game
 *   held each answering item and from when.
 * - item_counters: what an item answers in this game's release, each entry
 *   with Valve's sentence quoted; which of the enemies' abilities and items in
 *   this game it answers, does not answer, or is not known to.
 * - hero_counters: two heroes: which of one's abilities answer the other's and
 *   the reverse, the items that answer the other's abilities, and — as
 *   association, not cause — how the pairing goes in professional games and
 *   in public games of the player's bracket, and what pros build against it.
 *
 * The mechanisms and their limits are lib/coach/counters.js. Win rates are
 * one input among the mechanisms, never the answer on their own.
 */
import { STATIC_HEROES, HEROES_BY_KEY } from '../../packages/review-engine/src/staticHeroes.js';
import { itemTimeline } from '../../packages/review-engine/src/trace/index.js';
import { createRequire } from 'node:module';
import {
  ABILITY_TEXT_SOURCE, COUNTER_GAPS, ITEM_ANSWERS, MECHANISMS, abilityAnswers, dispelOnlyIf, abilityThreat, itemMechanisms, itemText, itemThreats,
} from '../coach/counters.js';
import { ITEM_VS_SOURCE, MATCHUP_SOURCE, heroVs, itemLifts, laneMatchup } from '../coach/matchups.js';
import { BRACKET_LABEL, RANK_SOURCE, heroVsRank, reviewBracket } from '../coach/matchupsRank.js';
import { CURRENT_RELEASE, patchData, patchForGame } from './patchData.js';

const ITEM_NAMES = createRequire(import.meta.url)('../coach/data/names.json').items;
const BY_SLUG = HEROES_BY_KEY;
const BY_ID = new Map(Object.values(STATIC_HEROES).map((h) => [h.id, h]));
const slugOf = (hero) => String(hero ?? '').trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s-]+/g, '_');
const keyOf = (s) => String(s ?? '').trim().toLowerCase().replace(/^item_/, '');
const L = (ctx) => (ctx?.lang === 'zh' ? 'zh' : 'en');
const r2 = (n) => Math.round(n * 100) / 100;
const itemName = (key, lang) => ITEM_NAMES[key]?.[lang] ?? key;
/** At most this many attribute-only answers (magic resistance, armor) per mechanism: the strongest first. */
const MAX_ATTRIBUTE_ANSWERS = 6;

/** Every item that answers each mechanism in a release, built once per release. */
const indexes = new Map();
function answerIndex(pd) {
  if (indexes.has(pd.name)) return indexes.get(pd.name);
  const byM = {};
  const attr = {};
  for (const key of Object.keys(pd.items)) {
    if (key.startsWith('recipe_')) continue;
    const curated = Object.hasOwn(ITEM_ANSWERS, key);
    for (const c of itemMechanisms(key, pd.items).confirmed) {
      // A shop item, or one of the curated list (neutral items cost 0): not every component with a point of armor.
      if (c.from === 'attribute') { if (!curated && !(pd.items[key].cost > 0)) continue; (attr[c.mechanism] ??= []).push({ item: key, ...c }); } else (byM[c.mechanism] ??= []).push({ item: key, ...c });
    }
  }
  const num = (s) => Number(String(s).split(' ').at(-1)) || 0;
  for (const [m, list] of Object.entries(attr)) {
    const have = new Set((byM[m] ?? []).map((x) => x.item));
    byM[m] = [...(byM[m] ?? []), ...list.filter((x) => !have.has(x.item)).sort((a, b) => num(b.valve_says) - num(a.valve_says)).slice(0, MAX_ATTRIBUTE_ANSWERS)];
  }
  indexes.set(pd.name, byM);
  return byM;
}

/** Who in this game held an item, and from when, on which side of the player. */
function holders(trace, key, seat) {
  const out = [];
  for (const h of trace.heroes) {
    const it = (itemTimeline(trace, { hero: h.key }).items ?? []).find((x) => x.item === key);
    if (it) out.push({ hero: h.key, side: seat ? (h.team === seat.team ? 'player_team' : 'enemy') : (h.team === 2 ? 'radiant' : 'dire'), first_held: it.first_held.clock });
  }
  return out;
}
const sideOf = (h, seat) => (seat ? (h.team === seat.team ? 'player_team' : 'enemy') : (h.team === 2 ? 'radiant' : 'dire'));
const seatOf = (trace, ctx) => (ctx.perspective == null ? null : trace.heroes.find((h) => h.key === slugOf(ctx.perspective)) ?? null);
const onlyIf = (m, on) => { const c = dispelOnlyIf(m, on); return c ? { only_if: c } : {}; };
const mechanismsUsed = (names) => Object.fromEntries([...new Set(names)].filter((m) => MECHANISMS[m]).map((m) => [m, MECHANISMS[m]]));

/** The data's versions, said the same way by every counter tool. */
function versions(pd) {
  return {
    data_release: pd.name, release_exact: pd.exact, ...(pd.how ? { release_known_from: pd.how } : {}),
    item_text_and_ability_flags: `Valve's game files of ${pd.name} (dotabuff/d2vpkr), built with OpenDota's builder: lib/data/constants/patches`,
    ability_text_and_behavior: `${ABILITY_TEXT_SOURCE.source}, ${ABILITY_TEXT_SOURCE.patch}, fetched ${ABILITY_TEXT_SOURCE.fetched}`,
  };
}
function versionGaps(pd) {
  return [
    ...(pd.exact ? [] : [{ topic: 'release_of_this_game', reason: `${pd.reason}; ${pd.name} data used` }]),
    ...(pd.name !== ABILITY_TEXT_SOURCE.patch ? [{ topic: 'ability_text_and_behavior', reason: `kept_for_${ABILITY_TEXT_SOURCE.patch}_only; break, spell_block and curated traits are read from it` }] : []),
  ];
}

/** An ability of a hero in a release, or null. */
function abilityIn(pd, heroId, id) { return (pd.heroAbilities(heroId) ?? []).find((a) => a.id === id) ?? null; }
/** The hero an ability key belongs to: one of this match's heroes first, then any hero. */
function ownerOf(trace, pd, id, hint) {
  const h = hint ? BY_SLUG.get(slugOf(hint)) : null;
  if (h) return abilityIn(pd, h.id, id) ? h : null;
  for (const s of trace.heroes) { const x = BY_SLUG.get(s.key); if (x && abilityIn(pd, x.id, id)) return x; }
  for (const x of BY_ID.values()) if (abilityIn(pd, x.id, id)) return x;
  return null;
}
/** The abilities of `heroes` (match seats) that answer `mechanism`, from their Valve text. */
function abilityAnswersAmong(trace, pd, seats, mechanism, lang, seat) {
  const out = [];
  for (const s of seats) {
    const h = BY_SLUG.get(s.key);
    for (const a of h ? pd.heroAbilities(h.id) ?? [] : []) {
      for (const x of abilityAnswers(a.id)) {
        // A strong dispel is listed under strong_dispel, which applies wherever basic_dispel does.
        if (x.mechanism === mechanism) out.push({ hero: s.key, side: sideOf(s, seat), ability: a.id, name: a[lang] ?? a.en, mechanism: x.mechanism, on: x.on, ...onlyIf(mechanism, x.on), valve_says: x.valve_says });
      }
    }
  }
  return out;
}

export function abilityCounters(trace, args = {}, ctx = {}) {
  const lang = L(ctx);
  const id = String(args.ability ?? '').trim().toLowerCase();
  const pd = patchForGame(trace.match_id, ctx.match);
  const owner = id ? ownerOf(trace, pd, id, args.hero) : null;
  if (!owner) return { error: 'unknown_ability', detail: `No hero has this ability in ${pd.name}. hero_abilities lists a hero's ability keys.` };
  const a = abilityIn(pd, owner.id, id);
  const seat = seatOf(trace, ctx);
  const threat = abilityThreat(a);
  const index = answerIndex(pd);
  // Strong dispels are listed under strong_dispel, which applies wherever basic_dispel does.
  const itemsFor = (m) => index[m] ?? [];
  const ownerSeat = trace.heroes.find((s) => BY_SLUG.get(s.key)?.id === owner.id);
  // Only the owner's opponents answer the ability: an ally of the owner holding the item is no answer to it. When
  // the ability's hero is not in this game there are no opponents to tell: everyone who held it, under another name.
  const opponents = (list) => (ownerSeat ? list.filter((x) => trace.heroes.find((s) => s.key === x.hero)?.team !== ownerSeat.team) : list);
  const priced = (k) => pd.items[k]?.cost > 0;
  const answered = []; const notAnswered = []; const unknown = [];
  for (const [m, v] of Object.entries(threat.by_mechanism)) {
    if (v.applies === 'unknown') { unknown.push({ mechanism: m, why: v.why }); continue; }
    if (v.applies === 'no') {
      // The items in this game that rely on the mechanism and do not help against this ability.
      const relied = itemsFor(m).flatMap((x) => opponents(holders(trace, x.item, seat)).map((hd) => ({ ...hd, item: x.item, name: itemName(x.item, lang) })));
      notAnswered.push({ mechanism: m, why: v.why, ...(relied.length ? { held_in_this_game_but_does_not_answer_it: relied } : {}) });
      continue;
    }
    answered.push({
      mechanism: m, ...(v.when ? { when: v.when } : {}),
      items: itemsFor(m).filter((x) => priced(x.item)).map((x) => { const held = opponents(holders(trace, x.item, seat)); return { item: x.item, name: itemName(x.item, lang), on: x.on, ...onlyIf(m, x.on), valve_says: x.valve_says, cost: pd.items[x.item].cost, ...(held.length ? { [ownerSeat ? 'held_by_its_opponents_in_this_game' : 'held_in_this_game_by_anyone']: held } : {}) }; }),
      // No shop price in Valve's data for this release (a neutral item, or one no longer sold: the data does not say which).
      ...(() => { const free = [...new Set(itemsFor(m).filter((x) => !priced(x.item)).map((x) => x.item))]; return free.length ? { items_without_a_shop_price: Object.fromEntries(free.map((k) => [k, itemName(k, lang)])) } : {}; })(),
      ...(() => { const abs = abilityAnswersAmong(trace, pd, ownerSeat ? trace.heroes.filter((s) => s.team !== ownerSeat.team) : trace.heroes.filter((s) => BY_SLUG.get(s.key)?.id !== owner.id), m, lang, seat); return abs.length ? { abilities_of_its_opponents_in_this_match: abs } : {}; })(),
    });
  }
  return {
    ref: `counter_ability:${id}`, ability: id, name: a[lang] ?? a.en, hero: ownerSeat?.key ?? owner.internalSlug,
    ...(ownerSeat ? { hero_side: sideOf(ownerSeat, seat) } : { hero_in_this_match: false }),
    ...versions(pd),
    valve_flags: threat.flags,
    ...(threat.traits.length ? { traits: threat.traits } : {}),
    answered_by: answered, not_answered_by: notAnswered, not_known: unknown,
    mechanisms: mechanismsUsed([...answered, ...notAnswered].map((x) => x.mechanism)),
    note: 'Each answer is a mechanism Valve\'s data states for this release, with the item\'s or ability\'s own sentence quoted (valve_says); "on" is whom it lands on. Read the mechanism\'s conditions and limits before advising it. not_known means Valve\'s data has no flag for it: say so rather than guess. held_by_its_opponents_in_this_game is who on the other side of the ability\'s hero had the item and from when, not whether they used it on this ability. held_in_this_game_by_anyone is used instead when the ability\'s hero is not in this game. items_without_a_shop_price have cost 0 in Valve\'s data for this release (a neutral item or one no longer sold).',
    gaps: [...versionGaps(pd), ...COUNTER_GAPS, { topic: 'use_of_items_on_this_ability', reason: 'item_casts_are_not_matched_to_ability_casts_here' }],
  };
}

export function itemCounters(trace, args = {}, ctx = {}) {
  const lang = L(ctx);
  const key = keyOf(args.item);
  const pd = patchForGame(trace.match_id, ctx.match);
  const mech = key ? itemMechanisms(key, pd.items) : { exists: false };
  if (!mech.exists) {
    const later = key && patchData(CURRENT_RELEASE).items[key];
    return { error: 'item_not_in_this_release', data_release: pd.name, ...(later ? { exists_in: CURRENT_RELEASE } : {}) };
  }
  const seat = seatOf(trace, ctx);
  const enemies = seat ? trace.heroes.filter((h) => h.team !== seat.team) : trace.heroes;
  const enemyAbilities = enemies.flatMap((s) => { const h = BY_SLUG.get(s.key); return (h ? pd.heroAbilities(h.id) ?? [] : []).map((a) => ({ hero: s.key, a, t: abilityThreat(a) })); });
  const against = mech.confirmed.map((c) => {
    const ms = [c.mechanism];
    // By hero: { hero: { ability: name } }, and for those it does not answer { hero: { ability: why } }.
    const by = (applies) => {
      const out = {};
      for (const x of enemyAbilities.filter((y) => ms.some((m) => y.t.by_mechanism[m]?.applies === applies))) (out[x.hero] ??= {})[x.a.id] = applies === 'no' ? ms.map((m) => x.t.by_mechanism[m]?.why).find(Boolean) : x.a[lang] ?? x.a.en;
      return out;
    };
    // Debuff immunity also meets the enemies' items whose text says they go through it; true strike their evasion items.
    const enemyItems = enemies.flatMap((s) => (itemTimeline(trace, { hero: s.key }).items ?? []).flatMap((it) => itemThreats(it.item, pd.items)
      .filter((th) => (c.mechanism === 'debuff_immunity' && th.threat === 'pierces_debuff_immunity') || (c.mechanism === 'true_strike' && th.threat === 'evasion'))
      .map((th) => ({ hero: s.key, item: it.item, name: itemName(it.item, lang), first_held: it.first_held.clock, threat: th.threat, valve_says: th.valve_says }))));
    // The sentence is quoted once, in valve_text; here the words of it that confirm the mechanism.
    const out = { mechanism: c.mechanism, on: c.on, ...onlyIf(c.mechanism, c.on), ...(c.from === 'attribute' ? { valve_attribute: c.valve_says } : { confirmed_by_the_words: c.matched }), answers_their_abilities: by('yes'), does_not_answer_their_abilities_because: by('no'), not_known_for: by('unknown') };
    if (c.mechanism === 'debuff_immunity' && enemyItems.length) out.their_items_that_go_through_it = enemyItems;
    if (c.mechanism === 'true_strike' && enemyItems.length) out.their_evasion_items = enemyItems;
    return out;
  });
  // What changed against the newest release's text: an answer that held in one and not in the other.
  let changed = null;
  if (pd.name !== CURRENT_RELEASE) {
    const now = itemMechanisms(key, patchData(CURRENT_RELEASE).items);
    const sig = (xs) => new Set((xs.confirmed ?? []).map((x) => `${x.mechanism}/${x.on}`));
    const a = sig(mech); const b = sig(now);
    const only = (x, y) => [...x].filter((s) => !y.has(s));
    if (only(a, b).length || only(b, a).length) changed = { compared_with: CURRENT_RELEASE, only_in_this_release: only(a, b), only_in_newer_release: only(b, a) };
  }
  return {
    ref: `counter_item:${key}`, item: key, name: itemName(key, lang), ...(Number.isFinite(pd.items[key].cost) ? { cost: pd.items[key].cost } : {}),
    ...versions(pd),
    valve_text: itemText(pd.items[key]).map((x) => x.replace(/\s+/g, ' ').trim()),
    answers: against,
    ...(mech.not_confirmed.length ? { not_confirmed_in_this_release: mech.not_confirmed } : {}),
    ...(changed ? { changed_since_this_release: changed } : {}),
    held_in_this_game: holders(trace, key, seat),
    ...(itemThreats(key, pd.items).length ? { what_others_must_answer_about_it: itemThreats(key, pd.items) } : {}),
    mechanisms: mechanismsUsed(mech.confirmed.map((c) => c.mechanism)),
    note: 'An item answers a mechanism only where its Valve text (or attribute) in this release says so, quoted in valve_says. Abilities listed under does_not_answer give the reason (goes through debuff immunity, not dispellable). An empty answers list means the site\'s list has nothing confirmed for this item, not that it answers nothing.',
    gaps: [...versionGaps(pd), ...COUNTER_GAPS],
  };
}

export function heroCounters(trace, args = {}, ctx = {}) {
  const lang = L(ctx);
  const seat = seatOf(trace, ctx);
  const hk = slugOf(args.hero ?? ctx.perspective); const vk = slugOf(args.against);
  const h = BY_SLUG.get(hk); const v = BY_SLUG.get(vk);
  if (!h || !v || h.id === v.id) return { error: 'unknown_hero', heroes: trace.heroes.map((x) => x.key) };
  const pd = patchForGame(trace.match_id, ctx.match);
  const index = answerIndex(pd);
  const abilitiesOf = (x) => pd.heroAbilities(x.id) ?? [];
  /** How `by`'s abilities (and the items) answer each of `of`'s abilities. */
  const answersTo = (of, by) => abilitiesOf(of).map((a) => {
    const t = abilityThreat(a);
    const mine = abilitiesOf(by).flatMap((b) => abilityAnswers(b.id).map((x) => ({ ...x, ability: b.id, name: b[lang] ?? b.en })));
    const per = Object.entries(t.by_mechanism).filter(([, x]) => x.applies !== 'unknown').map(([m, x]) => {
      if (x.applies === 'no') return { mechanism: m, applies: 'no', why: x.why };
      const abs = mine.filter((y) => y.mechanism === m);
      return { mechanism: m, applies: 'yes', ...(abs.length ? { by_abilities: abs.map((y) => ({ ability: y.ability, name: y.name, on: y.on, ...onlyIf(m, y.on), valve_says: y.valve_says })) } : {}) };
    });
    return { ability: a.id, name: a[lang] ?? a.en, valve_flags: t.flags, ...(t.traits.length ? { traits: t.traits.map((x) => x.trait) } : {}), mechanisms: per, not_known: Object.entries(t.by_mechanism).filter(([, x]) => x.applies === 'unknown').map(([m]) => m) };
  });
  const me = seat ? (ctx.match?.players ?? []).find((p) => p && p.hero_id === BY_SLUG.get(seat.key)?.id) : null;
  const bracket = ctx.match ? reviewBracket(ctx.match.players, me ?? {}) : null;
  const pro = heroVs(h.id, v.id);
  const pub = bracket ? heroVsRank(h.id, v.id, bracket.key) : null;
  const lane = laneMatchup(h.id, v.id);
  const lifts = itemLifts(h.id, v.id).filter((x) => pd.has(x.key));
  const theirs = answersTo(v, h); const mine = answersTo(h, v);
  const byAbility = (xs) => xs.filter((x) => x.mechanisms.some((m) => m.by_abilities?.length));
  return {
    ref: `counter_hero:${hk}:${vk}`, hero: hk, against: vk,
    ...versions(pd),
    // Mechanisms first: which of the hero's abilities answer the other's, and the reverse.
    their_abilities_and_what_answers_them: theirs,
    my_abilities_answer: byAbility(theirs).map((x) => ({ their_ability: x.ability, by: x.mechanisms.flatMap((m) => (m.by_abilities ?? []).map((b) => ({ mechanism: m.mechanism, ability: b.ability, name: b.name, ...(b.only_if ? { only_if: b.only_if } : {}) }))) })),
    their_abilities_answer_mine: byAbility(mine).map((x) => ({ my_ability: x.ability, by: x.mechanisms.flatMap((m) => (m.by_abilities ?? []).map((b) => ({ mechanism: m.mechanism, ability: b.ability, name: b.name, ...(b.only_if ? { only_if: b.only_if } : {}) }))) })),
    my_abilities_flags: mine.map((x) => ({ ability: x.ability, name: x.name, valve_flags: x.valve_flags, ...(x.traits ? { traits: x.traits } : {}) })),
    // Then numbers: association, not cause, each with its source and sample.
    in_pro_games: pro ? { games: pro.n, win_rate: r2(pro.wr), hero_usually: r2(pro.base), matchup: pro.verdict, since: MATCHUP_SOURCE.since, sample_patches_up_to: MATCHUP_SOURCE.patch, fetched: MATCHUP_SOURCE.fetched, source: 'OpenDota explorer, professional matches' } : null,
    in_public_games: pub ? { bracket: pub.bracket, bracket_name: BRACKET_LABEL[pub.bracket]?.[lang] ?? pub.bracket, games: pub.n, win_rate: r2(pub.wr), hero_usually: r2(pub.base), matchup: pub.verdict, patch: RANK_SOURCE.patch, weeks: RANK_SOURCE.weeks, source: RANK_SOURCE.source } : null,
    lane_in_pro_games: lane ? { games: lane.n, core_gold_difference_at_10_00_mean: lane.mean, share_hero_ahead: r2(lane.ahead), matchup: lane.verdict, since: MATCHUP_SOURCE.since } : null,
    items_pros_build_more_against_them: lifts.length ? { since: ITEM_VS_SOURCE.since, fetched: ITEM_VS_SOURCE.fetched, items: lifts.map((x) => ({ item: x.key, name: itemName(x.key, lang), share: x.rate, share_usually: x.base, pro_games: x.n })) } : null,
    // The items whose Valve text (or attribute) confirms each mechanism that answers one of their abilities, once; item_counters quotes the text.
    items_by_mechanism: Object.fromEntries([...new Set(theirs.flatMap((x) => x.mechanisms.filter((m) => m.applies === 'yes').map((m) => m.mechanism)))].map((m) => [m, [...new Set((index[m] ?? []).filter((y) => pd.items[y.item]?.cost > 0).map((y) => y.item))]])),
    mechanisms: mechanismsUsed([...theirs, ...mine].flatMap((x) => x.mechanisms.map((m) => m.mechanism))),
    note: 'Mechanisms are what Valve\'s data states for this release; items_by_mechanism lists the shop items whose Valve text confirms a mechanism (item_counters and ability_counters quote it). A matchup number is how the pairing went over many games — "favoured"/"unfavoured" only when two standard errors from the hero\'s usual rate, "even" otherwise — and is association, not the cause: say which mechanism, if any, explains it, and name the source when you quote it. The public numbers are from STRATZ\'s patch and weeks given, which may be older than this game.',
    gaps: [
      ...versionGaps(pd),
      ...(pro ? [] : [{ topic: 'pro_matchup', reason: 'too_few_pro_games_of_this_pairing' }]),
      ...(pub ? [] : [{ topic: 'public_matchup', reason: bracket ? 'too_few_public_games' : ctx.match ? 'bracket_unknown_for_this_game' : 'no_match_data_for_this_game' }]),
      ...(lane ? [] : [{ topic: 'pro_lane_matchup', reason: 'too_few_pro_games_of_this_lane_pairing' }]),
      ...COUNTER_GAPS,
    ],
  };
}

const HERO = { type: 'string', description: 'Hero key as in match_overview, e.g. "beastmaster".' };
export const COUNTER_TOOLS = [
  {
    name: 'ability_counters',
    description: 'What answers one ability, and what does not, in this game\'s release. The ability\'s Valve flags (damage type, whether it pierces debuff immunity / Black King Bar, how it is dispelled, behaviour) and, per mechanism (debuff immunity, basic or strong dispel, magic resistance, armor, pure damage, break, spell block, true strike vs evasion, true sight vs invisibility, heal reduction): the items whose Valve text confirms it (quoted), who in this game held each and from when, the abilities of this match\'s heroes that answer it — and the mechanisms that do not work on it, with the reason, and those Valve\'s data does not settle. Use it before saying "you should have used X against Y" or that an item would not have helped.',
    input_schema: { type: 'object', properties: { ability: { type: 'string', description: 'Ability key as hero_abilities lists it, e.g. "doom_bringer_doom".' }, hero: { ...HERO, description: 'Optional: the hero the ability belongs to.' } }, required: ['ability'], additionalProperties: false },
    run: abilityCounters,
  },
  {
    name: 'item_counters',
    description: 'What one item answers in this game\'s release, each mechanism with Valve\'s sentence quoted and whom it lands on; against this game\'s enemies: which of their abilities it answers, which it does not (and why — e.g. goes through debuff immunity), which the data does not settle, their items that go through it or that it must answer; who held it in this game; and what changed against the newest release. Use it to judge whether an item would have answered this enemy line-up.',
    input_schema: { type: 'object', properties: { item: { type: 'string', description: 'Item key, e.g. "black_king_bar", "monkey_king_bar".' } }, required: ['item'], additionalProperties: false },
    run: itemCounters,
  },
  {
    name: 'hero_counters',
    description: 'How two heroes answer each other: for each of the other hero\'s abilities its Valve flags and which mechanisms answer it (the hero\'s own abilities that do, with Valve\'s words, and the items that do), the reverse, and — as association, not cause — the pairing in professional games, in public games of the player\'s bracket, the lane in pro games, and the items pros build more against that hero, each with its source and sample. Use it for "why is this hero a problem for mine" — the mechanism first, the numbers second.',
    input_schema: { type: 'object', properties: { hero: { ...HERO, description: 'The hero to read from (usually the player\'s). Defaults to the player\'s.' }, against: { ...HERO, description: 'The other hero.' } }, required: ['against'], additionalProperties: false },
    run: heroCounters,
  },
];
