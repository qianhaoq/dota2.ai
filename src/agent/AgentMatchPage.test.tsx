// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { AgentMatchPage, journeyStep } from './AgentMatchPage';
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
const board = { match: { patch: '7.42' }, players: [{ slot: 0, radiant: true, kda: [4, 12, 14], hero: { id: 2, en: 'Axe', zh: '斧王', slug: 'axe', img: null } }, { slot: 1, radiant: false, kda: [9, 11, 18], account_id: 77, hero: { id: 38, en: 'Beastmaster', zh: '兽王', slug: 'beastmaster', img: null } }] };
const cast = { status: 'ok', ref: 'cast:beastmaster:primal_roar:6', kind: 'cast', names: { phantom_assassin: 'Phantom Assassin', sven: 'Sven' }, record: { clock: '27:27', target: 'phantom_assassin', target_hp: { hp: 1980, max_hp: 1980 }, target_spell_immune: true, target_stunned_seconds: 3.4, allies_within_1300: ['sven'], enemies_within_1300: ['phantom_assassin'], deaths_within_12s: [{ hero: 'phantom_assassin', side: 'enemy', dt: 10.8 }] } };
const overview = { status: 'ok', ref: 'overview', kind: 'overview', names: {}, record: { duration: { t: 2551 }, fights: [{ ref: 'fight:11', from: 1826, to: 1848, clock: '30:26–30:48', my_team_deaths: 5, enemy_deaths: 3, my_team_gold_lead_before: -745, my_team_gold_lead_2min_after: -4298 }] } };

type Handler = (url: string, init?: RequestInit) => any;
function mockFetch(routes: Record<string, Handler | any>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    const body = key ? await (typeof routes[key] === 'function' ? routes[key](url, init) : routes[key]) : null;
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

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.sessionStorage.clear(); window.localStorage.clear(); });

