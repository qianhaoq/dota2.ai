import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildThreeConclusions } from '../../lib/matchReview/threeConclusions.js';
import { derivePrimaryDeathPattern } from '../../lib/matchReview/deathTimeline.js';
import { buildMatchFact } from '../../lib/matchReview/matchFacts.js';
import type { MatchFact } from '../types/matchReview';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const goldFixture = JSON.parse(readFileSync(path.join(fixturesDir, 'match8985182860.json'), 'utf8'));
const unparsedFixture = JSON.parse(readFileSync(path.join(fixturesDir, 'match9035042364.unparsed.json'), 'utf8'));

const HERO_NAMES_8985: Record<number, { nameZh: string; nameEn: string; internalSlug: string }> = {
  54: { nameZh: '噬魂鬼', nameEn: 'Lifestealer', internalSlug: 'life_stealer' },
  86: { nameZh: '拉比克', nameEn: 'Rubick', internalSlug: 'rubick' },
  2: { nameZh: '斧王', nameEn: 'Axe', internalSlug: 'axe' },
  71: { nameZh: '裂魂人', nameEn: 'Spirit Breaker', internalSlug: 'spirit_breaker' },
  42: { nameZh: '冥魂大帝', nameEn: 'Wraith King', internalSlug: 'skeleton_king' },
  123: { nameZh: '森海飞霞', nameEn: 'Hoodwink', internalSlug: 'hoodwink' },
  18: { nameZh: '斯温', nameEn: 'Sven', internalSlug: 'sven' },
  9: { nameZh: '米拉娜', nameEn: 'Mirana', internalSlug: 'mirana' },
  90: { nameZh: '光之守卫', nameEn: 'Keeper of the Light', internalSlug: 'keeper_of_the_light' },
  88: { nameZh: '司夜刺客', nameEn: 'Nyx Assassin', internalSlug: 'nyx_assassin' },
};

