import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { deepReviewSystem, planOf, runDeepReview, verifyReview, PLAN_REASONS, SUBMIT_REVIEW, DEEP_REVIEW_PROMPT_VERSION } from '../../lib/agent/deepReview.js';
import { chatSystem, checkedPart, runChat, CHAT_MAX_QUESTION } from '../../lib/agent/chat.js';
import { MOCK_PLAN_ANSWER, MOCK_REVIEW } from '../../scripts/mock-agent.mjs';
import { PLAN_INTENTS, planQuestion } from '../agent/ReviewDoc';

const trace = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());
const scripted = (replies: any[]) => { const seen: any[] = []; let i = 0; return { seen, complete: async (o: any) => { seen.push(JSON.parse(JSON.stringify(o))); return replies[Math.min(i++, replies.length - 1)]; } }; };
const call = (name: string, args: any, id: string) => ({ id, name, args });

const investigate = { toolCalls: [
  call('ability_audit', { hero: 'beastmaster', ability: 'primal_roar' }, 'a'),
  call('tempo_report', { hero: 'beastmaster' }, 'b'),
  call('lineup_timing', {}, 'c'),
] };
const finding = { title: '咆哮没有留给幻影刺客的 BKB', claim: '10 次咆哮里只有 4 次给了幻影刺客。', evidence: [{ refs: ['audit:beastmaster:primal_roar'], fact: '10 次咆哮里 4 次的目标是幻影刺客。' }], fix: '咆哮留给她。' };
const plan = {
  line_ups: '路人局里 sven 在短局赢得更多；这局打了 42:31。',
  course: '你们在 18:07 到 19:46 拆了 3 座外塔；16 波团战里你们少死人的有 6 波，只有 22:57 那一波之后拆到了建筑。',
  your_part: '16 波团战你到场 15 波，20:00 到 30:00 你 52% 的存活时间身边有两名以上队友。',
  main_reason: 'team_play',
  why: '你几乎每波团都在，6 波少死人的团只换来 1 次建筑：不是你一个人的问题。',
  evidence: [
    { refs: ['tempo:beastmaster'], fact: '16 波团战里你们少死人的 6 波，之后拆到建筑的只有 22:57 这 1 波。' },
    { refs: ['phase:beastmaster:3'], fact: '20:00 到 30:00 对面拆了 3 座塔（20:02、24:28、25:59），你们在 25:05 拆了 1 座。' },
  ],
};
const review = (game_plan: any, extra: any = {}) => ({ verdict: '咆哮没有留给幻影刺客的 BKB。', mainline: [], findings: [finding], blind_spots: ['视野'], ...(game_plan === undefined ? {} : { game_plan }), ...extra });
const run = (replies: any[]) => { const m = scripted([investigate, ...replies]); return runDeepReview({ complete: m.complete, trace, hero: 'beastmaster', lang: 'zh' }).then((r: any) => ({ r, m })); };
const submit = (r: any, id = 's') => ({ toolCalls: [call('submit_review', r, id)] });

