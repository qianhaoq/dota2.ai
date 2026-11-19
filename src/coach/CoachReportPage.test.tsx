// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { buildCoachReport } from '../../lib/coach/analyze.js';

vi.mock('../v2/i18n/I18nProvider', () => ({ useI18n: () => ({ lang: 'zh', setLang: () => {} }) }));
const report = buildCoachReport(JSON.parse(readFileSync(path.join(process.cwd(), 'src/fixtures/coach/match9091400302.parsed.json'), 'utf8')));
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  fetchCoachReport: async () => report,
  fetchCoachCases: () => new Promise(() => {}),
}));
const { CoachReportPage } = await import('./CoachApp');

afterEach(cleanup);

describe('CoachReportPage header', () => {
  it('shows every player\'s final items in the lineup and the gold graph before the full review', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/r/9091400302?p=0']}>
        <Routes><Route path="/r/:matchId" element={<CoachReportPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(container.querySelector('.cx-lineup')).toBeTruthy());
    const seats = [...container.querySelectorAll('.cx-seat')];
    expect(seats).toHaveLength(10);
    seats.forEach((seat, i) => {
      const icons = seat.querySelectorAll('.cx-seat-items img, .cx-seat-items .cx-img-missing');
      expect(icons.length).toBe(report.players[i].items.length);
    });
    expect(screen.getAllByTitle('清莲宝珠').length).toBeGreaterThan(0);
    const order = [...container.querySelectorAll('.cx-lineup, .cx-graph, .cx-chapters')].map((e) => e.classList[0]);
    expect(order).toEqual(['cx-lineup', 'cx-graph', 'cx-chapters']);
    // Labels are HTML (not stretched SVG text): 10-minute ticks and the range.
    const ticks = [...container.querySelectorAll('.cx-graph-axis span')].map((e) => e.textContent);
    expect(ticks).toEqual(['0′', '10′', '20′', '30′', '40′']);
    expect(container.querySelector('.cx-graph-y')?.textContent).toMatch(/^\+[\d.]+k0−[\d.]+k$/);
  });
});
