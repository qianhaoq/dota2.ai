/** OpenDota publicMatches: avg_rank_tier is medal*10+stars (10–15 Herald … 80+ Immortal). */

export const REVIEW_HIGH_MMR_MIN_RANK_TIER = 60; // Ancient 1
export const REVIEW_HIGH_MMR_MIN_DURATION_SEC = 600; // 10 minutes — drops abandoned / in-progress listings
export const REVIEW_HIGH_MMR_EXCLUDED_GAME_MODES = new Set([23]); // Turbo

const MEDAL_ZH = ['', '先锋', '卫士', '中军', '统帅', '传奇', '万古', '超凡', '冠绝'];
const MEDAL_EN = ['', 'Herald', 'Guardian', 'Crusader', 'Archon', 'Legend', 'Ancient', 'Divine', 'Immortal'];

const STAR_ZH = ['', 'I', 'II', 'III', 'IV', 'V'];
const STAR_EN = ['', '1', '2', '3', '4', '5'];

/** True when value looks like OpenDota avg_mmr (not rank_tier accidentally passed in). */
export function isPlausibleAvgMmr(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1000;
}

export function parseRankTier(rankTier) {
  const tier = Number(rankTier);
  if (!Number.isFinite(tier) || tier <= 0) {
    return { medal: 0, stars: 0, valid: false };
  }
  const medal = Math.min(Math.floor(tier / 10), MEDAL_EN.length - 1);
  const stars = Math.min(Math.max(tier % 10, 0), 5);
  return { medal, stars, valid: medal > 0 };
}

export function formatRankTierLabel(rankTier, lang = 'zh') {
  const { medal, stars, valid } = parseRankTier(rankTier);
  if (!valid) return '';
  const isZh = lang === 'zh';
  const medalName = (isZh ? MEDAL_ZH : MEDAL_EN)[medal] || '';
  if (!medalName) return '';
  if (medal >= 8) {
    return isZh ? '冠绝一世' : 'Immortal';
  }
  if (stars > 0) {
    const starLabel = (isZh ? STAR_ZH : STAR_EN)[stars] || String(stars);
    return isZh ? `${medalName} ${starLabel}` : `${medalName} ${starLabel}`;
  }
  return medalName;
}

export function formatMmrBracketLabel(avgMmr, lang = 'zh') {
  const isZh = lang === 'zh';
  if (avgMmr >= 8000) return isZh ? '冠绝局' : 'Immortal';
  if (avgMmr >= 7000) return isZh ? '万分局' : 'Divine+';
  if (avgMmr >= 6000) return isZh ? '高分局' : 'Ancient+';
  if (avgMmr >= 5000) return isZh ? '中高分局' : 'Legend+';
  return isZh ? '排位局' : 'Ranked';
}

export function resolvePublicMatchSkill(match, lang = 'zh') {
  const avgMmrRaw = match?.avg_mmr;
  const rankTier = match?.avg_rank_tier;

  if (isPlausibleAvgMmr(avgMmrRaw)) {
    return {
      avgMmr: avgMmrRaw,
      avgRankTier: typeof rankTier === 'number' ? rankTier : null,
      mmrLabel: formatMmrBracketLabel(avgMmrRaw, lang),
    };
  }

  const tierLabel = formatRankTierLabel(rankTier, lang);
  return {
    avgMmr: null,
    avgRankTier: typeof rankTier === 'number' ? rankTier : null,
    mmrLabel: tierLabel,
  };
}

export function hasPublicMatchHeroes(match) {
  const radiant = match?.radiant_team;
  const dire = match?.dire_team;
  const ids = [...(Array.isArray(radiant) ? radiant : []), ...(Array.isArray(dire) ? dire : [])];
  return ids.some((id) => Number(id) > 0);
}

export function isReviewableHighMmrPublicMatch(match, options = {}) {
  const {
    minRankTier = REVIEW_HIGH_MMR_MIN_RANK_TIER,
    minDurationSec = REVIEW_HIGH_MMR_MIN_DURATION_SEC,
    excludedGameModes = REVIEW_HIGH_MMR_EXCLUDED_GAME_MODES,
  } = options;

  if (!match?.match_id) return false;
  if (!hasPublicMatchHeroes(match)) return false;

  const duration = Number(match.duration) || 0;
  if (duration < minDurationSec) return false;

  const gameMode = Number(match.game_mode);
  if (excludedGameModes.has(gameMode)) return false;

  const rankTier = Number(match.avg_rank_tier) || 0;
  const avgMmr = match.avg_mmr;
  if (isPlausibleAvgMmr(avgMmr)) {
    return avgMmr >= 5000;
  }

  return rankTier >= minRankTier;
}

export function comparePublicMatchesBySkill(a, b) {
  const aMmr = isPlausibleAvgMmr(a?.avg_mmr) ? a.avg_mmr : 0;
  const bMmr = isPlausibleAvgMmr(b?.avg_mmr) ? b.avg_mmr : 0;
  if (aMmr !== bMmr) return bMmr - aMmr;

  const aTier = Number(a?.avg_rank_tier) || 0;
  const bTier = Number(b?.avg_rank_tier) || 0;
  if (aTier !== bTier) return bTier - aTier;

  return (Number(b?.duration) || 0) - (Number(a?.duration) || 0);
}

export function selectReviewHighMmrPublicMatches(matches, limit, options = {}) {
  return (matches || [])
    .filter((match) => isReviewableHighMmrPublicMatch(match, options))
    .sort(comparePublicMatchesBySkill)
    .slice(0, limit);
}
