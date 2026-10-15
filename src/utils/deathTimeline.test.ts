import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildDeathTimeline } from '../../lib/matchReview/deathTimeline.js';
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

const HERO_SLUG_BY_ID: Record<number, string> = Object.fromEntries(
  Object.entries(HERO_NAMES).map(([id, info]) => [Number(id), info.internalSlug])
);

interface DeathEvent {
  time: number;
  minute: number;
  killerHeroId: number | null;
  killerIsRadiant: boolean | null;
  teamGoldLeadAtT: number | null;
}

describe('buildDeathTimeline — parsed fixture', () => {
  const timeline = buildDeathTimeline(parsedFixture.players, parsedFixture.radiant_gold_adv, HERO_SLUG_BY_ID);

  it('is available and derives deaths for the whole roster', () => {
    expect(timeline.available).toBe(true);
    expect(Object.keys(timeline.deathsByHeroId || {})).toHaveLength(10);
    expect(Object.keys(timeline.coverage || {})).toHaveLength(10);
  });

  it('keeps derived count within reported deaths for every player', () => {
    for (const p of parsedFixture.players) {
      const coverage = timeline.coverage![p.hero_id];
      expect(coverage.reportedDeaths).toBe(p.deaths);
      expect(coverage.derivedCount).toBe((timeline.deathsByHeroId![p.hero_id] || []).length);
      // Fixture anomaly: hero 42's scoreboard deaths is 7, but the combat log
      // records 8 hero kills on it — the 8th lands at t=3715, exactly the match
      // duration (final tick), which the scoreboard did not count. Events are
      // reported honestly instead of being trimmed to fit the stat.
      const ceiling = p.hero_id === 42 ? coverage.reportedDeaths! + 1 : coverage.reportedDeaths!;
      expect(coverage.derivedCount).toBeLessThanOrEqual(ceiling);
    }
  });

  it('does not fabricate deaths that only creeps/towers could explain', () => {
    // Hoodwink (123) and Doom (69) each died once without a hero killer.
    expect(timeline.coverage![123].derivedCount).toBe(timeline.coverage![123].reportedDeaths! - 1);
    expect(timeline.coverage![69].derivedCount).toBe(timeline.coverage![69].reportedDeaths! - 1);
  });

  it('derives Legion Commander deaths with killer and victim-perspective gold lead', () => {
    const events = timeline.deathsByHeroId![104] as DeathEvent[];
    expect(events).toHaveLength(11);
    // LC (radiant) was first killed by Sniper at 6:30 while radiant was 312 behind.
    expect(events[0]).toEqual({
      time: 390,
      minute: 6,
      killerHeroId: 35,
      killerIsRadiant: false,
      teamGoldLeadAtT: -312,
    });
    expect(events[events.length - 1]).toEqual({
      time: 3041,
      minute: 50,
      killerHeroId: 123,
      killerIsRadiant: false,
      teamGoldLeadAtT: -26167,
    });
  });

  it('sorts events by time and keeps each event self-consistent', () => {
    const rosterIds = new Set(parsedFixture.players.map((p: { hero_id: number }) => p.hero_id));
    for (const events of Object.values(timeline.deathsByHeroId!) as DeathEvent[][]) {
      const times = events.map((e) => e.time);
      expect(times).toEqual([...times].sort((a, b) => a - b));
      for (const e of events) {
        expect(e.minute).toBe(Math.floor(e.time / 60));
        expect(rosterIds.has(e.killerHeroId as number)).toBe(true);
      }
    }
    // Dire victims get the mirrored (negated) gold lead: WK died at minute 17
    // while radiant led by 5725, so from WK's team perspective it is +5725.
    const wk = (timeline.deathsByHeroId![42] as DeathEvent[])[0];
    expect(wk).toEqual({
      time: 1049,
      minute: 17,
      killerHeroId: 104,
      killerIsRadiant: true,
      teamGoldLeadAtT: 5725,
    });
  });
});

