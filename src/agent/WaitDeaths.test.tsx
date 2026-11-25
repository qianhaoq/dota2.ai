// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { WaitDeaths } from './WaitDeaths';

/** While the review is written: the player's deaths from the summary the review reads, each replayable. */

const summary = (over: any = {}) => ({
  ref: 'deaths:axe', deaths_total: 4, killed_by: { lina: 1, phantom_assassin: 3 },
  deaths_where: {
    in_a_fight: ['22:06', '8:27'], outside_fights: ['0:47', '2:51'],
    no_ally_within_2200_at_death: ['2:51'], three_or_more_enemy_heroes_dealing_damage: ['8:27', '22:06'],
    traded_within_15s: ['2:51', '8:27'], not_traded_within_15s: ['0:47'],
    // Lists the page does not show.
    health_below_half_at_window_start: ['0:47'], bought_back: [],
  },
  ...over,
});
const moment = { status: 'ok', t: 47, clock: '0:47', from: 35, to: 53, me: 'axe', place: null, place_name: null, heroes: [{ hero: 'axe', side: 'me' }], frames: [{ t: 47, at: [[0, 0, 1]] }], deaths: [], box: { x: -1000, y: -1000, size: 2000 }, away: [], not_known: [], names: { axe: 'Axe' }, icons: {} };
let record: any = summary();
const calls = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); };
// Each test asks about its own match: the evidence client keeps a record for the session.
let n = 0;
const show = async (lang: 'en' | 'zh' = 'en') => { n += 1; render(<WaitDeaths matchId={String(1000 + n)} hero="axe" lang={lang} />); await flush(); return String(1000 + n); };