describe('the game plan of a review', () => {
  it('ships as written when every sentence and record holds, with heroes named and a clock per evidence item', async () => {
    const { r } = await run([submit(review(plan))]);
    expect(r.status).toBe('ok');
    expect(r.verification).toMatchObject({ repaired: false, first_pass_problems: 0 });
    expect(r.review.prompt_version).toBe(DEEP_REVIEW_PROMPT_VERSION);
    expect(r.review.game_plan).toEqual({
      line_ups: '路人局里 斯温 在短局赢得更多；这局打了 42:31。', course: plan.course, your_part: plan.your_part, main_reason: 'team_play', why: plan.why,
      // The summary has no moment of its own; a stretch is shown by when it began.
      evidence: [{ refs: ['tempo:beastmaster'], fact: plan.evidence[0].fact }, { refs: ['phase:beastmaster:3'], clock: '20:00', fact: plan.evidence[1].fact }],
    });
    // The findings are untouched by it.
    expect(r.review.findings).toHaveLength(1);
  });

  it('a review without one is a review without one', async () => {
    const { r } = await run([submit(review(undefined))]);
    expect(r.status).toBe('ok');
    expect(r.review).not.toHaveProperty('game_plan');
  });

  it('asks for a repair naming the sentence, then leaves out only what still fails', async () => {
    const wrong = { ...plan, course: '你们在 12:34 拆了 3 座外塔，赢了 8 波团。', evidence: [plan.evidence[0], { refs: ['phase:beastmaster:3'], fact: '20:00 到 30:00 对面拆了 12 座建筑。' }, { refs: ['phase:beastmaster:42'], fact: '后期丢了高地。' }] };
    const { r, m } = await run([submit(review(wrong), 's1'), submit(review(wrong), 's2')]);
    expect(r.status).toBe('ok');
    expect(r.verification.repaired).toBe(true);
    const asked = JSON.parse(m.seen[2].messages.at(-1).content);
    expect(asked.problems.map((p: any) => [p.in, p.text])).toEqual([
      ['game_plan.course', '12:34'], ['game_plan.course', '8'],
      ['game_plan.evidence 2', '12 (not in phase:beastmaster:3)'], ['game_plan.evidence 3', 'phase:beastmaster:42'],
    ]);
    // The sentence that stated them is gone, and the two evidence items; the rest of the plan stands.
    expect(r.review.game_plan).toEqual({ line_ups: '路人局里 斯温 在短局赢得更多；这局打了 42:31。', your_part: plan.your_part, main_reason: 'team_play', why: plan.why, evidence: [{ refs: ['tempo:beastmaster'], fact: plan.evidence[0].fact }] });
    // A finding is never dropped for what the plan got wrong.
    expect(r.review.findings).toHaveLength(1);
    expect(r.verification.dropped).toBe(0);
  });

  it('a repaired plan is accepted', async () => {
    const { r } = await run([submit(review({ ...plan, course: '你们赢了 8 波团。' }), 's1'), submit(review(plan), 's2')]);
    expect(r.verification).toMatchObject({ repaired: true, problems: [] });
    expect(r.review.game_plan.course).toBe(plan.course);
  });

  it('the reason is a judgment: it ships only with the sentence that argues it, and only as a known one', async () => {
    const noWhy = (await run([submit(review({ ...plan, why: '因为你们 9:99 就该推了，赢了 8 波团。' }), 's1'), submit(review({ ...plan, why: '你们赢了 8 波团却没推。' }), 's2')])).r;
    expect(noWhy.review.game_plan).not.toHaveProperty('why');
    expect(noWhy.review.game_plan).not.toHaveProperty('main_reason');
    expect(noWhy.review.game_plan.course).toBe(plan.course);
    const odd = (await run([submit(review({ ...plan, main_reason: 'bad_luck' }))])).r;
    expect(odd.review.game_plan).not.toHaveProperty('main_reason');
    expect(odd.review.game_plan).not.toHaveProperty('why');
    expect(PLAN_REASONS).toEqual(['your_play', 'team_play', 'enemy_play', 'line_ups', 'unclear']);
  });

  it('with nothing left about what happened, or no record that holds, there is no plan', () => {
    const none = { problems: [], refs: new Map([['tempo:beastmaster', { at: null }]]) };
    expect(planOf({ why: 'x', main_reason: 'unclear', evidence: plan.evidence }, none.problems, none.refs)).toBeNull();
    expect(planOf({ ...plan, evidence: [] }, none.problems, none.refs)).toBeNull();
    expect(planOf({ ...plan, evidence: 'tempo:beastmaster' }, none.problems, none.refs)).toBeNull();
    expect(planOf({ ...plan, evidence: [{ refs: 'tempo:beastmaster', fact: 'x' }, { refs: ['tempo:beastmaster'] }, null] }, none.problems, none.refs)).toBeNull();
    for (const bad of [null, undefined, 'a plan', 7]) expect(planOf(bad, [], new Map())).toBeNull();
    // Both sentences about what happened failed the check: nothing to show, whatever else holds.
    expect(planOf(plan, [{ where: 'plan', index: 1 }, { where: 'plan', index: 2 }], none.refs)).toBeNull();
    // Problems elsewhere in the review do not touch the plan.
    expect(planOf(plan, [{ where: 'finding', index: 1 }, { where: 'mainline', index: 2 }], none.refs)).toMatchObject({ course: plan.course, your_part: plan.your_part });
    // At most four evidence items are shown, each with at most three refs.
    const many = planOf({ ...plan, evidence: Array.from({ length: 6 }, () => ({ refs: ['tempo:beastmaster', 'a:1', 'b:2', 'c:3'], fact: 'x' })) }, [], none.refs)!;
    expect(many.evidence).toHaveLength(4);
    expect(many.evidence[0].refs).toHaveLength(3);
    // Refs are the strings the check read: anything else is not passed on, and an item left with none is not shown.
    const mixed = planOf({ ...plan, evidence: [{ refs: [7, 'tempo:beastmaster', null], fact: 'x' }, { refs: [7, {}], fact: 'y' }] }, [], none.refs)!;
    expect(mixed.evidence).toEqual([{ refs: ['tempo:beastmaster'], fact: 'x' }]);
  });

  it('is checked like the rest of the review: vision, and English in a Chinese review', () => {
    const kitSources = (r: any) => verifyReview(r, []).problems.filter((p: any) => p.where.startsWith('plan'));
    expect(kitSources(review({ ...plan, course: '你们推塔时对面看不到你。', your_part: 'You were away from the fights.', why: 'x', line_ups: 'x', evidence: [] })).map((p: any) => [p.where, p.index, p.kind])).toEqual([['plan', 1, 'sight'], ['plan', 2, 'language']]);
    // A plan that is not an object, or sentences that are not strings, are simply not there.
    expect(kitSources(review('just text'))).toEqual([]);
    expect(kitSources(review({ course: 5, your_part: null, evidence: 'none' }))).toEqual([]);
  });

  it('the scripted review of the fixture server passes the same check, in both languages', async () => {
    for (const lang of ['zh', 'en'] as const) {
      const m = scripted([investigate, submit((MOCK_REVIEW as any)[lang])]);
      // The script's findings cite records this short investigation did not fetch; only the plan is under test here.
      const r: any = await runDeepReview({ complete: m.complete, trace, hero: 'beastmaster', lang });
      expect(r.verification.problems.filter((p: any) => p.where.startsWith('plan'))).toEqual([]);
    }
  });
});

