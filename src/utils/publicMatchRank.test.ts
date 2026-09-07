import { describe, expect, it } from 'vitest';
import {
  comparePublicMatchesBySkill,
  formatRankTierLabel,
  isPlausibleAvgMmr,
  isReviewableHighMmrPublicMatch,
  resolvePublicMatchSkill,
  selectReviewHighMmrPublicMatches,
} from '../../lib/matchReview/publicMatchRank.js';

describe('publicMatchRank', () => {
  it('does not treat avg_rank_tier as MMR', () => {
    expect(isPlausibleAvgMmr(51)).toBe(false);
    expect(isPlausibleAvgMmr(7000)).toBe(true);

    const skill = resolvePublicMatchSkill({ avg_rank_tier: 51 }, 'zh');
    expect(skill.avgMmr).toBeNull();
    expect(skill.mmrLabel).toBe('传奇 I');
    expect(skill.mmrLabel).not.toBe('普通局');
  });

  it('formats rank tier medals with stars', () => {
    expect(formatRankTierLabel(75, 'zh')).toBe('超凡 V');
    expect(formatRankTierLabel(75, 'en')).toBe('Divine 5');
    expect(formatRankTierLabel(64, 'zh')).toBe('万古 IV');
    expect(formatRankTierLabel(80, 'zh')).toBe('冠绝一世');
  });

  it('uses MMR bracket labels when avg_mmr is present', () => {
    const skill = resolvePublicMatchSkill({ avg_mmr: 7200, avg_rank_tier: 75 }, 'zh');
    expect(skill.avgMmr).toBe(7200);
    expect(skill.mmrLabel).toBe('万分局');
  });

  it('filters short, turbo, and low-rank public matches', () => {
    const lowRank = {
      match_id: 1,
      duration: 1200,
      game_mode: 22,
      avg_rank_tier: 45,
      radiant_team: [1, 2, 3, 4, 5],
      dire_team: [6, 7, 8, 9, 10],
    };
    const turbo = {
      match_id: 2,
      duration: 1200,
      game_mode: 23,
      avg_rank_tier: 75,
      radiant_team: [1, 2, 3, 4, 5],
      dire_team: [6, 7, 8, 9, 10],
    };
    const tooShort = {
      match_id: 3,
      duration: 400,
      game_mode: 22,
      avg_rank_tier: 75,
      radiant_team: [1, 2, 3, 4, 5],
      dire_team: [6, 7, 8, 9, 10],
    };
    const divine = {
      match_id: 4,
      duration: 1100,
      game_mode: 22,
      avg_rank_tier: 75,
      radiant_team: [1, 2, 3, 4, 5],
      dire_team: [6, 7, 8, 9, 10],
    };

    expect(isReviewableHighMmrPublicMatch(lowRank)).toBe(false);
    expect(isReviewableHighMmrPublicMatch(turbo)).toBe(false);
    expect(isReviewableHighMmrPublicMatch(tooShort)).toBe(false);
    expect(isReviewableHighMmrPublicMatch(divine)).toBe(true);
  });

  it('sorts and caps high-MMR review suggestions', () => {
    const matches = [
      { match_id: 1, duration: 900, game_mode: 22, avg_rank_tier: 61, radiant_team: [1], dire_team: [2] },
      { match_id: 2, duration: 1000, game_mode: 22, avg_rank_tier: 75, radiant_team: [1], dire_team: [2] },
      { match_id: 3, duration: 1100, game_mode: 22, avg_rank_tier: 73, radiant_team: [1], dire_team: [2] },
    ];

    const selected = selectReviewHighMmrPublicMatches(matches, 2);
    expect(selected.map((m: { match_id: number }) => m.match_id)).toEqual([2, 3]);
    expect(comparePublicMatchesBySkill(matches[1], matches[0])).toBeLessThan(0);
  });
});