beforeEach(() => {
  record = summary();
  (window as any).matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/evidence')) return record ? new Response(JSON.stringify({ status: 'ok', ref: 'deaths:axe', kind: 'deaths', record, names: { lina: 'Lina', phantom_assassin: 'Phantom Assassin' } }), { status: 200 }) : new Response(JSON.stringify({ code: 'unknown_ref' }), { status: 404 });
    if (u.includes('/moment')) return new Response(JSON.stringify(moment), { status: 200 });
    return new Response('{}', { status: 200 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('WaitDeaths', () => {
  it('asks for the same death summary the review reads, and says how many times and by whom', async () => {
    const id = await show();
    expect(calls().filter((u) => u.includes('/evidence'))).toEqual([`/api/agent/${id}/evidence?hero=axe&lang=en&ref=deaths%3Aaxe`]);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('While the coach reads the replay: your 4 deaths');
    expect(screen.getByText('Facts from the replay, no verdict yet. Each one can be played on the map.')).toBeTruthy();
    // Most often first, by the reader's names for them.
    expect(Array.from(document.querySelectorAll('.ag-wait-by .ag-chip')).map((e) => e.textContent)).toEqual(['Phantom Assassin ×3', 'Lina ×1']);
  });

  it('lists the deaths in game order, each with the labels the summary lists it under — and no others', async () => {
    await show();
    const rows = Array.from(document.querySelectorAll('.ag-wait-list > li')).map((li) => [li.querySelector('.ag-wait-clock')!.textContent, Array.from(li.querySelectorAll('.ag-wait-tags .ag-chip')).map((c) => c.textContent)]);
    expect(rows).toEqual([
      ['0:47', ['outside a fight', 'no enemy died within 15 s']],
      ['2:51', ['outside a fight', 'no ally within 2200', 'an enemy died within 15 s']],
      ['8:27', ['in a fight', '3+ enemies hitting you', 'an enemy died within 15 s']],
      // In neither trade list: the summary could not tell, and the page says neither.
      ['22:06', ['in a fight', '3+ enemies hitting you']],
    ]);
    expect(document.querySelector('.ag-wait-note')).toBeNull();
  });

  it('a death replays on the map at its own second; one at a time; counted as a moment played', async () => {
    const id = await show();
    const rows = () => Array.from(document.querySelectorAll('.ag-wait-list > li')) as HTMLElement[];
    // The time is the row's; the button says what it does, and is named with the time for a reader who hears it.
    expect(within(rows()[1]).getByRole('button', { name: 'Replay on the map · 2:51' }).textContent).toBe('Replay on the map');
    fireEvent.click(within(rows()[1]).getByRole('button', { name: 'Replay on the map · 2:51' }));
    await flush();
    expect(calls().filter((u) => u.includes('/moment'))).toEqual([`/api/agent/${id}/moment?hero=axe&lang=en&t=171`]);
    expect(rows()[1].querySelector('.ag-replay')).toBeTruthy();
    expect(within(rows()[1]).getByRole('button', { name: 'Close the replay · 2:51' }).getAttribute('aria-expanded')).toBe('true');
    // Another one: the first closes.
    fireEvent.click(within(rows()[0]).getByRole('button', { name: 'Replay on the map · 0:47' }));
    await flush();
    expect(document.querySelectorAll('.ag-replay')).toHaveLength(1);
    expect(rows()[0].querySelector('.ag-replay')).toBeTruthy();
    expect(within(rows()[0]).getByRole('button', { name: 'Close the replay · 0:47' }).textContent).toBe('Close the replay');
    fireEvent.click(within(rows()[0]).getByRole('button', { name: 'Close the replay · 0:47' }));
    expect(document.querySelectorAll('.ag-replay')).toHaveLength(0);
    const played = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).includes('/api/events')).map((c) => JSON.parse(String(c[1].body)));
    expect(played.map((e) => [e.event, e.props])).toEqual([['moment_played', { matchId: id, lang: 'en', hero: 'axe' }], ['moment_played', { matchId: id, lang: 'en', hero: 'axe' }]]);
  });

  it('a death the replay has no positions for is still listed, at its time, without the labels that could not be told', async () => {
    // 30:42 is in neither "in a fight" nor "outside one" (no position samples around it); the log still says an enemy
    // died within 15 s. 36:05 is only in a list this page shows no label for.
    record = summary({ deaths_total: 6, deaths_where: { ...summary().deaths_where, traded_within_15s: ['2:51', '8:27', '30:42'], nothing_cast_and_no_item_used: ['36:05'] } });
    await show();
    const rows = Array.from(document.querySelectorAll('.ag-wait-list > li')).map((li) => [li.querySelector('.ag-wait-clock')!.textContent, Array.from(li.querySelectorAll('.ag-wait-tags .ag-chip')).map((c) => c.textContent)]);
    expect(rows.slice(-2)).toEqual([['30:42', ['an enemy died within 15 s']], ['36:05', []]]);
    expect(rows).toHaveLength(6);
    expect(document.querySelector('.ag-wait-note')).toBeNull();
    // And it replays like any other.
    expect(screen.getByRole('button', { name: 'Replay on the map · 36:05' })).toBeTruthy();
  });

  it('deaths the summary gives no time for are counted, not hidden', async () => {
    record = summary({ deaths_total: 6 });
    await show();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('While the coach reads the replay: your 6 deaths');
    expect(document.querySelectorAll('.ag-wait-list > li')).toHaveLength(4);
    expect(document.querySelector('.ag-wait-note')!.textContent).toBe('2 more with no time in this summary.');
  });

  it('one death and none read as a person would say them', async () => {
    record = summary({ deaths_total: 1, killed_by: { lina: 1 }, deaths_where: { in_a_fight: ['8:27'], outside_fights: [], traded_within_15s: ['8:27'] } });
    await show();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('While the coach reads the replay: your one death');
    cleanup();
    record = summary({ deaths_total: 0, killed_by: {}, deaths_where: { in_a_fight: [], outside_fights: [] } });
    await show();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('While the coach reads the replay');
    expect(screen.getByText('You did not die once this game.')).toBeTruthy();
    expect(document.querySelector('.ag-wait-list')).toBeNull();
  });

  it('shows nothing when the summary cannot be read, or is not one: the wait is as it was', async () => {
    record = null;
    await show();
    expect(document.querySelector('.ag-wait')).toBeNull();
    cleanup();
    record = { ref: 'deaths:axe', deaths_total: 'many' };
    await show();
    expect(document.querySelector('.ag-wait')).toBeNull();
  });

  it('Chinese: the same, in the reader\'s language', async () => {
    await show('zh');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('教练看录像的这几分钟，先看你的 4 次阵亡');
    expect(Array.from(document.querySelectorAll('.ag-wait-by .ag-chip')).map((e) => e.textContent)).toEqual(['Phantom Assassin 3 次', 'Lina 1 次']);
    expect(Array.from(document.querySelectorAll('.ag-wait-list > li')[1].querySelectorAll('.ag-wait-tags .ag-chip')).map((c) => c.textContent)).toEqual(['团战外', '2200 范围内没有队友', '15 秒内有敌人倒下']);
    expect(screen.getByRole('button', { name: '在地图上重放 · 0:47' })).toBeTruthy();
  });
});
