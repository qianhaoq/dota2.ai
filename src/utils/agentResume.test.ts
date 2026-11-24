import { afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { runAgent } from '../../lib/agent/loop.js';
import { runDeepReview } from '../../lib/agent/deepReview.js';
import { createAgentService } from '../../lib/agent/service.js';
import { createBucketStore, createFileStore, createJsonStore } from '../../lib/agent/stores.js';

const fixture = gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url)));
const trace = () => JSON.parse(fixture.toString());
const ID = 9100904020;
const call = (name: string, args: any, id: string) => ({ id, name, args });
const finding = { title: '咆哮', claim: '幻影刺客开了 7 次黑皇杖。', evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 吼进黑皇杖，定住 3.4 秒' }], fix: '留给她。' };
const good = { verdict: '咆哮没有留给幻影刺客。', mainline: [], findings: [finding], next_game: ['留咆哮'], blind_spots: ['视野'] };
/** States a time no tool gave: the check sends it back for one repair round. */
const bad = { ...good, verdict: '你在 19:19 死了，咆哮没有留给幻影刺客。' };
const CUT = new Error('cut off');

/**
 * A model that acts on where the conversation is, not on how often it was asked, so it behaves the same
 * when a conversation is handed to it half way: turn 1 one lookup, turn 2 another, turn 3 the review
 * (`script.submit`), then — if that was sent back — one more lookup and the corrected review.
 * `cutAt`: the turn (1-based, by position in the conversation) at which the run is cut off.
 */
function model(script: { submit?: any; cutAt?: number } = {}) {
  const m: any = { turns: [] as number[], opened: [] as number[], usage: { input: 100, output: 10 } };
  m.complete = async (o: any) => {
    const turn = o.messages.filter((x: any) => x.role === 'assistant').length + 1;
    m.turns.push(turn); m.opened.push(o.messages.length);
    if (turn === script.cutAt) throw CUT;
    const reply = (toolCalls: any[]) => ({ toolCalls, usage: m.usage });
    if (turn === 1) return reply([call('ability_audit', { hero: 'beastmaster', ability: 'primal_roar' }, 'a')]);
    if (turn === 2) return reply([call('immunity_windows', { hero: 'phantom_assassin' }, 'b')]);
    if (turn === 3) return reply([call('submit_review', script.submit ?? good, 's')]);
    if (turn === 4) return reply([call('death_context', { hero: 'beastmaster', index: 9 }, 'd')]);
    return reply([call('submit_review', good, 's2')]);
  };
  return m;
}
/** What a store does to a checkpoint: only JSON survives. */
const stored = (c: any) => JSON.parse(JSON.stringify(c));

describe('runAgent: a run can be picked up after its last finished round', () => {
  const tools = [{ name: 'look', description: '', input_schema: {} }, { name: 'done', description: '', input_schema: {} }];
  const script = (messages: any[]) => {
    const n = messages.filter((x: any) => x.role === 'assistant').length;
    return n < 2 ? { toolCalls: [call('look', { n }, `c${n}`)], usage: { input: 10, output: 1 } } : { toolCalls: [call('done', { ok: true }, 'f')], usage: { input: 10, output: 1 } };
  };
  const base = { system: 's', tools, runTool: async (_n: string, a: any) => ({ saw: a.n }), isFinal: (c: any) => c.name === 'done' };

  it('tells the state after every round, and continues from one with the counts it had', async () => {
    const points: any[] = [];
    const whole = await runAgent({ ...base, complete: async (o: any) => script(o.messages), messages: [{ role: 'user', content: 'q' }], onCheckpoint: (s: any) => points.push(stored(s)) });
    expect(whole).toMatchObject({ status: 'final', final: { ok: true }, steps: 3, usage: { input: 30, output: 3 } });
    expect(points.map((p) => [p.steps, p.calls, p.messages.length, p.transcript.length])).toEqual([[1, 1, 3, 1], [2, 2, 5, 2]]);
    // Picked up after the first round: one lookup is not asked for again, and the totals are those of the whole run.
    const seen: number[] = [];
    const rest = await runAgent({ ...base, complete: async (o: any) => { seen.push(o.messages.length); return script(o.messages); }, messages: points[0].messages, resume: { steps: points[0].steps, calls: points[0].calls, usage: points[0].usage, transcript: points[0].transcript } });
    expect(seen).toEqual([3, 5]);
    expect(rest).toMatchObject({ status: 'final', final: { ok: true }, steps: 3, usage: { input: 30, output: 3 } });
    expect(rest.transcript).toEqual(whole.transcript);
    expect(rest.messages).toEqual(whole.messages);
  });

  it('the lookup budget counts what was used before the cut', async () => {
    const out = await runAgent({ ...base, maxToolCalls: 1, finalTools: ['done'], complete: async (o: any) => ({ toolCalls: o.tools.some((t: any) => t.name === 'look') ? [call('look', { n: 9 }, 'x')] : [call('done', { ok: true }, 'f')] }), messages: [{ role: 'user', content: 'q' }], resume: { steps: 1, calls: 1, usage: { input: 0, output: 0 }, transcript: [] } });
    // Already spent: the model is offered only the tool that ends the run.
    expect(out).toMatchObject({ status: 'final', transcript: [] });
  });
});

describe('runDeepReview: continued from a checkpoint', () => {
  it('a review cut off before it was handed in continues after its last lookup, and comes out the same', async () => {
    const whole: any = await runDeepReview({ complete: model().complete, trace: trace(), hero: 'beastmaster', lang: 'zh' });
    expect(whole.status).toBe('ok');

    const points: any[] = [];
    const cut = model({ cutAt: 3 });
    await expect(runDeepReview({ complete: cut.complete, trace: trace(), hero: 'beastmaster', lang: 'zh', onCheckpoint: (c: any) => points.push(stored(c)) })).rejects.toBe(CUT);
    expect(points).toHaveLength(2);
    expect(points[1]).toMatchObject({ v: 1, first: null, run: { steps: 2, tool_count: 2, calls: [{ name: 'ability_audit' }, { name: 'immunity_windows' }] } });
    // What the tools answered is not in it beyond the conversation itself.
    expect(points[1].run.calls[0]).toEqual({ name: 'ability_audit', args: { hero: 'beastmaster', ability: 'primal_roar' } });

    const next = model();
    const events: any[] = [];
    const resumed: any = await runDeepReview({ complete: next.complete, trace: trace(), hero: 'beastmaster', lang: 'zh', checkpoint: points[1], onEvent: (e: any) => events.push(e) });
    // One model turn instead of three; the two lookups were not made again as far as the model is concerned.
    expect(next.turns).toEqual([3]);
    expect(events[0]).toEqual({ type: 'resumed', tools: points[1].run.calls });
    expect(events.filter((e) => e.type === 'tool_start')).toEqual([]);
    expect(resumed.status).toBe('ok');
    // The evidence still checks out: the lookups' answers were computed again from the replay.
    expect(resumed.review).toEqual(whole.review);
    expect(resumed.tool_calls).toEqual(whole.tool_calls);
    expect(resumed.verification).toEqual(whole.verification);
    expect(resumed.steps).toBe(3);
    expect(resumed.usage).toEqual({ input: 300, output: 30 });
  });

  it('cut off during the repair round: the first pass is not asked for again', async () => {
    const whole: any = await runDeepReview({ complete: model({ submit: bad }).complete, trace: trace(), hero: 'beastmaster', lang: 'zh' });
    expect(whole).toMatchObject({ status: 'ok', verification: { repaired: true } });

    // Cut while the model was thinking about the correction: only the handed-in first pass is saved.
    const p4: any[] = [];
    await expect(runDeepReview({ complete: model({ submit: bad, cutAt: 4 }).complete, trace: trace(), hero: 'beastmaster', lang: 'zh', onCheckpoint: (c: any) => p4.push(stored(c)) })).rejects.toBe(CUT);
    expect(p4.at(-1)).toMatchObject({ first: { steps: 3 }, run: null });
    const after4 = model({ submit: bad });
    const r4: any = await runDeepReview({ complete: after4.complete, trace: trace(), hero: 'beastmaster', lang: 'zh', checkpoint: p4.at(-1) });
    expect(after4.turns).toEqual([4, 5]);
    expect(r4.review).toEqual(whole.review);
    expect(r4.verification).toEqual(whole.verification);

    // Cut one turn later, after the repair's own lookup.
    const p5: any[] = [];
    await expect(runDeepReview({ complete: model({ submit: bad, cutAt: 5 }).complete, trace: trace(), hero: 'beastmaster', lang: 'zh', onCheckpoint: (c: any) => p5.push(stored(c)) })).rejects.toBe(CUT);
    expect(p5.at(-1)).toMatchObject({ first: { steps: 3 }, run: { steps: 1, tool_count: 1, calls: [{ name: 'death_context' }] } });
    const after5 = model({ submit: bad });
    const r5: any = await runDeepReview({ complete: after5.complete, trace: trace(), hero: 'beastmaster', lang: 'zh', checkpoint: p5.at(-1) });
    expect(after5.turns).toEqual([5]);
    expect(r5.review).toEqual(whole.review);
    expect(r5.tool_calls).toEqual(whole.tool_calls);
    expect(r5.steps).toBe(whole.steps);
    expect(r5.usage).toEqual(whole.usage);
  });

  it('a lookup asked for in the same turn as the review is handed in is not run, and does not unsettle a later checkpoint', async () => {
    // Turn 3 hands the (unsupported) review in together with one more lookup: the loop takes the review and runs nothing.
    const withExtra = (cutAt?: number) => {
      const m = model({ submit: bad, cutAt });
      const inner = m.complete;
      m.complete = async (o: any) => { const r = await inner(o); if (r.toolCalls?.[0]?.id === 's') r.toolCalls.unshift(call('match_overview', {}, 'x')); return r; };
      return m;
    };
    const whole: any = await runDeepReview({ complete: withExtra().complete, trace: trace(), hero: 'beastmaster', lang: 'zh' });
    expect(whole).toMatchObject({ status: 'ok', verification: { repaired: true } });
    expect(whole.tool_calls.map((c: any) => c.name)).toEqual(['ability_audit', 'immunity_windows', 'death_context']);
    const points: any[] = [];
    await expect(runDeepReview({ complete: withExtra(5).complete, trace: trace(), hero: 'beastmaster', lang: 'zh', onCheckpoint: (c: any) => points.push(stored(c)) })).rejects.toBe(CUT);
    expect(points.at(-1).run.messages.some((x: any) => x.content === '{"error":"not_run"}')).toBe(true);
    const next = withExtra();
    const r: any = await runDeepReview({ complete: next.complete, trace: trace(), hero: 'beastmaster', lang: 'zh', checkpoint: points.at(-1) });
    expect(next.turns).toEqual([5]);
    expect(r.review).toEqual(whole.review);
  });

  it('a checkpoint that is not this game, hero and language, or is damaged, is ignored: the review starts over', async () => {
    const points: any[] = [];
    await expect(runDeepReview({ complete: model({ cutAt: 3 }).complete, trace: trace(), hero: 'beastmaster', lang: 'zh', onCheckpoint: (c: any) => points.push(stored(c)) })).rejects.toBe(CUT);
    const cp = points[1];
    const fresh = async (o: any) => { const m = model(); const events: any[] = []; const r: any = await runDeepReview({ complete: m.complete, trace: trace(), hero: 'beastmaster', lang: 'zh', onEvent: (e: any) => events.push(e), ...o }); expect(r.status).toBe('ok'); expect(events.some((e) => e.type === 'resumed')).toBe(false); return m.turns; };
    // Another seat, another language (the scripted review does not suit those; what matters is where the run began).
    for (const other of [{ hero: 'sven' }, { lang: 'en' }]) {
      const m = model(); const events: any[] = [];
      await runDeepReview({ complete: m.complete, trace: trace(), hero: 'beastmaster', lang: 'zh', checkpoint: cp, onEvent: (e: any) => events.push(e), ...other });
      expect(m.turns[0]).toBe(1);
      expect(m.opened[0]).toBe(1);
      expect(events.some((e) => e.type === 'resumed')).toBe(false);
    }
    // The replay was parsed again and a lookup now answers differently: the saved conversation is about another game.
    const reparsed = trace(); reparsed.casts = reparsed.casts.slice(0, 900);
    { const m = model(); const events: any[] = []; await runDeepReview({ complete: m.complete, trace: reparsed, hero: 'beastmaster', lang: 'zh', checkpoint: cp, onEvent: (e: any) => events.push(e) }); expect(m.turns[0]).toBe(1); expect(m.opened[0]).toBe(1); expect(events.some((e) => e.type === 'resumed')).toBe(false); }
    // Damaged or foreign.
    for (const broken of [null, {}, { v: 0 }, { ...cp, v: 2 }, { ...cp, run: null }, { ...cp, run: { ...cp.run, messages: [] } }, { ...cp, run: { ...cp.run, calls: [{}] } }, { ...cp, run: { ...cp.run, tool_count: 'x' } }, { ...cp, first: { ...cp.run } }, { ...cp, run: { ...cp.run, messages: [{ role: 'user', content: 'another opening' }, ...cp.run.messages.slice(1)] } }]) {
      expect(await fresh({ checkpoint: broken })).toEqual([1, 2, 3]);
    }
  });
});

describe('the service keeps a checkpoint while a review runs, and continues from it', () => {
  function world() {
    const blobs = new Map<string, any>();
    const docs = { get: async (k: string) => blobs.get(k) ?? null, put: async (k: string, v: any) => { blobs.set(k, stored(v)); } };
    const checkpoint = () => blobs.get([...blobs.keys()].find((k) => k.endsWith('.checkpoint.json'))!);
    return { blobs, docs, traces: { get: async () => trace() }, checkpoint };
  }
  const task = { kind: 'review', matchId: String(ID), hero: 'beastmaster', lang: 'zh' };
  /** Like `model`, but its third turn never answers: the instance is stopped while the model is thinking. */
  function hanging() {
    const m = model();
    const inner = m.complete;
    m.complete = (o: any) => (o.messages.filter((x: any) => x.role === 'assistant').length === 2 ? (m.turns.push(3), new Promise(() => {})) : inner(o));
    return m;
  }

  it('an instance is stopped mid-review: the next delivery makes one model turn, not three, and the reader sees the earlier lookups', async () => {
    const w = world();
    const first = hanging();
    const logA = vi.fn(); const logB = vi.fn();
    // The steps of the last "running" marker written, as another instance's status would report them.
    let shown: any[] = [];
    const put = w.docs.put;
    w.docs.put = async (k: string, v: any) => { if (k.endsWith('.job.json') && v.state === 'running' && v.runner) shown = v.steps; return put(k, v); };
    const a: any = createAgentService({ traces: w.traces, docs: w.docs, complete: first.complete, model: 'm1', log: logA });
    const running = a.run(task);
    await vi.waitFor(() => expect(w.checkpoint()?.run?.steps).toBe(2));
    expect(w.checkpoint()).toMatchObject({ v: 1, model: 'm1', first: null, run: { tool_count: 2 } });
    await a.shutdown();
    expect(await running).toEqual({ status: 'interrupted' });
    // Still there after the stop: it is what the next delivery continues from.
    expect(w.checkpoint()?.run?.steps).toBe(2);

    const second = model();
    const b: any = createAgentService({ traces: w.traces, docs: w.docs, complete: second.complete, model: 'm1', log: logB });
    const done = b.run(task);
    expect(await done).toEqual({ status: 'ready' });
    // While it ran, the reader was shown the lookups made before the stop (the marker every instance reads).
    expect(shown).toEqual([{ tool: 'ability_audit', args: { hero: 'beastmaster', ability: 'primal_roar' } }, { tool: 'immunity_windows', args: { hero: 'phantom_assassin' } }]);
    expect(second.turns).toEqual([3]);
    expect(logB).toHaveBeenCalledWith(expect.stringContaining('deep-review resumed'));
    const ready = await b.status(ID, 'beastmaster', 'zh');
    expect(ready).toMatchObject({ status: 'ready', tool_calls: 2, review: { verdict: good.verdict } });
    // The review is in: nothing is left to continue from.
    expect(w.checkpoint()).toEqual({ v: 0 });
  });

  it('a checkpoint still being written when the instance is stopped is waited for', async () => {
    const w = world();
    // A store that takes its time over checkpoints.
    const put = w.docs.put;
    let slow = 0;
    w.docs.put = async (k: string, v: any) => { if (k.endsWith('.checkpoint.json')) { slow += 1; await new Promise((r) => setTimeout(r, 60)); } return put(k, v); };
    const a: any = createAgentService({ traces: w.traces, docs: w.docs, complete: hanging().complete, model: 'm1' });
    const running = a.run(task);
    await vi.waitFor(() => expect(slow).toBeGreaterThan(0));
    expect(w.checkpoint()).toBeUndefined();
    await a.shutdown();
    await running;
    // Stopped, and what it had found out is in the store.
    expect(w.checkpoint()?.run?.steps).toBeGreaterThanOrEqual(1);
    const next = model();
    const b: any = createAgentService({ traces: w.traces, docs: w.docs, complete: next.complete, model: 'm1' });
    await vi.waitFor(() => expect(w.checkpoint()?.run?.steps).toBe(2));
    expect(await b.run(task)).toEqual({ status: 'ready' });
    expect(next.turns).toEqual([3]);
  });

  it('a review that fails leaves no checkpoint, and one from another model or from long ago is not used', async () => {
    const w = world();
    // Hands in nothing: failed, and the next try starts from the beginning.
    const quitter: any = createAgentService({ traces: w.traces, docs: w.docs, model: 'm1', complete: async (o: any) => (o.messages.some((x: any) => x.role === 'tool') ? { text: 'no review' } : { toolCalls: [call('match_overview', {}, 'a')] }) });
    expect(await quitter.run(task)).toEqual({ status: 'failed', reason: 'no_review' });
    expect(w.checkpoint()).toEqual({ v: 0 });

    // A checkpoint written by another model's run.
    const w2 = world();
    const clock = { t: 1_000_000 };
    const a: any = createAgentService({ traces: w2.traces, docs: w2.docs, complete: hanging().complete, model: 'm1', now: () => clock.t, beatMs: 2 ** 30 });
    const cut = a.run(task);
    await vi.waitFor(() => expect(w2.checkpoint()?.run?.steps).toBe(2));
    await a.shutdown(); await cut;
    const other = model();
    const b: any = createAgentService({ traces: w2.traces, docs: w2.docs, complete: other.complete, model: 'm2', now: () => clock.t });
    expect(await b.run(task)).toEqual({ status: 'ready' });
    expect(other.turns).toEqual([1, 2, 3]);

    // The same model, more than an hour later.
    const w3 = world();
    const c: any = createAgentService({ traces: w3.traces, docs: w3.docs, complete: hanging().complete, model: 'm1', now: () => clock.t, beatMs: 2 ** 30 });
    const cut3 = c.run(task);
    await vi.waitFor(() => expect(w3.checkpoint()?.run?.steps).toBe(2));
    await c.shutdown(); await cut3;
    const late = model();
    clock.t += 61 * 60_000;
    const d: any = createAgentService({ traces: w3.traces, docs: w3.docs, complete: late.complete, model: 'm1', now: () => clock.t });
    expect(await d.run(task)).toEqual({ status: 'ready' });
    expect(late.turns).toEqual([1, 2, 3]);
    // Within the hour it would have been used.
    const w4 = world();
    const e: any = createAgentService({ traces: w4.traces, docs: w4.docs, complete: hanging().complete, model: 'm1', now: () => clock.t, beatMs: 2 ** 30 });
    const cut4 = e.run(task);
    await vi.waitFor(() => expect(w4.checkpoint()?.run?.steps).toBe(2));
    await e.shutdown(); await cut4;
    const soon = model();
    clock.t += 59 * 60_000;
    const f: any = createAgentService({ traces: w4.traces, docs: w4.docs, complete: soon.complete, model: 'm1', now: () => clock.t });
    expect(await f.run(task)).toEqual({ status: 'ready' });
    expect(soon.turns).toEqual([3]);
  });

  it('on disk the checkpoint file is gone once the review is stored', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-resume-'));
    try {
      const svc: any = createAgentService({ traces: { get: async () => trace() }, reviewDir: dir, complete: model().complete, model: 'm1' });
      expect(await svc.run(task)).toEqual({ status: 'ready' });
      expect(readdirSync(dir).filter((f) => f.includes('checkpoint'))).toEqual([]);
      expect(readdirSync(dir).some((f) => f.endsWith('.review.json'))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('stores: delete', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-del-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it('a file store removes the file; removing what is not there, or a bad key, is not an error', async () => {
    const blobs = createFileStore(dir);
    await blobs.put('a.json', Buffer.from('{}'));
    expect(existsSync(join(dir, 'a.json'))).toBe(true);
    await blobs.delete('a.json');
    expect(existsSync(join(dir, 'a.json'))).toBe(false);
    await expect(blobs.delete('a.json')).resolves.toBeUndefined();
    await expect(blobs.delete('../x')).resolves.toBeUndefined();
    const json = createJsonStore(blobs);
    await json.put('b.json', { n: 1 });
    await json.delete('b.json');
    expect(await json.get('b.json')).toBeNull();
    // A blob store without delete: nothing happens, nothing throws.
    await expect(createJsonStore({ get: async () => null, put: async () => {} } as any).delete('b.json')).resolves.toBeUndefined();
    await expect(createJsonStore(null as any).delete('b.json')).resolves.toBeUndefined();
  });
  it('a bucket store deletes the object under its prefix, and a refusal is swallowed', async () => {
    const deleted: string[] = [];
    const bucket = { file: (key: string) => ({ delete: async () => { deleted.push(key); if (key.endsWith('no.json')) throw new Error('403'); } }) };
    const blobs = createBucketStore(bucket as any, 'agent/');
    await blobs.delete('x.json');
    await expect(blobs.delete('no.json')).resolves.toBeUndefined();
    await blobs.delete('../x');
    expect(deleted).toEqual(['agent/x.json', 'agent/no.json']);
  });
});
