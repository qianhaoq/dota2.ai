import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { createAgentRouter } from '../../lib/agent/router.js';
import { createAgentService } from '../../lib/agent/service.js';
import { DEEP_REVIEW_PROMPT_VERSION } from '../../lib/agent/deepReview.js';
import { FEEDBACK_SCHEMA, feedbackKey, feedbackRecord, parseFeedback, summarizeFeedback } from '../../lib/agent/feedback.js';

/** A reader's word on one finding: right, wrong or not useful. What is taken, what is kept, and what is counted. */

const express = createRequire(import.meta.url)('express');
const MATCH = '9100904020';
const P = DEEP_REVIEW_PROMPT_VERSION;
const review = {
  schema: 'dota2.ai/deep-review@1', match_id: Number(MATCH), hero: 'beastmaster', lang: 'zh', verdict: '咆哮没有留给幻影刺客。',
  findings: [
    { title: '咆哮给了瘟疫法师', claim: '30:25 咆哮给了瘟疫法师。', fix: '留给她。', evidence: [{ refs: ['cast:beastmaster:primal_roar:7'], fact: '30:25。' }, { refs: ['immune:phantom_assassin:3:beastmaster-primal_roar', 'cast:beastmaster:primal_roar:7'], fact: '30:34。' }] },
    { title: '没有黑皇杖', claim: '整局没有黑皇杖。', fix: '出。', evidence: [{ refs: ['build:beastmaster'], fact: '没有。' }] },
  ],
};
const ID = 'abcdefghij0123456789';
const word = (over: any = {}) => ({ hero: 'beastmaster', lang: 'zh', finding: 0, title: '咆哮给了瘟疫法师', rating: 'right', id: ID, ...over });

describe('parseFeedback', () => {
  it('takes a finding, its title, a rating, a reason of that rating, and the page\'s id for it', () => {
    expect(parseFeedback(word())).toEqual({ finding: 0, title: '咆哮给了瘟疫法师', rating: 'right', reason: null, id: ID });
    expect(parseFeedback(word({ rating: 'wrong', reason: 'fact' }))).toMatchObject({ rating: 'wrong', reason: 'fact' });
    expect(parseFeedback(word({ rating: 'useless', reason: 'vague', finding: 2 }))).toMatchObject({ rating: 'useless', reason: 'vague', finding: 2 });
    // No reason is a rating on its own.
    expect(parseFeedback(word({ rating: 'wrong', reason: '' }))).toMatchObject({ rating: 'wrong', reason: null });
  });

  it('refuses everything else: nothing is guessed into a rating', () => {
    const bad = [
      { rating: 'good' }, { rating: undefined }, { rating: 'right', reason: 'fact' }, { rating: 'wrong', reason: 'vague' }, { rating: 'useless', reason: 'because I said so' },
      { finding: -1 }, { finding: 3 }, { finding: 1.5 }, { finding: '0' }, { title: '' }, { title: 'x'.repeat(301) }, { title: 7 },
      { id: 'short' }, { id: 'UPPERCASE0123456789' }, { id: '../../etc/passwd0000' }, { id: undefined },
    ];
    for (const over of bad) expect([over, parseFeedback(word(over))]).toEqual([over, null]);
    for (const body of [null, undefined, 'right', []]) expect(parseFeedback(body)).toBeNull();
  });
});

describe('feedbackRecord', () => {
  const value = parseFeedback(word({ rating: 'wrong', reason: 'judgment' }))!;
  const base = { matchId: MATCH, hero: 'beastmaster', lang: 'zh', promptVersion: 37, review, at: Date.UTC(2026, 10, 25, 12, 0, 0) };

  it('copies the finding from the stored review: its place, its title, the records it cites, once each', () => {
    expect(feedbackRecord({ ...base, value })).toEqual({
      schema: FEEDBACK_SCHEMA, at: '2026-11-25T12:00:00.000Z', match_id: 9100904020, hero: 'beastmaster', lang: 'zh', prompt_version: 37, plan: null, model: null,
      finding: { index: 0, of: 2, title: '咆哮给了瘟疫法师', refs: ['cast:beastmaster:primal_roar:7', 'immune:phantom_assassin:3:beastmaster-primal_roar'] },
      rating: 'wrong', reason: 'judgment',
    });
    expect(feedbackRecord({ ...base, value, plan: 'split', model: 'kimi-k3.1-pro' })).toMatchObject({ plan: 'split', model: 'kimi-k3.1-pro' });
  });

  it('is not made for a finding that is not there, nor for another finding standing in its place', () => {
    expect(feedbackRecord({ ...base, value: { ...value, finding: 2 } })).toEqual({ error: 'no_such_finding' });
    expect(feedbackRecord({ ...base, value: { ...value, finding: 1 } })).toEqual({ error: 'stale' });
    expect(feedbackRecord({ ...base, review: { findings: [] }, value })).toEqual({ error: 'no_such_finding' });
    expect(feedbackRecord({ ...base, review: null, value })).toEqual({ error: 'no_such_finding' });
  });
});

