// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AgentMatchPage, journeyStep, REPLAY_NOT_READY } from './AgentMatchPage';
import { stepLabel } from './ChatRail';
import { buildingLabel } from './EvidenceCard';

const ui = vi.hoisted(() => ({ lang: 'en' }));
vi.mock('../v2/i18n/I18nProvider', () => ({ useI18n: () => ({ lang: ui.lang, setLang: () => {} }) }));

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
const overview = { status: 'ok', ref: 'overview', kind: 'overview', names: {}, record: { duration: { t: 2551 }, fights: [{ ref: 'fight:11', from: 1826, to: 1848, clock: '30:26–30:48', my_team_deaths: 5, enemy_deaths: 3, my_team_gold_lead_before: -745, my_team_gold_lead_2min_after: -4298 }], turning_fight: { ref: 'fight:11', clock: '30:26–30:48' } } };

type Handler = (url: string, init?: RequestInit) => any;
// Events leave by beacon, as in a browser, so they are not among the page's own requests.
const beacons: Promise<any>[] = [];
const events = async () => Promise.all(beacons);
const readBlob = (b: Blob) => new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsText(b); });
beforeEach(() => { (navigator as any).sendBeacon = (_url: string, body: Blob) => { beacons.push(readBlob(body).then((t) => JSON.parse(t))); return true; }; });
afterEach(() => { delete (navigator as any).sendBeacon; beacons.length = 0; });

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

afterEach(() => { ui.lang = 'en'; cleanup(); vi.unstubAllGlobals(); window.sessionStorage.clear(); window.localStorage.clear(); });

