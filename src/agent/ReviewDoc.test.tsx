// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { ReviewDoc } from './ReviewDoc';
import type { DeepReview } from './api';

/**
 * The review as a clear, non-templated coaching document:
 * verdict + attribution + patch → up-front highlights ("What went well") & findings ("What didn't")
 * → chronologically ordered walkthrough chapters → share → whole game → blind spots → token usage.
 */

const finding = (n: number, extra: Partial<DeepReview['findings'][number]> = {}) => ({
  title: `Finding ${n}`,
  claim: `Claim ${n}.`,
  fix: `Fix ${n}.`,
  evidence: [{ refs: [`death:axe:${n}`], clock: `${n}0:00`, fact: `Fact ${n}.` }],
  ...extra,
});

const review = (extra: Partial<DeepReview> = {}): DeepReview => ({
  schema: 'dota2.ai/deep-review@1',
  match_id: 7,
  hero: 'axe',
  lang: 'en',
  verdict: 'Strong teamfight presence across the match, with Primal Roar target selection deciding the late game.',
  highlights: [
    {
      title: 'Decisive BKB-piercing Roar at 27:27',
      detail: 'You immediately stopped Phantom Assassin through spell immunity for 3.4 s.',
      evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], clock: '27:27', fact: '27:27 stunned PA for 3.4 s.' }],
    },
  ],
  findings: [finding(1), finding(2), finding(3)],
  chapters: [
    {
      topic: 'draft',
      title: 'Your ultimate is the sole BKB-piercing disable',
      analysis: 'Against PA and Necrophos, Primal Roar defines teamfight control.',
      evidence: [{ refs: ['draft:beastmaster'], fact: '10-hero lineup breakdown.' }],
    },
    {
      topic: 'skills_and_items',
      title: 'Clean skill build, missing Blink or BKB after Aghanim\'s',
      analysis: 'Maxed core laning spells by level 10, but skipped Blink Dagger and Black King Bar.',
      evidence: [{ refs: ['pro_items:beastmaster'], fact: 'Pro games frequently add Blink or BKB.' }],
    },
  ],
  blind_spots: ['Creep positions.'],
  game_plan: { main_reason: 'team_play', why: 'Team did not convert won fights into towers.', evidence: [] },
  ...extra,
});

