import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { reviewToolkit, runDeepReview, verifyReview } from '../../lib/agent/deepReview.js';
import { linkHeroNames, runTraceTool } from '../../packages/review-engine/src/trace/index.js';
import { ENDED_WITHIN, STILL_IN_IT, TURN_DROP, TURN_RULE, turnOf, turningFight } from '../../packages/review-engine/src/trace/turningFight.js';

/** Match 9100904020, Beastmaster on Dire. The committed trace has no gold; the match record gives it. */
const trace = linkHeroNames(JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString()));
/** Radiant's gold lead per minute: Dire 745 behind going into the 30:26 fight, 4298 behind two minutes after it. */
const gold = (points: [number, number][]) => { const a = new Array(46).fill(0); for (const [m, v] of points) a[m] = v; return a; };
const match = { radiant_gold_adv: gold([[30, 745], [31, 2500], [32, 4298]]) };
const overview = (m: any = match) => runTraceTool(trace, 'match_overview', {}, { match: m, perspective: 'beastmaster' }) as any;

describe('the fight a lost game turned on', () => {
  const f = (ref: string, before: number | null, after: number | null, mine = 3, theirs = 1) => ({ ref, my_team_deaths: mine, enemy_deaths: theirs, my_team_gold_lead_before: before, my_team_gold_lead_2min_after: after });

  it('is the largest fall of the lead over a fight entered while still in the game, not the last collapse', () => {
    expect(turningFight([f('a', 500, -800), f('b', -745, -4298), f('c', 3000, 800)])?.ref).toBe('b');
    // The case the page used to test for itself: the last fight cost 12,000, entered 8,000 behind.
    expect(turningFight([f('a', 3565, 2800), f('b', -745, -4298), f('c', -8039, -20144)])?.ref).toBe('b');
    // A fall of exactly the threshold is not one; nor is any fight entered further behind than "still in it".
    expect(turningFight([f('a', 0, -TURN_DROP)])).toBeNull();
    expect(turningFight([f('a', 0, -TURN_DROP - 1)])?.ref).toBe('a');
    expect(turningFight([f('a', STILL_IN_IT - 1, -9000)])).toBeNull();
    expect(turningFight([f('a', STILL_IN_IT, -9000)])?.ref).toBe('a');
    // A fight without the lead on either side cannot be judged, and is not the turn.
    expect(turningFight([f('a', null, -9000), f('b', 0, null)])).toBeNull();
    expect(turningFight([f('a', 500, -400), f('b', null, null)])).toBeNull();
    expect(turningFight([])).toBeNull();
  });

  it('is a fight the team lost more heroes in: a lead that fell after a fight it won or drew is not that fight\'s doing', () => {
    // Seen on the corpus with a lead read off the net worth graph: a side "lost 9,700" after a fight it won 3–0.
    expect(turningFight([f('won', 5000, -4700, 0, 3)])).toBeNull();
    expect(turningFight([f('even', 5000, -4700, 2, 2)])).toBeNull();
    expect(turningFight([f('won', 5000, -4700, 0, 3), f('lost', 300, -1900, 2, 1)])?.ref).toBe('lost');
    // Deaths not stated: not known to be a lost fight.
    expect(turningFight([{ ref: 'x', my_team_gold_lead_before: 0, my_team_gold_lead_2min_after: -9000 } as any])).toBeNull();
    expect(TURN_RULE).toBe('gold-curve indicator (not a cause verdict): of the fights my_team lost more heroes in, entered at a gold lead of -2000 or better: the one the game ended within two minutes of; else the one after which the lead fell the most by two minutes after it, if by more than 1500');
  });

  it('a lost fight the game ended within two minutes of is the turn, whatever fell before it', () => {
    // Seen in 3 of 32 parsed games: level going into the last fight (once 3,442 ahead), and the Ancient down before
    // two minutes were up — so that fight has no lead "two minutes on". The rule used to name an earlier swing.
    const last = { ...f('last', 3442, null, 3, 0), to: 2596 };
    const swing = { ...f('swing', 5179, -975, 5, 3), to: 2080 };
    expect(turnOf([swing, last], { end: 2626 })).toEqual({ fight: last, by: 'game_ended_after_it', undecided: [] });
    expect(turnOf([swing, last], { end: 2596 + ENDED_WITHIN }).fight).toBe(last);
    // Entered already far behind, it is the end of a lost game, not its turn: the swing stands.
    expect(turnOf([swing, { ...last, my_team_gold_lead_before: STILL_IN_IT - 1 }], { end: 2626 })).toEqual({ fight: swing, by: 'largest_fall', undecided: [] });
    // Won or drawn, it is not it either.
    expect(turnOf([swing, { ...last, my_team_deaths: 2, enemy_deaths: 2 }], { end: 2626 }).fight).toBe(swing);
  });

  it('a lost fight that could be it and has no gold to tell by makes the answer "not known" — never "none"', () => {
    const swing = { ...f('swing', 5179, -975, 5, 3), to: 2080 };
    // No lead two minutes on, and not because the game ended: the gold series stops short.
    const cut = { ...f('cut', 300, null, 4, 1), to: 2400 };
    expect(turnOf([swing, cut], { end: 2900 })).toEqual({ fight: null, by: null, undecided: [cut] });
    expect(turnOf([cut], { end: 2900 })).toEqual({ fight: null, by: null, undecided: [cut] });
    // Where the game ended is not known either: the same.
    expect(turnOf([cut]).undecided).toEqual([cut]);
    // No lead before it at all.
    const blind = { ...f('blind', null, -3000, 4, 1), to: 900 };
    expect(turnOf([blind, swing], { end: 2900 })).toEqual({ fight: null, by: null, undecided: [blind] });
    // What cannot be the turn does not stand in the way: entered far behind, or not lost.
    expect(turnOf([swing, { ...cut, my_team_gold_lead_before: -9000 }, { ...blind, my_team_deaths: 1, enemy_deaths: 4 }], { end: 2900 })).toEqual({ fight: swing, by: 'largest_fall', undecided: [] });
    // turningFight is the fight alone: null for both "none" and "not known".
    expect(turningFight([cut], { end: 2900 })).toBeNull();
  });

  it('match_overview names it for the player who lost, with the rule it was read by', () => {
    expect(overview().turning_fight).toEqual({
      ref: 'fight:11', from: 1826.5, to: 1848.2, clock: '30:26–30:48', my_team_deaths: 5, enemy_deaths: 3,
      my_team_gold_lead_before: -745, my_team_gold_lead_2min_after: -4298, rule: TURN_RULE,
    });
  });

  it('gold with no fight that cost that much is "none"; no gold at all is unknown, and the gap says why', () => {
    const none = overview({ radiant_gold_adv: gold([]) });
    expect(none.turning_fight).toEqual({ none: true });
    expect(none.gaps.map((g: any) => g.topic)).not.toContain('turning_fight');
    const blind = overview(null);
    expect(blind.turning_fight).toBeNull();
    expect(blind.gaps).toContainEqual({ topic: 'gold_advantage', reason: 'not_in_trace' });
  });

  it('a gold series that stops before the fight is over is "not known", with its own gap — not "the game had no turn"', () => {
    // The record's lead cut to 31 minutes: the 30:26 fight keeps its lead going in (-745) and loses the one two minutes on.
    const cut = overview({ radiant_gold_adv: gold([[30, 745]]).slice(0, 31) });
    expect(cut.fights.find((x: any) => x.ref === 'fight:11')).toMatchObject({ my_team_gold_lead_before: -745, my_team_gold_lead_2min_after: null });
    expect(cut.turning_fight).toBeNull();
    expect(cut.gaps).toContainEqual({ topic: 'turning_fight', reason: 'no_gold_lead_around_a_lost_fight_that_could_be_it' });
    // Nothing is asked of a review about a fight nobody could name.
    expect(verifyReview({ verdict: '对线期送了。', mainline: [], findings: [], blind_spots: [] }, [cut]).problems.filter((p: any) => p.kind === 'turn')).toEqual([]);
  });

  it('match_overview names the last fight of a game that was level going into it', () => {
    // The same game with a near-level gold lead as long as the game (43 minutes, Radiant 100 ahead throughout):
    // 41:57–42:20, five of mine for none of theirs, and the Ancient fell at 42:31.
    const level = overview({ radiant_gold_adv: new Array(43).fill(100) });
    expect(level.turning_fight).toEqual({
      ref: 'fight:16', from: 2517.8, to: 2540.6, clock: '41:57–42:20', my_team_deaths: 5, enemy_deaths: 0,
      my_team_gold_lead_before: -100, my_team_gold_lead_2min_after: null, game_ended_within_two_minutes: true, rule: TURN_RULE,
    });
  });

  it('is not named for a game the team won, for a reader with no side, or when no Ancient fell', () => {
    // Radiant won this game. Their lead fell 5,000 over the 20:32 fight (3 Radiant deaths, 1 Dire) and came back: a setback.
    const setback = { radiant_gold_adv: gold([[20, 4000], [21, 1000], [22, -1000], [30, 745], [31, 2500], [32, 4298]]) };
    const won = runTraceTool(trace, 'match_overview', {}, { match: setback, perspective: 'axe' }) as any;
    expect(won.result).toBe('my_team_won');
    expect('turning_fight' in won).toBe(false);
    expect('turning_fight' in (runTraceTool(trace, 'match_overview', {}, { match }) as any)).toBe(false);
    const cut = { ...trace, buildings: trace.buildings.filter((b: any) => !/_fort$/.test(trace.names[b[1]])) };
    const unknown = runTraceTool(cut, 'match_overview', {}, { match, perspective: 'beastmaster' }) as any;
    expect(unknown.result).toBeNull();
    expect('turning_fight' in unknown).toBe(false);
  });
});

