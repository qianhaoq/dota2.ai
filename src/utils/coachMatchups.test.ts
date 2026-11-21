import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCoachReport } from '../../lib/coach/analyze.js';
import { heroVs, laneMatchup, laneStanding, MATCHUP_SOURCE } from '../../lib/coach/matchups.js';

const DATA = JSON.parse(readFileSync(path.join(process.cwd(), 'lib/coach/data/matchups.json'), 'utf8'));
const NAMES = JSON.parse(readFileSync(path.join(process.cwd(), 'lib/coach/data/names.json'), 'utf8'));
const load = (name: string) => JSON.parse(readFileSync(path.join(process.cwd(), 'src/fixtures/coach', name), 'utf8'));
const TIDE = 29; const URSA = 70; const WEAVER = 63;

describe('matchups.json snapshot', () => {
  it('names its source and only lists known heroes with well-formed rows', () => {
    expect(DATA.source).toMatch(/OpenDota/);
    expect(DATA.games).toBeGreaterThan(1000);
    expect(MATCHUP_SOURCE.since).toBe(DATA.since);
    const known = (id: string) => Boolean(NAMES.heroes[id]);
    for (const [h, row] of Object.entries(DATA.lane) as [string, Record<string, number[]>][]) {
      expect(known(h), h).toBe(true);
      for (const [v, r] of Object.entries(row)) {
        expect(known(v), v).toBe(true);
        expect(r).toHaveLength(6);
        expect(r[0]).toBeGreaterThanOrEqual(10);
        expect(r[2]).toBeLessThanOrEqual(r[3]); // p25 <= p75
        expect(r[4]).toBeLessThanOrEqual(r[0]); // ahead <= games
      }
    }
    for (const [h, row] of Object.entries(DATA.vs) as [string, Record<string, number[]>][]) {
      for (const r of Object.values(row)) { expect(r[0]).toBeGreaterThanOrEqual(15); expect(r[1]).toBeLessThanOrEqual(r[0]); }
      expect(DATA.base[h], h).toBeTruthy();
    }
  });
});

describe('laneMatchup / heroVs: verdicts only on real gaps', () => {
  it('reads Tidehunter vs Ursa as an unfavoured lane, and the mirror as favoured', () => {
    const tu = laneMatchup(TIDE, URSA)!;
    expect(tu).toMatchObject({ n: DATA.lane[TIDE][URSA][0], mean: DATA.lane[TIDE][URSA][1], verdict: 'unfavoured' });
    const ut = laneMatchup(URSA, TIDE)!;
    expect(ut.mean).toBe(-tu.mean);
    expect(ut.verdict).toBe('favoured');
  });

  it('says nothing on thin or missing samples', () => {
    expect(DATA.lane[1][2][0]).toBeLessThan(20);
    expect(laneMatchup(1, 2)).toBeNull();
    expect(laneMatchup(TIDE, 99999)).toBeNull();
    expect(DATA.vs[1][2][0]).toBeLessThan(30);
    expect(heroVs(1, 2)).toBeNull();
  });

  it('calls a win-rate gap a verdict only past two standard errors', () => {
    const m = heroVs(TIDE, URSA)!;
    const se = Math.sqrt((m.base * (1 - m.base)) / m.n);
    expect(Math.abs(m.wr - m.base)).toBeLessThan(2 * se);
    expect(m.verdict).toBe('even');
    const w = heroVs(TIDE, WEAVER)!;
    expect(Math.abs(w.wr - w.base)).toBeGreaterThanOrEqual(2 * Math.sqrt((w.base * (1 - w.base)) / w.n));
    expect(w.verdict).toBe('favoured');
  });

  it('places one game against the middle half of pro games', () => {
    const lm = laneMatchup(TIDE, URSA)!;
    expect(laneStanding(lm.p25 - 1, lm)).toBe('worse');
    expect(laneStanding(lm.p25, lm)).toBe('typical');
    expect(laneStanding(lm.p75 + 1, lm)).toBe('better');
    expect(laneStanding(Number.NaN, lm)).toBeNull();
  });
});

