import { describe, it, expect } from 'vitest';
import { Attribute, Hero, DraftState } from '../types';
import {
  resolveCoachingLineup,
  buildPracticeUserContext,
  heroDisplayName,
} from './practiceContext';

const invoker: Hero = {
  id: 74,
  name: 'Invoker',
  nameZh: '祈求者',
  nameEn: 'Invoker',
  attribute: Attribute.INTELLIGENCE,
  img: '',
};

const pudge: Hero = {
  id: 14,
  name: 'Pudge',
  nameZh: '帕吉',
  nameEn: 'Pudge',
  attribute: Attribute.STRENGTH,
  img: '',
};

const crystalMaiden: Hero = {
  id: 5,
  name: 'Crystal Maiden',
  nameZh: '水晶室女',
  nameEn: 'Crystal Maiden',
  attribute: Attribute.INTELLIGENCE,
  img: '',
};

const emptyDraft: DraftState = { radiant: [], dire: [] };

describe('heroDisplayName', () => {
  it('prefers Chinese name in zh', () => {
    expect(heroDisplayName(invoker, 'zh')).toBe('祈求者');
  });

  it('prefers English name in en', () => {
    expect(heroDisplayName(invoker, 'en')).toBe('Invoker');
  });
});

describe('resolveCoachingLineup', () => {
  it('seeds practiceHero into empty radiant (default ally side)', () => {
    const lineup = resolveCoachingLineup(emptyDraft, 'radiant', invoker);

    expect(lineup.seeded).toBe(true);
    expect(lineup.radiant).toEqual([invoker]);
    expect(lineup.dire).toEqual([]);
    expect(lineup.allies).toEqual([invoker]);
    expect(lineup.focusHeroId).toBe(74);
  });

  it('seeds practiceHero into empty dire when that side is selected', () => {
    const lineup = resolveCoachingLineup(emptyDraft, 'dire', invoker);

    expect(lineup.seeded).toBe(true);
    expect(lineup.dire).toEqual([invoker]);
    expect(lineup.radiant).toEqual([]);
    expect(lineup.allies).toEqual([invoker]);
    expect(lineup.focusHeroId).toBe(74);
  });

  it('seeds into empty radiant even if dire already has enemies', () => {
    const draft: DraftState = { radiant: [], dire: [pudge] };
    const lineup = resolveCoachingLineup(draft, 'radiant', invoker);

    expect(lineup.seeded).toBe(true);
    expect(lineup.radiant).toEqual([invoker]);
    expect(lineup.dire).toEqual([pudge]);
    expect(lineup.allies).toEqual([invoker]);
    expect(lineup.enemies).toEqual([pudge]);
    expect(lineup.focusHeroId).toBe(74);
  });

  it('does not overwrite an existing ally draft', () => {
    const draft: DraftState = { radiant: [pudge, crystalMaiden], dire: [] };
    const lineup = resolveCoachingLineup(draft, 'radiant', invoker);

    expect(lineup.seeded).toBe(false);
    expect(lineup.radiant).toEqual([pudge, crystalMaiden]);
    expect(lineup.allies).toEqual([pudge, crystalMaiden]);
    expect(lineup.focusHeroId).toBeUndefined();
  });

  it('does not duplicate practiceHero already on the ally side', () => {
    const draft: DraftState = { radiant: [invoker, pudge], dire: [] };
    const lineup = resolveCoachingLineup(draft, 'radiant', invoker);

    expect(lineup.seeded).toBe(false);
    expect(lineup.radiant).toEqual([invoker, pudge]);
    expect(lineup.focusHeroId).toBe(74);
  });

  it('does not seed when practiceHero is already on the enemy side', () => {
    const draft: DraftState = { radiant: [], dire: [invoker] };
    const lineup = resolveCoachingLineup(draft, 'radiant', invoker);

    expect(lineup.seeded).toBe(false);
    expect(lineup.radiant).toEqual([]);
    expect(lineup.dire).toEqual([invoker]);
    expect(lineup.focusHeroId).toBeUndefined();
  });

  it('leaves lineup empty when there is no practice hero and no draft', () => {
    const lineup = resolveCoachingLineup(emptyDraft, 'radiant', null);

    expect(lineup.seeded).toBe(false);
    expect(lineup.radiant).toEqual([]);
    expect(lineup.dire).toEqual([]);
    expect(lineup.focusHeroId).toBeUndefined();
  });
});

describe('buildPracticeUserContext', () => {
  it('returns undefined when no practice hero and no extra text', () => {
    expect(buildPracticeUserContext(null, 'zh')).toBeUndefined();
  });

  it('passes through extra text when no practice hero', () => {
    expect(buildPracticeUserContext(null, 'zh', '分析当前阵容')).toBe('分析当前阵容');
  });

  it('prefixes zh practice-hero teaching focus', () => {
    expect(buildPracticeUserContext(invoker, 'zh')).toBe(
      '练习英雄：祈求者。请以该英雄为学员焦点教学。'
    );
  });

  it('prefixes en practice-hero teaching focus', () => {
    expect(buildPracticeUserContext(invoker, 'en')).toBe(
      "Practice hero: Invoker. Teach this hero as the student's focus."
    );
  });

  it('appends user extra text after the practice prefix', () => {
    expect(buildPracticeUserContext(invoker, 'zh', '这把怎么抢线')).toBe(
      '练习英雄：祈求者。请以该英雄为学员焦点教学。 这把怎么抢线'
    );
  });
});