describe('AgentMatchPage', () => {
  it('no parsed replay yet: the roster comes from the scoreboard, and one click runs replay → parse → review', async () => {
    let polls = 0; let started = 0;
    const calls = mockFetch({
      '/api/coach/9100904020': board,
      'ref=deaths': { status: 'ok', ref: 'deaths:beastmaster', kind: 'deaths', names: { phantom_assassin: 'Phantom Assassin' }, record: { deaths_total: 2, killed_by: { phantom_assassin: 2 }, deaths_where: { in_a_fight: ['8:27'], outside_fights: ['0:47'] } } },
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
    // No replay parsed yet: none of the replay's facts to show, and none asked for — but the match record is
    // there already, so the scoreboard is on the waiting screen from the start, outside the progress region.
    expect(document.querySelector('.ag-wait')).toBeNull();
    const boardWhileParsing = screen.getByRole('region', { name: 'Scoreboard' });
    expect(boardWhileParsing.closest('[role="status"]')).toBeNull();
    expect(document.querySelector('.ag-state')!.compareDocumentPosition(boardWhileParsing) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(calls.some((c) => c.url.includes('ref=deaths'))).toBe(false);
    // The trace arrives: the review starts without a second click.
    await waitFor(() => expect(started).toBe(1), { timeout: 8000 });
    expect(await screen.findByText('Reading the whole game', {}, { timeout: 8000 })).toBeTruthy();
    // While the review is written: the reader's own deaths from the parsed replay, outside the progress region.
    const wait = (await screen.findByRole('heading', { level: 2, name: 'While the coach reads the replay: your 2 deaths' })).closest('section')!;
    expect(Array.from(wait.querySelectorAll('.ag-wait-clock')).map((e) => e.textContent)).toEqual(['0:47', '8:27']);
    expect(wait.closest('[role="status"]')).toBeNull();
    // Still there while the review is written, after the deaths.
    expect(wait.compareDocumentPosition(screen.getByRole('region', { name: 'Scoreboard' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  describe('a replay that is not ready yet (the game just ended)', () => {
    const was = { ...REPLAY_NOT_READY };
    beforeEach(() => { REPLAY_NOT_READY.askEveryMs = 40; });
    afterEach(() => { Object.assign(REPLAY_NOT_READY, was); });
    const notReady = { status: 'failed', reason: 'no_replay_url', final: false };
    const availWith = (parse: object) => ({ trace: false, model_configured: true, can_parse: true, heroes: [], parse });

    it('the reader said go: the page keeps asking and goes again by itself when the server allows it — no second click', async () => {
      let prepared = 0; let allowed = false; let asks = 0;
      const calls = mockFetch({
        '/api/coach/9100904020': board,
        // The first try fails for want of a replay address; the second one, once allowed, runs.
        '/prepare': () => { prepared += 1; return prepared === 1 ? notReady : { status: 'running', stage: 'locating' }; },
        '/api/agent/9100904020': () => { asks += 1; return availWith(prepared === 0 ? { status: 'none' } : prepared === 1 ? (allowed ? { status: 'none' } : notReady) : { status: 'running', stage: 'downloading' }); },
      });
      page('/r/9100904020?hero=beastmaster&lang=en');
      fireEvent.click(await screen.findByRole('button', { name: 'Review my game' }));
      expect(await screen.findByRole('heading', { name: 'The replay is not ready yet' })).toBeTruthy();
      // It says what will happen, and it is happening: the state is asked for again and again.
      expect(screen.getByText(/Leave this page open: it will try again by itself in a few minutes/)).toBeTruthy();
      const before = asks;
      await waitFor(() => expect(asks).toBeGreaterThanOrEqual(before + 3));
      expect(prepared).toBe(1);
      // The server's retry time has passed: the next ask says so, and the parse is started again without a click.
      allowed = true;
      await waitFor(() => expect(prepared).toBe(2));
      expect(await screen.findByRole('heading', { name: 'Working on your review' })).toBeTruthy();
      expect(calls.filter((c) => c.url.includes('/prepare'))).toHaveLength(2);
    });

    it('a reader who never said go is not waited for: the plain message, and nothing asked again', async () => {
      let asks = 0;
      mockFetch({ '/api/coach/9100904020': board, '/api/agent/9100904020': () => { asks += 1; return availWith(notReady); } });
      page('/r/9100904020?hero=beastmaster&lang=en');
      expect(await screen.findByRole('heading', { name: 'The replay is not ready yet' })).toBeTruthy();
      expect(screen.getByText(/Try again shortly\./)).toBeTruthy();
      expect(screen.queryByText(/Leave this page open/)).toBeNull();
      const seen = asks;
      await new Promise((r) => setTimeout(r, 300));
      expect(asks).toBe(seen);
    });

    it('it goes again by itself a few times, then leaves it to the reader', async () => {
      REPLAY_NOT_READY.triesByItself = 2;
      let prepared = 0; let asks = 0; let lastAsk = 0;
      mockFetch({
        '/api/coach/9100904020': board,
        '/prepare': () => { prepared += 1; lastAsk = asks; return notReady; },
        // Every third ask after a try the server allows another one; every try fails the same way.
        '/api/agent/9100904020': () => { asks += 1; return availWith(prepared === 0 || asks - lastAsk >= 3 ? { status: 'none' } : notReady); },
      });
      page('/r/9100904020?hero=beastmaster&lang=en');
      fireEvent.click(await screen.findByRole('button', { name: 'Review my game' }));
      // The click, then two more by itself.
      await waitFor(() => expect(prepared).toBe(3), { timeout: 6000 });
      await waitFor(() => expect(screen.getByText(/Try again shortly\./)).toBeTruthy());
      expect(screen.queryByText(/Leave this page open/)).toBeNull();
      const seen = asks;
      await new Promise((r) => setTimeout(r, 400));
      expect(asks).toBe(seen);
      expect(prepared).toBe(3);
      // The reader can still ask for it.
      expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    }, 12000);
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
    expect(await screen.findByText('Axe verdict.')).toBeTruthy();
    slow();
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByText('Axe verdict.')).toBeTruthy();
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
    expect(await screen.findByRole('heading', { level: 1, name: review.findings[0].title }, { timeout: 6000 })).toBeTruthy();
    expect(screen.getByText(review.verdict)).toBeTruthy();
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

  it('prepare answers "ready" and the next refresh fails: the page keeps asking until it has the trace', async () => {
    let n = 0; let started = 0;
    mockFetch({
      '/api/coach/9100904020': board,
      '/prepare': { status: 'ready' },
      '/review?': () => (started ? { status: 'running', steps: [] } : { status: 'none' }),
      '/review': (_u: string, init?: RequestInit) => { if (init?.method === 'POST') { started += 1; return { status: 'running', steps: [] }; } return null; },
      // No trace at first; the refresh right after prepare fails; then the trace is there.
      '/api/agent/9100904020': () => { n += 1; return n === 1 ? { trace: false, model_configured: true, can_parse: true, heroes: [], parse: { status: 'none' } } : n === 2 ? new Response('bad gateway', { status: 502 }) : { trace: true, model_configured: true, can_parse: true, heroes }; },
    });
    page('/r/9100904020?hero=beastmaster&lang=en');
    fireEvent.click(await screen.findByRole('button', { name: 'Review my game' }));
    await waitFor(() => expect(started).toBe(1), { timeout: 9000 });
    expect(n).toBeGreaterThanOrEqual(3);
  }, 20000);

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

  it('a fight is shown from both sides: who was in it, what was ready, and where the others were (review of #296)', async () => {
    const names = { beastmaster: '兽王', undying: '不朽尸王', dark_willow: '邪影芳灵', sven: '斯温', skywrath_mage: '天怒法师', axe: '斧王', phantom_assassin: '幻影刺客', mirana: '米拉娜', undying_flesh_golem: '腐肉傀儡', beastmaster_primal_roar: '原始咆哮', dire_bot_lane: '夜魇下路', radiant_top_lane: '天辉上路' };
    const fight = { status: 'ok', ref: 'fights:beastmaster:9', kind: 'fights', names, record: {
      ref: 'fights:beastmaster:9', fight: 'fight:9', clock: '25:25', engaged_at: '25:10', lost_fewer_heroes: 'enemy', more_heroes_took_part: 'enemy', me: 'took_part', my_team_gold_lead: -5200,
      my_team: { deaths: 2, took_part_count: 3, took_part: ['beastmaster', 'undying', 'dark_willow'], levels_of_those_in_it: 42,
        ultimates_ready: [{ hero: 'beastmaster', ability: 'beastmaster_primal_roar' }], ultimates_not_ready: [{ hero: 'undying', ability: 'undying_flesh_golem', why: 'cooldown', seconds_left: 124 }], black_king_bars_ready: [],
        not_in_it: [{ hero: 'sven', doing: 'none_of_these', place: 'dire_bot_lane', distance: 14151, tp_ready: null }, { hero: 'skywrath_mage', doing: 'none_of_these', place: 'radiant_top_lane', distance: 1631, tp_ready: true }] },
      enemy: { deaths: 1, took_part_count: 2, took_part: ['axe', 'phantom_assassin'], levels_of_those_in_it: 30, ultimates_ready: [], ultimates_not_ready: [], black_king_bars_ready: ['phantom_assassin'], not_in_it: [{ hero: 'mirana', doing: 'dead', respawn_in: 32 }] },
    } };
    const cites = (ref: string) => ({ ...review, lang: 'zh', findings: [{ ...review.findings[0], evidence: [{ refs: [ref], fact: '3 打 4。' }] }] });
    const chip = (text: string) => screen.getByText((_, el) => /^ag-chip/.test(el?.className ?? '') && el!.textContent === text);
    ui.lang = 'zh';
    mockFetch({ 'ref=overview': overview, '/evidence?': fight, '/review?': { status: 'ready', review: cites('fights:beastmaster:9'), verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 }, '/api/agent/9100904020': { trace: true, model_configured: true, heroes } });
    page('/r/9100904020?hero=beastmaster&lang=zh');
    fireEvent.click((await screen.findAllByRole('button', { name: '看原始记录' }))[0]);
    expect(await screen.findByText(/开打 25:10/)).toBeTruthy();
    expect(chip('斯温 · 夜魇下路14151 码外')).toBeTruthy();
    expect(chip('天怒法师 · 天辉上路1631 码外TP 可用')).toBeTruthy();
    expect(chip('米拉娜 · 阵亡复活还要 32秒')).toBeTruthy();
    expect(chip('不朽尸王 · 冷却124秒')).toBeTruthy();
    // In the fight, and with Black King Bar ready.
    expect(screen.getAllByText((_, el) => /^ag-chip/.test(el?.className ?? '') && el!.textContent === '幻影刺客')).toHaveLength(2);
    expect(screen.getByText('-5200')).toBeTruthy();
    expect(screen.queryByText(/dire_bot_lane|none_of_these|tp_ready/)).toBeNull();
  });

  it('the totals of pushes and of fights are labelled in the reader\'s language, never as field names (review of #302)', async () => {
    const chip = (text: string) => screen.getByText((_, el) => /^ag-chip/.test(el?.className ?? '') && el!.textContent === text);
    const cites = (ref: string) => ({ status: 'ready', review: { ...review, lang: 'zh', findings: [{ ...review.findings[0], evidence: [{ refs: [ref], fact: '对方推了 19 次。' }] }] }, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 });
    const sieges = { status: 'ok', ref: 'sieges:beastmaster', kind: 'sieges', names: { beastmaster: '兽王' }, record: {
      ref: 'sieges:beastmaster', ref_scope: 'summary', hero: 'beastmaster', my_team_pushes: 5, my_team_pushes_that_took_it: 4, enemy_pushes: 19, enemy_pushes_that_took_it: 17,
      pushes_with_two_or_more_hitting_than_near: { pushes: 12, took_it: 9 }, pushes_with_at_most_one_more_hitting_than_near: { pushes: 12, took_it: 12 }, my_team_pushes_i_hit: 3, my_buildings_taken_with_me_not_near: 14,
    } };
    ui.lang = 'zh';
    mockFetch({ 'ref=overview': overview, '/evidence?': sieges, '/review?': cites('sieges:beastmaster'), '/api/agent/9100904020': { trace: true, model_configured: true, heroes } });
    page('/r/9100904020?hero=beastmaster&lang=zh');
    fireEvent.click((await screen.findAllByRole('button', { name: '看原始记录' }))[0]);
    expect(await screen.findByText((_, el) => /^ag-chip/.test(el?.className ?? '') && el!.textContent === '对方推塔 19')).toBeTruthy();
    expect(chip('打塔人数比守方多 2 人及以上 · 被拆 9')).toBeTruthy();
    expect(chip('己方丢塔时你不在附近 14')).toBeTruthy();
    expect(screen.queryByText(/my team|pushes that|took it|with me/)).toBeNull();
    cleanup();

    const fights = { status: 'ok', ref: 'fights:beastmaster', kind: 'fights', names: { beastmaster: '兽王' }, record: {
      ref: 'fights:beastmaster', ref_scope: 'summary', hero: 'beastmaster', fights_total: 16, fights_my_team_lost_fewer: 6, fights_enemy_lost_fewer: 9, fights_with_more_of_my_team: 5, fights_with_more_of_the_enemy: 2,
      fights_the_side_with_more_heroes_lost_fewer: { fights_with_unequal_numbers: 7, the_side_with_more_lost_fewer: 3 }, fights_i_took_part_in: 16,
    } };
    mockFetch({ 'ref=overview': overview, '/evidence?': fights, '/review?': cites('fights:beastmaster'), '/api/agent/9100904020': { trace: true, model_configured: true, heroes } });
    page('/r/9100904020?hero=beastmaster&lang=zh');
    fireEvent.click((await screen.findAllByRole('button', { name: '看原始记录' }))[0]);
    expect(await screen.findByText((_, el) => /^ag-chip/.test(el?.className ?? '') && el!.textContent === '团战 16')).toBeTruthy();
    expect(chip('人数不等的团战 · 人多一方少死人 3')).toBeTruthy();
    expect(screen.queryByText(/fights total|lost fewer|took part/)).toBeNull();
  });

  it('a death says whether it was traded, and where the allies who were not near were', async () => {
    const death = { status: 'ok', ref: 'death:beastmaster:9', kind: 'death', names: { beastmaster: '兽王', phantom_assassin: '幻影刺客', sven: '斯温', skywrath_mage: '天怒法师', radiant_top_lane: '天辉上路' }, record: {
      ref: 'death:beastmaster:9', n: 9, t: 2165, clock: '36:05', killer: 'phantom_assassin',
      snapshots: [{ dt: -1, me: { hp: 300, max_hp: 2915 }, allies: [], enemies: [{ hero: 'phantom_assassin', dist: 150 }] }],
      ready_not_cast: [], controls_on_me: [], damage_taken: [{ from: 'phantom_assassin', by: 'attack', value: 2600 }],
      traded_within_15s: false, observers_within_1600: { my_team: 0, enemy: 2 }, bought_back: '36:20',
      allies_elsewhere: [{ hero: 'sven', place: 'radiant_top_lane', distance: 9100, tp_ready: true }, { hero: 'skywrath_mage', doing: 'dead', respawn_in: 25 }],
    } };
    const chip = (text: string) => screen.getByText((_, el) => /^ag-chip/.test(el?.className ?? '') && el!.textContent === text);
    ui.lang = 'zh';
    mockFetch({ 'ref=overview': overview, '/evidence?': death, '/review?': { status: 'ready', review: { ...review, lang: 'zh', findings: [{ ...review.findings[0], evidence: [{ refs: ['death:beastmaster:9'], fact: '36:05 阵亡。' }] }] }, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 }, '/api/agent/9100904020': { trace: true, model_configured: true, heroes } });
    page('/r/9100904020?hero=beastmaster&lang=zh');
    fireEvent.click((await screen.findAllByRole('button', { name: '看原始记录' }))[0]);
    expect(await screen.findByText('没换到：15 秒内对面没死英雄')).toBeTruthy();
    expect(chip('我方 0')).toBeTruthy();
    expect(chip('敌方 2')).toBeTruthy();
    expect(chip('买活 36:20')).toBeTruthy();
    cleanup();
    // A buyback is shown without wards too (a trace with buybacks and no ward file; review of #305).
    mockFetch({ 'ref=overview': overview, '/evidence?': { ...death, ref: 'death:beastmaster:10', record: { ...death.record, ref: 'death:beastmaster:10', observers_within_1600: null, bought_back: '36:20' } }, '/review?': { status: 'ready', review: { ...review, lang: 'zh', findings: [{ ...review.findings[0], evidence: [{ refs: ['death:beastmaster:10'], fact: '36:05 阵亡。' }] }] }, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 }, '/api/agent/9100904020': { trace: true, model_configured: true, heroes } });
    page('/r/9100904020?hero=beastmaster&lang=zh');
    fireEvent.click((await screen.findAllByRole('button', { name: '看原始记录' }))[0]);
    expect(await screen.findByText((_, el) => /^ag-chip/.test(el?.className ?? '') && el!.textContent === '买活 36:20')).toBeTruthy();
    expect(screen.queryByText('1600 码内的假眼')).toBeNull();
    expect(chip('斯温 · 天辉上路9100 码外TP 可用')).toBeTruthy();
    expect(chip('天怒法师 · 阵亡复活还要 25秒')).toBeTruthy();
    cleanup();

    // The totals: the trade lists are counted and labelled in the reader's language.
    const totals = { status: 'ok', ref: 'deaths:beastmaster', kind: 'deaths', names: { beastmaster: '兽王' }, record: {
      ref: 'deaths:beastmaster', ref_scope: 'summary', hero: 'beastmaster', deaths_total: 11,
      // Twenty other counters ahead of them: the trade counts still show, on a line of their own (review of #303).
      killed_by: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`hero_${i}`, 1])),
      deaths_where: { traded_within_15s: ['2:51', '6:13', '8:27'], not_traded_within_15s: ['0:47', '11:03'], no_ally_within_2200_at_death_and_not_traded: ['0:47'] },
    } };
    mockFetch({ 'ref=overview': overview, '/evidence?': totals, '/review?': { status: 'ready', review: { ...review, lang: 'zh', findings: [{ ...review.findings[0], evidence: [{ refs: ['deaths:beastmaster'], fact: '11 次阵亡。' }] }] }, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 }, '/api/agent/9100904020': { trace: true, model_configured: true, heroes } });
    page('/r/9100904020?hero=beastmaster&lang=zh');
    fireEvent.click((await screen.findAllByRole('button', { name: '看原始记录' }))[0]);
    expect(await screen.findByText((_, el) => /^ag-chip/.test(el?.className ?? '') && el!.textContent === '没换到 2')).toBeTruthy();
    expect(chip('换到了（15 秒内对面也死了英雄） 3')).toBeTruthy();
    expect(chip('身边没人且没换到 1')).toBeTruthy();
    expect(screen.queryByText(/traded/)).toBeNull();
  });

  it('a won fight is shown with who was still dead and for how long, and what the winners did with it', async () => {
    const point = { status: 'ok', ref: 'decision:spectre:4', kind: 'decision', names: { juggernaut: '主宰', lion: '莱恩', zuus: '宙斯', silencer: '沉默术士', invoker: '祈求者' }, record: {
      ref: 'decision:spectre:4', kind: 'after_a_won_fight', fight: 'fight:4', clock: '20:58', won_by: 'my_team', deaths: { my_team: 2, enemy: 4 },
      losers_still_dead_10s_after: 4, losers_respawn_in: [{ hero: 'juggernaut', seconds: 17 }, { hero: 'lion', seconds: 15 }, { hero: 'zuus', seconds: 31 }, { hero: 'silencer', seconds: 22 }],
      winners_did: 'took_a_building', buildings_winners_took: [{ building: 'badguys_tower1_mid', clock: '20:54', during_the_fight: true }], pushes: [], losers_took_back: [], me: 'did_not_hit', losers_richest: { hero: 'invoker', still_dead_10s_after: false },
    } };
    const chip = (text: string) => screen.getByText((_, el) => /^ag-chip/.test(el?.className ?? '') && el!.textContent === text);
    ui.lang = 'zh';
    mockFetch({ 'ref=overview': overview, '/evidence?': point, '/review?': { status: 'ready', review: { ...review, lang: 'zh', findings: [{ ...review.findings[0], evidence: [{ refs: ['decision:spectre:4'], fact: '20:58 赢团。' }] }] }, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 }, '/api/agent/9100904020': { trace: true, model_configured: true, heroes } });
    page('/r/9100904020?hero=beastmaster&lang=zh');
    fireEvent.click((await screen.findAllByRole('button', { name: '看原始记录' }))[0]);
    expect(await screen.findByText(/我方赢团 · 2 : 4/)).toBeTruthy();
    expect(chip('宙斯31秒')).toBeTruthy();
    expect(chip('随后拆到建筑')).toBeTruthy();
    expect(chip('20:54 · 中路 1 塔')).toBeTruthy();
    expect(screen.getByText('对方经济最高')).toBeTruthy();
    expect(chip('祈求者已复活')).toBeTruthy();
    expect(screen.queryByText(/took_a_building|badguys|juggernaut/)).toBeNull();
    cleanup();
    // A fight the enemy won: what the player's team took back is the player's team's (review of #306).
    mockFetch({ 'ref=overview': overview, '/evidence?': { ...point, ref: 'decision:spectre:5', record: { ...point.record, ref: 'decision:spectre:5', won_by: 'enemy', winners_did: 'neither', buildings_winners_took: [], losers_took_back: [{ building: 'badguys_tower2_top', clock: '22:10' }] } }, '/review?': { status: 'ready', review: { ...review, lang: 'zh', findings: [{ ...review.findings[0], evidence: [{ refs: ['decision:spectre:5'], fact: '20:58 输团。' }] }] }, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 }, '/api/agent/9100904020': { trace: true, model_configured: true, heroes } });
    page('/r/9100904020?hero=beastmaster&lang=zh');
    fireEvent.click((await screen.findAllByRole('button', { name: '看原始记录' }))[0]);
    expect(await screen.findByText('我方反拆')).toBeTruthy();
    expect(screen.queryByText('对方反拆')).toBeNull();
  });

  it('a tower that fell is shown with what its takers did next, what they lost meanwhile, and where the player was', async () => {
    const point = { status: 'ok', ref: 'decision:spectre:20', kind: 'decision', names: { sven: '斯温', radiant_jungle: '天辉野区' }, record: {
      ref: 'decision:spectre:20', kind: 'after_a_tower_fell', building: 'goodguys_tower1_top', tier: 1, clock: '18:07', taken_by: 'enemy', after_won_fight: null,
      hitting: ['sven'], takers_did: 'neither', buildings_takers_took_next: [], pushes: [], owners_took_back: [{ building: 'badguys_tower1_mid', clock: '18:50' }],
      me: 'elsewhere', my_place: 'radiant_jungle', distance_from_its_hitters: 5200,
    } };
    const chip = (text: string) => screen.getByText((_, el) => /^ag-chip/.test(el?.className ?? '') && el!.textContent === text);
    ui.lang = 'zh';
    mockFetch({ 'ref=overview': overview, '/evidence?': point, '/review?': { status: 'ready', review: { ...review, lang: 'zh', findings: [{ ...review.findings[0], evidence: [{ refs: ['decision:spectre:20'], fact: '18:07 掉上路 1 塔。' }] }] }, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 }, '/api/agent/9100904020': { trace: true, model_configured: true, heroes } });
    page('/r/9100904020?hero=beastmaster&lang=zh');
    fireEvent.click((await screen.findAllByRole('button', { name: '看原始记录' }))[0]);
    expect(await screen.findByText(/对方拆掉 上路 1 塔/)).toBeTruthy();
    expect(chip('随后什么都没拿')).toBeTruthy();
    expect(screen.getByText('同时我方拆掉')).toBeTruthy();
    expect(chip('18:50 · 中路 1 塔')).toBeTruthy();
    expect(chip('你在别处 · 天辉野区5200 码外')).toBeTruthy();
    expect(screen.queryByText(/after_a_tower_fell|goodguys|radiant_jungle|elsewhere/)).toBeNull();
  });

  it('a fight after big items is shown with whose items, which, when, and who lost fewer', async () => {
    const point = { status: 'ok', ref: 'decision:spectre:30', kind: 'decision', names: { phantom_assassin: '幻影刺客', black_king_bar: '黑皇杖', sven: '斯温', armlet: '莫尔迪基安的臂章' }, record: {
      ref: 'decision:spectre:30', kind: 'fight_after_a_big_item', fight: 'fight:7', clock: '21:59',
      items: [{ hero: 'phantom_assassin', side: 'enemy', item: 'black_king_bar', clock: '21:29', ref: 'item:phantom_assassin:black_king_bar' }, { hero: 'sven', side: 'my_team', item: 'armlet', clock: '21:37', ref: 'item:sven:armlet' }],
      items_from: 'both', deaths: { my_team: 3, enemy: 1 }, lost_fewer: 'enemy',
    } };
    const chip = (text: string) => screen.getByText((_, el) => /^ag-chip/.test(el?.className ?? '') && el!.textContent === text);
    ui.lang = 'zh';
    mockFetch({ 'ref=overview': overview, '/evidence?': point, '/review?': { status: 'ready', review: { ...review, lang: 'zh', findings: [{ ...review.findings[0], evidence: [{ refs: ['decision:spectre:30'], fact: '21:59 团战。' }] }] }, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 }, '/api/agent/9100904020': { trace: true, model_configured: true, heroes } });
    page('/r/9100904020?hero=beastmaster&lang=zh');
    fireEvent.click((await screen.findAllByRole('button', { name: '看原始记录' }))[0]);
    expect(await screen.findByText(/大件后的团战 · 3 : 1/)).toBeTruthy();
    expect(chip('幻影刺客 · 黑皇杖21:29')).toBeTruthy();
    expect(chip('对方少死')).toBeTruthy();
    expect(screen.queryByText(/black_king_bar|phantom_assassin|lost_fewer/)).toBeNull();
  });

  it('a Roshan is shown as who held the Aegis, who was there, what became of it, and what each side took after', async () => {
    const take = { status: 'ok', ref: 'roshan:beastmaster:1', kind: 'roshan', names: { phantom_assassin: '幻影刺客', axe: '斧王', mirana: '米拉娜', river_top_jungle: '河道上路野区' }, record: {
      ref: 'roshan:beastmaster:1', clock: '32:18', taken_by: 'enemy', aegis_holder: 'phantom_assassin', place: 'river_top_jungle', taking_side_near: ['axe', 'mirana'], other_side_near: [], me: 'not_there',
      aegis: 'used', aegis_used_at: '36:43', buildings_taking_side_took_in_the_next_300s: [{ clock: '36:22', building: 'badguys_tower2_top' }], buildings_other_side_took_in_the_next_300s: [], buildings_taking_side_took_count: 1,
      fights_in_the_next_300s: [{ fight: 'fight:12', clock: '33:31', aegis_side_deaths: 3, other_side_deaths: 1 }], taking_side_pushes_in_the_next_300s: { pushes: 2, took_it: 1 },
    } };
    const chip = (text: string) => screen.getByText((_, el) => /^ag-chip/.test(el?.className ?? '') && el!.textContent === text);
    ui.lang = 'zh';
    mockFetch({ 'ref=overview': overview, '/evidence?': take, '/review?': { status: 'ready', review: { ...review, lang: 'zh', findings: [{ ...review.findings[0], evidence: [{ refs: ['roshan:beastmaster:1'], fact: '32:18 对面打掉肉山。' }] }] }, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 }, '/api/agent/9100904020': { trace: true, model_configured: true, heroes } });
    page('/r/9100904020?hero=beastmaster&lang=zh');
    fireEvent.click((await screen.findAllByRole('button', { name: '看原始记录' }))[0]);
    expect(await screen.findByText(/对方打掉肉山 · 河道上路野区/)).toBeTruthy();
    expect(chip('不朽盾 幻影刺客 · 用掉36:43')).toBeTruthy();
    expect(chip('你不在场')).toBeTruthy();
    expect(chip('36:22 · 上路 2 塔')).toBeTruthy();
    expect(chip('33:31 · 3 : 1')).toBeTruthy();
    expect(screen.queryByText(/river_top|badguys|aegis/)).toBeNull();
  });

  it('a push is shown as who hit the building, which owners were near, whether it fell, and where the rest were', async () => {
    const push = { status: 'ok', ref: 'sieges:beastmaster:5', kind: 'sieges', names: { phantom_assassin: '幻影刺客', sven: '斯温', beastmaster: '兽王', axe: '斧王', dire_top_lane: '夜魇上路', radiant_bot_jungle: '天辉下路野区', river_bot_lane: '河道下路' }, record: {
      ref: 'sieges:beastmaster:5', building: 'badguys_tower1_mid', clock: '19:59', until: '20:01', pushed_by: 'enemy', took_it: true, fell_at: '20:02',
      hitting: ['phantom_assassin'], owners_near: [], hitting_minus_owners_near: 1, me: 'not_near',
      me_when_it_fell: { place: 'river_bot_lane', distance: 6695, tp_ready: true },
      pushing_side_not_hitting: [{ hero: 'axe', place: 'radiant_bot_jungle', distance: 5356, tp_ready: false }],
      owners_not_near: [{ hero: 'sven', place: 'dire_top_lane', distance: 8297, tp_ready: true }, { hero: 'beastmaster', doing: 'dead', respawn_in: 20 }],
    } };
    const chip = (text: string) => screen.getByText((_, el) => /^ag-chip/.test(el?.className ?? '') && el!.textContent === text);
    ui.lang = 'zh';
    mockFetch({ 'ref=overview': overview, '/evidence?': push, '/review?': { status: 'ready', review: { ...review, lang: 'zh', findings: [{ ...review.findings[0], evidence: [{ refs: ['sieges:beastmaster:5'], fact: '20:02 中路一塔被拆。' }] }] }, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 }, '/api/agent/9100904020': { trace: true, model_configured: true, heroes } });
    page('/r/9100904020?hero=beastmaster&lang=zh');
    fireEvent.click((await screen.findAllByRole('button', { name: '看原始记录' }))[0]);
    expect(await screen.findByText(/中路 1 塔 · 对方推/)).toBeTruthy();
    expect(chip('被拆 20:02')).toBeTruthy();
    expect(chip('你不在附近')).toBeTruthy();
    // Where the player was at the second it fell, apart from the rows taken when the push began.
    expect(chip('被拆时你 · 河道下路6695 码外')).toBeTruthy();
    expect(screen.getByText('守方不在附近（推进开始时）')).toBeTruthy();
    expect(screen.getByText('推塔方其余（推进开始时）')).toBeTruthy();
    expect(chip('斯温 · 夜魇上路8297 码外TP 可用')).toBeTruthy();
    expect(chip('兽王 · 阵亡复活还要 20秒')).toBeTruthy();
    expect(chip('斧王 · 天辉下路野区5356 码外TP 冷却中')).toBeTruthy();
    expect(screen.queryByText(/badguys_tower|dire_top_lane|owners_near/)).toBeNull();
  });

  it('a moment is shown as all ten heroes: where, doing what, and what was ready (review of #296)', async () => {
    const h = (hero: string, extra: any) => ({ hero, alive: true, place: 'dire_bot_lane', doing: 'none_of_these', level: 16, hp_pct: 100, mana: 800, tp_ready: null, black_king_bar_ready: null, ...extra });
    const state = { status: 'ok', ref: 'state:beastmaster:1510', kind: 'state', names: { beastmaster: '兽王', sven: '斯温', axe: '斧王', dire_bot_lane: '夜魇下路', radiant_top_lane: '天辉上路' }, record: {
      ref: 'state:beastmaster:1510', clock: '25:10', my_team_gold_lead: -2500,
      my_team: { alive: 2, trading_damage_with_enemy_heroes: 1, ultimates_ready: 1, heroes: [h('beastmaster', { doing: 'trading_damage_with_enemy_heroes', ultimate: { ability: 'beastmaster_primal_roar', ready: true }, tp_ready: false }), h('sven', { alive: false, doing: 'dead', respawn_in: 12, place: undefined })] },
      enemy: { alive: 1, trading_damage_with_enemy_heroes: 1, ultimates_ready: 0, heroes: [h('axe', { place: 'radiant_top_lane', ultimate: { ability: 'axe_culling_blade', ready: false, why: 'cooldown', seconds_left: 40 }, black_king_bar_ready: true })] },
    } };
    ui.lang = 'zh';
    mockFetch({ 'ref=overview': overview, '/evidence?': state, '/review?': { status: 'ready', review: { ...review, lang: 'zh', findings: [{ ...review.findings[0], evidence: [{ refs: ['state:beastmaster:1510'], fact: '25:10 斯温阵亡。' }] }] }, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 }, '/api/agent/9100904020': { trace: true, model_configured: true, heroes } });
    page('/r/9100904020?hero=beastmaster&lang=zh');
    fireEvent.click((await screen.findAllByRole('button', { name: '看原始记录' }))[0]);
    expect(await screen.findByRole('row', { name: '兽王 夜魇下路 · 在和敌方英雄交手 16 100% 是 – 否' })).toBeTruthy();
    expect(screen.getByRole('row', { name: '斯温 阵亡 · 复活还要 12秒 16 100% – – –' })).toBeTruthy();
    expect(screen.getByRole('row', { name: '斧王 天辉上路 16 100% 否 · 40秒 是 –' })).toBeTruthy();
  });

  it('a stretch of the game and the game\'s tempo are shown as what was taken, lost and where the hero was', async () => {
    const phase = { status: 'ok', ref: 'phase:beastmaster:3', kind: 'phase', names: { radiant_top_lane: '天辉上路', beastmaster: '兽王' }, record: {
      ref: 'phase:beastmaster:3', from: 1200, to: 1800, clock: '20:00–30:00', buildings_team_took: 1, buildings_opponents_took: 1,
      buildings: [{ building: 'badguys_tower1_mid', t: 1202, clock: '20:02', taken_by: 'opponents' }, { building: 'goodguys_tower2_top', t: 1505.9, clock: '25:05', taken_by: 'team', hero_damaged_it: true, heroes_who_damaged_it: ['beastmaster'] }],
      team_hero_deaths: 10, opponents_hero_deaths: 9, hero_deaths: 2,
      fights: [{ overview_fight: 'fight:7', clock: '21:59', team_deaths: 3, opponents_deaths: 1, lost_fewer_heroes: 'opponents', hero_was_there: true }, { overview_fight: 'fight:8', clock: '22:57', team_deaths: 0, opponents_deaths: 3, lost_fewer_heroes: 'team', hero_was_there: false }],
      hero_alive_seconds: 504, hero_dead_seconds: 96,
      hero_share_of_alive_time: { on_own_side_of_the_map: 0.44, around_the_river: 0.22, on_the_opponents_side: 0.34, with_no_ally_within_2200: 0.32, with_one_ally_within_2200: 0.17, with_two_or_more_allies_within_2200: 0.52, with_three_or_more_opponents_within_2200: null },
      hero_most_time_in: [{ place: 'radiant_top_lane', share_of_alive_time: 0.32 }], hero_damage_to_buildings: 248, team_heroes_damage_to_buildings: 455,
    } };
    const tempo = { status: 'ok', ref: 'tempo:beastmaster', kind: 'tempo', names: { beastmaster: '兽王' }, record: {
      ref: 'tempo:beastmaster', ref_scope: 'summary', hero: 'beastmaster', duration: { t: 2551, clock: '42:31' }, phases_total: 2, buildings_total: { team_took: 4, opponents_took: 18 },
      first_building_taken: { by_team: '18:07', by_opponents: null },
      buildings_team_took_by_phase: { '0:00–10:00': 0, '10:00–20:00': 3 }, buildings_opponents_took_by_phase: { '0:00–10:00': 0, '10:00–20:00': 0 }, team_hero_deaths_by_phase: { '0:00–10:00': 12, '10:00–20:00': 7 }, opponents_hero_deaths_by_phase: { '0:00–10:00': 12, '10:00–20:00': 10 },
      fights_total: 16, fights_where: { team_lost_fewer_heroes: ['4:43', '6:08'], team_lost_fewer_heroes_and_took_a_building_within_120s: ['6:08'], opponents_lost_fewer_heroes: ['2:35', '10:39', '21:59'], opponents_lost_fewer_heroes_and_took_a_building_within_120s: ['10:39', '21:59'], hero_was_there: ['2:35'], hero_was_not_there: [], hero_presence_not_known: [] },
      buildings_team_took_where: { hero_damaged_it: ['18:45', '19:46', '25:05'], hero_did_not_damage_it: ['18:07'], not_known: [] }, team_heroes_damage_to_buildings: { beastmaster: 540 },
    } };
    const cites = (ref: string) => ({ ...review, lang: 'zh', findings: [{ ...review.findings[0], evidence: [{ refs: [ref], fact: '赢了团没有换成塔。' }] }] });
    const chip = (text: string) => screen.getByText((_, el) => /^ag-chip/.test(el?.className ?? '') && el!.textContent === text);
    ui.lang = 'zh';
    mockFetch({ 'ref=overview': overview, '/evidence?': phase, '/review?': { status: 'ready', review: cites('phase:beastmaster:3'), verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 }, '/api/agent/9100904020': { trace: true, model_configured: true, heroes } });
    page('/r/9100904020?hero=beastmaster&lang=zh');
    fireEvent.click((await screen.findAllByRole('button', { name: '看原始记录' }))[0]);
    expect(await screen.findByText('20:00–30:00')).toBeTruthy();
    // A building is named by its lane and kind, and by whose it was: the one the team took was the other side's.
    expect(chip('20:02 · 己方 中路 1 塔')).toBeTruthy();
    expect(chip('25:05 · 对方 上路 2 塔')).toBeTruthy();
    expect(chip('21:59 · 3 : 1')).toBeTruthy();
    expect(chip('22:57 · 0 : 3不在场')).toBeTruthy();
    expect(chip('在己方半场 44%')).toBeTruthy();
    // A share that could not be measured is a dash, not zero.
    expect(chip('身边三名以上敌人 –')).toBeTruthy();
    expect(chip('天辉上路 32%')).toBeTruthy();
    expect(chip('队伍英雄合计 455')).toBeTruthy();
    expect(screen.queryByText(/radiant_top_lane|tower1|on own side/)).toBeNull();
    cleanup();

    mockFetch({ 'ref=overview': overview, '/evidence?': tempo, '/review?': { status: 'ready', review: cites('tempo:beastmaster'), verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 }, '/api/agent/9100904020': { trace: true, model_configured: true, heroes } });
    page('/r/9100904020?hero=beastmaster&lang=zh');
    fireEvent.click((await screen.findAllByRole('button', { name: '看原始记录' }))[0]);
    expect(await screen.findByText('兽王 · 42:31')).toBeTruthy();
    expect(screen.getByRole('row', { name: '10:00–20:00 3 0 7 10' })).toBeTruthy();
    expect(chip('己方 18:07')).toBeTruthy();
    expect(chip('对方 –')).toBeTruthy();
    expect(chip('之后两分钟内拆到建筑 1')).toBeTruthy();
    expect(chip('之后两分钟内拆到建筑 2')).toBeTruthy();
    expect(chip('1 / 16')).toBeTruthy();
    expect(chip('3 / 4')).toBeTruthy();
  });

  it('the build record: where the damage came from, each big item with what it is for, the answers held or not, the gap closers', async () => {
    const build = { status: 'ok', ref: 'build:beastmaster', kind: 'build', names: { beastmaster: '兽王', phantom_assassin: '幻影刺客', axe: '斧王' }, record: {
      ref: 'build:beastmaster', hero: 'beastmaster', my_role: 'core', deaths_total: 11, killed_by: { phantom_assassin: 7 },
      damage_in_my_deaths: { share_from_enemy_attacks: 0.44, share_from_enemy_abilities_and_items: 0.48, by_enemy: [{ enemy: 'phantom_assassin', kills_of_me: 7, share_from_their_attacks: 0.44, share_from_their_abilities_and_items: 0.16 }] },
      my_big_items_in_order: [{ ref: 'item:beastmaster:ultimate_scepter', item: 'ultimate_scepter', name: '阿哈利姆神杖', first_held: '16:48', cost: 4200, built_for: [] }, { ref: 'item:beastmaster:pipe', item: 'pipe', name: '洞察烟斗', first_held: '29:08', cost: 3725, built_for: ['answer_to_spell_damage', 'magic_resistance'] }],
      gold_in_big_items_by_purpose: {},
      items_that_answer_attack_damage: [{ item: 'ghost', name: '幽魂权杖', player_first_held: null }, { item: 'assault', name: '强袭胸甲', player_first_held: '38:58' }],
      items_that_answer_spell_damage: [],
      most_built_by_pros_on_this_hero: { pro_games: 1116, window: 'finished between 10:00 and 24:59', items: [{ item: 'blink', name: '闪烁匕首', share_of_pro_games_with_it_by_24_59: 0.71, player_first_held: null, built_for: ['initiation_or_gap_closer'] }] },
      gap_closers: { mine: null, enemies: [{ enemy: 'axe', item: 'blink', name: '闪烁匕首', first_held: '20:18' }] },
    } };
    ui.lang = 'zh';
    mockFetch({ 'ref=overview': overview, '/evidence?': build, '/review?': { status: 'ready', review: { ...review, lang: 'zh', findings: [{ ...review.findings[0], evidence: [{ refs: ['build:beastmaster'], fact: '洞察烟斗 29:08 才出。' }] }] }, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 }, '/api/agent/9100904020': { trace: true, model_configured: true, heroes } });
    page('/r/9100904020?hero=beastmaster&lang=zh');
    fireEvent.click((await screen.findAllByRole('button', { name: '看原始记录' }))[0]);
    expect(await screen.findByRole('row', { name: '29:08 洞察烟斗 3725 应对技能伤害 · 魔法抗性' })).toBeTruthy();
    // An item the data does not classify says so; it is not given a purpose.
    expect(screen.getByRole('row', { name: '16:48 阿哈利姆神杖 4200 未分类' })).toBeTruthy();
    expect(screen.getByText('阵亡前受到的伤害').parentElement!.textContent).toBe('阵亡前受到的伤害普攻 44%技能与物品 48%');
    expect(screen.getByText('应对普攻伤害的装备').parentElement!.textContent).toBe('应对普攻伤害的装备幽魂权杖 从未持有强袭胸甲 38:58');
    expect(screen.getByText('第一件位移装').parentElement!.textContent).toBe('第一件位移装斧王 · 闪烁匕首 20:18');
    expect(stepLabel({ tool: 'build_check', args: { hero: 'beastmaster' } }, 'zh')).toBe('核对出装和致死伤害');
  });

  it('the strengths record: levels of both sides, the matchup with its numbers, an enemy\'s kills before and after each item', async () => {
    const spikes = { status: 'ok', ref: 'spikes:beastmaster', kind: 'spikes', names: { beastmaster: '兽王', phantom_assassin: '幻影刺客', axe: '斧王' }, record: {
      ref: 'spikes:beastmaster', hero: 'beastmaster', kills_of_me: { phantom_assassin: 7 }, kills_of_me_before_their_item: {}, kills_of_me_from_their_item_on: {},
      me: { reached: { level_6: '7:28', level_12: '18:39' }, ultimate: { ability: 'beastmaster_primal_roar', name: '原始咆哮', cooldown_by_level: [90, 75, 60] }, big_items: [{ item: 'pipe', name: '洞察烟斗', first_held: '29:08' }] },
      enemies: [
        { enemy: 'phantom_assassin', kills_of_me_total: 7, reached: { level_6: '6:14', level_12: '17:18', level_18: '25:31' }, big_items: [{ item: 'bfury', name: '狂战斧', first_held: '15:47', kills_of_me_before: 2, kills_of_me_from_then_on: 5 }], my_hero_against_them_in_public_games: { bracket: 'la', games: 800, win_rate: 0.44, my_hero_usually: 0.48, matchup: 'unfavoured' } },
        { enemy: 'axe', kills_of_me_total: 0, reached: { level_6: '8:01' }, big_items: [{ item: 'blink', name: '闪烁匕首', first_held: '20:18', gap_closer: true }] },
      ],
      level_at: [],
    } };
    ui.lang = 'zh';
    mockFetch({ 'ref=overview': overview, '/evidence?': spikes, '/review?': { status: 'ready', review: { ...review, lang: 'zh', findings: [{ ...review.findings[0], evidence: [{ refs: ['spikes:beastmaster'], fact: '幻影刺客 15:47 做出狂战斧。' }] }] }, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 }, '/api/agent/9100904020': { trace: true, model_configured: true, heroes } });
    page('/r/9100904020?hero=beastmaster&lang=zh');
    fireEvent.click((await screen.findAllByRole('button', { name: '看原始记录' }))[0]);
    // A level not reached, and a matchup the data does not have, are dashes.
    expect(await screen.findByRole('row', { name: '兽王 7:28 18:39 –' })).toBeTruthy();
    expect(screen.getByRole('row', { name: '幻影刺客 6:14 17:18 25:31 7 44% (48%) · 吃亏' })).toBeTruthy();
    expect(screen.getByRole('row', { name: '斧王 8:01 – – 0 –' })).toBeTruthy();
    expect(screen.getByText('大招各级冷却').parentElement!.textContent).toBe('大招各级冷却原始咆哮 90 / 75 / 60');
    // Only for an enemy who killed the player: their items with the kills before → from then on.
    expect(screen.getByText('狂战斧').textContent).toBe('狂战斧 15:47 · 2 → 5');
    expect(screen.queryByText(/闪烁匕首 20:18/)).toBeNull();
    expect(stepLabel({ tool: 'power_spikes', args: { hero: 'beastmaster' } }, 'zh')).toBe('看双方的强势期');
  });

  it('line-up timing is a table of each hero\'s win rate by game length, with this game\'s column marked', async () => {
    const hero = (h: string, a: number | null, b: number | null, c: number | null, lean: string | null) => ({ hero: h, games: 1000, win_rate: 0.5, win_rate_under_35_min: a, win_rate_from_35_to_45_min: b, win_rate_over_45_min: c, change_from_short_to_long_games_in_points: -8.8, wins_more_in: lean });
    const timing = { status: 'ok', ref: 'lineup_timing', kind: 'lineup_timing', names: { sven: '斯温', beastmaster: '兽王', phantom_assassin: '幻影刺客' }, record: {
      ref: 'lineup_timing', source: 'STRATZ (https://stratz.com)', patch: '7.41', weeks: { from: '2026-10-15', to: '2026-11-11', count: 4 }, bracket: 'la', bracket_name: '传奇–万古', bracket_from: 'the_players_medal',
      this_game: { length: '42:31', group: 'from_35_to_45_min' },
      my_team: { heroes: [hero('sven', 0.564, 0.524, 0.475, 'shorter_games'), hero('beastmaster', null, 0.43, 0.449, null)], mean_win_rate_of_its_heroes: { under_35_min: null, from_35_to_45_min: 0.477, over_45_min: 0.462 } },
      enemy: { heroes: [hero('phantom_assassin', 0.444, 0.536, 0.533, 'longer_games')], mean_win_rate_of_its_heroes: { under_35_min: 0.444, from_35_to_45_min: 0.536, over_45_min: 0.533 } },
      mean_change_from_short_to_long_games_in_points: { my_team: null, enemy: 8.9 }, longer_games_favour: null,
    } };
    ui.lang = 'zh';
    mockFetch({ 'ref=overview': overview, '/evidence?': timing, '/review?': { status: 'ready', review: { ...review, lang: 'zh', findings: [{ ...review.findings[0], evidence: [{ refs: ['lineup_timing'], fact: '你方的英雄在短局里赢得更多。' }] }] }, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 }, '/api/agent/9100904020': { trace: true, model_configured: true, heroes } });
    page('/r/9100904020?hero=beastmaster&lang=zh');
    fireEvent.click((await screen.findAllByRole('button', { name: '看原始记录' }))[0]);
    expect(await screen.findByText('STRATZ (https://stratz.com) · 7.41 · 2026-10-15 – 2026-11-11')).toBeTruthy();
    expect(screen.getByRole('row', { name: '斯温 56.4% 52.4% 47.5% 短局' })).toBeTruthy();
    // A win rate the data does not have is a dash, and so is a lean it cannot call.
    expect(screen.getByRole('row', { name: '兽王 – 43.0% 44.9% –' })).toBeTruthy();
    expect(screen.getByRole('row', { name: '幻影刺客 44.4% 53.6% 53.3% 长局' })).toBeTruthy();
    expect(screen.getByRole('row', { name: '我方 · 五人平均 – 47.7% 46.2%' })).toBeTruthy();
    expect(screen.getByRole('row', { name: '敌方 · 五人平均 44.4% 53.6% 53.3%' })).toBeTruthy();
    // The group this game fell in is the marked column.
    expect(screen.getByText('52.4%').className).toBe('is-now');
    expect(screen.getByText('56.4%').className).toBe('');
    expect(screen.getByText('每个英雄单独统计，不代表整套阵容的胜率。')).toBeTruthy();
    expect(stepLabel({ tool: 'lineup_timing', args: {} }, 'zh')).toBe('查双方英雄在长局、短局的胜率');
  });

  it('names a tempo step and a building in the reader\'s language', () => {
    expect(stepLabel({ tool: 'tempo_report', args: { hero: 'beastmaster' } }, 'zh')).toBe('看各阶段的推进和节奏');
    expect(stepLabel({ tool: 'tempo_report', args: { hero: 'beastmaster' } }, 'en')).toBe('Reading who took the map, and when');
    expect([buildingLabel('badguys_tower1_mid', 'en'), buildingLabel('goodguys_melee_rax_top', 'en'), buildingLabel('badguys_tower4', 'en'), buildingLabel('goodguys_fort', 'en')]).toEqual(['mid tier-1 tower', 'top melee barracks', 'tier-4 tower', 'Ancient']);
    expect([buildingLabel('badguys_range_rax_bot', 'zh'), buildingLabel('badguys_tower4', 'zh'), buildingLabel('goodguys_fort', 'zh'), buildingLabel('npc_something_else', 'zh')]).toEqual(['下路远程兵营', '4 塔', '遗迹', 'npc something else']);
  });

  it('the reader can say their plan before the review: it goes in the link, the start, every poll and the chat', async () => {
    let started: any = null;
    const calls = mockFetch({
      '/chat': () => sse([{ text: '答。' }, { done: true }]),
      'ref=overview': overview,
      '/review?': (url: string) => (started ? { status: 'ready', review: { ...review, lang: 'zh', plan: 'push', game_plan: { against_your_plan: '你说要线优转推进，19:00 到 29:00 领先时只拆了 2 座建筑。', course: 'c', evidence: [{ refs: ['window:2'], clock: '19:00', fact: 'f' }] } }, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 } : { status: 'none' }),
      '/review': (_u: string, init?: RequestInit) => { if (init?.method !== 'POST') return null; started = JSON.parse(String(init.body)); return { status: 'running', steps: [] }; },
      '/api/agent/9100904020': { trace: true, model_configured: true, heroes },
    });
    ui.lang = 'zh';
    const Where = () => { const l = useLocation(); return <p data-testid="where">{l.search}</p>; };
    render(<MemoryRouter initialEntries={['/r/9100904020?hero=beastmaster&lang=zh']}><Where /><Routes><Route path="/r/:matchId" element={<AgentMatchPage />} /></Routes></MemoryRouter>);
    const group = await screen.findByRole('radiogroup', { name: '这局你想怎么打？（可选）' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['不说', '线优转推进', '抓人带节奏', '带线牵制', '发育拖后期']);
    // Saying nothing is the default.
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false', 'false']);
    fireEvent.click(within(group).getByRole('radio', { name: '线优转推进' }));
    expect(screen.getByTestId('where').textContent).toContain('plan=push');
    expect(within(group).getByRole('radio', { name: '线优转推进' }).getAttribute('aria-checked')).toBe('true');
    // The review for that plan is asked about, not the plan-free one.
    await waitFor(() => expect(calls.some((c) => c.url.includes('/review?') && c.url.includes('plan=push'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: '开始复盘' }));
    await waitFor(() => expect(started).toEqual({ hero: 'beastmaster', lang: 'zh', plan: 'push' }));
    // The review reads the game against it, under the plan's name.
    // The page asks again 2.5 s after the start.
    const yours = (await screen.findByText((_, el) => el?.tagName === 'DT' && (el.textContent ?? '').startsWith('对照你的思路'), {}, { timeout: 5000 })).closest('div')!;
    expect(yours.textContent).toBe('对照你的思路线优转推进你说要线优转推进，19:00 到 29:00 领先时只拆了 2 座建筑。');
    // A question goes with the plan, so the coach reads the review made for it.
    const box = screen.getByRole('textbox', { name: '问教练' });
    fireEvent.change(box, { target: { value: '怎么推？' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/chat'))).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith('/chat'))!.init!.body))).toMatchObject({ question: '怎么推？', plan: 'push' });
  });

  it('from a review made without a plan, the reader can have it made again for one: the start opens with that plan picked', async () => {
    mockFetch({
      '/chat': () => sse([{ text: '答。' }, { done: true }]),
      'ref=overview': overview,
      '/review?': (url: string) => (url.includes('plan=') ? { status: 'none' } : { status: 'ready', review: { ...review, lang: 'zh' }, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 }),
      '/api/agent/9100904020': { trace: true, model_configured: true, heroes },
    });
    ui.lang = 'zh';
    const Where = () => { const l = useLocation(); return <p data-testid="where">{l.search}</p>; };
    render(<MemoryRouter initialEntries={['/r/9100904020?hero=beastmaster&lang=zh']}><Where /><Routes><Route path="/r/:matchId" element={<AgentMatchPage />} /></Routes></MemoryRouter>);
    const section = (await screen.findByRole('heading', { level: 3, name: '运营思路' })).closest('details')!;
    // Nothing is offered until the reader asks about a plan.
    expect(within(section as HTMLElement).queryByRole('button', { name: '重写' })).toBeNull();
    fireEvent.click(within(section as HTMLElement).getByRole('button', { name: '抓人带节奏' }));
    const note = await within(section as HTMLElement).findByText(/也可以按「抓人带节奏」重写整份复盘/);
    fireEvent.click(within(note as HTMLElement).getByRole('button', { name: '重写' }));
    expect(screen.getByTestId('where').textContent).toContain('plan=gank');
    const group = await screen.findByRole('radiogroup', { name: '这局你想怎么打？（可选）' });
    expect(within(group).getByRole('radio', { name: '抓人带节奏' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('button', { name: '开始复盘' })).toBeTruthy();
  });

  it('a word on a finding names the review on screen: its prompt version and its writer\'s own id, never "the default"', async () => {
    const offer = { trace: true, model_configured: true, heroes, models: ['deepseek-flash', 'kimi-k3.1-pro'], default_model: 'deepseek-flash' };
    const ready = (extra: object) => ({ status: 'ready', review: { ...review, lang: 'zh' }, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 1, ...extra });
    const calls = mockFetch({ '/feedback': { status: 'ok' }, 'ref=overview': overview, '/review?': ready({ prompt_version: 37 }), '/api/agent/9100904020': offer });
    ui.lang = 'zh';
    page('/r/9100904020?hero=beastmaster&lang=zh');
    const group = await screen.findByRole('group', { name: '这条说得对吗？' });
    fireEvent.click(within(group).getByRole('button', { name: '说得对' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/feedback'))).toBe(true));
    const sent = JSON.parse(String(calls.find((c) => c.url.includes('/feedback'))!.init!.body));
    // The default here is asked for by no name (`model` is null on this page), and still named by its id in the word.
    expect(sent).toMatchObject({ hero: 'beastmaster', lang: 'zh', version: 37, model: 'deepseek-flash', finding: 0, title: review.findings[0].title, rating: 'right' });
    cleanup();
    // The same review once another model is the default here: another memory slot would be a second record, and
    // the default's alias would be Kimi. The id says DeepSeek either way — and what was said is still shown.
    mockFetch({ 'ref=overview': overview, '/review?': ready({ prompt_version: 37 }), '/api/agent/9100904020': { ...offer, default_model: 'kimi-k3.1-pro' } });
    page('/r/9100904020?hero=beastmaster&lang=zh&model=deepseek-flash');
    expect(within(await screen.findByRole('group', { name: '这条说得对吗？' })).getByRole('button', { name: '说得对' }).getAttribute('aria-pressed')).toBe('true');
    cleanup();
    // Written again under a newer prompt: unanswered, even with the same title.
    mockFetch({ 'ref=overview': overview, '/review?': ready({ prompt_version: 38 }), '/api/agent/9100904020': offer });
    page('/r/9100904020?hero=beastmaster&lang=zh');
    expect(within(await screen.findByRole('group', { name: '这条说得对吗？' })).getByRole('button', { name: '说得对' }).getAttribute('aria-pressed')).toBe('false');
    cleanup();
    // A server that does not say which version the review is: the question is not asked, since the word could not be placed.
    mockFetch({ 'ref=overview': overview, '/review?': ready({}), '/api/agent/9100904020': offer });
    page('/r/9100904020?hero=beastmaster&lang=zh');
    expect(await screen.findByRole('heading', { level: 1 })).toBeTruthy();
    expect(screen.queryByRole('group', { name: '这条说得对吗？' })).toBeNull();
  });

  it('the reader picks who writes the review: the model goes in the link, the start, every poll, the chat and the shared link', async () => {
    let started: any = null;
    const offer = { trace: true, model_configured: true, heroes, models: ['deepseek-flash', 'kimi-k3.1-pro', 'glm-5.3'], default_model: 'deepseek-flash' };
    const calls = mockFetch({
      '/chat': () => sse([{ text: '答。' }, { done: true }]),
      'ref=overview': overview,
      // The default's review exists; the other model's does not until it is started.
      '/review?': (url: string) => (!url.includes('model=') || started ? { status: 'ready', review: { ...review, lang: 'zh', verdict: url.includes('model=') ? 'Kimi 的结论。' : 'DeepSeek 的结论。' }, verification: { repaired: false, dropped: 0 }, model: url.includes('model=') ? 'k3.1-pro' : 'deepseek-flash', tool_calls: 9 } : { status: 'none' }),
      '/review': (_u: string, init?: RequestInit) => { if (init?.method !== 'POST') return null; started = JSON.parse(String(init.body)); return { status: 'running', steps: [] }; },
      '/api/agent/9100904020': offer,
    });
    ui.lang = 'zh';
    const Where = () => { const l = useLocation(); return <p data-testid="where">{l.search}</p>; };
    render(<MemoryRouter initialEntries={['/r/9100904020?hero=beastmaster&lang=zh']}><Where /><Routes><Route path="/r/:matchId" element={<AgentMatchPage />} /></Routes></MemoryRouter>);
    // On the default's finished review: who wrote it, and the others to compare with.
    expect(await screen.findByText('DeepSeek 的结论。')).toBeTruthy();
    const bar = screen.getByRole('radiogroup', { name: '撰写模型' });
    expect(within(bar).getAllByRole('radio').map((r) => [r.textContent, r.getAttribute('aria-checked')])).toEqual([['DeepSeek 4.1 Flash · 约 2–3 分钟', 'true'], ['Kimi K3.1 Pro · 约 13 分钟', 'false'], ['GLM-5.3 · 约 24 分钟', 'false']]);
    // It stands after the review, under the line that says the review was checked: nothing sits between the reader and the headline.
    const headline = screen.getByRole('heading', { level: 1 });
    expect(headline.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector('.ag-checked')!.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector('.ag-head')!.nextElementSibling!.className).toBe('ag-layout');
    fireEvent.click(within(bar).getByRole('radio', { name: 'Kimi K3.1 Pro · 约 13 分钟' }));
    expect(screen.getByTestId('where').textContent).toContain('model=kimi-k3.1-pro');
    // That model has no review of this game yet: the start is offered with it picked, and nothing has been started.
    const group = await screen.findByRole('radiogroup', { name: '由哪个模型来写？' });
    // Each button says how long that model takes, before the reader picks.
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['DeepSeek 4.1 Flash · 约 2–3 分钟', 'Kimi K3.1 Pro · 约 13 分钟', 'GLM-5.3 · 约 24 分钟']);
    expect(within(group).getByRole('radio', { name: 'Kimi K3.1 Pro · 约 13 分钟' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByText('DeepSeek 的结论。')).toBeNull();
    // The wait it is told is that model's, as timed — not the default's two to three minutes.
    expect(screen.getByText(/用 Kimi K3\.1 Pro 写，预计约 13 分钟（按实测）；DeepSeek 4\.1 Flash 约 2–3 分钟。/)).toBeTruthy();
    expect(screen.queryByText(/然后写出该改什么。大约两到三分钟。/)).toBeNull();
    expect(calls.some((c) => c.init?.method === 'POST')).toBe(false);
    await waitFor(() => expect(calls.some((c) => c.url.includes('/review?') && c.url.includes('model=kimi-k3.1-pro'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: '开始复盘' }));
    await waitFor(() => expect(started).toEqual({ hero: 'beastmaster', lang: 'zh', model: 'kimi-k3.1-pro' }));
    expect(await screen.findByText('Kimi 的结论。', {}, { timeout: 5000 })).toBeTruthy();
    // A question goes to the model that wrote the review on screen.
    const box = screen.getByRole('textbox', { name: '问教练' });
    fireEvent.change(box, { target: { value: '怎么打？' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/chat'))).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith('/chat'))!.init!.body))).toMatchObject({ question: '怎么打？', model: 'kimi-k3.1-pro' });
    // Back to the default: the model leaves the link and the requests, and the default's review is shown again.
    fireEvent.click(within(screen.getByRole('radiogroup', { name: '撰写模型' })).getByRole('radio', { name: 'DeepSeek 4.1 Flash · 约 2–3 分钟' }));
    expect(screen.getByTestId('where').textContent).not.toContain('model=');
    expect(await screen.findByText('DeepSeek 的结论。')).toBeTruthy();
  });

  it('with one model, or none listed, there is nothing to pick; a model the server does not offer is not asked for', async () => {
    const calls = mockFetch({ 'ref=overview': overview, '/review?': { status: 'none' }, '/review': (_u: string, init?: RequestInit) => (init?.method === 'POST' ? { status: 'running', steps: [] } : null), '/api/agent/9100904020': { trace: true, model_configured: true, heroes, models: ['deepseek-flash'], default_model: 'deepseek-flash' } });
    // The link names a model this server does not offer (and one that is no model): the default is asked for.
    page('/r/9100904020?hero=beastmaster&lang=en&model=glm-5.3');
    expect(await screen.findByRole('heading', { name: 'Review this game' })).toBeTruthy();
    expect(screen.queryByRole('radiogroup', { name: 'Which model writes it?' })).toBeNull();
    expect(screen.getByText(/and writes what to change\. About two to three minutes\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review my game' }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'POST')).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith('/review') && c.init?.method === 'POST')!.init!.body))).toEqual({ hero: 'beastmaster', lang: 'en' });
    expect(calls.some((c) => c.url.includes('model='))).toBe(false);
  });

  it('the wait told is the writing model\'s, also when a slow model is the server\'s default (review of #327)', async () => {
    // A server set up with Kimi alone: nothing to pick, no model in the requests, and Kimi's wait — not two to three minutes.
    const calls = mockFetch({ 'ref=overview': overview, '/review?': { status: 'none' }, '/api/agent/9100904020': { trace: true, model_configured: true, heroes, models: ['kimi-k3.1-pro'], default_model: 'kimi-k3.1-pro' } });
    page('/r/9100904020?hero=beastmaster&lang=en');
    expect(await screen.findByRole('heading', { name: 'Review this game' })).toBeTruthy();
    expect(screen.getByText(/and writes what to change\. With Kimi K3\.1 Pro, expect about 13 minutes \(as timed on a real game\)\.$/)).toBeTruthy();
    expect(screen.queryByText(/two to three/)).toBeNull();
    expect(calls.some((c) => c.url.includes('model='))).toBe(false);
  });

  it('while a review is being written the page says who writes it and how long to expect; a model that was not timed gets no time', async () => {
    const offer = { trace: true, model_configured: true, heroes, models: ['deepseek-flash', 'glm-5.3-flash', 'glm-5.4'], default_model: 'deepseek-flash' };
    mockFetch({ 'ref=overview': overview, '/review?': { status: 'running', steps: [{ tool: 'match_overview', args: {} }] }, '/api/agent/9100904020': offer });
    const first = page('/r/9100904020?hero=beastmaster&lang=en&model=glm-5.3-flash');
    expect(await screen.findByRole('heading', { name: 'Working on your review' })).toBeTruthy();
    expect(screen.getByText('GLM-5.3 Flash is writing it: expect about 11–13 minutes.')).toBeTruthy();
    first.unmount();
    // The default's wait is said too, where the server names its models.
    const second = page('/r/9100904020?hero=beastmaster&lang=en');
    expect(await screen.findByText('DeepSeek 4.1 Flash is writing it: expect about 2–3 minutes.')).toBeTruthy();
    second.unmount();
    // GLM-5.4 was never timed: its button and its wait say nothing about how long, rather than a guess.
    const third = page('/r/9100904020?hero=beastmaster&lang=en&model=glm-5.4');
    expect(await screen.findByRole('heading', { name: 'Working on your review' })).toBeTruthy();
    expect(screen.queryByText(/is writing it/)).toBeNull();
    third.unmount();
    mockFetch({ 'ref=overview': overview, '/review?': { status: 'none' }, '/api/agent/9100904020': offer });
    page('/r/9100904020?hero=beastmaster&lang=en&model=glm-5.4');
    const group = await screen.findByRole('radiogroup', { name: 'Which model writes it?' });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['DeepSeek 4.1 Flash · about 2–3 minutes', 'GLM-5.3 Flash · about 11–13 minutes', 'GLM-5.4']);
    expect(screen.queryByText(/expect about|two to three/)).toBeNull();
  });

  it('a personal link names the model that wrote the review, also when that model is the server\'s default (review of #327)', async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
    const ready = { status: 'ready', review, verification: { repaired: false, dropped: 0 }, model: 'k3.1-pro', tool_calls: 9 };
    // Kimi is this server's default: nothing in the page's requests names it…
    const calls = mockFetch({ 'ref=overview': overview, '/review?': ready, '/api/agent/9100904020': { trace: true, model_configured: true, heroes, models: ['kimi-k3.1-pro'], default_model: 'kimi-k3.1-pro' } });
    page('/r/9100904020?hero=beastmaster&lang=en');
    fireEvent.click(await screen.findByRole('button', { name: 'Copy my link' }));
    // …but the link does, so it opens Kimi's review on a server whose default has since become another model.
    await waitFor(() => expect(copied).toHaveLength(1));
    expect(copied[0]).toContain('hero=beastmaster&model=kimi-k3.1-pro&ref=share');
    expect(calls.some((c) => c.url.includes('model='))).toBe(false);
    cleanup();
    // So does a link to DeepSeek's review: without its name it would open whatever the default is.
    copied.length = 0;
    mockFetch({ 'ref=overview': overview, '/review?': { ...ready, model: 'deepseek-flash' }, '/api/agent/9100904020': { trace: true, model_configured: true, heroes, models: ['kimi-k3.1-pro', 'deepseek-flash'], default_model: 'kimi-k3.1-pro' } });
    page('/r/9100904020?hero=beastmaster&lang=en&model=deepseek-flash');
    fireEvent.click(await screen.findByRole('button', { name: 'Copy my link' }));
    await waitFor(() => expect(copied).toHaveLength(1));
    expect(copied[0]).toContain('hero=beastmaster&model=deepseek-flash&ref=share');
    cleanup();
    // A server that lists no models has one writer: its links name none, as before.
    copied.length = 0;
    mockFetch({ 'ref=overview': overview, '/review?': ready, '/api/agent/9100904020': { trace: true, model_configured: true, heroes } });
    page('/r/9100904020?hero=beastmaster&lang=en');
    fireEvent.click(await screen.findByRole('button', { name: 'Copy my link' }));
    await waitFor(() => expect(copied).toHaveLength(1));
    expect(copied[0]).not.toContain('model=');
  });

  it('going back to "don\'t say" takes the plan out of the link and the requests', async () => {
    const calls = mockFetch({ 'ref=overview': overview, '/review?': { status: 'none' }, '/review': (_u: string, init?: RequestInit) => (init?.method === 'POST' ? { status: 'running', steps: [] } : null), '/api/agent/9100904020': { trace: true, model_configured: true, heroes } });
    page('/r/9100904020?hero=beastmaster&lang=en&plan=late');
    const group = await screen.findByRole('radiogroup', { name: 'What were you going for this game? (optional)' });
    expect(within(group).getByRole('radio', { name: 'Farm for late' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(group).getByRole('radio', { name: 'Don\'t say' }));
    // Another plan is another review: the page asks about it again before the start is offered.
    fireEvent.click(await screen.findByRole('button', { name: 'Review my game' }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'POST')).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.init?.method === 'POST')!.init!.body))).toEqual({ hero: 'beastmaster', lang: 'en' });
    // A plan in a link that is none of the four is no plan.
    cleanup();
    mockFetch({ 'ref=overview': overview, '/review?': { status: 'none' }, '/api/agent/9100904020': { trace: true, model_configured: true, heroes } });
    page('/r/9100904020?hero=beastmaster&lang=en&plan=cheese');
    expect(within(await screen.findByRole('radiogroup')).getByRole('radio', { name: 'Don\'t say' }).getAttribute('aria-checked')).toBe('true');
  });

  it('a building the team took shows who on the other side was alive and near; a window shows who got richer', async () => {
    const building = { status: 'ok', ref: 'farm:beastmaster:b2', kind: 'farm', names: { axe: '斧王' }, record: { ref: 'farm:beastmaster:b2', clock: '18:45', building: 'goodguys_tower1_mid', enemy_heroes_alive: 3, enemy_heroes_near_your_team: [] } };
    const win = { status: 'ok', ref: 'farm:beastmaster:w2', kind: 'farm', names: { phantom_assassin: '幻影刺客', sven: '斯温' }, record: { ref: 'farm:beastmaster:w2', window: 'window:beastmaster:2', clock: '19:00–29:00', ahead: 'my_team', gained: { phantom_assassin: 7000, sven: 5000 }, gained_most: { my_team: 'sven', enemy: 'phantom_assassin' } } };
    ui.lang = 'zh';
    mockFetch({ 'ref=farm%3Abeastmaster%3Ab2': building, 'ref=farm%3Abeastmaster%3Aw2': win, 'ref=overview': overview, '/review?': { status: 'ready', review: { ...review, lang: 'zh', findings: [{ ...review.findings[0], evidence: [{ refs: ['farm:beastmaster:b2'], fact: 'a' }, { refs: ['farm:beastmaster:w2'], fact: 'b' }] }] }, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 }, '/api/agent/9100904020': { trace: true, model_configured: true, heroes } });
    page('/r/9100904020?hero=beastmaster&lang=zh');
    const opens = await screen.findAllByRole('button', { name: '看原始记录' });
    fireEvent.click(opens[0]); fireEvent.click(opens[1]);
    const chip = (text: string) => screen.getByText((_, el) => /^ag-chip/.test(el?.className ?? '') && el!.textContent === text);
    expect(await screen.findByText('· 中路 1 塔', { exact: false })).toBeTruthy();
    expect(chip('对方存活 3')).toBeTruthy();
    expect(chip('没有人')).toBeTruthy();
    expect(screen.getByRole('row', { name: '幻影刺客 7000' }).className).toBe('is-me');
    expect(screen.getByText('19:00–29:00')).toBeTruthy();
  });

  it('what the player\'s items served is a table by plan, with the plan they named first', async () => {
    // The record as the server serves it (a summary keeps maps and drops lists, measured_at among them).
    const { resolveRef } = await import('../../lib/agent/evidence.js');
    const { gunzipSync } = await import('node:zlib');
    const { readFileSync } = await import('node:fs');
    // A path from the working directory: under jsdom import.meta.url is not a file URL.
    const fixtureTrace = JSON.parse(gunzipSync(readFileSync(`${process.cwd()}/packages/review-engine/test/fixtures/trace-9100904020.json.gz`)).toString());
    const served: any = resolveRef(fixtureTrace, 'build_plan:beastmaster:push', { hero: 'beastmaster', lang: 'zh' });
    expect(served.record).not.toHaveProperty('measured_at');
    const bp = { status: 'ok', ...served };
    ui.lang = 'zh';
    mockFetch({ 'ref=overview': overview, '/evidence?': bp, '/review?': { status: 'ready', review: { ...review, lang: 'zh', findings: [{ ...review.findings[0], evidence: [{ refs: ['build_plan:beastmaster:push'], fact: '推进装 38:58 才出。' }] }] }, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 }, '/api/agent/9100904020': { trace: true, model_configured: true, heroes } });
    page('/r/9100904020?hero=beastmaster&lang=zh');
    fireEvent.click((await screen.findAllByRole('button', { name: '看原始记录' }))[0]);
    const chip = (text: string) => screen.getByText((_, el) => /^ag-chip/.test(el?.className ?? '') && el!.textContent === text);
    expect(await screen.findByText('你的思路')).toBeTruthy();
    expect(chip('第一件 强袭胸甲 38:58')).toBeTruthy();
    expect(chip('之前花在其他大件上 7925')).toBeTruthy();
    expect(chip('占大件金额 39%')).toBeTruthy();
    // The 15:00 and 25:00 columns are there although the served record has no list of marks.
    expect(screen.getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['', '截至 15:00', '截至 25:00', '全场', '第一件']);
    expect(screen.getByRole('row', { name: '线优转推进 0 0 5125 38:58' }).className).toBe('is-me');
    expect(screen.getByRole('row', { name: '抓人带节奏 0 0 0 –' })).toBeTruthy();
    expect(screen.queryByText(/gold in items|push/)).toBeNull();
  });

  it('a tool\'s totals are shown in the reader\'s language, a moment as its clock', async () => {
    const totals = { ref: 'audit:beastmaster:primal_roar', kind: 'audit', names: { beastmaster: '兽王', beastmaster_primal_roar: '原始咆哮', phantom_assassin: '幻影刺客' }, record: { ref: 'audit:beastmaster:primal_roar', ref_scope: 'summary', hero: 'beastmaster', ability: 'beastmaster_primal_roar', learned_at: { t: 450.1, clock: '7:30' }, casts_total: 10, by_target: { phantom_assassin: 4 }, deaths_with_it_ready_and_not_cast_total: 3 } };
    mockFetch({
      'ref=overview': overview,
      '/evidence?': totals,
      '/review?': { status: 'ready', review, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 },
      '/api/agent/9100904020': { trace: true, model_configured: true, heroes },
    });
    ui.lang = 'zh';
    page('/r/9100904020?hero=beastmaster&lang=zh');
    fireEvent.click((await screen.findAllByRole('button', { name: '看原始记录' }))[0]);
    const chip = (text: string) => screen.getByText((_, el) => el?.className === 'ag-chip' && el.textContent === text);
    expect(await screen.findByText('兽王 · 原始咆哮')).toBeTruthy();
    expect(chip('学会于 7:30')).toBeTruthy();
    expect(chip('施放次数 10')).toBeTruthy();
    expect(chip('目标 · 幻影刺客 4')).toBeTruthy();
    expect(chip('技能就绪未放就阵亡 3')).toBeTruthy();
    expect(screen.queryByText(/casts total|by target|learned at/)).toBeNull();
  });

  it('the deaths\' totals say what they have in common and where the damage came from', async () => {
    const totals = { ref: 'deaths:beastmaster', kind: 'deaths', names: { beastmaster: '兽王', phantom_assassin: '幻影刺客' }, record: { ref: 'deaths:beastmaster', ref_scope: 'summary', hero: 'beastmaster', deaths_total: 11, killed_by: { phantom_assassin: 7 }, deaths_where: { health_below_half_at_window_start: [], no_ally_within_2200_at_death: ['2:51'] }, damage_in_death_windows_total: 23757, damage_in_death_windows: { 'phantom_assassin: attacks': 10453 }, damage_share_in_death_windows: { 'phantom_assassin: attacks': 0.44 } } };
    mockFetch({
      'ref=overview': overview,
      '/evidence?': totals,
      '/review?': { status: 'ready', review, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 },
      '/api/agent/8000000021': { trace: true, model_configured: true, heroes },
    });
    ui.lang = 'zh';
    // Another match id: evidence is remembered per match.
    page('/r/8000000021?hero=beastmaster&lang=zh');
    fireEvent.click((await screen.findAllByRole('button', { name: '看原始记录' }))[0]);
    const chip = (text: string) => screen.getByText((_, el) => el?.className === 'ag-chip' && el.textContent === text);
    expect(await screen.findByText((_, el) => el?.className === 'ag-chip' && el.textContent === '阵亡时 2200 码内没有队友 1')).toBeTruthy();
    expect(chip('其中 · 幻影刺客 普通攻击 44%')).toBeTruthy();
    expect(chip('各次阵亡前承受的伤害 23757')).toBeTruthy();
    // A list no death is in is not a chip; the amounts behind the shares are not repeated.
    expect(screen.queryByText(/起步不到半血/)).toBeNull();
    expect(screen.queryByText(/10453/)).toBeNull();
  });

  it('a finding shows its rule for the next game: the situation, the action, how often this game', async () => {
    const ruled = { ...review, findings: [{ ...review.findings[0], rule: { when: 'Her Black King Bar is still unused', do: 'hold the roar until it ends', this_game: '6 of 7 windows' } }], next_game: ['Her Black King Bar is still unused: hold the roar until it ends'] };
    mockFetch({ 'ref=overview': overview, '/review?': { status: 'ready', review: ruled, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 }, '/api/agent/8000000022': { trace: true, model_configured: true, heroes } });
    ui.lang = 'en';
    page('/r/8000000022?hero=beastmaster&lang=en');
    const rule = await screen.findByLabelText('Rule for next game');
    expect(rule.textContent).toBe('WhenHer Black King Bar is still unusedDohold the roar until it endsThis game6 of 7 windows');
    expect(screen.getByText('Keep it for her.')).toBeTruthy();
  });

  it('the funnel: the page says it was opened, a review was asked for, refused, and seen', async () => {
    let posts = 0;
    mockFetch({
      '/review?': () => (posts < 2 ? { status: 'none' } : { status: 'ready', review, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 }),
      'ref=overview': overview,
      '/review': () => (++posts === 1 ? { __status: 429, code: 'rate_limited', retryAfterSec: 3600 } : { __status: 202, status: 'running', steps: [] }),
      '/api/agent/8000000031': { trace: true, model_configured: true, heroes },
    });
    page('/r/8000000031?hero=beastmaster&lang=en');
    fireEvent.click(await screen.findByRole('button', { name: 'Review my game' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Review my game' }));
    await waitFor(async () => expect((await events()).map((e) => e.event)).toContain('review_viewed'), { timeout: 6000 });
    const sent = await events();
    await waitFor(async () => expect((await events()).map((e) => e.event)).toContain('review_ready'));
    expect((await events()).map((e) => e.event)).toEqual(['match_opened', 'review_requested', 'review_refused', 'review_requested', 'review_viewed', 'review_ready']);
    expect(sent[0].props).toEqual({ matchId: '8000000031', lang: 'en' });
    expect(sent[1].props).toEqual({ matchId: '8000000031', lang: 'en', hero: 'beastmaster', step: 'review', plan: false });
    // Too long to wait out on the page: said once, not counted down.
    expect(sent[2].props).toEqual({ matchId: '8000000031', reason: 'rate', waits: false });
    expect(sent[4].props).toEqual({ ui: 'agent', hero: 'beastmaster', lang: 'en', matchId: '8000000031' });
    expect((await events())[5].props).toEqual({ matchId: '8000000031', hero: 'beastmaster', lang: 'en' });
    // Opening the same game again in this session is not a second visitor.
    cleanup();
    page('/r/8000000031?hero=beastmaster&lang=en');
    await screen.findByRole('heading', { level: 1 });
    expect((await events()).filter((e) => e.event === 'match_opened')).toHaveLength(1);
  }, 10000);

  describe('sharing the finished review', () => {
    const readyRoutes = (id: string) => ({
      'ref=overview': overview,
      '/review?': { status: 'ready', review, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 },
      [`/api/agent/${id}`]: { trace: true, model_configured: true, heroes },
    });
    const clipboard = (impl: (t: string) => Promise<void>) => {
      const writeText = vi.fn(impl);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      return writeText;
    };
    afterEach(() => { delete (navigator as any).clipboard; delete (navigator as any).share; });

    it('"send to my team" copies a link with no hero in it; "copy my link" keeps the hero and the plan', async () => {
      ui.lang = 'zh';
      const writeText = clipboard(async () => {});
      mockFetch(readyRoutes('8000000041'));
      page('/r/8000000041?hero=beastmaster&plan=push&lang=zh');
      fireEvent.click(await screen.findByRole('button', { name: '发给队友' }));
      await screen.findByRole('button', { name: '链接已复制，发到队伍群里吧' });
      const origin = window.location.origin;
      expect(writeText).toHaveBeenLastCalledWith(`我把咱们这局 #8000000041 复盘了，选你玩的英雄，看看你这局能改什么： ${origin}/r/8000000041?ref=team&lang=zh`);
      fireEvent.click(screen.getByRole('button', { name: '复制我的链接' }));
      await screen.findByRole('button', { name: '已复制' });
      expect(writeText).toHaveBeenLastCalledWith(`${origin}/r/8000000041?hero=beastmaster&plan=push&ref=share&lang=zh`);
      const shared = (await events()).filter((e) => e.event === 'report_shared').map((e) => e.props);
      expect(shared).toEqual([{ target: 'team', method: 'copy', matchId: '8000000041' }, { target: 'self', method: 'copy', matchId: '8000000041' }]);
    });

    it('a browser that refuses the clipboard is shown the link to copy by hand, and nothing is counted as shared', async () => {
      clipboard(async () => { throw new Error('denied'); });
      mockFetch(readyRoutes('8000000042'));
      page('/r/8000000042?hero=beastmaster&lang=en');
      fireEvent.click(await screen.findByRole('button', { name: 'Copy my link' }));
      const box = await screen.findByLabelText('Copy this link:');
      // English is said in the link too: the review is the English one, whatever language the recipient last chose.
      expect((box as HTMLInputElement).value).toBe(`${window.location.origin}/r/8000000042?hero=beastmaster&ref=share&lang=en`);
      expect((await events()).filter((e) => e.event === 'report_shared')).toEqual([]);
    });

    it('on a phone the share sheet opens; closing it neither copies nor counts', async () => {
      const writeText = clipboard(async () => {});
      const matchMedia = window.matchMedia;
      window.matchMedia = ((q: string) => ({ matches: q === '(pointer: coarse)', media: q, addEventListener() {}, removeEventListener() {} })) as any;
      let answer: () => Promise<void> = async () => {};
      const share = vi.fn(() => answer());
      (navigator as any).share = share;
      try {
        mockFetch(readyRoutes('8000000043'));
        page('/r/8000000043?hero=beastmaster&lang=en');
        fireEvent.click(await screen.findByRole('button', { name: 'Send to my team' }));
        await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
        expect(share).toHaveBeenCalledWith({ text: 'I had our game #8000000043 reviewed — pick the hero you played and see what you could change:', url: `${window.location.origin}/r/8000000043?ref=team` });
        await waitFor(async () => expect((await events()).filter((e) => e.event === 'report_shared').map((e) => e.props)).toEqual([{ target: 'team', method: 'native', matchId: '8000000043' }]));
        answer = async () => { throw Object.assign(new Error('closed'), { name: 'AbortError' }); };
        fireEvent.click(screen.getByRole('button', { name: 'Send to my team' }));
        await waitFor(() => expect(share).toHaveBeenCalledTimes(2));
        await new Promise((r) => setTimeout(r, 50));
        expect(writeText).not.toHaveBeenCalled();
        expect((await events()).filter((e) => e.event === 'report_shared')).toHaveLength(1);
      } finally { window.matchMedia = matchMedia; }
    });

    it('a teammate who comes in by the team link is told so, picks their hero, and the visit is counted as arrived by it', async () => {
      mockFetch(readyRoutes('8000000044'));
      page('/r/8000000044?ref=team');
      expect(await screen.findByText('A teammate sent you this game.')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /Beastmaster/ }));
      await screen.findByRole('button', { name: 'Send to my team' });
      await waitFor(async () => expect((await events()).map((e) => e.event)).toContain('review_viewed'));
      const sent = await events();
      expect(sent.find((e) => e.event === 'match_opened').props).toEqual({ matchId: '8000000044', lang: 'en', ref: 'team' });
      expect(sent.find((e) => e.event === 'review_viewed').props).toEqual({ ui: 'agent', hero: 'beastmaster', lang: 'en', ref: 'team', matchId: '8000000044' });
    });
  });

  it('a visit that came by a community link counts the match page and the review it got for that source', async () => {
    window.sessionStorage.setItem('dota2ai.src', 'xhh');
    let posts = 0;
    mockFetch({
      '/review?': () => (posts < 1 ? { status: 'none' } : { status: 'ready', review, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 }),
      'ref=overview': overview,
      '/review': () => { posts += 1; return { __status: 202, status: 'running', steps: [] }; },
      '/api/agent/8000000051': { trace: true, model_configured: true, heroes },
    });
    page('/r/8000000051?hero=beastmaster&lang=en');
    fireEvent.click(await screen.findByRole('button', { name: 'Review my game' }));
    await waitFor(async () => expect((await events()).map((e) => e.event)).toContain('review_ready'), { timeout: 6000 });
    const sent = await events();
    expect(sent.find((e) => e.event === 'match_opened').props).toEqual({ matchId: '8000000051', lang: 'en', src: 'xhh' });
    expect(sent.find((e) => e.event === 'review_ready').props).toEqual({ matchId: '8000000051', hero: 'beastmaster', lang: 'en', src: 'xhh' });
  }, 10000);

  it('the page counts as opened before anything has loaded, so a reader who leaves while it loads is counted', async () => {
    mockFetch({ '/api/agent/8000000033': () => new Promise(() => {}), '/api/coach/8000000033': () => new Promise(() => {}) });
    page('/r/8000000033?lang=en');
    await waitFor(async () => expect((await events()).map((e) => e.event)).toEqual(['match_opened']));
    expect((await events())[0].props).toEqual({ matchId: '8000000033', lang: 'en' });
  });

  it('a review asked for after another one on the same game was seen is still counted as got', async () => {
    let started: any = null;
    mockFetch({
      'ref=overview': overview,
      '/review?': (url: string) => (!url.includes('plan=') || started ? { status: 'ready', review, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 } : { status: 'none' }),
      '/review': (_u: string, init?: RequestInit) => { started = JSON.parse(String(init?.body)); return { __status: 202, status: 'running', steps: [] }; },
      '/api/agent/8000000034': { trace: true, model_configured: true, heroes },
    });
    render(<MemoryRouter initialEntries={['/r/8000000034?hero=beastmaster&lang=en']}><Routes><Route path="/r/:matchId" element={<AgentMatchPage />} /></Routes></MemoryRouter>);
    // The review already there is seen first.
    await waitFor(async () => expect((await events()).map((e) => e.event)).toContain('review_viewed'));
    cleanup();
    render(<MemoryRouter initialEntries={['/r/8000000034?hero=beastmaster&lang=en&plan=push']}><Routes><Route path="/r/:matchId" element={<AgentMatchPage />} /></Routes></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Review my game' }));
    await waitFor(() => expect(started).toEqual({ hero: 'beastmaster', lang: 'en', plan: 'push' }));
    await waitFor(async () => expect((await events()).map((e) => e.event)).toContain('review_ready'), { timeout: 5000 });
    expect((await events()).filter((e) => e.event === 'review_viewed')).toHaveLength(1);
  }, 10000);

  it('a refusal the page counts down is counted as one it waits out', async () => {
    mockFetch({ '/review?': { status: 'none' }, '/review': { __status: 429, code: 'rate_limited', retryAfterSec: 60 }, '/api/agent/8000000035': { trace: true, model_configured: true, heroes } });
    page('/r/8000000035?hero=beastmaster&lang=en');
    fireEvent.click(await screen.findByRole('button', { name: 'Review my game' }));
    await screen.findByRole('alert');
    await waitFor(async () => expect((await events()).find((e) => e.event === 'review_refused')?.props).toEqual({ matchId: '8000000035', reason: 'rate', waits: true }));
  });

  it('a question to the coach is counted, and what was asked never leaves in the event', async () => {
    const calls = mockFetch({
      '/chat': () => sse([{ text: '答。' }, { done: true }]),
      'ref=overview': overview,
      '/review?': { status: 'ready', review: { ...review, lang: 'zh' }, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 },
      '/api/agent/8000000032': { trace: true, model_configured: true, heroes },
    });
    ui.lang = 'zh';
    page('/r/8000000032?hero=beastmaster&lang=zh');
    const box = await screen.findByRole('textbox', { name: '问教练' });
    fireEvent.change(box, { target: { value: '我第二次为什么死？' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/chat'))).toBe(true));
    const sent = await events();
    expect(sent.find((e) => e.event === 'chat_asked')?.props).toEqual({ matchId: '8000000032', lang: 'zh', hero: 'beastmaster' });
    // A review that was already there when the page opened is viewed, not one this reader asked for.
    expect(sent.find((e) => e.event === 'review_viewed')?.props).toMatchObject({ ui: 'agent' });
    expect(sent.some((e) => e.event === 'review_ready')).toBe(false);
    expect(JSON.stringify(sent)).not.toContain('为什么');
  });

  it('a refused start explains itself', async () => {
    mockFetch({ '/review?': { status: 'none' }, '/review': { __status: 429, code: 'rate_limited', retryAfterSec: 60 }, '/api/agent/9100904020': { trace: true, model_configured: true, heroes } });
    page('/r/9100904020?hero=beastmaster&lang=en');
    fireEvent.click(await screen.findByRole('button', { name: 'Review my game' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Too many reviews');
  });

  it('a refused start says how long, keeps the button off until then, and starts by itself when the wait is over', async () => {
    let posts = 0;
    const calls = mockFetch({
      '/review?': { status: 'none' },
      '/review': () => (++posts === 1 ? { __status: 429, code: 'rate_limited', retryAfterSec: 2 } : { __status: 202, status: 'running', steps: [] }),
      '/api/agent/9100904020': { trace: true, model_configured: true, heroes },
    });
    ui.lang = 'zh';
    page('/r/9100904020?hero=beastmaster&lang=zh');
    const button = await screen.findByRole('button', { name: '开始复盘' });
    fireEvent.click(button);
    expect((await screen.findByRole('alert')).textContent).toMatch(/^从这里发起的复盘太多了，0:0[12] 后自动开始。$/);
    const again = screen.getByRole('button', { name: '开始复盘' }) as HTMLButtonElement;
    expect(again.disabled).toBe(true);
    // Clicking while it counts down sends nothing.
    fireEvent.click(again);
    expect(calls.filter((c) => c.init?.method === 'POST')).toHaveLength(1);
    await waitFor(() => expect(posts).toBe(2), { timeout: 4000 });
    await screen.findByText('正在准备你的复盘');
  }, 8000);

  it('a wait belongs to the review that was refused: picking another plan meanwhile frees the button, and only that review starts', async () => {
    const bodies: any[] = [];
    mockFetch({
      '/review?': { status: 'none' },
      '/review': (_u: string, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return bodies.length === 1 ? { __status: 429, code: 'rate_limited', retryAfterSec: 2 } : { __status: 202, status: 'running', steps: [] }; },
      '/api/agent/9100904020': { trace: true, model_configured: true, heroes },
    });
    page('/r/9100904020?hero=beastmaster&lang=en');
    fireEvent.click(await screen.findByRole('button', { name: 'Review my game' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/starts on its own/);
    fireEvent.click(screen.getByRole('radio', { name: 'Ganks and pressure' }));
    // The plan's own review was never refused: nothing counts down for it.
    const free = await screen.findByRole('button', { name: 'Review my game' }) as HTMLButtonElement;
    expect(free.disabled).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
    // The refused review's wait runs out while the reader is on another plan: nothing is sent for either.
    await new Promise((r) => { setTimeout(r, 3200); });
    expect(bodies).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Review my game' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({ hero: 'beastmaster', lang: 'en', plan: 'gank' });
  }, 10000);

  it('a refused parse is picked up again when the reader comes back to it after its wait ran out elsewhere', async () => {
    let prepares = 0;
    mockFetch({
      '/api/coach/9100904020': board,
      '/prepare': () => { if (++prepares > 20) throw new Error('prepare loop'); return prepares === 1 ? { __status: 429, code: 'rate_limited', retryAfterSec: 1 } : { __status: 202, status: 'running', stage: 'locating' }; },
      '/api/agent/9100904020': () => ({ trace: false, model_configured: true, can_parse: true, heroes: [], parse: prepares > 1 ? { status: 'running', stage: 'locating' } : { status: 'none' } }),
    });
    page('/r/9100904020?hero=beastmaster&lang=en');
    fireEvent.click(await screen.findByRole('button', { name: 'Review my game' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/starts on its own/);
    // Away on another plan while the wait runs out: nothing is sent for the one left behind.
    fireEvent.click(screen.getByRole('radio', { name: 'Ganks and pressure' }));
    await new Promise((r) => { setTimeout(r, 2200); });
    expect(prepares).toBe(1);
    // Back to it: the reader's go still stands, and the parse is asked for again.
    fireEvent.click(await screen.findByRole('radio', { name: 'Don\'t say' }));
    await waitFor(() => expect(prepares).toBe(2), { timeout: 3000 });
  }, 10000);

  it('a refusal that arrives after the reader moved to another hero is that first hero\'s, not the new one\'s', async () => {
    let prepares = 0;
    let release: (v: unknown) => void = () => {};
    mockFetch({
      '/api/coach/9100904020': board,
      '/prepare': () => { prepares += 1; return prepares === 1 ? new Promise((r) => { release = r; }) : { __status: 202, status: 'running', stage: 'locating' }; },
      '/api/agent/9100904020': () => ({ trace: false, model_configured: true, can_parse: true, heroes: [], parse: prepares > 1 ? { status: 'running', stage: 'locating' } : { status: 'none' } }),
    });
    page('/r/9100904020?hero=beastmaster&lang=en');
    fireEvent.click(await screen.findByRole('button', { name: 'Review my game' }));
    await waitFor(() => expect(prepares).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'Change hero' }));
    fireEvent.click(await screen.findByRole('button', { name: /Axe/ }));
    await screen.findByRole('button', { name: 'Review my game' });
    release({ __status: 429, code: 'rate_limited', retryAfterSec: 2 });
    await new Promise((r) => { setTimeout(r, 300); });
    // Axe was never refused: no countdown, and the button works while the first hero's wait runs.
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('button', { name: 'Review my game' }) as HTMLButtonElement).disabled).toBe(false);
    // That wait running out sends nothing for Axe, who has no go.
    await new Promise((r) => { setTimeout(r, 2500); });
    expect(prepares).toBe(1);
  }, 10000);

  it('a go for a second hero while the first one\'s parse request is out shares its refusal, and its wait', async () => {
    let prepares = 0;
    let release: (v: unknown) => void = () => {};
    mockFetch({
      '/api/coach/9100904020': board,
      '/prepare': () => { prepares += 1; return prepares === 1 ? new Promise((r) => { release = r; }) : { __status: 202, status: 'running', stage: 'locating' }; },
      '/api/agent/9100904020': () => ({ trace: false, model_configured: true, can_parse: true, heroes: [], parse: prepares > 1 ? { status: 'running', stage: 'locating' } : { status: 'none' } }),
    });
    page('/r/9100904020?hero=beastmaster&lang=en');
    fireEvent.click(await screen.findByRole('button', { name: 'Review my game' }));
    await waitFor(() => expect(prepares).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'Change hero' }));
    fireEvent.click(await screen.findByRole('button', { name: /Axe/ }));
    // Axe's go joins the parse request already out: nothing new is sent.
    fireEvent.click(await screen.findByRole('button', { name: 'Review my game' }));
    expect(prepares).toBe(1);
    release({ __status: 429, code: 'rate_limited', retryAfterSec: 1 });
    // The refusal is Axe's too: it counts down, then asks again.
    expect((await screen.findByRole('alert')).textContent).toMatch(/starts on its own/);
    await waitFor(() => expect(prepares).toBe(2), { timeout: 4000 });
  }, 10000);

  it('each review keeps its own wait: a second refusal for another plan does not cut the first one short', async () => {
    const bodies: any[] = [];
    mockFetch({
      '/review?': { status: 'none' },
      '/review': (_u: string, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return { __status: 429, code: 'rate_limited', retryAfterSec: bodies.length === 1 ? 30 : 20 }; },
      '/api/agent/9100904020': { trace: true, model_configured: true, heroes },
    });
    page('/r/9100904020?hero=beastmaster&lang=en');
    fireEvent.click(await screen.findByRole('button', { name: 'Review my game' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/in 0:(29|30)\.$/);
    fireEvent.click(screen.getByRole('radio', { name: 'Ganks and pressure' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Review my game' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/in 0:(19|20)\.$/);
    // Back to the first: still its own countdown, and nothing is sent before it ends.
    fireEvent.click(screen.getByRole('radio', { name: 'Don\'t say' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/in 0:(2[89]|30)\.$/);
    await new Promise((r) => { setTimeout(r, 1200); });
    expect(bodies).toHaveLength(2);
    expect((screen.getByRole('button', { name: 'Review my game' }) as HTMLButtonElement).disabled).toBe(true);
  }, 10000);

  it('a review start refused after the reader moved to another hero keeps its wait for when they come back', async () => {
    let posts = 0;
    let release: (v: unknown) => void = () => {};
    mockFetch({
      '/review?': { status: 'none' },
      '/review': () => { posts += 1; return posts === 1 ? new Promise((r) => { release = r; }) : { __status: 202, status: 'running', steps: [] }; },
      '/api/agent/9100904020': { trace: true, model_configured: true, heroes },
    });
    page('/r/9100904020?hero=beastmaster&lang=en');
    fireEvent.click(await screen.findByRole('button', { name: 'Review my game' }));
    await waitFor(() => expect(posts).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'Change hero' }));
    fireEvent.click(await screen.findByRole('button', { name: /Axe/ }));
    await screen.findByRole('button', { name: 'Review my game' });
    release({ __status: 429, code: 'rate_limited', retryAfterSec: 30 });
    await new Promise((r) => { setTimeout(r, 100); });
    expect(screen.queryByRole('alert')).toBeNull();
    // Back to Beastmaster: the refusal's wait is there, and nothing is sent before it ends.
    fireEvent.click(screen.getByRole('button', { name: 'Change hero' }));
    fireEvent.click(await screen.findByRole('button', { name: /Beastmaster/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/starts on its own in 0:(29|30)\.$/);
    await new Promise((r) => { setTimeout(r, 1200); });
    expect(posts).toBe(1);
  }, 10000);

  it('two quick clicks before the replay is parsed send one parse request', async () => {
    let release: (v: unknown) => void = () => {};
    const calls = mockFetch({
      '/api/coach/9100904020': board,
      '/prepare': () => new Promise((r) => { release = r; }),
      '/api/agent/9100904020': { trace: false, model_configured: true, can_parse: true, heroes: [], parse: { status: 'none' } },
    });
    page('/r/9100904020?hero=beastmaster&lang=en');
    const button = await screen.findByRole('button', { name: 'Review my game' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(calls.filter((c) => c.url.includes('/prepare'))).toHaveLength(1);
    release({ __status: 429, code: 'rate_limited', retryAfterSec: 30 });
    expect((await screen.findByRole('alert')).textContent).toMatch(/It starts on its own in 0:(29|30)\.$/);
  });

  it('a refusal too long to wait out on the page is said once, and the button stays usable', async () => {
    mockFetch({ '/review?': { status: 'none' }, '/review': { __status: 503, code: 'busy', retryAfterSec: 3600 }, '/api/agent/9100904020': { trace: true, model_configured: true, heroes } });
    page('/r/9100904020?hero=beastmaster&lang=en');
    const button = await screen.findByRole('button', { name: 'Review my game' });
    fireEvent.click(button);
    expect((await screen.findByRole('alert')).textContent).toBe('The coach is at capacity. Try again later.');
    expect((screen.getByRole('button', { name: 'Review my game' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('under the verdict: which patch the numbers are from and how that is known, or a warning when it is not known', async () => {
    const show = async (data_patch: any, lang: 'en' | 'zh') => {
      cleanup();
      ui.lang = lang;
      mockFetch({ 'ref=overview': overview, '/review?': { status: 'ready', review: { ...review, lang, ...(data_patch ? { data_patch } : {}) }, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 }, '/api/agent/9100904020': { trace: true, model_configured: true, heroes } });
      page(`/r/9100904020?hero=beastmaster&lang=${lang}`);
      await screen.findByRole('heading', { level: 1 });
      return document.querySelector('.ag-patch');
    };
    expect((await show({ name: '7.41c', exact: true, known_from: 'match_id' }, 'zh'))!.textContent).toBe('本复盘中的价格、装备效果和技能冷却按 7.41c 版本（依据比赛编号）');
    expect((await show({ name: '7.42', exact: true, known_from: 'match_data' }, 'en'))!.textContent).toBe('Prices, item effects and cooldowns in this review are those of patch 7.42 (from the match record)');
    const warn = (await show({ name: '7.42', exact: false, reason: 'older_than_7.40' }, 'zh'))!;
    expect(warn.textContent).toBe('这局的版本无法确定：价格、装备效果和技能冷却按当前 7.42 版本，可能与当时不同。');
    expect(warn.getAttribute('role')).toBe('note');
    // A game played after a hotfix of its release: the hotfix is named.
    expect((await show({ name: '7.41f', hotfix: '2026-10-07T00:40:47.000Z', exact: true, known_from: 'start_time' }, 'zh'))!.textContent).toBe('本复盘中的价格、装备效果和技能冷却按 7.41f 版本 2026-10-07 热修复后的数值（依据比赛开始时间）');
    expect((await show({ name: '7.41f', hotfix: '2026-10-07T00:40:47.000Z', exact: true, known_from: 'start_time' }, 'en'))!.textContent).toBe('Prices, item effects and cooldowns in this review are those of patch 7.41f after its hotfix of 2026-10-07 (from when the game was played)');
    // The release known, the hotfix not (it was rolling out): not "the patch could not be told".
    const hot = (await show({ name: '7.41f', exact: false, reason: 'started_while_the_2026-10-07T00:40_hotfix_was_rolling_out' }, 'zh'))!;
    expect(hot.textContent).toBe('本复盘中的价格、装备效果和技能冷却按 7.41f 版本；这局前后该版本正好有一次热修复，个别数值可能是热修复前或后的。');
    // A review stored before the patch was kept says nothing rather than guess.
    expect(await show(null, 'en')).toBeNull();
  });

  it('the game plan is its own section; a plan the reader picks is one question to the coach, without the moment pinned for another', async () => {
    const game_plan = { course: 'Your team took 3 outer towers from 18:07 to 19:46.', your_part: 'You were at 15 of the 16 fights.', line_ups: 'Sven wins more in shorter public games.', strengths: 'Phantom Assassin had Battle Fury at 15:47 and killed you 5 times after it.', main_reason: 'team_play', why: 'The team did not turn fights into towers.', evidence: [{ refs: ['phase:beastmaster:3'], clock: '20:00', fact: 'The enemy took 3 towers.' }] };
    const calls = mockFetch({
      '/chat': () => sse([{ step: { tool: 'tempo_report', args: { hero: 'beastmaster' } } }, { text: 'Your play fit the plan.', unverified: [] }, { done: true }]),
      'ref=overview': overview,
      '/evidence?': cast,
      '/review?': { status: 'ready', review: { ...review, game_plan }, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 },
      '/api/agent/9100904020': { trace: true, model_configured: true, heroes },
    });
    page('/r/9100904020?hero=beastmaster&lang=en');
    const section = (await screen.findByRole('heading', { level: 3, name: 'The game plan' })).closest('details')!;
    const plan = within(section as HTMLElement);
    expect(plan.getByText('How it went').nextElementSibling!.textContent).toBe(game_plan.course);
    expect(plan.getByText('Your part').nextElementSibling!.textContent).toBe(game_plan.your_part);
    expect(plan.getByText('The line-ups').nextElementSibling!.textContent).toBe(game_plan.line_ups);
    expect(plan.getByText('What you were up against').nextElementSibling!.textContent).toBe(game_plan.strengths);
    expect(section.querySelector('.ag-plan-why')!.textContent).toBe('Mostly the team, not youThe team did not turn fights into towers.');
    // Folded, its heading already says what the game is put down to.
    expect(section.querySelector('summary')!.textContent).toBe('The game planMostly the team, not you');
    // Its evidence opens like a finding's.
    expect(plan.getByText('The enemy took 3 towers.')).toBeTruthy();
    expect(plan.getByText('20:00')).toBeTruthy();
    // The reader's own lesson comes first; the game as a whole after it, folded, with the plan after the story.
    const lesson = screen.getByRole('heading', { level: 2, name: 'Practise this next game' });
    const whole = screen.getByRole('heading', { level: 2, name: 'The whole game' });
    expect(lesson.compareDocumentPosition(whole) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(section.closest('section')!.querySelector('h2')).toBe(whole);
    expect((section as HTMLDetailsElement).open).toBe(false);
    const folds = Array.from(section.closest('section')!.querySelectorAll('details > summary h3')).map((h) => h.textContent);
    expect(folds).toEqual(['How the game went', 'The game plan']);

    // A moment is pinned for a typed question; picking a plan does not send it along, and leaves it pinned.
    fireEvent.click(screen.getAllByRole('button', { name: 'Ask about this' })[0]);
    expect(await screen.findByText('About')).toBeTruthy();
    fireEvent.click(plan.getByRole('button', { name: 'Lanes into towers' }));
    await waitFor(() => expect(screen.getByText('Your play fit the plan.')).toBeTruthy());
    const sent = JSON.parse(String(calls.find((c) => c.url.includes('/chat'))!.init!.body));
    expect(sent).toEqual({ hero: 'beastmaster', lang: 'en', question: 'My plan this game was to win the lanes and take towers early. Did my play fit it? Was it sound against their line-up? And where it failed, was that my play, the plan, or what the enemy did?', history: [] });
    expect(screen.getByText('Reading who took the map, and when')).toBeTruthy();
    expect(screen.getByText('About')).toBeTruthy();
    // The reader's own words are shown as the question.
    expect(screen.getByText(/My plan this game was to win the lanes/)).toBeTruthy();
  });

  it('a review without a game plan still offers to check the reader\'s plan; while the coach is answering, a second pick is not sent', async () => {
    let chats = 0;
    mockFetch({
      '/chat': () => { chats += 1; return new Promise(() => {}); },
      'ref=overview': overview,
      '/review?': { status: 'ready', review: { ...review, lang: 'zh' }, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 },
      '/api/agent/9100904020': { trace: true, model_configured: true, heroes },
    });
    ui.lang = 'zh';
    page('/r/9100904020?hero=beastmaster&lang=zh');
    const section = (await screen.findByRole('heading', { level: 3, name: '运营思路' })).closest('details')!;
    const plan = within(section as HTMLElement);
    expect(plan.queryByText('走势')).toBeNull();
    expect(plan.getByText('这局你本来想怎么打？告诉教练，它会对照录像回答。')).toBeTruthy();
    expect(plan.getAllByRole('button').map((b) => b.textContent)).toEqual(['线优转推进', '抓人带节奏', '带线牵制', '发育拖后期']);
    fireEvent.click(plan.getByRole('button', { name: '抓人带节奏' }));
    await waitFor(() => expect(chats).toBe(1));
    expect(screen.getByText(/我这局的思路是「抓人带节奏、打压制」/)).toBeTruthy();
    expect(plan.queryByRole('status')).toBeNull();
    fireEvent.click(plan.getByRole('button', { name: '发育拖后期' }));
    // Not sent, and the reader is told why.
    expect((await plan.findByRole('status')).textContent).toBe('教练还在回答上一个问题，等它答完再选。');
    expect(chats).toBe(1);
    expect(screen.queryByText(/发育拖后期再打团/)).toBeNull();
  });

  it('ready: the scoreboard (both line-ups, the reader marked) is part of the whole game, folded, after the lesson', async () => {
    mockFetch({
      'ref=overview': overview,
      '/review?': { status: 'ready', review, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 },
      '/api/coach/9100904020': board,
      '/api/agent/9100904020': { trace: true, model_configured: true, heroes },
    });
    page('/r/9100904020?hero=beastmaster&lang=en');
    const lead = await screen.findByRole('heading', { level: 1, name: review.findings[0].title });
    const scoreboard = await screen.findByRole('region', { name: 'Scoreboard' });
    expect(scoreboard.querySelectorAll('li')).toHaveLength(board.players.length);
    expect(scoreboard.querySelector('li.is-me')?.textContent).toContain('Beastmaster');
    // After the lesson, in its own fold of the whole game, which starts closed; the story of the game comes before it.
    expect(lead.compareDocumentPosition(scoreboard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const fold = scoreboard.closest('details')!;
    expect(fold.querySelector('summary')!.textContent).toBe('Line-ups and scoreboard');
    expect(fold.open).toBe(false);
    expect(fold.closest('section')!.querySelector('h2')!.textContent).toBe('The whole game');
    const story = screen.getByRole('heading', { level: 3, name: 'How the game went' });
    expect(story.compareDocumentPosition(scoreboard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the strip marks the fight the record names as the turn — it does not work one out — and none when the record names none', async () => {
    const ready = { status: 'ready', review, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 };
    const fights = [
      { ref: 'fight:11', from: 1826, to: 1848, clock: '30:26–30:48', my_team_deaths: 5, enemy_deaths: 3, my_team_gold_lead_before: -745, my_team_gold_lead_2min_after: -4298 },
      // A bigger fall, entered ahead: by the rule the page used to apply itself, this one would be marked.
      { ref: 'fight:12', from: 2000, to: 2010, clock: '33:20–33:30', my_team_deaths: 4, enemy_deaths: 0, my_team_gold_lead_before: 9000, my_team_gold_lead_2min_after: 1000 },
    ];
    // Each case is its own game: the page keeps a game's overview for the session.
    const show = async (id: string, turning_fight: unknown) => {
      cleanup();
      mockFetch({ 'ref=overview': { ...overview, record: { duration: { t: 2551 }, fights, ...(turning_fight === undefined ? {} : { turning_fight }) } }, '/review?': ready, [`/api/agent/${id}`]: { trace: true, model_configured: true, heroes } });
      page(`/r/${id}?hero=beastmaster&lang=en`);
      await waitFor(() => expect(document.querySelectorAll('.ag-strip-fight')).toHaveLength(2));
      return Array.from(document.querySelectorAll('.ag-strip-fight.is-turn text')).map((t) => t.textContent);
    };
    expect(await show('8000000101', { ref: 'fight:11', clock: '30:26–30:48' })).toEqual(['▲ 30:26 the turn']);
    // A game with gold and no fight that cost that much; a game with no gold to tell from; a game the player won (no field).
    expect(await show('8000000102', { none: true })).toEqual([]);
    expect(await show('8000000103', null)).toEqual([]);
    expect(await show('8000000104', undefined)).toEqual([]);
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
    // The headline is the first finding; the sentence about the whole game stands with the whole game.
    expect(await screen.findByRole('heading', { level: 1, name: 'Roar on the wrong target' })).toBeTruthy();
    expect(screen.getByText('Three of ten went to Axe.').className).toBe('ag-lead-claim');
    expect(screen.getByText(review.verdict).closest('section')!.querySelector('h2')!.textContent).toBe('The whole game');
    expect(screen.getByRole('heading', { level: 2, name: 'Practise this next game' }).closest('section')!.textContent).toContain('Keep it for her.');
    expect(screen.getByText(/1 removed for lack of evidence/)).toBeTruthy();
    // The turning fight is marked on the strip once the overview arrives: the one the record names, and no other —
    // the page does not work it out again (the next fight cost more gold, and is not the one the review was sent to).
    expect(await screen.findByText(/▲ 30:26 the turn/)).toBeTruthy();
    expect(document.querySelectorAll('.ag-strip-fight.is-turn')).toHaveLength(1);
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
    // The account is known (77): the reader is told where the check will be waiting.
    expect(screen.getByText(/Your next game shows up on the dota2.ai home page with this goal already checked/)).toBeTruthy();
    expect((await events()).filter((e) => e.event === 'goal_set').map((e) => e.props)).toEqual([{ matchId: '9100904020', kind: 'hold_item', account: true, rules: 0 }]);
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

  it('a goal carried from another game shows its check, not that game\'s advice, and says which game it came from', async () => {
    // A goal stored by an older page kept the whole advice paragraph of the game it came from (another hero's) as `action`.
    const label = { en: 'At most 3 deaths to enemies who already have a Blink-type item', zh: '被已有跳刀类位移装的敌人击杀不超过 3 次' };
    window.localStorage.setItem('dota2ai.coach.goal', JSON.stringify({ id: '9091400302:3:deaths.high', goal: { kind: 'hold_item', items: ['blink'], hero_id: 38, label }, action: { en: 'As Tidehunter you start the fights.', zh: '潮汐猎人是开团的人。' }, findingId: 'deaths.high', fromMatch: 9091400302, fromStart: 1795344198, accountId: 77, heroId: 29, setAt: 1 }));
    const later = { match: { id: 9100999999, patch: '7.42', start_time: 1795400000, duration: 2400 }, players: [board.players[0], { ...board.players[1], items: [{ key: 'blink', en: 'Blink Dagger', zh: '闪烁匕首' }] }], reviews: [{ role: { kind: 'core' } }, { role: { kind: 'core' } }] };
    mockFetch({ '/api/coach/9100999999': later, '/api/agent/9100999999': { trace: false, model_configured: true, can_parse: true, heroes: [], parse: { status: 'none' } } });
    page('/r/9100999999?hero=beastmaster&lang=en');
    expect(await screen.findByText(label.en)).toBeTruthy();
    expect(screen.queryByText(/Tidehunter/)).toBeNull();
    expect(screen.getByRole('link', { name: 'set after game #9091400302' }).getAttribute('href')).toBe('/r/9091400302?lang=en');
  });

  it('a review whose rules name a count offers them as the next-game check, with what the next replay is counted on', async () => {
    const check = { kind: 'replay_habit', habit: 'low_health', max: 1, baseline: 3, label: { en: 'At most 1 deaths that began below half health (12 s before) (this game: 3)', zh: 'x' } };
    const alone = { kind: 'replay_habit', habit: 'alone', max: 2, baseline: 4, label: { en: 'At most 2 deaths with no ally within 2200 (this game: 4)', zh: 'x' } };
    const withRules = { ...review, findings: [
      { ...review.findings[0], rule: { when: 'Below half health with an enemy in front of you', do: 'walk back to the tower', this_game: '3 of 12 deaths', check } },
      { ...review.findings[0], title: 'Alone', rule: { when: 'No teammate on the minimap near you', do: 'stay on your side of the river', check: alone } },
    ] };
    mockFetch({
      '/api/coach/9100904020': { ...board, match: { id: 9100904020, patch: '7.42', start_time: 1795344198, duration: 2551 } },
      'ref=overview': overview,
      '/review?': { status: 'ready', review: withRules, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 },
      '/api/agent/9100904020': { trace: true, model_configured: true, can_parse: true, heroes },
    });
    page('/r/9100904020?hero=beastmaster&lang=en');
    // Under the rule itself, and (no scoreboard goal here) as the goal with the other rule beside it.
    expect(await screen.findAllByText(check.label.en)).toHaveLength(2);
    expect(screen.getAllByText(alone.label.en)).toHaveLength(2);
    expect(screen.getByText('Counted in your next replay')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Make this my next-game goal' }));
    await waitFor(() => expect(window.localStorage.getItem('dota2ai.coach.goal')).not.toBeNull());
    const stored = JSON.parse(window.localStorage.getItem('dota2ai.coach.goal')!);
    expect(stored).toMatchObject({ id: '9100904020:beastmaster:agent:replay_habit:low_health1:ralone2', goal: check, findingId: 'agent:1', accountId: 77 });
    expect(stored.rules).toEqual([{ finding: 2, when: 'No teammate on the minimap near you', do: 'stay on your side of the river', check: alone }]);
    // These are counted in the replay: the home page is where the next game is found, not where it is already checked.
    expect(screen.getByText(/open it from there\. This goal is checked once that game’s replay has been read/)).toBeTruthy();
    expect(screen.queryByText(/with this goal already checked/)).toBeNull();
  });

  it('a later game is counted on the rules from its own replay; without the replay nothing is called met', async () => {
    const check = { kind: 'replay_habit', habit: 'low_health', max: 1, baseline: 3, label: { en: 'At most 1 low', zh: 'x' } };
    const alone = { kind: 'replay_habit', habit: 'alone', max: 2, baseline: 4, label: { en: 'At most 2 alone', zh: 'x' } };
    const roar = { kind: 'replay_habit', habit: 'target_survived', max: 2, baseline: 4, hero: 'beastmaster', hero_id: 38, ability: 'primal_roar', name: { en: 'Primal Roar', zh: '原始咆哮' }, label: { en: 'At most 2 roars', zh: 'x' } };
    const goal = { id: 'g', goal: check, action: check.label, findingId: 'agent:1', fromMatch: 9100904020, fromStart: 1795344198, accountId: 77, heroId: 38, setAt: 1, rules: [{ finding: 2, when: 'No teammate near you', do: 'stay on your side of the river', check: alone }, { finding: 3, when: 'The carry has not used Black King Bar', do: 'keep the roar', check: roar }] };
    window.localStorage.setItem('dota2ai.coach.goal', JSON.stringify(goal));
    const later = { match: { id: 9100999998, patch: '7.42', start_time: 1795400000, duration: 2400 }, players: board.players, reviews: [{ role: { kind: 'core' } }, { role: { kind: 'core' } }] };
    // Not parsed yet: both are unknown, and the page says what is needed.
    mockFetch({ '/api/coach/9100999998': later, '/api/agent/9100999998': { trace: false, model_configured: true, can_parse: true, heroes: [], parse: { status: 'none' } } });
    page('/r/9100999998?hero=beastmaster&lang=en');
    expect(await screen.findAllByText('Your rule, in this game')).toHaveLength(2);
    expect(screen.getAllByText('Can’t tell yet')).toHaveLength(3);
    expect(screen.getAllByText('Needs this game\'s replay: open its replay review.')).toHaveLength(3);
    cleanup();
    // Parsed: the same counts, from this game's replay.
    const calls = mockFetch({
      '/api/coach/9100999998': later,
      'ref=deaths': { status: 'ok', ref: 'deaths:beastmaster', kind: 'deaths', names: {}, record: { deaths_total: 6, deaths_where: { health_below_half_at_window_start: ['12:40'], no_ally_within_2200_at_death: ['3:00', '9:10', '21:05'] }, deaths_not_known: { health_at_window_start: 0, allies_at_death: 0 } } },
      // The rule about the roar is counted on this game's audit of it.
      'ref=audit%3Abeastmaster%3Aprimal_roar': { status: 'ok', ref: 'audit:beastmaster:primal_roar', kind: 'audit', names: {}, record: { learned_at: { t: 400, clock: '6:40' }, casts_total: 7, casts_where: { enemy_hero_target_alive_12s_later: ['9:00'] } } },
      '/review?': { status: 'none' },
      '/api/agent/9100999998': { trace: true, model_configured: true, can_parse: true, heroes },
    });
    page('/r/9100999998?hero=beastmaster&lang=en');
    await waitFor(() => expect(screen.getAllByText('Met')).toHaveLength(2));
    expect(screen.getByText('Missed')).toBeTruthy();
    expect(screen.getByText('No teammate near you: stay on your side of the river')).toBeTruthy();
    expect(screen.getByText('3 deaths with no ally within 2200 (3:00, 9:10, 21:05); goal ≤ 2')).toBeTruthy();
    expect(calls.some((c) => c.url.includes('ref=deaths%3Abeastmaster'))).toBe(true);
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem('dota2ai.coach.goalChecks')!)).toEqual([
      expect.objectContaining({ goalId: 'g', matchId: 9100999998, result: 'met' }),
      expect.objectContaining({ goalId: 'g#2', matchId: 9100999998, result: 'missed' }),
      expect.objectContaining({ goalId: 'g#3', matchId: 9100999998, result: 'met', evidence: expect.objectContaining({ en: '1 Primal Roar casts on an enemy hero still alive 12 s later (9:00); goal ≤ 2' }) }),
    ]));
    // The games page has only the scoreboard: asked there, the goal answers with what the replay already settled.
    const store = await import('../coach/goalStore');
    expect(store.checkGoal(goal as any, later as any, 1)).toMatchObject({ result: 'met' });
    expect(store.checkRules(goal as any, later as any, 1, null)[0].check).toMatchObject({ result: 'missed' });
    expect(JSON.parse(window.localStorage.getItem('dota2ai.coach.goalChecks')!).map((c: any) => c.result)).toEqual(['met', 'missed', 'met']);
  });

  it('an invalid match id never calls the server', async () => {
    const calls = mockFetch({});
    page('/r/not-a-match?lang=en');
    expect(await screen.findByRole('heading', { name: 'That is not a match ID.' })).toBeTruthy();
    await waitFor(() => expect(calls).toHaveLength(0));
  });
});

describe('helpers', () => {
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
