// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MatchBoard } from './MatchBoard';
import type { CoachReport } from '../coach/types';

const item = (key: string, en: string, zh: string) => ({ key, en, zh, cost: 0, img: `https://cdn.example/${key}.png` });
const hero = (id: number, slug: string, en: string, zh: string) => ({ id, slug, en, zh, img: null, icon: null, roles: [] });
const player = (slot: number, radiant: boolean, h: ReturnType<typeof hero>, nw: number, items: ReturnType<typeof item>[] = []) => ({
  slot, radiant, hero: h, name: null, rank_tier: null, kda: [slot, 10 - slot, 5] as [number, number, number], last_hits: 100 + slot, denies: slot,
  gpm: 400 + slot, xpm: 500 + slot, net_worth: nw, hero_damage: 20000 + slot, tower_damage: 0, level: 20 + slot, items, benchmarks: null,
});

const report = {
  schema: 'x', engine: 'x',
  match: { id: 9091400302, duration: 2722, radiant_win: false, score: [34, 75], patch: '7.41', mode: { en: 'All Pick', zh: '全英雄选择' }, ranked: true, start_time: null, parsed: true, replay_available: true, turbo: false },
  players: [
    player(0, true, hero(29, 'tidehunter', 'Tidehunter', '潮汐猎人'), 18681, [item('blink', 'Blink Dagger', '闪烁匕首'), item('mage_slayer', 'Mage Slayer', '法师克星')]),
    player(1, true, hero(27, 'shadow_shaman', 'Shadow Shaman', '暗影萨满'), 10138),
    player(5, false, hero(70, 'ursa', 'Ursa', '熊战士'), 33918, [item('bfury', 'Battle Fury', '狂战斧')]),
    player(6, false, hero(101, 'skywrath_mage', 'Skywrath Mage', '天怒法师'), 24286),
  ],
  reviews: [], data_gaps: [],
  timeline: { radiant_gold_adv: [0, -148, 165, -360, -2000, -43787] },
  spikes: [{ slot: 0, items: [{ time: 966, item: item('mage_slayer', 'Mage Slayer', '法师克星') }, { time: 1771, item: item('blink', 'Blink Dagger', '闪烁匕首') }], aegis: [] }, null],
} as unknown as CoachReport;

afterEach(cleanup);

