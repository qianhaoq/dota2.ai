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
const { CoachReportPage, reportErrorCopy } = await import('./CoachApp');
const { CoachApiError } = await import('./api');

afterEach(() => { cleanup(); fetchReport.mockReset(); parse.mockReset(); matchup.mockReset(); });
const page = (url: string) => render(
  <MemoryRouter initialEntries={[url]}><Routes><Route path="/r/:matchId" element={<CoachReportPage />} /></Routes></MemoryRouter>,
);

describe('when the report does not load, the page says why', () => {
  // The codes lib/coach/router.js reportFor() sends, with their statuses.
  const cases: [string, number, RegExp, RegExp][] = [
    ['not_found', 404, /找不到这场比赛/, /does not know this match/],
    ['rate_limited', 429, /请求太频繁/, /too many requests/],
    ['insufficient', 422, /玩家数据还没准备好/, /player data is not available yet/],
    ['internal', 500, /这是我们这边的问题/, /fault is on our side/],
    ['upstream', 503, /OpenDota 暂时没有响应/, /did not answer in time/],
    ['upstream', 502, /OpenDota 暂时没有响应/, /did not answer in time/],
    ['network', 0, /连不上 dota2\.ai/, /Could not reach dota2\.ai/],
    ['invalid_match_id', 400, /不是一个比赛 ID/, /does not look like a match ID/],
  ];

  it.each(cases)('code %s (HTTP %i): its own message in both languages', (code, status, zh, en) => {
    const copy = reportErrorCopy({ code, status });
    expect(copy.zh).toMatch(zh);
    expect(copy.en).toMatch(en);
  });

  it('only a real upstream failure blames OpenDota', () => {
    for (const [code, status] of cases) {
      const copy = reportErrorCopy({ code, status });
      if (code !== 'upstream' && code !== 'not_found') expect(`${copy.zh} ${copy.en}`).not.toMatch(/OpenDota/);
    }
  });

  it('an answer without a known code falls back on the status', () => {
    expect(reportErrorCopy({ code: 'something_new', status: 404 }).zh).toMatch(/找不到这场比赛/);
    expect(reportErrorCopy({ code: 'something_new', status: 429 }).zh).toMatch(/请求太频繁/);
    expect(reportErrorCopy({ code: 'something_new', status: 422 }).zh).toMatch(/还没准备好/);
    expect(reportErrorCopy({ code: 'something_new', status: 0 }).zh).toMatch(/连不上/);
    expect(reportErrorCopy({ code: 'something_new', status: 500 }).zh).toMatch(/暂时没有响应/); // e.g. a proxy's error page
  });

  it('every code the server sends for a report has a message here', () => {
    const router = readFileSync(path.join(process.cwd(), 'lib/coach/router.js'), 'utf8');
    const fn = router.slice(router.indexOf('async function reportFor('), router.indexOf("router.get('/api/coach/:matchId/cases'"));
    const sent = [...fn.matchAll(/code: (?:[^,}]*\? )?'([a-z_]+)'(?: : '([a-z_]+)')?/g)].flatMap((m) => [m[1], m[2]]).filter(Boolean);
    expect([...new Set(sent)].sort()).toEqual(['insufficient', 'internal', 'not_found', 'rate_limited', 'upstream']);
    expect(fn).toContain('code: q.error'); // invalid_match_id / invalid_slot_pos
    // With a status that says nothing, each code still gets its own message, not the upstream one.
    const upstream = reportErrorCopy({ code: 'upstream', status: 599 });
    for (const code of [...sent, 'invalid_match_id', 'invalid_slot_pos']) {
      if (code !== 'upstream') expect(reportErrorCopy({ code: code!, status: 599 }), code).not.toBe(upstream);
    }
  });

  it('on the page: a match with no player data yet, then a retry that works', async () => {
    fetchReport.mockRejectedValueOnce(new CoachApiError('insufficient', 'OpenDota has no player data for this match yet', 422)).mockResolvedValue(parsed);
    const { container } = page('/r/9091400302?p=0');
    await waitFor(() => expect(screen.getByText(/这场比赛的玩家数据还没准备好/)).toBeTruthy());
    expect(screen.queryByText(/OpenDota 暂时没有响应/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /重试/ }));
    await waitFor(() => expect(container.querySelector('.rv-headline')).toBeTruthy());
  });

  it('on the page: our own failure and a dropped connection are not blamed on OpenDota', async () => {
    fetchReport.mockRejectedValueOnce(new CoachApiError('internal', 'Could not build the report', 500));
    page('/r/9091400302?p=0');
    await waitFor(() => expect(screen.getByText(/复盘生成失败。这是我们这边的问题/)).toBeTruthy());
    expect(document.querySelector('.cx-error')?.textContent).not.toMatch(/OpenDota/);
    cleanup();
    fetchReport.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { container } = page('/r/9091400302?p=0');
    await waitFor(() => expect(screen.getByText(/连不上 dota2\.ai/)).toBeTruthy());
    expect(container.querySelector('.cx-error')?.textContent).not.toMatch(/OpenDota/);
  });
});

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

  it('offers the parse when OpenDota has no replay address yet (it only fetches one once a parse is requested)', async () => {
    // What OpenDota returns for a game nobody has asked it to parse: has_gcdata false, no replay_url.
    const raw = load('match9091400302.unparsed.json');
    delete raw.replay_url; delete raw.replay_salt;
    const fresh = buildCoachReport({ ...raw, od_data: { has_api: true, has_gcdata: false, has_parsed: false } });
    expect(fresh.match).toMatchObject({ parsed: false, replay_available: true, source: 'opendota' });
    fetchReport.mockResolvedValue(fresh);
    parse.mockResolvedValue({ status: 'requested' });
    page('/r/9091400302?p=4');
    await waitFor(() => expect(screen.getByRole('button', { name: '解析这场比赛' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '解析这场比赛' }));
    await waitFor(() => expect(parse).toHaveBeenCalledWith('9091400302', 'zh'));
    await waitFor(() => expect(screen.getByText(/已提交解析/)).toBeTruthy());
  });

  it('does not offer it when the game coordinator says the match has no replay', async () => {
    const raw = load('match9091400302.unparsed.json');
    delete raw.replay_url;
    const none = buildCoachReport({ ...raw, data_source: 'steam_gc', cluster: 0, replay_salt: 0, od_data: { has_parsed: false } });
    expect(none.match).toMatchObject({ parsed: false, replay_available: false, source: 'steam_gc' });
    const some = buildCoachReport({ ...raw, data_source: 'steam_gc', replay_url: 'http://replay181.valve.net/570/9091400302_1.dem.bz2', od_data: { has_parsed: false } });
    expect(some.match.replay_available).toBe(true);
    fetchReport.mockResolvedValue(none);
    const { container } = page('/r/9091400302?p=4');
    await waitFor(() => expect(container.querySelector('.cx-gaps--priority')).toBeTruthy());
    expect(screen.queryByRole('button', { name: '解析这场比赛' })).toBeNull();
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
