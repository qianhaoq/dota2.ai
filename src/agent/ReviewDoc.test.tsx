// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { ReviewDoc } from './ReviewDoc';
import type { DeepReview } from './api';

/** The review as a document: one lesson first, the rest folded under it, the whole game after. */

const finding = (n: number, extra: Partial<DeepReview['findings'][number]> = {}) => ({
  title: `Finding ${n}`, claim: `Claim ${n}.`, fix: `Fix ${n}.`,
  evidence: [{ refs: [`death:axe:${n}`], clock: `${n}0:00`, fact: `Fact ${n}.` }],
  rule: { when: `When ${n}`, do: `Do ${n}`, this_game: `Seen ${n} times.` },
  ...extra,
});
const review = (extra: Partial<DeepReview> = {}): DeepReview => ({
  schema: 'dota2.ai/deep-review@1', match_id: 7, hero: 'axe', lang: 'en',
  verdict: 'The whole game in one sentence.', mainline: ['0:00–10:00: the lane.', '10:00–20:00: the map.'],
  findings: [finding(1), finding(2), finding(3)], did_well: ['Last hits.'], next_game: ['When 1: Do 1'], blind_spots: ['Creep positions.'],
  ...extra,
} as DeepReview);
const show = (r: DeepReview, props: Partial<React.ComponentProps<typeof ReviewDoc>> = {}) => render(<ReviewDoc matchId="7" review={r} lang="en" onAsk={() => {}} {...props} />);

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'not_found' }), { status: 404 }))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ReviewDoc: one lesson first', () => {
  it('the first finding is the headline, with its claim, its rule and its moments', () => {
    show(review());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Finding 1');
    expect(document.querySelector('.ag-lead .cx-eyebrow')!.textContent).toBe('The one thing to change');
    expect(document.querySelector('.ag-lead-claim')!.textContent).toBe('Claim 1.');
    const lesson = within(screen.getByRole('heading', { level: 2, name: 'Practise this next game' }).closest('section')!);
    expect(lesson.getByText('When 1')).toBeTruthy();
    expect(lesson.getByText('Do 1')).toBeTruthy();
    expect(lesson.getByText('Seen 1 times.')).toBeTruthy();
    expect(lesson.getByText('Fix 1.')).toBeTruthy();
    const moments = within(screen.getByRole('heading', { level: 2, name: 'The moments that show it' }).closest('section')!);
    expect(moments.getByText('Fact 1.')).toBeTruthy();
    // Only the first finding's: the others keep theirs.
    expect(moments.queryByText('Fact 2.')).toBeNull();
  });

  it('the other findings fold under it, numbered from 2, each whole', () => {
    show(review());
    const more = screen.getByRole('heading', { level: 2, name: 'Two more things' }).closest('section')!;
    const folds = Array.from(more.querySelectorAll('details.ag-finding')) as HTMLDetailsElement[];
    expect(folds.map((d) => d.querySelector('summary')!.textContent)).toEqual(['2Finding 2', '3Finding 3']);
    expect(folds.every((d) => !d.open)).toBe(true);
    const second = within(folds[0]);
    expect(second.getByText('Claim 2.')).toBeTruthy();
    expect(second.getByText('Fact 2.')).toBeTruthy();
    expect(second.getByText('When 2')).toBeTruthy();
    expect(second.getByText('Fix 2.')).toBeTruthy();
    // The first finding is not repeated among them.
    expect(more.textContent).not.toContain('Finding 1');
  });

  it('says "one more thing" for two findings, and nothing more for one', () => {
    show(review({ findings: [finding(1), finding(2)] }));
    expect(screen.getByRole('heading', { level: 2, name: 'One more thing' })).toBeTruthy();
    cleanup();
    show(review({ findings: [finding(1)] }));
    expect(screen.queryByRole('heading', { level: 2, name: /more thing/ })).toBeNull();
    expect(document.querySelectorAll('details.ag-finding')).toHaveLength(0);
  });

  it('a first finding without a rule still gives its fix as what to practise; without either there is no lesson block', () => {
    show(review({ findings: [finding(1, { rule: undefined })] }));
    const lesson = screen.getByRole('heading', { level: 2, name: 'Practise this next game' }).closest('section')!;
    expect(lesson.textContent).toContain('Fix 1.');
    expect(lesson.querySelector('.ag-rule')).toBeNull();
    cleanup();
    show(review({ findings: [finding(1, { rule: undefined, fix: '' })] }));
    expect(screen.queryByRole('heading', { level: 2, name: 'Practise this next game' })).toBeNull();
  });

  it('the sentence about the whole game stands with the whole game, after the findings; the story folds', () => {
    show(review(), { board: <div role="region" aria-label="Scoreboard">board</div>, share: <div data-testid="share">share</div> });
    const whole = screen.getByRole('heading', { level: 2, name: 'The whole game' }).closest('section')!;
    expect(whole.querySelector('.ag-verdict')!.textContent).toBe('The game in one sentenceThe whole game in one sentence.');
    const folds = Array.from(whole.querySelectorAll('details.ag-fold')) as HTMLDetailsElement[];
    expect(folds.map((d) => d.querySelector('summary h3')!.textContent)).toEqual(['How the game went', 'Line-ups and scoreboard']);
    expect(folds[0].querySelector('summary')!.textContent).toBe('How the game went2 parts');
    expect(folds.every((d) => !d.open)).toBe(true);
    expect(within(folds[1]).getByRole('region', { name: 'Scoreboard' })).toBeTruthy();
    // Order down the page: the lesson, the other findings, what went well, sharing, the whole game, what could not be seen.
    const order = ['Practise this next game', 'The moments that show it', 'Two more things', 'What you did well', 'The whole game', 'What the replay could not show'];
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(order);
    const share = screen.getByTestId('share');
    expect(screen.getByRole('heading', { level: 2, name: 'What you did well' }).compareDocumentPosition(share) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(share.compareDocumentPosition(whole) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the list that repeated the rules is gone: each rule is read with its finding', () => {
    show(review());
    expect(document.querySelector('.ag-next')).toBeNull();
    expect(screen.queryByText('When 1: Do 1')).toBeNull();
  });

  it('a review left with no finding leads with the sentence about the game, said once', () => {
    show(review({ findings: [] }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('The whole game in one sentence.');
    expect(document.querySelector('.ag-lead .cx-eyebrow')!.textContent).toBe('The game in one sentence');
    expect(document.querySelector('.ag-verdict')).toBeNull();
    expect(screen.queryByRole('heading', { level: 2, name: 'Practise this next game' })).toBeNull();
  });

  it('the patch the numbers are from stays with the headline, and a patch that could not be told is still a note', () => {
    show(review({ data_patch: { name: '7.42', exact: true, known_from: 'start_time' } } as Partial<DeepReview>));
    expect(document.querySelector('.ag-lead .ag-patch')!.textContent).toContain('7.42');
    cleanup();
    show(review({ data_patch: { name: '7.42', exact: false, reason: 'not_known' } } as Partial<DeepReview>));
    expect(within(document.querySelector('.ag-lead') as HTMLElement).getByRole('note').textContent).toContain('could not be told');
  });

  it('Chinese: the same structure in the reader\'s language', () => {
    render(<ReviewDoc matchId="7" review={review({ lang: 'zh' })} lang="zh" onAsk={() => {}} />);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['下局只练这一件', '这局的几个时刻', '还有两件事', '做得好的', '整局', '录像看不到的']);
    expect(document.querySelector('.ag-lead .cx-eyebrow')!.textContent).toBe('这局最该改的一件事');
    expect(document.querySelector('details.ag-fold summary')!.textContent).toBe('对局主线2 段');
  });
});

describe('ReviewDoc: zero mechanical KPIs & first-principles coach layout', () => {
  const coachReview = (extra: Partial<DeepReview> = {}): DeepReview => ({
    ...review(),
    verdict: 'Strong teamfight presence across the match, with Primal Roar target selection deciding the late game.',
    opening_note: 'You stayed composed in a difficult draft and attended nearly every fight. Most of the mid-game stall was team-wide tower conversion, not your play alone.',
    highlights: [
      {
        title: 'Decisive BKB-piercing Roar at 27:27',
        detail: 'You immediately stopped Phantom Assassin through spell immunity for 3.4 s.',
        evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], clock: '27:27', fact: '27:27 stunned PA for 3.4 s.' }],
      },
    ],
    chapters: [
      {
        topic: 'skill_build',
        title: 'Clean skill progression',
        assessment: 'praise',
        analysis: 'Maxed core laning spells by level 10 and upgraded Roar on schedule.',
        evidence: [{ refs: ['skill_build:beastmaster'], clock: '7:28', fact: 'Learned Roar at 7:28.' }],
      },
      {
        topic: 'items',
        title: 'Missing initiation item after Aghanim\'s',
        assessment: 'key_gap',
        analysis: 'Without Blink Dagger or Black King Bar, reaching the enemy carry first was difficult.',
        takeaway: 'Prioritize Blink Dagger or Black King Bar right after Aghanim\'s.',
        evidence: [{ refs: ['pro_items:beastmaster'], fact: 'Pro games frequently add Blink or BKB.' }],
      },
    ],
    encouragement: 'Your fight attendance and 27:27 execution already show strong offlane instincts.',
    game_plan: { main_reason: 'team_play', why: 'Team did not convert won fights into towers.', evidence: [] },
    ...extra,
  });

  it('renders opening note, highlights with evidence, adaptive chapters, improvements, and encouragement without duplicating verdict', () => {
    show(coachReview(), { board: <div role="region" aria-label="Scoreboard">board</div>, share: <div data-testid="share">share</div> });
    expect(document.querySelector('.ag-lead .cx-eyebrow')!.textContent).toBe("Coach's review");
    expect(document.querySelector('.ag-lead-reason')!.textContent).toBe('Mostly the team, not you');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Strong teamfight presence across the match, with Primal Roar target selection deciding the late game.');
    expect(document.querySelector('.ag-opening')!.textContent).toContain('difficult draft');
    // Highlights sit right below the coach header with evidence cards.
    const highlights = screen.getByRole('heading', { level: 2, name: 'What you did well' }).closest('section')!;
    expect(highlights.textContent).toContain('Decisive BKB-piercing Roar at 27:27');
    expect(highlights.querySelector('.ag-ev-clock')!.textContent).toBe('27:27');
    // Chapters show topic tags, assessment badges, optional takeaway, and folded records.
    const chapters = screen.getByRole('heading', { level: 2, name: 'Match breakdown' }).closest('section')!;
    const cards = chapters.querySelectorAll('.ag-chapter');
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector('.ag-chapter-topic')!.textContent).toBe('Skill build');
    expect(cards[0].querySelector('.ag-chapter-badge')!.textContent).toBe('Standout');
    expect(cards[0].querySelector('.ag-chapter-takeaway')).toBeNull();
    expect(cards[1].querySelector('.ag-chapter-topic')!.textContent).toBe('Item build');
    expect(cards[1].querySelector('.ag-chapter-badge')!.textContent).toBe('Key focus');
    expect(cards[1].querySelector('.ag-chapter-takeaway')!.textContent).toContain('Prioritize Blink Dagger');
    expect(cards[1].querySelector('.ag-chapter-records summary')!.textContent).toBe('Records · 1');
    // Key improvements show lead finding open and rest folded.
    const improvements = screen.getByRole('heading', { level: 2, name: 'Key improvements' }).closest('section')!;
    expect(improvements.querySelector('.ag-finding.is-lead h3')!.textContent).toBe('1Finding 1');
    expect(improvements.querySelectorAll('details.ag-finding')).toHaveLength(2);
    // Closing encouragement card.
    expect(document.querySelector('.ag-encouragement p')!.textContent).toContain('strong offlane instincts');
    // Verdict is already H1, so not duplicated inside Whole Game.
    expect(document.querySelector('.ag-whole .ag-verdict')).toBeNull();
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'What you did well', 'Match breakdown', 'Key improvements', "Coach's note", 'The whole game', 'What the replay could not show',
    ]);
  });

  it('spotless win with zero findings omits the improvements section cleanly and renders Chinese & Russian labels', () => {
    render(<ReviewDoc matchId="7" review={coachReview({ lang: 'zh', findings: [] })} lang="zh" onAsk={() => {}} />);
    expect(document.querySelector('.ag-lead .cx-eyebrow')!.textContent).toBe('教练总评');
    expect(document.querySelector('.ag-improvements')).toBeNull();
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      '本局亮点与肯定', '全维度复盘', '教练寄语', '整局', '录像看不到的',
    ]);
    expect(document.querySelector('.ag-chapter-topic')!.textContent).toBe('技能加点');
    expect(document.querySelector('.ag-chapter-badge')!.textContent).toBe('本局亮点');
    cleanup();
    render(<ReviewDoc matchId="7" review={coachReview({ lang: 'ru', findings: [] })} lang="ru" onAsk={() => {}} />);
    expect(document.querySelector('.ag-lead .cx-eyebrow')!.textContent).toBe('Разбор тренера');
    expect(document.querySelector('.ag-chapter-topic')!.textContent).toBe('Раскачка');
  });

  it('never renders GoalCard or ag-rule-check even when a legacy stored review carries goal and rule.check', () => {
    const legacyWithKpis = review({
      findings: [finding(1, { rule: { when: 'When 1', do: 'Do 1', this_game: 'Seen 1 times.', check: { kind: 'replay_habit', habit: 'low_health', max: 1, baseline: 3, label: { en: 'At most 1 low HP death', zh: '下一盘不超过 1 次' } } as any } })],
      goal: { kind: 'deaths_per10_max', max: 1.7, label: { en: 'At most 1.7 deaths per 10 minutes', zh: '每 10 分钟阵亡不超过 1.7 次' }, finding: 1 } as any,
    });
    show(legacyWithKpis);
    expect(document.querySelector('.ag-goal')).toBeNull();
    expect(document.querySelector('.ag-next')).toBeNull();
    expect(document.querySelector('.ag-rule-check')).toBeNull();
    expect(screen.queryByText(/Make this my next-game goal/)).toBeNull();
    expect(screen.queryByText(/At most 1 low HP death/)).toBeNull();
    expect(screen.queryByText(/At most 1\.7 deaths/)).toBeNull();
    // Normal rule coaching cue still renders cleanly without the KPI quota line.
    expect(screen.getByText('When 1')).toBeTruthy();
    expect(screen.getByText('Do 1')).toBeTruthy();
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

  it('shows nothing when moments could not be read (net_worth_only) or no fight lost win chance with full coverage', async () => {
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


describe('ReviewDoc: the story as a chain of causes (#437 P4)', () => {
  const story: DeepReview['story'] = [
    { phase: '0:00–10:00, the lane', what_changed: 'Down 5126 in the lane.', because: 'Seven deaths to roams, not last hits.', whose: 'me', evidence: [{ refs: ['lane:axe'], clock: '10:00', fact: 'Kills and assists −4818.' }] },
    { phase: '24:00–27:47, the turn', what_changed: '+199 became −16541.', because: 'Two fights lost with five against four.', whose: 'team', evidence: [] },
  ];

  it('each link shows its stretch, what changed, why and whose it was, with its records folded under it', () => {
    show(review({ story }));
    const links = document.querySelectorAll('.ag-story > ol > li');
    expect(links).toHaveLength(2);
    expect(links[0].querySelector('.ag-story-head')!.textContent).toBe('0:00–10:00, the laneYou');
    expect(links[0].querySelector('.ag-story-what')!.textContent).toBe('Down 5126 in the lane.');
    expect(links[0].querySelector('.ag-story-why')!.textContent).toBe('BecauseSeven deaths to roams, not last hits.');
    expect(links[0].querySelector('.ag-story-records summary')!.textContent).toBe('Records · 1');
    expect(links[1].querySelector('.ag-story-whose')!.textContent).toBe('Team');
    // A link with no records left shows none.
    expect(links[1].querySelector('.ag-story-records')).toBeNull();
    // The one-line phases are not shown twice.
    expect(document.querySelector('.ag-mainline')).toBeNull();
  });

  it('in Chinese the labels are Chinese', () => {
    render(<ReviewDoc matchId="7" review={review({ story, lang: 'zh' })} lang="zh" onAsk={() => {}} />);
    expect(document.querySelector('.ag-story-whose')!.textContent).toBe('你');
    expect(document.querySelector('.ag-story-why span')!.textContent).toBe('原因');
  });

  it('a review written before it keeps its one-line phases', () => {
    show(review());
    expect(document.querySelector('.ag-story')).toBeNull();
    expect(document.querySelectorAll('.ag-mainline li')).toHaveLength(2);
  });

  it('tolerates malformed non-array or null-element collections without throwing', () => {
    const malformed = review({
      opening_note: 123 as any,
      encouragement: null as any,
      highlights: {} as any,
      chapters: 'bad' as any,
      findings: [null as any, { title: 'Valid', claim: 'Valid claim', evidence: 'bad' as any, fix: 'Do x' }],
      did_well: {} as any,
      mainline: 'bad' as any,
      blind_spots: 42 as any,
    });
    expect(() => show(malformed)).not.toThrow();
    expect(screen.getByText('Valid')).toBeTruthy();
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

  it('omits the usage footer cleanly on legacy reviews without runMeta', () => {
    show(review());
    expect(document.querySelector('footer.ag-usage')).toBeNull();
  });
});