describe('summarizeFeedback', () => {
  const rec = (rating: string, over: any = {}) => ({ schema: FEEDBACK_SCHEMA, at: '2026-11-25T12:00:00.000Z', match_id: 1, hero: 'axe', lang: 'zh', prompt_version: 37, model: null, finding: { index: 0, of: 3, title: 'T', refs: [] }, rating, reason: null, ...over });

  it('counts by rating, by prompt version and for the first finding; lists what was not right, newest first', () => {
    const s = summarizeFeedback([
      rec('right'), rec('right', { finding: { index: 1, of: 3, title: 'B', refs: [] } }), rec('wrong', { reason: 'fact', at: '2026-11-25T13:00:00.000Z' }),
      rec('useless', { reason: 'vague', prompt_version: 36, finding: { index: 2, of: 3, title: 'C', refs: [] }, at: '2026-11-24T09:00:00.000Z' }),
    ]);
    expect(s.all).toEqual({ n: 4, right: 2, wrong: 1, useless: 1, right_rate: 0.5, reasons: { fact: 1, vague: 1 } });
    expect(s.first_finding).toEqual({ n: 2, right: 1, wrong: 1, useless: 0, right_rate: 0.5, reasons: { fact: 1 } });
    expect(s.by_prompt_version).toEqual([
      { prompt_version: 37, n: 3, right: 2, wrong: 1, useless: 0, right_rate: 0.67, reasons: { fact: 1 } },
      { prompt_version: 36, n: 1, right: 0, wrong: 0, useless: 1, right_rate: 0, reasons: { vague: 1 } },
    ]);
    expect(s.not_right.map((r: any) => [r.finding, r.title, r.rating, r.reason, r.prompt_version])).toEqual([[1, 'T', 'wrong', 'fact', 37], [3, 'C', 'useless', 'vague', 36]]);
    expect(s.skipped).toBe(0);
  });

  it('nothing said is no rate, not a rate of zero; what it cannot read is skipped, never counted as a rating', () => {
    expect(summarizeFeedback([])).toMatchObject({ all: { n: 0, right_rate: null }, first_finding: { n: 0, right_rate: null }, by_prompt_version: [], not_right: [], skipped: 0 });
    const s = summarizeFeedback([rec('right'), { schema: 'something/else@1', rating: 'wrong' }, rec('excellent'), rec('wrong', { finding: null }), null]);
    expect(s.all).toMatchObject({ n: 1, right: 1, wrong: 0, right_rate: 1 });
    expect(s.skipped).toBe(4);
  });
});

/** A store that is a Map, and counts what was written. */
const memory = () => { const m = new Map<string, any>(); return { m, get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: any) => { m.set(k, JSON.parse(JSON.stringify(v))); } }; };
const reviewKey = `${MATCH}.beastmaster.zh.p${P}`;

