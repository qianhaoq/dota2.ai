// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { buildCoachReport } from '../../lib/coach/analyze.js';
import { buildCaseStudies } from '../../lib/coach/cases.js';

vi.mock('../v2/i18n/I18nProvider', () => ({ useI18n: () => ({ lang: 'zh', setLang: () => {} }) }));
const fetchCoachCases = vi.fn();
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), fetchCoachCases: (...a: unknown[]) => fetchCoachCases(...a) }));
const { Cases } = await import('./Cases');

const read = (p: string) => JSON.parse(readFileSync(path.join(process.cwd(), p), 'utf8'));
const match = read('src/fixtures/coach/match9091400302.parsed.json');
const studies: any = buildCaseStudies({
  report: buildCoachReport(match), slot: 0, match,
  candidates: read('src/fixtures/coach/cases.tidehunter-vs-ursa.profiles.json').profiles,
});

afterEach(() => { cleanup(); fetchCoachCases.mockReset(); });

describe('Cases', () => {
  it('shows each problem with a negative and a positive pro game, a comparison table and links', async () => {
    fetchCoachCases.mockResolvedValue(studies);
    render(<Cases matchId="9091400302" slot={0} pos={null} />);
    expect(screen.getByRole('status').textContent).toContain('正在找相似的职业对局');
    await waitFor(() => expect(screen.getByText('你死于熊战士 8 次')).toBeTruthy());
    expect(fetchCoachCases).toHaveBeenCalledWith('9091400302', expect.objectContaining({ slot: 0, pos: null }));
    const theme = screen.getByRole('region', { name: '你死于熊战士 8 次' });
    expect(theme.textContent).toContain('反例');
    expect(theme.textContent).toContain('正例');
    const neg = studies.themes[0].negative;
    const link = Array.from(theme.querySelectorAll('a')).find((a) => a.getAttribute('href')?.startsWith(`/r/${neg.match_id}`));
    expect(link?.getAttribute('href')).toBe(`/r/${neg.match_id}?lang=zh&p=${neg.slot}`);
    expect(theme.querySelector('table')?.textContent).toContain('死于熊战士');
  });

  it('a failed load says so and can retry', async () => {
    fetchCoachCases.mockRejectedValueOnce(new Error('502')).mockResolvedValueOnce({ ...studies, themes: [] });
    render(<Cases matchId="9091400302" slot={0} pos={null} />);
    await waitFor(() => expect(screen.getByText(/职业对局暂时加载不了/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByText('没有找到和这局足够相似的职业对局。')).toBeTruthy());
  });
});