const show = (r: DeepReview, props: Partial<React.ComponentProps<typeof ReviewDoc>> = {}) =>
  render(<ReviewDoc matchId="7" review={r} lang="en" onAsk={() => {}} {...props} />);

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'not_found' }), { status: 404 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ReviewDoc: clean, non-templated logical review layout', () => {
  it('renders verdict, up-front pros & cons above chronologically ordered chapters with jump nav, and zero template boxes', () => {
    // Deliberately pass chapters out of order to verify canonical chronological display ordering.
    const outOfOrderChapters: DeepReview['chapters'] = [
      {
        topic: 'skills_and_items',
        title: 'Clean skills, missing initiation item after Aghanim\'s',
        analysis: 'Maxed core spells on time, but lacked Blink Dagger or Black King Bar.',
        evidence: [{ refs: ['pro_items:beastmaster'], fact: 'Pro games frequently add Blink or BKB.' }],
      },
      {
        topic: 'vision_and_macro',
        title: 'Wards & post-fight tower conversion',
        analysis: 'Won fights rarely turned into towers; ward placements were not recorded in this replay.',
        evidence: [{ refs: ['tempo:beastmaster'], fact: 'Only 1 of 6 won fights yielded a building.' }],
      },
      {
        topic: 'draft',
        title: 'Your ultimate is the sole BKB-piercing disable',
        analysis: 'Against PA and Necrophos, Primal Roar defines teamfight control.',
        evidence: [{ refs: ['draft:beastmaster'], fact: '10-hero lineup breakdown.' }],
      },
      {
        topic: 'game_plan',
        title: 'Push towers on midgame window and hold Roar for PA',
        analysis: 'Leverage the 19:00–29:00 power window and reserve Roar strictly for PA BKB.',
        evidence: [{ refs: ['window:beastmaster:2'], fact: 'Ahead from 19:00 to 29:00.' }],
      },
      {
        topic: 'midgame',
        title: 'Midgame fights and tempo',
        analysis: 'Full attendance across fights, with the 30:26 fight deciding the match.',
        evidence: [{ refs: ['fights:beastmaster:12'], clock: '33:23', fact: '841 damage in 33:23 fight.' }],
      },
      {
        topic: 'laning',
        title: 'Bot lane execution under roams',
        analysis: 'Absorbed 2 early roams while keeping lane pressure.',
        evidence: [{ refs: ['lane:beastmaster'], fact: '445 s in bot lane.' }],
      },
    ];

    show(review({ chapters: outOfOrderChapters }), {
      board: <div role="region" aria-label="Scoreboard">board</div>,
      share: <div data-testid="share">share</div>,
    });

    // Direct verdict + attribution pill; zero forced template fluff.
    expect(document.querySelector('.ag-lead-reason')!.textContent).toBe('Mostly the team, not you');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Strong teamfight presence across the match, with Primal Roar target selection deciding the late game.');
    expect(document.querySelector('.ag-opening')).toBeNull();
    expect(document.querySelector('.ag-encouragement')).toBeNull();
    expect(document.querySelector('.ag-story')).toBeNull();
    expect(document.querySelector('.ag-rule')).toBeNull();
    expect(document.querySelector('.ag-chapter-badge')).toBeNull();
    expect(document.querySelector('.ag-chapter-takeaway')).toBeNull();

    // Up-front Pros & Cons summary sits right below the verdict and ABOVE chapters.
    const summary = document.querySelector('.ag-summary')!;
    expect(summary.classList.contains('has-both')).toBe(true);
    const highlights = screen.getByRole('heading', { level: 2, name: 'What went well' }).closest('section')!;
    const improvements = screen.getByRole('heading', { level: 2, name: "What didn't" }).closest('section')!;
    const chapters = screen.getByRole('heading', { level: 2, name: 'Match walkthrough' }).closest('section')!;
    expect(highlights.compareDocumentPosition(improvements) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(improvements.compareDocumentPosition(chapters) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(highlights.textContent).toContain('Decisive BKB-piercing Roar at 27:27');
    expect(highlights.querySelector('.ag-ev-clock')!.textContent).toBe('27:27');

    // Findings: lead finding open, secondary findings folded numbered from 2.
    expect(improvements.querySelector('.ag-finding.is-lead h3')!.textContent).toBe('1Finding 1');
    expect(improvements.querySelector('.ag-finding.is-lead .ag-fix')!.textContent).toContain('Fix 1.');
    const folds = Array.from(improvements.querySelectorAll('details.ag-finding')) as HTMLDetailsElement[];
    expect(folds).toHaveLength(2);
    expect(folds.map((d) => d.querySelector('summary')!.textContent)).toEqual(['2Finding 2', '3Finding 3']);
    expect(folds.every((d) => !d.open)).toBe(true);

    // Compact numbered chapter nav strip jumps directly to each chronologically ordered chapter.
    const navLinks = Array.from(chapters.querySelectorAll('.ag-chapter-nav a'));
    expect(navLinks.map((a) => [a.getAttribute('href'), a.textContent])).toEqual([
      ['#chapter-0', '01Draft & matchups'],
      ['#chapter-1', '02Recommended game plan'],
      ['#chapter-2', '03Lanes & laning'],
      ['#chapter-3', '04Midgame fights & farm'],
      ['#chapter-4', '05Wards & macro'],
      ['#chapter-5', '06Skills & items'],
    ]);

    const cards = chapters.querySelectorAll('.ag-chapter');
    expect(cards).toHaveLength(6);
    expect(Array.from(cards).map((c) => c.id)).toEqual(['chapter-0', 'chapter-1', 'chapter-2', 'chapter-3', 'chapter-4', 'chapter-5']);
    expect(Array.from(cards).map((c) => c.querySelector('.ag-chapter-step')!.textContent)).toEqual(['01', '02', '03', '04', '05', '06']);
    expect(Array.from(cards).map((c) => c.querySelector('.ag-chapter-topic')!.textContent)).toEqual([
      'Draft & matchups',
      'Recommended game plan',
      'Lanes & laning',
      'Midgame fights & farm',
      'Wards & macro',
      'Skills & items',
    ]);
    expect(cards[5].querySelector('.ag-chapter-records summary')!.textContent).toBe('Records · 1');

    // Share sits between chapters and whole game; scoreboard is folded inside whole game.
    const share = screen.getByTestId('share');
    const whole = screen.getByRole('heading', { level: 2, name: 'The whole game' }).closest('section')!;
    expect(chapters.compareDocumentPosition(share) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(share.compareDocumentPosition(whole) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(whole).getByRole('region', { name: 'Scoreboard' })).toBeTruthy();

    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'What went well',
      "What didn't",
      'Match walkthrough',
      'The whole game',
      'What the replay could not show',
    ]);
  });

  it('handles 0 findings or 0 highlights cleanly and renders localized labels in zh & ru', () => {
    const allChapters: DeepReview['chapters'] = [
      { topic: 'draft', title: 'Draft', analysis: 'Good draft.', evidence: [{ refs: ['draft:bm'], fact: 'f' }] },
      { topic: 'game_plan', title: 'Plan', analysis: 'Clear plan.', evidence: [{ refs: ['window:bm:1'], fact: 'f' }] },
      { topic: 'laning', title: 'Lane', analysis: 'Won lane.', evidence: [{ refs: ['lane:bm'], fact: 'f' }] },
      { topic: 'midgame', title: 'Mid', analysis: 'Good midgame.', evidence: [{ refs: ['fights:bm:1'], fact: 'f' }] },
      { topic: 'vision_and_macro', title: 'Macro', analysis: 'Good wards.', evidence: [{ refs: ['tempo:bm'], fact: 'f' }] },
      { topic: 'skills_and_items', title: 'Skills & Items', analysis: 'Clean build.', evidence: [{ refs: ['skill_build:bm'], fact: 'f' }] },
      { topic: 'other', title: 'Details', analysis: 'Extra note.', evidence: [{ refs: ['overview'], fact: 'f' }] },
    ];

    // 0 findings: omits improvements cleanly without has-both 2-column class.
    render(<ReviewDoc matchId="7" review={review({ lang: 'zh', findings: [], chapters: allChapters })} lang="zh" onAsk={() => {}} />);
    expect(document.querySelector('.ag-improvements')).toBeNull();
    expect(document.querySelector('.ag-summary')!.classList.contains('has-both')).toBe(false);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      '做得好的', '逐层复盘', '整局数据', '录像看不到的',
    ]);
    expect(Array.from(document.querySelectorAll('.ag-chapter-topic')).map((el) => el.textContent)).toEqual([
      '阵容选择与克制', '本局推荐运营思路', '实际分路与对线', '中期打架与打钱', '视野布置与运营', '技能与出装', '其他细节',
    ]);
    cleanup();

    // Both pros and cons in Chinese.
    render(<ReviewDoc matchId="7" review={review({ lang: 'zh', chapters: allChapters })} lang="zh" onAsk={() => {}} />);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      '做得好的', '做得不好的', '逐层复盘', '整局数据', '录像看不到的',
    ]);
    cleanup();

    // 0 highlights: omits highlights cleanly, renders findings full-width.
    render(<ReviewDoc matchId="7" review={review({ lang: 'zh', highlights: [], chapters: allChapters })} lang="zh" onAsk={() => {}} />);
    expect(document.querySelector('.ag-highlights')).toBeNull();
    expect(document.querySelector('.ag-summary')!.classList.contains('has-both')).toBe(false);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      '做得不好的', '逐层复盘', '整局数据', '录像看不到的',
    ]);
    cleanup();

    // Russian labels.
    render(<ReviewDoc matchId="7" review={review({ lang: 'ru', findings: [], chapters: allChapters })} lang="ru" onAsk={() => {}} />);
    expect(Array.from(document.querySelectorAll('.ag-chapter-topic')).map((el) => el.textContent)).toEqual([
      'Драфт и матчапы', 'Рекомендуемый план', 'Линии и лайнинг', 'Мидгейм: драки и фарм', 'Варды и макро', 'Навыки и предметы', 'Ключевые детали',
    ]);
  });

  it('keeps the patch note with the headline and preserves tie order for repeated chapter topics', () => {
    show(review({ data_patch: { name: '7.42', exact: true, known_from: 'start_time' } }));
    expect(document.querySelector('.ag-lead .ag-patch')!.textContent).toContain('7.42');
    cleanup();

    show(review({
      data_patch: { name: '7.42', exact: false, reason: 'not_known' },
      chapters: [
        { topic: 'midgame', title: 'Fight 1', analysis: 'F1.', evidence: [{ refs: ['fights:x:1'], fact: 'f' }] },
        { topic: 'midgame', title: 'Fight 2', analysis: 'F2.', evidence: [{ refs: ['fights:x:2'], fact: 'f' }] },
        { topic: 'draft', title: 'Draft', analysis: 'D.', evidence: [{ refs: ['draft:x'], fact: 'f' }] },
      ],
    }));
    expect(within(document.querySelector('.ag-lead') as HTMLElement).getByRole('note').textContent).toContain('could not be told');
    expect(Array.from(document.querySelectorAll('.ag-chapter h3')).map((el) => el.textContent)).toEqual([
      'Draft', 'Fight 1', 'Fight 2',
    ]);
  });

  it('never renders mechanical KPI cards or goal controls', () => {
    show(review());
    expect(document.querySelector('.ag-goal')).toBeNull();
    expect(document.querySelector('.ag-next')).toBeNull();
    expect(document.querySelector('.ag-rule-check')).toBeNull();
    expect(screen.queryByText(/Make this my next-game goal/)).toBeNull();
  });

  it('tolerates malformed non-array or null-element collections without throwing', () => {
    const malformed = review({
      highlights: {} as any,
      chapters: 'bad' as any,
      findings: [null as any, { title: 'Valid', claim: 'Valid claim', evidence: 'bad' as any, fix: 'Do x' }],
      blind_spots: 42 as any,
    });
    expect(() => show(malformed)).not.toThrow();
    expect(screen.getByText('Valid')).toBeTruthy();
  });
});

