// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MAP_BOUNDS } from '../../lib/agent/mapBounds.js';
import { clearAgentCaches, type HeroTrack, type Moment } from './api';
import { HeroTrackMap, type HeroTrackMapHandle } from './HeroTrackMap';

let seq = 0;
const freshMatch = () => String(9200000000 + (seq += 1));

const makeTrack = (over: Partial<HeroTrack> = {}): HeroTrack => ({
  status: 'ok',
  hero: 'beastmaster',
  hero_name: 'Beastmaster',
  side: 'me',
  from: 0,
  to: 2400,
  trace_start: 0,
  duration: 2400,
  heroes: [
    { hero: 'beastmaster', hero_name: 'Beastmaster', side: 'me' },
    { hero: 'sven', hero_name: 'Sven', side: 'ally' },
    { hero: 'phantom_assassin', hero_name: 'Phantom Assassin', side: 'enemy' },
  ],
  segments: [
    { from: 0, to: 120, points: [[0, 6000, 6000], [60, 4200, 3800], [120, 2000, 1200]] },
    { from: 130, to: 260, points: [[130, -1500, -1200], [200, -400, -200], [260, 300, 200]] },
  ],
  breaks: [
    { from_t: 120, to_t: 130, from_x: 2000, from_y: 1200, to_x: -1500, to_y: -1200, reason: 'teleport' },
  ],
  heat: {
    grid_size: 24,
    bounds: MAP_BOUNDS,
    max_seconds: 85,
    cells: [
      { gx: 12, gy: 12, seconds: 85 },
      { gx: 18, gy: 18, seconds: 32 },
    ],
  },
  deaths: [
    { t: 507.2, clock: '8:27', x: -1200, y: -2400, killer: 'phantom_assassin', place: 'radiant_bot_lane', place_name: 'Radiant bottom lane' },
  ],
  stats: {
    total_seconds: 2401,
    alive_sampled_seconds: 2100,
    dead_seconds: 301,
    missing_seconds: 0,
  },
  names: { beastmaster: 'Beastmaster', sven: 'Sven', phantom_assassin: 'Phantom Assassin' },
  icons: { beastmaster: 'beastmaster', sven: 'sven', phantom_assassin: 'phantom_assassin' },
  gaps: [],
  ...over,
});

const makeMoment = (t = 507): Moment => ({
  status: 'ok',
  t,
  clock: '8:27',
  from: t - 12,
  to: t + 6,
  me: 'beastmaster',
  heroes: [{ hero: 'beastmaster', side: 'me' }, { hero: 'phantom_assassin', side: 'enemy' }],
  frames: [{ t, at: [[-1200, -2400, 1], [-1000, -2200, 1]] }],
  deaths: [{ t: 507.2, hero: 'beastmaster', killer: 'phantom_assassin' }],
  box: { x: -3000, y: -4000, size: 4000 },
  away: [],
  not_known: [],
  place: 'radiant_bot_lane',
  place_name: 'Radiant bottom lane',
  names: { beastmaster: 'Beastmaster', phantom_assassin: 'Phantom Assassin' },
  icons: { beastmaster: 'beastmaster', phantom_assassin: 'phantom_assassin' },
});

