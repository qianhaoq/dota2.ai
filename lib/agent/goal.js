/**
 * A next-game goal from a replay review: one thing the next game can be
 * checked on, with the same judge as every other goal (lib/coach/goals.js
 * evaluateGoal).
 *
 * The model only chooses: the kind, for a build goal which items, and which
 * finding it belongs to. Code decides whether that choice is allowed and
 * writes the numbers and the wording:
 * - hold_item: only items professionals build on this hero (pro_item_choices)
 *   that the player never held this game;
 * - fewer_deaths: a third fewer deaths per ten minutes than this game (the
 *   engine's own rule), from the replay's death count and length.
 * Anything else is no goal, not a made-up one.
 */
import { createRequire } from 'node:module';
import { STATIC_HEROES } from '../../packages/review-engine/src/staticHeroes.js';
import { matchOverview } from '../../packages/review-engine/src/trace/index.js';
import { proItemChoices } from './knowledgeTools.js';

const ITEM_NAMES = createRequire(import.meta.url)('../coach/data/names.json').items;
const BY_SLUG = new Map(Object.values(STATIC_HEROES).map((h) => [h.internalSlug, h]));
const r1 = (n) => Math.round(n * 10) / 10;
const MAX_ITEMS = 3;

export const GOAL_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['kind', 'finding'],
  description: 'One thing the player\'s NEXT game can be checked on, tied to one of your findings. Omit if neither kind fits.',
  properties: {
    kind: { type: 'string', enum: ['hold_item', 'fewer_deaths'], description: 'hold_item: finish next game holding one of `items` — only when a finding is about the build. fewer_deaths: die clearly less often per ten minutes — when a finding is about dying.' },
    items: { type: 'array', maxItems: MAX_ITEMS, items: { type: 'string' }, description: 'For hold_item: item keys exactly as pro_item_choices lists them (e.g. "blink", "black_king_bar"), ones the player never held.' },
    finding: { type: 'integer', minimum: 1, description: 'Which finding (1-based) this goal answers.' },
  },
};

/**
 * @param {any} pick  the model's `goal`
 * @param {{ trace: any, hero: string, findings: number }} o
 * @returns {{ finding: number, spec: object } | null}
 */
export function goalFromReview(pick, { trace, hero, findings }) {
  if (!pick || typeof pick !== 'object') return null;
  const finding = Number.isInteger(pick.finding) && pick.finding >= 1 && pick.finding <= findings ? pick.finding : null;
  const h = BY_SLUG.get(hero);
  if (finding == null || !h) return null;
  if (pick.kind === 'hold_item') {
    const pro = proItemChoices(trace, { hero });
    if (pro.error) return null;
    const allowed = new Set([...(pro.mid_game_items?.items ?? []), ...pro.built_more_against_these_enemies].filter((i) => i.player_first_held == null).map((i) => i.item));
    const items = [...new Set((Array.isArray(pick.items) ? pick.items : []).map((k) => String(k).replace(/^item_/, '')))].filter((k) => allowed.has(k) && ITEM_NAMES[k]).slice(0, MAX_ITEMS);
    if (!items.length) return null;
    return {
      finding,
      spec: {
        kind: 'hold_item', items, hero_id: h.id,
        label: { en: `On ${h.nameEn}: finish with ${items.map((k) => ITEM_NAMES[k].en).join(' or ')}`, zh: `用${h.nameZh}时：出一件${items.map((k) => ITEM_NAMES[k].zh).join('或')}` },
      },
    };
  }
  if (pick.kind === 'fewer_deaths') {
    const o = matchOverview(trace);
    const minutes = (o.duration?.t ?? 0) / 60;
    const deaths = o.heroes.find((x) => x.hero === hero)?.deaths ?? 0;
    if (minutes < 10 || deaths < 3) return null;
    const max = Math.max(1, r1(((deaths / minutes) * 10) * 0.67));
    return { finding, spec: { kind: 'deaths_per10_max', max, label: { en: `At most ${max} deaths per 10 minutes`, zh: `每 10 分钟死亡不超过 ${max} 次` } } };
  }
  return null;
}
