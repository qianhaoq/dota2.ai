// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WaitFacts } from './WaitFacts';

const overviewRecord = {
  duration: { t: 2400 },
  fights: [
    { ref: 'fight:1', from: 615, to: 635, clock: '10:15–10:35', my_team_deaths: 1, enemy_deaths: 3, my_team_gold_lead_before: 400 },
    { ref: 'fight:2', from: 1826, to: 1848, clock: '30:26–30:48', my_team_deaths: 4, enemy_deaths: 1, my_team_gold_lead_before: -1200 },
  ],
  turning_fight: { ref: 'fight:2' },
};

const buildRecord = {
  my_big_items_in_order: [
    { item: 'blink', name: 'Blink Dagger', first_held: '14:12' },
    { item: 'black_king_bar', name: 'Black King Bar', first_held: '22:40' },
  ],
};

const momentPayload = {
  status: 'ok',
  t: 1826,
  clock: '30:26',
  from: 1814,
  to: 1832,
  me: 'axe',
  place: null,
  place_name: null,
  heroes: [{ hero: 'axe', side: 'me' }],
  frames: [{ t: 1826, at: [[0, 0, 1]] }],
  deaths: [],
  box: { x: -1000, y: -1000, size: 2000 },
  away: [],
  not_known: [],
  names: { axe: 'Axe' },
  icons: {},
};

let allowOverview = true;
let allowBuild = true;
let seq = 0;

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
};

beforeEach(() => {
  allowOverview = true;
  allowBuild = true;
  (window as any).matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('ref=overview')) {
      return allowOverview
        ? new Response(JSON.stringify({ status: 'ok', ref: 'overview', kind: 'overview', record: overviewRecord, names: {} }), { status: 200 })
        : new Response(JSON.stringify({ code: 'unknown_ref' }), { status: 404 });
    }
    if (u.includes('ref=build%3Aaxe')) {
      return allowBuild
        ? new Response(JSON.stringify({ status: 'ok', ref: 'build:axe', kind: 'build', record: buildRecord, names: { blink: '闪烁匕首', black_king_bar: '黑皇杖' } }), { status: 200 })
        : new Response(JSON.stringify({ code: 'unknown_ref' }), { status: 404 });
    }
    if (u.includes('/moment')) return new Response(JSON.stringify(momentPayload), { status: 200 });
    return new Response('{}', { status: 200 });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('WaitFacts (#363)', () => {
  it('renders the fight strip (with the turning fight marked) and key-item timings while waiting, and replays a clicked fight', async () => {
    seq += 1;
    const id = String(5000 + seq);
    render(<WaitFacts matchId={id} hero="axe" lang="zh" />);
    await flush();

    expect(screen.getByRole('heading', { name: '团战走势与你的关键成装' })).toBeTruthy();
    expect(document.querySelectorAll('.ag-strip-fight')).toHaveLength(2);
    expect(document.querySelector('.ag-strip-fight.is-turn text')?.textContent).toBe('▲ 30:26 转折');

    const items = Array.from(document.querySelectorAll('.ag-wait-items li')).map((li) => li.textContent);
    expect(items).toEqual(['14:12闪烁匕首', '22:40黑皇杖']);

    // Clicking a fight bar opens the map replay for that fight's start second, and tracks moment_played.
    const secondFight = screen.getByRole('button', { name: '重放这波团战 30:26–30:48, 4:1' });
    fireEvent.click(secondFight);
    await flush();
    expect(document.querySelector('.ag-replay')).toBeTruthy();
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((c) => String(c[0]).includes(`/api/agent/${id}/moment?hero=axe&lang=zh&t=1826`))).toBe(true);
    expect(calls.some((c) => String(c[0]).includes('/api/events'))).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '收起团战回放' }));
    expect(document.querySelector('.ag-replay')).toBeNull();
  });

  it('renders nothing when neither overview nor build evidence is available', async () => {
    allowOverview = false;
    allowBuild = false;
    seq += 1;
    render(<WaitFacts matchId={String(5000 + seq)} hero="axe" lang="en" />);
    await flush();
    expect(document.querySelector('.ag-wait-facts')).toBeNull();
  });
});
