import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { buildMatchFact, parseMatchId, matchFactToPrompt } from '../../lib/matchReview/matchFacts.js';
import { LANE_CLUSTER_SOURCE } from '../../lib/matchReview/laneResolver.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/match8985182860.json'), 'utf8')
);

const HERO_NAMES_CN: Record<number, { nameZh: string; nameEn: string }> = {
  54: { nameZh: '噬魂鬼', nameEn: 'Lifestealer' },
  86: { nameZh: '拉比克', nameEn: 'Rubick' },
  2: { nameZh: '斧王', nameEn: 'Axe' },
  71: { nameZh: '裂魂人', nameEn: 'Spirit Breaker' },
  42: { nameZh: '冥魂大帝', nameEn: 'Wraith King' },
  123: { nameZh: '森海飞霞', nameEn: 'Hoodwink' },
  18: { nameZh: '斯温', nameEn: 'Sven' },
  9: { nameZh: '米拉娜', nameEn: 'Mirana' },
  90: { nameZh: '光之守卫', nameEn: 'Keeper of the Light' },
  88: { nameZh: '司夜刺客', nameEn: 'Nyx Assassin' },
};

describe('parseMatchId', () => {
  it('parses raw numeric id', () => {
    expect(parseMatchId('8985182860')).toBe(8985182860);
  });

  it('parses OpenDota URL', () => {
    expect(parseMatchId('https://www.opendota.com/matches/8985182860')).toBe(8985182860);
  });

  it('parses Dotabuff URL', () => {
    expect(parseMatchId('https://www.dotabuff.com/matches/8985182860')).toBe(8985182860);
  });
});

describe('buildMatchFact', () => {
  const fact = buildMatchFact(fixture, { lang: 'zh', heroId: 54, heroNames: HERO_NAMES_CN });

  it('includes summary and lane inference label', () => {
    expect(fact.summary.matchId).toBe(8985182860);
    expect(fact.laneInferenceLabelZh).toBe('根据录像站位推断');
    expect(fact.laneSource).toBe(LANE_CLUSTER_SOURCE);
    expect(fact.grounded).toBe(true);
  });

  it('builds focus lens for selected hero without OpenDota lane fields', () => {
    expect(fact.focusLens?.heroId).toBe(54);
    expect(fact.focusLens?.laneLabel).toBe('下路');
    expect(fact.focusLens?.opponents.map((o: { heroId: number }) => o.heroId)).toEqual([2]);
    expect(fact.focusLens?.nearby.map((o: { heroId: number }) => o.heroId)).toContain(71);
  });

  it('includes economy checkpoints and timeline', () => {
    expect(fact.economy.checkpoints.length).toBeGreaterThan(0);
    expect(fact.timeline.length).toBeGreaterThan(0);
  });

  it('prompt excludes raw opendota lane fields', () => {
    const prompt = matchFactToPrompt(fact, 'zh');
    expect(prompt).toContain('根据录像站位推断');
    expect(prompt).toContain('噬魂鬼');
    expect(prompt).not.toMatch(/lane_role/);
    expect(prompt).not.toMatch(/opendotaLane/);
  });

  it('prompt uses English labels when lang=en', () => {
    const factEn = buildMatchFact(fixture, { lang: 'en', heroId: 54, heroNames: HERO_NAMES_CN });
    const prompt = matchFactToPrompt(factEn, 'en');
    expect(prompt).toContain('Radiant');
    expect(prompt).toContain('Dire');
    expect(prompt).toContain('net worth');
    expect(prompt).not.toContain('天辉');
    expect(prompt).not.toContain('夜魇');
  });

  it('is not grounded when lane_pos data is insufficient', () => {
    const noLanes = buildMatchFact({
      ...fixture,
      players: fixture.players.map((p: { lane_pos: unknown }) => ({ ...p, lane_pos: {} })),
    }, {
      lang: 'zh',
      heroNames: HERO_NAMES_CN,
    });
    expect(noLanes.grounded).toBe(false);
    expect(noLanes.laneDataAvailable).toBe(false);
  });

  it('is not grounded when only a few players have lane_pos', () => {
    const partial = buildMatchFact({
      ...fixture,
      players: fixture.players.map((p: { lane_pos?: unknown }, i: number) => ({
        ...p,
        lane_pos: i < 2 ? p.lane_pos : {},
      })),
    }, {
      lang: 'zh',
      heroNames: HERO_NAMES_CN,
    });
    expect(partial.grounded).toBe(false);
    expect(partial.laneDataAvailable).toBe(false);
    expect(partial.laneSource).toBe('lane_pos_unavailable');
  });
});
