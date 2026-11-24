import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { WINDOW_PEAK, windowReport } from '../../lib/agent/windowReport.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { planOf, reviewToolkit, verifyReview } from '../../lib/agent/deepReview.js';
import { runTraceTool } from '../../packages/review-engine/src/trace/index.js';

const trace = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());
const match = JSON.parse(readFileSync(new URL('../fixtures/agent/match9100904020.scoreboard.json', import.meta.url), 'utf8'));
const report = (hero = 'beastmaster', m: any = match, lang = 'en'): any => windowReport(trace, { hero }, { match: m, lang });

describe('window_report on a real game', () => {
  it('cuts the game into runs one side stayed ahead, and keeps those that reached the peak', () => {
    const r = report();
    expect(r).toMatchObject({ ref: 'window:beastmaster', ref_scope: 'summary', hero: 'beastmaster', duration: { clock: '42:31' }, data_patch: expect.any(String) });
    // Beastmaster is Dire: the lead is Radiant's, turned round. At 20:00 Radiant was 2245 behind.
    expect(r.my_team_gold_lead_at).toMatchObject({ '5:00': -1654, '20:00': 2245, '25:00': 3565, '30:00': -745, '40:00': -12847 });
    expect(r.highest_lead).toEqual({ clock: '25:00', value: 3565 });
    expect(r.deepest_deficit).toEqual({ clock: '42:00', value: -27728 });
    expect(r.windows.map((w: any) => [w.ref, w.clock, w.ahead, w.peak_lead])).toEqual([
      ['window:beastmaster:1', '1:00–9:00', 'enemy', { clock: '6:00', value: 2585 }],
      // Ahead from 19:00 (by 1713) to 28:00 (by 82); behind at 29:00. The runs either side were too small or the other side's.
      ['window:beastmaster:2', '19:00–29:00', 'my_team', { clock: '25:00', value: 3565 }],
      ['window:beastmaster:3', '29:00–42:31', 'enemy', { clock: '42:00', value: 27728 }],
    ]);
    expect(r.windows_total).toEqual({ my_team: 1, enemy: 2 });
    // The run from 11:00 to 14:00 (ahead by at most 869) never reached the peak: not a window.
    expect(r.windows.some((w: any) => w.from === 660)).toBe(false);
    expect(WINDOW_PEAK).toBe(2000);
  });

  it('a window holds what each side took in it and the big items each side finished in it and just before it ended', () => {
    const w = report().windows[1];
    expect(w).toMatchObject({ lead_at_start: 1713, ended: { clock: '29:00', my_team_gold_lead: -574 }, buildings_taken: { my_team: 2, enemy: 3 }, fights_total: 4, fights_lost_fewer_heroes: { my_team: 1, enemy: 3 } });
    // Towers only: the filler buildings around a base are no objective.
    expect(w.buildings.map((b: any) => [b.clock, b.taken_by])).toEqual([['19:46', 'my_team'], ['20:02', 'enemy'], ['24:28', 'enemy'], ['25:05', 'my_team'], ['25:59', 'enemy']]);
    expect(report().windows[2].buildings.some((b: any) => /fillers/.test(b.building))).toBe(false);
    expect(report().windows[2].buildings_taken).toEqual({ my_team: 0, enemy: 15 });
    expect(w.fights.map((f: any) => f.fight)).toEqual(['fight:7', 'fight:8', 'fight:9', 'fight:10']);
    // Each item with item_timeline's own ref, so a sentence about it can cite that record.
    expect(w.big_items_finished.enemy).toContainEqual({ ref: 'item:phantom_assassin:black_king_bar', clock: '21:29', hero: 'phantom_assassin', item: 'black_king_bar', name: 'Black King Bar' });
    expect(w.big_items_finished.my_team.map((x: any) => x.hero)).toContain('sven');
    expect(w.enemy_big_items_in_the_last_180s.map((x: any) => `${x.clock} ${x.hero} ${x.item}`)).toEqual(['26:44 phantom_assassin basher', '27:03 necrolyte consecrated_wraps', '28:35 venomancer ultimate_scepter', '28:46 axe travel_boots']);
    // The last 180 s are inside the window: every one of them is also in what the enemy finished during it.
    for (const x of w.enemy_big_items_in_the_last_180s) expect(w.big_items_finished.enemy).toContainEqual(x);
    // A window that ran to the end of the game did not end: nothing is listed as finished "before it ended".
    const last = report().windows[2];
    expect(last.ended).toEqual({ clock: '42:31', by: 'end_of_the_game' });
    expect(Object.keys(last).some((k) => /_in_the_last_/.test(k))).toBe(false);
    // An enemy window lists what my team finished just before it ended.
    expect(report().windows[0]).toHaveProperty('my_team_big_items_in_the_last_180s');
  });

  it('is told from the hero asked about: the other side reads the same game the other way round', () => {
    const mine = report(); const axe = report('axe');
    expect(axe.my_team_gold_lead_at['25:00']).toBe(-3565);
    expect(axe.windows.map((w: any) => [w.clock, w.ahead])).toEqual(mine.windows.map((w: any) => [w.clock, w.ahead === 'my_team' ? 'enemy' : 'my_team']));
    expect(axe.windows[1].buildings_taken).toEqual({ my_team: 3, enemy: 2 });
    expect(axe.windows[1]).toHaveProperty('my_team_big_items_in_the_last_180s');
    expect(mine.heroes_by_net_worth).toEqual({ my_team: ['sven', 'beastmaster', 'skywrath_mage', 'undying', 'dark_willow'], enemy: ['phantom_assassin', 'necrolyte', 'venomancer', 'mirana', 'axe'] });
    expect(axe.heroes_by_net_worth.my_team[0]).toBe('phantom_assassin');
    expect(report('beastmaster', match, 'zh').windows[1].big_items_finished.enemy.find((x: any) => x.item === 'black_king_bar').name).toBe('黑皇杖');
    expect(windowReport(trace, { hero: 'pudge' }, { match })).toMatchObject({ error: 'unknown_hero' });
  });

  it('without the per-minute gold there are no windows — a stated gap, never an estimate', () => {
    for (const m of [null, { ...match, radiant_gold_adv: undefined }]) {
      const r = report('beastmaster', m);
      expect(r.windows).toBeNull();
      expect(r.gaps[0]).toEqual({ topic: 'gold_lead_by_minute', reason: 'no_per_minute_gold_in_the_match_data' });
      expect(r).not.toHaveProperty('highest_lead');
    }
    // Net worth at the end is the scoreboard's, which is there without the curve; with no match data it is not.
    expect(report('beastmaster', { ...match, radiant_gold_adv: undefined }).net_worth_at_end.phantom_assassin).toBe(38622);
    expect(report('beastmaster', null)).not.toHaveProperty('net_worth_at_end');
    // A minute missing in the middle could split a window in two: none is drawn.
    const holed = { ...match, radiant_gold_adv: match.radiant_gold_adv.map((v: number, i: number) => (i === 24 ? null : v)) };
    const h = report('beastmaster', holed);
    expect(h.windows).toBeNull();
    expect(h.gaps[0]).toEqual({ topic: 'gold_lead_by_minute', reason: 'match_data_has_missing_minutes' });
    // A curve that ends before the game did is missing minutes too.
    expect(report('beastmaster', { ...match, radiant_gold_adv: match.radiant_gold_adv.slice(0, 30) }).windows).toBeNull();
    // A minute exactly level belongs to neither side and ends a run.
    const level = { ...match, radiant_gold_adv: match.radiant_gold_adv.map((v: number, i: number) => (i === 23 ? 0 : v)) };
    expect(report('beastmaster', level).windows.filter((w: any) => w.ahead === 'my_team').map((w: any) => w.clock)).toEqual(['19:00–23:00', '24:00–29:00']);
  });
});