describe('report: was the lane hard before it started?', () => {
  const r = buildCoachReport(load('match9091400302.parsed.json')) as any;
  const tideLane = r.reviews[0].chapters.story.why.find((c: any) => c.id === 'lane.3');

  it('adds the pro baseline to the lane cause and frames the advice as damage control', () => {
    expect(tideLane.baseline).toMatchObject({ hero: TIDE, vs: URSA, verdict: 'unfavoured', actual: -677, standing: 'typical' });
    expect(tideLane.evidence.map((e: any) => e.zh)).toContain(
      `职业比赛（7.41 以来 ${DATA.lane[TIDE][URSA][0]} 场）潮汐猎人对熊战士的线：10 分钟平均落后 304，潮汐猎人领先的占 ${Math.round((DATA.lane[TIDE][URSA][4] / DATA.lane[TIDE][URSA][0]) * 100)}%。这局 −677——在职业同对位对局的常见范围内`,
    );
    expect(tideLane.fix.zh.startsWith('潮汐猎人对熊战士在职业比赛里也是劣势线（10 分钟平均落后 304），这局的差距在正常范围：目标是少亏、不死，而不是赢线。')).toBe(true);
    // The lane-specific advice still follows.
    expect(tideLane.fix.zh).toContain('爆栗出击');
  });

  it('calls it the play when the lane went worse than most pro games of the matchup', () => {
    const m = load('match9091400302.parsed.json');
    m.players[0].gold_t = m.players[0].gold_t.map((g: number, i: number) => (i >= 10 ? g - 1500 : g));
    const lane = (buildCoachReport(m) as any).reviews[0].chapters.story.why.find((c: any) => c.id === 'lane.3');
    expect(lane.baseline.standing).toBe('worse');
    expect(lane.fix.zh.startsWith('这条线比四分之三的职业同对位（潮汐猎人对熊战士）对局都差：问题在打法上，不只是对位。')).toBe(true);
  });

  it('puts the baseline in the laning chapter, and lanes without enough pro games get none', () => {
    expect(r.reviews[0].chapters.laning.baseline).toMatchObject({ hero: TIDE, vs: URSA, n: DATA.lane[TIDE][URSA][0] });
    expect(r.reviews[0].chapters.laning.read.zh).toContain('潮汐猎人对熊战士的线：10 分钟平均落后 304');
    const others = r.reviews[0].chapters.story.why.filter((c: any) => c.id !== 'lane.3' && c.id.startsWith('lane.'));
    for (const c of others) if (!c.baseline) expect(c.evidence.some((e: any) => e.zh.includes('职业比赛（'))).toBe(false);
  });

  it('lists your hero against each enemy hero, with the source of the numbers', () => {
    const mu = r.reviews[0].matchups;
    expect(mu.map((x: any) => x.hero).sort()).toEqual(r.players.filter((p: any) => !p.radiant).map((p: any) => p.hero.id).sort());
    expect(mu.find((x: any) => x.hero === WEAVER).verdict).toBe('favoured');
    expect(mu.find((x: any) => x.hero === URSA).verdict).toBe('even');
    const IV = JSON.parse(readFileSync(path.join(process.cwd(), 'lib/coach/data/item-vs.json'), 'utf8'));
    expect(r.baselines).toEqual({ source: 'OpenDota explorer, professional matches', since: DATA.since, games: DATA.games, fetched: DATA.fetched, item_rule: IV.rule });
  });

  it('still lists hero matchups for an unparsed match (they need only the draft)', () => {
    const u = buildCoachReport(load('match9091400302.unparsed.json')) as any;
    expect(u.reviews[0].matchups).toHaveLength(5);
  });
});

describe('framing never contradicts the core matchup (review #198)', () => {
  it('a core who beat the baseline in a lane lost on support gold is told the lane was lost elsewhere', () => {
    const m = load('match9091400302.parsed.json');
    const slotOf = (id: number) => m.players.findIndex((p: any) => p.hero_id === id);
    const setG10 = (slot: number, g: number) => { m.players[slot].gold_t = m.players[slot].gold_t.map((x: number, i: number) => (i === 10 ? g : x)); };
    const tide = slotOf(TIDE);
    const shaman = m.players.findIndex((p: any, i: number) => i !== tide && p.lane === m.players[tide].lane && (p.player_slot < 128) === (m.players[tide].player_slot < 128));
    const ursa = slotOf(URSA);
    const hood = m.players.findIndex((p: any, i: number) => i !== ursa && p.lane === m.players[ursa].lane && (p.player_slot < 128) === (m.players[ursa].player_slot < 128));
    setG10(tide, 4663); setG10(shaman, 1000); setG10(hood, 3000);
    const lane = (buildCoachReport(m) as any).reviews[tide].chapters.story.why.find((c: any) => c.id === 'lane.3');
    expect(lane.impact).toBeLessThan(0); // the lane as a whole is still lost
    expect(lane.baseline.actual).toBeGreaterThan(lane.baseline.p75);
    expect(lane.baseline.standing).toBe('better');
    expect(lane.fix.zh.startsWith('潮汐猎人对熊战士的核心对位打得好于四分之三的职业对局：这条线的经济差不是输在核心对位上。')).toBe(true);
    expect(lane.fix.zh).not.toContain('目标是少亏');
    expect(lane.fix.zh).not.toContain('在正常范围');
  });
});
