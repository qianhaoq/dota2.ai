// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { buildCoachReport } from '../../lib/coach/analyze.js';

vi.mock('../v2/i18n/I18nProvider', () => ({ useI18n: () => ({ lang: 'zh', setLang: () => {} }) }));
const load = (f: string) => JSON.parse(readFileSync(path.join(process.cwd(), 'src/fixtures/coach', f), 'utf8'));
const parsed = buildCoachReport(load('match9091400302.parsed.json'));
const unparsed = buildCoachReport(load('match9091400302.unparsed.json'));

const fetchReport = vi.fn();
const parse = vi.fn();
const matchup = vi.fn();
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  fetchCoachReport: (...a: unknown[]) => fetchReport(...a),
  fetchCoachCases: () => new Promise(() => {}),
  requestParse: (...a: unknown[]) => parse(...a),
  fetchMatchup: (...a: unknown[]) => matchup(...a),
}));
const { CoachReportPage } = await import('./CoachApp');

afterEach(() => { cleanup(); fetchReport.mockReset(); parse.mockReset(); matchup.mockReset(); });
const page = (url: string) => render(
  <MemoryRouter initialEntries={[url]}><Routes><Route path="/r/:matchId" element={<CoachReportPage />} /></Routes></MemoryRouter>,
);

describe('review page from the card surface (review #206)', () => {
  it('a pending parse keeps going when the reviewed player changes', async () => {
    fetchReport.mockResolvedValue(unparsed);
    parse.mockResolvedValue({ status: 'pending' });
    const { container } = page('/r/9091400302?p=4');
    await waitFor(() => expect(screen.getByRole('button', { name: '解析这场比赛' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '解析这场比赛' }));
    await waitFor(() => expect(screen.getByText(/已提交解析/)).toBeTruthy());
    const panel = container.querySelector('.cx-gaps--priority')!;
    // Switch to another player from the header's hero strip.
    fireEvent.click(container.querySelectorAll('.rv-seat')[0] as HTMLElement);
    await waitFor(() => expect(fetchReport).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(container.querySelector('.rv-headline')?.textContent).toBe(unparsed.reviews[0].headline.zh));
    // Same panel instance, still pending (not reset to the idle button).
    expect(container.querySelector('.cx-gaps--priority')).toBe(panel);
    expect(screen.getByText(/已提交解析/)).toBeTruthy();
  });

  it('a replay Valve no longer has: says so and takes the parse button away', async () => {
    fetchReport.mockResolvedValue(unparsed);
    parse.mockResolvedValue({ status: 'failed', provider: 'self_hosted', reason: 'replay_gone' });
    page('/r/9091400302?p=4');
    await waitFor(() => expect(screen.getByRole('button', { name: '解析这场比赛' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '解析这场比赛' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Valve 已不再保存这场比赛的录像（录像大约保留两周），无法解析这场比赛。'));
    expect(screen.queryByRole('button', { name: '解析这场比赛' })).toBeNull();
  });

  it('a failed parse says who failed: our own parser or OpenDota, and can be retried', async () => {
    fetchReport.mockResolvedValue(unparsed);
    parse.mockResolvedValueOnce({ status: 'failed', provider: 'self_hosted' }).mockResolvedValueOnce({ status: 'failed' });
    page('/r/9091400302?p=4');
    await waitFor(() => expect(screen.getByRole('button', { name: '解析这场比赛' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '解析这场比赛' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('解析没有成功，请一分钟后再试。'));
    fireEvent.click(screen.getByRole('button', { name: '解析这场比赛' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('OpenDota 没有接受请求，录像可能已过期。'));
  });

  it('a match parsed by our own parser is labelled so, without the "no timeline" note', async () => {
    fetchReport.mockResolvedValue({ ...parsed, match: { ...parsed.match, source: 'steam_gc' } });
    const { container } = page('/r/9091400302?p=0');
    await waitFor(() => expect(container.querySelector('.rv-sections')).toBeTruthy());
    expect(screen.getByText(/由 dota2\.ai 解析 Valve 录像/)).toBeTruthy();
    expect(screen.queryByText(/只有终局计分板/)).toBeNull();
  });

  it('opening pro cases scrolls to the requested theme section', async () => {
    fetchReport.mockResolvedValue(parsed);
    const scrolled: string[] = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.id); } as never;
    try {
      const { container } = page('/r/9091400302?p=0');
      await waitFor(() => expect(container.querySelector('.rv-sections')).toBeTruthy());
      const btn = screen.getAllByRole('button', { name: '同问题的职业对局' })[0];
      fireEvent.click(btn);
      await waitFor(() => expect(container.querySelector('#cx-ch-cases')).toBeTruthy());
      await waitFor(() => expect(scrolled.some((id) => id === 'cx-ch-cases' || id.startsWith('cx-case-'))).toBe(true));
      // A second click navigates again.
      scrolled.length = 0;
      fireEvent.click(btn);
      await waitFor(() => expect(scrolled.length).toBeGreaterThan(0));
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });

  it('parsed review: compare actions stay available next to the laning chapter, and open the brief', async () => {
    fetchReport.mockResolvedValue(parsed);
    matchup.mockResolvedValue({ lines: { en: ['Tidehunter vs Ursa'], zh: ['潮汐猎人 对 熊战士'] } });
    const { container } = page('/r/9091400302?p=0');
    await waitFor(() => expect(container.querySelector('#cx-ch-laning')).toBeTruthy());
    // The matchups card's compare actions live in the laning area, under its chapter.
    const card = container.querySelector('#rv-sec-laning .rv-compare') as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.querySelector('.cx-matchups')).toBeNull(); // the strip is in the laning chapter, not duplicated
    expect(container.querySelectorAll('#rv-sec-laning .cx-matchups')).toHaveLength(1);
    fireEvent.click(within(card).getByRole('button', { name: '对比 · 熊战士' }));
    await waitFor(() => expect(screen.getByText('潮汐猎人 对 熊战士')).toBeTruthy());
    expect(matchup).toHaveBeenCalledWith(29, 70, 'ca', expect.anything());
  });

  it('a question asked from a card carries that card as its context', async () => {
    fetchReport.mockResolvedValue(parsed);
    const { container } = page('/r/9091400302?p=0');
    await waitFor(() => expect(container.querySelector('.rv-sections')).toBeTruthy());
    const f = parsed.reviews[0].findings[0];
    const card = container.querySelector(`#card-finding-${f.id.replace(/[^a-z0-9_-]/gi, '-')}`) as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: '问教练' }));
    await waitFor(() => expect(screen.getByText(new RegExp(`当前围绕：${f.title.zh.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))).toBeTruthy());
  });
});
