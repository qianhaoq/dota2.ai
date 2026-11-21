// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { buildCoachReport } from '../../lib/coach/analyze.js';

vi.mock('../v2/i18n/I18nProvider', () => ({ useI18n: () => ({ lang: 'zh', setLang: () => {} }) }));
const load = (f: string) => JSON.parse(readFileSync(path.join(process.cwd(), 'src/fixtures/coach', f), 'utf8'));
let report: ReturnType<typeof buildCoachReport> = buildCoachReport(load('match9091400302.unparsed.json'));
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  fetchCoachReport: async () => report,
  fetchCoachCases: () => new Promise(() => {}),
}));
const { CoachReportPage } = await import('./CoachApp');

afterEach(cleanup);

const page = (slot: number) => render(
  <MemoryRouter initialEntries={[`/r/9091400302?p=${slot}`]}>
    <Routes><Route path="/r/:matchId" element={<CoachReportPage />} /></Routes>
  </MemoryRouter>,
);

describe('matchups with public games at your rank', () => {
  it('unparsed match: shows the matchups card with the bracket numbers and a STRATZ credit link', async () => {
    report = buildCoachReport(load('match9091400302.unparsed.json'));
    const { container } = page(0); // Tidehunter, rank tier 42
    await waitFor(() => expect(container.querySelector('.cx-matchups')).toBeTruthy());
    const box = container.querySelector('.cx-matchups')!;
    expect(box.querySelectorAll('li')).toHaveLength(5);
    expect(box.textContent).toContain('中军–统帅路人局');
    const link = box.querySelector('.cx-mu-credit a') as HTMLAnchorElement;
    expect(link.textContent).toBe('STRATZ');
    expect(link.href).toBe('https://stratz.com/');
    expect(link.rel).toContain('noopener');
  });

  it('no medal in the match: no rank row and no credit line, pro numbers only', async () => {
    const m = load('match9091400302.unparsed.json');
    for (const p of m.players) p.rank_tier = null;
    report = buildCoachReport(m);
    const { container } = page(0);
    await waitFor(() => expect(container.querySelector('.cx-lineup')).toBeTruthy());
    expect(container.querySelector('.cx-mu-rank')).toBeNull();
    expect(container.querySelector('.cx-mu-credit')).toBeNull();
  });
});