const HERO_NAMES_9035: Record<number, { nameZh: string; nameEn: string; internalSlug: string }> = {
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

describe('buildThreeConclusions — gold sample 8985182860 (en)', () => {
  const fact = buildMatchFact(goldFixture, { lang: 'en', heroId: 54, heroNames: HERO_NAMES_8985 }) as MatchFact;
  const conclusions = buildThreeConclusions(fact, { lang: 'en' });

  it('exposes the focus side outcome derived from summary.radiantWin', () => {
    // Lifestealer is Radiant and Radiant lost.
    expect(conclusions.outcome).toBe('loss');
  });

  it('turningPoint reports the detected lead flip with gold swing and window deaths', () => {
    const tp = conclusions.turningPoint;
    expect(tp.status).toBe('ok');
    expect(tp.title).toBe('Turning point');
    expect(tp.summary).toContain('29:00');
    expect(tp.summary).toContain('from +2358 at min 22 to -1032 at min 29');
    // 11 derived Radiant deaths fall in the 22–29 min window; 3 within 30s.
    expect(tp.summary).toContain('11 Radiant deaths were recorded in the min 22-29 window (3 within 30s)');
    expect(tp.summary).toContain('That swing went against your team.');
    // Vision/positioning is not in MatchFact — must never be claimed.
    expect(tp.summary).not.toMatch(/vision|no vision|without vision/i);

    const times = tp.evidence.map((e) => e.time);
    expect(times).toContain('22:00');
    expect(times).toContain('29:00');
    const leadEvidence = tp.evidence.filter((e) => e.source === 'advantageSwing');
    expect(leadEvidence).toHaveLength(2);
    expect(leadEvidence[0].text).toBe('Radiant gold lead +2358 (min 22)');
    expect(leadEvidence[1].text).toBe('Radiant gold lead -1032 (min 29)');
    expect(tp.evidence.some((e) => e.source === 'timeline' && e.text.includes('Radiant lost bot T1 tower'))).toBe(true);
    expect(tp.evidence.some((e) => e.source === 'deathTimeline' && e.text.includes('Keeper of the Light died'))).toBe(true);
  });

  it('topMistake derives the repeated-phase death pattern with timestamps', () => {
    const tm = conclusions.topMistake;
    expect(tm.status).toBe('ok');
    expect(tm.title).toBe('Top mistake');
    expect(tm.summary).toBe("Lifestealer's death pattern: 6 of 9 recorded deaths came in the late game (25+ min) — review those timestamps first.");
    expect(tm.evidence.map((e) => e.time)).toEqual(['25:09', '28:38', '40:48', '48:44', '49:48', '52:05']);
    expect(tm.evidence.every((e) => e.source === 'deathTimeline')).toBe(true);
    expect(tm.evidence[0].text).toContain('Lifestealer died (killed by Nyx Assassin');
  });

  it('nextGameRule states the lane rule backed by lane matchup + 10-min checkpoints', () => {
    const rule = conclusions.nextGameRule;
    expect(rule.status).toBe('ok');
    expect(rule.title).toBe('Next-game rule');
    expect(rule.summary).toContain('Laning rule vs Axe:');
    expect(rule.summary).toContain('40 CS');
    expect(rule.summary).toContain('your team was 975 gold ahead at 10 min');
    expect(rule.evidence).toEqual([
      { time: '10:00', text: 'CS @10 min: 40', source: 'players' },
      { time: '10:00', text: 'Team gold lead @10 min: +975', source: 'economy' },
      { time: null, text: 'Lane opponents: Axe', source: 'focusLens' },
    ]);
  });

  it('followUps omit the item preset (no item facts) and keep the fact-backed ones', () => {
    // MatchFact carries no itemTimings here, so the vague "Why build this item?"
    // preset is omitted entirely instead of pointing at nothing.
    expect(conclusions.followUps).toEqual([
      'Why did we lose the fight at 29:00?',
      'Where should support stand in the Bot lane here?',
    ]);
  });
});

describe('buildThreeConclusions — gold sample 8985182860 (zh)', () => {
  const fact = buildMatchFact(goldFixture, { lang: 'zh', heroId: 54, heroNames: HERO_NAMES_8985 }) as MatchFact;
  const conclusions = buildThreeConclusions(fact, { lang: 'zh' });

  it('localizes titles and summaries', () => {
    expect(conclusions.turningPoint.title).toBe('转折点');
    expect(conclusions.turningPoint.summary).toContain('29:00 经济优势易手：天辉从 22 分钟的 +2358 变为 29 分钟的 -1032。');
    expect(conclusions.topMistake.title).toBe('最大问题');
    expect(conclusions.topMistake.summary).toContain('6 次集中在后期');
    expect(conclusions.nextGameRule.title).toBe('下一局规则');
    expect(conclusions.nextGameRule.summary).toContain('对线规则——面对 斧王');
    expect(conclusions.nextGameRule.summary).toContain('我方领先 975 金');
    expect(conclusions.nextGameRule.evidence[2].text).toBe('对线对手：斧王');
  });

  it('followUps use the zh presets tailored to facts', () => {
    expect(conclusions.followUps).toEqual([
      '29:00 那波团为什么输？',
      '辅助下路这段该怎么站？',
    ]);
  });
});

describe('buildThreeConclusions — fallback adverse swing (9035042364 parsed, en)', () => {
  // No lead flip in this match (radiant's best moment was +184), so the
  // turning point falls back to the largest one-minute gold swing adverse to
  // the focus side — NOT the absolute max, which was radiant's late -13863 →
  // -8124 recovery that explains nothing about the loss.
  const fact = buildMatchFact(
    JSON.parse(readFileSync(path.join(fixturesDir, 'match9035042364.parsed.json'), 'utf8')),
    { lang: 'en', heroId: 104, heroNames: HERO_NAMES_9035 },
  ) as MatchFact;
  const conclusions = buildThreeConclusions(fact, { lang: 'en' });

  it('exposes the focus side outcome', () => {
    // Legion Commander is Radiant and Radiant lost.
    expect(conclusions.outcome).toBe('loss');
  });

  it('turningPoint picks the biggest adverse swing, never the losing side\'s recovery', () => {
    const tp = conclusions.turningPoint;
    expect(tp.status).toBe('ok');
    expect(tp.summary).toContain('44:00 — the biggest one-minute gold swing against Radiant: Radiant went from -21378 to -25798.');
    // The -13863 → -8124 recovery at 57:00 must not be presented as the loss driver.
    expect(tp.summary).not.toContain('57:00');
    expect(tp.summary).toContain('That swing went against your team.');
    expect(tp.evidence.filter((e) => e.source === 'economy').map((e) => e.time)).toEqual(['43:00', '44:00']);
  });

  it('topMistake derives the behind-deaths pattern', () => {
    const tm = conclusions.topMistake;
    expect(tm.status).toBe('ok');
    expect(tm.summary).toContain('10 of 11 recorded deaths came while your team was more than 1000 gold behind');
    expect(tm.evidence[0].time).toBe('14:05');
  });

  it('followUps ask about the wipe-backed fight at the adverse minute', () => {
    // 4 Radiant deaths within 30s in minute 44 prove the fight; the question
    // may name it. The late-game recovery minute is never referenced.
    expect(conclusions.followUps).toEqual([
      'Why did we lose the fight at 44:00?',
      'Where should support stand in the Top lane here?',
    ]);
  });
});

describe('buildThreeConclusions — insufficient cases', () => {
  it('marks every conclusion insufficient on the unparsed fixture (zh)', () => {
    const fact = buildMatchFact(unparsedFixture, { lang: 'zh', heroId: 104, heroNames: HERO_NAMES_9035 }) as MatchFact;
    const conclusions = buildThreeConclusions(fact, { lang: 'zh' });
    expect(conclusions.turningPoint.status).toBe('insufficient');
    expect(conclusions.turningPoint.summary).toContain('数据不足');
    expect(conclusions.topMistake.status).toBe('insufficient');
    expect(conclusions.topMistake.summary).toContain('数据不足');
    expect(conclusions.nextGameRule.status).toBe('insufficient');
    expect(conclusions.nextGameRule.summary).toContain('数据不足');
    for (const key of ['turningPoint', 'topMistake', 'nextGameRule'] as const) {
      expect(conclusions[key].evidence).toEqual([]);
      expect(conclusions[key].title).toBeTruthy();
    }
    // Presets still exist for the follow-up chips: no swing and no item facts,
    // so both are omitted rather than invented.
    expect(conclusions.outcome).toBe('loss'); // radiantWin + focus side are known facts even when unparsed
    expect(conclusions.followUps).toEqual(['这局的关键节点在哪里？', '辅助这段该怎么站？']);
  });

  it('topMistake/nextGameRule need a focus hero even on a fully parsed match (en)', () => {
    const fact = buildMatchFact(goldFixture, { lang: 'en', heroNames: HERO_NAMES_8985 }) as MatchFact;
    const conclusions = buildThreeConclusions(fact, { lang: 'en' });
    expect(fact.focusHeroId).toBeNull();
    expect(conclusions.outcome).toBeNull();
    expect(conclusions.turningPoint.status).toBe('ok');
    expect(conclusions.topMistake.status).toBe('insufficient');
    expect(conclusions.topMistake.summary).toContain('Insufficient data');
    expect(conclusions.nextGameRule.status).toBe('insufficient');
    expect(conclusions.nextGameRule.summary).toContain('Insufficient data');
    // No focus side ⇒ the wipe-backed fight is asked about neutrally, and the
    // support question loses its lane detail.
    expect(conclusions.followUps).toEqual([
      'What happened in the fight at 29:00?',
      'Where should support stand here?',
    ]);
  });

  it('survives null facts with explicit insufficient markers (en default)', () => {
    const conclusions = buildThreeConclusions(null as never);
    expect(conclusions.outcome).toBeNull();
    expect(conclusions.turningPoint.status).toBe('insufficient');
    expect(conclusions.topMistake.status).toBe('insufficient');
    expect(conclusions.topMistake.summary).toContain('Insufficient data');
    expect(conclusions.nextGameRule.status).toBe('insufficient');
    expect(conclusions.followUps).toEqual([
      'What was the decisive moment of this game?',
      'Where should support stand here?',
    ]);
  });

  it('distinguishes an available timeline with too few deaths from a missing one', () => {
    // Parsed match, whole roster at 0 kills / 0 deaths: the death timeline is
    // available but has nothing to derive a pattern from — and the flat gold
    // curve has no turning point either.
    const quiet = buildMatchFact({
      match_id: 7,
      duration: 1200,
      radiant_win: true,
      radiant_gold_adv: [0, 50, 100, 80, 120, 90],
      od_data: { has_parsed: true },
      players: Array.from({ length: 10 }, (_, i) => ({
        hero_id: i + 1,
        player_slot: i < 5 ? i : 128 + i - 5,
        kills: 0,
        deaths: 0,
        kills_log: [],
      })),
      objectives: [],
    }, {
      lang: 'en',
      heroId: 1,
      heroNames: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [
        i + 1,
        { nameZh: `英雄${i}`, nameEn: `Hero${i}`, internalSlug: `h${i}` },
      ])),
    }) as MatchFact;
    const conclusions = buildThreeConclusions(quiet, { lang: 'en' });
    expect(quiet.deathTimelineAvailable).toBe(true);
    expect(conclusions.topMistake.status).toBe('insufficient');
    expect(conclusions.topMistake.summary).toBe('Insufficient data — fewer than two recorded deaths, so no death pattern can be derived');
    expect(conclusions.turningPoint.status).toBe('insufficient');
    expect(conclusions.turningPoint.summary).toBe('Insufficient data — no single minute moved the gold lead enough to mark a turning point');
  });

  it('defaults to English without opts', () => {
    const fact = buildMatchFact(goldFixture, { lang: 'en', heroId: 54, heroNames: HERO_NAMES_8985 }) as MatchFact;
    expect(buildThreeConclusions(fact).turningPoint.title).toBe('Turning point');
  });
});