describe('AgentMatchPage', () => {
  it('no parsed replay yet: the roster comes from the scoreboard, and one click runs replay → parse → review', async () => {
    let polls = 0; let started = 0;
    const calls = mockFetch({
      '/api/coach/9100904020': board,
      '/prepare': () => ({ status: 'running', stage: 'locating' }),
      '/review?': () => (started ? { status: 'running', steps: [{ tool: 'match_overview', args: {} }] } : { status: 'none' }),
      '/review': (_u: string, init?: RequestInit) => { if (init?.method === 'POST') { started += 1; return { status: 'running', steps: [] }; } return null; },
      // First the parse is running; two polls later the trace is there.
      '/api/agent/9100904020': () => { polls += 1; return polls <= 1 ? { trace: false, model_configured: true, can_parse: true, heroes: [], parse: { status: 'none' } } : polls === 2 ? { trace: false, model_configured: true, can_parse: true, heroes: [], parse: { status: 'running', stage: 'extracting' } } : { trace: true, model_configured: true, can_parse: true, heroes }; },
    });
    page('/r/9100904020?lang=en');
    fireEvent.click(await screen.findByRole('button', { name: /Beastmaster/ }));
    expect(await screen.findByRole('heading', { name: 'Review this game' })).toBeTruthy();
    // Nothing that costs a download or a model call has started on its own.
    expect(calls.some((c) => c.init?.method === 'POST')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Review my game' }));
    expect(await screen.findByRole('heading', { name: 'Working on your review' })).toBeTruthy();
    await waitFor(() => expect(document.querySelector('.ag-journey li.is-live strong')?.textContent).toBe('Read the replay'));
    // The trace arrives: the review starts without a second click.
    await waitFor(() => expect(started).toBe(1), { timeout: 8000 });
    expect(await screen.findByText('Reading the whole game', {}, { timeout: 8000 })).toBeTruthy();
    expect(calls.filter((c) => c.url.includes('/prepare'))).toHaveLength(1);
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith('/review') && c.init?.method === 'POST')!.init!.body))).toEqual({ hero: 'beastmaster', lang: 'en' });
  }, 20000);

  it('the reader\'s "go" outlives a parse that died: on return it is started again, once', async () => {
    window.sessionStorage.setItem('dota2ai.review-intent.9100904020.beastmaster.en', '1');
    let prepared = 0;
    const calls = mockFetch({
      '/api/coach/9100904020': board,
      '/prepare': () => { prepared += 1; return { status: 'running', stage: 'locating' }; },
      '/api/agent/9100904020': () => ({ trace: false, model_configured: true, can_parse: true, heroes: [], parse: prepared ? { status: 'running', stage: 'downloading' } : { status: 'none' } }),
    });
    page('/r/9100904020?hero=beastmaster&lang=en');
    expect(await screen.findByRole('heading', { name: 'Working on your review' })).toBeTruthy();
    await waitFor(() => expect(prepared).toBe(1));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/api/agent/9100904020')).length).toBeGreaterThanOrEqual(2));
    expect(prepared).toBe(1);
  });

  it('one click is one start, and a refresh that fails right after prepare does not strand the wait', async () => {
    // With a trace: the start answers slowly; the carry-on effect must not send a second one meanwhile.
    let starts = 0;
    mockFetch({
      '/api/coach/9100904020': board,
      '/review?': { status: 'none' },
      '/review': async (_u: string, init?: RequestInit) => { if (init?.method !== 'POST') return null; starts += 1; await new Promise((r) => setTimeout(r, 300)); return { status: 'running', steps: [] }; },
      '/api/agent/9100904020': { trace: true, model_configured: true, can_parse: true, heroes },
    });
    page('/r/9100904020?hero=beastmaster&lang=en');
    fireEvent.click(await screen.findByRole('button', { name: 'Review my game' }));
    await waitFor(() => expect(document.querySelector('.ag-journey')).toBeTruthy());
    await new Promise((r) => setTimeout(r, 600));
    expect(starts).toBe(1);
    cleanup(); window.sessionStorage.clear();
    // Without a trace: prepare says running, the refresh right after it fails; the page still shows and polls the parse.
    let n = 0;
    mockFetch({
      '/api/coach/9100904020': board,
      '/prepare': { status: 'running', stage: 'downloading' },
      '/api/agent/9100904020': () => { n += 1; return n === 1 ? { trace: false, model_configured: true, can_parse: true, heroes: [], parse: { status: 'none' } } : n === 2 ? new Response('bad gateway', { status: 502 }) : { trace: false, model_configured: true, can_parse: true, heroes: [], parse: { status: 'running', stage: 'extracting' } }; },
    });
    page('/r/9100904020?hero=beastmaster&lang=en');
    fireEvent.click(await screen.findByRole('button', { name: 'Review my game' }));
    await waitFor(() => expect(n).toBeGreaterThanOrEqual(3), { timeout: 9000 });
    await waitFor(() => expect(document.querySelector('.ag-journey li.is-live strong')?.textContent).toBe('Read the replay'));
  }, 20000);

  it('an answer for the previous hero does not replace the one on screen; a failed poll is not a failed review', async () => {
    let slow: any; let polls = 0;
    mockFetch({
      'ref=overview': overview,
      // Beastmaster's status answers late; Axe's review is ready at once.
      '/review?hero=beastmaster': () => new Promise((r) => { slow = () => r({ status: 'running', steps: [] }); }),
      '/review?hero=axe': { status: 'ready', review: { ...review, hero: 'axe', verdict: 'Axe verdict.' }, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 1 },
      '/api/agent/9100904020': { trace: true, model_configured: true, can_parse: true, heroes },
    });
    page('/r/9100904020?hero=beastmaster&lang=en');
    await waitFor(() => expect(slow).toBeTypeOf('function'));
    fireEvent.click(await screen.findByRole('button', { name: 'Change hero' }));
    fireEvent.click(await screen.findByRole('button', { name: /Axe/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Axe verdict.' })).toBeTruthy();
    slow();
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByRole('heading', { level: 1, name: 'Axe verdict.' })).toBeTruthy();
    cleanup();
    // Running, then a poll fails (502), then ready: the page never shows "the review did not come out".
    mockFetch({
      'ref=overview': overview,
      '/review?': () => { polls += 1; return polls === 1 ? { status: 'running', steps: [] } : polls === 2 ? new Response('bad gateway', { status: 502 }) : { status: 'ready', review, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 1 }; },
      '/api/agent/9100904020': { trace: true, model_configured: true, can_parse: true, heroes },
    });
    page('/r/9100904020?hero=beastmaster&lang=en');
    expect(await screen.findByRole('heading', { name: 'Working on your review' })).toBeTruthy();
    await waitFor(() => expect(polls).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    expect(screen.queryByRole('heading', { name: 'The review did not come out' })).toBeNull();
    expect(await screen.findByRole('heading', { level: 1, name: review.verdict }, { timeout: 6000 })).toBeTruthy();
  }, 20000);

  it('an availability answer for the match the reader left does not replace the new match\'s', async () => {
    let late: any;
    mockFetch({
      '/api/coach/9100904020': board, '/api/coach/8000000009': board,
      '/review?': { status: 'none' },
      // The first match answers late, with a parsed trace; the second has none.
      '/api/agent/9100904020': () => new Promise((r) => { late = () => r({ trace: true, model_configured: true, can_parse: true, heroes }); }),
      '/api/agent/8000000009': { trace: false, model_configured: true, can_parse: true, heroes: [], parse: { status: 'none' } },
    });
    const Jump = () => { const go = useNavigate(); return <button type="button" onClick={() => go('/r/8000000009?hero=beastmaster&lang=en')}>jump</button>; };
    render(<MemoryRouter initialEntries={['/r/9100904020?hero=beastmaster&lang=en']}><Jump /><Routes><Route path="/r/:matchId" element={<AgentMatchPage />} /></Routes></MemoryRouter>);
    await waitFor(() => expect(late).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: 'jump' }));
    expect(await screen.findByRole('heading', { name: 'Review this game' })).toBeTruthy();
    late();
    await new Promise((r) => setTimeout(r, 100));
    // Still the new match, still without a trace: the old answer was dropped.
    expect(screen.getByText(/Match 8000000009/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Review this game' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Scoreboard' })).toBeTruthy();
  });

  it('a failed first availability request is asked again, not read as "switched off"', async () => {
    let n = 0;
    mockFetch({ '/api/coach/9100904020': board, '/review?': { status: 'none' }, '/api/agent/9100904020': () => { n += 1; return n === 1 ? new Response('bad gateway', { status: 502 }) : { trace: true, model_configured: true, can_parse: true, heroes }; } });
    page('/r/9100904020?hero=beastmaster&lang=en');
    await waitFor(() => expect(n).toBe(1));
    expect(screen.queryByRole('heading', { name: 'Replay reviews are not switched on here' })).toBeNull();
    expect(await screen.findByRole('heading', { name: 'Review this game' }, { timeout: 6000 })).toBeTruthy();
    expect(n).toBe(2);
  }, 15000);

  it('a start still out for one hero does not block another\'s; leaving a chat cancels its answer', async () => {
    const posted: string[] = []; let chatSignal: AbortSignal | undefined;
    mockFetch({
      '/chat': (_u: string, init?: RequestInit) => { chatSignal = init?.signal ?? undefined; return new Promise(() => {}); },
      'ref=overview': overview,
      '/review?hero=axe': { status: 'ready', review: { ...review, hero: 'axe' }, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 1 },
      '/review?': { status: 'none' },
      '/review': (_u: string, init?: RequestInit) => { if (init?.method !== 'POST') return null; const hero = JSON.parse(String(init.body)).hero; posted.push(hero); return hero === 'beastmaster' ? new Promise(() => {}) : { status: 'running', steps: [] }; },
      '/api/agent/9100904020': { trace: true, model_configured: true, can_parse: true, heroes: [...heroes, { hero: 'sven', team: 'dire', hero_id: 18, en: 'Sven', zh: '斯温' }] },
    });
    page('/r/9100904020?hero=beastmaster&lang=en');
    fireEvent.click(await screen.findByRole('button', { name: 'Review my game' }));
    await waitFor(() => expect(posted).toEqual(['beastmaster']));
    fireEvent.click(screen.getByRole('button', { name: 'Change hero' }));
    fireEvent.click(await screen.findByRole('button', { name: /Sven/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Review my game' }));
    await waitFor(() => expect(posted).toEqual(['beastmaster', 'sven']));
    // A chat in progress is cancelled when the reader leaves that conversation.
    fireEvent.click(screen.getByRole('button', { name: 'Change hero' }));
    fireEvent.click(await screen.findByRole('button', { name: /Axe/ }));
    const chat = await screen.findByRole('complementary', { name: 'Ask the coach' });
    fireEvent.change(within(chat).getByRole('textbox'), { target: { value: 'q' } });
    fireEvent.click(within(chat).getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(chatSignal).toBeTruthy());
    expect(chatSignal!.aborted).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Change hero' }));
    await waitFor(() => expect(chatSignal!.aborted).toBe(true));
  });

  it('a failed status request does not stop the wait: the page asks again', async () => {
    let n = 0;
    mockFetch({
      '/api/coach/9100904020': board,
      '/review?': { status: 'running', steps: [] },
      // Running, then one request fails, then the trace is there.
      '/api/agent/9100904020': () => { n += 1; if (n === 2) return new Response('bad gateway', { status: 502 }); return n < 2 ? { trace: false, model_configured: true, can_parse: true, heroes: [], parse: { status: 'running', stage: 'extracting' } } : { trace: true, model_configured: true, can_parse: true, heroes }; },
    });
    page('/r/9100904020?hero=beastmaster&lang=en');
    expect(await screen.findByRole('heading', { name: 'Working on your review' })).toBeTruthy();
    await waitFor(() => expect(n).toBeGreaterThanOrEqual(3), { timeout: 9000 });
    await waitFor(() => expect(document.querySelector('.ag-journey li.is-live strong')?.textContent).toBe('The coach goes through it'), { timeout: 4000 });
  }, 20000);

  it('a replay that is gone is said plainly, with the scoreboard and no review in its place', async () => {
    mockFetch({ '/api/coach/8000000001': board, '/api/agent/8000000001': { trace: false, model_configured: true, can_parse: true, heroes: [], parse: { status: 'failed', reason: 'replay_gone', final: true } } });
    page('/r/8000000001?hero=beastmaster&lang=en');
    expect(await screen.findByRole('heading', { name: 'The replay of this game is no longer available' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Scoreboard' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review my game' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByText('Ask the coach')).toBeNull();
  });

  it('other dead ends: parsing switched off, a parse that failed (retry offered), a match nobody knows', async () => {
    mockFetch({ '/api/coach/8000000002': board, '/api/agent/8000000002': { trace: false, model_configured: true, can_parse: false, heroes: [], parse: { status: 'none' } } });
    page('/r/8000000002?hero=beastmaster&lang=en');
    expect(await screen.findByRole('heading', { name: 'Replay reviews are not switched on here' })).toBeTruthy();
    cleanup();
    mockFetch({ '/api/coach/8000000003': board, '/api/agent/8000000003': { trace: false, model_configured: true, can_parse: true, heroes: [], parse: { status: 'failed', reason: 'download_failed', final: false } } });
    page('/r/8000000003?hero=beastmaster&lang=en');
    expect(await screen.findByRole('heading', { name: 'The replay could not be read' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    cleanup();
    mockFetch({ '/api/agent/8000000004': { trace: false, model_configured: true, can_parse: true, heroes: [], parse: { status: 'none' } } });
    page('/r/8000000004?lang=en');
    expect(await screen.findByRole('heading', { name: 'This match could not be opened' })).toBeTruthy();
  });

  it('with a trace: pick a hero, then the start is the reader\'s click, never automatic', async () => {
    const calls = mockFetch({ '/review?': { status: 'none' }, '/api/agent/9100904020': { trace: true, model_configured: true, can_parse: true, heroes } });
    page('/r/9100904020?lang=en');
    fireEvent.click(await screen.findByRole('button', { name: /Beastmaster/ }));
    expect(await screen.findByRole('heading', { name: 'Review this game' })).toBeTruthy();
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

  it('the review\'s goal can be set as the next-game goal, and removed', async () => {
    const goal = { kind: 'hold_item', items: ['blink', 'black_king_bar'], hero_id: 38, label: { en: 'On Beastmaster: finish with Blink Dagger or Black King Bar', zh: '用兽王时：出一件闪烁匕首或黑皇杖' }, finding: 1 };
    mockFetch({
      '/api/coach/9100904020': { ...board, match: { id: 9100904020, patch: '7.42', start_time: 1795344198, duration: 2551 } },
      'ref=overview': overview,
      '/review?': { status: 'ready', review: { ...review, goal }, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 },
      '/api/agent/9100904020': { trace: true, model_configured: true, can_parse: true, heroes },
    });
    page('/r/9100904020?hero=beastmaster&lang=en');
    expect(await screen.findByText('On Beastmaster: finish with Blink Dagger or Black King Bar')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Make this my next-game goal' }));
    expect(await screen.findByText(/✓ Your next-game goal · From finding 1/)).toBeTruthy();
    const stored = JSON.parse(window.localStorage.getItem('dota2ai.coach.goal')!);
    expect(stored).toMatchObject({ id: '9100904020:beastmaster:agent:hold_item:blink+black_king_bar', goal: { kind: 'hold_item', items: ['blink', 'black_king_bar'], hero_id: 38 }, action: goal.label, fromMatch: 9100904020, fromStart: 1795344198, accountId: 77, heroId: 38 });
    expect(stored.goal).not.toHaveProperty('finding');
    // The game the goal came from is not judged against it.
    expect(screen.queryByText('Your goal, in this game')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(window.localStorage.getItem('dota2ai.coach.goal')).toBeNull());
    // The same game reviewed in another language proposed a different goal: that card is not "already set".
    fireEvent.click(await screen.findByRole('button', { name: 'Make this my next-game goal' }));
    cleanup();
    mockFetch({
      '/api/coach/9100904020': { ...board, match: { id: 9100904020, patch: '7.42', start_time: 1795344198, duration: 2551 } },
      'ref=overview': overview,
      '/review?': { status: 'ready', review: { ...review, goal: { kind: 'deaths_per10_max', max: 1.7, label: { en: 'At most 1.7 deaths per 10 minutes', zh: 'x' }, finding: 1 } }, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 },
      '/api/agent/9100904020': { trace: true, model_configured: true, can_parse: true, heroes },
    });
    page('/r/9100904020?hero=beastmaster&lang=en');
    expect(await screen.findByText('At most 1.7 deaths per 10 minutes')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Make this my next-game goal' })).toBeTruthy();
    expect(screen.queryByText(/✓ Your next-game goal/)).toBeNull();
  });

  it('a later game is judged against the goal, at the top of its page', async () => {
    window.localStorage.setItem('dota2ai.coach.goal', JSON.stringify({ id: '9100904020:beastmaster:agent', goal: { kind: 'hold_item', items: ['blink', 'black_king_bar'], hero_id: 38, label: { en: 'On Beastmaster: finish with Blink Dagger or Black King Bar', zh: 'x' } }, action: { en: 'On Beastmaster: finish with Blink Dagger or Black King Bar', zh: 'x' }, findingId: 'agent:1', fromMatch: 9100904020, fromStart: 1795344198, accountId: 77, heroId: 38, setAt: 1 }));
    const later = { match: { id: 9100999999, patch: '7.42', start_time: 1795400000, duration: 2400 }, players: [board.players[0], { ...board.players[1], items: [{ key: 'blink', en: 'Blink Dagger', zh: '闪烁匕首' }] }], reviews: [{ role: { kind: 'core' } }, { role: { kind: 'core' } }] };
    mockFetch({ '/api/coach/9100999999': later, '/api/agent/9100999999': { trace: false, model_configured: true, can_parse: true, heroes: [], parse: { status: 'none' } } });
    page('/r/9100999999?hero=beastmaster&lang=en');
    expect(await screen.findByText('Your goal, in this game')).toBeTruthy();
    expect(screen.getByText('Met')).toBeTruthy();
    expect(screen.getByText('Finished with Blink Dagger')).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem('dota2ai.coach.goalChecks')!)).toEqual([expect.objectContaining({ goalId: '9100904020:beastmaster:agent', matchId: 9100999999, result: 'met' })]);
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
  it('the wait is four steps, and the live one follows the work', () => {
    const noTrace = (stage: string | null) => ({ trace: false, model_configured: true, can_parse: true, heroes: [], parse: { status: 'running' as const, stage } });
    const withTrace = { trace: true, model_configured: true, can_parse: true, heroes: [] };
    const steps = (n: number) => ({ status: 'running' as const, steps: Array.from({ length: n }, () => ({ tool: 'x', args: {} })) });
    expect([journeyStep(noTrace('locating'), null), journeyStep(noTrace('downloading'), null), journeyStep(noTrace('extracting'), null), journeyStep(noTrace('storing'), null)]).toEqual([0, 0, 1, 1]);
    expect([journeyStep(withTrace, { status: 'none' }), journeyStep(withTrace, steps(2)), journeyStep(withTrace, steps(6))]).toEqual([2, 2, 3]);
  });
  it('names the agent\'s steps for the reader', () => {
    expect(stepLabel({ tool: 'fight_timeline', args: { from: 1805, to: 1860 } }, 'zh')).toBe('回放团战 30:05–31:00');
    expect(stepLabel({ tool: 'death_context', args: { hero: 'x', index: 9 } }, 'en')).toBe('Looking at a death #9');
    expect(stepLabel({ tool: 'new_tool', args: {} }, 'en')).toBe('new_tool');
  });
});
