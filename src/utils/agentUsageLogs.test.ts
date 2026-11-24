import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { createAgentRouter } from '../../lib/agent/router.js';
import { createAgentService } from '../../lib/agent/service.js';

const express = createRequire(import.meta.url)('express');
const trace = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());
const ID = 9100904020;
const call = (name: string, args: any, id: string) => ({ id, name, args });
const finding = { title: '咆哮', claim: '幻影刺客开了 7 次黑皇杖。', evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 吼进黑皇杖，定住 3.4 秒' }], fix: '留给她。' };
const submit = { verdict: '咆哮没有留给幻影刺客。', mainline: [], findings: [finding], next_game: ['留咆哮'], blind_spots: ['视野'] };
const complete = async (o: any) => {
  const last = o.messages.at(-1);
  if (!o.tools.some((t: any) => t.name === 'submit_review')) return last.role === 'tool' ? { text: '36:05 你满血 2915。' } : { toolCalls: [call('death_context', { hero: 'beastmaster', index: 9 }, 'd')] };
  return last.role === 'user' ? { toolCalls: [call('ability_audit', { hero: 'beastmaster', ability: 'primal_roar' }, 'a'), call('immunity_windows', { hero: 'phantom_assassin' }, 'b')] } : { toolCalls: [call('submit_review', submit, 's')] };
};
const until = async (f: () => Promise<any>, ok: (v: any) => boolean) => { let v: any; for (let i = 0; i < 100; i += 1) { v = await f(); if (ok(v)) return v; await new Promise((r) => setTimeout(r, 15)); } return v; };

describe('usage logs', () => {
  it('a review\'s lines say which plan it was made for, "none" when the player named none', async () => {
    const lines: string[] = [];
    const svc: any = createAgentService({ traces: { get: async () => trace }, complete, log: (m: string) => lines.push(m) });
    await svc.start(ID, 'beastmaster', 'zh', { plan: 'push' });
    await until(() => svc.status(ID, 'beastmaster', 'zh', 'push'), (s) => s.status === 'ready');
    await svc.start(ID, 'beastmaster', 'zh');
    await until(() => svc.status(ID, 'beastmaster', 'zh'), (s) => s.status === 'ready');
    const ready = lines.filter((l) => l.startsWith('deep-review ready'));
    expect(ready).toHaveLength(2);
    expect(ready[0]).toMatch(/^deep-review ready match=9100904020 hero=beastmaster plan=push steps=/);
    expect(ready[1]).toMatch(/^deep-review ready match=9100904020 hero=beastmaster plan=none steps=/);
    // A failed review says it too.
    const failing: any = createAgentService({ traces: { get: async () => trace }, complete: async () => ({ text: 'no tools' }), log: (m: string) => lines.push(m) });
    await failing.start(ID, 'beastmaster', 'en', { plan: 'late' });
    // The job is marked failed a moment before its line is written: wait for the line.
    await until(async () => lines.find((l) => l.startsWith('deep-review failed')), Boolean);
    expect(lines.find((l) => l.startsWith('deep-review failed'))).toMatch(/^deep-review failed match=9100904020 hero=beastmaster plan=late reason=/);
  });

  it('a start and every chat turn are one line each — how it went, never what was asked', async () => {
    const lines: string[] = [];
    const service = createAgentService({ traces: { get: async () => trace }, complete });
    const app = express(); app.use(express.json());
    app.use(createAgentRouter({ service, resolveClientIp: () => '10.6.0.1', log: (m: string) => lines.push(m) }));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await fetch(`${base}/api/agent/${ID}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hero: 'beastmaster', lang: 'zh', plan: 'gank' }) });
      expect(lines.find((l) => l.startsWith('review start'))).toBe(`review start match=${ID} hero=beastmaster plan=gank -> running`);
      const question = '我 36 分钟那次怎么死的？秘密问题文本';
      for (const plan of ['push', undefined]) {
        const res = await fetch(`${base}/api/agent/${ID}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hero: 'beastmaster', lang: 'zh', question, history: [], ...(plan ? { plan } : {}) }) });
        await res.text();
      }
      const chats = lines.filter((l) => l.startsWith('chat '));
      expect(chats).toEqual([
        `chat match=${ID} hero=beastmaster plan=push -> ok tools=1 in=0 out=0 unverified=0`,
        `chat match=${ID} hero=beastmaster plan=none -> ok tools=1 in=0 out=0 unverified=0`,
      ]);
      // The question, or any part of it, is never written.
      expect(lines.join('\n')).not.toContain('秘密问题文本');
      expect(lines.join('\n')).not.toContain('36 分钟');
    } finally { server.close(); }
  });
});