describe('window_report as evidence', () => {
  const kit: any = reviewToolkit({ trace, hero: 'beastmaster', lang: 'zh', match });
  const record = kit.runTool('window_report', { hero: 'beastmaster' });

  it('is a tool of the agent, and its refs resolve to the records a reader is shown', () => {
    expect(kit.tools.map((t: any) => t.name)).toContain('window_report');
    expect(record).toMatchObject({ tool: 'window_report', ref: 'window:beastmaster' });
    const whole: any = resolveRef(trace, 'window:beastmaster', { hero: 'beastmaster', lang: 'zh', match });
    expect(whole).toMatchObject({ kind: 'window', record: { highest_lead: { value: 3565 } } });
    // The summary is the counts: no windows, no gaps.
    expect(whole.record).not.toHaveProperty('windows');
    expect(whole.record).not.toHaveProperty('gaps');
    const one: any = resolveRef(trace, 'window:beastmaster:2', { hero: 'beastmaster', lang: 'zh', match });
    expect(one).toMatchObject({ kind: 'window', record: { clock: '19:00–29:00', ahead: 'my_team' }, names: { phantom_assassin: '幻影刺客' } });
    // An item in a window resolves through item_timeline, the record it came from.
    expect(resolveRef(trace, 'item:phantom_assassin:black_king_bar', { hero: 'beastmaster', match })!.record.first_held.clock).toBe('21:29');
    for (const bad of ['window:beastmaster:9', 'window:x', 'window:2:1', 'windows']) expect(resolveRef(trace, bad, { hero: 'beastmaster', match })).toBeNull();
    // Without the match data a window cannot be resolved.
    expect(resolveRef(trace, 'window:beastmaster:2', { hero: 'beastmaster' })).toBeNull();
  });

  it('a sentence may state a window\'s times and numbers, and an item only by the record it came from', () => {
    const plan = (fact: string, refs: string[]) => ({ verdict: 'v', mainline: [], findings: [], game_plan: { window: '你们在 19:00 到 29:00 领先，25:00 时最多领先 3565。', course: 'c', your_part: 'y', main_reason: 'team_play', why: 'w', evidence: [{ refs, fact }] } });
    const problems = (fact: string, refs: string[]) => verifyReview(plan(fact, refs), [kit.context, record]).problems.filter((p: any) => p.where.startsWith('plan'));
    expect(problems('19:00 到 29:00 你们领先，最多领先 3565（25:00），期间你们拆了 2 座建筑、对面拆了 3 座。', ['window:beastmaster:2'])).toEqual([]);
    expect(problems('幻影刺客在 21:29 出了黑皇杖。', ['item:phantom_assassin:black_king_bar'])).toEqual([]);
    // The peak of another window is not in this one.
    expect(problems('19:00 到 29:00 最多领先 27728。', ['window:beastmaster:2'])).toEqual([expect.objectContaining({ kind: 'moment' })]);
    const shown = planOf(plan('19:00 到 29:00 你们领先。', ['window:beastmaster:2']).game_plan, [], verifyReview(plan('x', ['window:beastmaster:2']), [kit.context, record]).refs)!;
    expect(shown.window).toBe('你们在 19:00 到 29:00 领先，25:00 时最多领先 3565。');
    expect(shown.evidence[0]).toMatchObject({ refs: ['window:beastmaster:2'], clock: '19:00' });
    // A plan with only its window sentence left still shows.
    expect(planOf({ window: 'w', evidence: [{ refs: ['window:beastmaster:2'], fact: 'f' }] }, [], new Map())).toMatchObject({ window: 'w' });
    // A window sentence that fails the check is left out by itself.
    expect(planOf({ window: 'w', course: 'c', evidence: [{ refs: ['window:beastmaster:2'], fact: 'f' }] }, [{ where: 'plan', index: 5 } as any], new Map())).not.toHaveProperty('window');
  });

  it('fights in a window are match_overview\'s, under the same refs', () => {
    const o = runTraceTool(trace, 'match_overview', {}, { perspective: 'beastmaster', match }) as any;
    for (const f of report().windows[1].fights) expect(o.fights.find((x: any) => x.ref === f.fight)).toMatchObject({ my_team_deaths: f.my_team_deaths, enemy_deaths: f.enemy_deaths });
  });
});