describe('service.feedback', () => {
  const make = (over: any = {}) => {
    const docs = memory(); const kept = memory();
    docs.m.set(`${reviewKey}.review.json`, { review, verification: { repaired: false, dropped: 0 }, model: 'mock' });
    const service = createAgentService({ traces: { get: async () => null }, complete: async () => ({}), model: 'mock', docs, feedback: kept, now: () => Date.UTC(2026, 10, 25, 12, 0, 0), ...over });
    return { service, docs, kept };
  };
  const value = (over: any = {}) => parseFeedback(word(over))!;

  it('keeps one record per reader per finding, under the review it is about; the same id again takes its place', async () => {
    const { service, kept } = make();
    expect(await service.feedback(MATCH, 'beastmaster', 'zh', { value: value() })).toEqual({ status: 'ok' });
    expect([...kept.m.keys()]).toEqual([`${reviewKey}.f0.${ID}`]);
    expect(kept.m.get(`${reviewKey}.f0.${ID}`)).toMatchObject({ schema: FEEDBACK_SCHEMA, prompt_version: P, finding: { index: 0, of: 2, title: '咆哮给了瘟疫法师' }, rating: 'right', reason: null, at: '2026-11-25T12:00:00.000Z' });
    // A change of mind: the same key, the new word.
    await service.feedback(MATCH, 'beastmaster', 'zh', { value: value({ rating: 'wrong', reason: 'fact' }) });
    expect(kept.m.size).toBe(1);
    expect(kept.m.get(`${reviewKey}.f0.${ID}`)).toMatchObject({ rating: 'wrong', reason: 'fact' });
    // Another reader, and another finding, are their own records.
    await service.feedback(MATCH, 'beastmaster', 'zh', { value: value({ id: 'zzzzzzzzzz0123456789' }) });
    await service.feedback(MATCH, 'Beastmaster', 'zh', { value: value({ finding: 1, title: '没有黑皇杖', rating: 'useless', reason: 'knew' }) });
    expect([...kept.m.keys()].sort()).toEqual([`${reviewKey}.f0.${ID}`, `${reviewKey}.f0.zzzzzzzzzz0123456789`, `${reviewKey}.f1.${ID}`].sort());
    expect(feedbackKey(reviewKey, value({ finding: 1 }))).toBe(`${reviewKey}.f1.${ID}`);
  });

  it('what is kept is the stored finding and two labels: nothing the request could have typed', async () => {
    const { service, kept } = make();
    await service.feedback(MATCH, 'beastmaster', 'zh', { value: { ...value({ rating: 'wrong', reason: 'not_mine' }), note: 'free text', email: 'a@b.c' } as any });
    const r = kept.m.get(`${reviewKey}.f0.${ID}`);
    expect(Object.keys(r).sort()).toEqual(['at', 'finding', 'hero', 'lang', 'match_id', 'model', 'plan', 'prompt_version', 'rating', 'reason', 'schema']);
    expect(Object.keys(r.finding).sort()).toEqual(['index', 'of', 'refs', 'title']);
    expect(JSON.stringify(r)).not.toMatch(/free text|a@b\.c/);
  });

  it('takes nothing for a review that is not stored, a finding that is not in it, or another finding in its place', async () => {
    const { service, kept } = make();
    expect(await service.feedback(MATCH, 'beastmaster', 'en', { value: value() })).toEqual({ status: 'no_review' });
    expect(await service.feedback(MATCH, 'axe', 'zh', { value: value() })).toEqual({ status: 'no_review' });
    expect(await service.feedback('123', 'beastmaster', 'zh', { value: value() })).toEqual({ status: 'no_review' });
    expect(await service.feedback(MATCH, 'beastmaster', 'zh', { plan: 'split', value: value() })).toEqual({ status: 'no_review' });
    expect(await service.feedback(MATCH, 'beastmaster', 'zh', { value: value({ finding: 2 }) })).toEqual({ status: 'no_such_finding' });
    expect(await service.feedback(MATCH, 'beastmaster', 'zh', { value: value({ title: '上一版的标题' }) })).toEqual({ status: 'stale' });
    expect(kept.m.size).toBe(0);
  });

  it('with nowhere to keep it, or a store that fails, it says so instead of answering "ok"', async () => {
    expect(await make({ feedback: null }).service.feedback(MATCH, 'beastmaster', 'zh', { value: value() })).toEqual({ status: 'unavailable' });
    const broken = { put: async () => { throw new Error('bucket down'); } };
    expect(await make({ feedback: broken }).service.feedback(MATCH, 'beastmaster', 'zh', { value: value() })).toEqual({ status: 'unavailable' });
  });
});

