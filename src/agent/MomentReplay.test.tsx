// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MomentReplay, STEP_MS, heroIcon } from './MomentReplay';
import { EvidenceCard, momentOf } from './EvidenceCard';
import type { Moment } from './api';

/** Three heroes over four seconds: the player, an ally who has no sample at one second, an enemy who walks into the square and dies. */
const moment = (over: Partial<Moment> = {}): Moment => ({
  status: 'ok', t: 102, clock: '1:42', from: 100, to: 103, me: 'axe',
  heroes: [{ hero: 'axe', side: 'me' }, { hero: 'queen_of_pain', side: 'ally' }, { hero: 'lina', side: 'enemy' }],
  frames: [
    { t: 100, at: [[0, 0, 1], [500, 500, 1], [5000, 0, 1]] },
    { t: 101, at: [[100, 0, 1], null, [900, 0, 1]] },
    { t: 102, at: [[200, 0, 1], [600, 500, 1], [800, 0, 1]] },
    { t: 103, at: [[300, 0, 1], [700, 500, 1], [800, 0, 0]] },
  ],
  deaths: [{ t: 102.6, hero: 'lina', killer: 'axe' }],
  box: { x: -1000, y: -1000, size: 2000 }, away: [], not_known: [], place: 'river_mid', place_name: 'river mid',
  names: { axe: 'Axe', queen_of_pain: 'Queen of Pain', lina: 'Lina' }, icons: { axe: 'axe', queen_of_pain: 'queenofpain', lina: 'lina' },
  ...over,
});
let n = 0;
/** Each test asks for its own game second, so the session cache of moments does not carry one test's answer into the next. */
const fresh = () => { n += 1; return 100000 + n; };
const serve = (body: Moment | null) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body ?? { code: 'no_such_time' }), { status: body ? 200 : 404, headers: { 'content-type': 'application/json' } })));
const heroes = () => Array.from(document.querySelectorAll('.ag-replay-hero')).map((g) => `${g.querySelector('title')!.textContent}${g.classList.contains('is-dead') ? ' (dead)' : ''}`);
const clock = () => document.querySelector('.ag-replay-controls output')!.textContent;
const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
const step = async (k = 1) => { for (let j = 0; j < k; j += 1) await act(async () => { await vi.advanceTimersByTimeAsync(STEP_MS); }); };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('MomentReplay', () => {
  it('asked for, it plays from the first second to the last and stops; the cited second is marked', async () => {
    serve(moment());
    render(<MomentReplay matchId="7" hero="axe" lang="en" t={fresh()} />);
    expect(screen.getByText('Loading the moment…')).toBeTruthy();
    await flush();
    expect(screen.getByRole('img', { name: 'The map from 1:40 to 1:43' })).toBeTruthy();
    expect(clock()).toBe('1:40');
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
    await step();
    expect(clock()).toBe('1:41');
    await step();
    expect(clock()).toBe('1:42');
    expect(document.querySelector('.ag-replay-controls output')!.className).toBe('is-moment');
    await step(3);
    // The last second stays on screen, and the button offers to play again.
    expect(clock()).toBe('1:43');
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
  });

  it('draws a hero where the replay has them: not at a second without a sample, not outside the square, and dead from the second they died', async () => {
    serve(moment());
    render(<MomentReplay matchId="7" hero="axe" lang="en" t={fresh()} />);
    await flush();
    // 1:40: the enemy is across the map, outside the square, and named under it.
    // The player's mark is drawn last, on top of any other.
    expect(heroes()).toEqual(['Queen of Pain', 'Axe']);
    expect(screen.getByText('Not in this part of the map: Lina')).toBeTruthy();
    expect(screen.queryByText(/No position in the replay/)).toBeNull();
    await step();
    // 1:41: the ally has no sample at this second: not drawn, and the page says the replay has no position for her — not that she was elsewhere.
    expect(heroes()).toEqual(['Lina', 'Axe']);
    expect(screen.queryByText(/Not in this part of the map/)).toBeNull();
    expect(screen.getByText('No position in the replay at this second: Queen of Pain')).toBeTruthy();
    await step(2);
    expect(heroes()).toEqual(['Queen of Pain', 'Lina (dead)', 'Axe']);
    expect(document.querySelector('.ag-replay-deaths li')!.textContent).toBe('1:42 Lina died');
    expect(document.querySelector('.ag-replay-deaths li')!.className).toBe('is-past');
  });

  it('a trail is only ever consecutive seconds the replay has: it does not join across a missing second, nor through one outside the square', async () => {
    serve(moment());
    render(<MomentReplay matchId="7" hero="axe" lang="en" t={fresh()} />);
    await flush();
    const trails = () => Object.fromEntries(['me', 'ally', 'enemy'].map((side) => [side, document.querySelector(`.ag-replay-trail.is-${side}`)?.getAttribute('points') ?? null]));
    // The square is 2000 wide on a 320 px map: 0.16 px a unit, y down.
    const at = (x: number, y: number) => `${((x + 1000) * 0.16).toFixed(1)},${(320 - (y + 1000) * 0.16).toFixed(1)}`;
    // 1:40, the first second: nobody has come from anywhere yet.
    expect(trails()).toEqual({ me: null, ally: null, enemy: null });
    await step(2);
    // 1:42: the ally had no sample at 1:41, so her trail does not reach back to 1:40; the enemy was outside the
    // square at 1:40, so his starts where he came into it.
    expect(trails()).toEqual({ me: [at(0, 0), at(100, 0), at(200, 0)].join(' '), ally: null, enemy: [at(900, 0), at(800, 0)].join(' ') });
    await step();
    // 1:43: two consecutive seconds of the ally now, and still nothing drawn across the gap.
    expect(trails().ally).toBe([at(600, 500), at(700, 500)].join(' '));
  });

  it('the player is told apart, and each hero is drawn by the game\'s own icon for it', async () => {
    serve(moment());
    render(<MomentReplay matchId="7" hero="axe" lang="zh" t={fresh()} />);
    await flush();
    const me = document.querySelector('.ag-replay-hero.is-me')!;
    expect(me.querySelector('text')!.textContent).toBe('你');
    expect(me.querySelector('image')!.getAttribute('href')).toBe(heroIcon('axe'));
    expect(document.querySelector('.ag-replay-hero.is-ally image')!.getAttribute('href')).toBe('https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/icons/queenofpain.png');
    expect(Array.from(document.querySelectorAll('.ag-replay-legend li')).map((li) => li.textContent)).toEqual(['你', '队友', '对手']);
    // Bearings: where the player stood, and the river where it crosses the square.
    expect(document.querySelector('.ag-replay-place')!.textContent).toBe('1:42 · river mid');
    const river = document.querySelector('.ag-replay-river')!;
    expect(['x1', 'y1', 'x2', 'y2'].map((a) => Number(river.getAttribute(a)))).toEqual([0, 0, 320, 320]);
    // Where a hero stood is not what anyone saw: the page says so.
    expect(document.querySelector('.ag-replay figcaption')!.textContent).toContain('不代表谁能看到谁');
  });

  it('scrubbing stops the play and shows that second; play at the end starts over', async () => {
    serve(moment());
    render(<MomentReplay matchId="7" hero="axe" lang="en" t={fresh()} />);
    await flush();
    const slider = screen.getByRole('slider', { name: 'Game time' });
    fireEvent.change(slider, { target: { value: '3' } });
    expect(clock()).toBe('1:43');
    expect(slider.getAttribute('aria-valuetext')).toBe('1:43');
    await step(2);
    expect(clock()).toBe('1:43');
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(clock()).toBe('1:40');
    await step();
    expect(clock()).toBe('1:41');
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await step(2);
    expect(clock()).toBe('1:41');
  });

  it('a reader who asked for less motion gets the cited second, still, and can play it themselves', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), addEventListener: () => {}, removeEventListener: () => {} }));
    serve(moment());
    render(<MomentReplay matchId="7" hero="axe" lang="en" t={fresh()} />);
    await flush();
    expect(clock()).toBe('1:42');
    await step(3);
    expect(clock()).toBe('1:42');
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
  });

  it('a moment the server does not have is said, not drawn', async () => {
    serve(null);
    render(<MomentReplay matchId="7" hero="axe" lang="zh" t={fresh()} />);
    await flush();
    expect(screen.getByText('这一刻没有取到。')).toBeTruthy();
    expect(document.querySelector('.ag-replay')).toBeNull();
  });

  it('a hero the table has no icon for is still drawn, as its ring', async () => {
    serve(moment({ icons: { axe: 'axe' } }));
    render(<MomentReplay matchId="7" hero="axe" lang="en" t={fresh()} />);
    await flush();
    const ally = document.querySelector('.ag-replay-hero.is-ally')!;
    expect(ally.querySelector('image')).toBeNull();
    expect(ally.querySelector('circle')).toBeTruthy();
  });
});

