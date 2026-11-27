import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { createAgentRouter } from '../../lib/agent/router.js';
import { createAgentService } from '../../lib/agent/service.js';
import { parseChatBody } from '../../lib/agent/chat.js';
import { AGENT_MODELS, AGENT_MODEL_IDS, DEFAULT_AGENT_MODEL, modelId, modelLabel, modelMinutes, modelWait, writesSlowly } from '../../lib/agent/models.js';
import { agentModel, agentModels, deepReviewProvider } from '../../lib/agent/providers.js';
import { redactCredentials, redactSecrets, redactUnmistakableSecrets, registerSecretValues, secretValuesFromEnv } from '../../lib/llmErrors.js';
import { shareUrl } from '../../lib/coach/sharePreview.js';
import { sanitizeAnalyticsProps } from '../../lib/analyticsEvents.js';
import { shareLinks } from '../agent/ShareBar';

const express = createRequire(import.meta.url)('express');
const fixture = gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url)));
const trace = () => JSON.parse(fixture.toString());
const SCOREBOARD = JSON.parse(readFileSync(new URL('../fixtures/agent/match9100904020.scoreboard.json', import.meta.url), 'utf8'));
const ID = 9100904020;
const call = (name: string, args: any, id: string) => ({ id, name, args });
const finding = { title: '咆哮', claim: '幻影刺客开了 7 次黑皇杖。', evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 吼进黑皇杖，定住 3.4 秒' }], fix: '留给她。' };
const submit = { verdict: '咆哮没有留给幻影刺客。', mainline: [], findings: [finding], next_game: ['留咆哮'], blind_spots: ['视野'] };
/** A model that looks things up (one turn), then submits a review; it counts the times it was asked. */
function engine(name: string) {
  const e = { name, asked: 0, complete: async (o: any) => {
    e.asked += 1;
    return o.messages.at(-1).role === 'user'
      ? { toolCalls: [call('ability_audit', { hero: 'beastmaster', ability: 'primal_roar' }, 'a'), call('immunity_windows', { hero: 'phantom_assassin' }, 'b')] }
      : { toolCalls: [call('submit_review', submit, 's')] };
  } };
  return e;
}
function world() {
  const blobs = new Map<string, any>();
  const docs = { get: async (k: string) => blobs.get(k) ?? null, put: async (k: string, v: any) => { blobs.set(k, v); } };
  const t = trace();
  return { blobs, docs, traces: { get: async () => t } };
}
const until = async (f: () => Promise<any>, ok: (v: any) => boolean) => { let v: any; for (let i = 0; i < 100; i += 1) { v = await f(); if (ok(v)) return v; await new Promise((r) => setTimeout(r, 15)); } return v; };
const reviews = (w: ReturnType<typeof world>) => [...w.blobs.keys()].filter((k) => k.endsWith('.review.json')).sort();

describe('the models a reader can choose', () => {
  it('are named by an id and a label, the default first', () => {
    expect(AGENT_MODEL_IDS).toEqual(['deepseek-flash', 'kimi-k3.1-pro', 'glm-5.3-flash', 'glm-5.3', 'glm-5.4']);
    expect(DEFAULT_AGENT_MODEL).toBe('deepseek-flash');
    for (const m of AGENT_MODELS) expect(Object.keys(m).sort()).toEqual(['id', 'label', 'minutes']);
    // What was not timed is not given a time.
    expect([modelMinutes('deepseek-flash'), modelMinutes('kimi-k3.1-pro'), modelMinutes('glm-5.3-flash'), modelMinutes('glm-5.4'), modelMinutes('nope')]).toEqual([[2, 3], [13, 13], [11, 13], null, null]);
    // The wait a reader is told: the measured span, one number when both runs agree, nothing when not timed.
    expect(AGENT_MODEL_IDS.map((id) => modelWait(id, 'zh'))).toEqual(['约 2–3 分钟', '约 13 分钟', '约 11–13 分钟', '约 24 分钟', null]);
    expect(AGENT_MODEL_IDS.map((id) => modelWait(id, 'en'))).toEqual(['about 2–3 minutes', 'about 13 minutes', 'about 11–13 minutes', 'about 24 minutes', null]);
    expect(modelWait('nope', 'en')).toBeNull();
    for (const m of AGENT_MODELS) if (m.minutes) expect(m.minutes[0] <= m.minutes[1] && m.minutes[0] > 0).toBe(true);
    // Which models need the longer time limit is a fact about the model, not about which one a server makes its
    // default (review of #327); one that was not timed is not assumed to be quick.
    expect(AGENT_MODEL_IDS.map((id) => [id, writesSlowly(id)])).toEqual([['deepseek-flash', false], ['kimi-k3.1-pro', true], ['glm-5.3-flash', true], ['glm-5.3', true], ['glm-5.4', true]]);
    expect(writesSlowly('nope')).toBe(true);
    expect([modelId('glm-5.3'), modelId('GLM-5.3'), modelId('gpt'), modelId(''), modelId(null), modelId(['glm-5.3']), modelId('__proto__')]).toEqual(['glm-5.3', null, null, null, null, null, null]);
    expect([modelLabel('kimi-k3.1-pro'), modelLabel('nope')]).toEqual(['Kimi K3.1 Pro', 'nope']);
  });
});

describe('which models a server offers', () => {
  const all = { DEEPSEEK_API_KEY: 'sk-d', KIMI_API_KEY: 'sk-kimi-k', GLM_API_KEY: 'g.h' };
  it('each model whose key is set, the default first; GLM-5.3 and GLM-5.4 only when asked for', () => {
    const offer = agentModels(all);
    expect(offer.models.map((m) => m.id)).toEqual(['deepseek-flash', 'kimi-k3.1-pro', 'glm-5.3-flash']);
    expect(offer.default).toBe('deepseek-flash');
    expect(offer.skipped).toEqual([]);
    // A missing key takes its models out, and says which variable (never a value).
    const some = agentModels({ GLM_API_KEY: 'g.h' });
    expect(some.models.map((m) => m.id)).toEqual(['glm-5.3-flash']);
    expect(some.default).toBe('glm-5.3-flash');
    expect(some.skipped).toEqual([{ id: 'deepseek-flash', error: 'missing_key', needs: 'DEEPSEEK_API_KEY' }, { id: 'kimi-k3.1-pro', error: 'missing_key', needs: 'KIMI_API_KEY' }]);
    expect(agentModels({})).toEqual({ default: null, models: [], skipped: expect.any(Array) });
    const picked = agentModels({ ...all, AGENT_MODELS: 'glm-5.4, deepseek-flash,gpt-9' });
    expect(picked.models.map((m) => m.id)).toEqual(['deepseek-flash', 'glm-5.4']);
    expect(picked.skipped).toEqual([{ id: 'gpt-9', error: 'unknown_model' }]);
  });

  it('each id is one upstream model at one address', () => {
    expect(agentModel('deepseek-flash', all)).toMatchObject({ ok: true, id: 'deepseek-flash', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'sk-d' });
    expect(agentModel('glm-5.3', { ...all, GLM_MODEL: 'glm-4.5' })).toMatchObject({ baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3', apiKey: 'g.h' });
    expect(agentModel('gpt-9', all)).toEqual({ ok: false, error: 'unknown_provider' });
    expect(agentModel('constructor', all)).toEqual({ ok: false, error: 'unknown_provider' });
  });

  it('a Kimi key goes to the address of its kind, and to no address that is not Kimi\'s', () => {
    // A Kimi Code membership key, and what K3.1 Pro is called there.
    expect(agentModel('kimi-k3.1-pro', { KIMI_API_KEY: 'sk-kimi-abc' })).toMatchObject({ baseURL: 'https://api.kimi.com/coding/v1', model: 'k3.1-pro', extraBody: {} });
    // A platform key.
    expect(agentModel('kimi-k3.1-pro', { KIMI_API_KEY: 'sk-abc' })).toMatchObject({ baseURL: 'https://api.moonshot.cn/v1', model: 'kimi-k3.1-pro' });
    expect(agentModel('kimi-k3.1-pro', { KIMI_API_KEY: 'sk-abc', KIMI_BASE_URL: 'https://api.moonshot.ai/v1/' })).toMatchObject({ baseURL: 'https://api.moonshot.ai/v1', model: 'kimi-k3.1-pro' });
    expect(agentModel('kimi-k3.1-pro', { KIMI_API_KEY: 'sk-kimi-abc', KIMI_BASE_URL: 'https://api.kimi.ai/coding/v1' })).toMatchObject({ baseURL: 'https://api.kimi.ai/coding/v1', model: 'k3.1-pro' });
    for (const url of ['https://api.kimi.com.evil.example/coding/v1', 'http://api.moonshot.cn/v1', 'https://example.com/v1', 'constructor']) {
      expect(agentModel('kimi-k3.1-pro', { KIMI_API_KEY: 'sk-kimi-abc', KIMI_BASE_URL: url })).toEqual({ ok: false, error: 'invalid_base_url', needs: 'KIMI_BASE_URL' });
    }
    // The id is K3.1 Pro whatever a script's override says; the script's own entry follows the override.
    expect(agentModel('kimi-k3.1-pro', { KIMI_API_KEY: 'sk-kimi-abc', KIMI_MODEL: 'k3' })).toMatchObject({ model: 'k3.1-pro' });
    expect(deepReviewProvider('kimi', { KIMI_API_KEY: 'sk-kimi-abc', KIMI_MODEL: 'k3' })).toMatchObject({ model: 'k3' });
    expect(deepReviewProvider('kimi', {})).toEqual({ ok: false, error: 'missing_key', needs: 'KIMI_API_KEY' });
  });

  it('models that always think are never told to stop: "disabled" asks for their lowest effort', () => {
    expect(agentModel('glm-5.3-flash', all)).toMatchObject({ extraBody: { thinking: { type: 'enabled' } } });
    expect(agentModel('glm-5.3-flash', { ...all, DEEP_REVIEW_THINKING: 'disabled' })).toMatchObject({ thinking: 'disabled', extraBody: { thinking: { type: 'enabled' }, reasoning_effort: 'low' } });
    expect((agentModel('glm-5.3', { ...all, GLM_REASONING_EFFORT: 'high' }) as any).extraBody).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'high' });
    expect((agentModel('glm-5.3', { ...all, GLM_REASONING_EFFORT: 'none' }) as any).extraBody).toEqual({ thinking: { type: 'enabled' } });
    // Kimi takes no `thinking` field at all.
    expect((agentModel('kimi-k3.1-pro', { ...all, DEEP_REVIEW_THINKING: 'disabled' }) as any).extraBody).toEqual({ reasoning_effort: 'low' });
    expect((agentModel('kimi-k3.1-pro', { ...all, KIMI_REASONING_EFFORT: 'max' }) as any).extraBody).toEqual({ reasoning_effort: 'max' });
    expect((agentModel('deepseek-flash', { ...all, DEEP_REVIEW_THINKING: 'disabled' }) as any).extraBody).toEqual({ thinking: { type: 'disabled' } });
  });
});

describe('a review by another model is its own review', () => {
  const service = (w: ReturnType<typeof world>, extra: any = {}) => {
    const d = engine('deepseek-flash'); const g = engine('glm-5.3');
    const svc: any = createAgentService({ traces: w.traces, docs: w.docs, models: { 'deepseek-flash': d, 'glm-5.3': g }, defaultModel: 'deepseek-flash', getMatchDetail: async () => SCOREBOARD, ...extra });
    return { svc, d, g };
  };

  it('written by the model asked for, kept beside the default\'s, and neither stands in for the other', async () => {
    const w = world();
    const { svc, d, g } = service(w);
    expect(await svc.availability(ID)).toMatchObject({ model_configured: true, models: ['deepseek-flash', 'glm-5.3'], default_model: 'deepseek-flash' });
    expect(await svc.start(ID, 'beastmaster', 'zh', { model: 'glm-5.3' })).toMatchObject({ status: 'running' });
    // The default's review of the same game is not that one: nothing is running for it.
    expect(await svc.status(ID, 'beastmaster', 'zh')).toEqual({ status: 'none' });
    const ready = await until(() => svc.status(ID, 'beastmaster', 'zh', null, 'glm-5.3'), (s) => s.status === 'ready');
    expect(ready).toMatchObject({ status: 'ready', model: 'glm-5.3', review: { verdict: submit.verdict } });
    expect([d.asked, g.asked > 0]).toEqual([0, true]);
    expect(reviews(w)).toEqual([expect.stringMatching(/^9100904020\.beastmaster\.zh\.p\d+\.m-glm-5\.3\.review\.json$/)]);
    expect(await svc.status(ID, 'beastmaster', 'zh')).toEqual({ status: 'none' });
    // The default, by no name or by its own, keeps the key every review had before there was a choice.
    await svc.start(ID, 'beastmaster', 'zh', { model: 'deepseek-flash' });
    expect(await until(() => svc.status(ID, 'beastmaster', 'zh'), (s) => s.status === 'ready')).toMatchObject({ status: 'ready', model: 'deepseek-flash' });
    expect(await svc.status(ID, 'beastmaster', 'zh', null, 'deepseek-flash')).toMatchObject({ status: 'ready', model: 'deepseek-flash' });
    expect(reviews(w)).toEqual([expect.stringMatching(/^9100904020\.beastmaster\.zh\.p\d+\.m-glm-5\.3\.review\.json$/), expect.stringMatching(/^9100904020\.beastmaster\.zh\.p\d+\.review\.json$/)]);
    expect(d.asked).toBeGreaterThan(0);
    // With a plan too: the plan first, then the model.
    await svc.start(ID, 'beastmaster', 'zh', { plan: 'push', model: 'glm-5.3' });
    await until(() => svc.status(ID, 'beastmaster', 'zh', 'push', 'glm-5.3'), (s) => s.status === 'ready');
    expect(reviews(w)).toContainEqual(expect.stringMatching(/\.p\d+\.plan-push\.m-glm-5\.3\.review\.json$/));
    // A link preview reads the review of the model the link names.
    expect(await svc.peek(ID, 'beastmaster', 'zh', null, 'glm-5.3')).toMatchObject({ verdict: submit.verdict });
    expect(await svc.peek(ID, 'beastmaster', 'zh', null, 'kimi-k3.1-pro')).toBeNull();
  });

  it('a model this server does not offer is not offered a stand-in', async () => {
    const w = world();
    const { svc, d, g } = service(w);
    for (const model of ['kimi-k3.1-pro', 'nope', 'constructor', ['glm-5.3'], 7]) {
      expect(svc.modelOf(model)).toBe(false);
      expect(await svc.start(ID, 'beastmaster', 'zh', { model })).toEqual({ status: 'unavailable', reason: 'model_not_offered' });
      expect(await svc.status(ID, 'beastmaster', 'zh', null, model)).toEqual({ status: 'unavailable', reason: 'model_not_offered' });
      expect(await svc.chat({ matchId: ID, hero: 'beastmaster', lang: 'zh', model, question: 'q', history: [] })).toEqual({ status: 'unavailable' });
    }
    expect([svc.modelOf(null), svc.modelOf(''), svc.modelOf(undefined), svc.modelOf('deepseek-flash'), svc.modelOf('glm-5.3')]).toEqual([null, null, null, null, 'glm-5.3']);
    expect([d.asked, g.asked, reviews(w)]).toEqual([0, 0, []]);
  });

  it('is queued with its model and run by it; a queued task for a model not offered is dropped', async () => {
    const w = world();
    const queue: any[] = [];
    const front = service(w, { dispatch: async (task: any) => { queue.push(task); } });
    const back = service(w);
    await front.svc.start(ID, 'beastmaster', 'zh', { model: 'glm-5.3' });
    await front.svc.start(ID, 'beastmaster', 'zh');
    // Each task names its model, the default's too: what it is run by does not depend on what the default is when it arrives.
    expect(queue).toEqual([{ kind: 'review', matchId: String(ID), hero: 'beastmaster', lang: 'zh', model: 'glm-5.3' }, { kind: 'review', matchId: String(ID), hero: 'beastmaster', lang: 'zh', model: 'deepseek-flash' }]);
    expect(await back.svc.run({ ...queue[0], model: 'kimi-k3.1-pro' })).toEqual({ status: 'invalid' });
    expect(await back.svc.run(queue[0])).toEqual({ status: 'ready' });
    expect([back.d.asked, back.g.asked > 0]).toEqual([0, true]);
    expect(await front.svc.status(ID, 'beastmaster', 'zh', null, 'glm-5.3')).toMatchObject({ status: 'ready', model: 'glm-5.3' });
    // The other one is still only queued: its marker says running, and nothing of it is stored.
    expect(reviews(w)).toHaveLength(1);
  });

  it('the model that wrote the review on screen answers the questions about it, with that review', async () => {
    const w = world();
    const { svc } = service(w);
    await svc.start(ID, 'beastmaster', 'zh', { model: 'glm-5.3' });
    await until(() => svc.status(ID, 'beastmaster', 'zh', null, 'glm-5.3'), (s) => s.status === 'ready');
    const seen: Record<string, string[]> = { d: [], g: [] };
    const asking: any = createAgentService({ traces: w.traces, docs: w.docs, defaultModel: 'deepseek-flash', models: {
      'deepseek-flash': { name: 'deepseek-flash', complete: async (o: any) => { seen.d.push(o.messages[0].content); return { text: '答。' }; } },
      'glm-5.3': { name: 'glm-5.3', complete: async (o: any) => { seen.g.push(o.messages[0].content); return { text: '答。' }; } },
    } });
    await asking.chat({ matchId: ID, hero: 'beastmaster', lang: 'zh', model: 'glm-5.3', question: 'q', history: [] });
    expect([seen.d.length, seen.g.length]).toEqual([0, 1]);
    expect(seen.g[0]).toContain(submit.verdict);
    await asking.chat({ matchId: ID, hero: 'beastmaster', lang: 'zh', question: 'q', history: [] });
    expect(seen.d[0]).toContain('Review of this game: none yet');
    expect(parseChatBody({ question: 'q', hero: 'axe', model: 'glm-5.3' }).model).toBe('glm-5.3');
    expect(parseChatBody({ question: 'q', hero: 'axe' }).model).toBeUndefined();
    expect(parseChatBody({ question: 'q', hero: 'axe', model: { $ne: 1 } }).model).toBe(false);
  });

  it('the key without a model is DeepSeek\'s alone: another model that becomes the default is not handed DeepSeek\'s reviews (review of #327)', async () => {
    const w = world();
    // A review DeepSeek wrote, stored as every review was before there was a choice.
    const { svc: before } = service(w);
    await before.start(ID, 'beastmaster', 'zh');
    await until(() => before.status(ID, 'beastmaster', 'zh'), (s) => s.status === 'ready');
    expect(reviews(w)).toEqual([expect.stringMatching(/\.p\d+\.review\.json$/)]);
    // The server is now set up without DeepSeek: Kimi is the default, by no name or by its own.
    const k = engine('k3.1-pro');
    const queue: any[] = [];
    const kimiOnly: any = createAgentService({ traces: w.traces, docs: w.docs, models: { 'kimi-k3.1-pro': k }, defaultModel: 'kimi-k3.1-pro', getMatchDetail: async () => SCOREBOARD, dispatch: async (task: any) => { queue.push(task); } });
    expect(await kimiOnly.status(ID, 'beastmaster', 'zh')).toEqual({ status: 'none' });
    expect(await kimiOnly.status(ID, 'beastmaster', 'zh', null, 'kimi-k3.1-pro')).toEqual({ status: 'none' });
    expect(await kimiOnly.peek(ID, 'beastmaster', 'zh')).toBeNull();
    // Its own review is written by it, under its own name; the task that carries it names it.
    expect(await kimiOnly.start(ID, 'beastmaster', 'zh')).toMatchObject({ status: 'running' });
    expect(queue).toEqual([{ kind: 'review', matchId: String(ID), hero: 'beastmaster', lang: 'zh', model: 'kimi-k3.1-pro' }]);
    expect(await kimiOnly.run(queue[0])).toEqual({ status: 'ready' });
    expect(k.asked).toBeGreaterThan(0);
    expect(await kimiOnly.status(ID, 'beastmaster', 'zh')).toMatchObject({ status: 'ready', model: 'k3.1-pro' });
    expect(reviews(w)).toEqual([expect.stringMatching(/\.p\d+\.m-kimi-k3\.1-pro\.review\.json$/), expect.stringMatching(/\.p\d+\.review\.json$/)]);
    // DeepSeek's is still DeepSeek's, for a server that offers both, whichever is its default.
    const both: any = createAgentService({ traces: w.traces, docs: w.docs, models: { 'kimi-k3.1-pro': k, 'deepseek-flash': engine('deepseek-flash') }, defaultModel: 'kimi-k3.1-pro' });
    expect(await both.status(ID, 'beastmaster', 'zh', null, 'deepseek-flash')).toMatchObject({ status: 'ready', model: 'deepseek-flash' });
    expect(await both.status(ID, 'beastmaster', 'zh')).toMatchObject({ status: 'ready', model: 'k3.1-pro' });
    // A task queued while another model was the default is run by the model it names, or dropped: never by this server's default.
    expect(await kimiOnly.run({ kind: 'review', matchId: String(ID), hero: 'phantom_assassin', lang: 'zh', model: 'deepseek-flash' })).toEqual({ status: 'invalid' });
  });

  it('a service given one model, as before there was a choice, lists none and keeps its keys', async () => {
    const w = world();
    const one = engine('m');
    const svc: any = createAgentService({ traces: w.traces, docs: w.docs, complete: one.complete, model: 'm' });
    const avail = await svc.availability(ID);
    expect(avail).toMatchObject({ model_configured: true });
    expect(avail).not.toHaveProperty('models');
    expect(await svc.start(ID, 'beastmaster', 'zh', { model: 'glm-5.3' })).toEqual({ status: 'unavailable', reason: 'model_not_offered' });
    await svc.start(ID, 'beastmaster', 'zh');
    expect(await until(() => svc.status(ID, 'beastmaster', 'zh'), (s) => s.status === 'ready')).toMatchObject({ model: 'm' });
    expect(reviews(w)).toEqual([expect.stringMatching(/^9100904020\.beastmaster\.zh\.p\d+\.review\.json$/)]);
  });
});

describe('the routes take the model, and refuse one that is not offered', () => {
  it('an unknown model is a 400 that spends nothing; each extra model has its own hourly ceiling', async () => {
    const w = world();
    let acquired = 0;
    const d = engine('deepseek-flash'); const g = engine('glm-5.3'); const f = engine('glm-5.3-flash');
    const service: any = createAgentService({ traces: w.traces, docs: w.docs, models: { 'deepseek-flash': d, 'glm-5.3-flash': f, 'glm-5.3': g }, defaultModel: 'deepseek-flash', getMatchDetail: async () => SCOREBOARD });
    const app = express(); app.use(express.json());
    app.use(createAgentRouter({ service, resolveClientIp: () => '10.7.0.1', modelHourlyMax: 1, llm: { acquire: () => { acquired += 1; return { ok: true }; } } }));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const get = async (hero: string, q: string) => (await fetch(`${base}/api/agent/${ID}/review?hero=${hero}&lang=zh${q}`)).json();
      const post = (body: any) => fetch(`${base}/api/agent/${ID}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(await (await fetch(`${base}/api/agent/${ID}`)).json()).toMatchObject({ models: ['deepseek-flash', 'glm-5.3-flash', 'glm-5.3'], default_model: 'deepseek-flash' });
      for (const model of ['kimi-k3.1-pro', 'gpt-9', ['glm-5.3'], { a: 1 }, 5]) {
        const bad = await post({ hero: 'beastmaster', lang: 'zh', model });
        expect([bad.status, await bad.json()]).toEqual([400, { code: 'invalid_model', error: 'Unknown model' }]);
      }
      expect((await fetch(`${base}/api/agent/${ID}/review?hero=beastmaster&model=gpt-9`)).status).toBe(400);
      expect((await fetch(`${base}/api/agent/${ID}/review?hero=beastmaster&model=glm-5.3&model=glm-5.3`)).status).toBe(400);
      const chat = await fetch(`${base}/api/agent/${ID}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hero: 'beastmaster', lang: 'zh', question: 'q', history: [], model: 'gpt-9' }) });
      expect(chat.status).toBe(400);
      expect([acquired, d.asked, g.asked]).toEqual([0, 0, 0]);

      expect((await post({ hero: 'beastmaster', lang: 'zh', model: 'glm-5.3' })).status).toBe(202);
      expect(acquired).toBe(1);
      const ready = await until(() => get('beastmaster', '&model=glm-5.3'), (s) => s.status === 'ready');
      expect(ready.model).toBe('glm-5.3');
      expect(await get('beastmaster', '')).toEqual({ status: 'none' });
      // An empty model is the default.
      expect(await get('beastmaster', '&model=')).toEqual({ status: 'none' });
      // That model's hour is full: its next review waits, and nothing was taken from the model budget for it…
      const full = await post({ hero: 'phantom_assassin', lang: 'zh', model: 'glm-5.3' });
      expect([full.status, (await full.json()).code]).toEqual([503, 'busy']);
      expect(acquired).toBe(1);
      // …while another model's hour, and the default, are their own.
      expect((await post({ hero: 'phantom_assassin', lang: 'zh', model: 'glm-5.3-flash' })).status).toBe(202);
      expect((await post({ hero: 'phantom_assassin', lang: 'zh' })).status).toBe(202);
      expect((await post({ hero: 'beastmaster', lang: 'zh', model: 'deepseek-flash' })).status).toBe(202);
      expect(acquired).toBe(4);
      // The review already there is handed over without asking the ceiling.
      expect((await post({ hero: 'beastmaster', lang: 'zh', model: 'glm-5.3' })).status).toBe(200);
    } finally { server.close(); }
  });
});

