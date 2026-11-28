import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { collectFacts, deepReviewSystem, headingOf, nameHeroes, placeNames, runDeepReview, statedFacts, SUBMIT_REVIEW, suggestChildRefs, verifyReview, verifyText, sightClaims, wordingProblems, DEEP_REVIEW_SCHEMA, CHAPTER_TOPICS } from '../../lib/agent/deepReview.js';
import { chaptersOf, highlightsOf } from '../../lib/agent/review/verify.js';
import { applyTranslation, extractTranslatable } from '../../lib/agent/review/translate.js';
import { logicOf, reviewTexts, rubricOf } from '../../lib/agent/evalReview.js';
import { shapeReview } from '../../lib/agent/replayTool.js';
import { checkedPart } from '../../lib/agent/chat.js';

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
const defaultChapters = [
  { topic: 'midgame', title: '中期团战', analysis: '27:27 咆哮吼中幻影刺客，定住后击杀。', evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 咆哮吼中开着 BKB 的幻影刺客，她 11 秒后（27:38）阵亡' }] },
  { topic: 'skills_and_items', title: '大招目标选择', analysis: '幻影刺客开了 7 次 BKB，咆哮留给她收益最高。', evidence: [{ refs: ['immune:phantom_assassin:3:beastmaster-primal_roar'], fact: '30:34 她开 BKB 时咆哮还在冷却，9 秒前 30:25 给了瘟疫法师' }] },
];
const review = (findings: any[], extra: any = {}) => ({ verdict: '咆哮没有留给幻影刺客的 BKB。', highlights: [], findings, chapters: [], blind_spots: ['视野'], ...extra });
const fullReview = (findings: any[], extra: any = {}) => review(findings, { chapters: defaultChapters, ...extra });

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
    const passed = verifyReview(review([fine], { verdict: '11 次阵亡里 7 次死于幻影刺客', mainline: [] }), sources);
    // Every fact in it is the tools': nothing is unsupported, and nothing would be dropped.
    expect(passed.problems.filter((p: any) => !p.soft)).toEqual([]);
    expect(passed.unsupported.findings.size).toBe(0);
    // How many numbers a sentence carries is the model's to judge (#405): nothing is asked about it.
    expect(passed.problems).toEqual([]);
    // With the claim cut to two, there is nothing to say at all.
    expect(verifyReview(review([{ ...fine, claim: '27:25 时 2915 血' }], { verdict: '11 次阵亡里 7 次死于幻影刺客', mainline: [] }), sources)).toMatchObject({ ok: true, problems: [] });
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
    expect(verifyReview(review([bad], {
      verdict: '19:19 输了，8 次被杀',
      highlights: [{ title: '打钱', detail: '打了 3000 伤害' }],
      chapters: [{ topic: 'laning', title: '对线', analysis: '5:00 崩了', evidence: [{ refs: ['death:x:6'], fact: '27:27' }] }],
    }), sources).problems).toEqual([
      { where: 'verdict', index: 0, kind: 'time', text: '19:19' },
      // 8 is nowhere among the tools' counts (7 and 11 are).
      { where: 'verdict', index: 0, kind: 'count', text: '8' },
      { where: 'finding', index: 0, kind: 'number', text: '9,876' },
      { where: 'finding', index: 0, kind: 'number', text: '1.3' },
      { where: 'finding', index: 0, kind: 'ref', text: 'death:x:99' },
      { where: 'finding', index: 0, kind: 'ref', text: '(no ref)' },
      { where: 'finding', index: 0, kind: 'moment', text: '27:38 (not in death:x:4)' },
      { where: 'finding', index: 0, kind: 'moment', text: '2915 (not in death:x:4)' },
      { where: 'finding', index: 0, kind: 'moment', text: '25 (not in death:x:6)' },
      { where: 'highlight', index: 0, kind: 'number', text: '3000' },
      { where: 'chapter', index: 0, kind: 'time', text: '5:00' },
      // And, apart from what is unsupported: the evidence item written in English ("no ref at all") in a Chinese review.
      { where: 'finding', index: 0, kind: 'english', text: 'ref, all', soft: true },
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

describe('a number stated plainly must be a tool\'s own, not one near an unrelated value (#295)', () => {
  // The real case: fight_report gave a distance of 11112; farm_report had a gold gain of 11297; the review wrote 11300.
  const src = [{ distance: 11112 }, { gained: { legion_commander: 11297 } }, { lead: 2915.4 }];
  it('a plain number passes only as the value itself, give or take rounding', () => {
    expect(verifyText('离战场 11300。', src).problems).toEqual([{ kind: 'number', text: '11300' }]);
    expect(verifyText('离战场 11112。', src).ok).toBe(true);
    expect(verifyText('领先 2915。', src).ok).toBe(true);
    expect(verifyText('领先 2916。', src).ok).toBe(true);
    expect(verifyText('领先 2930。', src).problems).toEqual([{ kind: 'number', text: '2930' }]);
    // The same in a review's own highlights.
    const r = verifyReview(review([], { verdict: 'v', highlights: [{ title: '回城', detail: '离战场 11300、回城卷轴可用。' }] }), src);
    expect(r.problems).toEqual([expect.objectContaining({ where: 'highlight', kind: 'number', text: '11300' })]);
  });

  it('a number the text calls approximate keeps the slack, in either language', () => {
    for (const t of ['离战场约 11000。', '离战场大约 11,000。', '离战场 11000 左右。', 'About 11,000 away.', 'roughly 11000 away', '~11000 away', '11k away']) expect(verifyText(t, src).ok).toBe(true);
    expect(verifyText('离战场约 13000。', src).ok).toBe(false);
    // 左右 after a unit (review of #300).
    for (const t of ['离战场 11100 码左右。', '差 11000 金左右。', '离战场 11000 码上下。']) expect(verifyText(t, src).ok).toBe(true);
  });

  it('a word that ends in 约 is not "about": 节约 11000 is exact (review of #300)', () => {
    const saved = [{ gold_saved: 10500 }];
    expect(verifyText('节约 11000 金币。', saved).ok).toBe(false);
    expect(verifyText('预约 11000。', saved).ok).toBe(false);
    expect(verifyText('节约 10500 金币。', saved).ok).toBe(true);
    // A bare 约 after any other word is still "about".
    expect(verifyText('省下约 11000 金币。', saved).ok).toBe(true);
    expect(verifyText('离战场约 11000。', [{ distance: 11112 }]).ok).toBe(true);
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
    const src = { tool: 'death_context', ref: 'deaths:beastmaster', ref_scope: 'summary', deaths_total: 11, deaths_where: { outside_fights: ['2:51'], three_or_more_enemy_heroes_dealing_damage: ['8:27', '22:06', '25:30', '30:42', '36:05'] }, deaths: [{ ref: 'death:beastmaster:1', t: 47, clock: '0:47' }] };
    const f = (fact: string) => verifyReview({ verdict: 'v', findings: [{ title: 't', claim: 'c', evidence: [{ refs: ['deaths:beastmaster'], fact }] }] }, [src]).problems;
    expect(f('11 次阵亡里有 5 次是被三个以上敌人打死的：8:27、22:06、25:30、30:42、36:05；2:51 那次在团战之外。')).toEqual([]);
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
    const m = scripted([investigate, { toolCalls: [call('submit_review', fullReview([good]), 's')] }]);
    // Three lookups allowed, three used: the next turn offers only submit_review, and it is accepted.
    const r: any = await runDeepReview({ complete: m.complete, trace, hero: 'beastmaster', lang: 'zh', maxToolCalls: 3 });
    expect(r.status).toBe('ok');
    expect(m.seen[1].tools.map((t: any) => t.name)).toEqual(['submit_review']);
  });
});

describe('runDeepReview', () => {
  it('investigates with the trace tools and returns the verified review', async () => {
    const m = scripted([investigate, { toolCalls: [call('submit_review', fullReview([good]), 's')] }]);
    const r: any = await runDeepReview({ complete: m.complete, trace, hero: 'Beastmaster', lang: 'zh' });
    expect(r.status).toBe('ok');
    expect(r.review).toMatchObject({ schema: DEEP_REVIEW_SCHEMA, match_id: 9100904020, hero: 'beastmaster', lang: 'zh', findings: [goodShown], verdict: '咆哮没有留给幻影刺客的 BKB。' });
    expect(r.verification).toEqual({ repaired: false, first_pass_problems: 0, dropped: 0, problems: [], game_plan_missing: 'not_submitted' });
    expect(r.tool_calls.map((c: any) => c.name)).toEqual(['ability_audit', 'immunity_windows', 'death_context']);
    // The model is told who it reviews and what to call the heroes, in the reader's language.
    expect(m.seen[0].system).toContain('简体中文');
    expect(m.seen[0].messages[0].content).toContain('"player_hero":"beastmaster"');
    expect(m.seen[0].messages[0].content).toContain('"necrolyte":"瘟疫法师"');
    expect(m.seen[0].tools.map((t: any) => t.name)).toEqual(['match_overview', 'death_context', 'ability_audit', 'immunity_windows', 'fight_timeline', 'item_timeline', 'tempo_report', 'hero_abilities', 'skill_build', 'pro_item_choices', 'lane_report', 'draft_report', 'lineup_timing', 'window_report', 'build_for_plan', 'farm_report', 'build_check', 'power_spikes', 'fight_report', 'game_state', 'siege_report', 'roshan_report', 'key_moments', 'ward_report', 'save_report', 'decision_points', 'combat_log', 'hero_track', 'item_info', 'hero_info', 'hero_matchup', 'patch_changes', 'web_search', 'submit_review']);
    // The tool results the model read are the real ones, told from the player's side.
    expect(JSON.parse(m.seen[1].messages.find((x: any) => x.tool_call_id === 'a').content).casts_total).toBe(10);
  });

  it('asks once for a repair, then drops what is still unsupported', async () => {
    const m = scripted([
      investigate,
      { toolCalls: [call('submit_review', fullReview([good, invented]), 's1')] },
      { toolCalls: [call('submit_review', fullReview([good, invented], { verdict: '19:19 崩了', highlights: [{ title: '吼中', detail: '27:27 吼中' }, { title: '假亮点', detail: '19:19 崩' }] }), 's2')] },
    ]);
    const r: any = await runDeepReview({ complete: m.complete, trace, hero: 'beastmaster', lang: 'zh' });
    expect(r.status).toBe('ok');
    expect(r.review.findings).toEqual([goodShown]);
    expect(r.review.highlights).toEqual([{ title: '吼中', detail: '27:27 吼中' }]);
    // An unsupported verdict falls back to the first finding that stands.
    expect(r.review.verdict).toBe(good.title);
    expect(r.verification).toMatchObject({ repaired: true, dropped: 1 });
    const repair = JSON.parse(m.seen[2].messages.at(-1).content);
    expect(repair).toMatchObject({ error: 'unsupported_facts', problems: expect.arrayContaining([{ in: 'finding 2', text: '19:19', why: 'this time is not in any tool result' }, expect.objectContaining({ in: 'finding 2', text: 'fight:99' })]) });
    // 3 investigation/repair turns, and no translation call: a review is written in the one language asked.
    expect(m.seen).toHaveLength(3);
    expect(Object.keys(r.reviews)).toEqual(['zh']);
  });

  it('translates into the other site languages only when asked (translate: true)', async () => {
    const m = scripted([investigate, { toolCalls: [call('submit_review', fullReview([good]), 's1')] }, { text: '{}' }, { text: '{}' }]);
    await runDeepReview({ complete: m.complete, trace, hero: 'beastmaster', lang: 'zh', translate: true });
    expect(m.seen.length).toBeGreaterThan(2);
    expect(m.seen[2].tools).toEqual([]);
  });

  it('one evidence item the cited record does not hold is left out; the finding stays on the rest', async () => {
    // Seen in production: a finding about the ultimate lost whole because one of six items cited the summary for a stun length.
    const stray = { refs: ['audit:beastmaster:primal_roar'], fact: '咆哮定住了 98.7 秒。' };
    const mixed = { ...good, evidence: [...good.evidence, stray] };
    const m = scripted([investigate, { toolCalls: [call('submit_review', fullReview([mixed]), 's1')] }, { toolCalls: [call('submit_review', fullReview([mixed]), 's2')] }]);
    const r: any = await runDeepReview({ complete: m.complete, trace, hero: 'beastmaster', lang: 'zh' });
    expect(r.status).toBe('ok');
    expect(r.review.findings).toEqual([goodShown]);
    expect(r.verification).toMatchObject({ repaired: true, dropped: 0, problems: [{ where: 'finding', index: 0, kind: 'moment', text: '98.7 (not in audit:beastmaster:primal_roar)' }] });
    // Nothing left to stand on: the finding goes, as before.
    const hollow = { ...good, evidence: [stray] };
    const m2 = scripted([investigate, { toolCalls: [call('submit_review', fullReview([good, hollow]), 's1')] }, { toolCalls: [call('submit_review', fullReview([good, hollow]), 's2')] }]);
    const r2: any = await runDeepReview({ complete: m2.complete, trace, hero: 'beastmaster', lang: 'zh' });
    expect(r2.review.findings).toEqual([goodShown]);
    expect(r2.verification).toMatchObject({ dropped: 1 });
    // A finding that is no finding (null, or evidence that is no list) is dropped like any other; the job does not fail.
    const broken = [good, null, { ...good, evidence: { refs: ['death:beastmaster:9'], fact: '36:05' } }];
    const m4 = scripted([investigate, { toolCalls: [call('submit_review', fullReview(broken), 's1')] }, { toolCalls: [call('submit_review', fullReview(broken), 's2')] }]);
    const r4: any = await runDeepReview({ complete: m4.complete, trace, hero: 'beastmaster', lang: 'zh' });
    expect(r4.status).toBe('ok');
    expect(r4.review.findings).toEqual([goodShown]);
    expect(r4.verification).toMatchObject({ dropped: 2 });
    // Its own claim unsupported: good evidence does not save it.
    const wrong = { ...good, claim: '你 19:19 的经济只有 9,876。' };
    const m3 = scripted([investigate, { toolCalls: [call('submit_review', fullReview([good, wrong]), 's1')] }, { toolCalls: [call('submit_review', fullReview([good, wrong]), 's2')] }]);
    const r3: any = await runDeepReview({ complete: m3.complete, trace, hero: 'beastmaster', lang: 'zh' });
    expect(r3.review.findings).toEqual([goodShown]);
    expect(r3.verification).toMatchObject({ dropped: 1 });
  });

  it('a line in English inside a Chinese review is sent back, and dropped if it stays', async () => {
    const submitted = fullReview([good], {
      highlights: [
        { title: 'Good farm', detail: 'Good farm overall' },
        { title: '关键大招', detail: '27:27 吼中' },
      ],
    });
    const m = scripted([investigate, { toolCalls: [call('submit_review', submitted, 's1')] }, { toolCalls: [call('submit_review', submitted, 's2')] }]);
    const r: any = await runDeepReview({ complete: m.complete, trace, hero: 'beastmaster', lang: 'zh' });
    expect(JSON.parse(m.seen[2].messages.at(-1).content).problems).toEqual(expect.arrayContaining([
      { in: 'highlight 1', text: 'Good farm', why: 'write this in the language of the rest of the review' },
      { in: 'highlight 1', text: 'Good farm overall', why: 'write this in the language of the rest of the review' },
    ]));
    expect(r.review.highlights).toEqual([{ title: '关键大招', detail: '27:27 吼中' }]);
    // An English review is not held to this, and names in Latin letters inside a Chinese line are fine.
    expect(verifyReview({ verdict: 'Roar was not saved.', highlights: [{ title: 'Farm', detail: 'Good farm overall' }], findings: [] }, []).problems).toEqual([]);
    expect(verifyReview({ verdict: '咆哮没有留住。', highlights: [{ title: 'BKB 及时', detail: 'Eul 的神圣法杖没出' }], findings: [] }, []).problems).toEqual([]);
  });

  it('record handles written into a sentence in brackets are taken out; refs stay', () => {
    const out: any = nameHeroes({
      verdict: '对线没崩（lane:beastmaster）。',
      highlights: [
        { title: 't1', detail: '两次都定住了（audit:beastmaster:primal_roar、cast:beastmaster:primal_roar:6/9）。' },
        { title: 't2', detail: '8 次死于熊战士 (deaths:tidehunter)，4:21（第一次）最早 (见 12:30)' },
      ],
      findings: [{ title: 't', claim: '12 次里 8 次（deaths:sven）', fix: 'f', evidence: [{ refs: ['death:sven:1'], fact: 'sven 阵亡 (death:sven:1)' }] }],
    }, { sven: '斯温' });
    expect(out.verdict).toBe('对线没崩。');
    expect(out.highlights.map((h: any) => h.detail)).toEqual(['两次都定住了。', '8 次死于熊战士，4:21（第一次）最早 (见 12:30)']);
    expect(out.findings[0].claim).toBe('12 次里 8 次');
    // A handle whose first part is a range or carries a dash (seen in production: timeline:480-550).
    expect(nameHeroes({ verdict: '整段 8:00–9:10 我方 6 死（timeline:480-550）。她开了黑皇杖（immune:phantom_assassin:7:beastmaster-primal_roar），比分 3:1（上半场）' }, { sven: '斯温' }).verdict).toBe('整段 8:00–9:10 我方 6 死。她开了黑皇杖，比分 3:1（上半场）');
    expect(out.findings[0].evidence).toEqual([{ refs: ['death:sven:1'], fact: '斯温 阵亡' }]);
  });

  it('handles listed in a bracket beside other words, and tool names, are taken out too', () => {
    // Seen in production (p15): the sources of a line listed after it, bare or after other words.
    const out: any = nameHeroes({
      verdict: '团队经济从 -4972 掉到 -7895（overview、fight:3、fight:4）。',
      chapters: [
        { topic: 'midgame', title: 'c1', analysis: '一起倒下（4 换 3，timeline:2194-2233），但兵营已破', evidence: [] },
        { topic: 'midgame', title: 'c2', analysis: 'between 28:28 and 28:30 (fight:5, three heroes to none) while', evidence: [] },
        { topic: 'midgame', title: 'c3', analysis: 'in this game (immunity:dire, zero windows), so', evidence: [] },
        { topic: 'midgame', title: 'c4', analysis: 'two fights ended even (fight:3 at 20:20–20:39, fight:4 at 24:10)', evidence: [] },
      ],
    }, { sven: '斯温' });
    expect(out.verdict).toBe('团队经济从 -4972 掉到 -7895。');
    // The last one cannot be cut without breaking the sentence: it is left for the repair round (below).
    expect(out.chapters.map((c: any) => c.analysis)).toEqual(['一起倒下（4 换 3），但兵营已破', 'between 28:28 and 28:30 (three heroes to none) while', 'in this game (zero windows), so', 'two fights ended even (fight:3 at 20:20–20:39, fight:4 at 24:10)']);
  });

  it('wording: a tool key in a sentence, a hero name one character off, a time picked out of a list it is not in', () => {
    const names = { hero_names: { skywrath_mage: '天怒法师', storm_spirit: '风暴之灵', sven: '斯温' }, place_names: { dire_top_lane: '夜魇上路' } };
    expect(wordingProblems('天赋法师在 dire_top_lane 靠 no_ally_within_1200 抓你，skywrath_mage 配合风暴之拳，见 audit:sven:storm_hammer（lane:sven）', names)).toEqual([
      { kind: 'key', text: 'audit:sven:storm_hammer' },
      { kind: 'key', text: 'no_ally_within_1200' },
      { kind: 'name', text: '天赋法师 (天怒法师?)' },
    ]);
    // Not named: keys that are replaced afterwards, a real ability one character from a hero (风暴之拳 / 风暴之灵),
    // a web address, a score, a hyphenated word, handles that are stripped.
    expect(wordingProblems('风暴之拳砸中天怒法师，比分 3:1，mid-game 见 https://dota2.ai/r/1_2（overview、fight:3）', names)).toEqual([]);
    // The sentence production shipped (tidehunter p15), and its English form.
    expect(wordingProblems('6 次死亡是三个以上敌人同时在打你，4 次死时身边没有队友（18:31、19:29、25:33、32:34），其中 37:14 那次身边一个队友都没有。')).toEqual([{ kind: 'list', text: '37:14 (not among 18:31、19:29、25:33、32:34)' }]);
    expect(wordingProblems('Four deaths had no ally near (18:31, 19:29 and 25:33), of which the 37:14 one was at full health.')).toEqual([{ kind: 'list', text: '37:14 (not among 18:31, 19:29 and 25:33)' }]);
    // Sentences production shipped that are fine: the time is in the list; the bracket is not a list of times; "其中" is about something else.
    expect(wordingProblems('4 次身边没有队友（18:31、19:29、25:33、32:34），其中 25:33 那次满血。')).toEqual([]);
    expect(wordingProblems('三次妖术（11:28 帕吉 988/1644、13:38 力丸 912/912、16:42 露娜 1210/1264）的目标在之后全都还活着，其中 13:41 和 16:49 是你交出整套之后阵亡。')).toEqual([]);
    expect(wordingProblems('两次黑皇杖（34:44 那次 9 秒、38:26 那次 3.2 秒），唯一死在其中的就是 34:53 这一次')).toEqual([]);
  });

  it('wording is sent back once and never costs a finding, a chapter or an evidence item', async () => {
    const worded = {
      ...good,
      claim: '幻影剌客开了 7 次 BKB，只有 27:27 那次你的咆哮吼中了她（killed_by 里她最多）；吼中的两次（27:27、30:25），其中 36:05 那次没放。',
    };
    const sent = fullReview([worded], {
      chapters: [
        { topic: 'midgame', title: '中期团战', analysis: '30:25 的咆哮给了瘟疫法师，见 cast:beastmaster:primal_roar:6 那次。', evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 吼住她' }] },
        defaultChapters[1],
      ],
    });
    const m = scripted([investigate, { toolCalls: [call('submit_review', sent, 's1')] }, { toolCalls: [call('submit_review', sent, 's2')] }]);
    const r: any = await runDeepReview({ complete: m.complete, trace, hero: 'beastmaster', lang: 'zh' });
    expect(JSON.parse(m.seen[2].messages.at(-1).content).problems).toEqual(expect.arrayContaining([
      { in: 'finding 1', text: '幻影剌客 (幻影刺客?)', why: expect.stringContaining('hero_names') },
      { in: 'finding 1', text: 'killed_by', why: expect.stringContaining('key or field name') },
      { in: 'finding 1', text: '36:05 (not among 27:27、30:25)', why: expect.stringContaining('agree with itself') },
      { in: 'chapter 1', text: 'cast:beastmaster:primal_roar:6', why: expect.stringContaining('key or field name') },
    ]));
    // Still there after the repair round: it ships as written, and what was wrong with it is on record.
    expect(r.status).toBe('ok');
    expect(r.verification).toMatchObject({ repaired: true, dropped: 0 });
    expect(r.verification.problems.every((p: any) => p.soft)).toBe(true);
    expect(r.review.chapters).toHaveLength(2);
    expect(r.review.findings[0].claim).toBe(worded.claim);
    expect(r.review.findings[0].evidence).toHaveLength(3);
    // A repair that words it properly comes back clean.
    const m2 = scripted([investigate, { toolCalls: [call('submit_review', sent, 's1')] }, { toolCalls: [call('submit_review', fullReview([good]), 's2')] }]);
    const r2: any = await runDeepReview({ complete: m2.complete, trace, hero: 'beastmaster', lang: 'zh' });
    expect(r2.verification).toMatchObject({ repaired: true, dropped: 0, problems: [] });
    // A chat answer is not held to wording.
    expect(verifyText('killed_by 里她最多', [])).toEqual({ ok: true, problems: [] });
  });

  it('a repair that looks the fact up is accepted', async () => {
    const lane = { title: '一血', claim: '0:47 被击杀时身边没有队友。', evidence: [{ refs: ['death:beastmaster:1'], fact: '0:47 一血' }], fix: '等兵线。' };
    const m = scripted([investigate, { toolCalls: [call('submit_review', fullReview([good, lane]), 's1')] }, { toolCalls: [call('death_context', { hero: 'beastmaster', index: 1 }, 'd')] }, { toolCalls: [call('submit_review', fullReview([good, lane]), 's2')] }]);
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
    const out: any = nameHeroes({
      verdict: 'sven 先死，然后 skywrath_mage；svens 不变',
      highlights: [{ title: 'dark_willow 收掉 axe', detail: 'sven 配合击杀', evidence: [{ refs: ['death:sven:1'], fact: 'sven 助攻' }] }],
      chapters: [{ topic: 'midgame', title: 'sven 节奏', analysis: 'skywrath_mage 支援', evidence: [{ refs: ['death:sven:1'], fact: 'sven 阵亡' }] }],
      findings: [{ title: 'undying', claim: 'c', fix: 'sven', evidence: [{ refs: ['death:sven:1'], fact: 'sven 阵亡' }] }],
    }, { sven: '斯温', skywrath_mage: '天怒法师', dark_willow: '邪影芳灵', undying: '不朽尸王', axe: 'axe' });
    expect(out.verdict).toBe('斯温 先死，然后 天怒法师；svens 不变');
    expect(out.highlights[0]).toMatchObject({ title: '邪影芳灵 收掉 axe', detail: '斯温 配合击杀', evidence: [{ refs: ['death:sven:1'], fact: '斯温 助攻' }] });
    expect(out.chapters[0]).toMatchObject({ title: '斯温 节奏', analysis: '天怒法师 支援', evidence: [{ refs: ['death:sven:1'], fact: '斯温 阵亡' }] });
    expect(out.findings[0]).toMatchObject({ title: '不朽尸王', fix: '斯温', evidence: [{ refs: ['death:sven:1'], fact: '斯温 阵亡' }] });
    expect(out).not.toHaveProperty('mainline');
    expect(out).not.toHaveProperty('did_well');
    expect(out).not.toHaveProperty('next_game');
  });

  it('dropped findings are kept in dropped_findings for diagnostics, and schema strips dogmatic rule/template boxes', async () => {
    const props = SUBMIT_REVIEW.input_schema.properties as Record<string, any>;
    for (const removed of ['opening_note', 'encouragement', 'story', 'mainline', 'did_well', 'next_game', 'goal']) {
      expect(props).not.toHaveProperty(removed);
    }
    expect(Object.keys(props.findings.items.properties).sort()).toEqual(['claim', 'evidence', 'fix', 'title']);
    expect(Object.keys(props.chapters.items.properties).sort()).toEqual(['analysis', 'evidence', 'title', 'topic']);
    // A finding that is dropped is kept as it was written, for whoever has to find out why.
    const m3 = scripted([investigate, { toolCalls: [call('submit_review', fullReview([good, invented]), 's')] }, { toolCalls: [call('submit_review', fullReview([good, invented]), 's2')] }]);
    const r3: any = await runDeepReview({ complete: m3.complete, trace, hero: 'beastmaster', lang: 'zh' });
    expect(r3.verification.dropped).toBe(1);
    expect(r3.dropped_findings).toEqual([invented]);
    expect(r3.review.findings[0]).not.toHaveProperty('rule');
    expect(r3.review).not.toHaveProperty('next_game');
    expect(r3.review).not.toHaveProperty('goal');
  });

  it('how many heroes each side lost in a fight is backed by the timeline that is cited for it', async () => {
    const { runTraceTool } = await import('../../packages/review-engine/src/trace/index.js');
    const fight = runTraceTool(trace, 'fight_timeline', { from: 1805, to: 1860 }, { perspective: 'beastmaster' });
    const f = (fact: string) => review([{ title: '中路团', claim: '这波团打输了。', fix: '等队友。', evidence: [{ refs: ['timeline:1805-1860'], fact }] }]);
    const problems = (fact: string) => verifyReview(f(fact), [fight]).problems.filter((p: any) => p.where === 'finding');
    expect(problems('30:26 开始的这波团，你们死 5 人、对面死 3 人。')).toEqual([]);
    // A count the timeline does not give is still refused.
    expect(problems('30:26 开始的这波团，你们死 7 人。')).not.toEqual([]);
  });

  it('a finding sent without its heading is asked for one, and otherwise opens with its own claim', async () => {
    const { title, ...untitled } = good as any;
    expect(verifyReview(review([untitled]), []).problems).toContainEqual({ where: 'title', index: 0, kind: 'missing', text: 'title' });
    // Asked once; the repair supplies it.
    const m = scripted([investigate, { toolCalls: [call('submit_review', fullReview([untitled]), 's1')] }, { toolCalls: [call('submit_review', fullReview([good]), 's2')] }]);
    const r: any = await runDeepReview({ complete: m.complete, trace, hero: 'beastmaster' });
    expect(JSON.parse(m.seen[2].messages.at(-1).content).problems).toEqual([{ in: 'finding 1, title', text: 'title', why: 'this finding has no title: give it a heading of a few words' }]);
    expect(r.review.findings[0].title).toBe(title);
    expect(r.verification).toMatchObject({ repaired: true, dropped: 0, problems: [] });
    // Still none after the repair: the finding stays, headed by the opening sentence of its own claim.
    const m2 = scripted([investigate, { toolCalls: [call('submit_review', fullReview([untitled]), 's1')] }, { toolCalls: [call('submit_review', fullReview([{ ...untitled, title: '  ' }]), 's2')] }]);
    const r2: any = await runDeepReview({ complete: m2.complete, trace, hero: 'beastmaster' });
    expect(r2.status).toBe('ok');
    expect(r2.verification.dropped).toBe(0);
    expect(r2.review.findings[0].title).toBe(headingOf({ claim: good.claim }));
    expect(good.claim.startsWith(r2.review.findings[0].title.replace(/…$/, ''))).toBe(true);
    expect(headingOf({ title: 'Kept', claim: 'x' })).toBe('Kept');
    expect(headingOf({ claim: '12 次死亡里有 4 次身边没有队友；其中 19:29 最亏。后面还有。' })).toBe('12 次死亡里有 4 次身边没有队友');
    expect(headingOf({ claim: 'Four of twelve deaths had no ally near. The 19:29 one cost most.' })).toBe('Four of twelve deaths had no ally near');
    // A time such as 4:21 or a number such as 1.7 is not the end of a sentence.
    expect(headingOf({ claim: 'At 4:21 you had 1.7 deaths per ten minutes. More.' })).toBe('At 4:21 you had 1.7 deaths per ten minutes');
  });

  it('verifies highlights and chapters strictly and ships spotless 0-finding wins without template fields', async () => {
    const cleanReview = {
      verdict: '这局 27:27 隔着黑皇杖的咆哮打出了关键价值。',
      highlights: [
        {
          title: '27:27 果断隔着黑皇杖控住幻影刺客',
          detail: '27:27 吼进她的黑皇杖，定住 3.4 秒并帮队伍在 27:38 击杀她。',
          evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 咆哮吼中开着 BKB 的幻影刺客，她 11 秒后（27:38）阵亡。' }],
        },
      ],
      findings: [],
      chapters: [
        {
          topic: 'midgame',
          title: '关键大招果断',
          analysis: '27:27 你在幻影刺客开启黑皇杖时直接交出咆哮，成功将其定住 3.4 秒并在 27:38 击杀。',
          evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 咆哮定住 3.4 秒，27:38 阵亡。' }],
        },
        {
          topic: 'other',
          title: '36:05 阵亡前的连控',
          analysis: '36:05 你在 2915 血时遭到连控阵亡，咆哮就绪但没能按出。',
          evidence: [{ refs: ['death:beastmaster:9'], fact: '36:05 满血 2915 阵亡，咆哮就绪没放。' }],
        },
      ],
      blind_spots: ['录像里没有视野数据。'],
    };
    const m = scripted([investigate, { toolCalls: [call('submit_review', cleanReview, 's')] }]);
    const r: any = await runDeepReview({ complete: m.complete, trace, hero: 'beastmaster', lang: 'zh' });
    expect(r.status).toBe('ok');
    expect(r.verification).toMatchObject({ repaired: false, first_pass_problems: 0, dropped: 0 });
    expect(r.review.highlights).toHaveLength(1);
    expect(r.review.highlights[0].evidence[0].clock).toBe('27:27');
    expect(r.review.chapters).toHaveLength(2);
    expect(r.review.chapters[0].evidence[0].clock).toBe('27:27');
    expect(r.review).not.toHaveProperty('opening_note');
    expect(r.review).not.toHaveProperty('encouragement');
    expect(r.review).not.toHaveProperty('did_well');

    // Unsupported facts, vision claims, and missing refs in highlights & chapters are caught strictly and dropped if unrepaired.
    const badCoach = {
      ...cleanReview,
      highlights: [
        { ...cleanReview.highlights[0], evidence: [...cleanReview.highlights[0].evidence, { refs: ['fight:99'], fact: '假证据' }] },
        { title: '假亮点', detail: '你在 19:19 打了 9,876 伤害，对面看到了你。', evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27' }] },
      ],
      chapters: [
        { ...cleanReview.chapters[0], analysis: '记得 19:19 买 9,876 金币的装备。' },
        { ...cleanReview.chapters[1], evidence: [{ refs: ['fight:99'], fact: '无依据' }] },
        { topic: 'unknown_dim', title: '有效章节', analysis: '36:05 满血 2915 阵亡。', evidence: [{ refs: ['death:beastmaster:9'], fact: '36:05 满血 2915。' }, { refs: ['fight:99'], fact: '假证据' }] },
      ],
      findings: [good],
    };
    const m2 = scripted([investigate, { toolCalls: [call('submit_review', badCoach, 's1')] }, { toolCalls: [call('submit_review', badCoach, 's2')] }]);
    const r2: any = await runDeepReview({ complete: m2.complete, trace, hero: 'beastmaster', lang: 'zh' });
    const repairProblems = JSON.parse(m2.seen[2].messages.at(-1).content).problems;
    expect(repairProblems).toEqual(expect.arrayContaining([
      expect.objectContaining({ in: 'highlight 1, evidence 2', text: 'fight:99' }),
      expect.objectContaining({ in: 'highlight 2', text: '19:19' }),
      expect.objectContaining({ in: 'highlight 2', text: '看到了你' }),
      expect.objectContaining({ in: 'chapter 1', text: '19:19' }),
      expect.objectContaining({ in: 'chapter 2, evidence 1', text: 'fight:99' }),
    ]));
    expect(r2.review.highlights).toHaveLength(1);
    expect(r2.review.highlights[0].evidence).toHaveLength(1);
    expect(r2.review.chapters).toEqual([{ topic: 'other', title: '有效章节', analysis: '36:05 满血 2915 阵亡。', evidence: [{ refs: ['death:beastmaster:9'], clock: '36:05', fact: '36:05 满血 2915。' }] }]);

    // nameHeroes cleans hero/place keys and inline handles inside highlights & chapters without touching refs.
    const named: any = nameHeroes({
      verdict: 'v',
      highlights: [{ title: 'sven 配合', detail: 'phantom_assassin 阵亡 (cast:beastmaster:primal_roar:6)', evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: 'phantom_assassin 被控' }] }],
      chapters: [{ topic: 'skills_and_items', title: '针对 phantom_assassin', analysis: 'sven 在 dire_top_lane', evidence: [{ refs: ['death:beastmaster:9'], fact: 'sven 旁' }] }],
    }, { phantom_assassin: '幻影刺客', sven: '斯温' }, placeNames('zh'));
    expect(named.highlights[0]).toEqual({ title: '斯温 配合', detail: '幻影刺客 阵亡', evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '幻影刺客 被控' }] });
    expect(named.chapters[0]).toEqual({ topic: 'skills_and_items', title: '针对 幻影刺客', analysis: '斯温 在夜魇上路', evidence: [{ refs: ['death:beastmaster:9'], fact: '斯温 旁' }] });
  });

  it('guards malformed non-array / non-object / non-string review fields without throwing across verify, run, translate, eval, chat and MCP', async () => {
    const malformedEn: any = {
      verdict: 'A close game.',
      findings: [],
      highlights: {},
      chapters: 'bad',
      blind_spots: 42,
      game_plan: 'invalid',
    };
    const resEn = verifyReview(malformedEn, []);
    expect(resEn.ok).toBe(true);
    expect(resEn.problems).toEqual([]);

    const malformedZh: any = {
      ...malformedEn,
      verdict: '这是一局焦灼的对局。',
      findings: 'not-an-array',
    };
    const resZh = verifyReview(malformedZh, []);
    expect(resZh.ok).toBe(true);
    expect(resZh.problems).toEqual([]);

    const badItemsReview: any = {
      verdict: 'A close game.',
      findings: [],
      highlights: [null, 42, { text: 123, title: 123, detail: null, evidence: 'bad' }, { title: 'Clean start', detail: 'Held lane well.', evidence: [null, 99, { refs: 'bad', fact: 123 }] }],
      chapters: [null, 'x', { topic: 'laning', title: 123, analysis: {}, evidence: null }, { topic: 'vision_and_macro', title: 'Map play', analysis: 'Good rotation.', evidence: [null] }],
    };
    const resItems = verifyReview(badItemsReview, []);
    expect(resItems.ok).toBe(false);
    expect(highlightsOf(badItemsReview.highlights, resItems.problems, resItems.refs)).toEqual([{ title: 'Clean start', detail: 'Held lane well.' }]);
    expect(chaptersOf(badItemsReview.chapters, resItems.problems, resItems.refs)).toEqual([]);

    expect(() => nameHeroes(malformedEn, { phantom_assassin: '幻影刺客' })).not.toThrow();
    expect(() => nameHeroes(badItemsReview, { phantom_assassin: '幻影刺客' })).not.toThrow();
    expect(() => extractTranslatable(malformedEn)).not.toThrow();
    expect(() => extractTranslatable(badItemsReview)).not.toThrow();
    expect(applyTranslation(malformedEn, { verdict: '焦灼对局。', highlights: [], findings: [], chapters: [], blind_spots: [] }, 'zh')).not.toBeNull();
    expect(() => reviewTexts(malformedEn)).not.toThrow();
    expect(() => logicOf(malformedEn)).not.toThrow();
    expect(() => rubricOf(malformedEn, { must_hit: [], must_praise: [] })).not.toThrow();
    expect(() => shapeReview('9100904020', 'beastmaster', 'en', { review: malformedEn })).not.toThrow();
    expect(() => shapeReview('9100904020', 'beastmaster', 'en', { review: badItemsReview })).not.toThrow();
    expect(() => checkedPart(malformedEn)).not.toThrow();
    expect(() => checkedPart(badItemsReview)).not.toThrow();

    const m = scripted([
      investigate,
      {
        toolCalls: [call('submit_review', {
          verdict: '咆哮没有留给幻影刺客的 BKB。',
          highlights: {},
          chapters: 'bad',
          blind_spots: 99,
          findings: [good],
        }, 's1')],
      },
    ]);
    const ran: any = await runDeepReview({ complete: m.complete, trace, hero: 'beastmaster', lang: 'zh' });
    expect(ran.status).toBe('ok');
    expect(ran.review.findings).toHaveLength(1);
    expect(ran.review.highlights).toEqual([]);
    expect(ran.review.chapters).toEqual([]);
    expect(ran.review.blind_spots).toEqual([]);
  });

  it('the prompt clarifies Dota 2 replay data facts, removes template dogma, and stays compact (< 10 KB)', () => {
    const s = deepReviewSystem('en');
    // Core safety & judgment rules
    expect(s).toContain('deaths_where');
    expect(s).toContain('damage_share_in_death_windows');
    expect(s).toContain('an ability under off_cooldown_without_the_mana could not be cast');
    expect(s).toContain("never charge the team's lost fights to a player who was not the cause");
    expect(s).toContain('was not wasted because one was spell immune');
    expect(s).toContain('ordered by what mattered most to this player');
    expect(s).toContain('only high-leverage, player-controlled improvements');
    expect(s).toContain('enemy_context_at_window_start');
    expect(s).toContain('never hand out mechanical next-game numeric quotas');
    // Dota 2 data-fact clarifications
    expect(s).toContain('first_held');
    expect(s).toContain('first_purchased');
    expect(s).toContain('my_team_courier_deaths_during_delivery');
    expect(s).toContain('controls_on_me');
    expect(s).toContain('hero_abilities');
    expect(s).toContain('ward_report');
    expect(s).toContain('show placement, never who saw whom');
    expect(s).toContain('highlights');
    expect(s).toContain('chapters');
    // No template fluff fields left in prompt
    expect(s).not.toContain('opening_note');
    expect(s).not.toContain('encouragement');
    expect(s).not.toContain('the game ended before 25:00');
    expect(s).not.toContain('deaths_before_10 is four or more');
    // Compact (< 10 KB)
    expect(Buffer.byteLength(s, 'utf8')).toBeLessThan(10_000);
    expect(deepReviewSystem('zh')).toContain('ordered by what mattered most to this player');
  });

  it('uses clean submit_review schema (no template boxes, minimal game_plan) and teaches summary vs child refs', () => {
    const props = SUBMIT_REVIEW.input_schema.properties as Record<string, any>;
    expect(Object.keys(props).sort()).toEqual(['blind_spots', 'chapters', 'findings', 'game_plan', 'highlights', 'verdict']);
    expect(Object.keys(props.game_plan.properties).sort()).toEqual(['against_your_plan', 'evidence', 'main_reason', 'why']);
    expect(props.game_plan.required).toEqual(['main_reason', 'why']);
    const s = deepReviewSystem('en');
    expect(s).toContain('cast:<hero>:<ability>:<n>');
    expect(s).toContain('fights:<hero>:<n>');
    expect(s).toContain('phase:<hero>:<n>');
  });

  it('suggests exact child refs for summary-ref moment failures without relaxing verifyReview', async () => {
    const { reviewToolkit } = await import('../../lib/agent/review/toolkit.js');
    const kit: any = reviewToolkit({ trace, hero: 'beastmaster', lang: 'zh' });
    const audit = kit.runTool('ability_audit', { hero: 'beastmaster', ability: 'primal_roar' });
    const fights = kit.runTool('fight_report', { hero: 'beastmaster' });
    const tempo = kit.runTool('tempo_report', { hero: 'beastmaster' });
    const deaths = kit.runTool('death_context', { hero: 'beastmaster', index: 9 });
    const allSources = [kit.context, audit, fights, tempo, deaths];

    // 1. verifyReview stays 100% strict: summary refs STILL reject child-event clocks and numbers.
    const strictCheck = verifyReview({
      verdict: '原始咆哮两次按住法术免疫幻影刺客。',
      highlights: [{
        title: '关键咆哮按住魔免幻影刺客',
        detail: '27:27 吼住开着黑皇杖的幻影刺客 3.4 秒。',
        evidence: [{ refs: ['audit:beastmaster:primal_roar'], fact: '27:27 吼进黑皇杖，定住 3.4 秒。' }],
      }],
      findings: [],
    }, allSources);
    expect(strictCheck.ok).toBe(false);
    expect(strictCheck.problems).toEqual([
      { where: 'highlight_evidence', index: 0, item: 0, kind: 'moment', text: '27:27 (not in audit:beastmaster:primal_roar)' },
      { where: 'highlight_evidence', index: 0, item: 0, kind: 'moment', text: '3.4 (not in audit:beastmaster:primal_roar)' },
    ]);

    // 2. suggestChildRefs points strictly to matching child refs within THAT summary's own tool result.
    expect(suggestChildRefs(strictCheck.problems[0], allSources, strictCheck.refs)).toEqual(['cast:beastmaster:primal_roar:6']);
    expect(suggestChildRefs(strictCheck.problems[1], allSources, strictCheck.refs)).toContain('cast:beastmaster:primal_roar:6');
    // fights:<hero> -> fights:<hero>:6 (12:58, 753 damage)
    expect(suggestChildRefs({ kind: 'moment', text: '12:58 (not in fights:beastmaster)' }, allSources, strictCheck.refs)).toEqual(['fights:beastmaster:6']);
    expect(suggestChildRefs({ kind: 'moment', text: '753 (not in fights:beastmaster)' }, allSources, strictCheck.refs)).toEqual(['fights:beastmaster:6']);
    // tempo:<hero> -> phase:<hero>:5 (40:13, 12 buildings)
    expect(suggestChildRefs({ kind: 'moment', text: '40:13 (not in tempo:beastmaster)' }, allSources, strictCheck.refs)).toEqual(['phase:beastmaster:5']);
    expect(suggestChildRefs({ kind: 'moment', text: '12 (not in tempo:beastmaster)' }, allSources, strictCheck.refs)).toContain('phase:beastmaster:5');
    // deaths:<hero> -> death:<hero>:9 (36:05, 2915 HP); does not leak nested nearby_fight grandchild
    expect(suggestChildRefs({ kind: 'moment', text: '36:05 (not in deaths:beastmaster)' }, allSources, strictCheck.refs)).toEqual(['death:beastmaster:9']);
    expect(suggestChildRefs({ kind: 'moment', text: '2915 (not in deaths:beastmaster)' }, allSources, strictCheck.refs)).toEqual(['death:beastmaster:9']);
    // ability_audit also holds deaths_with_it_ready_and_not_cast (death:beastmaster:9 at 36:05), so it suggests that exact child.
    expect(suggestChildRefs({ kind: 'moment', text: '36:05 (not in audit:beastmaster:primal_roar)' }, allSources, strictCheck.refs)).toEqual(['death:beastmaster:9']);
    // Never leaks an unrelated tool's child ref (12:58 is in fight_report, NOT in ability_audit; 40:13 is in tempo_report, NOT in fights).
    expect(suggestChildRefs({ kind: 'moment', text: '12:58 (not in audit:beastmaster:primal_roar)' }, allSources, strictCheck.refs)).toEqual([]);
    expect(suggestChildRefs({ kind: 'moment', text: '40:13 (not in fights:beastmaster)' }, allSources, strictCheck.refs)).toEqual([]);
    // Non-summary ref or non-matching value returns [].
    expect(suggestChildRefs({ kind: 'moment', text: '27:27 (not in death:beastmaster:9)' }, allSources, strictCheck.refs)).toEqual([]);
    expect(suggestChildRefs({ kind: 'moment', text: '98.7 (not in audit:beastmaster:primal_roar)' }, allSources, strictCheck.refs)).toEqual([]);

    // 3. End-to-end runDeepReview repair payload sends suggested_refs for summary-ref failures and omits it when no child matches.
    const firstSubmit = {
      verdict: '原始咆哮两次按住法术免疫幻影刺客。',
      highlights: [{
        title: '27:27 吼住开着黑皇杖的幻影刺客',
        detail: '27:27 吼住开着黑皇杖的幻影刺客 3.4 秒。',
        evidence: [
          { refs: ['audit:beastmaster:primal_roar'], fact: '27:27 吼进黑皇杖，定住 3.4 秒。' },
          { refs: ['audit:beastmaster:primal_roar'], fact: '假数字 98.7 秒。' },
        ],
      }],
      findings: [],
      chapters: [{
        topic: 'midgame', title: '团战执行',
        analysis: '12:58 这波团你打出 753 点伤害。',
        evidence: [{ refs: ['fights:beastmaster'], fact: '12:58 团战打出 753 点伤害。' }],
      }, {
        topic: 'vision_and_macro', title: '推进与高地',
        analysis: '40:13 高地告破。',
        evidence: [{ refs: ['tempo:beastmaster'], fact: '40:13 丢掉中路高地塔。' }],
      }],
      blind_spots: ['录像里没有视野数据。'],
    };
    const repairedSubmit = {
      ...firstSubmit,
      highlights: [{
        ...firstSubmit.highlights[0],
        evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 吼进黑皇杖，定住 3.4 秒。' }],
      }],
      chapters: [
        { ...firstSubmit.chapters[0], evidence: [{ refs: ['fights:beastmaster:6'], fact: '12:58 团战打出 753 点伤害。' }] },
        { ...firstSubmit.chapters[1], evidence: [{ refs: ['phase:beastmaster:5'], fact: '40:13 丢掉中路高地塔。' }] },
      ],
    };
    const m = scripted([
      { toolCalls: [
        call('ability_audit', { hero: 'beastmaster', ability: 'primal_roar' }, 'a'),
        call('fight_report', { hero: 'beastmaster' }, 'f'),
        call('tempo_report', { hero: 'beastmaster' }, 't'),
      ] },
      { toolCalls: [call('submit_review', firstSubmit, 's1')] },
      { toolCalls: [call('submit_review', repairedSubmit, 's2')] },
    ]);
    const r: any = await runDeepReview({ complete: m.complete, trace, hero: 'beastmaster', lang: 'zh' });
    const repairPayload = JSON.parse(m.seen[2].messages.at(-1).content);
    const byText = (prefix: string) => repairPayload.problems.find((p: any) => p.text.startsWith(prefix));
    expect(byText('27:27 (not in audit:beastmaster:primal_roar)')).toMatchObject({
      in: 'highlight 1, evidence 1',
      why: expect.stringContaining('suggested_refs'),
      suggested_refs: ['cast:beastmaster:primal_roar:6'],
    });
    expect(byText('3.4 (not in audit:beastmaster:primal_roar)').suggested_refs).toContain('cast:beastmaster:primal_roar:6');
    expect(byText('12:58 (not in fights:beastmaster)').suggested_refs).toEqual(['fights:beastmaster:6']);
    expect(byText('753 (not in fights:beastmaster)').suggested_refs).toEqual(['fights:beastmaster:6']);
    expect(byText('40:13 (not in tempo:beastmaster)').suggested_refs).toEqual(['phase:beastmaster:5']);
    // No child holds 98.7 -> suggested_refs is omitted completely.
    expect(byText('98.7 (not in audit:beastmaster:primal_roar)')).not.toHaveProperty('suggested_refs');
    // After repair using suggested_refs, the highlight keeps its clickable evidence with clock 27:27.
    expect(r.status).toBe('ok');
    expect(r.verification).toMatchObject({ repaired: true, problems: [] });
    expect(r.review.highlights[0].evidence).toEqual([{ refs: ['cast:beastmaster:primal_roar:6'], clock: '27:27', fact: '27:27 吼进黑皇杖，定住 3.4 秒。' }]);
  });

  it('accepts all 7 clean chronological chapter topics while strictly rejecting unbacked numbers and fog-of-war vision claims inside vision_and_macro', async () => {
    const { reviewToolkit } = await import('../../lib/agent/review/toolkit.js');
    const kit: any = reviewToolkit({ trace, hero: 'beastmaster', lang: 'zh' });
    const draft = kit.runTool('draft_report', { hero: 'beastmaster' });
    const lane = kit.runTool('lane_report', { hero: 'beastmaster' });
    const skill = kit.runTool('skill_build', { hero: 'beastmaster' });
    const fights = kit.runTool('fight_report', { hero: 'beastmaster' });
    const tempo = kit.runTool('tempo_report', { hero: 'beastmaster' });
    const audit = kit.runTool('ability_audit', { hero: 'beastmaster', ability: 'primal_roar' });
    const death9 = kit.runTool('death_context', { hero: 'beastmaster', index: 9 });
    const sources = [kit.context, draft, lane, skill, fights, tempo, audit, death9];

    const sevenChapters = [
      { topic: 'draft', title: '阵容选择与克制', analysis: '面对幻影刺客与斧王，原始咆哮是关键点控。', evidence: [{ refs: ['draft:beastmaster'], fact: '十名英雄对阵确定。' }] },
      { topic: 'game_plan', title: '本局推荐运营思路', analysis: '16 波团战中优先围绕团战转化推进并留好大招。', evidence: [{ refs: ['tempo:beastmaster'], fact: '全场 16 波团战里我方少死人 6 波。' }] },
      { topic: 'laning', title: '实际分路与对线', analysis: '前 10 分钟共阵亡 4 次（0:47、2:51、6:13、8:27）。', evidence: [{ refs: ['lane:beastmaster'], fact: '10:00 前共阵亡 4 次。' }] },
      { topic: 'midgame', title: '中期打架与打钱', analysis: '27:27 吼进黑皇杖定住 3.4 秒，36:05 阵亡时满血 2915。', evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 吼进黑皇杖定住 3.4 秒。' }, { refs: ['death:beastmaster:9'], fact: '36:05 满血 2915 阵亡。' }] },
      { topic: 'vision_and_macro', title: '视野布置与运营', analysis: '16 波团战里少死人的 6 波仅 22:57 后拆到建筑，录像不显示战争迷雾。', evidence: [{ refs: ['tempo:beastmaster'], fact: '16 波团战里少死人的 6 波只有 22:57 后拆到建筑。' }] },
      { topic: 'skills_and_items', title: '技能与出装', analysis: '7:28 到 6 级点出原始咆哮，36:05 遭连控阵亡时满血 2915。', evidence: [{ refs: ['skill_build:beastmaster'], fact: '7:28 学习原始咆哮。' }, { refs: ['death:beastmaster:9'], fact: '36:05 满血 2915 阵亡。' }] },
      { topic: 'other', title: '其他关键细节', analysis: '10 次咆哮里只有 4 次给了幻影刺客。', evidence: [{ refs: ['audit:beastmaster:primal_roar'], fact: '10 次咆哮里 4 次给了幻影刺客。' }] },
    ];
    const clean = verifyReview({ verdict: '整体节奏清晰。', chapters: sevenChapters, findings: [] }, sources);
    expect(clean.ok).toBe(true);
    expect(clean.problems).toEqual([]);
    const shipped = chaptersOf(sevenChapters, clean.problems, clean.refs);
    expect(shipped).toHaveLength(7);
    expect(shipped.map((c: any) => c.topic)).toEqual(CHAPTER_TOPICS);

    // Strictly rejects unbacked numbers AND fog-of-war / sight claims inside `vision_and_macro`.
    const badVisionAndNum = verifyReview({
      verdict: '整体节奏清晰。',
      chapters: [
        {
          topic: 'vision_and_macro',
          title: '视野布置与运营',
          analysis: '你在没有视野的地方走位被对面看到了你，导致 19:19 丢了 9876 金币。',
          evidence: [{ refs: ['tempo:beastmaster'], fact: '对方在视野里发现了你并拆了 99 座塔。' }],
        },
      ],
      findings: [],
    }, sources);
    expect(badVisionAndNum.ok).toBe(false);
    expect(badVisionAndNum.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ where: 'chapter', index: 0, kind: 'sight' }),
      expect.objectContaining({ where: 'chapter', index: 0, kind: 'time', text: '19:19' }),
      expect.objectContaining({ where: 'chapter', index: 0, kind: 'number', text: '9876' }),
      expect.objectContaining({ where: 'chapter_evidence', index: 0, item: 0, kind: 'sight' }),
      expect.objectContaining({ where: 'chapter_evidence', index: 0, item: 0, kind: 'moment', text: '99 (not in tempo:beastmaster)' }),
    ]));
    expect(chaptersOf([{ topic: 'vision_and_macro', title: '视野布置与运营', analysis: 'x', evidence: [{ refs: ['tempo:beastmaster'], fact: 'x' }] }], badVisionAndNum.problems, badVisionAndNum.refs)).toEqual([]);

    // English vision claim inside vision_and_macro is also strictly rejected.
    const badEnVision = verifyReview({
      verdict: 'Clear macro review.',
      chapters: [
        {
          topic: 'vision_and_macro',
          title: 'Wards & macro',
          analysis: 'You walked in without vision and they saw you before the push.',
          evidence: [{ refs: ['tempo:beastmaster'], fact: 'Enemy had full vision of you during the 6 won fights.' }],
        },
      ],
      findings: [],
    }, sources);
    expect(badEnVision.ok).toBe(false);
    expect(badEnVision.problems.filter((p: any) => p.kind === 'sight').length).toBeGreaterThanOrEqual(2);
  });

  it('the prompt states the rules the verifier enforces', () => {
    const s = deepReviewSystem('en');
    expect(s).toContain('MUST write ALL analysis and advice in English');
    expect(s).toContain('must come verbatim from a tool result in this conversation');
    expect(s).toContain('my_team_gold_lead is negative when the player\'s team is behind');
    expect(s).toContain('never assume spell immunity stops an ability the tools show pierced it');
    expect(s).toContain('Never join a fact from one record to a different moment');
    expect(SUBMIT_REVIEW.input_schema.properties.findings.items.properties.evidence.items.required).toEqual(['refs', 'fact']);
    expect(s).toContain('submit_review` exactly once');
    expect(SUBMIT_REVIEW.input_schema.properties.findings.maxItems).toBe(3);
  });

  it('enforces structure guard (chapters >= 2, findings <= 3): repairs 7-finding/0-chapter submissions and hard-caps stubborn excess findings', async () => {
    // Reproduces live production P1 (9107883117 Omniknight v84): model dumped 7 findings and 0 chapters.
    const sevenFindings = Array.from({ length: 7 }, (_, i) => ({ ...good, title: `咆哮问题 ${i + 1}` }));
    const brokenFirst = review(sevenFindings, { chapters: [] });
    const repairedSecond = fullReview([good]);
    const m = scripted([
      investigate,
      { toolCalls: [call('submit_review', brokenFirst, 's1')] },
      { toolCalls: [call('submit_review', repairedSecond, 's2')] },
    ]);
    const r: any = await runDeepReview({ complete: m.complete, trace, hero: 'beastmaster', lang: 'zh' });
    expect(r.status).toBe('ok');
    expect(r.verification).toMatchObject({ repaired: true, dropped: 0, problems: [] });
    expect(JSON.parse(m.seen[2].messages.at(-1).content).problems).toEqual(expect.arrayContaining([
      { in: 'findings', text: 'too_many_findings (7 > 3)', why: expect.stringContaining('at most 3') },
      { in: 'chapters', text: 'too_few_chapters (0 < 2)', why: expect.stringContaining('2–7 chronological chapters') },
    ]));
    expect(r.review.findings).toHaveLength(1);
    expect(r.review.chapters).toHaveLength(2);

    // Even if the model stubbornly repeats 7 findings in the repair round, shipped findings are hard-capped to MAX_FINDINGS (3).
    const mStubborn = scripted([
      investigate,
      { toolCalls: [call('submit_review', brokenFirst, 's1')] },
      { toolCalls: [call('submit_review', brokenFirst, 's2')] },
    ]);
    const rStubborn: any = await runDeepReview({ complete: mStubborn.complete, trace, hero: 'beastmaster', lang: 'zh' });
    expect(rStubborn.status).toBe('ok');
    expect(rStubborn.review.findings).toHaveLength(3);
    expect(rStubborn.verification.dropped).toBe(4);

    // Chapters whose evidence fails verification drop surviving count below MIN_CHAPTERS and also trigger structure repair.
    const unbackedChapters = review([good], {
      chapters: [
        defaultChapters[0],
        { topic: 'laning', title: '虚构对线', analysis: '对线期表现稳定。', evidence: [{ refs: ['lane:missing_ref'], fact: '虚构数据' }] },
      ],
    });
    const mBadChap = scripted([
      investigate,
      { toolCalls: [call('submit_review', unbackedChapters, 's1')] },
      { toolCalls: [call('submit_review', repairedSecond, 's2')] },
    ]);
    const rBadChap: any = await runDeepReview({ complete: mBadChap.complete, trace, hero: 'beastmaster', lang: 'zh' });
    expect(rBadChap.verification).toMatchObject({ repaired: true, dropped: 0, problems: [] });
    expect(JSON.parse(mBadChap.seen[2].messages.at(-1).content).problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ in: 'chapters', text: 'chapters_dropped_below_min (1 < 2)' }),
    ]));
  });
});
