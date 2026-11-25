import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildProbes, gradeProbe, numbersIn, clocksIn, sideCounts, zhNumeral, scoreProbes, PROBE_KINDS } from '../../lib/agent/probes.js';
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

  it('asks in the reader\'s language', () => {
    const zh: any[] = buildProbes(trace, 'beastmaster', { lang: 'zh' }) as any[];
    expect(zh.map((p) => p.expect)).toEqual(probes.map((p) => p.expect));
    expect(zh.find((p) => p.kind === 'where_was_ally').question).toMatch(/斯温/);
  });

  it('no Aegis pickup gives no Aegis probe, never one whose answer is "nobody"', () => {
    const noAegis = { ...trace, items: trace.items.map((it: any) => { const { item_aegis, ...rest } = it ?? {}; return rest; }) };
    const rosh: any = reviewToolkit({ trace: noAegis, hero: 'beastmaster', lang: 'en' })!.runTool('roshan_report', { hero: 'beastmaster' });
    expect(rosh.takes).toEqual([]);
    const kinds = (buildProbes(noAegis, 'beastmaster') as any[]).map((p) => p.kind);
    expect(kinds).toEqual(PROBE_KINDS.filter((k) => k !== 'first_aegis'));
  });
});

describe('probes: grading an answer', () => {
  const probes: any[] = buildProbes(trace, 'beastmaster') as any[];
  const at = (kind: string) => probes.find((p) => p.kind === kind);

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
    const own = { kind: 'first_aegis', source: { args: { hero: 'beastmaster' } }, expect: { me: true, clock: '32:18' } };
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
    expect(numbersIn('二十个人头，一波团，一座塔', 'zh')).toEqual([20]);
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
    expect(sideCounts('You fought 4 vs 5.')).toEqual({ mine: [4], theirs: [5] });
    expect(sideCounts('你们 4 打 5。', 'zh')).toEqual({ mine: [4], theirs: [5] });
    const p = { kind: 'heroes_in_lost_fight', source: { args: { hero: 'beastmaster' } }, expect: { my_team: 'dire', sides: [{ count: 2, heroes: ['beastmaster', 'undying'] }, { count: 4, heroes: ['axe', 'necrolyte', 'venomancer', 'mirana'] }] } };
    expect(gradeProbe(p, 'Your team brought two heroes, and the enemy brought four.', names).pass).toBe(true);
    expect(gradeProbe(p, 'Your team brought four heroes, and the enemy brought two.', names)).toMatchObject({ pass: false, wrong: ['my team 4', 'enemy 2'] });
  });

  it('scores by kind', () => {
    expect(scoreProbes([{ kind: 'a', pass: true }, { kind: 'a', pass: false }, { kind: 'b', pass: true }] as any)).toEqual({ probes: 3, passed: 2, by_kind: { a: { probes: 2, passed: 1 }, b: { probes: 1, passed: 1 } } });
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
