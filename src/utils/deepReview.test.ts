import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { collectFacts, deepReviewSystem, nameHeroes, nextGame, placeNames, runDeepReview, statedFacts, SUBMIT_REVIEW, verifyReview, verifyText, sightClaims, DEEP_REVIEW_SCHEMA } from '../../lib/agent/deepReview.js';

const trace = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());
const scripted = (replies: any[]) => { const seen: any[] = []; let i = 0; return { seen, complete: async (o: any) => { seen.push(JSON.parse(JSON.stringify(o))); return replies[Math.min(i++, replies.length - 1)]; } }; };
const call = (name: string, args: any, id: string) => ({ id, name, args });

const investigate = { toolCalls: [
  call('ability_audit', { hero: 'beastmaster', ability: 'primal_roar' }, 'a'),
  call('immunity_windows', { hero: 'phantom_assassin', watch_hero: 'beastmaster', watch_ability: 'primal_roar' }, 'b'),
  call('death_context', { hero: 'beastmaster', index: 9 }, 'c'),
] };
const good = {
  title: '咆哮没有留给幻影刺客的 BKB',
  claim: '幻影刺客开了 7 次 BKB，只有 27:27 那次你的咆哮吼中了她。',
  evidence: [
    { refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 咆哮吼中开着 BKB 的幻影刺客，她 11 秒后（27:38）阵亡' },
    { refs: ['immune:phantom_assassin:3:beastmaster-primal_roar'], fact: '30:34 她开 BKB 时咆哮还在冷却，9 秒前 30:25 给了瘟疫法师' },
    { refs: ['death:beastmaster:9'], fact: '36:05 满血 2915，咆哮就绪没放' },
  ],
  fix: '对面核心有 BKB 时，咆哮只留给他。',
};
const invented = { title: '打钱', claim: '你 19:19 的经济只有 9,876。', evidence: [{ refs: ['fight:99'], fact: '落后 4.2k' }], fix: '多刷野。' };
/** What the reader gets: each evidence item with the game time of the first record it cites. */
const shown = (f: any, clocks: string[]) => ({ ...f, evidence: f.evidence.map((e: any, i: number) => ({ refs: e.refs, clock: clocks[i], fact: e.fact })) });
const goodShown = shown(good, ['27:27', '30:34', '36:05']);
const review = (findings: any[], extra: any = {}) => ({ verdict: '咆哮没有留给幻影刺客的 BKB。', mainline: ['30:25 的咆哮给了瘟疫法师。'], findings, next_game: ['咆哮留给带 BKB 的核心'], blind_spots: ['视野'], ...extra });

describe('fact collection', () => {
  it('reads times, numbers, the tools\' own counts, and what was said about each moment', () => {
    const f = collectFacts([{ deaths_total: 11, killed_by: { phantom_assassin: 7 }, deaths: [{ t: 1647.4, clock: '27:27', hp: 2915, deaths_within_12s: [{ dt: 10.8 }] }], note: 'died at 36:05 with 1,455 mana' }]);
    expect([...f.times].sort((a, b) => a - b)).toEqual([1647, 2165]);
    expect(f.numbers.has(2915)).toBe(true);
    // Top-level numbers, one level of maps, and list lengths are the counts a review may quote.
    expect([...f.summary].sort((a, b) => a - b)).toEqual([1, 7, 11]);
    // The record at 27:27 holds its own numbers, including the 12 of "deaths_within_12s".
    expect(f.moments).toHaveLength(1);
    expect(f.moments[0]).toMatchObject({ from: 1647.4, to: 1647.4 });
    for (const n of [2915, 10.8, 12]) expect(f.moments[0].numbers.has(n)).toBe(true);
    expect(f.moments[0].numbers.has(11)).toBe(false);
    const st = statedFacts('27:27 满血 2,915，落后 4.2k，杀了 7 次，1.3 秒后');
    expect(st.times).toEqual(['27:27']);
    expect(st.numbers).toEqual([
      { text: '2,915', value: 2915, approx: false, decimal: false, counted: false },
      { text: '4.2k', value: 4200, approx: true, decimal: false, counted: false },
      { text: '7', value: 7, approx: false, decimal: false, counted: true },
      { text: '1.3', value: 1.3, approx: false, decimal: true, counted: true, seconds: true },
    ]);
  });
  it('passes what the tools said and names what they did not', () => {
    const sources = [{ deaths_total: 11, killed_by: { phantom_assassin: 7 }, gold: 4298, deaths: [{ ref: 'death:x:6', t: 1647.4, hp: 2915, deaths_within_12s: [{ t: 1658.2, dt: 10.8 }] }, { ref: 'death:x:4', t: 1321, hp: 1476 }] }];
    const fine = { title: 't', claim: '27:25 时 2915 血，领先 4.3k', evidence: [{ refs: ['death:x:6'], fact: '27:27 之后 11 秒（27:38）阵亡，剩 2915 血' }], fix: '站到 700 码外，留 25 秒' };
    expect(verifyReview(review([fine], { verdict: '11 次阵亡里 7 次死于幻影刺客', mainline: [] }), sources)).toMatchObject({ ok: true, problems: [] });
    const bad = {
      title: 't', claim: '经济只有 9,876，1.3 秒就倒了',
      evidence: [
        { refs: ['death:x:99'], fact: 'x' },
        { fact: 'no ref at all' },
        // A real time and a real number, attached to the wrong record.
        { refs: ['death:x:4'], fact: '22:01 之后 27:38 阵亡，剩 2915 血' },
        { refs: ['death:x:6'], fact: '25 秒后阵亡' },
      ],
      fix: 'f',
    };
    expect(verifyReview(review([bad], { verdict: '19:19 输了，8 次被杀', mainline: ['27:27 好', '5:00 坏'], did_well: ['打了 3000 伤害'] }), sources).problems).toEqual([
      { where: 'verdict', index: 0, kind: 'time', text: '19:19' },
      // 8 is nowhere among the tools' counts (7 and 11 are).
      { where: 'verdict', index: 0, kind: 'count', text: '8' },
      { where: 'mainline', index: 1, kind: 'time', text: '5:00' },
      { where: 'did_well', index: 0, kind: 'number', text: '3000' },
      { where: 'finding', index: 0, kind: 'number', text: '9,876' },
      { where: 'finding', index: 0, kind: 'number', text: '1.3' },
      { where: 'finding', index: 0, kind: 'ref', text: 'death:x:99' },
      { where: 'finding', index: 0, kind: 'ref', text: '(no ref)' },
      { where: 'finding', index: 0, kind: 'moment', text: '27:38 (not in death:x:4)' },
      { where: 'finding', index: 0, kind: 'moment', text: '2915 (not in death:x:4)' },
      { where: 'finding', index: 0, kind: 'moment', text: '25 (not in death:x:6)' },
    ]);
  });
});

describe('who could see whom is never in the replay data', () => {
  it('a statement about vision is found in either language; saying the data lacks it is not one', () => {
    expect(sightClaims('那段时间斧王就站在你视野里，你只要把咆哮先手给斧王。')).toEqual(['站在你视野']);
    expect(sightClaims('Axe was in your vision the whole time.')).toEqual(['in your vision']);
    expect(sightClaims('对方看到了你进野区。')).toEqual(['看到了你']);
    expect(sightClaims('They could see you coming.')).toEqual(['could see']);
    // The honest version, and plain distances, pass.
    expect(sightClaims('录像数据里没有视野，无法判断对方是否看得见你。')).toEqual([]);
    expect(sightClaims('The replay has no vision data, so we cannot tell whether they could see you.')).toEqual([]);
    expect(sightClaims('斧王在 137 码内。他跳了进来。')).toEqual([]);
    expect(sightClaims(undefined as any)).toEqual([]);
  });

  it('it fails the check of an answer and of a review, with nothing else wrong', () => {
    expect(verifyText('Axe stood in your vision and you did not roar him.', [])).toEqual({ ok: false, problems: [{ kind: 'sight', text: 'in your vision' }] });
    expect(verifyText('Axe stood next to you and you did not roar him.', []).ok).toBe(true);
    const r = verifyReview({ verdict: 'You lost.', findings: [{ title: 'Roar', claim: '斧王一直在你视野里。', evidence: [] }] }, []);
    expect(r.problems).toContainEqual({ where: 'finding', index: 0, kind: 'sight', text: '在你视野' });
  });
});

describe('places are named in the reader\'s language', () => {
  it('every region the tools can name has a name in both languages', () => {
    const zh: Record<string, string> = placeNames('zh'); const en: Record<string, string> = placeNames('en');
    for (const side of ['radiant', 'dire', 'river']) for (const area of ['mid', 'top_lane', 'top_jungle', 'bot_lane', 'bot_jungle']) { expect(zh[`${side}_${area}`]).toMatch(/^[\u4e00-\u9fff]+$/); expect(en[`${side}_${area}`]).toMatch(/^[A-Za-z ]+$/); }
    expect(zh).toMatchObject({ dire_top_lane: '夜魇上路', radiant_bot_jungle: '天辉下路野区', river_mid: '河道中路', dire_base: '夜魇基地', dire: '夜魇', Dire: '夜魇' });
    expect(en).toMatchObject({ dire_top_lane: 'Dire top lane', radiant_base: 'Radiant base' });
    // In English the bare word is left alone ("a dire mistake").
    expect('dire' in en).toBe(false);
  });

  it('a key, or half of one, left in the text is replaced; other words are not', () => {
    const names = { axe: '斧王' };
    expect(nameHeroes({ verdict: '在 dire 上路被杀；dire_top_lane 再死；Dire 一方；radiant_base 里。dire_tower 不动，by axe now' }, names, placeNames('zh')).verdict)
      .toBe('在夜魇上路被杀；夜魇上路再死；夜魇一方；天辉基地里。dire_tower 不动，by 斧王 now');
    expect(nameHeroes({ verdict: 'A dire mistake in dire_top_lane near radiant_base. Dire won.' }, {}, placeNames('en')).verdict)
      .toBe('A dire mistake in Dire top lane near Radiant base. Dire won.');
    // Numbers and times next to a name keep their spacing.
    expect(nameHeroes({ verdict: '36:05 dire 3 人' }, names, placeNames('zh')).verdict).toBe('36:05 夜魇 3 人');
  });
});

describe('a whole number of seconds may be a tool\'s number rounded', () => {
  const src = [{ before_death: 7.6 }];
  it('"8 s" for 7.6 passes, in either language; a count does not get the same leeway', () => {
    expect(verifyText('阵亡前 8 秒召唤了野猪。', src).ok).toBe(true);
    expect(verifyText('Summoned 8 seconds before the death.', src).ok).toBe(true);
    expect(verifyText('阵亡前 7 秒。', src).ok).toBe(true);
    expect(verifyText('阵亡前 9 秒。', src).problems).toEqual([{ kind: 'count', text: '9' }]);
    expect(verifyText('死了 8 次。', src).problems).toEqual([{ kind: 'count', text: '8' }]);
  });
});

describe('review findings on #233', () => {
  it('evidence may state only what its cited records hold: a scoreboard number does not pass under a death', () => {
    const sources = [{ scoreboard: { net_worth: 16953 } }, { deaths_total: 1, deaths: [{ ref: 'death:x:1', t: 600, clock: '10:00', hp: 100 }] }];
    const at = (fact: string, refs = ['death:x:1']) => verifyReview(review([{ title: 't', claim: 'c', evidence: [{ refs, fact }], fix: 'f' }], { verdict: 'v', mainline: [] }), sources).problems;
    expect(at('At 10:00 you had 16953 HP')).toEqual([{ where: 'finding', index: 0, kind: 'moment', text: '16953 (not in death:x:1)' }]);
    expect(at('At 10:00 you had 100 HP')).toEqual([]);
  });

  it('a tool\'s counts have their own ref, which covers those counts and nothing nested below', () => {
    const sources = [{ ref: 'audit:x:roar', ref_scope: 'summary', casts_total: 5555, by_target: { pa: 4444 }, casts: [{ ref: 'cast:x:roar:1', t: 60, clock: '1:00', target_stunned_seconds: 3.4, damage: 777 }] }];
    const at = (refs: string[], fact: string) => verifyReview(review([{ title: 't', claim: 'c', evidence: [{ refs, fact }], fix: 'f' }], { verdict: 'v', mainline: [] }), sources).problems.map((p: any) => p.text);
    expect(at(['audit:x:roar'], '5555 casts, 4444 on her')).toEqual([]);
    // Inside one cast record, not among the audit's totals: citing the summary does not cover it.
    expect(at(['audit:x:roar'], 'stunned 3.4 s for 777 damage')).toEqual(['3.4 (not in audit:x:roar)', '777 (not in audit:x:roar)']);
    // One of the audit's totals, without citing the audit.
    expect(at(['cast:x:roar:1'], '5555 casts in all')).toEqual(['5555 (not in cast:x:roar:1)']);
    expect(at(['cast:x:roar:1', 'audit:x:roar'], 'at 1:00, one of 5555 casts, stunned 3.4 s')).toEqual([]);
  });

  it('a deaths summary backs the game times it lists its deaths by, and no others', () => {
    const src = { tool: 'death_context', ref: 'deaths:beastmaster', ref_scope: 'summary', deaths_total: 11, deaths_where: { no_ally_within_2200_at_death: ['2:51'], three_or_more_enemy_heroes_dealing_damage: ['8:27', '22:06', '25:30', '30:42', '36:05'] }, deaths: [{ ref: 'death:beastmaster:1', t: 47, clock: '0:47' }] };
    const f = (fact: string) => verifyReview({ verdict: 'v', findings: [{ title: 't', claim: 'c', evidence: [{ refs: ['deaths:beastmaster'], fact }] }] }, [src]).problems;
    expect(f('11 次阵亡里有 5 次是被三个以上敌人打死的：8:27、22:06、25:30、30:42、36:05；2:51 那次身边没有队友。')).toEqual([]);
    // A death's own time is in its record, not in the summary: 0:47 is not one the summary lists.
    expect(f('0:47 那次也是。')).toEqual([{ where: 'finding', index: 0, kind: 'moment', text: '0:47 (not in deaths:beastmaster)' }]);
  });

  it('a finding with no cited evidence is not accepted, whatever it says', async () => {
    const bare = { title: 'Alone', claim: 'You repeatedly fought alone.', fix: 'Stay with the team.' };
    expect(verifyReview(review([bare], { verdict: 'v', mainline: [] }), []).problems).toEqual([{ where: 'finding', index: 0, kind: 'ref', text: '(no evidence)' }]);
    expect(verifyReview(review([{ ...bare, evidence: [] }], { verdict: 'v', mainline: [] }), []).problems).toEqual([{ where: 'finding', index: 0, kind: 'ref', text: '(no evidence)' }]);
    // Submitted without a single lookup: asked once to repair, then dropped; nothing left is not a review.
    const m = scripted([{ toolCalls: [call('submit_review', review([bare], { verdict: 'v', mainline: [] }), 's')] }]);
    const r: any = await runDeepReview({ complete: m.complete, trace, hero: 'beastmaster' });
    expect(r).toMatchObject({ status: 'unverified', review: { findings: [] }, verification: { repaired: true, dropped: 1 } });
  });

  it('a percentage is checked as what it says', () => {
    const sources = [{ ref: 'pro_items:x', items: [{ item: 'blink', share_of_pro_games: 0.71 }], lane_efficiency_pct: 75 }];
    const at = (fact: string) => verifyReview(review([{ title: 't', claim: 'c', evidence: [{ refs: ['pro_items:x'], fact }], fix: 'f' }], { verdict: 'v', mainline: [] }), sources).problems.map((p: any) => p.text);
    expect(at('Blink Dagger appears in 71% of professional games')).toEqual([]);
    expect(at('a share of 0.71')).toEqual([]);
    expect(at('lane efficiency 75%')).toEqual([]);
    // 0.71% is not what a share of 0.71 says.
    expect(at('Blink Dagger appears in 0.71% of professional games')).toEqual(['0.71% (not in pro_items:x)']);
    expect(at('in 17% of games')).toEqual(['17% (not in pro_items:x)']);
    expect(statedFacts('71％ 的职业局').numbers[0]).toMatchObject({ text: '71%', value: 71, percent: true });
    // In prose too.
    expect(verifyReview(review([], { verdict: 'Blink in 71% of pro games, BKB in 9%', mainline: [] }), sources).problems).toEqual([{ where: 'verdict', index: 0, kind: 'number', text: '9%' }]);
  });

  it('the review can still be handed in after the last lookup is spent', async () => {
    const m = scripted([investigate, { toolCalls: [call('submit_review', review([good]), 's')] }]);
    // Three lookups allowed, three used: the next turn offers only submit_review, and it is accepted.
    const r: any = await runDeepReview({ complete: m.complete, trace, hero: 'beastmaster', lang: 'zh', maxToolCalls: 3 });
    expect(r.status).toBe('ok');
    expect(m.seen[1].tools.map((t: any) => t.name)).toEqual(['submit_review']);
  });
});

describe('runDeepReview', () => {
  it('investigates with the trace tools and returns the verified review', async () => {
    const m = scripted([investigate, { toolCalls: [call('submit_review', review([good]), 's')] }]);
    const r: any = await runDeepReview({ complete: m.complete, trace, hero: 'Beastmaster', lang: 'zh' });
    expect(r.status).toBe('ok');
    expect(r.review).toMatchObject({ schema: DEEP_REVIEW_SCHEMA, match_id: 9100904020, hero: 'beastmaster', lang: 'zh', findings: [goodShown], verdict: '咆哮没有留给幻影刺客的 BKB。' });
    expect(r.verification).toEqual({ repaired: false, first_pass_problems: 0, dropped: 0, problems: [] });
    expect(r.tool_calls.map((c: any) => c.name)).toEqual(['ability_audit', 'immunity_windows', 'death_context']);
    // The model is told who it reviews and what to call the heroes, in the reader's language.
    expect(m.seen[0].system).toContain('简体中文');
    expect(m.seen[0].messages[0].content).toContain('"player_hero":"beastmaster"');
    expect(m.seen[0].messages[0].content).toContain('"necrolyte":"瘟疫法师"');
    expect(m.seen[0].tools.map((t: any) => t.name)).toEqual(['match_overview', 'death_context', 'ability_audit', 'immunity_windows', 'fight_timeline', 'item_timeline', 'hero_abilities', 'pro_item_choices', 'submit_review']);
    // The tool results the model read are the real ones, told from the player's side.
    expect(JSON.parse(m.seen[1].messages.find((x: any) => x.tool_call_id === 'a').content).casts_total).toBe(10);
  });

  it('asks once for a repair, then drops what is still unsupported', async () => {
    const m = scripted([investigate, { toolCalls: [call('submit_review', review([good, invented]), 's1')] }, { toolCalls: [call('submit_review', review([good, invented], { verdict: '19:19 崩了', mainline: ['27:27 吼中', '19:19 崩'] }), 's2')] }]);
    const r: any = await runDeepReview({ complete: m.complete, trace, hero: 'beastmaster', lang: 'zh' });
    expect(r.status).toBe('ok');
    expect(r.review.findings).toEqual([goodShown]);
    expect(r.review.mainline).toEqual(['27:27 吼中']);
    // An unsupported verdict falls back to the first finding that stands.
    expect(r.review.verdict).toBe(good.title);
    expect(r.verification).toMatchObject({ repaired: true, dropped: 1 });
    const repair = JSON.parse(m.seen[2].messages.at(-1).content);
    expect(repair).toMatchObject({ error: 'unsupported_facts', problems: expect.arrayContaining([{ in: 'finding 2', text: '19:19', why: 'this time is not in any tool result' }, expect.objectContaining({ in: 'finding 2', text: 'fight:99' })]) });
    expect(m.seen).toHaveLength(3);
  });

  it('a repair that looks the fact up is accepted', async () => {
    const lane = { title: '一血', claim: '0:47 被击杀时身边没有队友。', evidence: [{ refs: ['death:beastmaster:1'], fact: '0:47 一血' }], fix: '等兵线。' };
    const m = scripted([investigate, { toolCalls: [call('submit_review', review([good, lane]), 's1')] }, { toolCalls: [call('death_context', { hero: 'beastmaster', index: 1 }, 'd')] }, { toolCalls: [call('submit_review', review([good, lane]), 's2')] }]);
    const r: any = await runDeepReview({ complete: m.complete, trace, hero: 'beastmaster' });
    expect(r.review.findings).toEqual([goodShown, shown(lane, ['0:47'])]);
    expect(r.verification).toMatchObject({ repaired: true, dropped: 0, problems: [] });
  });

  it('reports no review, nothing verifiable, and an unknown hero', async () => {
    expect(await runDeepReview({ complete: scripted([{ text: 'I think you played fine.' }]).complete, trace, hero: 'beastmaster' })).toMatchObject({ status: 'no_review' });
    expect(await runDeepReview({ complete: scripted([{ toolCalls: [call('submit_review', review([invented]), 's')] }]).complete, trace, hero: 'beastmaster' })).toMatchObject({ status: 'unverified', review: { findings: [] }, verification: { dropped: 1 } });
    expect(await runDeepReview({ complete: scripted([]).complete, trace, hero: 'pudge' })).toMatchObject({ status: 'unknown_hero', heroes: expect.arrayContaining(['beastmaster']) });
  });

  it('the scoreboard goes in without names or account ids', async () => {
    const m = scripted([{ toolCalls: [call('submit_review', review([{ ...good, evidence: [] , claim: '9 杀 11 死。' }]), 's')] }]);
    await runDeepReview({ complete: m.complete, trace, hero: 'beastmaster', match: { players: [{ hero_id: 38, kills: 9, deaths: 11, assists: 18, net_worth: 16953, gold_per_min: 450, last_hits: 260, personaname: 'someone', account_id: 123456789 }] } });
    const first = m.seen[0].messages[0].content;
    expect(first).toContain('"scoreboard":{"kills":9,"deaths":11,"assists":18,"net_worth":16953,"gold_per_min":450,"last_hits":260}');
    expect(first).not.toContain('someone');
    expect(first).not.toContain('123456789');
  });

  it('engine hero keys that slip through are replaced with the reader\'s names, refs untouched', () => {
    const out: any = nameHeroes({ verdict: 'sven 先死，然后 skywrath_mage；svens 不变', mainline: ['dark_willow 收掉 axe'], findings: [{ title: 'undying', claim: 'c', fix: 'sven', evidence: [{ refs: ['death:sven:1'], fact: 'sven 阵亡' }] }] }, { sven: '斯温', skywrath_mage: '天怒法师', dark_willow: '邪影芳灵', undying: '不朽尸王', axe: 'axe' });
    expect(out.verdict).toBe('斯温 先死，然后 天怒法师；svens 不变');
    expect(out.mainline).toEqual(['邪影芳灵 收掉 axe']);
    expect(out.findings[0]).toMatchObject({ title: '不朽尸王', fix: '斯温', evidence: [{ refs: ['death:sven:1'], fact: '斯温 阵亡' }] });
  });

  it('a finding carries a rule for the next game; what it says happened this game is checked', async () => {
    const rule = { when: '对面核心的黑皇杖还没开', do: '咆哮留着，等她开完再吼', this_game: '7 次黑皇杖里只有 27:27 那次吼中了她' };
    expect(SUBMIT_REVIEW.input_schema.properties.findings.items.required).toContain('rule');
    expect(SUBMIT_REVIEW.input_schema.properties.findings.items.properties.rule.required).toEqual(['when', 'do', 'this_game']);
    // The model no longer writes a second list beside its findings.
    expect('next_game' in SUBMIT_REVIEW.input_schema.properties).toBe(false);
    const m = scripted([investigate, { toolCalls: [call('submit_review', review([{ ...good, rule }, { ...good, title: '第二条', rule: { when: '  ', do: '买闪烁匕首' } }]), 's')] }]);
    const r: any = await runDeepReview({ complete: m.complete, trace, hero: 'beastmaster', lang: 'zh' });
    expect(r.status).toBe('ok');
    expect(r.review.findings[0].rule).toEqual(rule);
    // Half a rule is not shown as one; that finding's fix stands in for it.
    expect(r.review.findings[1].rule).toBeUndefined();
    expect(r.review.next_game).toEqual(['对面核心的黑皇杖还没开：咆哮留着，等她开完再吼', '对面核心有 BKB 时，咆哮只留给他。']);
    // A time the tools never gave, stated as what happened this game, fails like one in the claim — on the rule's own account.
    const bad = verifyReview(review([{ ...good, rule: { ...rule, this_game: '19:19 那次也是' } }]), [JSON.parse(m.seen[1].messages.find((x: any) => x.tool_call_id === 'a').content)]);
    expect(bad.problems).toContainEqual({ where: 'rule', index: 0, kind: 'time', text: '19:19' });
    // It costs that sentence, not the finding: the situation and the action stay, and the model is told where to look.
    const wrong = { ...good, rule: { ...rule, this_game: '19:19 那次也是' } };
    const m2 = scripted([investigate, { toolCalls: [call('submit_review', review([wrong]), 's')] }, { toolCalls: [call('submit_review', review([wrong]), 's2')] }]);
    const r2: any = await runDeepReview({ complete: m2.complete, trace, hero: 'beastmaster', lang: 'zh' });
    expect(r2.status).toBe('ok');
    expect(r2.review.findings[0].rule).toEqual({ when: rule.when, do: rule.do });
    expect(r2.verification).toMatchObject({ repaired: true, dropped: 0 });
    expect(r2.dropped_findings).toEqual([]);
    expect(JSON.parse(m2.seen[2].messages.at(-1).content).problems).toEqual([{ in: 'finding 1, rule.this_game', text: '19:19', why: 'this time is not in any tool result' }]);
    // A finding that is dropped is kept as it was written, for whoever has to find out why.
    const m3 = scripted([investigate, { toolCalls: [call('submit_review', review([good, invented]), 's')] }, { toolCalls: [call('submit_review', review([good, invented]), 's2')] }]);
    const r3: any = await runDeepReview({ complete: m3.complete, trace, hero: 'beastmaster', lang: 'zh' });
    expect(r3.verification.dropped).toBe(1);
    expect(r3.dropped_findings).toEqual([invented]);
    // The situation and the action are advice: a threshold in them is not a fact about the game.
    expect(verifyReview(review([{ ...good, rule: { when: '血量低于 50% 而熊战士在 1000 码内', do: '回家补给', this_game: rule.this_game } }]), m.seen.at(-1).messages.filter((x: any) => x.role === 'tool').map((x: any) => JSON.parse(x.content))).problems).toEqual([]);
  });

  it('next game is the findings\' rules in their order, in the reader\'s punctuation', () => {
    const f = [{ rule: { when: 'Below half health in lane', do: 'walk back to the tower' }, fix: 'x' }, { fix: 'Buy Blink by 20:00.' }, { fix: ' ' }];
    expect(nextGame(f, 'en')).toEqual(['Below half health in lane: walk back to the tower', 'Buy Blink by 20:00.']);
    expect(nextGame(undefined, 'zh')).toEqual([]);
    // Engine keys in a rule get the reader's names like the rest of the review.
    expect(nameHeroes({ verdict: 'v', findings: [{ title: 't', claim: 'c', fix: 'f', evidence: [], rule: { when: 'phantom_assassin 在场', do: '等 phantom_assassin', this_game: '7 次' } }] }, { phantom_assassin: '幻影刺客' }).findings[0].rule).toEqual({ when: '幻影刺客 在场', do: '等 幻影刺客', this_game: '7 次' });
  });

  it('the prompt asks for counted patterns, a checkable rule, and a fair share of the blame', () => {
    const s = deepReviewSystem('en');
    expect(s).toContain('deaths_where');
    expect(s).toContain('damage_share_in_death_windows');
    expect(s).toContain('off_cooldown_without_the_mana could not be cast');
    expect(s).toContain('"It was ready and not pressed" is not a finding on its own');
    expect(s).toContain('do not charge the team\'s lost fights to them');
    expect(s).toContain('was not wasted because one of them was spell immune');
  });

  it('the prompt states the rules the verifier enforces', () => {
    const s = deepReviewSystem('en');
    expect(s).toContain('MUST write ALL analysis and advice in English');
    expect(s).toContain('must be one a tool returned in this conversation');
    expect(s).toContain('my_team_gold_lead is negative when the player\'s team is behind');
    expect(s).toContain('never assume it did not');
    expect(s).toContain('Never join a fact from one record to a different moment');
    expect(SUBMIT_REVIEW.input_schema.properties.findings.items.properties.evidence.items.required).toEqual(['refs', 'fact']);
    expect(s).toContain('submit_review exactly once');
    expect(SUBMIT_REVIEW.input_schema.properties.findings.maxItems).toBe(3);
  });
});