describe('which evidence lines can be replayed', () => {
  it('a line whose record is a moment of the game, by its clock', () => {
    expect(momentOf({ refs: ['death:axe:3'], clock: '36:05', fact: 'f' })).toBe(2165);
    expect(momentOf({ refs: ['cast:beastmaster:primal_roar:7'], clock: '30:25', fact: 'f' })).toBe(1825);
    expect(momentOf({ refs: ['fights:axe:11', 'fight:11'], clock: '30:26', fact: 'f' })).toBe(1826);
    expect(momentOf({ refs: ['immune:phantom_assassin:3'], clock: '30:34', fact: 'f' })).toBe(1834);
    expect(momentOf({ refs: ['state:axe:1200'], clock: '20:00', fact: 'f' })).toBe(1200);
    expect(momentOf({ refs: ['death:axe:1'], clock: '-0:37', fact: 'f' })).toBe(-37);
  });

  it('not a count over the game, a build, a lane or a ten-minute stretch, and not a line without a clock', () => {
    for (const ref of ['deaths:axe', 'build:axe', 'lane:axe', 'window:axe:2', 'phase:axe:3', 'tempo:axe', 'spikes:axe', 'pro_items:axe', 'item:axe:blink', 'roshan:axe:1', 'overview']) expect(momentOf({ refs: [ref], clock: '19:00', fact: 'f' })).toBeNull();
    expect(momentOf({ refs: ['death:axe:3'], fact: 'f' })).toBeNull();
    expect(momentOf({ refs: ['death:axe:3'], clock: 'at 36', fact: 'f' })).toBeNull();
    expect(momentOf({ refs: [], clock: '36:05', fact: 'f' })).toBeNull();
  });

  it('the card offers the replay only for such a line, and opens it in place', async () => {
    serve(moment());
    render(<ul><EvidenceCard matchId="7" hero="axe" lang="en" item={{ refs: ['death:axe:3'], clock: '36:05', fact: 'Died.' }} onAsk={() => {}} /><EvidenceCard matchId="7" hero="axe" lang="en" item={{ refs: ['build:axe'], clock: '16:48', fact: 'Built.' }} onAsk={() => {}} /></ul>);
    const buttons = screen.getAllByRole('button', { name: 'Replay this moment' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    await flush();
    expect(document.querySelector('.ag-replay')).toBeTruthy();
    // The clock on the line is the game second asked for.
    const calls = (fetch as any).mock.calls as [string, RequestInit?][];
    expect(calls.map((c) => String(c[0])).filter((u) => u.includes('/moment?'))).toEqual(['/api/agent/7/moment?hero=axe&lang=en&t=2165']);
    // Playing a moment is counted, once, by what it is about and nothing a person typed.
    const sent = calls.filter((c) => String(c[0]).includes('/api/events')).map((c) => JSON.parse(String(c[1]?.body)));
    expect(sent.map((e) => [e.event, e.props])).toEqual([['moment_played', { matchId: '7', lang: 'en', hero: 'axe' }]]);
    fireEvent.click(screen.getByRole('button', { name: 'Close the replay' }));
    expect(document.querySelector('.ag-replay')).toBeNull();
  });
});
