// @vitest-environment jsdom
/** PR7 wiring: InsightCard Evidence button → sheet/panel, URL claim/view sync,
 * deep link, Esc close + focus return. Component internals live in
 * src/v2/evidence/Evidence.test.tsx. */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { buildReview } from '../../../packages/review-engine/src/index.js';
import MatchPage from './MatchPage';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Review } from '../review/types';
vi.mock('../../services/analytics', () => ({ trackEvent: vi.fn() }));

const raw = JSON.parse(readFileSync('src/fixtures/match9035042364.parsed.json', 'utf8'));
const review = buildReview(raw, { heroId: 14, lang: 'en', fetchedAt: '2026-10-17T00:00:00Z' }) as unknown as Review;

function LocationProbe() {
    const location = useLocation();
    return <output data-testid="location">{location.search}</output>;
}

function page(route: string) {
    // JSON for every request: the SSE attempt fails the content-type check and
    // useReviewStream falls back to the JSON review (same payload).
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(review), { headers: { 'Content-Type': 'application/json' } }))));
    return render(<MemoryRouter initialEntries={[route]}><I18nProvider><LocationProbe /><Routes><Route path="/m/:matchId?" element={<MatchPage />}/></Routes></I18nProvider></MemoryRouter>);
}

afterEach(cleanup);

describe('MatchPage evidence wiring', () => {
    it('opens the sheet from an InsightCard, pages, syncs the URL and closes on Esc with focus return', async () => {
        page('/m/9035042364?hero=pudge&lang=en');
        const buttons = await screen.findAllByRole('button', { name: 'Evidence' });
        expect(buttons.length).toBe(3);
        fireEvent.click(buttons[1]);
        const dialog = await screen.findByRole('dialog', { name: 'Evidence' });
        expect(screen.getByTestId('evidence-body').getAttribute('data-claim')).toBe('1');
        await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('claim=2'));
        expect(screen.getByTestId('location').textContent).toContain('view=evidence');
        // Pager → claim 3, URL follows.
        fireEvent.click(within(dialog).getByRole('button', { name: 'Next insight' }));
        await waitFor(() => expect(screen.getByTestId('evidence-body').getAttribute('data-claim')).toBe('2'));
        expect(screen.getByTestId('location').textContent).toContain('claim=3');
        // Esc closes and clears the evidence params.
        fireEvent.keyDown(document, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Evidence' })).toBeNull(), { timeout: 2000 });
        expect(screen.getByTestId('location').textContent).not.toContain('view=evidence');
        expect(screen.getByTestId('location').textContent).not.toContain('claim=');
        await waitFor(() => expect(document.activeElement).toBe(buttons[1]));
    });

    it('deep link ?claim=2&view=evidence opens that claim once the review is ready', async () => {
        page('/m/9035042364?hero=pudge&lang=en&claim=2&view=evidence');
        const dialog = await screen.findByRole('dialog', { name: 'Evidence' });
        expect(dialog).toBeTruthy();
        await waitFor(() => expect(within(dialog).getByTestId('evidence-body').getAttribute('data-claim')).toBe('1'));
        expect(within(dialog).getByTestId('evidence-body').textContent).toContain('Who killed you');
    });

    it('zh deep link renders localized evidence', async () => {
        page('/m/9035042364?hero=pudge&lang=zh&claim=1&view=evidence');
        const dialog = await screen.findByRole('dialog', { name: '证据' });
        await waitFor(() => expect(within(dialog).getByTestId('evidence-body').textContent).toContain('关键时刻'));
    });

    it('opens claim 1 when view=evidence has no claim (engine evidence_url)', async () => {
        page('/m/9035042364?hero=pudge&lang=en&view=evidence');
        const dialog = await screen.findByRole('dialog', { name: 'Evidence' });
        await waitFor(() => expect(within(dialog).getByTestId('evidence-body').getAttribute('data-claim')).toBe('0'));
        expect(within(dialog).getByTestId('evidence-body').textContent).toContain('Key moments');
    });
});