describe('buildThreeConclusions — itemization rule when item timings exist', () => {
  it('derives an item rule conditioned on the enemy lineup and tailors the item follow-up', () => {
    const fact = buildMatchFact(goldFixture, { lang: 'en', heroId: 54, heroNames: HERO_NAMES_8985 }) as MatchFact;
    // MatchFact does not carry item timings today; when it does, the rule
    // switches to itemization. Simulate that future fact shape.
    (fact.players.find((p) => p.heroId === 54) as unknown as { itemTimings: Array<{ time: number; key: string }> })
      .itemTimings = [{ time: 1500, key: 'black_king_bar' }];

    const conclusions = buildThreeConclusions(fact, { lang: 'en' });
    const rule = conclusions.nextGameRule;
    expect(rule.status).toBe('ok');
    expect(rule.summary).toContain('Itemization vs this enemy lineup');
    expect(rule.summary).toContain('your first tracked item (black_king_bar) arrived at 25:00');
    const lineup = rule.evidence.find((e) => e.text.startsWith('Enemy lineup:'));
    expect(lineup?.text).toContain('Nyx Assassin');
    expect(lineup?.time).toBeNull();
    expect(rule.evidence[0]).toEqual({ time: '25:00', text: 'Item: black_king_bar', source: 'players' });
    expect(conclusions.followUps[0]).toBe('Why build black_king_bar at 25:00?');
  });
});