describe('POST /api/agent/:matchId/feedback', () => {
  let server: any; let base = ''; let kept: ReturnType<typeof memory>;
  const start = async (over: any = {}) => {
    const docs = memory(); kept = memory();
    docs.m.set(`${reviewKey}.review.json`, { review, verification: { repaired: false, dropped: 0 }, model: 'mock' });
    const service = createAgentService({ traces: { get: async () => null }, complete: async () => ({}), model: 'mock', docs, feedback: kept });
    const app = express();
    app.use(express.json());
    app.use(createAgentRouter({ service, resolveClientIp: (req: any) => req.headers['x-test-ip'] ?? '10.0.0.1', ...over }));
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const stop = () => new Promise((resolve) => server.close(resolve));
  const post = async (body: any, ip = '10.0.0.1', id = MATCH) => { const r = await fetch(`${base}/api/agent/${id}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-ip': ip }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json(), retry: r.headers.get('retry-after') }; };
  beforeAll(() => start());
  afterAll(() => stop());

  it('keeps the word and answers ok; a bad body is refused before anything is looked up', async () => {
    expect(await post(word({ rating: 'wrong', reason: 'fact' }))).toMatchObject({ status: 200, body: { status: 'ok' } });
    expect(kept.m.get(`${reviewKey}.f0.${ID}`)).toMatchObject({ rating: 'wrong', reason: 'fact', hero: 'beastmaster', lang: 'zh' });
    for (const bad of [word({ rating: 'great' }), word({ rating: 'right', reason: 'fact' }), word({ hero: '' }), word({ finding: 9 }), word({ id: 'x' }), {}]) expect((await post(bad)).status).toBe(400);
    expect(await post(word({ plan: 'not-a-plan' }))).toMatchObject({ status: 400, body: { code: 'invalid_plan' } });
    expect(await post(word({ model: 'gpt-9' }))).toMatchObject({ status: 400, body: { code: 'invalid_model' } });
    expect((await post(word(), '10.0.0.1', 'abc')).status).toBe(400);
    expect(kept.m.size).toBe(1);
  });

  it('answers 404 with the reason when there is no such review or finding, and writes nothing', async () => {
    const before = kept.m.size;
    expect(await post(word({ lang: 'en' }))).toMatchObject({ status: 404, body: { code: 'no_review' } });
    expect(await post(word({ title: '别的标题' }))).toMatchObject({ status: 404, body: { code: 'stale' } });
    expect(await post(word({ finding: 2 }))).toMatchObject({ status: 404, body: { code: 'no_such_finding' } });
    expect(kept.m.size).toBe(before);
  });

  it('thirty a caller in ten minutes, then 429 for that caller only', async () => {
    await stop(); await start();
    for (let i = 0; i < 30; i += 1) expect((await post(word(), '10.0.0.7')).status).toBe(200);
    expect(await post(word(), '10.0.0.7')).toMatchObject({ status: 429, body: { code: 'rate_limited' } });
    expect((await post(word(), '10.0.0.8')).status).toBe(200);
  });

  it('a day\'s ceiling on what is written: 503 with when to come back, and the refused caller is not charged for it', async () => {
    await stop(); await start({ feedbackDailyMax: 2 });
    expect((await post(word(), '10.0.1.1')).status).toBe(200);
    expect((await post(word({ id: 'bbbbbbbbbb0123456789' }), '10.0.1.2')).status).toBe(200);
    const full = await post(word({ id: 'cccccccccc0123456789' }), '10.0.1.3');
    expect(full).toMatchObject({ status: 503, body: { code: 'busy' } });
    expect(Number(full.retry)).toBeGreaterThan(0);
    expect(kept.m.size).toBe(2);
  });

  it('the same-origin guard stands in front of it, and a server that keeps none says so', async () => {
    await stop(); await start({ guard: () => ({ ok: false, status: 403, error: 'Cross-site request' }) });
    expect(await post(word())).toMatchObject({ status: 403, body: { code: 'forbidden' } });
    expect(kept.m.size).toBe(0);
    await stop();
    const service = createAgentService({ traces: { get: async () => null }, complete: async () => ({}), model: 'mock', docs: memory() });
    const app = express(); app.use(express.json()); app.use(createAgentRouter({ service, resolveClientIp: () => '10.0.0.1' }));
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect(await post(word())).toMatchObject({ status: 503, body: { code: 'unavailable' } });
  });
});