describe('MatchBoard', () => {
  it('both line-ups with level, K/D/A, last hits, net worth, GPM, damage and items; your side first and your row marked', () => {
    render(<MatchBoard report={report} hero="ursa" lang="en" />);
    const board = screen.getByRole('region', { name: 'Scoreboard' });
    expect(within(board).getByText('Dire victory')).toBeTruthy();
    expect(board.textContent).toContain('45:22');
    // The reader played Ursa: Dire comes first.
    const sides = [...board.querySelectorAll('.ag-side h3')].map((h) => h.textContent);
    expect(sides).toEqual(['Dire · your sidenet worth 58,204', 'Radiantnet worth 28,819']);
    const rows = board.querySelectorAll('li');
    expect(rows).toHaveLength(4);
    const ursa = rows[0] as HTMLElement;
    expect(ursa.classList.contains('is-me')).toBe(true);
    expect(ursa.textContent).toContain('Ursa');
    expect(ursa.textContent).toContain('you');
    expect(ursa.textContent).toContain('5 / 5 / 5');
    expect(ursa.textContent).toContain('105 / 5');
    expect(ursa.textContent).toContain('33.9k');
    expect(ursa.textContent).toContain('405');
    expect(within(ursa).getByRole('img', { name: 'Battle Fury' })).toBeTruthy();
    expect(board.querySelectorAll('li.is-me')).toHaveLength(1);
  });

  it('an item the replay saw finished carries its time; the gold lead says who led at the end', () => {
    render(<MatchBoard report={report} hero="tidehunter" lang="zh" />);
    const board = screen.getByRole('region', { name: '记分板' });
    const tide = board.querySelector('li.is-me') as HTMLElement;
    expect(tide.textContent).toContain('潮汐猎人');
    expect(within(tide).getByRole('img', { name: '闪烁匕首 · 成型 29:31' })).toBeTruthy();
    expect(within(tide).getByRole('img', { name: '法师克星 · 成型 16:06' })).toBeTruthy();
    expect(within(board).getByRole('img', { name: '每分钟经济差: 结束时 夜魇 +43,787' })).toBeTruthy();
    // Radiant (the reader's side) first.
    expect(board.querySelector('.ag-side')!.classList.contains('is-radiant')).toBe(true);
  });

  it('without OpenDota\'s gold record the board says so instead of drawing nothing', () => {
    render(<MatchBoard report={{ ...report, timeline: null } as CoachReport} hero="ursa" lang="en" />);
    const board = screen.getByRole('region', { name: 'Scoreboard' });
    expect(board.querySelector('.ag-gold')).toBeNull();
    expect(board.textContent).toContain('No minute-by-minute gold for this game');
    // The rest is there: final net worth, items.
    expect(board.textContent).toContain('33.9k');
  });

  it('without OpenDota\'s curve the replay\'s own net worth lead is drawn, and says where it is from', () => {
    render(<MatchBoard report={{ ...report, timeline: null } as CoachReport} hero="ursa" lang="zh" replayLead={[-8, 47, 464, 993, 35038]} />);
    const board = screen.getByRole('region', { name: '记分板' });
    expect(within(board).getByRole('img', { name: '每分钟净值差（来自录像）: 结束时 天辉 +35,038' })).toBeTruthy();
    // The same place, with gold earned summed from the replay's combat log: named for what it is.
    cleanup();
    render(<MatchBoard report={{ ...report, timeline: null } as CoachReport} hero="ursa" lang="zh" replayLead={[-8, 47, 464, 993, 35038]} replayLeadIs="gold" />);
    expect(screen.getByRole('img', { name: '每分钟经济差（来自录像）: 结束时 天辉 +35,038' })).toBeTruthy();
    expect(screen.queryByRole('img', { name: /净值差/ })).toBeNull();
    expect(board.querySelector('.ag-gold-none')).toBeNull();
    cleanup();
    // 46 minutes: ticks at 10, 20, 30, 40. The 40:00 label would sit under "Dire ahead": its line is drawn, its label is not.
    const long = Array.from({ length: 46 }, (_, m) => m * 100);
    const { container } = render(<MatchBoard report={{ ...report, timeline: null } as CoachReport} lang="en" replayLead={long} />);
    expect([...container.querySelectorAll('.ag-gold-axis i')].map((e) => e.textContent)).toEqual(['10:00', '20:00', '30:00']);
    expect(container.querySelectorAll('.ag-gold-tick')).toHaveLength(4);
    cleanup();
    // OpenDota's curve, when the record has it, is the one drawn.
    render(<MatchBoard report={report} hero="ursa" lang="en" replayLead={[1, 2, 3, 4]} />);
    expect(screen.getByRole('img', { name: 'Gold lead by minute: at the end Dire +43,787' })).toBeTruthy();
  });

  it('a scoreboard with little in it still shows who played, and no made-up numbers', () => {
    const bare = { match: { patch: '7.42' }, players: [{ slot: 0, radiant: true, kda: [4, 12, 14], hero: { id: 2, en: 'Axe', zh: '斧王', slug: 'axe', img: null } }] } as unknown as CoachReport;
    render(<MatchBoard report={bare} lang="en" />);
    const board = screen.getByRole('region', { name: 'Scoreboard' });
    expect(board.querySelectorAll('li')).toHaveLength(1);
    expect(board.textContent).toContain('Axe');
    expect(board.textContent).toContain('4 / 12 / 14');
    expect(board.querySelector('.ag-gold')).toBeNull();
    expect(board.querySelector('.ag-board-head')).toBeNull();
    expect(board.textContent).not.toContain('NaN');
    expect(board.textContent).not.toContain('undefined');
  });
});
