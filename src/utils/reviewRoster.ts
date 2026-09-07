import { Hero } from '../types';
import type { MatchFact, MatchPlayerFact } from '../types/matchReview';

export interface ReviewRosterEntry {
  player: MatchPlayerFact;
  hero: Hero | null;
}

/** 从 MatchFact 抽出本局十人，并挂上本地英雄图/名（缺图时仍保留选手数据） */
export function rosterFromMatchFact(
  fact: MatchFact | null | undefined,
  allHeroes: Hero[]
): ReviewRosterEntry[] {
  if (!fact?.players?.length) return [];
  const byId = new Map(allHeroes.map((h) => [h.id, h]));
  return fact.players.map((player) => ({
    player,
    hero: byId.get(player.heroId) ?? null,
  }));
}

export function isHeroInMatch(fact: MatchFact | null | undefined, heroId: number | '' | undefined): boolean {
  if (!fact || heroId === '' || heroId == null) return false;
  return fact.players.some((p) => p.heroId === Number(heroId));
}
