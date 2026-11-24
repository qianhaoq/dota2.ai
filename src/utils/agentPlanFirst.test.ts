import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { createAgentRouter } from '../../lib/agent/router.js';
import { createAgentService } from '../../lib/agent/service.js';
import { runDeepReview, planOf } from '../../lib/agent/deepReview.js';
import { parseChatBody, runChat } from '../../lib/agent/chat.js';
import { PLANS, PLAN_KEYS, planByKey, planKey } from '../../lib/agent/plans.js';

const express = createRequire(import.meta.url)('express');
const fixture = gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url)));
const trace = () => JSON.parse(fixture.toString());
const SCOREBOARD = JSON.parse(readFileSync(new URL('../fixtures/agent/match9100904020.scoreboard.json', import.meta.url), 'utf8'));
const ID = 9100904020;
const call = (name: string, args: any, id: string) => ({ id, name, args });
const finding = { title: '咆哮', claim: '幻影刺客开了 7 次黑皇杖。', evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 吼进黑皇杖，定住 3.4 秒' }], fix: '留给她。' };
const against = '你说要线优转推进：19:00 到 29:00 你们领先，25:00 时最多领先 3565，但这段时间你们只拆了 2 座建筑、对面拆了 3 座。';
const gamePlan = { against_your_plan: against, window: '你们在 19:00 到 29:00 领先。', course: 'c', your_part: 'y', main_reason: 'team_play', why: 'w', evidence: [{ refs: ['window:beastmaster:2'], fact: '19:00 到 29:00 你们领先，最多领先 3565（25:00）。' }] };
const submit = { verdict: '咆哮没有留给幻影刺客。', mainline: [], findings: [finding], game_plan: gamePlan, next_game: ['留咆哮'], blind_spots: ['视野'] };
/** A model that looks things up (one turn), then submits a review. It records every opening message it is sent. */
function model() {
  const m = { openings: [] as string[], complete: async (o: any) => {
    if (o.messages.length === 1) m.openings.push(o.messages[0].content);
    return o.messages.at(-1).role === 'user'
      ? { toolCalls: [call('ability_audit', { hero: 'beastmaster', ability: 'primal_roar' }, 'a'), call('immunity_windows', { hero: 'phantom_assassin' }, 'b'), call('window_report', { hero: 'beastmaster' }, 'w')] }
      : { toolCalls: [call('submit_review', submit, 's')] };
  } };
  return m;
}
function world() {
  const blobs = new Map<string, any>();
  const docs = { get: async (k: string) => blobs.get(k) ?? null, put: async (k: string, v: any) => { blobs.set(k, v); } };
  const t = trace();
  return { blobs, docs, traces: { get: async () => t } };
}
const until = async (f: () => Promise<any>, ok: (v: any) => boolean) => { let v: any; for (let i = 0; i < 100; i += 1) { v = await f(); if (ok(v)) return v; await new Promise((r) => setTimeout(r, 15)); } return v; };

describe('the plans', () => {
  it('are four, each with a button, a phrase and what it asks of a game', () => {
    expect(PLAN_KEYS).toEqual(['push', 'gank', 'split', 'late']);
    for (const p of PLANS) expect(p.label.en && p.label.zh && p.said.en && p.said.zh && p.for_the_model).toBeTruthy();
    expect([planKey('push'), planKey('late'), planKey('PUSH'), planKey('rat'), planKey(''), planKey(null), planKey(3)]).toEqual(['push', 'late', null, null, null, null, null]);
    expect(planByKey('gank')!.label.zh).toBe('抓人带节奏');
    expect(planByKey('nope')).toBeNull();
  });
});

describe('a review read against the plan the player named', () => {
  it('tells the model the plan, ships its reading, and records which plan it was made for', async () => {
    const m = model();
    const r: any = await runDeepReview({ complete: m.complete, trace: trace(), hero: 'beastmaster', lang: 'zh', plan: 'push', match: SCOREBOARD });
    expect(r.status).toBe('ok');
    expect(m.openings[0]).toContain('The player says their plan this game was to win the lanes, then turn the lead into towers early');
    expect(m.openings[0]).toContain('(in their words: "win the lanes and take towers early")');
    expect(r.review.plan).toBe('push');
    expect(r.review.game_plan.against_your_plan).toBe(against);
    // Its numbers were checked like every other plan sentence.
    expect(r.verification.problems.filter((p: any) => p.where === 'plan')).toEqual([]);
  });

  it('without a named plan, the model is told none, and a reading of a plan nobody stated is not shown', async () => {
    const m = model();
    const r: any = await runDeepReview({ complete: m.complete, trace: trace(), hero: 'beastmaster', lang: 'zh', match: SCOREBOARD });
    expect(m.openings[0]).not.toContain('their plan');
    expect(r.review).not.toHaveProperty('plan');
    expect(r.review.game_plan).not.toHaveProperty('against_your_plan');
    expect(r.review.game_plan.window).toBe(gamePlan.window);
    // An unknown plan is no plan.
    const odd: any = await runDeepReview({ complete: model().complete, trace: trace(), hero: 'beastmaster', lang: 'zh', plan: 'cheese', match: SCOREBOARD });
    expect(odd.review).not.toHaveProperty('plan');
    expect(odd.review.game_plan).not.toHaveProperty('against_your_plan');
  });

  it('a reading that states something the tools never said is left out by itself', () => {
    const refs = new Map([['window:beastmaster:2', { at: 1140 }]]);
    const plan = { against_your_plan: 'a', course: 'c', evidence: [{ refs: ['window:beastmaster:2'], fact: 'f' }] };
    expect(planOf(plan, [], refs, { stated: true })).toMatchObject({ against_your_plan: 'a', course: 'c' });
    expect(planOf(plan, [{ where: 'plan', index: 6 } as any], refs, { stated: true })).not.toHaveProperty('against_your_plan');
    expect(planOf(plan, [], refs)).not.toHaveProperty('against_your_plan');
    // With only the reading left, the plan still shows — when a plan was named.
    expect(planOf({ against_your_plan: 'a', evidence: plan.evidence }, [], refs, { stated: true })).toMatchObject({ against_your_plan: 'a' });
    expect(planOf({ against_your_plan: 'a', evidence: plan.evidence }, [], refs)).toBeNull();
  });
});

describe('a review for a plan is its own review', () => {
  it('kept apart from the review without one, queued with its plan, and delivered with it', async () => {
    const w = world();
    const queue: any[] = [];
    const front: any = createAgentService({ traces: w.traces, docs: w.docs, complete: model().complete, dispatch: async (task: any) => { queue.push(task); } });
    const back = model();
    const worker: any = createAgentService({ traces: w.traces, docs: w.docs, complete: back.complete, getMatchDetail: async () => SCOREBOARD });
    expect(await front.start(ID, 'beastmaster', 'zh', { plan: 'push' })).toEqual({ status: 'running', steps: [] });
    expect(queue).toEqual([{ kind: 'review', matchId: String(ID), hero: 'beastmaster', lang: 'zh', plan: 'push' }]);
    // The same game without a plan is not that review: nothing is running for it.
    expect(await front.status(ID, 'beastmaster', 'zh')).toEqual({ status: 'none' });
    expect(await front.status(ID, 'beastmaster', 'zh', 'push')).toMatchObject({ status: 'running' });
    expect(await worker.run(queue[0])).toEqual({ status: 'ready' });
    expect(back.openings[0]).toContain('their plan this game was to win the lanes');
    const ready = await front.status(ID, 'beastmaster', 'zh', 'push');
    expect(ready).toMatchObject({ status: 'ready', review: { plan: 'push', game_plan: { against_your_plan: against } } });
    expect([...w.blobs.keys()].filter((k) => k.endsWith('.review.json'))).toEqual([expect.stringMatching(/^9100904020\.beastmaster\.zh\.p\d+\.plan-push\.review\.json$/)]);
    // Another plan, or none, is another review; a task for a plan that is none of the four is refused.
    expect(await front.status(ID, 'beastmaster', 'zh', 'late')).toEqual({ status: 'none' });
    expect(await worker.run({ ...queue[0], plan: 'cheese' })).toEqual({ status: 'invalid' });
    // A plan-free task keeps the old key, so reviews made before plans existed are still found.
    expect(await worker.run({ kind: 'review', matchId: String(ID), hero: 'beastmaster', lang: 'zh' })).toEqual({ status: 'ready' });
    expect([...w.blobs.keys()].filter((k) => k.endsWith('.review.json')).sort()).toEqual([expect.stringMatching(/^9100904020\.beastmaster\.zh\.p\d+\.plan-push\.review\.json$/), expect.stringMatching(/^9100904020\.beastmaster\.zh\.p\d+\.review\.json$/)].sort());
  });

  it('the chat reads the review made for the reader\'s plan, and is told the plan', async () => {
    const w = world();
    const svc: any = createAgentService({ traces: w.traces, docs: w.docs, complete: model().complete, getMatchDetail: async () => SCOREBOARD });
    await svc.start(ID, 'beastmaster', 'zh', { plan: 'push' });
    await until(() => svc.status(ID, 'beastmaster', 'zh', 'push'), (s) => s.status === 'ready');
    const seen: any[] = [];
    const chatModel = async (o: any) => { seen.push(o.messages[0].content); return { text: '答。' }; };
    const asking: any = createAgentService({ traces: w.traces, docs: w.docs, complete: chatModel });
    await asking.chat({ matchId: ID, hero: 'beastmaster', lang: 'zh', plan: 'push', question: 'q', history: [] });
    expect(seen[0]).toContain('their plan this game was to win the lanes');
    expect(seen[0]).toContain(against);
    await asking.chat({ matchId: ID, hero: 'beastmaster', lang: 'zh', question: 'q', history: [] });
    expect(seen[1]).not.toContain('their plan');
    expect(seen[1]).toContain('Review of this game: none yet');
    expect(parseChatBody({ question: 'q', hero: 'axe', plan: 'push' })).toMatchObject({ plan: 'push' });
    expect(parseChatBody({ question: 'q', hero: 'axe', plan: 'cheese' }).plan).toBeUndefined();
    const direct: any[] = [];
    await runChat({ complete: async (o: any) => { direct.push(o.messages[0].content); return { text: 'x' }; }, trace: trace(), hero: 'beastmaster', lang: 'en', plan: 'late', question: 'q' });
    expect(direct[0]).toContain('their plan this game was to avoid losing fights early');
  });
});

describe('the routes take the plan, and refuse one that is none', () => {
  it('GET and POST /review with ?plan / body.plan; an unknown plan is a 400 that spends nothing', async () => {
    const w = world();
    let acquired = 0;
    const service: any = createAgentService({ traces: w.traces, docs: w.docs, complete: model().complete, getMatchDetail: async () => SCOREBOARD });
    const app = express(); app.use(express.json());
    app.use(createAgentRouter({ service, resolveClientIp: () => '10.7.0.1', llm: { acquire: () => { acquired += 1; return { ok: true }; } } }));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const get = async (q: string) => (await fetch(`${base}/api/agent/${ID}/review?hero=beastmaster&lang=zh${q}`)).json();
      const post = (body: any) => fetch(`${base}/api/agent/${ID}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const bad = await post({ hero: 'beastmaster', lang: 'zh', plan: 'cheese' });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ code: 'invalid_plan', error: 'Unknown plan' });
      expect((await fetch(`${base}/api/agent/${ID}/review?hero=beastmaster&plan=cheese`)).status).toBe(400);
      expect(acquired).toBe(0);
      expect((await post({ hero: 'beastmaster', lang: 'zh', plan: 'gank' })).status).toBe(202);
      expect(acquired).toBe(1);
      const ready = await until(() => get('&plan=gank'), (s) => s.status === 'ready');
      expect(ready.review.plan).toBe('gank');
      expect(await get('')).toEqual({ status: 'none' });
      // An empty plan is no plan.
      expect(await get('&plan=')).toEqual({ status: 'none' });
    } finally { server.close(); }
  });
});