describe('ReviewDoc: fight presence strip (#363)', () => {
  it('renders falls_by_my_part segments (including not_known when present) and omits zero/null shares', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('ref=moments%3Aaxe')) {
        return new Response(JSON.stringify({
          status: 'ok',
          ref: 'moments:axe',
          kind: 'moments',
          names: {},
          record: {
            read: true,
            falls_by_my_part: { in_it: 0.62, elsewhere: 0.28, dead: 0, not_known: 0.1 },
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 'not_found' }), { status: 404 });
    }));

    render(<ReviewDoc matchId="701" review={review({ lang: 'zh' })} lang="zh" onAsk={() => {}} />);
    const fig = await screen.findByRole('figure', { name: '己方掉势团战里，你当时在哪' });
    expect(fig.textContent).toContain('在团里62%');
    expect(fig.textContent).toContain('在别处28%');
    expect(fig.textContent).toContain('缺少采样10%');
    expect(fig.textContent).not.toContain('已阵亡');
    expect(fig.textContent).not.toContain('仅覆盖可算出胜率变化');
    expect(fig.textContent).toContain('不等同于谁的责任');
  });

  it('states coverage when some fights lacked gold-lead minutes, and renders unknown instead of hiding when all fights were unread', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/703/') && u.includes('ref=moments%3Aaxe')) {
        return new Response(JSON.stringify({
          status: 'ok',
          ref: 'moments:axe',
          kind: 'moments',
          names: {},
          record: {
            read: true,
            falls_by_my_part: { in_it: 0.7, elsewhere: 0.3, dead: 0, not_known: null },
            fights_read: 10,
            fights_not_read: 4,
          },
        }), { status: 200 });
      }
      if (u.includes('/704/') && u.includes('ref=moments%3Aaxe')) {
        return new Response(JSON.stringify({
          status: 'ok',
          ref: 'moments:axe',
          kind: 'moments',
          names: {},
          record: {
            read: true,
            falls_by_my_part: { in_it: null, elsewhere: null, dead: null, not_known: null },
            fights_read: 0,
            fights_not_read: 14,
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 'not_found' }), { status: 404 });
    }));

    render(<ReviewDoc matchId="703" review={review({ lang: 'zh' })} lang="zh" onAsk={() => {}} />);
    const partial = await screen.findByRole('figure', { name: '己方掉势团战里，你当时在哪' });
    expect(partial.textContent).toContain('在团里70%');
    expect(partial.textContent).toContain('仅覆盖可算出胜率变化的 10/14 波团战（另有 4 波团缺少对应分钟经济差，未计入占比）');
    cleanup();

    render(<ReviewDoc matchId="704" review={review({ lang: 'zh' })} lang="zh" onAsk={() => {}} />);
    const allUnread = await screen.findByRole('figure', { name: '己方掉势团战里，你当时在哪' });
    expect(allUnread.querySelector('.ag-presence-bar')).toBeNull();
    expect(allUnread.textContent).toContain('不确定——有 14 波团战缺少对应分钟经济差，读不出胜率变化。');
  });

  it('shows nothing when moments could not be read (net_worth_only)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('ref=moments%3Aaxe')) {
        return new Response(JSON.stringify({
          status: 'ok',
          ref: 'moments:axe',
          kind: 'moments',
          names: {},
          record: { read: false },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 'not_found' }), { status: 404 });
    }));

    render(<ReviewDoc matchId="702" review={review()} lang="en" onAsk={() => {}} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector('.ag-presence')).toBeNull();
  });
});

