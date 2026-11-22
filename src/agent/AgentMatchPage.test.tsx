// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AgentMatchPage } from './AgentMatchPage';
import { turningFight } from './ReviewDoc';
import { stepLabel } from './ChatRail';

vi.mock('../v2/i18n/I18nProvider', () => ({ useI18n: () => ({ lang: 'en', setLang: () => {} }) }));

const heroes = [
  { hero: 'axe', team: 'radiant', hero_id: 2, en: 'Axe', zh: '斧王' },
  { hero: 'beastmaster', team: 'dire', hero_id: 38, en: 'Beastmaster', zh: '兽王' },
];
const review = {
  schema: 'dota2.ai/deep-review@1', match_id: 9100904020, hero: 'beastmaster', lang: 'en',
  verdict: 'The roar was never kept for Phantom Assassin.', mainline: ['30:26 the fight that turned it.'],
  findings: [{ title: 'Roar on the wrong target', claim: 'Three of ten went to Axe.', evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], clock: '27:27', fact: 'Roared into her BKB; stunned 3.4 s.' }], fix: 'Keep it for her.' }],
  did_well: ['Aghanim\'s at 16:48.'], next_game: ['Keep the roar for the carry.'], blind_spots: ['Vision.'],
};
const cast = { status: 'ok', ref: 'cast:beastmaster:primal_roar:6', kind: 'cast', names: { phantom_assassin: 'Phantom Assassin', sven: 'Sven' }, record: { clock: '27:27', target: 'phantom_assassin', target_hp: { hp: 1980, max_hp: 1980 }, target_spell_immune: true, target_stunned_seconds: 3.4, allies_within_1300: ['sven'], enemies_within_1300: ['phantom_assassin'], deaths_within_12s: [{ hero: 'phantom_assassin', side: 'enemy', dt: 10.8 }] } };
const overview = { status: 'ok', ref: 'overview', kind: 'overview', names: {}, record: { duration: { t: 2551 }, fights: [{ ref: 'fight:11', from: 1826, to: 1848, clock: '30:26–30:48', my_team_deaths: 5, enemy_deaths: 3, my_team_gold_lead_before: -745, my_team_gold_lead_2min_after: -4298 }] } };

