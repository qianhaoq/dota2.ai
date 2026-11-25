import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildProbes, gradeProbe, numbersIn, clocksIn, sideCounts, zhNumeral, namesPlace, buildingCounts, scoreProbes, PROBE_KINDS } from '../../lib/agent/probes.js';
import { reviewToolkit } from '../../lib/agent/deepReview.js';
import { runChat } from '../../lib/agent/chat.js';

const FIXTURE = new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url);
/** A real ranked game (9100904020): Beastmaster on Dire, lost in 42:31. */
const trace = JSON.parse(gunzipSync(readFileSync(FIXTURE)).toString());
const kit: any = reviewToolkit({ trace, hero: 'beastmaster', lang: 'en' });
const names = { heroNames: kit.context.hero_names, placeNames: kit.context.place_names, lang: 'en' };

describe('probes: questions the replay settles, with the answer the tools give', () => {
  const probes: any[] = buildProbes(trace, 'beastmaster') as any[];

  it('builds every kind on a full game, in a fixed order, the same twice', () => {
    expect(probes.map((p) => p.kind)).toEqual(PROBE_KINDS);
    expect(buildProbes(trace, 'beastmaster')).toEqual(probes);
    expect(buildProbes(trace, 'pudge')).toBeNull();
  });

  it('every expected answer is what its source tool returns', () => {
    const at = (kind: string) => probes.find((p) => p.kind === kind);
    const run = (p: any) => kit.runTool(p.source.tool, p.source.args);
    expect(at('deaths_before_10').expect.numbers).toEqual([run(at('deaths_before_10')).my_deaths_before_10_00_total]);
    expect(at('most_avoidable_death').expect.clock).toBe(run(at('most_avoidable_death')).most_left_unused[0].clock);
    const fight = run(at('not_in_lost_fight')).fights.find((f: any) => at('not_in_lost_fight').question.includes(` ${f.clock} `));
    expect(fight.lost_fewer_heroes).toBe('enemy');
    expect(fight.me).toBe('took_part');
    expect(at('not_in_lost_fight').expect.heroes).toEqual(fight.my_team.not_in_it.map((x: any) => x.hero));
    // With the player in the fight, everyone missing is an ally the answer can name.
    expect(at('not_in_lost_fight').expect.heroes).not.toContain('beastmaster');
    expect(at('heroes_in_lost_fight').expect.sides).toEqual([{ count: fight.my_team.took_part_count, heroes: fight.my_team.took_part }, { count: fight.enemy.took_part_count, heroes: fight.enemy.took_part }]);
    const rosh = run(at('first_aegis')).takes[0];
    expect(at('first_aegis').expect).toEqual({ heroes: [rosh.aegis_holder], clock: rosh.clock });
    const state = run(at('where_was_ally'));
    const ally = state.my_team.heroes.find((s: any) => at('where_was_ally').question.includes(kit.context.hero_names[s.hero]));
    expect(ally.alive).toBe(true);
    expect(at('where_was_ally').expect.place).toBe(ally.place);
    const lost = run(at('first_tower_lost')).buildings.filter((b: any) => b.lost_by === 'my_team' && /_tower\d/.test(b.building)).map((b: any) => b.clock);
    expect(lost).toContain(at('first_tower_lost').expect.clock);
    // The earliest, a tower my team denied included: it was lost all the same.
    const sec = (c: string) => Number(c.split(':')[0]) * 60 + Number(c.split(':')[1]);
    expect(Math.min(...lost.map(sec))).toBe(sec(at('first_tower_lost').expect.clock));
  });

  it('two-lookup probes: a moment from one tool, the answer from another', () => {
    const at = (kind: string) => probes.find((p) => p.kind === kind);
    // The fight is asked by its start, as fight_report gives it; decision_points gives the same fight by its end.
    const won = kit.runTool('decision_points', { hero: 'beastmaster' }).points.find((p: any) => p.kind === 'after_a_won_fight' && p.won_by === 'my_team');
    const start = kit.runTool('fight_report', { hero: 'beastmaster' }).fights.find((f: any) => f.fight === won.fight).clock;
    expect(at('buildings_after_won_fight').question).toContain(` ${start}, `);
    expect(start).not.toBe(won.clock);
    // After the fight: a building that fell while it was still going is not one taken after it.
    expect(at('buildings_after_won_fight').expect).toEqual({ buildings: won.buildings_winners_took.filter((b: any) => !b.during_the_fight).length });
    // Where I was at the second the first tower fell.
    const tower = at('first_tower_lost').expect.clock;
    expect(at('where_i_was_at_first_tower_lost').source).toEqual({ tool: 'game_state', args: { hero: 'beastmaster', at: tower } });
    const me = kit.runTool('game_state', { hero: 'beastmaster', at: tower }).my_team.heroes.find((s: any) => s.hero === 'beastmaster');
    expect(at('where_i_was_at_first_tower_lost').expect).toEqual(me.alive ? { my_team: 'dire', place: me.place } : { dead: true });
    const aegis = kit.runTool('roshan_report', { hero: 'beastmaster' }).takes[0];
    expect(at('buildings_after_first_aegis').expect).toEqual({ buildings: aegis.buildings_taking_side_took_count });
  });

  it('asks in the reader\'s language', () => {
    const zh: any[] = buildProbes(trace, 'beastmaster', { lang: 'zh' }) as any[];
    expect(zh.map((p) => p.expect)).toEqual(probes.map((p) => p.expect));
    expect(zh.find((p) => p.kind === 'where_was_ally').question).toMatch(/斯温/);
  });

  it('the player\'s own Aegis: answered by "you" or by their hero, on the real fixture', () => {
    const pa: any = (buildProbes(trace, 'phantom_assassin') as any[]).find((p) => p.kind === 'first_aegis');
    expect(pa.expect).toEqual({ me: 'phantom_assassin', clock: '32:18' });
    const n = { heroNames: reviewToolkit({ trace, hero: 'phantom_assassin', lang: 'en' })!.context.hero_names, placeNames: {}, lang: 'en' };
    expect(gradeProbe(pa, 'Phantom Assassin took the first Aegis at 32:18.', n).pass).toBe(true);
    expect(gradeProbe(pa, 'You took the first Aegis at 32:18.', n).pass).toBe(true);
  });

  it('no Aegis pickup gives no Aegis probe, never one whose answer is "nobody"', () => {
    const noAegis = { ...trace, items: trace.items.map((it: any) => { const { item_aegis, ...rest } = it ?? {}; return rest; }) };
    const rosh: any = reviewToolkit({ trace: noAegis, hero: 'beastmaster', lang: 'en' })!.runTool('roshan_report', { hero: 'beastmaster' });
    expect(rosh.takes).toEqual([]);
    const kinds = (buildProbes(noAegis, 'beastmaster') as any[]).map((p) => p.kind);
    expect(kinds).toEqual(PROBE_KINDS.filter((k) => k !== 'first_aegis' && k !== 'buildings_after_first_aegis'));
  });
});

