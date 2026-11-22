/**
 * Knowledge tools for the review agent: what the repository's data snapshots
 * say about heroes and items, so the model never has to recall game facts.
 *
 * - hero_abilities: Valve's own ability flags (damage type, whether it goes
 *   through spell immunity, how it is dispelled), lib/coach/data/abilities.json.
 * - pro_item_choices: the finished items professional players build on a hero
 *   in the mid game and the ones they build clearly more often against each
 *   enemy of this match (hero-items.json, item-vs.json), next to when the
 *   player first held each.
 *
 * Pro data is association, not proof, and is not the player's rank bracket:
 * every answer says so and carries its sample size.
 */
import { createRequire } from 'node:module';
import { STATIC_HEROES } from '../../packages/review-engine/src/staticHeroes.js';
import { itemTimeline } from '../../packages/review-engine/src/trace/index.js';
import { ITEM_VS_SOURCE, itemLifts } from '../coach/matchups.js';

const require = createRequire(import.meta.url);
const ABILITIES = require('../coach/data/abilities.json');
const HERO_ITEMS = require('../coach/data/hero-items.json');
const ITEM_NAMES = require('../coach/data/names.json').items;

const BY_SLUG = new Map(Object.values(STATIC_HEROES).map((h) => [h.internalSlug, h]));
const slugOf = (hero) => String(hero ?? '').trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s-]+/g, '_');
const DMG = { P: 'physical', M: 'magical', U: 'pure' };
const share = (n, d) => Math.round((n / d) * 100) / 100;
const itemName = (key, lang) => ITEM_NAMES[key]?.[lang] ?? key;

export function heroAbilities(_trace, args = {}, ctx = {}) {
  const hero = BY_SLUG.get(slugOf(args.hero));
  const list = hero ? ABILITIES.heroes?.[String(hero.id)] : null;
  if (!Array.isArray(list)) return { error: 'unknown_hero' };
  const lang = ctx.lang === 'zh' ? 'zh' : 'en';
  const ult = ABILITIES.ultimates?.[String(hero.id)];
  return {
    ref: `abilities:${hero.internalSlug}`, hero: hero.internalSlug, patch: ABILITIES.patch, source: ABILITIES.source,
    abilities: list.map((a) => ({
      ability: a.id, name: a[lang] ?? a.en, ...(a.ult ? { ultimate: true } : {}),
      ...(a.dmg ? { damage_type: DMG[a.dmg] } : {}),
      // Absent means Valve's data does not say; it is not "no".
      ...(typeof a.pierces === 'boolean' ? { goes_through_spell_immunity: a.pierces } : {}),
      ...(a.dispel ? { dispelled_by: a.dispel } : {}),
      ...(a.ult && ult?.key === a.id && Array.isArray(ult.cd) ? { cooldown_by_level: ult.cd } : {}),
    })),
    note: 'Flags describe the ability as Valve lists it. What happened in this game comes from the replay tools.',
  };
}

export function proItemChoices(trace, args = {}, ctx = {}) {
  const slug = slugOf(args.hero);
  const seat = trace.heroes.find((h) => h.key === slug);
  const hero = BY_SLUG.get(slug);
  if (!seat || !hero) return { error: 'unknown_hero', heroes: trace.heroes.map((h) => h.key) };
  const lang = ctx.lang === 'zh' ? 'zh' : 'en';
  const held = new Map(itemTimeline(trace, { hero: slug }).items.map((i) => [i.item, i.first_held.clock]));
  const bought = (key) => ({ item: key, name: itemName(key, lang), player_first_held: held.get(key) ?? null });
  const row = HERO_ITEMS.heroes?.[String(hero.id)];
  const against = [];
  for (const e of trace.heroes.filter((h) => h.team !== seat.team)) {
    const enemy = BY_SLUG.get(e.key);
    for (const x of enemy ? itemLifts(hero.id, enemy.id) : []) against.push({ enemy: e.key, ...bought(x.key), share_of_pro_games_against_this_enemy: x.rate, share_usually: x.base, pro_games: x.n });
  }
  return {
    ref: `pro_items:${slug}`, hero: slug,
    mid_game_items: row ? { pro_games: row.games, window: 'finished between 10:00 and 24:59', source: HERO_ITEMS.source, items: row.items.map((i) => ({ ...bought(i.key), share_of_pro_games: share(i.n, row.games) })) } : null,
    built_more_against_these_enemies: against,
    ...(against.length ? { against_source: `professional matches since ${ITEM_VS_SOURCE.since}` } : {}),
    note: 'Professional games, not this player\'s rank. A share is how often pros built the item, not proof it wins. player_first_held null = the player never held it.',
    gaps: [...(row ? [] : [{ topic: 'pro_mid_game_items', reason: 'no_pro_sample_for_hero' }]), { topic: 'rank_bracket_items', reason: 'only_professional_games_measured' }],
  };
}

const HERO = { type: 'string', description: 'Hero key as in match_overview, e.g. "beastmaster".' };
export const KNOWLEDGE_TOOLS = [
  {
    name: 'hero_abilities',
    description: "Valve's data on a hero's abilities for the current patch: which is the ultimate, damage type, whether it goes through spell immunity (Black King Bar), how it is dispelled. Look here before saying what an ability can or cannot do — yours or an enemy's.",
    input_schema: { type: 'object', properties: { hero: HERO }, required: ['hero'], additionalProperties: false },
    run: heroAbilities,
  },
  {
    name: 'pro_item_choices',
    description: 'What professional players build on this hero: the finished mid-game items with how often, and the items they build clearly more often against each enemy hero of this match — each next to when this player first held it (null = never). Use it to judge the build; say it is pro data when you quote it.',
    input_schema: { type: 'object', properties: { hero: HERO }, required: ['hero'], additionalProperties: false },
    run: proItemChoices,
  },
];