type Handler = (url: string, init?: RequestInit) => any;
function mockFetch(routes: Record<string, Handler | any>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    const body = key ? (typeof routes[key] === 'function' ? routes[key](url, init) : routes[key]) : null;
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body ?? { code: 'not_found' }), { status: body ? (body.__status ?? 200) : 404, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}
const sse = (frames: object[]) => new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const page = (path: string) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes><Route path="/r/:matchId" element={<AgentMatchPage />} /><Route path="/" element={<p>home</p>} /></Routes>
  </MemoryRouter>,
);

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('AgentMatchPage', () => {
  it('without a parsed replay it says so and shows nothing in its place', async () => {
    mockFetch({ '/api/agent/8000000001': { trace: false, model_configured: true, heroes: [] } });
    page('/r/8000000001?lang=en');
    expect(await screen.findByRole('heading', { name: 'This game has no parsed replay yet' })).toBeTruthy();
    expect(screen.queryByText('Ask the coach')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review my game' })).toBeNull();
  });

  it('asks which hero, then offers to start; the start is the reader\'s click, never automatic', async () => {
    const calls = mockFetch({ '/review?': { status: 'none' }, '/api/agent/9100904020': { trace: true, model_configured: true, heroes } });
    page('/r/9100904020?lang=en');
    fireEvent.click(await screen.findByRole('button', { name: /Beastmaster/ }));
    expect(await screen.findByRole('heading', { name: 'No review of this hero yet' })).toBeTruthy();
    expect(calls.some((c) => c.init?.method === 'POST')).toBe(false);
    expect(calls.some((c) => c.url.includes('/review?hero=beastmaster&lang=en'))).toBe(true);
  });

  it('start → the agent\'s steps while it works', async () => {
    const calls = mockFetch({
      '/review?': { status: 'none' },
      '/review': (_u: string, init?: RequestInit) => (init?.method === 'POST' ? { status: 'running', steps: [{ tool: 'match_overview', args: {} }, { tool: 'fight_timeline', args: { from: 1805, to: 1860 } }] } : null),
      '/api/agent/9100904020': { trace: true, model_configured: true, heroes },
    });
    page('/r/9100904020?hero=beastmaster&lang=en');
    fireEvent.click(await screen.findByRole('button', { name: 'Review my game' }));
    expect(await screen.findByText('Reading the whole game')).toBeTruthy();
    expect(screen.getByText('Replaying a fight 30:05–31:00')).toBeTruthy();
    expect(JSON.parse(String(calls.find((c) => c.init?.method === 'POST')!.init!.body))).toEqual({ hero: 'beastmaster', lang: 'en' });
  });

  it('a refused start explains itself', async () => {
    mockFetch({ '/review?': { status: 'none' }, '/review': { __status: 429, code: 'rate_limited', retryAfterSec: 60 }, '/api/agent/9100904020': { trace: true, model_configured: true, heroes } });
    page('/r/9100904020?hero=beastmaster&lang=en');
    fireEvent.click(await screen.findByRole('button', { name: 'Review my game' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Too many reviews');
  });

  it('ready: the review, its evidence record on demand, and a question about that moment', async () => {
    const calls = mockFetch({
      '/chat': () => sse([{ step: { tool: 'ability_audit', args: {} } }, { text: 'She was stunned 3.4 s.\n\nKeep it for her.', unverified: [{ kind: 'time', text: '19:19' }] }, { done: true }]),
      'ref=overview': overview,
      '/evidence?': cast,
      '/review?': { status: 'ready', review, verification: { repaired: true, dropped: 1 }, model: 'm', tool_calls: 9 },
      '/api/agent/9100904020': { trace: true, model_configured: true, heroes },
    });
    page('/r/9100904020?hero=beastmaster&lang=en');
    expect(await screen.findByRole('heading', { level: 1, name: review.verdict })).toBeTruthy();
    expect(screen.getByText('Roar on the wrong target')).toBeTruthy();
    expect(screen.getByText(/1 removed for lack of evidence/)).toBeTruthy();
    // The turning fight is marked on the strip once the overview arrives.
    expect(await screen.findByText(/▲ 30:26 the turn/)).toBeTruthy();
    // The record behind the sentence is fetched only when asked for.
    expect(calls.some((c) => c.url.includes('ref=cast'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Show the record' }));
    expect(await screen.findByText('spell immune')).toBeTruthy();
    expect(screen.getByText('stunned 3.4s')).toBeTruthy();
    expect(screen.getAllByText('Phantom Assassin').length).toBeGreaterThan(0);
    // Ask about that moment: the ref travels with the question, the reader sees their own words.
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this' }));
    const chat = screen.getByRole('complementary', { name: 'Ask the coach' });
    expect(within(chat).getByText('27:27')).toBeTruthy();
    fireEvent.change(within(chat).getByRole('textbox'), { target: { value: 'Was that right?' } });
    fireEvent.click(within(chat).getByRole('button', { name: 'Ask' }));
    expect(await within(chat).findByText('She was stunned 3.4 s.')).toBeTruthy();
    expect(within(chat).getByText('Checking every cast')).toBeTruthy();
    expect(within(chat).getByText(/Not found in the replay data.*19:19/)).toBeTruthy();
    expect(within(chat).getByText('Was that right?')).toBeTruthy();
    const sent = JSON.parse(String(calls.find((c) => c.url.includes('/chat'))!.init!.body));
    expect(sent).toEqual({ hero: 'beastmaster', lang: 'en', question: 'Was that right?\n(about cast:beastmaster:primal_roar:6)', history: [] });
  });

  it('an invalid match id never calls the server', async () => {
    const calls = mockFetch({});
    page('/r/not-a-match?lang=en');
    expect(await screen.findByRole('heading', { name: 'That is not a match ID.' })).toBeTruthy();
    await waitFor(() => expect(calls).toHaveLength(0));
  });
});

describe('helpers', () => {
  it('the turning fight is the biggest fall while still in the game, not the last collapse', () => {
    const f = (ref: string, before: number | null, after: number | null) => ({ ref, from: 0, to: 0, clock: '', my_team_deaths: 0, enemy_deaths: 0, my_team_gold_lead_before: before, my_team_gold_lead_2min_after: after });
    expect(turningFight([f('a', 3565, 2800), f('b', -745, -4298), f('c', -8039, -20144)])?.ref).toBe('b');
    expect(turningFight([f('a', 500, -400), f('b', null, null)])).toBeNull();
    expect(turningFight([])).toBeNull();
  });
  it('names the agent\'s steps for the reader', () => {
    expect(stepLabel({ tool: 'fight_timeline', args: { from: 1805, to: 1860 } }, 'zh')).toBe('回放团战 30:05–31:00');
    expect(stepLabel({ tool: 'death_context', args: { hero: 'x', index: 9 } }, 'en')).toBe('Looking at a death #9');
    expect(stepLabel({ tool: 'new_tool', args: {} }, 'en')).toBe('new_tool');
  });
});
