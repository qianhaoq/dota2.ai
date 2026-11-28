// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { CoachReport } from '../coach/types';
import type { AgentHero } from './api';
import { MatchHeroBanner } from './MatchHeroBanner';

const ROSTER: AgentHero[] = [
  { hero: 'phantom_assassin', team: 'radiant', hero_id: 44, en: 'Phantom Assassin', zh: '幻影刺客' },
  { hero: 'necrolyte', team: 'radiant', hero_id: 36, en: 'Necrophos', zh: '瘟疫法师' },
  { hero: 'beastmaster', team: 'dire', hero_id: 38, en: 'Beastmaster', zh: '兽王' },
  { hero: 'sven', team: 'dire', hero_id: 18, en: 'Sven', zh: '斯温' },
];

const BOARD = {
  match: {
    radiant_win: true,
    score: [39, 35],
    duration: 2551,
    patch: '7.41b',
    mode: { en: 'All Pick', zh: '全阵营选择' },
  },
  players: [
    {
      slot: 0,
      radiant: true,
      hero: { id: 44, slug: 'phantom_assassin', en: 'Phantom Assassin', zh: '幻影刺客', img: 'https://cdn.example/pa.png' },
      level: 27,
      kda: [14, 5, 11],
      last_hits: 310,
      denies: 14,
      net_worth: 26400,
      gpm: 620,
      xpm: 710,
      hero_damage: 34200,
      items: [],
    },
    {
      slot: 5,
      radiant: false,
      hero: { id: 38, slug: 'beastmaster', en: 'Beastmaster', zh: '兽王', img: 'https://cdn.example/bm.png' },
      level: 24,
      kda: [9, 11, 18],
      last_hits: 260,
      denies: 9,
      net_worth: 16953,
      gpm: 450,
      xpm: 580,
      hero_damage: 21400,
      items: [
        { key: 'ultimate_scepter', en: "Aghanim's Scepter", zh: '阿哈利姆神杖', img: 'https://cdn.example/aghs.png' },
        { key: 'helm_of_the_overlord', en: 'Helm of the Overlord', zh: '统御头盔', img: 'https://cdn.example/helm.png' },
      ],
    },
  ],
  spikes: [
    {
      slot: 5,
      items: [
        { time: 1008, item: { key: 'ultimate_scepter', en: "Aghanim's Scepter", zh: '阿哈利姆神杖' } },
      ],
    },
  ],
} as unknown as CoachReport;

afterEach(() => {
  cleanup();
});

describe('MatchHeroBanner', () => {
  it('renders broadcast telemetry, personal HUD stats, 6-slot inventory with completion clock, and 5v5 quick-switch roster', () => {
    const onPickHero = vi.fn();
    render(
      <MatchHeroBanner
        matchId="9100904020"
        lang="zh"
        hero={ROSTER[2]}
        roster={ROSTER}
        board={BOARD}
        onPickHero={onPickHero}
      />,
    );

    const banner = document.querySelector('.ag-head.ag-banner')!;
    expect(banner.classList.contains('is-radiant-win')).toBe(true);
    expect(banner.textContent).toContain('比赛 9100904020 · 7.41b');
    expect(banner.textContent).toContain('天辉胜利');
    expect(banner.textContent).toContain('42:31');
    expect(banner.textContent).toContain('全阵营选择');
    expect(banner.textContent).toContain('兽王');
    expect(banner.textContent).toContain('失利');
    expect(banner.textContent).toContain('17.0k');
    expect(banner.textContent).toContain('450 / 580');

    // 6-slot inventory grid with completion timestamp for Aghanim's Scepter (16:48) and 4 empty slots.
    const inv = screen.getByLabelText('终局出装');
    expect(inv.querySelectorAll('.ag-inv-slot')).toHaveLength(6);
    expect(inv.querySelectorAll('.ag-inv-slot.is-empty')).toHaveLength(4);
    expect(inv.querySelector('.ag-inv-time')!.textContent).toBe('16:48');

    // Compact quick-switch roster lets the reader jump to another hero or click "换英雄".
    const nav = screen.getByRole('navigation', { name: '切换英雄复盘视角' });
    const paBtn = within(nav).getByRole('button', { name: '切换查看 幻影刺客' });
    fireEvent.click(paBtn);
    expect(onPickHero).toHaveBeenCalledWith('phantom_assassin');

    // Clicking the currently active hero is a no-op; clicking "换英雄" clears hero selection.
    const bmBtn = within(nav).getByRole('button', { name: '切换查看 兽王' });
    expect(bmBtn.getAttribute('aria-current')).toBe('page');
    fireEvent.click(bmBtn);
    expect(onPickHero).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '换英雄' }));
    expect(onPickHero).toHaveBeenLastCalledWith(null);
  });

  it('omits hero HUD and quick-switch bar cleanly when no hero is selected yet', () => {
    render(
      <MatchHeroBanner
        matchId="9100904020"
        lang="en"
        hero={null}
        roster={ROSTER}
        board={BOARD}
        onPickHero={() => {}}
      />,
    );
    expect(document.querySelector('.ag-banner-hero-row')).toBeNull();
    expect(document.querySelector('.ag-banner-roster')).toBeNull();
    expect(document.querySelector('.ag-banner')!.textContent).toContain('Radiant Victory');
  });
});
