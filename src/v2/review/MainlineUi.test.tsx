// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '../i18n/I18nProvider';
import InsightCard from './InsightCard';
import { MiniChart } from './ConversationCards';
import PracticeGoals from './PracticeGoals';
import ReviewTimelines from './ReviewTimelines';
import type { Insight, Review } from './types';

afterEach(cleanup);

const renderWithI18n = (ui: React.ReactElement, lang: 'en' | 'zh' = 'en') =>
    render(<MemoryRouter initialEntries={[`/?lang=${lang}`]}><I18nProvider>{ui}</I18nProvider></MemoryRouter>);

const windowInsight: Insight = {
    id: 'window.1', kind: 'review_window', status: 'ok', title: '决策窗口 1（8:15）：阵亡与后续',
    time: { from: 495, to: 736 }, claim: { text: '8:15 你被帕吉以肢解击杀；11:21 夜魇下路一塔被天辉摧毁。', phrasing: 'template' },
    sections: [
        { label_key: 'known', text: '8:15 前我方摧毁对方建筑 0 处。' },
        { label_key: 'actions', text: '8:15 你被帕吉以肢解击杀。' },
        { label_key: 'missing', text: '本局没有英雄状态样本。' },
        { label_key: 'evaluation', text: '评价（基于上述证据，不做因果推断）。' },
    ],
    fact_ids: ['death.3'], metrics: [], citations: ['r1'],
};

describe('mainline insight card sections', () => {
    it.each(['en', 'zh'] as const)('labels the layered sections (%s)', lang => {
        renderWithI18n(<InsightCard insight={windowInsight} index={2} streaming={false}/>, lang);
        const sections = screen.getAllByTestId('card-section');
        expect(sections.map(s => s.getAttribute('data-section'))).toEqual(['known', 'actions', 'missing', 'evaluation']);
        const labels = { en: ['What was known then', 'What happened', 'Evidence gaps', 'Assessment (no causal claims)'], zh: ['当时已知', '发生的事', '证据缺口', '评价（不做因果推断）'] }[lang];
        for (const label of labels) expect(screen.getByText(label)).toBeTruthy();
    });

    it('keeps old-shape cards free of the sections block', () => {
        renderWithI18n(<InsightCard insight={{ ...windowInsight, id: 'turning_point', sections: undefined }} index={1} streaming={false}/>, 'en');
        expect(screen.queryByTestId('card-sections')).toBeNull();
    });
});

describe('practice block', () => {
    it('renders proven goals with checkable conditions', () => {
        renderWithI18n(<PracticeGoals practice={{ status: 'proven', items: [{ goal: '开黑皇杖前先看死亡窗口。', condition: '下一局出现同类窗口时核对（时序相关，非因果）。', fact_ids: ['state.win.1'] }], note: null }}/>);
        const block = screen.getByTestId('practice-block');
        expect(block.getAttribute('data-status')).toBe('proven');
        expect(block.textContent).toContain('开黑皇杖前先看死亡窗口。');
        expect(block.textContent).toContain('时序相关，非因果');
    });

    it('renders only the cannot-prove note when insufficient', () => {
        renderWithI18n(<PracticeGoals practice={{ status: 'insufficient', items: [], note: '本局证据不足，无法给出可验证的练习目标。' }}/>);
        const block = screen.getByTestId('practice-block');
        expect(block.getAttribute('data-status')).toBe('insufficient');
        expect(block.textContent).toContain('本局证据不足');
        expect(screen.queryByText('开黑皇杖前先看死亡窗口。')).toBeNull();
    });
});

describe('mini chart series labels', () => {
    it('labels a net-worth-only series under its own name, never as gold', () => {
        const series = { radiant_gold_adv: [], radiant_xp_adv: [], radiant_net_worth_adv: [100, -200, 300] } as Review['series'];
        renderWithI18n(<MiniChart series={series}/>);
        expect(screen.getByRole('img')).toBeTruthy();
        expect(screen.queryByText('Gold')).toBeNull();
        expect(screen.queryByText('XP')).toBeNull();
    });

    it('renders nothing when no series has data', () => {
        const { container } = renderWithI18n(<MiniChart series={{ radiant_gold_adv: [], radiant_xp_adv: [] } as Review['series']}/>);
        expect(container.querySelector('svg')).toBeNull();
    });
});

describe('consolidated gap list', () => {
    it('labels known topics and never prints raw field keys', () => {
        const review = {
            series: { radiant_gold_adv: [], radiant_xp_adv: [] },
            data_gaps: [
                { topic: 'hero_states', reason: 'hero_states_not_in_artifact' },
                { topic: 'net_worth_t', reason: 'missing' },
                { topic: 'patch', reason: 'missing_match_patch' },
            ],
        } as unknown as Review;
        renderWithI18n(<ReviewTimelines review={review}/>, 'zh');
        const list = screen.getByTestId('gap-list');
        expect(list.textContent).toContain('英雄状态样本');
        expect(list.textContent).toContain('版本号');
        expect(list.textContent).not.toMatch(/net_worth_t|hero_states|source_path|trace\//);
        // No state samples anywhere: the HP/positions-absent note stays.
        expect(document.body.textContent).toContain('缺少血量、视野和队友实时位置');
    });

    it('does not claim HP and positions are missing once windows cite state samples', () => {
        const review = {
            series: { radiant_gold_adv: [], radiant_xp_adv: [] },
            insights: [{ id: 'window.1', kind: 'review_window', fact_ids: ['state.win.1.night_stalker'] }],
            data_gaps: [{ topic: 'creep_waves', reason: 'states_have_no_creep_entities' }],
        } as unknown as Review;
        renderWithI18n(<ReviewTimelines review={review}/>, 'zh');
        expect(document.body.textContent).not.toContain('缺少血量、视野和队友实时位置');
        // The honest remaining gaps (vision / creep entities) are still named.
        expect(document.body.textContent).toContain('视野与兵线实体不在本记录里');
    });
});