describe('a model keeps its hourly ceiling when it is the server\'s default (review of #327)', () => {
  it('Kimi as the default is still held to its own ceiling; DeepSeek, default or not, has none of its own', async () => {
    const serve = async (models: any, defaultModel: string) => {
      const w = world();
      const service: any = createAgentService({ traces: w.traces, docs: w.docs, models, defaultModel, getMatchDetail: async () => SCOREBOARD });
      const app = express(); app.use(express.json());
      app.use(createAgentRouter({ service, resolveClientIp: () => '10.7.0.2', modelHourlyMax: 1 }));
      const server = app.listen(0);
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const post = async (body: any) => (await fetch(`${base}/api/agent/${ID}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status;
      return { post, close: () => server.close() };
    };
    const kimiFirst = await serve({ 'kimi-k3.1-pro': engine('k3.1-pro'), 'deepseek-flash': engine('deepseek-flash') }, 'kimi-k3.1-pro');
    try {
      // By no name and by its own, Kimi's reviews count against Kimi's hour.
      expect(await kimiFirst.post({ hero: 'beastmaster', lang: 'zh' })).toBe(202);
      expect(await kimiFirst.post({ hero: 'phantom_assassin', lang: 'zh' })).toBe(503);
      expect(await kimiFirst.post({ hero: 'phantom_assassin', lang: 'zh', model: 'kimi-k3.1-pro' })).toBe(503);
      // DeepSeek, not the default here, is held only by the shared limits.
      expect(await kimiFirst.post({ hero: 'phantom_assassin', lang: 'zh', model: 'deepseek-flash' })).toBe(202);
      expect(await kimiFirst.post({ hero: 'sven', lang: 'zh', model: 'deepseek-flash' })).toBe(202);
    } finally { kimiFirst.close(); }
  });
});

describe('a key is redacted by its value, whatever it looks like', () => {
  it('a key with no known shape, alone in a line, does not reach the log once it is registered', () => {
    // The shape of a Zhipu key: hex, a dot, letters. No "sk-", no "Bearer", no "key=" beside it.
    const key = '0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp'; // gitleaks:allow (made up for this test, not a credential)
    const line = `upstream said: credential ${key} rejected`;
    expect(redactCredentials(line)).toContain(key);
    registerSecretValues([key, 'short', '', null, 42]);
    for (const redact of [redactCredentials, redactSecrets, redactUnmistakableSecrets]) {
      expect(redact(line)).not.toContain(key);
      expect(redact(line)).not.toContain(key.slice(0, 20));
      expect(redact(`${key}${key}`)).not.toContain('0123456789abcdef');
    }
    // A short value is not treated as a secret: ordinary words survive.
    expect(redactCredentials('a short word')).toBe('a short word');
    // By value before the cut: a key the length cap would split is still taken out whole.
    expect(redactSecrets(`${'x '.repeat(990)}${key}`)).not.toContain('0123456789abcdef');
  });

  it('the secrets are the values of the variables named as such', () => {
    const env = { GLM_API_KEY: 'g'.repeat(20), KIMI_API_KEY: 'k'.repeat(20), STEAM_RETRIEVER_SECRET: 's'.repeat(20), SOME_TOKEN: 't'.repeat(20), DB_PASSWORD: 'p'.repeat(20), DEEPSEEK_MODEL: 'deepseek-flash-long-name', AGENT_BUCKET: 'bucket-name-long-enough', MONKEY: 'm'.repeat(20), SHORT_KEY: 'abc', EMPTY_KEY: '' };
    expect(secretValuesFromEnv(env).sort()).toEqual(['g', 'k', 'p', 's', 't'].map((c) => c.repeat(20)));
    expect(secretValuesFromEnv()).toEqual([]);
  });
});

describe('a shared link and the counts name the model', () => {
  it('the personal link and its preview address carry a model that is not the default; the team link never', () => {
    const links = shareLinks('https://dota2.ai', '9100904020', 'beastmaster', 'zh', 'push', 'glm-5.3');
    expect(links.self).toBe('https://dota2.ai/r/9100904020?hero=beastmaster&plan=push&model=glm-5.3&ref=share&lang=zh');
    expect(links.team).not.toContain('model');
    expect(shareLinks('https://dota2.ai', '9100904020', 'beastmaster', 'en').self).not.toContain('model');
    expect(shareUrl(9100904020, { hero: 'beastmaster', model: 'glm-5.3', lang: 'zh' })).toMatch(/\/r\/9100904020\?hero=beastmaster&model=glm-5\.3&lang=zh$/);
    expect(shareUrl(9100904020, { hero: 'beastmaster' })).not.toContain('model');
    // Without a hero there is no review to name a model for.
    expect(shareUrl(9100904020, { slot: 3, model: 'glm-5.3' })).not.toContain('model');
  });

  it('an event keeps a model id of the list and drops anything else', () => {
    expect(sanitizeAnalyticsProps({ matchId: '1', lang: 'zh', step: 'review', plan: false, model: 'glm-5.3' }, 'review_requested')).toMatchObject({ model: 'glm-5.3' });
    expect(sanitizeAnalyticsProps({ matchId: '1', lang: 'zh', step: 'review', plan: false, model: 'my secret text' }, 'review_requested')).not.toHaveProperty('model');
    expect(sanitizeAnalyticsProps({ matchId: '1', lang: 'zh', hero: 'axe', model: 'kimi-k3.1-pro' }, 'review_ready')).toMatchObject({ model: 'kimi-k3.1-pro' });
  });
});
