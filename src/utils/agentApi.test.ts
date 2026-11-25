import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createAgentRouter } from '../../lib/agent/router.js';
import { proItemsFor } from '../../lib/agent/proItems.js';
import { patchData } from '../../lib/agent/patchData.js';
import { createAgentService, createFileTraceStore } from '../../lib/agent/service.js';
import { chatSystem, parseChatBody, runChat } from '../../lib/agent/chat.js';

const express = createRequire(import.meta.url)('express');
const MATCH = '9100904020';
const dir = mkdtempSync(join(tmpdir(), 'agent-api-'));
copyFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url), join(dir, `${MATCH}.trace.json.gz`));
copyFileSync(new URL('../../package.json', import.meta.url), join(dir, '123.trace.json.gz'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const call = (name: string, args: any, id: string) => ({ id, name, args });
const finding = { title: '咆哮', claim: '幻影刺客开了 7 次黑皇杖。', evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 吼进黑皇杖，定住 3.4 秒' }], fix: '留给她。' };
const submit = { verdict: '咆哮没有留给幻影刺客。', mainline: [], findings: [finding], next_game: ['留咆哮'], blind_spots: ['视野'] };
/** A model that looks things up, then submits a review; for chat questions it looks up one death and answers. */
function model() {
  const seen: any[] = [];
  const complete = async (o: any) => {
    seen.push(JSON.parse(JSON.stringify(o)));
    const last = o.messages.at(-1);
    const isChat = !o.tools.some((t: any) => t.name === 'submit_review');
    if (isChat) {
      if (last.role === 'tool') return { text: '36:05 你满血 2915，被 axe 先手。' };
      if (String(last.content).startsWith('These are not in')) return { text: '36:05 你被先手。' };
      if (String(last.content).includes('编')) return { text: '你在 19:19 死了。' };
      return { toolCalls: [call('death_context', { hero: 'beastmaster', index: 9 }, 'd')] };
    }
    if (last.role === 'user') return { toolCalls: [call('ability_audit', { hero: 'beastmaster', ability: 'primal_roar' }, 'a'), call('immunity_windows', { hero: 'phantom_assassin' }, 'b')] };
    return { toolCalls: [call('submit_review', submit, 's')] };
  };
  return { seen, complete };
}

describe('trace store', () => {
  it('reads a trace by match id, and nothing else', async () => {
    const store = createFileTraceStore(dir);
    expect((await store.get(MATCH)).heroes).toHaveLength(10);
    expect(await store.get(Number(MATCH))).toBe(await store.get(MATCH));
    for (const bad of ['123', '999', '../x', '', '0']) expect(await store.get(bad)).toBeNull();
    expect(await createFileTraceStore(null).get(MATCH)).toBeNull();
  });
});

describe('runChat', () => {
  it('looks the moment up and answers from it, in the reader\'s names', async () => {
    const m = model();
    const trace = await createFileTraceStore(dir).get(MATCH);
    const steps: any[] = [];
    const r = await runChat({ complete: m.complete, trace, hero: 'beastmaster', lang: 'zh', question: '36 分钟那次我怎么死的？', history: [{ q: '之前的问题', a: '之前的回答' }], onEvent: (e: any) => steps.push(e) });
    expect(r).toMatchObject({ status: 'ok', text: '36:05 你满血 2915，被 斧王 先手。', unverified: [], tool_calls: [{ name: 'death_context', args: { hero: 'beastmaster', index: 9 } }] });
    expect(steps[0]).toEqual({ type: 'tool_start', name: 'death_context', args: { hero: 'beastmaster', index: 9 } });
    // The model sees the context, the earlier turn, the question, and only lookup tools.
    expect(m.seen[0].messages.map((x: any) => x.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(m.seen[0].messages[0].content).toContain('Review of this game: none yet');
    expect(m.seen[0].tools.map((t: any) => t.name)).not.toContain('submit_review');
    expect(m.seen[0].system).toBe(chatSystem('zh'));
  });
  it('asks once for a correction, and reports what is still unsupported', async () => {
    const trace = await createFileTraceStore(dir).get(MATCH);
    const fixed = await runChat({ complete: model().complete, trace, hero: 'beastmaster', question: '编一个' });
    expect(fixed).toMatchObject({ status: 'ok', text: '36:05 你被先手。' });
    // 36:05 is in no tool result of that conversation either: it is flagged, not hidden.
    expect(fixed.unverified).toEqual([{ kind: 'time', text: '36:05' }]);
    const stubborn = await runChat({ complete: async () => ({ text: '你在 19:19 死了。' }), trace, hero: 'beastmaster', question: 'q' });
    expect(stubborn.unverified).toEqual([{ kind: 'time', text: '19:19' }]);
    // A time the review already holds needs no lookup.
    expect((await runChat({ complete: async () => ({ text: '27:27 那次。' }), trace, hero: 'beastmaster', question: 'q', review: { findings: [{ evidence: [{ clock: '27:27' }] }] } })).unverified).toEqual([]);
    expect(await runChat({ complete: async () => ({ text: ' ' }), trace, hero: 'beastmaster', question: 'q' })).toMatchObject({ status: 'no_answer' });
    expect(await runChat({ complete: async () => ({ text: 'x' }), trace, hero: 'pudge', question: 'q' })).toEqual({ status: 'unknown_hero' });
  });
  it('an earlier answer backs a later one only if it came back clean', async () => {
    const trace = await createFileTraceStore(dir).get(MATCH);
    const say = async () => ({ text: '你在 19:19 死了。' });
    // The earlier answer stated 19:19 and was returned with it flagged: it is not evidence now.
    expect((await runChat({ complete: say, trace, hero: 'beastmaster', question: 'q', history: [{ q: 'a', a: '你在 19:19 死了。', clean: false }] })).unverified).toEqual([{ kind: 'time', text: '19:19' }]);
    expect((await runChat({ complete: say, trace, hero: 'beastmaster', question: 'q', history: [{ q: 'a', a: '你在 19:19 死了。' }] } as any)).unverified).toEqual([{ kind: 'time', text: '19:19' }]);
    expect((await runChat({ complete: say, trace, hero: 'beastmaster', question: 'q', history: [{ q: 'a', a: '你在 19:19 死了。', clean: true }] })).unverified).toEqual([]);
  });

  it('a count the review or a clean earlier answer stated may be repeated', async () => {
    const trace = await createFileTraceStore(dir).get(MATCH);
    const say = async () => ({ text: 'You cast it 7 times and died 9 times.' });
    const review = { verdict: 'She used Black King Bar 7 times.' };
    expect((await runChat({ complete: say, trace, hero: 'beastmaster', question: 'q' })).unverified).toEqual([{ kind: 'count', text: '7' }, { kind: 'count', text: '9' }]);
    expect((await runChat({ complete: say, trace, hero: 'beastmaster', question: 'q', review, history: [{ q: 'a', a: 'You died 9 times.', clean: true }] })).unverified).toEqual([]);
    // A flagged earlier answer backs nothing.
    expect((await runChat({ complete: say, trace, hero: 'beastmaster', question: 'q', review, history: [{ q: 'a', a: 'You died 9 times.', clean: false }] })).unverified).toEqual([{ kind: 'count', text: '9' }]);
  });

  it('a review\'s advice is not evidence: only its checked part backs a later answer', async () => {
    const trace = await createFileTraceStore(dir).get(MATCH);
    const review = { verdict: 'v at 27:27', findings: [{ title: 't', claim: 'c', evidence: [{ refs: ['x'], clock: '30:25', fact: 'f' }], fix: 'At 19:19 you lost 99999 gold.' }], next_game: ['Farm 88888 by 18:18.'], blind_spots: ['17:17'] };
    const say = (text: string) => runChat({ complete: async () => ({ text }), trace, hero: 'beastmaster', question: 'q', review });
    expect((await say('At 19:19 you lost 99999 gold.')).unverified).toEqual([{ kind: 'time', text: '19:19' }, { kind: 'number', text: '99999' }]);
    expect((await say('Farm 88888 by 18:18, see 17:17.')).unverified!.map((u: any) => u.text)).toEqual(['18:18', '17:17', '88888']);
    expect((await say('At 27:27 and 30:25.')).unverified).toEqual([]);
    // What a rule says happened this game was checked with the finding; its situation and action are advice.
    const ruled = { verdict: 'v', findings: [{ title: 't', claim: 'c', evidence: [], fix: 'f', rule: { when: 'Below 16:16 on the clock', do: 'hold 77777 gold', this_game: '7 deaths, the first at 15:15' } }] };
    const say2 = (text: string) => runChat({ complete: async () => ({ text }), trace, hero: 'beastmaster', question: 'q', review: ruled });
    expect((await say2('7 deaths, the first at 15:15.')).unverified).toEqual([]);
    expect((await say2('At 16:16 hold 77777 gold.')).unverified).toEqual([{ kind: 'time', text: '16:16' }, { kind: 'number', text: '77777' }]);
  });

  it('the repair round runs on what is left of the turn\'s budget', async () => {
    const trace = await createFileTraceStore(dir).get(MATCH);
    let lookups = 0; let turn = 0;
    const six = Array.from({ length: 6 }, (_, i) => call('hero_abilities', { hero: 'beastmaster' }, `h${i}`));
    const offered: number[] = [];
    const complete = async (o: any) => { turn += 1; offered.push(o.tools.length); const last = o.messages.at(-1); if (last.role === 'user' && String(last.content).startsWith('These are not in')) return { text: 'ok.', toolCalls: six }; if (last.role === 'tool') return { text: 'You died at 19:19.' }; return { toolCalls: six }; };
    const r = await runChat({ complete, trace, hero: 'beastmaster', question: 'q', onEvent: (e: any) => { if (e.type === 'tool_start') lookups += 1; } });
    // Six lookups in the turn, none more in the repair: it is offered no tools and must answer.
    expect(lookups).toBe(6);
    expect(r).toMatchObject({ status: 'ok', text: 'ok.' });
    expect(turn).toBe(3);
    // Turn 1 has every tool; turn 2 (budget spent) and the repair have none.
    expect(offered.slice(1)).toEqual([0, 0]);
  });

  it('validates the request body', () => {
    expect(parseChatBody({ question: ' hi ', hero: 'axe', lang: 'zh', history: [{ q: 'a', a: 'b' }, { q: 1 }, { q: '', a: 'x' }, { q: 'c', a: 'd', clean: true }, { q: 'e', a: 'f', clean: 'yes' }] })).toEqual({ question: 'hi', hero: 'axe', lang: 'zh', history: [{ q: 'a', a: 'b', clean: false }, { q: 'c', a: 'd', clean: true }, { q: 'e', a: 'f', clean: false }] });
    expect(parseChatBody({ question: 'x', hero: 'axe', history: Array.from({ length: 9 }, (_, i) => ({ q: `q${i}`, a: 'a' })) }).history).toHaveLength(6);
    expect([parseChatBody({}), parseChatBody({ question: 'x'.repeat(501), hero: 'a' }), parseChatBody({ question: 'x' })].map((r: any) => r.error)).toEqual(['empty_question', 'question_too_long', 'invalid_hero']);
  });
});

describe('what the check removed is kept beside the review', () => {
  it('the dropped finding and the reasons are saved, and not sent to the reader', async () => {
    const madeUp = { title: '打钱', claim: '你 19:19 的经济只有 9,876。', evidence: [{ refs: ['fight:99'], fact: '落后 4.2k' }], fix: '多刷野。' };
    const complete = async (o: any) => (o.messages.at(-1).role === 'user'
      ? { toolCalls: [call('ability_audit', { hero: 'beastmaster', ability: 'primal_roar' }, 'a'), call('immunity_windows', { hero: 'phantom_assassin' }, 'b')] }
      : { toolCalls: [call('submit_review', { ...submit, findings: [finding, madeUp] }, 's')] });
    const reviewDir = join(dir, 'kept');
    const service: any = createAgentService({ traces: createFileTraceStore(dir), complete, model: 'm', reviewDir });
    expect(await service.start(MATCH, 'beastmaster', 'en')).toMatchObject({ status: 'running' });
    let now: any;
    await vi.waitFor(async () => { now = await service.status(MATCH, 'beastmaster', 'en'); expect(now.status).toBe('ready'); }, { timeout: 5000 });
    expect(now.verification).toEqual({ repaired: true, dropped: 1 });
    expect(now.review.findings).toHaveLength(1);
    const file = readdirSync(reviewDir).find((f) => f.endsWith('.unverified.json'))!;
    const kept = JSON.parse(readFileSync(join(reviewDir, file), 'utf8'));
    expect(kept.dropped_findings).toEqual([madeUp]);
    expect(kept.problems).toContainEqual({ where: 'finding', index: 1, kind: 'ref', text: 'fight:99' });
    expect(kept.status).toBe('ok');
    // A review the check rejected whole leaves the same record: that is when it is needed most.
    const none = join(dir, 'none');
    const all: any = createAgentService({ traces: createFileTraceStore(dir), complete: async (o: any) => (o.messages.at(-1).role === 'user' ? { toolCalls: [call('ability_audit', { hero: 'beastmaster', ability: 'primal_roar' }, 'a')] } : { toolCalls: [call('submit_review', { ...submit, findings: [madeUp] }, 's')] }), model: 'm', reviewDir: none });
    await all.start(MATCH, 'beastmaster', 'en');
    await vi.waitFor(async () => expect((await all.status(MATCH, 'beastmaster', 'en')).status).toBe('failed'), { timeout: 5000 });
    const lost = JSON.parse(readFileSync(join(none, readdirSync(none).find((f) => f.endsWith('.unverified.json'))!), 'utf8'));
    expect(lost).toMatchObject({ status: 'unverified', dropped_findings: [madeUp] });
    // A review with nothing wrong leaves no such file.
    const clean = join(dir, 'clean');
    const ok: any = createAgentService({ traces: createFileTraceStore(dir), complete: model().complete, model: 'm', reviewDir: clean });
    await ok.start(MATCH, 'beastmaster', 'en');
    await vi.waitFor(async () => expect((await ok.status(MATCH, 'beastmaster', 'en')).status).toBe('ready'), { timeout: 5000 });
    expect(readdirSync(clean).some((f) => f.endsWith('.unverified.json'))).toBe(false);
    expect(existsSync(clean)).toBe(true);
  });
});

describe('agent API', () => {
  let server: any; let base = '';
  const m = model();
  const reviewDir = join(dir, 'reviews');
  let budget = { ok: true } as any;
  let guardOk = true;
  beforeAll(async () => {
    const service = createAgentService({ traces: createFileTraceStore(dir), complete: m.complete, model: 'test-model', reviewDir, getMatchDetail: async () => { throw new Error('upstream down'); } });
    const app = express();
    app.use(express.json());
    app.use(createAgentRouter({ service, resolveClientIp: (req: any) => String(req.headers['x-test-ip'] ?? '10.0.0.1'), llm: { acquire: () => budget }, guard: () => (guardOk ? { ok: true } : { ok: false, status: 403, error: 'Cross-origin' }) }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));
  const get = async (path: string) => { const r = await fetch(base + path); return { status: r.status, body: await r.json() }; };
  const post = async (path: string, body: any, ip = '10.0.0.1') => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-ip': ip }, body: JSON.stringify(body) }); return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }; };
  const frames = (sse: string) => sse.split('\n\n').filter(Boolean).map((f) => JSON.parse(f.replace(/^data: /, '')));

  it('says whether a replay trace exists and for which heroes', async () => {
    const a = await get(`/api/agent/${MATCH}`);
    expect(a.body).toMatchObject({ trace: true, model_configured: true, can_parse: false });
    expect(a.body.heroes).toContainEqual({ hero: 'beastmaster', team: 'dire', hero_id: 38, en: 'Beastmaster', zh: '兽王' });
    expect((await get('/api/agent/999')).body).toEqual({ trace: false, model_configured: true, can_parse: false, heroes: [], parse: { status: 'none' } });
    // Without a pipeline nothing can be parsed, and the answer says so.
    expect(await post('/api/agent/999/prepare', {})).toMatchObject({ status: 503, body: { status: 'unavailable' } });
    expect(await post(`/api/agent/${MATCH}/prepare`, {})).toMatchObject({ status: 200, body: { status: 'ready' } });
    expect((await get('/api/agent/abc')).status).toBe(400);
  });

  it('review: none → start (202) → ready, kept on disk; a second start spends nothing', async () => {
    expect((await get(`/api/agent/${MATCH}/review?hero=beastmaster&lang=zh`)).body).toEqual({ status: 'none' });
    const started = await post(`/api/agent/${MATCH}/review`, { hero: 'beastmaster', lang: 'zh' });
    expect(started).toMatchObject({ status: 202, body: { status: 'running' } });
    let now: any;
    for (let i = 0; i < 50; i += 1) { now = (await get(`/api/agent/${MATCH}/review?hero=beastmaster&lang=zh`)).body; if (now.status === 'ready') break; await new Promise((r) => setTimeout(r, 20)); }
    expect(now).toMatchObject({ status: 'ready', model: 'test-model', tool_calls: 2, verification: { repaired: false, dropped: 0 }, review: { schema: 'dota2.ai/deep-review@1', hero: 'beastmaster', lang: 'zh', verdict: submit.verdict } });
    expect(now.review.findings[0].evidence[0]).toEqual({ refs: ['cast:beastmaster:primal_roar:6'], clock: '27:27', fact: finding.evidence[0].fact });
    expect(readdirSync(reviewDir).sort()).toEqual([expect.stringMatching(/^9100904020\.beastmaster\.zh\.p\d+\.job\.json$/), expect.stringMatching(/^9100904020\.beastmaster\.zh\.p\d+\.review\.json$/)]);
    const calls = m.seen.length;
    budget = { ok: false, reason: 'client', retryAfterSec: 9 };
    expect(await post(`/api/agent/${MATCH}/review`, { hero: 'beastmaster', lang: 'zh' })).toMatchObject({ status: 200, body: { status: 'ready' } });
    budget = { ok: true };
    expect(m.seen.length).toBe(calls);
    // Another language is another review.
    expect((await get(`/api/agent/${MATCH}/review?hero=beastmaster&lang=en`)).body).toEqual({ status: 'none' });
  });

  it('review: bad input, missing trace, limits and the guard', async () => {
    expect((await get(`/api/agent/${MATCH}/review`)).status).toBe(400);
    expect(await get(`/api/agent/${MATCH}/review?hero=pudge`)).toMatchObject({ body: { status: 'unknown_hero' } });
    expect(await post('/api/agent/999/review', { hero: 'axe' })).toMatchObject({ status: 404, body: { status: 'no_trace' } });
    expect((await post(`/api/agent/${MATCH}/review`, { hero: 'x;y' })).status).toBe(400);
    budget = { ok: false, reason: 'cost_guard' };
    expect(await post(`/api/agent/${MATCH}/review`, { hero: 'axe' }, '10.0.0.7')).toMatchObject({ status: 503, body: { code: 'busy' } });
    budget = { ok: true };
    guardOk = false;
    expect((await post(`/api/agent/${MATCH}/review`, { hero: 'axe' })).status).toBe(403);
    expect((await post(`/api/agent/${MATCH}/chat`, { hero: 'beastmaster', question: 'q' })).status).toBe(403);
    guardOk = true;
    // Five starts per caller per ten minutes.
    const statuses = [];
    for (const [hero, lang] of [['axe', 'en'], ['sven', 'en'], ['mirana', 'en'], ['undying', 'en'], ['necrolyte', 'zh'], ['venomancer', 'zh']]) statuses.push((await post(`/api/agent/${MATCH}/review`, { hero, lang }, '10.0.0.9')).status);
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
  });

  it('evidence: the record behind a ref, recomputed from the replay, with display names', async () => {
    const ev = (ref: string, lang = 'zh') => get(`/api/agent/${MATCH}/evidence?hero=beastmaster&lang=${lang}&ref=${encodeURIComponent(ref)}`);
    const cast = (await ev('cast:beastmaster:primal_roar:6')).body;
    expect(cast).toMatchObject({ status: 'ok', kind: 'cast', record: { clock: '27:27', target: 'phantom_assassin', target_spell_immune: true, target_stunned_seconds: 3.4 }, names: { phantom_assassin: '幻影刺客' } });
    const death = (await ev('death:beastmaster:9', 'en')).body;
    expect(death).toMatchObject({ kind: 'death', record: { clock: '36:05', killer: 'necrolyte' }, names: { necrolyte: 'Necrophos', beastmaster_primal_roar: 'Primal Roar', pipe: 'Pipe of Insight', modifier_necrolyte_reapers_scythe: "Reaper's Scythe" } });
    expect(death.record).not.toHaveProperty('gaps');
    // An immunity window comes with where the player's ultimate was.
    expect((await ev('immune:phantom_assassin:3:beastmaster-primal_roar')).body.record).toMatchObject({ clock: '30:34', watched: { state: 'on_cooldown', last_cast: { target: 'necrolyte' } } });
    // The same window watched for another ability shows that ability, and without a watch shows none.
    expect((await ev('immune:phantom_assassin:3:beastmaster-wild_axes')).body.record.watched).toMatchObject({ state: 'ready' });
    expect((await ev('immune:phantom_assassin:3')).body.record).not.toHaveProperty('watched');
    expect((await ev('immune:phantom_assassin:3:nonsense')).status).toBe(404);
    expect((await ev('fight:11')).body.record).toMatchObject({ my_team_deaths: 5, enemy_deaths: 3 });
    expect((await ev('timeline:1805-1860')).body.record.events.length).toBeGreaterThan(10);
    expect((await ev('item:phantom_assassin:black_king_bar')).body.record.first_held.clock).toBe('21:29');
    expect((await ev('overview')).body.record).toMatchObject({ result: 'my_team_lost', fights_total: 16 });
    // The fixture game is 7.42's: the pro items are those of 7.42's own pro games.
    const pro = (await ev('pro_items:beastmaster')).body.record.mid_game_items;
    expect(pro.played_on_releases).toEqual(['7.42']);
    expect(pro.items[0].item).toBe(proItemsFor(38, patchData('7.42'))!.items[0][0]);
    // A death looked at with a wider window is shown with that window, not the default one.
    const narrow = (await ev('death:beastmaster:2')).body.record; const wide = (await ev('death:beastmaster:2:w30')).body.record;
    expect([narrow.snapshots[0].dt, wide.snapshots[0].dt]).toEqual([-12, -30]);
    expect(wide.ref).toBe('death:beastmaster:2:w30');
    expect((await ev('death:beastmaster:2:w999')).status).toBe(404);
    // A tool's summary ref shows its totals, not the records listed below them.
    const audit = (await ev('audit:beastmaster:primal_roar')).body;
    expect(audit).toMatchObject({ kind: 'audit', record: { casts_total: 10, by_target: { phantom_assassin: 4 }, casts_on_spell_immune_target: 2 } });
    expect(audit.record).not.toHaveProperty('casts');
    expect((await ev('deaths:beastmaster')).body.record).toMatchObject({ deaths_total: 11, killed_by: { phantom_assassin: 7 } });
    // A summary over another window resolves to that window's counts, not the default's.
    expect((await ev('deaths:beastmaster')).body.record).toMatchObject({ window: 12, damage_in_death_windows_total: 23757 });
    expect((await ev('deaths:beastmaster:w4')).body.record).toMatchObject({ ref: 'deaths:beastmaster:w4', window: 4, damage_in_death_windows_total: 18106 });
    expect((await ev('deaths:beastmaster:nope')).status).toBe(404);
    expect((await ev('immunity:phantom_assassin')).body.record).toMatchObject({ windows_total: 7 });
    // With what was watched, the totals that back "her BKB opened with the roar on cooldown three times" are shown too.
    expect((await ev('immunity:phantom_assassin:beastmaster:primal_roar')).body.record).toMatchObject({ windows_total: 7, watched_state_when_window_opened: { on_cooldown: 3, ready: 3, dead: 1 }, windows_with_a_cast_on_the_immune_hero: 2 });
    for (const bad of ['cast:beastmaster:primal_roar:99', 'death:beastmaster:0', 'nope:1', 'timeline:0-99999', '../etc', 'death:pudge:1']) expect((await ev(bad)).status).toBe(404);
    expect((await get(`/api/agent/${MATCH}/evidence?hero=beastmaster`)).status).toBe(400);
    expect((await get('/api/agent/999/evidence?hero=axe&ref=overview')).status).toBe(404);
  });

  it('moment: where the ten heroes were around a game time, with display names; a bad time or hero is refused', async () => {
    const at = (q: string) => get(`/api/agent/${MATCH}/moment?${q}`);
    const m = (await at('hero=beastmaster&lang=zh&t=1825')).body;
    expect(m).toMatchObject({ status: 'ok', t: 1825, clock: '30:25', from: 1813, to: 1831, me: 'beastmaster', names: { beastmaster: '兽王', phantom_assassin: '幻影刺客' } });
    expect(m.frames).toHaveLength(19);
    expect(m.heroes.filter((h: any) => h.side === 'me')).toEqual([{ hero: 'beastmaster', side: 'me' }]);
    expect((await at('hero=beastmaster&lang=en&t=1825')).body.names.phantom_assassin).toBe('Phantom Assassin');
    // Each hero's icon name is the game's own, which is not always the replay's key.
    expect(m.icons).toMatchObject({ beastmaster: 'beastmaster', phantom_assassin: 'phantom_assassin', necrolyte: 'necrolyte' });
    expect(Object.keys(m.icons)).toHaveLength(10);
    // What is asked must be a hero and a game time in seconds.
    for (const bad of ['hero=beastmaster', 'hero=beastmaster&t=abc', 'hero=beastmaster&t=1e3', 't=1825', 'hero=beastmaster&t=1825&t=1830']) expect((await at(bad)).status).toBe(400);
    expect((await at('hero=beastmaster&t=99999')).status).toBe(404);
    expect((await at('hero=pudge&t=1825')).status).toBe(404);
    expect((await get('/api/agent/999/moment?hero=axe&t=10')).status).toBe(404);
  });

  it('two starts arriving together are one job; a refused model budget uses up no review slot', async () => {
    const before = m.seen.length;
    const [a, b] = await Promise.all([post(`/api/agent/${MATCH}/review`, { hero: 'dark_willow', lang: 'en' }, '10.0.1.1'), post(`/api/agent/${MATCH}/review`, { hero: 'dark_willow', lang: 'en' }, '10.0.1.2')]);
    expect([a.body.status, b.body.status]).toEqual(['running', 'running']);
    let now: any;
    for (let i = 0; i < 50; i += 1) { now = (await get(`/api/agent/${MATCH}/review?hero=dark_willow&lang=en`)).body; if (now.status !== 'running') break; await new Promise((r) => setTimeout(r, 20)); }
    // One investigation: two model calls (look up, submit), not four.
    expect(m.seen.length - before).toBe(2);
    // The model budget says no five times; the caller's five review slots are all still there afterwards.
    const six = [['necrolyte', 'en'], ['venomancer', 'en'], ['skywrath_mage', 'en'], ['phantom_assassin', 'en'], ['mirana', 'zh'], ['undying', 'zh']];
    budget = { ok: false, reason: 'client', retryAfterSec: 5 };
    for (const [hero, lang] of six.slice(0, 5)) expect((await post(`/api/agent/${MATCH}/review`, { hero, lang }, '10.0.1.9')).status).toBe(429);
    budget = { ok: true };
    const statuses = [];
    for (const [hero, lang] of six) statuses.push((await post(`/api/agent/${MATCH}/review`, { hero, lang }, '10.0.1.9')).status);
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
  });

  it('a request that cannot be served, or is refused, reserves nothing', async () => {
    let acquired = 0;
    const counting = express();
    counting.use(express.json());
    const service = createAgentService({ traces: createFileTraceStore(dir), complete: m.complete, model: 'test-model' });
    counting.use(createAgentRouter({ service, resolveClientIp: (req: any) => String(req.headers['x-test-ip'] ?? '10.9.0.1'), llm: { acquire: () => { acquired += 1; return budget; } } }));
    const srv = counting.listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const at = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const send = (path: string, body: any, ip = '10.9.0.1') => fetch(at + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-ip': ip }, body: JSON.stringify(body) });
    try {
      // No trace, or a hero not in the game: the model budget is never touched.
      for (let i = 0; i < 30; i += 1) await send('/api/agent/999/chat', { hero: 'axe', question: 'q' });
      await send(`/api/agent/${MATCH}/chat`, { hero: 'pudge', question: 'q' });
      await send('/api/agent/999/review', { hero: 'axe' });
      expect(acquired).toBe(0);
      // Twelve chat turns a minute per caller: the thirteenth is refused without taking model budget.
      for (let i = 0; i < 12; i += 1) expect((await send(`/api/agent/${MATCH}/chat`, { hero: 'beastmaster', question: 'q' }, '10.9.0.2')).status).toBe(200);
      expect(acquired).toBe(12);
      expect((await send(`/api/agent/${MATCH}/chat`, { hero: 'beastmaster', question: 'q' }, '10.9.0.2')).status).toBe(429);
      expect(acquired).toBe(12);
      // The model budget says no: the caller's chat slots are untouched (twelve still go through afterwards).
      budget = { ok: false, reason: 'client', retryAfterSec: 5 };
      for (let i = 0; i < 5; i += 1) expect((await send(`/api/agent/${MATCH}/chat`, { hero: 'beastmaster', question: 'q' }, '10.9.0.3')).status).toBe(429);
      budget = { ok: true };
      for (let i = 0; i < 12; i += 1) expect((await send(`/api/agent/${MATCH}/chat`, { hero: 'beastmaster', question: 'q' }, '10.9.0.3')).status).toBe(200);
    } finally { budget = { ok: true }; await new Promise((r) => srv.close(r)); }
  });

  it('sixty requests for the same review at once are one job and one charge', async () => {
    let acquired = 0;
    const app2 = express();
    app2.use(express.json());
    // Every request must be past its status check before any job exists, or a late one is told "running" (200)
    // and never reaches the shared start. Waiting a fixed time, or for all sixty to arrive, does not make that so
    // on a busy machine: the check reads the disk, and a fast request can start the job while a slow one is still
    // reading. So no request is given its answer until all sixty have theirs.
    const slow = createFileTraceStore(dir);
    // Read and parsed once, then handed out after the same delay: after the check the sixty move together, and
    // the one that begins the job waits on a timer set after everyone else's.
    const loaded = new Map<string, Promise<any>>();
    const once = (id: any) => { const k = String(id); if (!loaded.has(k)) loaded.set(k, slow.get(id)); return loaded.get(k)!; };
    const traces = { get: async (id: any) => { await new Promise((r) => setTimeout(r, 30)); return once(id); } };
    const real = createAgentService({ traces, complete: m.complete, model: 'test-model' });
    let checked = 0; let open!: () => void;
    const allChecked = new Promise<void>((r) => { open = r; });
    const gated = { ...real, status: async (...a: [any, any, any]) => { const out = await real.status(...a); checked += 1; if (checked >= 60) open(); await allChecked; return out; } };
    app2.use(createAgentRouter({ service: gated, resolveClientIp: (req: any) => String(req.headers['x-test-ip']), llm: { acquire: () => { acquired += 1; return { ok: true }; } } }));
    const srv = app2.listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const at = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const send = (hero: string, ip: string) => fetch(`${at}/api/agent/${MATCH}/review`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-ip': ip }, body: JSON.stringify({ hero, lang: 'en' }) });
    try {
      const all = await Promise.all(Array.from({ length: 60 }, (_, i) => send('sven', `10.7.0.${i}`)));
      expect(all.every((r) => r.status === 202)).toBe(true);
      expect(acquired).toBe(1);
      // A refused start is refused to everyone who shared it, each on their own response.
      const refusing = express();
      refusing.use(express.json());
      refusing.use(createAgentRouter({ service: createAgentService({ traces, complete: m.complete, model: 'test-model' }), resolveClientIp: (req: any) => String(req.headers['x-test-ip']), llm: { acquire: () => ({ ok: false, reason: 'cost_guard' }) } }));
      const srv2 = refusing.listen(0, '127.0.0.1');
      await new Promise((r) => srv2.once('listening', r));
      const at2 = `http://127.0.0.1:${(srv2.address() as AddressInfo).port}`;
      const two = await Promise.all(['10.7.2.1', '10.7.2.2'].map((ip) => fetch(`${at2}/api/agent/${MATCH}/review`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-ip': ip }, body: JSON.stringify({ hero: 'sven', lang: 'en' }), signal: AbortSignal.timeout(5000) })));
      expect(two.map((r) => r.status)).toEqual([503, 503]);
      expect(await two[1].json()).toMatchObject({ code: 'busy' });
      await new Promise((r) => srv2.close(r));
      // The hour's sixty slots are not gone: another hero's review still starts.
      expect((await send('mirana', '10.7.1.1')).status).toBe(202);
      expect(acquired).toBe(2);
    } finally { await new Promise((r) => srv.close(r)); }
  });

  it('a caller who leaves while the trace is being read is neither admitted nor investigated for', async () => {
    let acquired = 0; let chats = 0; let release: any;
    const app3 = express();
    app3.use(express.json());
    const service: any = { availability: () => new Promise((r) => { release = () => r({ trace: true, model_configured: true, heroes: [{ hero: 'beastmaster' }] }); }), chat: async () => { chats += 1; return { status: 'ok', text: 'x', unverified: [] }; } };
    app3.use(createAgentRouter({ service, resolveClientIp: () => '10.8.0.1', llm: { acquire: () => { acquired += 1; return { ok: true }; } } }));
    const srv = app3.listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const ac = new AbortController();
    const pending = fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/agent/${MATCH}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hero: 'beastmaster', question: 'q' }), signal: ac.signal }).catch(() => null);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    ac.abort(); await pending;
    await new Promise((r) => setTimeout(r, 50));
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect([acquired, chats]).toEqual([0, 0]);
    await new Promise((r) => srv.close(r));
  });

  it('chat: streams the tool steps, then the checked answer', async () => {
    const r = await post(`/api/agent/${MATCH}/chat`, { hero: 'beastmaster', lang: 'zh', question: '36 分钟那次我怎么死的？' });
    expect(r.status).toBe(200);
    expect(frames(r.body as string)).toEqual([{ step: { tool: 'death_context', args: { hero: 'beastmaster', index: 9 } } }, { text: '36:05 你满血 2915，被 斧王 先手。' }, { done: true }]);
    // The finished review travels with the question.
    expect(m.seen.at(-2).messages[0].content).toContain('"verdict":"咆哮没有留给幻影刺客。"');
    const flagged = frames((await post(`/api/agent/${MATCH}/chat`, { hero: 'beastmaster', lang: 'zh', question: '编一个' })).body as string);
    expect(flagged[0]).toMatchObject({ text: '36:05 你被先手。' });
    expect(frames((await post('/api/agent/999/chat', { hero: 'axe', question: 'q' })).body as string)).toEqual([{ error: 'no_trace' }, { done: true }]);
    expect((await post(`/api/agent/${MATCH}/chat`, { hero: 'beastmaster' })).status).toBe(400);
  });
});
