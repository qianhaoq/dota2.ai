// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { buildCoachReport } from '../../lib/coach/analyze.js';
import { buildSurface } from '../../lib/coach/cards.js';
import { MCP_TOOLS, MCP_URL } from './accessSnippets';

vi.mock('../v2/i18n/I18nProvider', () => ({ useI18n: () => ({ lang: 'en', setLang: () => {} }) }));
const report = buildCoachReport(JSON.parse(readFileSync(path.join(process.cwd(), 'src/fixtures/coach/match9091400302.parsed.json'), 'utf8'))) as any;
const cards = vi.fn();
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), fetchCoachCards: (...a: unknown[]) => cards(...a) }));
const { CoachHome } = await import('./CoachApp');

afterEach(() => { cleanup(); cards.mockReset(); });
const home = () => render(<MemoryRouter><CoachHome /></MemoryRouter>);

describe('home: what happens next', () => {
  it('explains the four steps of a review and what the coach cannot see, without sample numbers', () => {
    const { container } = home();
    const how = container.querySelector('.hm-how') as HTMLElement;
    expect(within(how).getByRole('heading', { name: 'What happens next' })).toBeTruthy();
    expect([...how.querySelectorAll('.hm-how-steps strong')].map((x) => x.textContent)).toEqual(['You pick your hero', 'The coach watches the replay', 'You get the review', 'Ask anything']);
    expect(how.textContent).toContain('the coach says it cannot see');
    // The old sample fetched the rule engine's cards; the home page no longer calls it.
    expect(cards).not.toHaveBeenCalled();
    expect(container.querySelector('.hm-live')).toBeNull();
  });
});

describe('home: four ways to use it', () => {
  it('Web / Agent (MCP) / CLI / HTTP, each with a command that works as written', async () => {
    cards.mockImplementation(async (_id: string, seat: number) => buildSurface(report, seat));
    const { container } = home();
    const ways = container.querySelector('.hm-ways') as HTMLElement;
    expect(within(ways).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Web', 'Agent (MCP)', 'CLI', 'HTTP']);
    // MCP is the default tab: the hosted endpoint and all 8 tool names.
    expect(ways.querySelector('pre')?.textContent).toBe(`claude mcp add --transport http dota2ai ${MCP_URL}`);
    for (const tool of MCP_TOOLS) expect(ways.textContent).toContain(tool);
    expect(MCP_TOOLS).toHaveLength(8);
    fireEvent.click(within(ways).getByRole('tab', { name: 'CLI' }));
    expect(ways.querySelector('pre')?.textContent).toContain('node packages/cli/bin/dota2ai.js coach 9091400302 --hero tidehunter --section why');
    expect(ways.textContent).toContain('Not published on npm yet');
    fireEvent.click(within(ways).getByRole('tab', { name: 'HTTP' }));
    expect(ways.querySelector('pre')?.textContent).toContain('curl https://dota2.ai/api/coach/9091400302');
    expect(within(ways).getByRole('link', { name: 'llms.txt' }).getAttribute('href')).toBe('/llms.txt');
  });

  it('Copy puts exactly the shown command on the clipboard, and the agent prompt is copyable too', async () => {
    cards.mockImplementation(async (_id: string, seat: number) => buildSurface(report, seat));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { container } = home();
    const ways = container.querySelector('.hm-ways') as HTMLElement;
    const [copyCmd, copyPrompt] = within(ways).getAllByRole('button', { name: /^Copy/ });
    fireEvent.click(copyCmd);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`claude mcp add --transport http dota2ai ${MCP_URL}`));
    expect(await within(ways).findByText('Copied')).toBeTruthy();
    fireEvent.click(copyPrompt);
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining('https://dota2.ai/llms.txt')));
  });
});
