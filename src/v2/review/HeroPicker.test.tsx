// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import HeroPicker from './HeroPicker';
import type { MatchPlayerFact } from '../../types/matchReview';

const players = [
  { heroId: 104, isRadiant: true, nameZh: '军团指挥官', nameEn: 'Legion Commander', kills: 3, deaths: 9, assists: 5 },
  { heroId: 41, isRadiant: true, nameZh: '虚空假面', nameEn: 'Faceless Void', kills: 13, deaths: 14, assists: 12 },
  { heroId: 69, isRadiant: false, nameZh: '末日使者', nameEn: 'Doom', kills: 9, deaths: 5, assists: 9 },
] as unknown as MatchPlayerFact[];

describe('HeroPicker — long names at 390px', () => {
  afterEach(() => cleanup());

  it('renders long names in full inside the tile (visual clamp only)', () => {
    render(<HeroPicker players={players} winner="dire" selectedHeroId={null} onPick={() => {}} />);
    expect(screen.getByText('Legion Commander')).toBeTruthy();
    expect(screen.getByText('Faceless Void')).toBeTruthy();
  });

  it('exposes the full name via aria-label and title', () => {
    render(<HeroPicker players={players} winner="dire" selectedHeroId={null} onPick={() => {}} />);
    const legion = screen.getByRole('button', { name: 'Legion Commander, 3/9/5' });
    expect(legion.getAttribute('title')).toBe('Legion Commander');
  });

  it('clamps names to 2 wrapped lines and lets the tile shrink below its content', () => {
    render(<HeroPicker players={players} winner="dire" selectedHeroId={null} onPick={() => {}} />);
    const name = screen.getByText('Legion Commander');
    expect(name.className).toContain('line-clamp-2');
    // words must never split mid-word ("Windrange|r") — explicit normal
    // overrides any inherited break-all/word-wrap; a single word too long
    // for the tile hyphenates instead of clipping (hyphens need a lang to
    // pick the hyphenation dictionary), title/aria-label keep the full name.
    expect(name.className).toContain('[word-break:normal]');
    expect(name.className).toContain('[overflow-wrap:normal]');
    expect(name.className).toContain('[hyphens:auto]');
    expect(name.className).toContain('[-webkit-hyphens:auto]');
    expect(name.className).toContain('overflow-hidden');
    expect(name.getAttribute('lang')).toBe('en');
    // min-w-0 on the tile (button) is what stops the 5-col grid from
    // overflowing at 390px — long names must wrap, not push the tile wide.
    expect(name.closest('button')?.className).toContain('min-w-0');
  });

  it('still picks the hero on tap', () => {
    const onPick = vi.fn();
    render(<HeroPicker players={players} winner="dire" selectedHeroId={null} onPick={onPick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Doom, 9/5/9' }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ heroId: 69 }));
  });
});
