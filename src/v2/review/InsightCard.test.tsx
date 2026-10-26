// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { buildReview } from '../../../packages/review-engine/src/index.js';
import { I18nProvider } from '../i18n/I18nProvider';
import InsightCard, {
  cardConclusion,
  detailFactLabelKey,
  goldWindowLabelKey,
  windowDelta,
} from './InsightCard';
import type { Fact, Review } from './types';

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
  it.each(['en', 'zh'] as const)('keeps numbered engine conclusions intact in %s', lang => {
    const r = review(lang);
    for (const insight of r.insights) expect(cardConclusion(insight)).toBe(insight.claim.text);
    expect(cardConclusion(r.insights[1])).toContain('16/19');
    expect(cardConclusion(r.insights[2])).toContain('−2,060');
  });
  it('splits legacy multi-sentence fix_this claims', () => {
    expect(cardConclusion({
      id: 'fix_this', status: 'ok', claim: { text: '经济落后超过一千时死亡 10 次；共 11 次。落后时优先减少无收益的交战。', phrasing: 'template' },
      fact_ids: [], metrics: [], citations: [],
    })).toBe('落后时优先减少无收益的交战。');
  });
});

describe('gold window label', () => {
  it('uses collapse only for a negative delta', () => {
    const neg: Fact = { id: 'gold.window.x', display: { en: '−1', zh: '−1' }, value: { delta: -100 }, citation: 's1', source_path: 'x' };
    const flat: Fact = { id: 'gold.window.y', display: { en: '0', zh: '0' }, value: { delta: 0 }, citation: 's1', source_path: 'y' };
    const pos: Fact = { id: 'gold.window.z', display: { en: '+1', zh: '+1' }, value: 250, citation: 's1', source_path: 'z' };
    expect(windowDelta(neg)).toBe(-100);
    expect(goldWindowLabelKey(neg)).toBe('cardGoldCollapse');
    expect(goldWindowLabelKey(flat)).toBe('cardGoldWorstWindow');
    expect(goldWindowLabelKey(pos)).toBe('cardGoldWorstWindow');
    expect(goldWindowLabelKey(undefined)).toBe('cardGoldWorstWindow');
  });

  it('maps detail fact ids to label keys', () => {
    expect(detailFactLabelKey('gold.low')).toBe('factGoldLow');
    expect(detailFactLabelKey('comeback.52_57.gold')).toBe('factRecoveryGold');
    expect(detailFactLabelKey('comeback.52_57.xp')).toBe('factRecoveryXp');
    expect(detailFactLabelKey('deaths.behind_1k')).toBe('factDeathsBehind');
    expect(detailFactLabelKey('deaths.total')).toBe('factDeathsTotal');
    expect(detailFactLabelKey('gold_fed')).toBe('goldFed');
    expect(detailFactLabelKey('time_dead')).toBe('timeDead');
    expect(detailFactLabelKey('unknown.metric')).toBeNull();
  });
});

describe('InsightCard hierarchy for 9035042364', () => {
  it('zh: conclusion / localized killers / labeled details without slug aggregate', () => {
    const r = review('zh');
    wrap(<>{r.insights.map((insight, i) => (
      <InsightCard key={insight.id} insight={insight} review={r} index={i + 1} streaming={false} />
    ))}</>, 'zh');

    expect(screen.getAllByTestId('insight-card')).toHaveLength(3);

    expect(screen.getByText('落后千金时死亡 16/19；重复击杀者含冥魂大帝。落后时优先减少无收益的交战。')).toBeTruthy();
    expect(screen.getByText(/优先回看/)).toBeTruthy();
    expect(screen.getByText('本局 10 分钟补刀 13、团队经济 −2,060。下一局 10 分钟补刀至少 13，经济落后控制在 2,060 金以内；未达标先安全发育。')).toBeTruthy();
    expect(screen.queryByText(/doom_bringer/)).toBeNull();
    expect(screen.queryByText(/skeleton_king/)).toBeNull();

    expect(screen.getAllByTestId('killer-row').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText('冥魂大帝')).toBeTruthy();
    expect(screen.getByText('狙击手')).toBeTruthy();

    expect(screen.getAllByText('结论').length).toBe(3);
    expect(screen.getAllByText('对位').length).toBe(3);
    expect(screen.getAllByText('明细').length).toBeGreaterThanOrEqual(1);

    // Negative window delta → collapse wording still applies for this fixture.
    expect(screen.getByText('经济崩盘窗口')).toBeTruthy();

    const low = r.facts['gold.low'];
    expect(screen.getByText((_, el) => el?.tagName === 'SPAN' && (el.textContent ?? '').includes('全局低点') && (el.textContent ?? '').includes(low.display.zh))).toBeTruthy();
    expect(screen.getByText((_, el) => el?.tagName === 'SPAN' && (el.textContent ?? '').includes('落后死亡') && (el.textContent ?? '').includes(String(r.facts['deaths.behind_1k'].display.zh)))).toBeTruthy();
    expect(screen.getByText((_, el) => el?.tagName === 'SPAN' && (el.textContent ?? '').includes('总死亡') && (el.textContent ?? '').includes(String(r.facts['deaths.total'].display.zh)))).toBeTruthy();
  });

  it('en: uses English hero names in matchup', () => {
    const r = review('en');
    wrap(<InsightCard insight={r.insights[1]} review={r} index={2} streaming={false} />, 'en');
    expect(screen.getByText('Deaths while behind: 16/19; repeated killer includes Wraith King. Prioritize avoiding low-value fights while behind.')).toBeTruthy();
    expect(screen.getByText('Wraith King')).toBeTruthy();
    expect(screen.getByText('Doom')).toBeTruthy();
    expect(screen.queryByText(/doom_bringer/)).toBeNull();
  });

  it('zh: flat/positive window uses neutral worst-window label', () => {
    const r = review('zh');
    const insight = structuredClone(r.insights[0]);
    const winId = 'gold.window.flat';
    const flatWin: Fact = {
      id: winId,
      value: { start: 100, end: 200, delta: 100, start_minute: 10, end_minute: 15 },
      display: { en: '+100', zh: '+100', t: '10:00–15:00' },
      citation: 's1',
      source_path: 'test',
    };
    const patched: Review = {
      ...r,
      facts: {
        ...r.facts,
        [winId]: flatWin,
        [`${winId}.delta`]: { id: `${winId}.delta`, value: 100, display: { en: '+100', zh: '+100', t: '15:00' }, citation: 's1', source_path: 'test' },
      },
    };
    insight.metrics = [{ fact_id: `${winId}.delta`, label_key: `${winId}.delta` }, ...insight.metrics.filter(m => !/^gold\.window\./.test(m.fact_id))];
    wrap(<InsightCard insight={insight} review={patched} index={1} streaming={false} />, 'zh');
    expect(screen.getByText('最差五分钟经济窗口')).toBeTruthy();
    expect(screen.queryByText('经济崩盘窗口')).toBeNull();
  });
});
