// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { buildCoachReport } from '../../lib/coach/analyze.js';

vi.mock('../v2/i18n/I18nProvider', () => ({ useI18n: () => ({ lang: 'zh', setLang: () => {} }) }));
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), fetchCoachCases: () => new Promise(() => {}) }));
const { Chapters } = await import('./Chapters');
const report: any = buildCoachReport(JSON.parse(readFileSync(path.join(process.cwd(), 'src/fixtures/coach/match9091400302.parsed.json'), 'utf8')));

afterEach(cleanup);

describe('why -> pro cases', () => {
  it('links the causes on you to the matching pro-case theme, and only those', () => {
    const { container } = render(<Chapters review={report.reviews[0]} report={report} pos={null} />);
    const items = [...container.querySelectorAll('.cx-why-list > li')];
    const mine = items.filter((li) => li.classList.contains('is-mine'));
    expect(mine.length).toBeGreaterThan(0);
    const links = [...container.querySelectorAll('a.cx-why-pro')].map((a) => a.getAttribute('href'));
    // Tidehunter: own lane -> laning cases; lost fights from behind -> fights cases.
    expect(links).toEqual(['#cx-case-laning', '#cx-case-fights']);
    for (const li of items.filter((x) => !x.classList.contains('is-mine'))) expect(li.querySelector('a.cx-why-pro')).toBeNull();
  });

  it('scrolls to the theme once loaded, else to the cases chapter', () => {
    render(<Chapters review={report.reviews[0]} report={report} pos={null} />);
    const chapter = document.getElementById('cx-ch-cases')!;
    const toChapter = vi.fn(); chapter.scrollIntoView = toChapter;
    fireEvent.click(screen.getAllByText(/看职业对局/)[0]);
    expect(toChapter).toHaveBeenCalled();
    const theme = document.createElement('section'); theme.id = 'cx-case-laning';
    const toTheme = vi.fn(); theme.scrollIntoView = toTheme; document.body.appendChild(theme);
    fireEvent.click(screen.getAllByText(/看职业对局/)[0]);
    expect(toTheme).toHaveBeenCalled();
    theme.remove();
  });
});

describe('why -> lane heat map', () => {
  it('draws your and your lane killer\'s first-10-minute positions on your lane only', () => {
    const { container } = render(<Chapters review={report.reviews[2]} report={report} pos={null} />); // Warlock
    const figs = container.querySelectorAll('figure.cx-heat');
    expect(figs).toHaveLength(1);
    const heat = report.reviews[2].chapters.story.why.find((c: any) => c.heat).heat;
    expect(figs[0].querySelectorAll('circle.cx-heat-me')).toHaveLength(heat.me.cells.length);
    expect(figs[0].querySelectorAll('circle.cx-heat-opp')).toHaveLength(heat.opp.cells.length);
    expect(figs[0].textContent).toContain('前 10 分钟站位（录像位置采样）');
    expect(figs[0].textContent).toContain('术士');
    expect(figs[0].textContent).toContain('破晓辰星');
    expect(figs[0].querySelector('svg')!.getAttribute('aria-label')).toContain('术士 / 破晓辰星');
  });
});
