// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EvidenceCard } from './EvidenceCard';
import * as api from './api';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('EvidenceCard auto-triggered cast & unknown proximity rendering', () => {
  it('renders unknown proximity cleanly when auto-trigger positions are missing (both null and partial null)', async () => {
    const spy = vi.spyOn(api, 'fetchEvidence');
    spy.mockResolvedValueOnce({
      status: 'ok',
      ref: 'cast:abaddon:borrowed_time:1',
      kind: 'cast',
      names: { abaddon_borrowed_time: '回光返照' },
      record: {
        clock: '10:00',
        trigger: 'auto',
        target: null,
        target_hp: null,
        target_spell_immune: null,
        target_stunned_seconds: null,
        me: null,
        allies_within_1300: null,
        enemies_within_1300: null,
        deaths_within_12s: [],
      },
    });
    spy.mockResolvedValueOnce({
      status: 'ok',
      ref: 'cast:abaddon:borrowed_time:2',
      kind: 'cast',
      names: { sven: '流浪剑客', abaddon_borrowed_time: '回光返照' },
      record: {
        clock: '15:00',
        trigger: 'auto',
        target: null,
        target_hp: null,
        target_spell_immune: null,
        target_stunned_seconds: null,
        me: { hp: 380, max_hp: 1200 },
        allies_within_1300: ['sven'],
        enemies_within_1300: null,
        deaths_within_12s: [],
      },
    });

    render(
      <ul>
        <EvidenceCard
          matchId="9106357143"
          hero="abaddon"
          lang="zh"
          item={{ clock: '10:00', fact: '回光返照自动触发', refs: ['cast:abaddon:borrowed_time:1', 'cast:abaddon:borrowed_time:2'] }}
          onAsk={() => {}}
        />
      </ul>,
    );

    fireEvent.click(screen.getByRole('button', { name: '看原始记录' }));
    await waitFor(() => expect(screen.getAllByText(/自动触发/).length).toBeGreaterThanOrEqual(2));
    expect(screen.getByText('未知')).toBeTruthy();
    expect(screen.getByText('流浪剑客')).toBeTruthy();
    expect(screen.getByText('敌方 · 未知')).toBeTruthy();
  });
});