describe('probes: grading an answer', () => {
  const probes: any[] = buildProbes(trace, 'beastmaster') as any[];
  const at = (kind: string) => probes.find((p) => p.kind === kind);

  it('a zero said of something else never answers a count of deaths', () => {
    const d = { kind: 'deaths_before_10', source: { args: {} }, expect: { numbers: [0] } };
    expect(gradeProbe(d, 'You died three times; none of those deaths were avoidable.', names).pass).toBe(false);
    expect(gradeProbe(d, 'You died twice and took nothing for it.', names).pass).toBe(false);
    expect(gradeProbe(d, 'You never died before 10:00.', names).pass).toBe(true);
  });

  it('reads numbers in digits and words, never out of a clock', () => {
    expect(numbersIn('You died twice, at 6:13 and 8:27.')).toEqual([2]);
    expect(numbersIn('Four deaths: 0:47, 2:51')).toEqual([4]);
    expect(numbersIn('你死了四次', 'zh')).toContain(4);
    expect(clocksIn('at 36:05, then 41:57')).toEqual([2165, 2517]);
  });

  it('passes the right answer and fails a wrong one', () => {
    const d = at('deaths_before_10');
    expect(gradeProbe(d, `You died ${d.expect.numbers[0]} times before 10:00.`, names).pass).toBe(true);
    expect(gradeProbe(d, `You died ${d.expect.numbers[0] + 1} times before 10:00.`, names)).toMatchObject({ pass: false, missing: [String(d.expect.numbers[0])] });

    const nf = at('not_in_lost_fight');
    const missingNames = nf.expect.heroes.map((h: string) => kit.context.hero_names[h]);
    expect(gradeProbe(nf, `${missingNames.join(', ')} were not in it.`, names).pass).toBe(true);
    expect(gradeProbe(nf, `${missingNames[0]} was not in it.`, names)).toMatchObject({ pass: false, missing: missingNames.slice(1) });
    // Naming who was in it too does not fail the answer; it is kept for reading.
    expect(gradeProbe(nf, `${missingNames.join(', ')} were not in it; you and Undying were.`, names)).toMatchObject({ pass: true, also_named: ['Undying'] });

    const w = at('where_was_ally');
    expect(gradeProbe(w, `Sven was in the ${kit.context.place_names[w.expect.place]}.`, names).pass).toBe(true);
    expect(gradeProbe(w, 'Sven was in the river mid.', names).pass).toBe(false);
  });

  it('the most avoidable death is the first death the answer names, a second either way', () => {
    const m = at('most_avoidable_death');
    expect(gradeProbe(m, `Your ${m.expect.clock} death. Compare 41:57, which cost more.`, names).pass).toBe(true);
    expect(gradeProbe(m, `Your 41:57 death, more than ${m.expect.clock}.`, names)).toMatchObject({ pass: false, wrong: ['41:57'] });
    expect(gradeProbe(m, 'Your 36:06 death.', names).pass).toBe(true);
    expect(gradeProbe(m, 'Your 36:08 death.', names)).toMatchObject({ pass: false, missing: ['36:05'] });
    expect(gradeProbe(m, 'The fight at 33:00 went badly; your 36:05 death.', names).pass).toBe(true);
  });

  it('a side\'s count is said by its number or by naming all its heroes; "you" stands for the player', () => {
    const h = at('heroes_in_lost_fight');
    const [mine, theirs] = h.expect.sides;
    const named = (side: any) => side.heroes.filter((x: string) => x !== 'beastmaster').map((x: string) => kit.context.hero_names[x]).join(', ');
    expect(gradeProbe(h, `You and ${named(mine)} against ${named(theirs)}.`, names).pass).toBe(true);
    expect(gradeProbe(h, `${mine.count} of yours against ${theirs.count}.`, names).pass).toBe(true);
    // The player is in the list as "you" or by their hero, never taken as said.
    expect(gradeProbe(h, `Only ${named(mine)} fought for your team, against ${named(theirs)}.`, names)).toMatchObject({ pass: false, missing: [String(mine.count)] });
    expect(gradeProbe(h, `只有${kit.context.hero_names.undying}替你们打，对面是${named(theirs)}。`, { ...names, lang: 'zh' }).pass).toBe(false);
    expect(gradeProbe(h, `Beastmaster and ${named(mine)} against ${named(theirs)}.`, names).pass).toBe(true);
    const uneven = { kind: 'heroes_in_lost_fight', source: { args: { hero: 'beastmaster' } }, expect: { sides: [{ count: 4, heroes: ['beastmaster', 'undying', 'sven', 'dark_willow'] }, { count: 5, heroes: ['axe', 'necrolyte', 'venomancer', 'mirana', 'phantom_assassin'] }] } };
    expect(gradeProbe(uneven, 'You, Undying, Sven and Dark Willow: 4 against 5.', names).pass).toBe(true);
    expect(gradeProbe(uneven, '4 of yours against 6.', names)).toMatchObject({ pass: false, wrong: ['enemy 6'] });
    expect(gradeProbe(uneven, 'Four of yours.', names)).toMatchObject({ pass: false, missing: ['5'] });
    const own = { kind: 'first_aegis', source: { args: { hero: 'beastmaster' } }, expect: { me: 'beastmaster', clock: '32:18' } };
    expect(gradeProbe(own, 'Beastmaster took it at 32:18.', names).pass).toBe(true);
    expect(gradeProbe(own, 'Your team took it at 32:18.', names).pass).toBe(false);
    expect(gradeProbe(own, 'You took it at 32:18.', names).pass).toBe(true);
    expect(gradeProbe(own, '你在 32:18 拿的。', { ...names, lang: 'zh' }).pass).toBe(true);
    expect(gradeProbe(own, 'Phantom Assassin took it at 32:18.', names).pass).toBe(false);
  });

  it('a clock before the horn is negative, and a zero can be said without a number', () => {
    expect(clocksIn('your death at -0:37, then 1:05')).toEqual([-37, 65]);
    expect(clocksIn('在 −0:37')).toEqual([-37]);
    const pre = { kind: 'most_avoidable_death', source: { args: {} }, expect: { clock: '-0:37', among: ['-0:37'] } };
    expect(gradeProbe(pre, 'Your only death, at −0:37.', names).pass).toBe(true);
    expect(gradeProbe(pre, 'Your only death, at 0:37.', names).pass).toBe(false);
    expect(numbersIn('你开局一次都没死。', 'zh')).toEqual([0]);
    expect(numbersIn('You never died before 10:00.')).toContain(0);
  });

  it('reads a Chinese count whole, and only before a counter', () => {
    expect(numbersIn('你死了十四次', 'zh')).toEqual([14]);
    expect(numbersIn('你死了四次', 'zh')).toEqual([4]);
    expect(numbersIn('二十个人头，一波团', 'zh')).toEqual([20]);
    // 座 counts buildings: "拆了一座" answers how many buildings.
    expect(numbersIn('一座。之后拆了三座塔', 'zh')).toEqual([1, 3]);
    expect([zhNumeral('十'), zhNumeral('十四'), zhNumeral('二十'), zhNumeral('三十五'), zhNumeral('十十')]).toEqual([10, 14, 20, 35, null]);
    const d = { kind: 'deaths_before_10', source: { args: {} }, expect: { numbers: [1] } };
    expect(gradeProbe(d, '你一次都没死。', { ...names, lang: 'zh' }).pass).toBe(false);
    expect(gradeProbe({ ...d, expect: { numbers: [4] } }, '你死了十四次。', { ...names, lang: 'zh' }).pass).toBe(false);
    expect(gradeProbe({ ...d, expect: { numbers: [14] } }, '你死了十四次。', { ...names, lang: 'zh' }).pass).toBe(true);
  });

  it('a fight count belongs to the side it is said of', () => {
    expect(sideCounts('Your team brought two heroes, and the enemy brought four.')).toEqual({ mine: [2], theirs: [4] });
    expect(sideCounts("Radiant's 4 versus Dire's 5.", 'en', 'dire')).toEqual({ mine: [5], theirs: [4] });
    expect(sideCounts('你方 4 个英雄参战，敌方 5 个。', 'zh')).toEqual({ mine: [4], theirs: [5] });
    expect(sideCounts('You fought 4v5.')).toEqual({ mine: [4], theirs: [5] });
    expect(sideCounts('Two allies and four enemies took part.')).toEqual({ mine: [2], theirs: [4] });
    expect(sideCounts('You brought 2 allied heroes and they brought 4 enemy heroes.')).toEqual({ mine: [2], theirs: [4] });
    expect(sideCounts('我们来了 2 个人，对面来了 4 个敌人。', 'zh')).toEqual({ mine: [2], theirs: [4] });
    expect(sideCounts('You fought 4 vs 5.')).toEqual({ mine: [4], theirs: [5] });
    expect(sideCounts('你们 4 打 5。', 'zh')).toEqual({ mine: [4], theirs: [5] });
    const p = { kind: 'heroes_in_lost_fight', source: { args: { hero: 'beastmaster' } }, expect: { my_team: 'dire', sides: [{ count: 2, heroes: ['beastmaster', 'undying'] }, { count: 4, heroes: ['axe', 'necrolyte', 'venomancer', 'mirana'] }] } };
    expect(gradeProbe(p, 'Your team brought two heroes, and the enemy brought four.', names).pass).toBe(true);
    expect(gradeProbe(p, 'Your team brought four heroes, and the enemy brought two.', names)).toMatchObject({ pass: false, wrong: ['my team 4', 'enemy 2'] });
  });

  it('a place is read the way a player says it, "your own" being the player\'s side', () => {
    expect(namesPlace('you were in your own mid lane', 'dire_mid', 'en', 'dire')).toBe(true);
    expect(namesPlace('you were in Radiant mid', 'dire_mid', 'en', 'dire')).toBe(false);
    expect(namesPlace('in the bottom river', 'river_bot_lane', 'en', 'radiant')).toBe(true);
    expect(namesPlace('in the top river', 'river_top_jungle', 'en', 'radiant')).toBe(false);
    expect(namesPlace('in the enemy top lane', 'river_top_lane', 'en', 'radiant')).toBe(false);
    expect(namesPlace('in the enemy top lane', 'dire_top_lane', 'en', 'radiant')).toBe(true);
    expect(namesPlace('your bottom tier 1 fell', 'radiant_bot_lane', 'en', 'radiant')).toBe(false);
    expect(namesPlace('你在下路河道', 'river_bot_lane', 'zh', 'dire')).toBe(true);
    expect(namesPlace('你在自家上路野区', 'dire_top_jungle', 'zh', 'dire')).toBe(true);
    expect(namesPlace('你在自家上路', 'dire_top_jungle', 'zh', 'dire')).toBe(false);
    expect(namesPlace('你在自家上路。', 'dire_top_lane', 'zh', 'dire')).toBe(true);
    expect(namesPlace('你在敌方下路。', 'radiant_bot_lane', 'zh', 'dire')).toBe(true);
    expect(namesPlace('back in your base', 'radiant_base', 'en', 'radiant')).toBe(true);
    // The side before the lane, in the same clause: never one named after it, or across a comma.
    expect(namesPlace('You were in Radiant mid, Dire took the tower.', 'dire_mid', 'en', 'radiant')).toBe(false);
    expect(namesPlace('You were in Radiant mid, Dire took the tower.', 'radiant_mid', 'en', 'radiant')).toBe(true);
    expect(namesPlace('in Radiant mid while Dire pushed', 'dire_mid', 'en', 'radiant')).toBe(false);
    expect(namesPlace('你在天辉中路，夜魇拆了塔', 'dire_mid', 'zh', 'radiant')).toBe(false);
  });

  it('"took nothing" is a zero, and a dead player is "dead"', () => {
    const n = { kind: 'buildings_after_won_fight', source: { args: {} }, expect: { buildings: 0 } };
    expect(gradeProbe(n, 'You took nothing in those two minutes.', names).pass).toBe(true);
    expect(gradeProbe(n, '之后两分钟一座都没拆。', { ...names, lang: 'zh' }).pass).toBe(true);
    expect(gradeProbe(n, 'You took one tower.', names)).toMatchObject({ pass: false, wrong: ['1'] });
    const d = { kind: 'where_i_was_at_first_tower_lost', source: { args: {} }, expect: { dead: true } };
    expect(gradeProbe(d, 'You were dead, 20 s from respawning.', names).pass).toBe(true);
    expect(gradeProbe(d, '你当时阵亡了，还要 12 秒复活。', { ...names, lang: 'zh' }).pass).toBe(true);
    expect(gradeProbe(d, 'You were in the Dire jungle.', names).pass).toBe(false);
    // Back already, or "not dead": wrong, though the words are there.
    for (const t of ['You had already respawned and were farming mid.', 'You were not dead.', "You weren't dead then."]) expect(gradeProbe(d, t, names)).toMatchObject({ pass: false, wrong: ['alive'] });
    for (const t of ['你当时已经复活，正在中路打钱。', '你当时没死。']) expect(gradeProbe(d, t, { ...names, lang: 'zh' })).toMatchObject({ pass: false, wrong: ['活着'] });
    // Said of someone else, "alive" says nothing about the player.
    expect(gradeProbe(d, '你当时已经死了，在读秒。敌方活着的只有拉比克。', { ...names, lang: 'zh' }).pass).toBe(true);
    expect(gradeProbe(d, 'You were dead; only Lion was alive near it.', names).pass).toBe(true);
    // Someone else dead is not the player dead.
    expect(gradeProbe(d, 'Lion was dead; you were farming mid.', names).pass).toBe(false);
    expect(gradeProbe(d, '莱恩阵亡了，你在中路打钱。', { ...names, lang: 'zh' }).pass).toBe(false);
    expect(gradeProbe(d, '那一刻你**已经死了**，正在读秒。', { ...names, lang: 'zh' }).pass).toBe(true);
    expect(gradeProbe(d, '你当时是死的。你们活着的灰烬之灵在中路。', { ...names, lang: 'zh' }).pass).toBe(true);
    // Advice after the answer is not the answer.
    expect(gradeProbe(d, '那一刻你已经死了。下次你活着站在塔后，两个人推不动一塔。', { ...names, lang: 'zh' }).pass).toBe(true);
    expect(gradeProbe(d, 'You were alive in mid. Had you died there, the tower would still have fallen.', names)).toMatchObject({ pass: false, wrong: ['alive'] });
  });

  it('a building count is a number said of buildings, never the minutes in the question', () => {
    const two = { kind: 'buildings_after_won_fight', source: { args: {} }, expect: { buildings: 2 } };
    expect(gradeProbe(two, 'We took one tower in the two minutes after the fight.', names)).toMatchObject({ pass: false, wrong: ['1'] });
    expect(gradeProbe(two, 'Two buildings: the tier 1 top and the tier 2 top.', names).pass).toBe(true);
    expect(gradeProbe(two, 'One tower and one barracks.', names).pass).toBe(true);
    // A total and its parts are told apart: parts alone add up, a total followed by its parts is the total.
    const one = { ...two, expect: { buildings: 1 } };
    expect(gradeProbe(one, 'One tower and one barracks.', names)).toMatchObject({ pass: false, wrong: ['1+1'] });
    const three = { ...two, expect: { buildings: 3 } };
    expect(gradeProbe(three, 'They took 3 buildings: 2 towers and 1 barracks.', names).pass).toBe(true);
    expect(gradeProbe({ ...two, expect: { buildings: 6 } }, 'They took 3 buildings: 2 towers and 1 barracks.', names)).toMatchObject({ pass: false, wrong: ['3'] });
    expect(gradeProbe(three, '拆了三座：两座塔、一座兵营。', { ...names, lang: 'zh' }).pass).toBe(true);
    // A tier, a clock or a bracketed aside between two parts is not a count and does not stop them adding up.
    expect(gradeProbe(three, 'We took two tier 2 towers and one tier 3 tower.', names).pass).toBe(true);
    expect(gradeProbe(two, 'We took two tier 2 towers and one tier 3 tower.', names)).toMatchObject({ pass: false, wrong: ['2+1'] });
    expect(gradeProbe(three, 'We took two T2 towers and one T3 tower.', names).pass).toBe(true);
    // However a tier is written, its number is never the count.
    expect(buildingCounts('We took three tier-2 towers.')).toEqual([3]);
    expect(gradeProbe(three, 'We took three tier-2 towers.', names).pass).toBe(true);
    expect(gradeProbe(two, 'We took three tier-2 towers.', names)).toMatchObject({ pass: false, wrong: ['3'] });
    expect(buildingCounts('The tier one tower fell, then 2 tier-3 towers and the T4 towers.')).toEqual([2]);
    expect(buildingCounts('拆了 3 座 T2 塔，上路二塔和三塔都没了', 'zh')).toEqual([3]);
    expect(gradeProbe(three, 'Two towers at 34:24 and 34:48 and one barracks.', names).pass).toBe(true);
    expect(gradeProbe(three, 'Two towers (at 32:52 and 33:31) and one barracks.', names).pass).toBe(true);
    expect(gradeProbe(three, '拆了两座二塔和一座三塔。', { ...names, lang: 'zh' }).pass).toBe(true);
    // A total set off by a comma only: it is the sum of the parts after it, so it is the total.
    expect(gradeProbe(three, 'They took 3 buildings, 2 towers and 1 barracks.', names).pass).toBe(true);
    expect(gradeProbe({ ...two, expect: { buildings: 6 } }, 'They took 3 buildings, 2 towers and 1 barracks.', names)).toMatchObject({ pass: false, wrong: ['3'] });
    expect(gradeProbe(three, '拆了三座，两座塔、一座兵营。', { ...names, lang: 'zh' }).pass).toBe(true);
    expect(gradeProbe(three, 'They took 3 buildings including 2 towers and 1 barracks.', names).pass).toBe(true);
    // A verb after the join is still a join; a count after a word naming a side is not a part of ours.
    expect(gradeProbe(three, 'We took two towers and destroyed one barracks.', names).pass).toBe(true);
    expect(gradeProbe(two, 'We took two towers and destroyed one barracks.', names)).toMatchObject({ pass: false, wrong: ['2+1'] });
    expect(gradeProbe(two, 'We took two towers, and the enemy took one tower back.', names).pass).toBe(true);
    expect(gradeProbe(three, 'We took two towers, and the enemy took one tower back.', names)).toMatchObject({ pass: false, wrong: ['2'] });
    expect(gradeProbe(three, '拆了两座塔，还拆了一座兵营。', { ...names, lang: 'zh' }).pass).toBe(true);
    expect(gradeProbe(two, '你们拆了两座塔，对面拆了一座。', { ...names, lang: 'zh' }).pass).toBe(true);
    expect(gradeProbe(three, '拆了三座，分别是两座塔和一座兵营。', { ...names, lang: 'zh' }).pass).toBe(true);
    expect(gradeProbe(two, 'In the two minutes after it, nothing fell.', names).pass).toBe(false);
    expect(gradeProbe(two, '两座：上路一塔和二塔。', { ...names, lang: 'zh' }).pass).toBe(true);
    const five = { kind: 'buildings_after_first_aegis', source: { args: {} }, expect: { buildings: 5 } };
    expect(gradeProbe(five, 'In the five minutes after it they took 3 towers.', names)).toMatchObject({ pass: false, wrong: ['3'] });
    expect(gradeProbe(five, 'They destroyed 5 buildings in the five minutes after.', names).pass).toBe(true);
    expect(buildingCounts('拿盾后五分钟里拆了 5 座建筑', 'zh')).toEqual([5]);
    // An answer that opens with the count; markup around a count; a tier is not a count.
    expect(gradeProbe(five, 'Five — in the 300 seconds after, none of your team was near.', names).pass).toBe(true);
    expect(gradeProbe({ ...two }, 'Their side took **two** buildings: your bottom tier 2 and top tier 2.', names).pass).toBe(true);
    const zero = { ...two, expect: { buildings: 0 } };
    expect(gradeProbe(zero, 'Zero buildings. The bottom tier 1 tower stood until 16:36.', names).pass).toBe(true);
    expect(gradeProbe(zero, '两分钟里你们一座建筑都没拆。上路一塔 18:47 才丢。', { ...names, lang: 'zh' }).pass).toBe(true);
    expect(gradeProbe(zero, '零。', { ...names, lang: 'zh' }).pass).toBe(true);
    expect(gradeProbe(five, '第一个不朽盾被拿走后，他们拆了 5 座建筑。', { ...names, lang: 'zh' }).pass).toBe(true);
  });

  it('scores by kind', () => {
    expect(scoreProbes([{ kind: 'a', pass: true }, { kind: 'a', pass: false }, { kind: 'b', pass: true }] as any)).toEqual({ probes: 3, passed: 2, not_graded: 0, by_kind: { a: { probes: 2, passed: 1 }, b: { probes: 1, passed: 1 } } });
  });

  it('a chat that looks the fact up passes; one that answers from nothing does not', async () => {
    const d = at('deaths_before_10');
    const n = d.expect.numbers[0];
    const looksUp = [{ toolCalls: [{ id: 'c1', name: d.source.tool, args: d.source.args }] }, { text: `You died ${n} times before 10:00.` }];
    let i = 0;
    const good: any = await runChat({ complete: async () => looksUp[Math.min(i++, 1)], trace, hero: 'beastmaster', lang: 'en', question: d.question });
    expect(good.tool_calls.map((c: any) => c.name)).toEqual(['lane_report']);
    expect(gradeProbe(d, good.text, names).pass).toBe(true);
    const guess: any = await runChat({ complete: async () => ({ text: `You died ${n + 2} times before 10:00.` }), trace, hero: 'beastmaster', lang: 'en', question: d.question });
    expect(gradeProbe(d, guess.text, names).pass).toBe(false);
  });
});
