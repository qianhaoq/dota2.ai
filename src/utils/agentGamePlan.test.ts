import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { deepReviewSystem, planOf, planGapOf, runDeepReview, verifyReview, PLAN_REASONS, SUBMIT_REVIEW, DEEP_REVIEW_PROMPT_VERSION } from '../../lib/agent/deepReview.js';
import { chatSystem, checkedPart, runChat, CHAT_MAX_QUESTION } from '../../lib/agent/chat.js';
import { MOCK_PLAN_ANSWER, MOCK_REVIEW } from '../../scripts/mock-agent.mjs';
import { PLAN_INTENTS, planQuestion } from '../agent/ReviewDoc';

const SCOREBOARD = JSON.parse(readFileSync(new URL('../fixtures/agent/match9100904020.scoreboard.json', import.meta.url), 'utf8'));
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
  main_reason: 'team_play',
  why: '你和 sven 几乎每波团都在，6 波少死人的团只换来 1 次建筑：不是你一个人的问题。',
  evidence: [
    { refs: ['tempo:beastmaster'], fact: '16 波团战里你们少死人的 6 波，之后拆到建筑的只有 22:57 这 1 波。' },
    { refs: ['phase:beastmaster:3'], fact: '20:00 到 30:00 对面拆了 3 座塔（20:02、24:28、25:59），你们在 25:05 拆了 1 座。' },
  ],
};
const defaultChapters = [
  { topic: 'midgame', title: '中期团战节奏', analysis: '10 次咆哮里只有 4 次给了幻影刺客。', evidence: [{ refs: ['audit:beastmaster:primal_roar'], fact: '10 次咆哮里 4 次的目标是幻影刺客。' }] },
  { topic: 'vision_and_macro', title: '赢团转推节奏', analysis: '16 波团战里少死人的 6 波只拆到 1 次建筑。', evidence: [{ refs: ['tempo:beastmaster'], fact: '16 波团战里你们少死人的 6 波，之后拆到建筑的只有 22:57 这 1 波。' }] },
];
const review = (game_plan: any, extra: any = {}) => ({ verdict: '咆哮没有留给幻影刺客的 BKB。', highlights: [], findings: [finding], chapters: defaultChapters, blind_spots: ['视野'], ...(game_plan === undefined ? {} : { game_plan }), ...extra });
const run = (replies: any[]) => { const m = scripted([investigate, ...replies]); return runDeepReview({ complete: m.complete, trace, hero: 'beastmaster', lang: 'zh' }).then((r: any) => ({ r, m })); };
const submit = (r: any, id = 's') => ({ toolCalls: [call('submit_review', r, id)] });

