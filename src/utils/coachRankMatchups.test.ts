import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildCoachReport } from '../../lib/coach/analyze.js';
import {
  BRACKETS, RANK_SOURCE, bracketOfTier, heroVsRank, laneVsRank, parseBracket, rankLaneLine, reviewBracket,
} from '../../lib/coach/matchupsRank.js';
import { matchupBrief, matchupLines } from '../../lib/coach/matchupBrief.js';
import { reportContext } from '../../lib/coach/ask.js';

const DATA = JSON.parse(readFileSync(new URL('../../lib/coach/data/matchups-rank.json', import.meta.url), 'utf8'));
const load = (f: string) => JSON.parse(readFileSync(new URL(`../fixtures/coach/${f}`, import.meta.url), 'utf8'));
const TIDE = 29; const URSA = 70;

describe('rank brackets', () => {
  it('maps OpenDota rank tiers to the four STRATZ brackets, unknown to null', () => {
    expect([11, 25, 31, 42, 51, 65, 71, 80].map(bracketOfTier)).toEqual(['hg', 'hg', 'ca', 'ca', 'la', 'la', 'di', 'di']);
    expect([null, undefined, 0, 9, 90, 'x'].map(bracketOfTier)).toEqual([null, null, null, null, null, null]);
  });
  it('parses bracket keys, medal names and tiers', () => {
    expect(['di', 'Legend', 'archon', '54', '7', 'herald'].map(parseBracket)).toEqual(['di', 'la', 'ca', 'la', 'di', 'hg']);
    expect(['', null, 'mythic', '99'].map(parseBracket)).toEqual([null, null, null, null]);
  });
  it('reads the player\'s own medal, else the match median with 3+ public medals, else nothing', () => {
    expect(reviewBracket([], { rank_tier: 42 })).toEqual({ key: 'ca', basis: 'player', known: 1 });
    const ps = [{ rank_tier: 72 }, { rank_tier: 75 }, { rank_tier: 51 }, { rank_tier: null }];
    expect(reviewBracket(ps, { rank_tier: null })).toEqual({ key: 'di', basis: 'match', known: 3 });
    expect(reviewBracket([{ rank_tier: 72 }, { rank_tier: 75 }], {})).toBeNull();
  });
});