describe('buildDeathTimeline — unparsed fixture', () => {
  it('returns available:false when no player has kills_log', () => {
    const timeline = buildDeathTimeline(unparsedFixture.players, unparsedFixture.radiant_gold_adv, HERO_SLUG_BY_ID);
    expect(timeline).toEqual({ available: false });
  });

  it('surfaces empty death fields with a fieldReasons.deaths entry via buildMatchFact', () => {
    const fact = buildMatchFact(unparsedFixture, { lang: 'zh', heroId: 104, heroNames: HERO_NAMES }) as MatchFact;
    expect(fact.deathTimelineAvailable).toBe(false);
    expect(fact.advantageSwing).toBeNull();
    for (const p of fact.players) {
      expect(p.deathEvents).toEqual([]);
      expect(p.deathsDerivedCount).toBe(0);
    }
    expect(fact.focusLens?.deathEvents).toEqual([]);
    expect(fact.fieldReasons?.deaths?.reason).toBe('not_parsed_yet');
    expect(fact.fieldReasons?.deaths?.message).toContain('死亡时间线');
    expect(fact.fieldReasons?.deaths?.message).toContain('尚未解析');
  });

  it('localizes the death timeline field reason in English', () => {
    const fact = buildMatchFact(unparsedFixture, { lang: 'en', heroNames: HERO_NAMES }) as MatchFact;
    expect(fact.fieldReasons?.deaths?.message).toContain('Death timeline');
    expect(fact.fieldReasons?.deaths?.message).toMatch(/not parsed yet/i);
  });
});

describe('buildDeathTimeline — synthetic', () => {
  const mkPlayer = (over: Record<string, unknown>) => ({
    hero_id: 1,
    player_slot: 0,
    deaths: 0,
    kills_log: [],
    ...over,
  });

  it('accepts full npc_dota_hero_ prefixed slugs in heroSlugById', () => {
    const players = [
      mkPlayer({ hero_id: 1, player_slot: 0, kills_log: [{ time: 100, key: 'npc_dota_hero_axe' }] }),
      mkPlayer({ hero_id: 2, player_slot: 128, deaths: 1, kills_log: [] }),
    ];
    const timeline = buildDeathTimeline(players, [], { 1: 'npc_dota_hero_antimage', 2: 'npc_dota_hero_axe' });
    expect(timeline.available).toBe(true);
    expect(timeline.deathsByHeroId![2]).toEqual([
      { time: 100, minute: 1, killerHeroId: 1, killerIsRadiant: true, teamGoldLeadAtT: null },
    ]);
  });

  it('falls back to player hero_name when heroSlugById is not provided', () => {
    const players = [
      mkPlayer({ hero_id: 1, player_slot: 0, hero_name: 'npc_dota_hero_lina', kills_log: [{ time: 65, key: 'npc_dota_hero_axe' }] }),
      mkPlayer({ hero_id: 2, player_slot: 128, deaths: 2, hero_name: 'npc_dota_hero_axe', kills_log: [] }),
    ];
    const timeline = buildDeathTimeline(players, []);
    expect(timeline.deathsByHeroId![2]).toHaveLength(1);
    expect(timeline.coverage![2]).toEqual({ derivedCount: 1, reportedDeaths: 2 });
  });

  it('skips victims that cannot be mapped to a hero', () => {
    const players = [
      mkPlayer({ hero_id: 1, player_slot: 0, kills_log: [
        { time: 100, key: 'npc_dota_hero_nevermore' },
        { time: 200, key: 'npc_dota_hero_axe' },
      ] }),
      mkPlayer({ hero_id: 2, player_slot: 128, deaths: 1, hero_name: 'npc_dota_hero_axe', kills_log: [] }),
    ];
    const timeline = buildDeathTimeline(players, []);
    expect(timeline.deathsByHeroId![2]).toHaveLength(1);
    expect(timeline.coverage![1]).toEqual({ derivedCount: 0, reportedDeaths: 0 });
  });

  it('mirrors the gold lead for dire victims and nulls it when adv is missing', () => {
    const players = [
      mkPlayer({ hero_id: 3, player_slot: 128, kills_log: [
        { time: 60, key: 'npc_dota_hero_rubick' }, // radiant victim, minute 1
        { time: 120, key: 'npc_dota_hero_axe' }, // dire victim, minute 2
      ] }),
      mkPlayer({ hero_id: 1, player_slot: 0, hero_name: 'npc_dota_hero_rubick', kills_log: [] }),
      mkPlayer({ hero_id: 2, player_slot: 129, hero_name: 'npc_dota_hero_axe', kills_log: [] }),
    ];
    const adv = [500, 600, 700, 800];
    const timeline = buildDeathTimeline(players, adv);
    expect(timeline.deathsByHeroId![1][0].teamGoldLeadAtT).toBe(600);
    expect(timeline.deathsByHeroId![2][0].teamGoldLeadAtT).toBe(-700);

    const noAdv = buildDeathTimeline(players, []);
    expect(noAdv.deathsByHeroId![1][0].teamGoldLeadAtT).toBeNull();
    // Minute beyond the adv array is also null.
    const shortAdv = buildDeathTimeline(players, [500]);
    expect(shortAdv.deathsByHeroId![2][0].teamGoldLeadAtT).toBeNull();
  });

  it('sorts events across killers by time', () => {
    const players = [
      mkPlayer({ hero_id: 1, player_slot: 0, kills_log: [{ time: 300, key: 'npc_dota_hero_axe' }] }),
      mkPlayer({ hero_id: 3, player_slot: 1, kills_log: [{ time: 100, key: 'npc_dota_hero_axe' }] }),
      mkPlayer({ hero_id: 2, player_slot: 128, hero_name: 'npc_dota_hero_axe', deaths: 2, kills_log: [] }),
    ];
    const timeline = buildDeathTimeline(players, []);
    expect(timeline.deathsByHeroId![2].map((e: DeathEvent) => e.time)).toEqual([100, 300]);
    expect(timeline.deathsByHeroId![2][0].killerHeroId).toBe(3);
    expect(timeline.deathsByHeroId![2][1].killerHeroId).toBe(1);
  });

  it('treats parsed matches with zero hero kills as no_data, not not_parsed_yet', () => {
    const fact = buildMatchFact({
      match_id: 1,
      duration: 1200,
      radiant_win: true,
      radiant_gold_adv: [0, 100, 200, 300, 400, 500],
      od_data: { has_parsed: true },
      players: [
        mkPlayer({ hero_id: 1, player_slot: 0, kills_log: [] }),
        mkPlayer({ hero_id: 2, player_slot: 128, kills_log: [] }),
      ],
      objectives: [],
    }, { lang: 'zh', heroNames: { 1: { nameZh: 'A', nameEn: 'A', internalSlug: 'a' }, 2: { nameZh: 'B', nameEn: 'B', internalSlug: 'b' } } }) as MatchFact;
    expect(fact.parsed).toBe(true);
    expect(fact.deathTimelineAvailable).toBe(false);
    expect(fact.fieldReasons?.deaths?.reason).toBe('no_data');
  });

  it('returns available:false for empty or invalid players input', () => {
    expect(buildDeathTimeline([], [], null)).toEqual({ available: false });
    // Robust against nullish input even though the JSDoc asks for arrays.
    expect(buildDeathTimeline(null as never, null as never, null)).toEqual({ available: false });
  });
});