describe('a review is not made to write about the turning fight (#405: what to cover is the model\'s judgment)', () => {
  const lane = runTraceTool(trace, 'death_context', { hero: 'beastmaster', index: 1 }, { perspective: 'beastmaster' }) as any;
  const fights = runTraceTool(trace, 'fight_timeline', { from: 1820, to: 1850 }, { perspective: 'beastmaster' }) as any;
  const finding = (extra: any = {}) => ({ title: '对线期的阵亡', claim: '你在 0:47 阵亡。', evidence: [{ refs: ['death:beastmaster:1'], fact: '0:47 阵亡。' }], fix: '退到塔后。', ...extra });
  const review = (findings: any[]) => ({ verdict: '对线期送了。', mainline: [], findings, blind_spots: [] });
  const turnNotes = (r: any, sources: any[]) => verifyReview(r, sources).problems.filter((p: any) => p.kind === 'turn');

  it('nothing is asked when the tools named no turning fight: none found, no gold, or the overview not read', () => {
    expect(turnNotes(review([finding()]), [overview({ radiant_gold_adv: gold([]) }), lane])).toEqual([]);
    expect(turnNotes(review([finding()]), [overview(null), lane])).toEqual([]);
    expect(turnNotes(review([finding()]), [lane])).toEqual([]);
  });

  it('a review whose findings leave out a named turning fight passes, with nothing asked and nothing dropped', () => {
    const named = overview();
    expect(named.turning_fight).toMatchObject({ ref: expect.stringMatching(/^fight:/) });
    const check = verifyReview(review([finding()]), [named, lane, fights]);
    expect(turnNotes(review([finding()]), [named, lane, fights])).toEqual([]);
    expect(check.problems.filter((p: any) => !p.soft)).toEqual([]);
    expect(check.unsupported.findings.size).toBe(0);
  });

});