describe('the game plan of a review', () => {
  it('ships as written when rationale and optional records hold, with heroes named and a clock per evidence item', async () => {
    const { r } = await run([submit(review(plan))]);
    expect(r.status).toBe('ok');
    expect(r.verification).toMatchObject({ repaired: false, first_pass_problems: 0 });
    expect(r.review.prompt_version).toBe(DEEP_REVIEW_PROMPT_VERSION);
    expect(r.review.game_plan).toEqual({
      main_reason: 'team_play',
      why: '你和 斯温 几乎每波团都在，6 波少死人的团只换来 1 次建筑：不是你一个人的问题。',
      evidence: [{ refs: ['tempo:beastmaster'], fact: plan.evidence[0].fact }, { refs: ['phase:beastmaster:3'], clock: '20:00', fact: plan.evidence[1].fact }],
    });
    expect(r.review.findings).toHaveLength(1);
  });

  it('a review without a game plan records why (#388)', async () => {
    const { r } = await run([submit(review(undefined))]);
    expect(r.status).toBe('ok');
    expect(r.review).not.toHaveProperty('game_plan');
    expect(r.verification.game_plan_missing).toBe('not_submitted');
    // Submitted with evidence, but no evidence item holds: dropped, and said so.
    const noRecord = (await run([submit(review({ ...plan, evidence: [{ refs: ['tempo:nobody'], fact: 'x' }] })), submit(review({ ...plan, evidence: [{ refs: ['tempo:nobody'], fact: 'x' }] }), 's2')])).r;
    expect(noRecord.review).not.toHaveProperty('game_plan');
    expect(noRecord.verification.game_plan_missing).toBe('no_evidence_that_holds');
    // A plan that ships leaves no such field.
    const kept = (await run([submit(review(plan))])).r;
    expect(kept.review.game_plan).toBeTruthy();
    expect(kept.verification).not.toHaveProperty('game_plan_missing');
  });

  it('submit_review requires clean non-templated fields and slim game_plan (main_reason + why)', () => {
    expect(SUBMIT_REVIEW.input_schema.required).toEqual(['verdict', 'highlights', 'findings', 'chapters', 'game_plan', 'blind_spots']);
    expect((SUBMIT_REVIEW.input_schema.properties as any).game_plan.required).toEqual(['main_reason', 'why']);
  });

  it('a slim game_plan (main_reason + why, no duplicate evidence) ships cleanly while invalid evidence or bad why is caught', async () => {
    const slim = { main_reason: 'team_play', why: '你几乎每波团都在，6 波少死人的团只换来 1 次建筑：不是你一个人的问题。' };
    const { r } = await run([submit(review(slim))]);
    expect(r.status).toBe('ok');
    expect(r.verification).toMatchObject({ repaired: false, first_pass_problems: 0 });
    expect(r.review.game_plan).toEqual({ main_reason: 'team_play', why: slim.why, evidence: [] });
    expect(r.verification).not.toHaveProperty('game_plan_missing');

    const refs = new Map([['tempo:beastmaster', { at: null }]]);
    expect(planOf(slim, [], refs)).toEqual({ main_reason: 'team_play', why: slim.why, evidence: [] });
    expect(planGapOf(slim, [], refs)).toBeNull();
    // If evidence IS provided, every submitted item is verified: all-bad or malformed evidence is rejected.
    expect(planOf({ ...slim, evidence: [{ refs: ['tempo:nobody'], fact: 'x' }] }, [{ where: 'plan_evidence', index: 0 }], refs)).toBeNull();
    expect(planGapOf({ ...slim, evidence: [{ refs: ['tempo:nobody'], fact: 'x' }] }, [{ where: 'plan_evidence', index: 0 }], refs)).toBe('no_evidence_that_holds');
    expect(planOf({ ...slim, evidence: 'tempo:beastmaster' }, [], refs)).toBeNull();
    expect(planGapOf({ ...slim, evidence: 'tempo:beastmaster' }, [], refs)).toBe('no_evidence_that_holds');
    // If main_reason + why fail and no stated against_your_plan holds, planGapOf reports no_reason (PLAN_TEXTS index 0 = 'why').
    expect(planGapOf({ main_reason: 'bad_luck', why: 'x' }, [], refs)).toBe('no_reason');
    expect(planGapOf(slim, [{ where: 'plan', index: 0 }], refs)).toBe('no_reason');

    // End-to-end repair round asks about no_reason when game_plan.why fails verification, and ships once repaired.
    const badSlim = { main_reason: 'team_play', why: '你们赢了 99 波团战。' };
    const repaired = await run([submit(review(badSlim), 's1'), submit(review(slim), 's2')]);
    expect(repaired.r.verification).toMatchObject({ repaired: true, problems: [] });
    expect(repaired.r.review.game_plan).toEqual({ main_reason: 'team_play', why: slim.why, evidence: [] });
    const asked = JSON.parse(repaired.m.seen[2].messages.at(-1).content);
    expect(asked.problems).toContainEqual(expect.objectContaining({ in: 'game_plan', text: 'no_reason' }));
  });

  it('a plan handed in that would be dropped is asked about once in the repair round, and ships when repaired (#388)', async () => {
    const bad = { ...plan, evidence: [{ refs: ['tempo:nobody'], fact: '无' }] };
    const { r, m } = await run([submit(review(bad), 's1'), submit(review(plan), 's2')]);
    expect(r.verification.repaired).toBe(true);
    expect(r.verification.first_pass_problems).toBeGreaterThan(0);
    expect(r.review.game_plan).toMatchObject({ main_reason: 'team_play' });
    expect(r.verification).not.toHaveProperty('game_plan_missing');
    const repairMsg = m.seen.flatMap((x: any) => x.messages ?? []).filter((x: any) => x.role === 'tool' && String(x.content).includes('unsupported_facts')).at(-1);
    const asked = JSON.parse(repairMsg.content);
    expect(asked.problems).toContainEqual(expect.objectContaining({ in: 'game_plan', text: 'no_evidence_that_holds', why: expect.stringContaining('would be left out of the review') }));
    // Still not repaired: the review ships without it, and says why.
    const still = (await run([submit(review(bad), 's1'), submit(review(bad), 's2')])).r;
    expect(still.review).not.toHaveProperty('game_plan');
    expect(still.verification.game_plan_missing).toBe('no_evidence_that_holds');
  });

  it('a plan that holds is not asked about; a review without one is not either', async () => {
    const ok = (await run([submit(review(plan))])).r;
    expect(ok.verification.repaired).toBe(false);
    const none = await run([submit(review(undefined))]);
    expect(none.r.verification.repaired).toBe(false);
  });

  it('asks for a repair naming the field, then leaves out only what still fails', async () => {
    const wrong = {
      ...plan,
      evidence: [
        plan.evidence[0],
        { refs: ['phase:beastmaster:3'], fact: '20:00 到 30:00 对面拆了 12 座建筑。' },
        { refs: ['phase:beastmaster:42'], fact: '后期丢了高地。' },
      ],
    };
    const { r, m } = await run([submit(review(wrong), 's1'), submit(review(wrong), 's2')]);
    expect(r.status).toBe('ok');
    expect(r.verification.repaired).toBe(true);
    const asked = JSON.parse(m.seen[2].messages.at(-1).content);
    expect(asked.problems.map((p: any) => [p.in, p.text])).toEqual([
      ['game_plan.evidence 2', '12 (not in phase:beastmaster:3)'],
      ['game_plan.evidence 3', 'phase:beastmaster:42'],
    ]);
    expect(r.review.game_plan).toEqual({
      main_reason: 'team_play',
      why: '你和 斯温 几乎每波团都在，6 波少死人的团只换来 1 次建筑：不是你一个人的问题。',
      evidence: [{ refs: ['tempo:beastmaster'], fact: plan.evidence[0].fact }],
    });
    expect(r.review.findings).toHaveLength(1);
    expect(r.verification.dropped).toBe(0);
  });

  it('the reason is a judgment: it ships only with the sentence that argues it, and only as a known one', async () => {
    const noWhy = (await run([submit(review({ ...plan, why: '你们赢了 8 波团却没推。' }), 's1'), submit(review({ ...plan, why: '你们赢了 8 波团却没推。' }), 's2')])).r;
    expect(noWhy.review).not.toHaveProperty('game_plan');
    const odd = (await run([submit(review({ ...plan, main_reason: 'bad_luck' }), 's1'), submit(review({ ...plan, main_reason: 'bad_luck' }), 's2')])).r;
    expect(odd.review).not.toHaveProperty('game_plan');
    expect(PLAN_REASONS).toEqual(['your_play', 'team_play', 'enemy_play', 'line_ups', 'unclear']);
  });

  it('planOf enforces ref limits, stated against_your_plan, and malformed input guards', () => {
    const refs = new Map([['tempo:beastmaster', { at: null }]]);
    for (const bad of [null, undefined, 'a plan', 7]) expect(planOf(bad, [], new Map())).toBeNull();
    expect(planGapOf(null, [], refs)).toBe('not_submitted');
    expect(planOf({ ...plan, evidence: [{ refs: 'tempo:beastmaster', fact: 'x' }, { refs: ['tempo:beastmaster'] }, null] }, [], refs)).toBeNull();
    // Problems elsewhere in the review do not touch the plan.
    expect(planOf(plan, [{ where: 'finding', index: 1 }], refs)).toMatchObject({ main_reason: 'team_play', why: plan.why });
    // At most four evidence items, each with at most three refs.
    const many = planOf({ ...plan, evidence: Array.from({ length: 6 }, () => ({ refs: ['tempo:beastmaster', 'a:1', 'b:2', 'c:3'], fact: 'x' })) }, [], refs)!;
    expect(many.evidence).toHaveLength(4);
    expect(many.evidence[0].refs).toHaveLength(3);
    // Refs are the strings the check read; an item left with none is dropped.
    const mixed = planOf({ ...plan, evidence: [{ refs: [7, 'tempo:beastmaster', null], fact: 'x' }, { refs: [7, {}], fact: 'y' }] }, [], refs)!;
    expect(mixed.evidence).toEqual([{ refs: ['tempo:beastmaster'], fact: 'x' }]);
    // against_your_plan ships only when stated is true.
    expect(planOf({ ...plan, against_your_plan: 'fit well' }, [], refs, { stated: false })).not.toHaveProperty('against_your_plan');
    expect(planOf({ ...plan, against_your_plan: 'fit well' }, [], refs, { stated: true })).toMatchObject({ against_your_plan: 'fit well' });
  });

  it('is checked like the rest of the review: vision, and English in a Chinese review', () => {
    const kitSources = (r: any) => verifyReview(r, []).problems.filter((p: any) => p.where.startsWith('plan'));
    expect(kitSources(review({ main_reason: 'team_play', why: '你们推塔时对面看不到你。', against_your_plan: 'You were away from the fights.', evidence: [] })).map((p: any) => [p.where, p.index, p.kind])).toEqual([['plan', 0, 'sight'], ['plan', 1, 'language']]);
    expect(kitSources(review('just text'))).toEqual([]);
    expect(kitSources(review({ why: 5, evidence: 'none' }))).toEqual([]);
  });

  it('the scripted review of the fixture server passes the same check, in all three languages', async () => {
    for (const lang of ['zh', 'en', 'ru'] as const) {
      const m = scripted([{ toolCalls: [...investigate.toolCalls, call('window_report', { hero: 'beastmaster' }, 'w')] }, submit((MOCK_REVIEW as any)[lang])]);
      const r: any = await runDeepReview({ complete: m.complete, trace, hero: 'beastmaster', lang, match: SCOREBOARD });
      expect(r.verification.problems.filter((p: any) => p.where.startsWith('plan'))).toEqual([]);
    }
  });
});

