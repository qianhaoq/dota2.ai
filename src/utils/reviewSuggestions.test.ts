import { describe, expect, it } from 'vitest';
import {
  formatSuggestionDuration,
  formatSuggestionSubtitle,
  formatSuggestionTitle,
} from './reviewSuggestions';
import type { ReviewProSuggestion, ReviewPublicSuggestion } from '../services/dotaApiService';

const proSuggestion: ReviewProSuggestion = {
  kind: 'recent',
  matchId: 8987146774,
  startTime: 1788775966,
  duration: 2120,
  radiantWin: false,
  radiantTeam: 'PowerRangers',
  direTeam: 'Natus Vincere',
  leagueName: 'EPL Masters 2026',
  opendotaUrl: 'https://www.opendota.com/matches/8987146774',
};

const publicSuggestion: ReviewPublicSuggestion = {
  kind: 'highMmr',
  matchId: 8987197531,
  startTime: 1788779026,
  duration: 1100,
  radiantWin: true,
  avgMmr: null,
  mmrLabel: '超凡 V',
  radiantHeroNames: ['Windranger', 'Slark'],
  direHeroNames: ['Pudge', 'Invoker'],
  opendotaUrl: 'https://www.opendota.com/matches/8987197531',
};

describe('reviewSuggestions formatting', () => {
  it('formats pro match title and subtitle', () => {
    expect(formatSuggestionTitle(proSuggestion, 'zh')).toBe('PowerRangers vs Natus Vincere');
    expect(formatSuggestionSubtitle(proSuggestion, 'zh')).toContain('EPL Masters 2026');
    expect(formatSuggestionSubtitle(proSuggestion, 'zh')).toContain('35分钟');
  });

  it('formats public match title from hero names', () => {
    expect(formatSuggestionTitle(publicSuggestion, 'en')).toBe('Windranger, Slark vs Pudge, Invoker');
    expect(formatSuggestionSubtitle(publicSuggestion, 'zh')).toBe('超凡 V · 18分钟');
    expect(formatSuggestionSubtitle(
      { ...publicSuggestion, mmrLabel: 'Divine 5' },
      'en',
    )).toBe('Divine 5 · 18m');
  });

  it('formats live duration', () => {
    expect(formatSuggestionDuration(0, 'zh')).toBe('进行中');
    expect(formatSuggestionDuration(0, 'en')).toBe('Live');
  });
});
