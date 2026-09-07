import type { Language } from '../types';
import type { ReviewProSuggestion, ReviewPublicSuggestion, ReviewSuggestion } from '../services/dotaApiService';

export function formatSuggestionDuration(seconds: number, lang: Language): string {
  const mins = Math.floor((seconds || 0) / 60);
  if (mins <= 0) return lang === 'zh' ? '进行中' : 'Live';
  return lang === 'zh' ? `${mins}分钟` : `${mins}m`;
}

export function formatSuggestionTitle(suggestion: ReviewSuggestion, lang: Language): string {
  if (suggestion.kind === 'recent') {
    const pro = suggestion as ReviewProSuggestion;
    return `${pro.radiantTeam} vs ${pro.direTeam}`;
  }
  const pub = suggestion as ReviewPublicSuggestion;
  const radiant = pub.radiantHeroNames.slice(0, 2).join(', ');
  const dire = pub.direHeroNames.slice(0, 2).join(', ');
  if (radiant || dire) {
    const vs = lang === 'zh' ? ' vs ' : ' vs ';
    return `${radiant || '—'}${vs}${dire || '—'}`;
  }
  return pub.mmrLabel || (lang === 'zh' ? '高分对局' : 'High MMR');
}

export function formatSuggestionSubtitle(suggestion: ReviewSuggestion, lang: Language): string {
  const duration = formatSuggestionDuration(suggestion.duration, lang);
  if (suggestion.kind === 'recent') {
    const pro = suggestion as ReviewProSuggestion;
    const league = pro.leagueName?.trim() || (lang === 'zh' ? '职业比赛' : 'Pro match');
    return `${league} · ${duration}`;
  }
  const pub = suggestion as ReviewPublicSuggestion;
  const mmr = pub.mmrLabel || (lang === 'zh' ? '高分' : 'High MMR');
  return `${mmr} · ${duration}`;
}
