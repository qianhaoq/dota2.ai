/**
 * build_for_plan: the player's big items against the plans, so a review can
 * say whether what they bought served what they went for — "you said lanes
 * into towers; your first item for it came at 31:16, after 9,300 gold of
 * other items".
 *
 * Big items are read as power_spikes reads them (this game's patch, the same
 * rule). What each serves comes from ./planItems.js: Valve's own line for the
 * effect, and the site's reading of which plan that effect serves. An item not
 * in that list is not classified, never "for nothing". Prices are this game's
 * patch's.
 */
import { createRequire } from 'node:module';
import { itemTimeline } from '../../packages/review-engine/src/trace/index.js';
import { ALWAYS_KEY_ITEMS, KEY_ITEM_MIN_COST } from '../coach/knowledge.js';
import { isBigItemIn, patchForGame } from './patchData.js';
import { PLAN_ITEMS, PLAN_ITEM_EFFECT } from './planItems.js';
import { PLAN_KEYS, planByKey, planKey } from './plans.js';

const ITEM_NAMES = createRequire(import.meta.url)('../coach/data/names.json').items;
/** The moments the gold is counted at, as clocks a sentence may state. */
const MARKS = [15, 25];
const slugOf = (hero) => String(hero ?? '').trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s-]+/g, '_');

export function buildForPlan(trace, args = {}, ctx = {}) {
  const slug = slugOf(args.hero);
  const seat = trace.heroes.find((h) => h.key === slug);
  if (!seat) return { error: 'unknown_hero', heroes: trace.heroes.map((h) => h.key) };
  if (args.plan != null && !planKey(args.plan)) return { error: 'unknown_plan', plans: PLAN_KEYS };
  const lang = ctx.lang === 'zh' ? 'zh' : 'en';
  const pd = patchForGame(trace.match_id, ctx.match);
  const end = trace.t0 + trace.n - 1;
  const items = (itemTimeline(trace, { hero: slug }).items ?? [])
    .filter((i) => isBigItemIn(pd, i.item, { minCost: KEY_ITEM_MIN_COST, always: ALWAYS_KEY_ITEMS }))
    .sort((a, b) => a.first_held.t - b.first_held.t)
    .map((i) => {
      const cls = PLAN_ITEMS[i.item];
      const cost = Number.isFinite(pd.items[i.item]?.cost) ? pd.items[i.item].cost : null;
      return {
        ref: i.ref, item: i.item, name: ITEM_NAMES[i.item]?.[lang] ?? ITEM_NAMES[i.item]?.en ?? i.item,
        first_held: i.first_held.clock, t: i.first_held.t, cost,
        // Valve's line that puts it under a plan, quoted as Valve wrote it (English).
        ...(cls ? { serves: cls.plans, valve_says: cls.quote } : { serves: [] }),
      };
    });
  const by = (t) => items.filter((i) => i.t <= t);
  const gold = (list, plan) => list.filter((i) => (plan ? i.serves.includes(plan) : true) && i.cost != null).reduce((a, i) => a + i.cost, 0);
  const perPlan = (f) => Object.fromEntries(PLAN_KEYS.map((p) => [p, f(p)]));
  const first = (plan) => items.find((i) => i.serves.includes(plan)) ?? null;
  const marks = MARKS.filter((m) => m * 60 <= end);

  const stated = planByKey(planKey(args.plan));
  const mine = stated ? items.filter((i) => i.serves.includes(stated.key)) : [];
  const total = gold(items);
  return {
    // The plan is in the ref: the record says more with one, and the same ref must open the same record.
    ref: `build_plan:${slug}${stated ? `:${stated.key}` : ''}`, ref_scope: 'summary', hero: slug, data_patch: pd.name,
    // The moments gold is counted at below, as game times a sentence may state.
    measured_at: marks.map((m) => `${m}:00`),
    big_items_total: items.length,
    gold_in_big_items: total,
    // One map per measure, keyed by plan: the tool's own numbers, which a sentence may quote.
    gold_in_items_for_each_plan: perPlan((p) => gold(items, p)),
    ...Object.fromEntries(marks.map((m) => [`gold_in_items_for_each_plan_by_${m}_00`, perPlan((p) => gold(by(m * 60), p))])),
    first_item_for_each_plan: perPlan((p) => first(p)?.first_held ?? null),
    what_each_plan_s_items_do: PLAN_ITEM_EFFECT,
    ...(stated ? {
      stated_plan: {
        plan: stated.key, name: stated.label[lang], its_items_do: PLAN_ITEM_EFFECT[stated.key],
        items_for_it: mine.map(({ t, ...i }) => i),
        // Flat, so the summary covers them: a sentence may state when the first one came.
        first_item_for_it: mine[0]?.item ?? null, first_item_for_it_name: mine[0]?.name ?? null, first_item_for_it_at: mine[0]?.first_held ?? null,
        // Gold put into other big items before the first one for it: what came first.
        gold_in_other_big_items_before_it: mine[0] ? gold(items.filter((i) => i.t < mine[0].t)) : total,
        share_of_big_item_gold_for_it: total > 0 ? Math.round((gold(mine) / total) * 100) / 100 : null,
      },
    } : {}),
    items: items.map(({ t, ...i }) => i),
    rule: 'big items as power_spikes reads them; an item serves a plan when Valve\'s text for it states the effect (valve_says) — the site\'s reading of which plan that effect serves. An item with serves: [] is not classified, not useless.',
    note: 'Gold is each item\'s price in this game\'s patch, counted when the hero first held it. Items are not the whole of a plan: where the player was and what the team did are in tempo_report and window_report.',
    gaps: [
      { topic: 'items_not_in_the_list', reason: 'not_classified_by_the_site' },
      ...(pd.exact ? [] : [{ topic: 'item_data_of_this_game_patch', reason: `${pd.reason}; ${pd.name} data used` }]),
    ],
  };
}

export const BUILD_FOR_PLAN_TOOL = {
  name: 'build_for_plan',
  description: "The player's big items against the four plans (push: lanes into towers; gank: ganks and pressure; split: split push; late: farm for late): each item with when it was first held, its price, and which plan its own effect serves with Valve's line for it; the gold in items for each plan by 15:00, by 25:00 and in all; the first item for each plan. With `plan` (the plan the player named), also the items for it, the first one and when, the gold in other big items before it, and its share of the big-item gold. Use it for whether what the player bought served what they went for.",
  input_schema: {
    type: 'object',
    properties: { hero: { type: 'string', description: 'Hero key as in match_overview. Use the player\'s hero.' }, plan: { type: 'string', enum: [...PLAN_KEYS], description: 'The plan the player named, if they did.' } },
    required: ['hero'], additionalProperties: false,
  },
  run: buildForPlan,
};