describe('buildThreeConclusions — next-game rule gold-lead wording (deficit / lead / even)', () => {
  // Lifestealer is Radiant, so the min-10 radiantGoldLead IS teamGold10.
  // Only that checkpoint is overridden; everything else comes from the gold
  // fixture, so the numbers are the data's, not hand-typed.
  const baseFact = buildMatchFact(goldFixture, { lang: 'en', heroId: 54, heroNames: HERO_NAMES_8985 }) as MatchFact;
  const withTeamGold10 = (fact: MatchFact, lead: number) =>
    ({
      ...fact,
      economy: {
        ...fact.economy,
        checkpoints: (fact.economy?.checkpoints ?? []).map((c) =>
          c?.minute === 10 ? { ...c, radiantGoldLead: lead } : c,
        ),
      },
    }) as MatchFact;
  const summaryFor = (lead: number, lang: 'en' | 'zh') =>
    buildThreeConclusions(withTeamGold10(baseFact, lead), { lang }).nextGameRule.summary;

  it('en deficit: absolute gold behind with a thousands separator, never a "lead"', () => {
    const summary = summaryFor(-2060, 'en');
    expect(summary).toContain('this game you had 40 CS and your team was 2,060 gold behind at 10 min.');
    expect(summary).not.toContain('gold lead');
    expect(summary).not.toContain('-2060');
  });

  it('en lead: gold ahead, still thousands-separated', () => {
    const summary = summaryFor(12345, 'en');
    expect(summary).toContain('your team was 12,345 gold ahead at 10 min.');
    expect(summary).not.toContain('+12345');
  });

  it('en even: team gold was even', () => {
    expect(summaryFor(0, 'en')).toContain('this game you had 40 CS and team gold was even at 10 min.');
  });

  it('zh deficit: 我方落后 with plain digits', () => {
    const summary = summaryFor(-2060, 'zh');
    expect(summary).toContain('本局 10 分钟时你的补刀为 40、我方落后 2060 金。');
    expect(summary).not.toContain('经济差');
    expect(summary).not.toContain('2,060');
  });

  it('zh lead: 我方领先 with plain digits', () => {
    expect(summaryFor(975, 'zh')).toContain('我方领先 975 金');
  });

  it('zh even: 双方经济持平', () => {
    expect(summaryFor(0, 'zh')).toContain('补刀为 40、双方经济持平。');
  });

  it('keeps the signed evidence lines untouched', () => {
    const rule = buildThreeConclusions(withTeamGold10(baseFact, -2060), { lang: 'en' }).nextGameRule;
    expect(rule.evidence[1]).toEqual({ time: '10:00', text: 'Team gold lead @10 min: -2060', source: 'economy' });
    const ruleZh = buildThreeConclusions(withTeamGold10(baseFact, -2060), { lang: 'zh' }).nextGameRule;
    expect(ruleZh.evidence[1]).toEqual({ time: '10:00', text: '10 分钟我方经济差：-2060', source: 'economy' });
  });
});

