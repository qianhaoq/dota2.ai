import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { detectAdvantageSwing, COMEBACK_LEAD_THRESHOLD } from '../../lib/matchReview/advantageSwing.js';
import { buildMatchFact } from '../../lib/matchReview/matchFacts.js';
import type { MatchFact } from '../types/matchReview';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const parsedFixture = JSON.parse(readFileSync(path.join(fixturesDir, 'match9035042364.parsed.json'), 'utf8'));
const unparsedFixture = JSON.parse(readFileSync(path.join(fixturesDir, 'match9035042364.unparsed.json'), 'utf8'));

const HERO_NAMES: Record<number, { nameZh: string; nameEn: string; internalSlug: string }> = {
  9: { nameZh: '米拉娜', nameEn: 'Mirana', internalSlug: 'mirana' },
  14: { nameZh: '帕吉', nameEn: 'Pudge', internalSlug: 'pudge' },
  21: { nameZh: '风行者', nameEn: 'Windranger', internalSlug: 'windrunner' },
  35: { nameZh: '狙击手', nameEn: 'Sniper', internalSlug: 'sniper' },
  41: { nameZh: '虚空假面', nameEn: 'Faceless Void', internalSlug: 'faceless_void' },
  42: { nameZh: '冥魂大帝', nameEn: 'Wraith King', internalSlug: 'skeleton_king' },
  69: { nameZh: '末日使者', nameEn: 'Doom', internalSlug: 'doom_bringer' },
  84: { nameZh: '食人魔魔法师', nameEn: 'Ogre Magi', internalSlug: 'ogre_magi' },
  104: { nameZh: '军团指挥官', nameEn: 'Legion Commander', internalSlug: 'legion_commander' },
  123: { nameZh: '森海飞霞', nameEn: 'Hoodwink', internalSlug: 'hoodwink' },
};

describe('detectAdvantageSwing', () => {
  it('exports the comeback lead threshold', () => {
    expect(COMEBACK_LEAD_THRESHOLD).toBe(5000);
  });

  it('returns null when the advantage array is too short or missing', () => {
    expect(detectAdvantageSwing([], true)).toBeNull();
    expect(detectAdvantageSwing([0, 100, 200, 300], true)).toBeNull();
    expect(detectAdvantageSwing(undefined, false)).toBeNull();
    expect(detectAdvantageSwing(null, true)).toBeNull();
  });

  it('detects a dire-side lead that radiant overturned (comeback)', () => {
    // Dire peaked at +6000 at minute 2; radiant took the lead at minute 4 and won.
    const adv = [0, -1000, -6000, -3000, 500, 4000, 12000];
    expect(detectAdvantageSwing(adv, true)).toEqual({
      loserSide: 'dire',
      loserPeakLead: 6000,
      loserPeakMinute: 2,
      crossoverMinute: 4,
      comeback: true,
    });
  });

  it('counts a peak of exactly the threshold as a comeback', () => {
    const adv = [0, -5000, -2000, 1000, 3000];
    expect(detectAdvantageSwing(adv, true)).toMatchObject({ loserPeakLead: 5000, comeback: true });
    const justUnder = [0, -4999, -2000, 1000, 3000];
    expect(detectAdvantageSwing(justUnder, true)).toMatchObject({ loserPeakLead: 4999, comeback: false });
  });

  it('reports no crossover when the loser stayed ahead in gold until the end', () => {
    // Radiant won despite trailing the whole game (throne race) — no crossover.
    const adv = [-5000, -6000, -4000, -8000, -9000];
    expect(detectAdvantageSwing(adv, true)).toEqual({
      loserSide: 'dire',
      loserPeakLead: 9000,
      loserPeakMinute: 4,
      crossoverMinute: null,
      comeback: true,
    });
  });

  it('is not a comeback when the eventual loser barely led', () => {
    const adv = [0, 184, -7, 37, -537, -227, -312];
    expect(detectAdvantageSwing(adv, false)).toEqual({
      loserSide: 'radiant',
      loserPeakLead: 184,
      loserPeakMinute: 1,
      crossoverMinute: 2,
      comeback: false,
    });
  });

  it('handles a stomp where the loser never led (negative peak)', () => {
    // Dire stomped: radiant (loser) trailed from minute 0, peak is the least-bad minute.
    const adv = [-100, -200, -300, -400, -500];
    expect(detectAdvantageSwing(adv, false)).toMatchObject({
      loserSide: 'radiant',
      loserPeakLead: -100,
      loserPeakMinute: 0,
      crossoverMinute: null,
      comeback: false,
    });
  });

  it('returns a null crossover when the loser peak lead is exactly zero (stomp from minute 0)', () => {
    // OpenDota's radiant_gold_adv[0] is always 0; a dire stomp looks like this.
    // The loser's peak "lead" is that phantom 0 — no crossover may be fabricated.
    const adv = [0, -100, -300, -600, -900];
    expect(detectAdvantageSwing(adv, false)).toEqual({
      loserSide: 'radiant',
      loserPeakLead: 0,
      loserPeakMinute: 0,
      crossoverMinute: null,
      comeback: false,
    });
  });

  it('returns a null crossover when the loser peak lead is negative', () => {
    // Radiant lost while never leading once: no crossover exists to report.
    expect(detectAdvantageSwing([-100, -200, -300, -400, -500], false)).toEqual({
      loserSide: 'radiant',
      loserPeakLead: -100,
      loserPeakMinute: 0,
      crossoverMinute: null,
      comeback: false,
    });
  });
});

describe('detectAdvantageSwing — fixture integration', () => {
  it('finds the (small) radiant peak from the parsed fixture', () => {
    const swing = detectAdvantageSwing(parsedFixture.radiant_gold_adv, parsedFixture.radiant_win);
    // Dire won; radiant's best moment was +184 at minute 1, gone by minute 2.
    expect(swing).toEqual({
      loserSide: 'radiant',
      loserPeakLead: 184,
      loserPeakMinute: 1,
      crossoverMinute: 2,
      comeback: false,
    });
  });

  it('exposes advantageSwing through buildMatchFact for parsed matches', () => {
    const fact = buildMatchFact(parsedFixture, { lang: 'zh', heroId: 104, heroNames: HERO_NAMES }) as MatchFact;
    expect(fact.advantageSwing).toEqual(detectAdvantageSwing(parsedFixture.radiant_gold_adv, parsedFixture.radiant_win));
    expect(fact.advantageSwing?.comeback).toBe(false);
  });

  it('returns null advantageSwing for the unparsed fixture', () => {
    const fact = buildMatchFact(unparsedFixture, { lang: 'zh', heroId: 104, heroNames: HERO_NAMES }) as MatchFact;
    expect(fact.advantageSwing).toBeNull();
  });
});