function stubFetch(handler: (url: string) => unknown) {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const body = handler(url);
    if (!body) return new Response(JSON.stringify({ code: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return urls;
}

afterEach(() => {
  cleanup();
  clearAgentCaches();
  vi.unstubAllGlobals();
});

describe('HeroTrackMap', () => {
  it('renders Path mode by default and toggles cleanly to Activity Heatmap mode', async () => {
    const id = freshMatch();
    stubFetch((u) => (u.includes('/track') ? makeTrack() : null));
    render(<HeroTrackMap matchId={id} hero="beastmaster" lang="en" />);

    expect(await screen.findByRole('group', { name: 'Beastmaster Path from 0:00 to 40:00' })).toBeTruthy();
    expect(document.querySelectorAll('.ag-track-line').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.ag-track-jump')).toHaveLength(1);
    expect(document.querySelectorAll('.ag-track-cell')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Path' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Heatmap' }));
    expect(screen.getByRole('button', { name: 'Heatmap' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('group', { name: 'Beastmaster Heatmap from 0:00 to 40:00' })).toBeTruthy();
    expect(document.querySelectorAll('.ag-track-cell')).toHaveLength(2);
    expect(document.querySelectorAll('.ag-track-line')).toHaveLength(0);
    // Death marker remains visible across both modes.
    expect(document.querySelectorAll('.ag-track-death')).toHaveLength(1);
  });

  it('switches heroes and time windows (presets and custom minute range) with accurate API queries', async () => {
    const id = freshMatch();
    const urls = stubFetch((u) => {
      const parsed = new URL(u, 'http://localhost');
      const h = parsed.searchParams.get('hero') ?? 'beastmaster';
      const from = parsed.searchParams.has('from') ? Number(parsed.searchParams.get('from')) : 0;
      const to = parsed.searchParams.has('to') ? Number(parsed.searchParams.get('to')) : 2400;
      return makeTrack({
        hero: h,
        hero_name: h === 'phantom_assassin' ? 'Phantom Assassin' : 'Beastmaster',
        side: h === 'phantom_assassin' ? 'enemy' : 'me',
        from,
        to,
      });
    });

    render(<HeroTrackMap matchId={id} hero="beastmaster" lang="en" />);
    await screen.findByRole('group', { name: /Beastmaster Path/ });

    // Switch to 10–20m preset.
    fireEvent.click(screen.getByRole('button', { name: '10–20m' }));
    await screen.findByRole('group', { name: 'Beastmaster Path from 10:00 to 20:00' });
    expect(urls.some((u) => u.includes('hero=beastmaster') && u.includes('from=600') && u.includes('to=1200'))).toBe(true);

    // Switch hero to Phantom Assassin (keeps the active 10–20m stretch and passes viewer=beastmaster).
    fireEvent.change(screen.getByLabelText('Hero'), { target: { value: 'phantom_assassin' } });
    await screen.findByRole('group', { name: 'Phantom Assassin Path from 10:00 to 20:00' });
    expect(urls.some((u) => u.includes('hero=phantom_assassin') && u.includes('viewer=beastmaster') && u.includes('from=600') && u.includes('to=1200'))).toBe(true);

    // Custom minute range validation & apply.
    fireEvent.change(screen.getByLabelText('From (min)'), { target: { value: '25' } });
    fireEvent.change(screen.getByLabelText('To (min)'), { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('alert').textContent).toContain('Start minute must be before or equal to end minute.');

    fireEvent.change(screen.getByLabelText('From (min)'), { target: { value: '15' } });
    fireEvent.change(screen.getByLabelText('To (min)'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await screen.findByRole('group', { name: 'Phantom Assassin Path from 15:00 to 25:00' });
    expect(urls.some((u) => u.includes('from=900') && u.includes('to=1500'))).toBe(true);
  });

  it('discloses missing position samples honestly and leaves missing gaps blank (never connecting across them)', async () => {
    const id = freshMatch();
    stubFetch((u) => {
      if (!u.includes('/track')) return null;
      return makeTrack({
        breaks: [
          { from_t: 120, to_t: 130, from_x: 2000, from_y: 1200, to_x: -1500, to_y: -1200, reason: 'missing' },
        ],
        stats: { total_seconds: 601, alive_sampled_seconds: 560, dead_seconds: 0, missing_seconds: 41 },
      });
    });

    const { rerender } = render(<HeroTrackMap matchId={id} hero="beastmaster" lang="en" />);
    const noteEn = await screen.findByRole('note');
    expect(noteEn.textContent).toContain('41 s of position samples missing in this stretch');
    // Missing breaks render hollow endpoint markers and NEVER a connecting jump line.
    expect(document.querySelectorAll('.ag-track-gap-mark')).toHaveLength(1);
    expect(document.querySelectorAll('.ag-track-jump')).toHaveLength(0);

    // Chinese bilingual rendering.
    rerender(<HeroTrackMap matchId={id} hero="beastmaster" lang="zh" />);
    const noteZh = await screen.findByRole('note');
    expect(noteZh.textContent).toContain('该时段有 41 秒缺少位置采样，断档处已留空');
    expect(screen.getByRole('button', { name: '移动路径' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '活动热区' })).toBeTruthy();
  });

  it('jumps directly into MomentReplay when clicking a death marker on the map or in the death list', async () => {
    const id = freshMatch();
    const onPlayMoment = vi.fn();
    const urls = stubFetch((u) => {
      if (u.includes('/track')) return makeTrack();
      if (u.includes('/moment')) return makeMoment(507);
      return null;
    });

    render(<HeroTrackMap matchId={id} hero="beastmaster" lang="en" onPlayMoment={onPlayMoment} />);
    const svgDeath = await screen.findByRole('button', { name: 'Death at 8:27 — replay on map' });
    fireEvent.click(svgDeath);

    expect(onPlayMoment).toHaveBeenCalledWith(507, 'beastmaster');
    await waitFor(() => expect(urls.some((u) => u.includes(`/api/agent/${id}/moment?hero=beastmaster&lang=en&t=507`))).toBe(true));
    expect(await screen.findByText('Moment replay · 8:27')).toBeTruthy();
    expect(document.querySelector('.ag-replay')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Close replay' }));
    expect(document.querySelector('.ag-replay')).toBeNull();
  });

  it('loads on demand when collapsible is enabled (zero fetches before opening)', async () => {
    const id = freshMatch();
    const urls = stubFetch((u) => (u.includes('/track') ? makeTrack({ hero_name: '兽王' }) : null));
    render(<HeroTrackMap matchId={id} hero="beastmaster" lang="zh" collapsible />);

    expect(urls).toHaveLength(0);
    expect(screen.getByText('移动路径与活动热区')).toBeTruthy();

    fireEvent.click(screen.getByText('移动路径与活动热区'));
    await screen.findByRole('group', { name: '兽王 0:00 到 40:00 的移动路径' });
    expect(urls.filter((u) => u.includes('/track'))).toHaveLength(1);
  });

  it('clears stale track data and death buttons while switching heroes and keeps them cleared on request failure', async () => {
    const id = freshMatch();
    const onPlayMoment = vi.fn();
    let rejectPending!: (err: Error) => void;
    let resolveSven!: (res: Response) => void;

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/moment')) {
        return Promise.resolve(new Response(JSON.stringify(makeMoment(507)), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      if (url.includes('hero=beastmaster')) {
        return Promise.resolve(new Response(JSON.stringify(makeTrack()), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      if (url.includes('hero=phantom_assassin')) {
        return new Promise<Response>((_resolve, reject) => { rejectPending = reject; });
      }
      if (url.includes('hero=sven')) {
        return new Promise<Response>((resolve) => { resolveSven = resolve; });
      }
      return Promise.resolve(new Response(JSON.stringify({ code: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } }));
    }));

    render(<HeroTrackMap matchId={id} hero="beastmaster" lang="en" onPlayMoment={onPlayMoment} />);

    // Open Beastmaster's death replay first.
    const bmDeath = await screen.findByRole('button', { name: 'Death at 8:27 — replay on map' });
    fireEvent.click(bmDeath);
    expect(onPlayMoment).toHaveBeenCalledWith(507, 'beastmaster');
    expect(await screen.findByText('Moment replay · 8:27')).toBeTruthy();

    // Switch hero to Phantom Assassin while its request is still pending:
    // Beastmaster's map, death buttons, and open MomentReplay must clear immediately.
    fireEvent.change(screen.getByLabelText('Hero'), { target: { value: 'phantom_assassin' } });
    expect(screen.getByRole('status').textContent).toContain('Loading movement data');
    expect(screen.queryByRole('button', { name: 'Death at 8:27 — replay on map' })).toBeNull();
    expect(document.querySelector('.ag-track-death')).toBeNull();
    expect(document.querySelector('.ag-track-death-btn')).toBeNull();
    expect(document.querySelector('.ag-replay')).toBeNull();

    // Fail the Phantom Assassin request: stale Beastmaster track must stay cleared and error must show.
    rejectPending(new Error('network error'));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load movement data');
    expect(document.querySelector('.ag-track-death')).toBeNull();
    expect(document.querySelector('.ag-track-death-btn')).toBeNull();
    expect(onPlayMoment).toHaveBeenCalledTimes(1);

    // All heroes remain selectable in the dropdown even after a failed fetch, and switching to Sven loads cleanly.
    const select = screen.getByLabelText('Hero') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['beastmaster', 'sven', 'phantom_assassin']);
    fireEvent.change(select, { target: { value: 'sven' } });
    expect(screen.getByRole('status').textContent).toContain('Loading movement data');
    resolveSven(new Response(JSON.stringify(makeTrack({
      hero: 'sven',
      hero_name: 'Sven',
      side: 'ally',
      deaths: [{ t: 902.1, clock: '15:02', x: 100, y: 100, killer: 'phantom_assassin', place: 'river_mid', place_name: 'river mid' }],
    })), { status: 200, headers: { 'content-type': 'application/json' } }));

    const svenDeath = await screen.findByRole('button', { name: 'Death at 15:02 — replay on map' });
    fireEvent.click(svenDeath);
    expect(onPlayMoment).toHaveBeenLastCalledWith(902, 'sven');
  });

  it('supports 5v5 quick-avatar switching and imperative focusWindow(preset, mode) opening', async () => {
    const id = freshMatch();
    const urls = stubFetch((u) => {
      const parsed = new URL(u, 'http://localhost');
      const h = parsed.searchParams.get('hero') ?? 'beastmaster';
      const from = parsed.searchParams.has('from') ? Number(parsed.searchParams.get('from')) : 0;
      const to = parsed.searchParams.has('to') ? Number(parsed.searchParams.get('to')) : 2400;
      return makeTrack({ hero: h, hero_name: h === 'sven' ? 'Sven' : 'Beastmaster', side: h === 'sven' ? 'ally' : 'me', from, to });
    });

    const ref = React.createRef<HeroTrackMapHandle>();
    render(<HeroTrackMap ref={ref} matchId={id} hero="beastmaster" lang="en" collapsible />);
    expect(urls).toHaveLength(0);

    // Imperatively focus 0-10m heatmap window (used by walkthrough chapter map actions).
    React.act(() => {
      ref.current?.focusWindow('0-10', 'heat');
    });
    expect(await screen.findByRole('group', { name: 'Beastmaster Heatmap from 0:00 to 10:00' })).toBeTruthy();
    expect(urls.some((u) => u.includes('from=0') && u.includes('to=600'))).toBe(true);

    // Quick-switch avatar bar switches directly to Sven without using the dropdown.
    const avatarGroup = screen.getByRole('group', { name: 'Quick switch hero' });
    fireEvent.click(avatarGroup.querySelector('button[title="Sven (Ally)"]')!);
    expect(await screen.findByRole('group', { name: 'Sven Heatmap from 0:00 to 10:00' })).toBeTruthy();
  });
});