describe('derivePrimaryDeathPattern', () => {  it('returns the dominant same-phase bucket', () => {
    const pattern = derivePrimaryDeathPattern([
      { time: 300, killerHeroId: 1, teamGoldLeadAtT: null },
      { time: 500, killerHeroId: 2, teamGoldLeadAtT: null },
      { time: 2000, killerHeroId: 3, teamGoldLeadAtT: null },
    ]);
    expect(pattern).toMatchObject({ pattern: 'phase_repeat', phase: 'lane', totalDeaths: 3 });
    expect(pattern?.events).toHaveLength(2);
  });

  it('prefers phase_repeat on ties with repeat_killer', () => {
    const pattern = derivePrimaryDeathPattern([
      { time: 300, killerHeroId: 1, teamGoldLeadAtT: null },
      { time: 400, killerHeroId: 1, teamGoldLeadAtT: null },
    ]);
    expect(pattern?.pattern).toBe('phase_repeat');
  });

  it('falls back to repeat_killer when deaths span phases', () => {
    const pattern = derivePrimaryDeathPattern([
      { time: 300, killerHeroId: 7, teamGoldLeadAtT: null },
      { time: 700, killerHeroId: 7, teamGoldLeadAtT: null },
      { time: 1600, killerHeroId: 8, teamGoldLeadAtT: null },
    ]);
    expect(pattern).toMatchObject({ pattern: 'repeat_killer', killerHeroId: 7, totalDeaths: 3 });
  });

  it('falls back to behind_deaths when phases and killers differ', () => {
    const pattern = derivePrimaryDeathPattern([
      { time: 300, killerHeroId: 1, teamGoldLeadAtT: -1200 },
      { time: 700, killerHeroId: 2, teamGoldLeadAtT: -2500 },
    ]);
    expect(pattern).toMatchObject({ pattern: 'behind_deaths', totalDeaths: 2 });
  });

  it('requires a real lead deficit for behind_deaths', () => {
    expect(derivePrimaryDeathPattern([
      { time: 300, killerHeroId: 1, teamGoldLeadAtT: -999 },
      { time: 700, killerHeroId: 2, teamGoldLeadAtT: -500 },
    ])).toBeNull();
  });

  it('returns null for fewer than two usable events', () => {
    expect(derivePrimaryDeathPattern([])).toBeNull();
    expect(derivePrimaryDeathPattern([{ time: 100, killerHeroId: 1 }])).toBeNull();
    expect(derivePrimaryDeathPattern(null as never)).toBeNull();
  });
});

describe('buildThreeConclusions — winning focus picks a favorable swing (9035042364 parsed, Doom/Dire)', () => {
  const fact = buildMatchFact(
    JSON.parse(readFileSync(path.join(fixturesDir, 'match9035042364.parsed.json'), 'utf8')),
    { lang: 'en', heroId: 69, heroNames: HERO_NAMES_9035 },
  ) as MatchFact;
  const conclusions = buildThreeConclusions(fact, { lang: 'en' });

  it('never presents the opponent recovery as the turning point of a win', () => {
    expect(conclusions.outcome).toBe('win');
    const tp = conclusions.turningPoint;
    expect(tp.status).toBe('ok');
    expect(tp.summary).not.toContain('57:00');
    expect(tp.summary).not.toContain('against Dire');
    expect(tp.summary).not.toContain('went against your team');
  });
});

describe('buildThreeConclusions — death timeline failure reason', () => {
  const base = buildMatchFact(goldFixture, { lang: 'en', heroId: 54, heroNames: HERO_NAMES_8985 }) as MatchFact;
  const withReason = (reason: string) => ({
    ...base,
    deathTimelineAvailable: false,
    fieldReasons: { ...(base as any).fieldReasons, deaths: { reason, message: 'x' } },
  }) as unknown as MatchFact;

  it('reports parsed-but-unmapped instead of "not parsed yet"', () => {
    const tm = buildThreeConclusions(withReason('incomplete_hero_map'), { lang: 'en' }).topMistake;
    expect(tm.status).toBe('insufficient');
    expect(tm.summary).toContain('replay parsed');
    expect(tm.summary).not.toContain('not parsed yet');
  });

  it('still says not parsed yet when that is the real reason (zh)', () => {
    const tm = buildThreeConclusions(withReason('not_parsed_yet'), { lang: 'zh' }).topMistake;
    expect(tm.summary).toContain('录像尚未解析');
  });
});