describe('snapshot and verdict rules', () => {
  it('names its source, credit, patch and a window of whole weeks', () => {
    expect(RANK_SOURCE.attribution).toEqual({ en: 'Data: STRATZ', url: 'https://stratz.com' });
    expect(RANK_SOURCE.source).toMatch(/STRATZ/);
    expect(RANK_SOURCE.weeks.count).toBeGreaterThanOrEqual(1);
    // STRATZ weeks run Thursday to Wednesday (week = floor(unix seconds / 604800)), count weeks apart.
    const from = Date.parse(RANK_SOURCE.weeks.from); const to = Date.parse(RANK_SOURCE.weeks.to);
    expect(new Date(from).getUTCDay()).toBe(4);
    // The same STRATZ weeks as the hero-timing snapshot when both were made in the same window: the same games.
    const timing = JSON.parse(readFileSync(new URL('../../lib/coach/data/hero-timing.json', import.meta.url), 'utf8'));
    // The two snapshots are separate STRATZ requests minutes apart, and STRATZ goes on adding games of the window it
    // had not processed: on 2026-11-27 la was 870094 against 870091 and di 275976 against 275974 (#438). The same
    // games means the same counts to within 1 in 10,000, not to the game.
    if (timing.weeks.from === RANK_SOURCE.weeks.from && timing.weeks.to === RANK_SOURCE.weeks.to) for (const b of BRACKETS) expect(Math.abs(timing.games[b] - RANK_SOURCE.games[b])).toBeLessThanOrEqual(Math.max(1, Math.round(RANK_SOURCE.games[b] / 10_000)));
    expect((to - from) / 86400000 + 1).toBe(7 * RANK_SOURCE.weeks.count);
    for (const b of BRACKETS) {
      expect(RANK_SOURCE.games[b]).toBeGreaterThan(1000);
      for (const row of Object.values(DATA.lane[b] as Record<string, Record<string, number[]>>)) {
        for (const cells of Object.values(row)) expect(cells).toHaveLength(5); // won, even, lost, stomp won, stomp lost
      }
    }
  });

  it('every win-rate verdict is two standard errors from the hero\'s own rate on 100+ games; below 100 is null', () => {
    let checked = 0;
    for (const b of BRACKETS) {
      for (const [h, row] of Object.entries(DATA.vs[b] as Record<string, Record<string, [number, number]>>).slice(0, 30)) {
        for (const [v, [n]] of Object.entries(row)) {
          const m = heroVsRank(Number(h), Number(v), b);
          if (n < 100) { expect(m).toBeNull(); continue; }
          const se = Math.sqrt((m!.base * (1 - m!.base)) / n);
          if (m!.verdict === 'even') expect(Math.abs(m!.diff)).toBeLessThan(2 * se);
          else expect(Math.abs(m!.diff)).toBeGreaterThanOrEqual(2 * se);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('lane verdicts need 50+ lanes and a 5-point, two-SE gap from the hero\'s own lanes; shares add up', () => {
    let checked = 0;
    for (const b of BRACKETS) {
      for (const [h, row] of Object.entries(DATA.lane[b] as Record<string, Record<string, number[]>>).slice(0, 30)) {
        for (const [v, cells] of Object.entries(row)) {
          const lr = laneVsRank(Number(h), Number(v), b);
          if (cells.reduce((x, y) => x + y, 0) < 50) { expect(lr).toBeNull(); continue; }
          // Five disjoint outcomes: stomps sit inside won / lost, never on top of them.
          expect(lr!.won + lr!.even + lr!.lost).toBeCloseTo(1, 9);
          expect(lr!.stomped).toBeLessThanOrEqual(lr!.lost + 1e-9);
          expect(lr!.n).toBe((DATA.lane[b][h][v] as number[]).reduce((x, y) => x + y, 0));
          // Judged against the hero's own lanes at that bracket, not against 50/50 (an offlaner loses most lanes).
          const gap = lr!.edge - lr!.base.edge;
          const se = Math.sqrt(Math.max(0, lr!.won + lr!.lost - lr!.edge ** 2) / lr!.n);
          if (lr!.verdict === 'even') expect(Math.abs(gap) < 0.05 || Math.abs(gap) < 2 * se).toBe(true);
          else {
            expect(Math.abs(gap)).toBeGreaterThanOrEqual(0.05);
            expect(Math.abs(gap)).toBeGreaterThanOrEqual(2 * se);
            expect(lr!.verdict).toBe(gap > 0 ? 'favoured' : 'unfavoured');
          }
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('an offlaner is not "unfavoured" in every lane: verdicts are relative to its own lanes', () => {
    const rows = Object.keys(DATA.lane.la[String(TIDE)]).map((v) => laneVsRank(TIDE, Number(v), 'la')).filter(Boolean) as any[];
    expect(rows.length).toBeGreaterThan(20);
    expect(rows[0].base.lost).toBeGreaterThan(rows[0].base.won); // Tidehunter loses most lanes overall…
    const verdicts = new Set(rows.map((r) => r.verdict));
    expect(verdicts.has('even') || verdicts.has('favoured')).toBe(true); // …yet not every lane is called hard
  });

  it('an unknown pair or bracket is null, never "even"', () => {
    expect(heroVsRank(TIDE, 99999, 'di')).toBeNull();
    expect(laneVsRank(TIDE, URSA, 'xx')).toBeNull();
  });

  it('the lane line names bracket, window, sample and STRATZ', () => {
    const lr = laneVsRank(TIDE, URSA, 'di');
    expect(lr).not.toBeNull();
    const line = rankLaneLine({ en: 'Tidehunter', zh: '潮汐猎人' }, { en: 'Ursa', zh: '熊战士' }, lr!);
    expect(line.en).toMatch(new RegExp(`^Divine–Immortal public games \\(${RANK_SOURCE.patch}, ${RANK_SOURCE.weeks.count} weeks to ${RANK_SOURCE.weeks.to}, data: STRATZ\\), Tidehunter laning against Ursa: won \\d+%, even \\d+%, lost \\d+% \\(stomped \\d+%\\) of [\\d,]+ lanes; all Tidehunter lanes: won \\d+%, lost \\d+%$`));
    expect(line.zh).toContain('数据来自 STRATZ');
  });
});

describe('in the report', () => {
  it('unparsed match: each review carries its bracket, rank matchups and the STRATZ credit', () => {
    const r = buildCoachReport(load('match9091400302.unparsed.json')) as any;
    expect(r.baselines.rank.attribution.url).toBe('https://stratz.com');
    const tide = r.reviews.find((v: any) => r.players[v.slot].hero.id === TIDE);
    expect(tide.bracket).toMatchObject({ key: 'ca', basis: 'player' }); // rank_tier 42
    const vsUrsa = tide.matchups.find((m: any) => m.hero === URSA);
    const expected = heroVsRank(TIDE, URSA, 'ca');
    expect(vsUrsa.rank).toMatchObject({ bracket: 'ca', n: expected?.n ?? null, wr: expected?.wr ?? null });
    const lane = laneVsRank(TIDE, URSA, 'ca');
    expect(vsUrsa.rank.lane?.n ?? null).toBe(lane?.n ?? null);
  });

  it('no medal anywhere: no bracket and no rank numbers (never a guessed bracket)', () => {
    const m = load('match9091400302.unparsed.json');
    for (const p of m.players) p.rank_tier = null;
    const r = buildCoachReport(m) as any;
    for (const v of r.reviews) {
      expect(v.bracket).toBeNull();
      for (const x of v.matchups) expect(x.rank).toBeNull();
    }
  });

  it('parsed match: the laning chapter quotes your lane against their core at your bracket', () => {
    const r = buildCoachReport(load('match9091400302.parsed.json')) as any;
    const tide = r.reviews.find((v: any) => r.players[v.slot].hero.id === TIDE);
    const l = tide.chapters?.laning;
    if (!l) throw new Error('fixture lost its laning chapter');
    const rival = l.rows.filter((x: any) => !x.ally).sort((a: any, b: any) => (b.lh10 ?? 0) - (a.lh10 ?? 0))[0].hero;
    const lr = laneVsRank(TIDE, rival, 'ca')!;
    expect(lr).not.toBeNull();
    expect(l.rank_lane).toEqual({
      bracket: 'ca', hero: TIDE, vs: rival, n: lr.n, won: lr.won, even: lr.even, lost: lr.lost, stomped: lr.stomped,
      usual_won: lr.base.won, usual_lost: lr.base.lost, verdict: lr.verdict,
    });
    expect(l.read.en).toContain('Crusader–Archon public games');
    expect(l.read.en).toContain('data: STRATZ');
    expect(l.read.zh).toContain('数据来自 STRATZ');
  });

  it('the follow-up chat gets the rank lines with bracket and source', () => {
    const r = buildCoachReport(load('match9091400302.unparsed.json')) as any;
    const slot = r.players.findIndex((p: any) => p.hero.id === TIDE);
    const en = reportContext(r, slot, 'en');
    expect(en).toContain('Crusader–Archon public games');
    expect(en).toContain('data: STRATZ');
    expect(reportContext(r, slot, 'zh')).toContain('中军–统帅路人局');
  });
});

describe('matchup brief', () => {
  it('always carries all four brackets and the credit; lines add only the bracket asked for', () => {
    const b = matchupBrief('tidehunter', 'ursa', { rank: 'legend' }) as any;
    expect(Object.keys(b.by_rank)).toEqual(['hg', 'ca', 'la', 'di']);
    expect(b.rank).toBe('la');
    expect(b.rank_source.attribution.en).toBe('Data: STRATZ');
    const lines = matchupLines(b, 'en');
    expect(lines.some((x: string) => x.startsWith('Legend–Ancient public games ('))).toBe(true);
    expect(lines.some((x: string) => x.startsWith('Divine–Immortal'))).toBe(false);
    const plain = matchupBrief('tidehunter', 'ursa') as any;
    expect(plain.rank).toBeNull();
    expect(matchupLines(plain, 'en').some((x: string) => /public games/.test(x))).toBe(false);
  });

  it('rejects an unknown rank instead of silently ignoring it', () => {
    expect(matchupBrief('tidehunter', 'ursa', { rank: 'mythic' })).toEqual({ error: expect.stringContaining('Unknown rank: mythic') });
  });
});