describe('the prompts know the game plan', () => {
  it('the review prompt asks for it from the two tools, and says what it must not claim', () => {
    const s = deepReviewSystem('en');
    expect(s).toContain('tempo_report');
    expect(s).toContain('lineup_timing');
    expect(s).toContain('never motives ("intended"');
    expect(s).toContain('Say a hero was "farming" only when a tool reports `doing: "farming"`');
    const p = SUBMIT_REVIEW.input_schema.properties.game_plan;
    expect(p.required).toEqual(['main_reason', 'why']);
    expect(p.properties.main_reason.enum).toEqual(PLAN_REASONS);
    expect(p.properties.evidence.maxItems).toBe(4);
    expect('minItems' in p.properties.evidence).toBe(false);
    expect(SUBMIT_REVIEW.input_schema.required).toContain('game_plan');
  });

  it('the chat is told how to answer a stated plan, and may lean on the checked parts of the review', () => {
    const s = chatSystem('en');
    expect(s).toContain('take that as their plan');
    expect(s).toContain('window_report for the player first');
    expect(s).toContain('then tempo_report');
    expect(s).toContain('not that it closed the window');
    expect(s).toContain('Never tell the player what they "intended"');
    const part: any = checkedPart({
      verdict: 'v',
      highlights: [{ title: 'Roar at 27:27', detail: 'Stunned PA through BKB.', evidence: [{ refs: ['cast:x:1'], clock: '27:27', fact: '3.4 s stun.' }] }],
      chapters: [{ topic: 'midgame', title: 'Fights', analysis: 'High attendance.', evidence: [{ refs: ['fights:x:12'], clock: '33:23', fact: '841 damage.' }] }],
      findings: [],
      game_plan: { main_reason: 'team_play', why: 'w', against_your_plan: 'a', evidence: [{ refs: ['tempo:x'], clock: '20:00', fact: 'f' }] },
    });
    // main_reason is a judgment: not part of what backs a later answer.
    expect(part.game_plan).toEqual({ against_your_plan: 'a', why: 'w', evidence: [{ clock: '20:00', fact: 'f' }] });
    expect(part.highlights).toEqual([{ title: 'Roar at 27:27', detail: 'Stunned PA through BKB.', evidence: [{ clock: '27:27', fact: '3.4 s stun.' }] }]);
    expect(part.chapters).toEqual([{ topic: 'midgame', title: 'Fights', analysis: 'High attendance.', evidence: [{ clock: '33:23', fact: '841 damage.' }] }]);
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
    const bad = scripted([{ toolCalls: [call('tempo_report', { hero: 'beastmaster' }, 'p')] }, { text: '你到场了 14 波团战。' }, { text: '你到场了 14 波团战。' }]);
    const marked: any = await runChat({ complete: bad.complete, trace, hero: 'beastmaster', lang: 'zh', question: planQuestion('push', 'zh')! });
    expect(marked.unverified).toEqual([{ kind: 'count', text: '14' }]);
  });
});