describe('the prompts know the game plan', () => {
  it('the review prompt asks for it from the two tools, and says what it must not claim', () => {
    const s = deepReviewSystem('en');
    expect(s).toContain('tempo_report for the player');
    expect(s).toContain('lineup_timing');
    expect(s).toContain('never state what the player or the team "intended"');
    expect(s).toContain('never "farming"');
    expect(s).toContain('is "your_play" only when the player\'s own numbers show it');
    const p = SUBMIT_REVIEW.input_schema.properties.game_plan;
    expect(p.required).toEqual(['course', 'your_part', 'main_reason', 'why', 'evidence']);
    expect(p.properties.main_reason.enum).toEqual(PLAN_REASONS);
    expect(p.properties.evidence.maxItems).toBe(4);
    // Asked for, not demanded: a model that leaves it out still hands in a review.
    expect(SUBMIT_REVIEW.input_schema.required).not.toContain('game_plan');
  });

  it('the chat is told how to answer a stated plan, and may lean on the plan the review checked', () => {
    const s = chatSystem('en');
    expect(s).toContain('take that as their plan');
    expect(s).toContain('tempo_report for the player first');
    expect(s).toContain('Never tell the player what they "intended"');
    const part: any = checkedPart({ verdict: 'v', findings: [], game_plan: { course: 'c', your_part: 'y', line_ups: 'l', main_reason: 'team_play', why: 'w', evidence: [{ refs: ['tempo:x'], clock: '20:00', fact: 'f' }] } });
    // The reason it names is a judgment: not part of what backs a later answer.
    expect(part.game_plan).toEqual({ line_ups: 'l', course: 'c', your_part: 'y', why: 'w', evidence: [{ clock: '20:00', fact: 'f' }] });
    expect(checkedPart({ verdict: 'v', findings: [] })).not.toHaveProperty('game_plan');
  });

  it('a plan the player picks becomes one question the chat accepts, and the answer is checked against the replay', async () => {
    expect(PLAN_INTENTS.map((p) => p.key)).toEqual(['push', 'gank', 'split', 'late']);
    for (const p of PLAN_INTENTS) for (const lang of ['zh', 'en'] as const) {
      const q = planQuestion(p.key, lang)!;
      expect(q.length).toBeLessThanOrEqual(CHAT_MAX_QUESTION);
      expect(q).toContain(p.said[lang]);
    }
    expect(planQuestion('nope', 'zh')).toBeNull();
    const m = scripted([{ toolCalls: [call('tempo_report', { hero: 'beastmaster' }, 'p'), call('lineup_timing', {}, 'r')] }, { text: MOCK_PLAN_ANSWER.zh }]);
    const out: any = await runChat({ complete: m.complete, trace, hero: 'beastmaster', lang: 'zh', question: planQuestion('push', 'zh')! });
    expect(out).toMatchObject({ status: 'ok', unverified: [] });
    expect(out.tool_calls.map((c: any) => c.name)).toEqual(['tempo_report', 'lineup_timing']);
    // The same answer with a count the replay does not hold is returned marked, not hidden.
    const bad = scripted([{ toolCalls: [call('tempo_report', { hero: 'beastmaster' }, 'p')] }, { text: '你到场了 14 波团战。' }, { text: '你到场了 14 波团战。' }]);
    const marked: any = await runChat({ complete: bad.complete, trace, hero: 'beastmaster', lang: 'zh', question: planQuestion('push', 'zh')! });
    expect(marked.unverified).toEqual([{ kind: 'count', text: '14' }]);
  });
});
