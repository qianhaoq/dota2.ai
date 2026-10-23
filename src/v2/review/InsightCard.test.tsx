// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { buildReview } from '../../../packages/review-engine/src/index.js';
import { I18nProvider } from '../i18n/I18nProvider';
import InsightCard, { cardConclusion } from './InsightCard';
import type { Review } from './types';

const raw = JSON.parse(readFileSync('src/fixtures/match9035042364.parsed.json', 'utf8'));
function review(lang: 'en' | 'zh' = 'zh'): Review {
  return buildReview(raw, { heroId: 14, lang, fetchedAt: '2026-10-17T00:00:00Z' }) as unknown as Review;
}
function wrap(ui: React.ReactElement, lang: 'en' | 'zh' = 'zh') {
  return render(
    <MemoryRouter initialEntries={[`/m/9035042364?hero=pudge&lang=${lang}`]}>
      <I18nProvider>{ui}</I18nProvider>
    </MemoryRouter>,
  );
}

afterEach(() => cleanup());

describe('cardConclusion fallback', () => {
  it('keeps short engine conclusions intact', () => {
    const r = review('zh');
    expect(cardConclusion(r.insights[1])).toBe('落后时优先减少无收益的交战。');
    expect(cardConclusion(r.insights[0])).toContain('优先回看');
    expect(cardConclusion(r.insights[2])).toBe('优先练习稳定补刀与安全获取资源。');
  });
  it('splits legacy multi-sentence fix_this claims', () => {
    expect(cardConclusion({
      id: 'fix_this', status: 'ok', claim: { text: '经济落后超过一千时死亡 10 次；共 11 次。落后时优先减少无收益的交战。', phrasing: 'template' },
      fact_ids: [], metrics: [], citations: [],
    })).toBe('落后时优先减少无收益的交战。');
  });
});

describe('InsightCard hierarchy for 9035042364', () => {
  it('zh: conclusion / localized killers / details without slug aggregate', () => {
    const r = review('zh');
    wrap(<>{r.insights.map((insight, i) => (
      <InsightCard key={insight.id} insight={insight} review={r} index={i + 1} streaming={false} />
    ))}</>, 'zh');

    expect(screen.getAllByTestId('insight-card')).toHaveLength(3);

    expect(screen.getByText('落后时优先减少无收益的交战。')).toBeTruthy();
    expect(screen.getByText(/优先回看/)).toBeTruthy();
    expect(screen.getByText('优先练习稳定补刀与安全获取资源。')).toBeTruthy();
    expect(screen.queryByText(/doom_bringer/)).toBeNull();
    expect(screen.queryByText(/skeleton_king/)).toBeNull();

    expect(screen.getAllByTestId('killer-row').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText('冥魂大帝')).toBeTruthy();
    expect(screen.getByText('狙击手')).toBeTruthy();

    expect(screen.getAllByText('结论').length).toBe(3);
    expect(screen.getAllByText('对位').length).toBe(3);
    expect(screen.getAllByText('明细').length).toBeGreaterThanOrEqual(1);

    expect(screen.getByText('经济崩盘窗口')).toBeTruthy();
    expect(screen.getByText(r.facts['gold.low'].display.zh + ' · ' + r.facts['gold.low'].display.t)).toBeTruthy();
  });

  it('en: uses English hero names in matchup', () => {
    const r = review('en');
    wrap(<InsightCard insight={r.insights[1]} review={r} index={2} streaming={false} />, 'en');
    expect(screen.getByText('Prioritize avoiding low-value fights while behind.')).toBeTruthy();
    expect(screen.getByText('Wraith King')).toBeTruthy();
    expect(screen.getByText('Doom')).toBeTruthy();
    expect(screen.queryByText(/doom_bringer/)).toBeNull();
  });
});