describe('buildMatchFact — death timeline integration', () => {
  const fact = buildMatchFact(parsedFixture, { lang: 'zh', heroId: 104, heroNames: HERO_NAMES }) as MatchFact;

  it('attaches deathEvents and derived counts to every player', () => {
    expect(fact.deathTimelineAvailable).toBe(true);
    expect(fact.fieldReasons?.deaths).toBeUndefined();
    for (const p of fact.players) {
      expect(Array.isArray(p.deathEvents)).toBe(true);
      expect(p.deathsDerivedCount).toBe(p.deathEvents.length);
      expect(p.deathEvents.length).toBeLessThanOrEqual(p.deaths + (p.heroId === 42 ? 1 : 0));
    }
  });

  it('adds the focus player deathEvents to the focus lens', () => {
    const focus = fact.players.find((p) => p.heroId === 104)!;
    expect(fact.focusLens?.deathEvents).toEqual(focus.deathEvents);
    expect(fact.focusLens?.deathEvents).toHaveLength(11);
  });

  it('reports no timeline when hero slugs cannot be resolved', () => {
    const bare = buildMatchFact(parsedFixture, { lang: 'zh', heroId: 104 }) as MatchFact;
    // Without heroNames there is no slug lookup and no hero_name on the fixture
    // players, so no victim can be mapped — nothing is fabricated.
    expect(bare.deathTimelineAvailable).toBe(true);
    for (const p of bare.players) {
      expect(p.deathEvents).toEqual([]);
      expect(p.deathsDerivedCount).toBe(0);
    }
  });
});