describe('review of #280: what the window report must agree on', () => {
  it('reads the game\'s patch as power_spikes does, also when the match data has no patch', async () => {
    const { powerSpikes } = await import('../../lib/agent/situationTools.js');
    // A game of 7.41f by its start time (7.41f rolled out 2026-09-15, 7.42 on 2026-11-18), with no patch in the
    // match data: both tools read 7.41f's items.
    const older = { ...match, patch: undefined, start_time: Date.parse('2026-10-20T00:00:00Z') / 1000 };
    const w: any = windowReport(trace, { hero: 'beastmaster' }, { match: older });
    const p: any = powerSpikes(trace, { hero: 'beastmaster' }, { match: older });
    expect(w.data_patch).toBe('7.41f');
    expect(w.data_patch).toBe(p.data_patch);
    // The same items are big to both: every big item power_spikes lists for an enemy inside window 2 is in it.
    const inWindow = (t: string) => { const [m, sec] = t.split(':').map(Number); const x = m * 60 + sec; return x >= 1140 && x < 1740; };
    const theirs = p.enemies.flatMap((e: any) => e.big_items.filter((i: any) => inWindow(i.first_held)).map((i: any) => `${e.enemy}:${i.item}`)).sort();
    expect(w.windows[1].big_items_finished.enemy.map((x: any) => `${x.hero}:${x.item}`).sort()).toEqual(theirs);
    // With the patch in the match data, that is the patch.
    expect((windowReport(trace, { hero: 'beastmaster' }, { match }) as any).data_patch).toBe((powerSpikes(trace, { hero: 'beastmaster' }, { match }) as any).data_patch);
  });

  it('a building that falls at the minute the lead changes sides is the next window\'s, never both', () => {
    // A tower moved to 29:00 exactly, the minute the enemy went ahead.
    const i = trace.buildings.findIndex((b: any) => /badguys_tower1_top$/.test(trace.names[b[1]]));
    const moved = { ...trace, buildings: trace.buildings.map((b: any, j: number) => (j === i ? [1740, b[1], b[2], b[3]] : b)) };
    const w: any = windowReport(moved, { hero: 'beastmaster' }, { match });
    const where = w.windows.filter((x: any) => x.buildings.some((b: any) => b.clock === '29:00')).map((x: any) => x.ref);
    expect(where).toEqual(['window:beastmaster:3']);
    // Each building of the game is in at most one window, and the Ancient, at the end of the game, is in the last.
    const all = w.windows.flatMap((x: any) => x.buildings.map((b: any) => `${b.clock} ${b.building}`));
    expect(new Set(all).size).toBe(all.length);
    expect(w.windows.at(-1).buildings.at(-1)).toMatchObject({ building: 'badguys_fort', clock: '42:31' });
  });

  it('the lead at each 5-minute mark can be stated, citing the summary', () => {
    const kit: any = reviewToolkit({ trace, hero: 'beastmaster', lang: 'zh', match });
    const record = kit.runTool('window_report', { hero: 'beastmaster' });
    expect(record.measured_at).toEqual(['5:00', '10:00', '15:00', '20:00', '25:00', '30:00', '35:00', '40:00']);
    // Only the summary is a source: no other tool states 10:00 in this check.
    const sources = [record];
    const review = (fact: string, line: string) => ({ verdict: 'v', mainline: [], findings: [], game_plan: { window: line, course: 'c', evidence: [{ refs: ['window:beastmaster'], fact }] } });
    const problems = verifyReview(review('10:00 时你们落后 482。', '10:00 时你们还落后 482，20:00 已经领先 2245。'), sources).problems.filter((p: any) => p.where.startsWith('plan'));
    expect(problems).toEqual([]);
    // A mark the report does not read at is not backed.
    expect(verifyReview(review('12:00 时你们落后 482。', 'x'), sources).problems.filter((p: any) => p.where === 'plan_evidence')).toEqual([expect.objectContaining({ kind: 'moment', text: expect.stringContaining('12:00') })]);
  });

  it('a window read from another hero\'s side has its own refs, and they open the same record', () => {
    const kit: any = reviewToolkit({ trace, hero: 'beastmaster', lang: 'en', match });
    const axe = kit.runTool('window_report', { hero: 'axe' });
    expect(axe.ref).toBe('window:axe');
    const three = axe.windows[2];
    expect(three).toMatchObject({ ref: 'window:axe:3', ahead: 'my_team', buildings_taken: { my_team: 15, enemy: 0 } });
    // Opened inside Beastmaster's review, the ref is still Axe's side of the game.
    const opened: any = resolveRef(trace, 'window:axe:3', { hero: 'beastmaster', lang: 'en', match });
    expect(opened.record).toMatchObject({ ref: 'window:axe:3', ahead: 'my_team', buildings_taken: { my_team: 15, enemy: 0 } });
    expect(resolveRef(trace, 'window:beastmaster:3', { hero: 'beastmaster', match })!.record).toMatchObject({ ahead: 'enemy', buildings_taken: { my_team: 0, enemy: 15 } });
  });
});
