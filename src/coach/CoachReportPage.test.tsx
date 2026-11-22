// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  it('every player\'s final items are one click away, and the gold graph sits in "how the game swung"', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/r/9091400302?p=0']}>
        <Routes><Route path="/r/:matchId" element={<CoachReportPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(container.querySelector('.rv-head')).toBeTruthy());
    // The header strip switches between all ten; the full lineup with items opens on demand.
    expect(container.querySelectorAll('.rv-seat')).toHaveLength(10);
    expect(container.querySelector('.cx-lineup')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开 10 人详情' }));
    const seats = [...container.querySelectorAll('.cx-seat')];
    expect(seats).toHaveLength(10);
    seats.forEach((seat, i) => {
      const icons = seat.querySelectorAll('.cx-seat-items img, .cx-seat-items .cx-img-missing');
      expect(icons.length).toBe(report.players[i].items.length);
    });
    expect(screen.getAllByTitle('清莲宝珠').length).toBeGreaterThan(0);
    // Reading order: header, verdict, the next-game list, then the areas (the graph is in the first one).
    const order = [...container.querySelectorAll('.rv-head, .rv-verdict, #cx-ch-plan, .rv-sections')].map((e) => e.classList[0]);
    expect(order).toEqual(['rv-head', 'rv-verdict', 'rv-next', 'rv-sections']);
    expect(container.querySelector('#rv-sec-story .cx-graph')).toBeTruthy();
    // Labels are HTML (not stretched SVG text): 10-minute ticks and the range.
    const ticks = [...container.querySelectorAll('.cx-graph-axis span')].map((e) => e.textContent);
    expect(ticks).toEqual(['0′', '10′', '20′', '30′', '40′']);
    expect(container.querySelector('.cx-graph-y')?.textContent).toMatch(/^\+[\d.]+k0−[\d.]+k$/);
  });
});
