import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { runDeepReview, verifyReview } from '../../lib/agent/deepReview.js';
import { linkHeroNames, runTraceTool } from '../../packages/review-engine/src/trace/index.js';
import { STILL_IN_IT, TURN_DROP, TURN_RULE, turningFight } from '../../packages/review-engine/src/trace/turningFight.js';

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
    expect(TURN_RULE).toBe('of the fights my_team lost more heroes in, entered at a gold lead of -2000 or better: the one after which the lead fell the most by two minutes after it, if by more than 1500');
  });

  it('match_overview names it for the player who lost, with the rule it was read by', () => {
    expect(overview().turning_fight).toEqual({
      ref: 'fight:11', from: 1826.5, to: 1848.2, clock: '30:26–30:48', my_team_deaths: 5, enemy_deaths: 3,
      my_team_gold_lead_before: -745, my_team_gold_lead_2min_after: -4298, rule: TURN_RULE,
    });
  });

  it('gold with no fight that cost that much is "none"; no gold at all is unknown, and the gap says why', () => {
    expect(overview({ radiant_gold_adv: gold([]) }).turning_fight).toEqual({ none: true });
    const blind = overview(null);
    expect(blind.turning_fight).toBeNull();
    expect(blind.gaps).toContainEqual({ topic: 'gold_advantage', reason: 'not_in_trace' });
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

describe('a review is asked about the turning fight', () => {
  const lane = runTraceTool(trace, 'death_context', { hero: 'beastmaster', index: 1 }, { perspective: 'beastmaster' }) as any;
  const fights = runTraceTool(trace, 'fight_timeline', { from: 1820, to: 1850 }, { perspective: 'beastmaster' }) as any;
  const finding = (extra: any = {}) => ({ title: '对线期的阵亡', claim: '你在 0:47 阵亡。', evidence: [{ refs: ['death:beastmaster:1'], fact: '0:47 阵亡。' }], fix: '退到塔后。', ...extra });
  const review = (findings: any[]) => ({ verdict: '对线期送了。', mainline: [], findings, blind_spots: [] });
  const turnNotes = (r: any, sources: any[]) => verifyReview(r, sources).problems.filter((p: any) => p.kind === 'turn');

  it('when no finding looks at it: one note, naming the fight, that removes nothing', () => {
    const check = verifyReview(review([finding()]), [overview(), lane]);
    expect(check.problems).toEqual([{ where: 'findings', index: 0, kind: 'turn', text: '30:26–30:48', soft: true }]);
    expect(check.ok).toBe(false);
    expect(check.unsupported.findings.size).toBe(0);
  });

  it('a finding looks at it by citing the fight, by a record inside it, or by a time inside it', () => {
    const sources = [overview(), lane, fights];
    expect(turnNotes(review([finding({ evidence: [{ refs: ['fight:11'], fact: '这波你们多死了人。' }] })]), sources)).toEqual([]);
    expect(turnNotes(review([finding({ evidence: [{ refs: ['fights:beastmaster:11'], fact: '这波你到场了。' }] })]), sources)).toEqual([]);
    expect(turnNotes(review([finding({ evidence: [{ refs: ['death:beastmaster:1'], clock: '30:30', fact: '阵亡。' }] })]), sources)).toEqual([]);
    expect(turnNotes(review([finding({ claim: '30:25 你把咆哮给了瘟疫法师。' })]), sources)).toEqual([]);
    expect(turnNotes(review([finding(), finding({ claim: '30:40 团灭。' })]), sources)).toEqual([]);
    // Another fight, or a time well outside it, is not it.
    expect(turnNotes(review([finding({ evidence: [{ refs: ['fight:10'], fact: '上一波。' }] })]), sources)).toHaveLength(1);
    expect(turnNotes(review([finding({ evidence: [{ refs: ['fights:beastmaster:1'], fact: '第一波。' }] })]), sources)).toHaveLength(1);
    expect(turnNotes(review([finding({ claim: '29:00 你在打野。' })]), sources)).toHaveLength(1);
  });

  it('nothing is asked when the tools named no turning fight: none found, no gold, or the overview not read', () => {
    expect(turnNotes(review([finding()]), [overview({ radiant_gold_adv: gold([]) }), lane])).toEqual([]);
    expect(turnNotes(review([finding()]), [overview(null), lane])).toEqual([]);
    expect(turnNotes(review([finding()]), [lane])).toEqual([]);
  });

  it('is not asked when fight_report said the player was not in that fight; is asked when it said they were, or was not read', () => {
    const report = runTraceTool(trace, 'match_overview', {}, { match, perspective: 'beastmaster' }) as any;
    const mine = { tool: 'fight_report', ref: 'fights:beastmaster', fights: report.fights.map((f: any) => ({ fight: f.ref, me: 'took_part' })) };
    const away = { ...mine, fights: mine.fights.map((f: any) => (f.fight === 'fight:11' ? { ...f, me: 'not_in_it' } : f)) };
    expect(turnNotes(review([finding()]), [overview(), lane, mine])).toHaveLength(1);
    expect(turnNotes(review([finding()]), [overview(), lane, away])).toEqual([]);
    // Another hero's report, or one that does not list the fight, says nothing about the player in it.
    expect(turnNotes(review([finding()]), [overview(), lane, { ...away, fights: away.fights.filter((f: any) => f.fight !== 'fight:11') }])).toHaveLength(1);
    expect(turnNotes(review([finding()]), [overview(), lane, { ...away, tool: 'tempo_report' }])).toHaveLength(1);
  });

  it('the repair round is told which fight, once; a review that still does not look at it ships whole', async () => {
    const call = (name: string, args: any, id: string) => ({ id, name, args });
    const replies = [
      { toolCalls: [call('match_overview', {}, 'a'), call('death_context', { hero: 'beastmaster', index: 1 }, 'b')] },
      { toolCalls: [call('submit_review', review([finding()]), 's1')] },
      { toolCalls: [call('submit_review', review([finding()]), 's2')] },
    ];
    const seen: any[] = []; let i = 0;
    const complete = async (o: any) => { seen.push(JSON.parse(JSON.stringify(o))); return replies[Math.min(i++, replies.length - 1)]; };
    const r: any = await runDeepReview({ complete, trace, hero: 'beastmaster', lang: 'zh', match });
    const repair = JSON.parse(seen[2].messages.at(-1).content);
    expect(repair.error).toBe('unsupported_facts');
    expect(repair.problems).toEqual([{ in: 'findings', text: '30:26–30:48', why: expect.stringContaining('no finding looks at the fight the game turned on') }]);
    expect(seen).toHaveLength(3);
    expect(r.status).toBe('ok');
    expect(r.review.findings.map((f: any) => f.title)).toEqual(['对线期的阵亡']);
    expect(r.verification).toMatchObject({ repaired: true, dropped: 0 });
  });
});
