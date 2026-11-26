// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { buildCoachReport } from '../../lib/coach/analyze.js';
import { buildSurface } from '../../lib/coach/cards.js';
import { AGENT_CLIENTS, CURSOR_INSTALL, MCP_TOOLS, MCP_URL } from './accessSnippets';

vi.mock('../v2/i18n/I18nProvider', () => ({ useI18n: () => ({ lang: 'en', setLang: () => {} }) }));
const report = buildCoachReport(JSON.parse(readFileSync(path.join(process.cwd(), 'src/fixtures/coach/match9091400302.parsed.json'), 'utf8'))) as any;
const cards = vi.fn();
const recent = vi.fn(async (_id: string) => ({ account_id: 0, empty_hint: null, matches: [] as unknown[] }));
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), fetchCoachCards: (...a: unknown[]) => cards(...a), fetchRecentMatches: (id: string) => recent(id) }));
const { CoachHome } = await import('./CoachApp');

afterEach(() => { cleanup(); cards.mockReset(); recent.mockClear(); window.localStorage.clear(); });
const home = () => render(<MemoryRouter><CoachHome /></MemoryRouter>);

describe('home: coming back after the next game', () => {
  const goal = (accountId: number | null) => ({
    id: 'g1', goal: { kind: 'deaths_per10_max', max: 2, label: { en: 'At most 2 deaths per 10 minutes', zh: 'x' } },
    action: { en: 'a', zh: 'a' }, findingId: 'agent:1', fromMatch: 9091400302, fromStart: 1, accountId, heroId: 29, setAt: 1,
  });

  it('a goal set from a review brings that player\'s latest game to the home page, with no friend code saved', async () => {
    window.localStorage.setItem('dota2ai.coach.goal', JSON.stringify(goal(86745912)));
    home();
    await waitFor(() => expect(recent).toHaveBeenCalledWith('86745912'));
  });

  it('a saved friend code wins; a goal without an account (or an anonymous one) shows nothing', async () => {
    window.localStorage.setItem('dota2ai.coach.account', '12345678');
    window.localStorage.setItem('dota2ai.coach.goal', JSON.stringify(goal(86745912)));
    home();
    await waitFor(() => expect(recent).toHaveBeenCalled());
    expect(recent.mock.calls.map((c) => c[0])).toEqual(['12345678']);
    cleanup(); recent.mockClear(); window.localStorage.clear();
    for (const id of [null, 4294967295]) {
      window.localStorage.setItem('dota2ai.coach.goal', JSON.stringify(goal(id)));
      home();
      await new Promise((r) => setTimeout(r, 20));
      cleanup();
    }
    expect(recent).not.toHaveBeenCalled();
  });
});

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

  it('one line per agent tool: picking one swaps the line, and Copy takes the line shown', async () => {
    cards.mockImplementation(async (_id: string, seat: number) => buildSurface(report, seat));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { container } = home();
    const ways = container.querySelector('.hm-ways') as HTMLElement;
    const picker = within(ways).getByRole('group', { name: 'Your agent' });
    expect(within(picker).getAllByRole('button').map((b) => b.textContent)).toEqual(['Claude Code', 'Codex', 'Gemini CLI', 'VS Code', 'Cursor', 'Any other']);
    expect(within(picker).getByRole('button', { name: 'Claude Code' }).getAttribute('aria-pressed')).toBe('true');
    // Every line names the hosted endpoint, and is one line.
    for (const c of AGENT_CLIENTS) { expect(c.line).toContain(MCP_URL); expect(c.line).not.toContain('\n'); }
    const lines: Record<string, string> = {
      Codex: `codex mcp add dota2ai --url ${MCP_URL}`,
      'Gemini CLI': `gemini mcp add --transport http dota2ai ${MCP_URL}`,
      'VS Code': `code --add-mcp '{"name":"dota2ai","type":"http","url":"${MCP_URL}"}'`,
      Cursor: `{ "mcpServers": { "dota2ai": { "url": "${MCP_URL}" } } }`,
      'Any other': MCP_URL,
    };
    for (const [name, line] of Object.entries(lines)) {
      fireEvent.click(within(picker).getByRole('button', { name }));
      expect(ways.querySelector('pre')?.textContent).toBe(line);
      // A JSON line that is shown must parse.
      if (line.startsWith('{')) expect(JSON.parse(line).mcpServers.dota2ai.url).toBe(MCP_URL);
    }
    fireEvent.click(within(picker).getByRole('button', { name: 'Codex' }));
    fireEvent.click(within(ways).getAllByRole('button', { name: /^Copy/ })[0]);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(lines.Codex));
    // What to say once it is connected, and Cursor's one-click link carrying the same address.
    expect(ways.textContent).toContain('Review my Dota 2 match 9100904020 — I played Beastmaster.');
    fireEvent.click(within(picker).getByRole('button', { name: 'Cursor' }));
    const link = within(ways).getByRole('link', { name: 'Or add it to Cursor in one click' });
    expect(link.getAttribute('href')).toBe(CURSOR_INSTALL);
    expect(JSON.parse(atob(new URL(CURSOR_INSTALL).searchParams.get('config')!))).toEqual({ url: MCP_URL });
    // The picker belongs to the agent tab only.
    fireEvent.click(within(ways).getByRole('tab', { name: 'CLI' }));
    expect(within(ways).queryByRole('group', { name: 'Your agent' })).toBeNull();
    expect(ways.textContent).not.toContain('Then just say');
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

describe('home: feedback, GitHub Issues, X, email & message box', () => {
  it('links to GitHub Issues, X (@kilocean), and author email; opens feedback box on click without adding initial textboxes', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/site-feedback')) {
        return new Response(JSON.stringify({ status: 'ok', id: 'fb1' }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ code: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { container } = home();
      // Initial render keeps a single textbox (the hero match/friend-code input).
      expect(screen.getAllByRole('textbox')).toHaveLength(1);
      const fb = container.querySelector('.hm-feedback') as HTMLElement;
      expect(within(fb).getByRole('link', { name: /GitHub Issues/ }).getAttribute('href')).toBe('https://github.com/qianhaoq/dota2.ai/issues');
      expect(within(fb).getByRole('link', { name: /@kilocean/ }).getAttribute('href')).toBe('https://x.com/kilocean');
      expect(within(fb).getByRole('link', { name: 'qianhao1229@gmail.com' }).getAttribute('href')).toBe('mailto:qianhao1229@gmail.com');

      fireEvent.click(within(fb).getByRole('button', { name: 'Leave a message' }));
      fireEvent.change(within(fb).getByLabelText('Your message'), { target: { value: 'Great Russian translation!' } });
      fireEvent.change(within(fb).getByLabelText('Contact (optional)'), { target: { value: '@tester' } });
      fireEvent.click(within(fb).getByRole('button', { name: 'Send feedback' }));

      await waitFor(() => expect(within(fb).getByText('Thanks — your message has been received.')).toBeTruthy());
      expect(fetchMock).toHaveBeenCalledWith('/api/site-feedback', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ category: 'suggestion', message: 'Great Russian translation!', contact: '@tester', lang: 'en' }),
      }));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
