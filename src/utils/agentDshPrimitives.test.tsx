// @vitest-environment jsdom
import React from 'react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createAgentRouter } from '../../lib/agent/router.js';
import { createAgentService, createFileTraceStore } from '../../lib/agent/service.js';
import { runAgent } from '../../lib/agent/loop.js';
import { I18nProvider } from '../v2/i18n/I18nProvider';
import { ShareBar, shareLinks } from '../agent/ShareBar';
import { configureDota2AiRuntime, shareOrigin } from '../runtime/dota2aiRuntime';
import { initAnalytics, trackEvent } from '../services/analytics';
import { createDshApiFetch, mountProfileSync, type DshUserProfile } from '../../packages/dsh/src/client/transport';
import { ToolCard } from '../../packages/dsh/src/client/ToolCard';
import { en as dshEn, zh as dshZh } from '../../packages/dsh/src/client/locales';

const express = createRequire(import.meta.url)('express');
const MATCH = '9100904020';
const dir = mkdtempSync(join(tmpdir(), 'agent-dsh-prim-'));
copyFileSync(join(process.cwd(), 'packages/review-engine/test/fixtures/trace-9100904020.json.gz'), join(dir, `${MATCH}.trace.json.gz`));
copyFileSync(join(process.cwd(), 'package.json'), join(dir, '123.trace.json.gz'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => cleanup());

describe('GET /api/agent/:matchId/trace and createTraceStore.raw', () => {
  it('serves verified .trace.json.gz bytes and rejects invalid, missing, corrupt, or rate-limited requests', async () => {
    const traces = createFileTraceStore(dir);
    const rawBuf = await traces.raw(MATCH);
    expect(Buffer.isBuffer(rawBuf)).toBe(true);
    expect(JSON.parse(gunzipSync(rawBuf!).toString('utf8')).match_id).toBe(9100904020);
    // Corrupt and missing files return null, never unverified bytes.
    expect(await traces.raw('123')).toBeNull();
    expect(await traces.raw('999')).toBeNull();
    expect(await traces.raw('../etc/passwd')).toBeNull();

    const service = createAgentService({ traces, complete: async () => ({ text: 'ok' }), model: 'm' });
    const app = express();
    let allowRead = true;
    app.use(createAgentRouter({
      service,
      resolveClientIp: () => '10.0.0.1',
      readLimiter: { tryConsume: () => (allowRead ? { ok: true } : { ok: false, retryAfterSec: 12 }) },
    }));
    const srv = app.listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      const ok = await fetch(`${base}/api/agent/${MATCH}/trace`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toContain('application/gzip');
      expect(ok.headers.get('cache-control')).toBe('private, max-age=3600');
      const body = Buffer.from(await ok.arrayBuffer());
      expect(JSON.parse(gunzipSync(body).toString('utf8')).schema).toBe('dota2.ai/match-trace@1');

      expect((await fetch(`${base}/api/agent/999/trace`)).status).toBe(404);
      expect((await fetch(`${base}/api/agent/123/trace`)).status).toBe(404);
      expect((await fetch(`${base}/api/agent/abc/trace`)).status).toBe(400);

      allowRead = false;
      const limited = await fetch(`${base}/api/agent/${MATCH}/trace`);
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBe('12');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('runAgent provider_state preservation', () => {
  it('carries reply.providerState on assistant tool-call turns and omits it when absent', async () => {
    const seen: any[] = [];
    let turn = 0;
    const complete = async (o: any) => {
      seen.push(JSON.parse(JSON.stringify(o.messages)));
      turn += 1;
      if (turn === 1) {
        return {
          toolCalls: [{ id: 'c1', name: 'lookup', args: { x: 1 } }],
          reasoning: 'step 1',
          providerState: { anthropicSignature: 'opaque-sig-1' },
        };
      }
      if (turn === 2) {
        return {
          toolCalls: [{ id: 'c2', name: 'lookup', args: { x: 2 } }],
        };
      }
      return { text: 'all done', providerState: { ignoredOnFinal: true } };
    };
    const r = await runAgent({
      complete,
      system: 's',
      messages: [{ role: 'user', content: 'start' }],
      tools: [{ name: 'lookup', description: 'd', input_schema: { type: 'object' } }],
      runTool: async (_n: string, a: any) => ({ ok: a.x }),
    });
    expect(r.status).toBe('answered');
    expect(seen[1][1]).toMatchObject({
      role: 'assistant',
      reasoning_content: 'step 1',
      provider_state: { anthropicSignature: 'opaque-sig-1' },
    });
    expect(seen[2][3]).not.toHaveProperty('provider_state');
    expect(r.messages.at(-1)).toEqual({ role: 'assistant', content: 'all done' });
  });
});

describe('dynamic resolveModels and model_meta in createAgentService', () => {
  it('reflects live host model updates without restarting the service', async () => {
    const traces = createFileTraceStore(dir);
    let activeDefault = 'dsh.deepseek.deepseek-chat';
    const service: any = createAgentService({
      traces,
      resolveModels: () => ({
        defaultModel: activeDefault,
        models: {
          'dsh.deepseek.deepseek-chat': { name: 'deepseek/deepseek-chat', complete: async () => ({ text: 'a' }) },
          'dsh.openai.gpt-5': { name: 'openai/gpt-5', complete: async () => ({ text: 'b' }) },
        },
        modelMeta: {
          'dsh.deepseek.deepseek-chat': { label: 'DeepSeek V3 (DeepSeek)', minutes: null },
          'dsh.openai.gpt-5': { label: 'GPT-5 (OpenAI)', minutes: null },
        },
      }),
    });

    const a1 = await service.availability(MATCH);
    expect(a1).toMatchObject({
      model_configured: true,
      default_model: 'dsh.deepseek.deepseek-chat',
      models: ['dsh.deepseek.deepseek-chat', 'dsh.openai.gpt-5'],
      model_meta: {
        'dsh.deepseek.deepseek-chat': { label: 'DeepSeek V3 (DeepSeek)', minutes: null },
        'dsh.openai.gpt-5': { label: 'GPT-5 (OpenAI)', minutes: null },
      },
    });
    expect(service.modelOf('dsh.openai.gpt-5')).toBe('dsh.openai.gpt-5');
    expect(service.modelOf('unknown-model')).toBe(false);

    activeDefault = 'dsh.openai.gpt-5';
    expect((await service.availability(MATCH)).default_model).toBe('dsh.openai.gpt-5');

    // Pinning failure backoff: if default model A fails with 402 after the host switches default to B,
    // A's backoff is recorded against A, never against healthy B.
    let releaseA!: () => void;
    const waitA = new Promise<void>((r) => { releaseA = r; });
    let currentDef = 'dsh.deepseek.deepseek-chat';
    const pinnedSvc: any = createAgentService({
      traces,
      resolveModels: () => ({
        defaultModel: currentDef,
        models: {
          'dsh.deepseek.deepseek-chat': {
            name: 'deepseek/deepseek-chat',
            complete: async () => {
              await waitA;
              throw Object.assign(new Error('Insufficient Balance'), { status: 402 });
            },
          },
          'dsh.openai.gpt-5': {
            name: 'openai/gpt-5',
            complete: async () => ({ text: 'ok' }),
          },
        },
      }),
    });
    expect((await pinnedSvc.start(MATCH, 'beastmaster', 'zh')).status).toBe('running');
    currentDef = 'dsh.openai.gpt-5';
    releaseA();
    await waitFor(async () => {
      expect((await pinnedSvc.status(MATCH, 'beastmaster', 'zh', null, 'dsh.deepseek.deepseek-chat')).status).toBe('failed');
    });
    // Starting on the new default B succeeds; explicitly requesting A hits model_out_of_credit backoff.
    expect((await pinnedSvc.start(MATCH, 'beastmaster', 'zh')).status).toBe('running');
    expect(await pinnedSvc.start(MATCH, 'axe', 'zh', { model: 'dsh.deepseek.deepseek-chat' })).toMatchObject({
      status: 'unavailable',
      reason: 'model_out_of_credit',
    });
    await pinnedSvc.shutdown();
  });
});

describe('DSH frontend runtime, ShareBar safety, analytics silence, and client transport', () => {
  it('uses publicOrigin for share links, strips dsh.* model IDs, and invokes onDiscussInHost', async () => {
    const discussed: any[] = [];
    const dispose = configureDota2AiRuntime({
      surface: 'dsh',
      publicOrigin: 'https://dota2.ai',
      onDiscussInHost: (p) => { discussed.push(p); },
    });
    try {
      expect(shareOrigin()).toBe('https://dota2.ai');
      // Host-local `dsh.*` model IDs must never appear in public dota2.ai URLs, whereas server models still do.
      expect(shareLinks(shareOrigin(), MATCH, 'beastmaster', 'zh', null, 'dsh.deepseek.deepseek-chat').self)
        .toBe(`https://dota2.ai/r/${MATCH}?hero=beastmaster&ref=share&lang=zh`);
      expect(shareLinks(shareOrigin(), MATCH, 'beastmaster', 'zh', null, 'glm-5.3').self)
        .toBe(`https://dota2.ai/r/${MATCH}?hero=beastmaster&model=glm-5.3&ref=share&lang=zh`);

      const { getByRole } = render(
        <MemoryRouter>
          <I18nProvider>
            <ShareBar
              matchId={MATCH}
              hero="beastmaster"
              lang="en"
              model="dsh.deepseek.deepseek-chat"
            />
          </I18nProvider>
        </MemoryRouter>,
      );
      const btn = getByRole('button', { name: /Discuss in DSH chat|发送到 DSH 会话/ });
      fireEvent.click(btn);
      expect(discussed).toEqual([{
        matchId: MATCH,
        hero: 'beastmaster',
        lang: 'en',
        text: `Let us discuss my Dota 2 match #${MATCH} (beastmaster) review.`,
      }]);
    } finally {
      dispose();
    }
  });

  it('silences /api/events analytics and hides web-only install/feedback sections on CoachHome when surface === dsh', async () => {
    const fetchSpy = vi.fn(async (_input: string, _init?: RequestInit) => new Response('{"code":"not_found"}', { status: 404, headers: { 'Content-Type': 'application/json' } }));
    const globalFetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"code":"not_found"}', { status: 404 }));
    const dispose = configureDota2AiRuntime({
      surface: 'dsh',
      apiFetch: fetchSpy,
    });
    try {
      initAnalytics();
      trackEvent('return_visit', { days_since_first: 1 });
      expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('/api/events'))).toBe(false);
      expect(globalFetchSpy.mock.calls.some((c) => String(c[0]).includes('/api/events'))).toBe(false);

      const { CoachHome } = await import('../coach/CoachApp');
      const { container } = render(
        <MemoryRouter>
          <I18nProvider>
            <CoachHome />
          </I18nProvider>
        </MemoryRouter>,
      );
      expect(container.querySelector('.hm-ways')).toBeNull();
      expect(container.querySelector('.hm-feedback')).toBeNull();
      expect(container.querySelector('.hm-also')).toBeNull();
    } finally {
      globalFetchSpy.mockRestore();
      dispose();
    }
  });

  it('adapts Typert request/stream into fetch Responses and renders clickable chat ToolCards', async () => {
    const apiFetch = createDshApiFetch({
      request: async (req) => ({
        ok: true,
        value: { status: 200, body: { echoed: req.url }, retryAfterSec: 7 },
      }),
      stream: async function* () {
        yield { step: { tool: 'death_context', args: { hero: 'beastmaster', index: 1 } } };
        yield { text: 'Checked answer.' };
        yield { done: true };
      },
      getProfile: async () => ({ ok: true, value: { accountId: null, reviewed: [], seenUntil: null, goal: null, goalChecks: [] } }),
      saveProfile: async (p) => ({ ok: true, value: { accountId: p.accountId ?? null, reviewed: [], seenUntil: null, goal: null, goalChecks: [] } }),
    });

    const jsonRes = await apiFetch('/api/agent/9100904020');
    expect(jsonRes.status).toBe(200);
    expect(jsonRes.headers.get('retry-after')).toBe('7');
    expect(await jsonRes.json()).toEqual({ echoed: '/api/agent/9100904020' });

    const sseRes = await apiFetch('/api/agent/9100904020/chat', { method: 'POST', body: '{"question":"hi"}' });
    expect(sseRes.headers.get('content-type')).toContain('text/event-stream');
    const text = await sseRes.text();
    expect(text).toContain('data: {"step":{"tool":"death_context"');
    expect(text).toContain('data: {"text":"Checked answer."}');
    expect(text).toContain('data: {"done":true}');

    const opened: string[] = [];
    const { container, getByRole, getByText } = render(
      <ToolCard
        toolName="dota2ai_replay_review"
        block={{
          call: { argsRaw: JSON.stringify({ match_id: 9100904020, hero: 'Beastmaster', lang: 'zh' }) },
          content: [{ type: 'text', text: JSON.stringify({ status: 'ready', verdict: '咆哮留给幻刺。' }) }],
        }}
        t={(k) => dshZh[k] ?? dshEn[k]}
        openPath={(p) => opened.push(p)}
      />,
    );
    expect(getByText('咆哮留给幻刺。')).toBeTruthy();
    // Legacy review (verdict only) renders cleanly without empty Coach-First preview blocks.
    expect(container.querySelector('.dota2ai-tool-preview')).toBeNull();
    fireEvent.click(getByRole('button', { name: /在 dota2\.ai 页面打开/ }));
    await waitFor(() => expect(opened).toEqual(['/r/9100904020?lang=zh&hero=beastmaster']));
  });

  it('renders highlights and numbered localized chapter pills in canonical order on ready replay review ToolCards (en & zh) and tolerates malformed payloads', () => {
    const coachPayload = {
      status: 'ready',
      match_id: '9100904020',
      hero: 'beastmaster',
      lang: 'en',
      verdict: 'Strong tempo offlane with high fight presence.',
      highlights: [
        { title: 'Clutch 27:27 BKB-piercing Roar', detail: 'Locked down Phantom Assassin through BKB.' },
        { title: '100% mid-game fight attendance', detail: 'Showed up to all 16 fights.' },
      ],
      chapters: [
        { topic: 'skills_and_items', title: 'Skills & items', analysis: 'Needed Blink earlier.' },
        { topic: 'draft', title: 'Draft', analysis: 'Good matchup.' },
        { topic: 'game_plan', title: 'Plan', analysis: 'Push on midgame spike.' },
        { topic: 'laning', title: 'Lane', analysis: 'Won lane.' },
        { topic: 'midgame', title: 'Midgame', analysis: 'Hold Roar in skirmishes.' },
        { topic: 'vision_and_macro', title: 'Wards', analysis: 'Ward placement & towers.' },
        { topic: 'other', title: 'Notes', analysis: 'Good roshan timing.' },
      ],
    };

    const enCard = render(
      <ToolCard
        toolName="dota2ai_replay_review"
        block={{
          call: { argsRaw: JSON.stringify({ match_id: 9100904020, hero: 'beastmaster', lang: 'en' }) },
          content: [{ type: 'text', text: JSON.stringify(coachPayload) }],
        }}
        t={(k) => dshEn[k]}
        openPath={() => {}}
      />,
    );
    expect(enCard.getByText(coachPayload.verdict)).toBeTruthy();
    expect(enCard.getByText('2 highlights')).toBeTruthy();
    expect(enCard.getByText('Clutch 27:27 BKB-piercing Roar')).toBeTruthy();
    const enPills = [...enCard.container.querySelectorAll('.dota2ai-tool-chapter')];
    expect(enPills.map((el) => el.textContent)).toEqual([
      '01Draft & matchups',
      '02Recommended game plan',
      '03Lanes & laning',
      '04Midgame fights & farm',
      '05Wards & macro',
      '06Skills & items',
      '07Key details',
    ]);
    expect(enPills.every((el) => el.className === 'dota2ai-tool-chapter')).toBe(true);
    expect(enPills[3].getAttribute('title')).toBe('Midgame');
    expect(enCard.container.querySelector('details.dota2ai-tool-details')).not.toBeNull();
    enCard.unmount();

    // Chinese locale renders localized count + all topic labels in canonical order.
    const zhCard = render(
      <ToolCard
        toolName="dota2ai_replay_review"
        block={{
          call: { argsRaw: JSON.stringify({ match_id: 9100904020, hero: 'beastmaster', lang: 'zh' }) },
          content: [{
            type: 'text',
            text: JSON.stringify({
              ...coachPayload,
              lang: 'zh',
              verdict: '团战参与度拉满，关键在把大招留给黑皇杖核心。',
              highlights: [{ title: '27:27 隔着黑皇杖控住核心', detail: '定住 3.4 秒。' }],
              chapters: [
                { topic: 'vision_and_macro', title: '视野与运营', analysis: '推塔协同。' },
                { topic: 'game_plan', title: '推荐运营思路', analysis: '抓窗口推塔。' },
                { topic: 'laning', title: '对线期稳健', analysis: '压制明显。' },
                { topic: 'midgame', title: '中期打架打钱', analysis: '留大招。' },
              ],
            }),
          }],
        }}
        t={(k) => dshZh[k]}
        openPath={() => {}}
      />,
    );
    expect(zhCard.getByText('1 处亮点')).toBeTruthy();
    expect(zhCard.getByText('27:27 隔着黑皇杖控住核心')).toBeTruthy();
    expect([...zhCard.container.querySelectorAll('.dota2ai-tool-chapter')].map((el) => el.textContent)).toEqual([
      '01本局推荐运营思路', '02实际分路与对线', '03中期打架与打钱', '04视野布置与运营',
    ]);
    zhCard.unmount();

    // Malformed highlights/chapters (non-arrays, null/primitive items, empty objects, unknown topic) never throw.
    const badNonArray = render(
      <ToolCard
        toolName="dota2ai_replay_review"
        block={{
          call: { argsRaw: JSON.stringify({ match_id: 9100904020, hero: 'beastmaster' }) },
          content: [{ type: 'text', text: JSON.stringify({ status: 'ready', verdict: 'Safe render', highlights: 'oops', chapters: { bad: true } }) }],
        }}
        t={(k) => dshEn[k]}
        openPath={() => {}}
      />,
    );
    expect(badNonArray.getByText('Safe render')).toBeTruthy();
    expect(badNonArray.container.querySelector('.dota2ai-tool-preview')).toBeNull();
    badNonArray.unmount();

    const mixedBadEntries = render(
      <ToolCard
        toolName="dota2ai_replay_review"
        block={{
          call: { argsRaw: JSON.stringify({ match_id: 9100904020, hero: 'beastmaster' }) },
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'ready',
              verdict: 'Partial valid payload',
              highlights: [null, 42, {}, { title: '   ', detail: 'Fallback detail preview' }],
              chapters: [null, 'bad', {}, { topic: 'unknown_dim', title: 'Custom note' }],
            }),
          }],
        }}
        t={(k) => dshEn[k]}
        openPath={() => {}}
      />,
    );
    expect(mixedBadEntries.getByText('1 highlight')).toBeTruthy();
    expect(mixedBadEntries.getByText('Fallback detail preview')).toBeTruthy();
    const normalized = mixedBadEntries.container.querySelectorAll('.dota2ai-tool-chapter');
    expect(normalized).toHaveLength(1);
    expect(normalized[0].textContent).toBe('01Key details');
    expect(normalized[0].className).toBe('dota2ai-tool-chapter');
    mixedBadEntries.unmount();

    // Non-ready review never renders the preview.
    const reviewingCard = render(
      <ToolCard
        toolName="dota2ai_replay_review"
        block={{
          call: { argsRaw: JSON.stringify({ match_id: 9100904020, hero: 'beastmaster' }) },
          content: [{ type: 'text', text: JSON.stringify({ status: 'reviewing', highlights: coachPayload.highlights, chapters: coachPayload.chapters }) }],
        }}
        t={(k) => dshEn[k]}
        openPath={() => {}}
      />,
    );
    expect(reviewingCard.container.querySelector('.dota2ai-tool-preview')).toBeNull();
    reviewingCard.unmount();
  });

  it('renders transparent token usage (en & zh) on ready replay review ToolCards without fabricating prices or zeros', () => {
    const PRICE_RE = /[$¥￥]|CNY|USD|元|角/;
    const withCache = {
      status: 'ready',
      match_id: '9100904020',
      hero: 'beastmaster',
      lang: 'en',
      verdict: 'Strong tempo offlane.',
      model: 'deepseek/deepseek-chat',
      steps: 8,
      tool_calls: 18,
      repair_rounds: 1,
      usage_source: 'provider_usage',
      usage: {
        input: 12_400,
        output: 2100,
        input_uncached: 3300,
        cache_read: 9100,
        cache_write: null,
        source: 'provider_usage',
      },
    };

    const enCard = render(
      <ToolCard
        toolName="dota2ai_replay_review"
        block={{
          call: { argsRaw: JSON.stringify({ match_id: 9100904020, hero: 'beastmaster', lang: 'en' }) },
          content: [{ type: 'text', text: JSON.stringify(withCache) }],
        }}
        t={(k) => dshEn[k]}
        openPath={() => {}}
      />,
    );
    const enUsage = enCard.container.querySelector('.dota2ai-tool-usage')!;
    expect(enUsage).not.toBeNull();
    expect(enUsage.textContent).toContain('12.4k in (9.1k cached, 3.3k uncached) · 2.1k out · 8 steps · 18 tools · 1 repair · deepseek/deepseek-chat');
    expect(enUsage.textContent).toContain('Source: provider usage (tokens only, no price estimate)');
    expect(enUsage.textContent).not.toMatch(PRICE_RE);
    enCard.unmount();

    const zhCard = render(
      <ToolCard
        toolName="dota2ai_replay_review"
        block={{
          call: { argsRaw: JSON.stringify({ match_id: 9100904020, hero: 'beastmaster', lang: 'zh' }) },
          content: [{ type: 'text', text: JSON.stringify({ ...withCache, lang: 'zh' }) }],
        }}
        t={(k) => dshZh[k]}
        openPath={() => {}}
      />,
    );
    const zhUsage = zhCard.container.querySelector('.dota2ai-tool-usage')!;
    expect(zhUsage.textContent).toContain('输入 12.4k（缓存命中 9.1k，未命中 3.3k） · 输出 2.1k · 8 轮 · 18 次工具 · 1 次修订 · deepseek/deepseek-chat');
    expect(zhUsage.textContent).toContain('来源：模型接口统计（仅展示真实 token，不估算费用）');
    expect(zhUsage.textContent).not.toMatch(PRICE_RE);
    zhCard.unmount();

    // Null cache fields stay omitted (never coerced to 0 cached) and missing provider usage shows unavailable honestly.
    const noCacheCard = render(
      <ToolCard
        toolName="dota2ai_replay_review"
        block={{
          call: { argsRaw: JSON.stringify({ match_id: 9100904020, hero: 'beastmaster' }) },
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'ready',
              verdict: 'Done.',
              model: 'openai/gpt-5',
              steps: 4,
              tool_calls: 7,
              usage_source: 'provider_usage',
              usage: { input: 6000, output: 900, input_uncached: null, cache_read: null, cache_write: null, source: 'provider_usage' },
            }),
          }],
        }}
        t={(k) => dshEn[k]}
        openPath={() => {}}
      />,
    );
    const noCacheUsage = noCacheCard.container.querySelector('.dota2ai-tool-usage')!;
    expect(noCacheUsage.textContent).toContain('6k in · 900 out · 4 steps · 7 tools · openai/gpt-5');
    expect(noCacheUsage.textContent).not.toContain('cached');
    expect(noCacheUsage.textContent).not.toMatch(PRICE_RE);
    noCacheCard.unmount();

    const noTelemetryCard = render(
      <ToolCard
        toolName="dota2ai_replay_review"
        block={{
          call: { argsRaw: JSON.stringify({ match_id: 9100904020, hero: 'beastmaster' }) },
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'ready',
              verdict: 'Done.',
              model: 'custom/local',
              steps: 3,
              tool_calls: 5,
              usage_source: null,
              usage: { input: 0, output: 0, input_uncached: null, cache_read: null, cache_write: null, source: null },
            }),
          }],
        }}
        t={(k) => dshEn[k]}
        openPath={() => {}}
      />,
    );
    const noTelemetryUsage = noTelemetryCard.container.querySelector('.dota2ai-tool-usage')!;
    expect(noTelemetryUsage.textContent).toContain('Token usage unavailable · 3 steps · 5 tools · custom/local');
    expect(noTelemetryUsage.textContent).toContain('Source: not reported by provider');
    expect(noTelemetryUsage.textContent).not.toContain('0 in');
    expect(noTelemetryUsage.textContent).not.toMatch(PRICE_RE);
    noTelemetryCard.unmount();

    // Malformed usage payload never throws.
    const badUsageCard = render(
      <ToolCard
        toolName="dota2ai_replay_review"
        block={{
          call: { argsRaw: JSON.stringify({ match_id: 9100904020, hero: 'beastmaster' }) },
          content: [{ type: 'text', text: JSON.stringify({ status: 'ready', verdict: 'Safe.', usage: 'not-an-object', steps: 'bad' }) }],
        }}
        t={(k) => dshEn[k]}
        openPath={() => {}}
      />,
    );
    expect(badUsageCard.container.querySelector('.dota2ai-tool-usage')).toBeNull();
    badUsageCard.unmount();
  });

  it('renders bilingual cached-version badge, DSH local cache boundary note, and usage telemetry together on ready ToolCards (#486)', () => {
    const cachedEn = render(
      <ToolCard
        toolName="dota2ai_replay_review"
        block={{
          call: { argsRaw: JSON.stringify({ match_id: 9100904020, hero: 'beastmaster', lang: 'en' }) },
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'ready',
              verdict: 'Cached review verdict.',
              cache_scope: 'dsh_local',
              stale_version: true,
              prompt_version: 75,
              latest_prompt_version: 78,
              model: 'deepseek/deepseek-chat',
              steps: 6,
              tool_calls: 12,
              usage_source: 'provider_usage',
              usage: { input: 9000, output: 1500, input_uncached: 2000, cache_read: 7000, cache_write: null, source: 'provider_usage' },
            }),
          }],
        }}
        t={(k) => dshEn[k]}
        openPath={() => {}}
      />,
    );
    expect(cachedEn.getByText('Cached v75')).toBeTruthy();
    expect(cachedEn.container.querySelector('.dota2ai-tool-usage')?.textContent).toContain('9k in (7k cached, 2k uncached) · 1.5k out · 6 steps · 12 tools');
    expect(cachedEn.container.querySelector('.dota2ai-tool-cache-note')?.textContent).toContain('$DSH_HOME/dota2ai');
    expect(cachedEn.container.querySelector('.dota2ai-tool-cache-note')?.textContent).toContain('separate from dota2.ai web cache');
    cachedEn.unmount();

    const cachedZh = render(
      <ToolCard
        toolName="dota2ai_replay_review"
        block={{
          call: { argsRaw: JSON.stringify({ match_id: 9100904020, hero: 'beastmaster', lang: 'zh' }) },
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'ready',
              verdict: '缓存复盘结论。',
              cache_scope: 'dsh_local',
              stale_version: true,
              prompt_version: 75,
              latest_prompt_version: 78,
            }),
          }],
        }}
        t={(k) => dshZh[k]}
        openPath={() => {}}
      />,
    );
    expect(cachedZh.getByText('缓存 v75')).toBeTruthy();
    expect(cachedZh.container.querySelector('.dota2ai-tool-cache-note')?.textContent).toContain('本机 DSH 私有缓存');
    cachedZh.unmount();

    // Canonical hero key from tool output overrides Chinese alias input, and diagnostic statuses show clear badges + guidance (#485).
    const openedAlias: string[] = [];
    const aliasCard = render(
      <ToolCard
        toolName="dota2ai_coach_cases"
        block={{
          call: { argsRaw: JSON.stringify({ match_id: 'https://dota2.ai/r/9091400302', hero: '小鹿', lang: 'zh' }) },
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'no_parsed_match',
              surface: 'native_dsh',
              match_id: '9091400302',
              hero: 'enchantress',
              message: 'OpenDota has basic scoreboard only; call dota2ai_replay_review.',
            }),
          }],
        }}
        t={(k) => dshZh[k]}
        openPath={(p) => openedAlias.push(p)}
      />,
    );
    expect(aliasCard.getByText('仅基础数据')).toBeTruthy();
    expect(aliasCard.getByText('OpenDota has basic scoreboard only; call dota2ai_replay_review.')).toBeTruthy();
    fireEvent.click(aliasCard.getByRole('button', { name: /在 dota2\.ai 页面打开/ }));
    expect(openedAlias).toEqual(['/r/9091400302?lang=zh&hero=enchantress']);
    aliasCard.unmount();
  });

  it('notifies already-mounted CoachHome consumers when async profile hydration resolves, without echoing saveProfile', async () => {
    window.localStorage.clear();
    const requestedUrls: string[] = [];
    const saveCalls: any[] = [];
    let resolveProfile!: (res: { ok: true; value: DshUserProfile }) => void;
    const deferredProfile = new Promise<{ ok: true; value: DshUserProfile }>((r) => { resolveProfile = r; });

    const disposeRuntime = configureDota2AiRuntime({
      surface: 'dsh',
      apiFetch: async (url) => {
        requestedUrls.push(url);
        if (url.includes('/api/coach/players/86745912/recent')) {
          return new Response(JSON.stringify({ account_id: 86745912, empty_hint: null, matches: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('{"code":"not_found"}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      },
    });

    let disposeSync = () => {};
    try {
      const syncPromise = mountProfileSync({
        request: async () => ({ ok: true, value: { status: 404, body: {} } }),
        stream: async function* () {},
        getProfile: () => deferredProfile,
        saveProfile: async (patch) => {
          saveCalls.push(patch);
          return { ok: true, value: { accountId: patch.accountId ?? null, reviewed: [], seenUntil: null, goal: null, goalChecks: [] } };
        },
      });

      const { CoachHome } = await import('../coach/CoachApp');
      const { container } = render(
        <MemoryRouter>
          <I18nProvider>
            <CoachHome />
          </I18nProvider>
        </MemoryRouter>,
      );

      // Mounted before getProfile() resolves: no account or goal rendered yet.
      expect(requestedUrls.some((u) => u.includes('86745912'))).toBe(false);
      expect(container.querySelector('.cx-goal-nav')).toBeNull();

      resolveProfile({
        ok: true,
        value: {
          accountId: '86745912',
          reviewed: ['9100904020'],
          seenUntil: 1700000000,
          goal: {
            id: 'g1',
            goal: { kind: 'deaths_per10_max', max: 2, label: { en: 'At most 2 deaths / 10m', zh: '每10分钟不超2死' } },
            action: { en: 'Play safer', zh: '少死' },
            findingId: 'agent:0',
            fromMatch: 9100904020,
            fromStart: 1700000000,
            accountId: 86745912,
            heroId: 38,
            setAt: 1700000001,
          },
          goalChecks: [],
        },
      });
      disposeSync = await syncPromise;

      await waitFor(() => {
        expect(requestedUrls.some((u) => u.includes('/api/coach/players/86745912/recent'))).toBe(true);
        expect(container.querySelector('a[href^="/p/86745912"]')).not.toBeNull();
        expect(container.textContent).toContain('My games');
        expect(container.textContent).toContain('Goal');
      });
      // Hydration itself must not echo a redundant saveProfile write back to the host.
      expect(saveCalls).toEqual([]);
    } finally {
      disposeSync();
      disposeRuntime();
      window.localStorage.clear();
    }

    // Conversely, hydrating an empty saved profile clears stale localStorage fields instead of resurrecting them.
    window.localStorage.setItem('dota2ai.coach.account', '99999999');
    window.localStorage.setItem('dota2ai.coach.goal', JSON.stringify({ id: 'stale', goal: { kind: 'deaths_per10_max', max: 1 } }));
    const clearedSaves: any[] = [];
    const disposeCleared = await mountProfileSync({
      request: async () => ({ ok: true, value: { status: 404, body: {} } }),
      stream: async function* () {},
      getProfile: async () => ({
        ok: true,
        value: { accountId: null, reviewed: [], seenUntil: null, goal: null, goalChecks: [] },
      }),
      saveProfile: async (patch) => {
        clearedSaves.push(patch);
        return { ok: true, value: { accountId: patch.accountId ?? null, reviewed: [], seenUntil: null, goal: null, goalChecks: [] } };
      },
    });
    try {
      expect(window.localStorage.getItem('dota2ai.coach.account')).toBeNull();
      expect(window.localStorage.getItem('dota2ai.coach.goal')).toBeNull();
      window.dispatchEvent(new Event('dota2ai:profile'));
      expect(clearedSaves).toEqual([{ accountId: null, reviewed: [], seenUntil: null, goal: null, goalChecks: [] }]);
    } finally {
      disposeCleared();
      window.localStorage.clear();
    }
  });
});