describe('ReviewDoc: transparent token usage footer (#488)', () => {
  const PRICE_RE = /[$¥￥]|CNY|USD|元|角/;

  it('shows exact input/cache breakdown, output, steps, tools, repair rounds, stages, model, and source in en & zh with zero fabricated prices', () => {
    const runMeta = {
      model: 'deepseek/deepseek-chat',
      steps: 8,
      tool_calls: 18,
      repair_rounds: 1,
      truncation_retries: 0,
      usage_source: 'provider_usage' as const,
      usage: {
        input: 12_400,
        output: 2100,
        input_uncached: 3300,
        cache_read: 9100,
        cache_write: null,
        source: 'provider_usage' as const,
        stages: {
          first: { input: 9000, output: 1500, input_uncached: 2800, cache_read: 6200, cache_write: null, source: 'provider_usage' as const, steps: 6, tool_calls: 16 },
          repair: { input: 3400, output: 600, input_uncached: 500, cache_read: 2900, cache_write: null, source: 'provider_usage' as const, steps: 2, tool_calls: 2 },
        },
      },
    };

    show(review(), { runMeta });
    const footer = document.querySelector('footer.ag-usage')!;
    expect(footer).not.toBeNull();
    expect(footer.textContent).toContain('12.4k in (9.1k cached, 3.3k uncached) · 2.1k out · 8 steps · 18 tools · 1 repair · deepseek/deepseek-chat');
    expect(footer.textContent).toContain('Source: provider usage (tokens only, no price estimate)');
    expect(footer.textContent).toContain('First pass');
    expect(footer.textContent).toContain('Fact repair');
    expect(footer.textContent).not.toMatch(PRICE_RE);
    cleanup();

    render(<ReviewDoc matchId="7" review={review({ lang: 'zh' })} lang="zh" onAsk={() => {}} runMeta={runMeta} />);
    const zhFooter = document.querySelector('footer.ag-usage')!;
    expect(zhFooter.textContent).toContain('输入 12.4k（缓存命中 9.1k，未命中 3.3k） · 输出 2.1k · 8 轮 · 18 次工具 · 1 次修订 · deepseek/deepseek-chat');
    expect(zhFooter.textContent).toContain('来源：模型接口统计（仅展示真实 token，不估算费用）');
    expect(zhFooter.textContent).toContain('首次生成');
    expect(zhFooter.textContent).toContain('事实修订');
    expect(zhFooter.textContent).not.toMatch(PRICE_RE);
  });

  it('never fabricates 0 cached when cache fields are null, and states unavailable when provider omitted usage', () => {
    show(review(), {
      runMeta: {
        model: 'openai/gpt-5',
        steps: 5,
        tool_calls: 10,
        repair_rounds: 0,
        usage_source: 'provider_usage',
        usage: { input: 8500, output: 1100, input_uncached: null, cache_read: null, cache_write: null, source: 'provider_usage' },
      },
    });
    const noCache = document.querySelector('footer.ag-usage')!;
    expect(noCache.textContent).toContain('8.5k in · 1.1k out · 5 steps · 10 tools · openai/gpt-5');
    expect(noCache.textContent).not.toContain('cached');
    expect(noCache.textContent).not.toContain('uncached');
    expect(noCache.textContent).not.toMatch(PRICE_RE);
    cleanup();

    render(
      <ReviewDoc
        matchId="7"
        review={review({ lang: 'zh' })}
        lang="zh"
        onAsk={() => {}}
        runMeta={{
          model: 'custom/model',
          steps: 4,
          tool_calls: 6,
          usage_source: null,
          usage: { input: 0, output: 0, input_uncached: null, cache_read: null, cache_write: null, source: null },
        }}
      />,
    );
    const unavailable = document.querySelector('footer.ag-usage')!;
    expect(unavailable.textContent).toContain('未返回 token 用量 · 4 轮 · 6 次工具 · custom/model');
    expect(unavailable.textContent).toContain('来源：模型接口未返回用量');
    expect(unavailable.textContent).not.toContain('输入 0');
    expect(unavailable.textContent).not.toMatch(PRICE_RE);
  });

  it('omits the usage footer cleanly without runMeta', () => {
    show(review());
    expect(document.querySelector('footer.ag-usage')).toBeNull();
  });
});
