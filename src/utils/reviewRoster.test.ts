import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Attribute, Hero } from '../types';
import type { MatchFact } from '../types/matchReview';
import { buildMatchFact } from '../../lib/matchReview/matchFacts.js';
import { isHeroInMatch, rosterFromMatchFact } from './reviewRoster';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/match8985182860.json'), 'utf8')
);

const HERO_NAMES_CN: Record<number, { nameZh: string; nameEn: string }> = {
  54: { nameZh: '噬魂鬼', nameEn: 'Lifestealer' },
  86: { nameZh: '拉比克', nameEn: 'Rubick' },
  2: { nameZh: '斧王', nameEn: 'Axe' },
};

const ls: Hero = {
  id: 54,
  name: 'Lifestealer',
  nameZh: '噬魂鬼',
  nameEn: 'Lifestealer',
  attribute: Attribute.STRENGTH,
  img: '',
  icon: 'ls.png',
};

const rubick: Hero = {
  id: 86,
  name: 'Rubick',
  nameZh: '拉比克',
  nameEn: 'Rubick',
  attribute: Attribute.INTELLIGENCE,
  img: '',
  icon: 'rubick.png',
};

describe('rosterFromMatchFact', () => {
  const fact = buildMatchFact(fixture, { lang: 'zh', heroNames: HERO_NAMES_CN }) as MatchFact;

  it('lists only heroes who played match 8985182860', () => {
    const roster = rosterFromMatchFact(fact, [ls, rubick]);
    const ids = roster.map((e) => e.player.heroId);
    expect(ids).toContain(54);
    expect(ids).toContain(86);
    expect(ids).toHaveLength(10);
    expect(roster.find((e) => e.player.heroId === 54)?.hero?.nameZh).toBe('噬魂鬼');
    expect(roster.every((e) => e.player.heroId > 0)).toBe(true);
  });

  it('keeps unmatched players without dropping them', () => {
    const roster = rosterFromMatchFact(fact, [ls]);
    const axe = roster.find((e) => e.player.heroId === 2);
    expect(axe?.hero).toBeNull();
    expect(axe?.player.displayName).toBeTruthy();
  });

  it('returns empty when fact is missing', () => {
    expect(rosterFromMatchFact(null, [ls])).toEqual([]);
  });
});

describe('isHeroInMatch', () => {
  const fact = buildMatchFact(fixture, { lang: 'zh', heroNames: HERO_NAMES_CN }) as MatchFact;

  it('accepts 噬魂鬼 and rejects a hero who sat out', () => {
    expect(isHeroInMatch(fact, 54)).toBe(true);
    expect(isHeroInMatch(fact, 1)).toBe(false);
    expect(isHeroInMatch(fact, '')).toBe(false);
  });
});
