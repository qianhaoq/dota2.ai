// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AgentMatchPage, journeyStep } from './AgentMatchPage';
import { turningFight } from './ReviewDoc';
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

afterEach(() => { ui.lang = 'en'; cleanup(); vi.unstubAllGlobals(); window.sessionStorage.clear(); window.localStorage.clear(); });

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
    const section = (await screen.findByRole('heading', { level: 2, name: '运营思路' })).closest('section')!;
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

  it('a refused start explains itself', async () => {
    mockFetch({ '/review?': { status: 'none' }, '/review': { __status: 429, code: 'rate_limited', retryAfterSec: 60 }, '/api/agent/9100904020': { trace: true, model_configured: true, heroes } });
    page('/r/9100904020?hero=beastmaster&lang=en');
    fireEvent.click(await screen.findByRole('button', { name: 'Review my game' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Too many reviews');
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
    expect((await show({ name: '7.41', exact: true, known_from: 'match_id' }, 'zh'))!.textContent).toBe('本复盘中的价格、装备效果和技能冷却按 7.41 版本（依据比赛编号）');
    expect((await show({ name: '7.42', exact: true, known_from: 'match_data' }, 'en'))!.textContent).toBe('Prices, item effects and cooldowns in this review are those of patch 7.42 (from the match record)');
    const warn = (await show({ name: '7.42', exact: false, reason: 'older_than_7.40' }, 'zh'))!;
    expect(warn.textContent).toBe('这局的版本无法确定：价格、装备效果和技能冷却按当前 7.42 版本，可能与当时不同。');
    expect(warn.getAttribute('role')).toBe('note');
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
    const section = (await screen.findByRole('heading', { level: 2, name: 'The game plan' })).closest('section')!;
    const plan = within(section as HTMLElement);
    expect(plan.getByText('How it went').nextElementSibling!.textContent).toBe(game_plan.course);
    expect(plan.getByText('Your part').nextElementSibling!.textContent).toBe(game_plan.your_part);
    expect(plan.getByText('The line-ups').nextElementSibling!.textContent).toBe(game_plan.line_ups);
    expect(plan.getByText('What you were up against').nextElementSibling!.textContent).toBe(game_plan.strengths);
    expect(plan.getByText('Mostly the team, not you').parentElement!.textContent).toBe('Mostly the team, not youThe team did not turn fights into towers.');
    // Its evidence opens like a finding's.
    expect(plan.getByText('The enemy took 3 towers.')).toBeTruthy();
    expect(plan.getByText('20:00')).toBeTruthy();
    // It stands before the findings: the game as a whole, then the player's own play.
    const heads = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(heads.indexOf('The game plan')).toBeLessThan(heads.indexOf('What decided it'));
    expect(heads.indexOf('The game plan')).toBeGreaterThan(heads.indexOf('How the game went'));

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
    const section = (await screen.findByRole('heading', { level: 2, name: '运营思路' })).closest('section')!;
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

  it('ready: the scoreboard (both line-ups, the reader marked) sits right under the verdict', async () => {
    mockFetch({
      'ref=overview': overview,
      '/review?': { status: 'ready', review, verification: { repaired: false, dropped: 0 }, model: 'm', tool_calls: 9 },
      '/api/coach/9100904020': board,
      '/api/agent/9100904020': { trace: true, model_configured: true, heroes },
    });
    page('/r/9100904020?hero=beastmaster&lang=en');
    const verdict = await screen.findByRole('heading', { level: 1, name: review.verdict });
    const scoreboard = await screen.findByRole('region', { name: 'Scoreboard' });
    expect(scoreboard.querySelectorAll('li')).toHaveLength(board.players.length);
    expect(scoreboard.querySelector('li.is-me')?.textContent).toContain('Beastmaster');
    // Under the verdict, before the story of the game.
    expect(verdict.compareDocumentPosition(scoreboard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const story = screen.getByRole('heading', { level: 2, name: 'How the game went' });
    expect(scoreboard.compareDocumentPosition(story) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
