/** Each hero's ultimate, from Valve's data (lib/coach/data/abilities.json). */
import { createRequire } from 'node:module';
import { HEROES_BY_KEY } from '../../packages/review-engine/src/staticHeroes.js';

const ABILITIES = createRequire(import.meta.url)('../coach/data/abilities.json');

/** The ultimate's entry for a hero key as the replay names it ({ key, en, zh, cd }), or null. */
export function ultimateEntry(heroKey) {
  const id = HEROES_BY_KEY.get(heroKey)?.id;
  return id == null ? null : ABILITIES.ultimates?.[String(id)] ?? null;
}

/** The hero's ultimate key, for "where was the ultimate when she went immune". */
export const ultimateOf = (heroKey) => ultimateEntry(heroKey)?.key ?? null;

/** Every ultimate ability key for a hero (handles multi-ultimate heroes like Dark Willow and Kez; Codex P1 on #464). */
export function ultimatesOf(heroKey) {
  const id = HEROES_BY_KEY.get(heroKey)?.id;
  if (id == null) return [];
  const list = (ABILITIES.heroes?.[String(id)] ?? []).filter((a) => a?.ult && a.id).map((a) => a.id);
  const primary = ABILITIES.ultimates?.[String(id)]?.key;
  if (primary && !list.includes(primary)) list.unshift(primary);
  return list;
}

/** An ultimate with no cooldown in the data (a passive, or one paid for in mana only): "ready" says nothing about it. */
export const hasNoCooldown = (heroKey) => { const u = ultimateEntry(heroKey); return !!u && !(Array.isArray(u.cd) && u.cd.some((c) => c > 0)); };
