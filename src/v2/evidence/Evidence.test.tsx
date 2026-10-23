// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { buildReview } from '../../../packages/review-engine/src/index.js';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Review } from '../review/types';
import EvidenceBody from './EvidenceBody';
import EvidenceSheet from './EvidenceSheet';
import EvidencePanel from './EvidencePanel';
import GoldXpChart from './GoldXpChart';
import InsightCard from '../review/InsightCard';

const raw = JSON.parse(readFileSync('src/fixtures/match9035042364.parsed.json', 'utf8'));
const review = buildReview(raw, { heroId: 14, lang: 'en', fetchedAt: '2026-10-17T00:00:00Z' }) as unknown as Review;

function wrap(content: React.ReactNode, lang = 'en') {
  window.localStorage.clear();
  return render(<MemoryRouter initialEntries={[`/m/9035042364?hero=pudge&lang=${lang}`]}><I18nProvider>{content}</I18nProvider></MemoryRouter>);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('EvidenceBody claim 0 (turning point)', () => {
  it('shows window KV and chart labels strictly from engine displays', () => {
    wrap(<EvidenceBody review={review} claim={0} onPage={() => {}}/>);
    const body = screen.getByTestId('evidence-body');
    // Window deltas + low point come from buildReview facts (see labels.test for the fixture).
    expect(within(body).getAllByText('−6,983').length).toBeGreaterThan(0);
    expect(within(body).getAllByText('−9,630').length).toBeGreaterThan(0);
    expect(within(body).getAllByText('−28,965 · 46:00').length).toBeGreaterThan(0);
    expect(within(body).getAllByText('40:00–45:00').length).toBeGreaterThan(0);
    expect(within(body).getByText('−19,971 → −26,954')).toBeTruthy();
    // Moments: Roshan + big structures + gold-low note.
    expect(within(body).getByText('Dire took Roshan')).toBeTruthy();
    expect(within(body).getByText('Radiant mid T3 tower destroyed')).toBeTruthy();
    expect(within(body).getByText('Gold gap at its lowest: −28,965')).toBeTruthy();
  });

  it('segmented control switches the rendered series', () => {
    wrap(<EvidenceBody review={review} claim={0} onPage={() => {}}/>);
    const chart = () => screen.getByTestId('gold-xp-chart');
    expect(chart().getAttribute('data-mode')).toBe('both');
    expect(chart().querySelectorAll('[data-series="gold"]').length).toBe(1);
    expect(chart().querySelectorAll('[data-series="xp"]').length).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'XP' }));
    expect(chart().getAttribute('data-mode')).toBe('xp');
    expect(chart().querySelectorAll('[data-series="gold"]').length).toBe(0);
    // XP-only mode labels the XP peak from its fact display.
    expect(within(chart()).getAllByText('21,945').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Gold' }));
    expect(chart().querySelectorAll('[data-series="xp"]').length).toBe(0);
    expect(screen.getByRole('button', { name: 'Gold' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('EvidenceBody claim 1 (fix this)', () => {
  it('renders death strip, killer bars from displays, and GapBoxes for missing facts', () => {
    wrap(<EvidenceBody review={review} claim={1} onPage={() => {}}/>);
    const body = screen.getByTestId('evidence-body');
    expect(within(body).getByText('Your 19 deaths over time')).toBeTruthy();
    expect(within(body).getByTestId('death-strip')).toBeTruthy();
    const bars = within(body).getByTestId('killer-bars');
    expect(within(bars).getByText('Wraith King')).toBeTruthy();
    expect(within(bars).getByText('8')).toBeTruthy();
    expect(within(bars).getByText('5')).toBeTruthy();
    expect(within(bars).getByText('2')).toBeTruthy();
    // gold_fed / time_dead are registered gaps in this fixture → GapBox, never invented numbers.
    const gaps = within(body).getAllByTestId('gap-box');
    expect(gaps.length).toBe(3);
    expect(within(body).getByText('Gold fed: not enough data')).toBeTruthy();
    expect(within(body).getByText('Time dead: not enough data')).toBeTruthy();
    expect(within(body).getByText('Not enough data for death locations')).toBeTruthy();
    expect(body.textContent).not.toContain('10,253');
    expect(body.textContent).not.toContain('12:56');
  });

  it('renders a KV (not a gap) when gold_fed / time_dead facts exist', () => {
    const withFacts: Review = {
      ...review,
      facts: {
        ...review.facts,
        gold_fed: { id: 'gold_fed', display: { en: '10,253', zh: '10,253' }, citation: 's1', source_path: 'deaths' },
        time_dead: { id: 'time_dead', display: { en: '12:56', zh: '12:56' }, citation: 's1', source_path: 'deaths' },
      },
      data_gaps: review.data_gaps.filter(g => g.topic !== 'gold_fed' && g.topic !== 'time_dead'),
    };
    wrap(<EvidenceBody review={withFacts} claim={1} onPage={() => {}}/>);
    const body = screen.getByTestId('evidence-body');
    expect(within(body).getByText('10,253')).toBeTruthy();
    expect(within(body).getByText('12:56')).toBeTruthy();
    expect(within(body).getAllByTestId('gap-box').length).toBe(1); // only death_locations remains
  });
});

describe('EvidenceBody claim 2 (next game)', () => {
  it('shows why chips, enemy lineup, item timings and the build gap', () => {
    wrap(<EvidenceBody review={review} claim={2} onPage={() => {}}/>);
    const body = screen.getByTestId('evidence-body');
    expect(within(body).getByText('Why this advice')).toBeTruthy();
    // Enemy lineup = the five dire heroes.
    expect(within(body).getByText('Enemy lineup')).toBeTruthy();
    expect(within(body).getByText('Wraith King')).toBeTruthy();
    expect(within(body).queryByText('Pudge')).toBeNull();
    const items = within(body).getByTestId('items-grid');
    expect(within(items).getByText('Blink Dagger')).toBeTruthy();
    expect(within(items).getByText('21:00')).toBeTruthy();
    expect(items.textContent).not.toMatch(/ward/i);
    expect(within(body).getByText('Build vs this lineup: not enough data')).toBeTruthy();
  });
});

describe('EvidenceBody shared sections', () => {
  it('pager navigates and disables at the ends', () => {
    const onPage = vi.fn();
    wrap(<EvidenceBody review={review} claim={0} onPage={onPage}/>);
    const pager = screen.getByTestId('evidence-pager');
    expect(pager.textContent).toContain('1/3');
    expect(within(pager).getByRole('button', { name: 'Previous insight' })).toHaveProperty('disabled', true);
    fireEvent.click(within(pager).getByRole('button', { name: 'Next insight' }));
    expect(onPage).toHaveBeenCalledWith(1);
  });

  it('lists sources with badges and the OpenDota citation', () => {
    wrap(<EvidenceBody review={review} claim={0} onPage={() => {}}/>);
    const sources = screen.getByTestId('evidence-sources');
    expect(within(sources).getByText('opendota · radiant_gold_adv')).toBeTruthy();
    expect(within(sources).getByText('Match 9035042364')).toBeTruthy();
    expect(within(sources).getByText('Parsed ✓')).toBeTruthy();
    expect(within(sources).getByRole('link', { name: 'OpenDota ↗' })).toBeTruthy();
  });

  it('feedback buttons collapse into a thanks line after a successful persist', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }))));
    wrap(<EvidenceBody review={review} claim={0} onPage={() => {}}/>);
    fireEvent.click(screen.getByRole('button', { name: /Yes/ }));
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Thanks');
    expect(fetch).toHaveBeenCalledWith('/api/feedback', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      kind: 'evidence_claim_vote',
      matchId: review.match.id,
      hero: review.player?.hero,
      insightId: review.insights[0]?.id,
    });
    expect(body.message).toContain(`match=${review.match.id}`);
    expect(body.message).toContain(`hero=${review.player?.hero}`);
  });

  it('keeps feedback buttons and shows an error when persist fails', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: false }), { status: 500, headers: { 'Content-Type': 'application/json' } }))));
    wrap(<EvidenceBody review={review} claim={0} onPage={() => {}}/>);
    fireEvent.click(screen.getByRole('button', { name: /Yes/ }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Yes/ })).toBeTruthy();
  });

  it('localizes to zh', () => {
    wrap(<EvidenceBody review={review} claim={1} onPage={() => {}}/>, 'zh');
    const body = screen.getByTestId('evidence-body');
    expect(within(body).getByText('你的 19 次死亡时间线')).toBeTruthy();
    expect(within(body).getByText('谁击杀了你')).toBeTruthy();
    expect(within(body).getByText('死亡位置：数据不足')).toBeTruthy();
    expect(within(body).getByText('冥魂大帝')).toBeTruthy();
  });

  it('localizes item names in the Chinese evidence view', () => {
    wrap(<EvidenceBody review={review} claim={2} onPage={() => {}}/>, 'zh');
    const items = within(screen.getByTestId('evidence-body')).getByTestId('items-grid');
    expect(within(items).getByText('闪烁匕首')).toBeTruthy();
    expect(within(items).getByText('黑皇杖')).toBeTruthy();
    expect(within(items).queryByText('Black king bar')).toBeNull();
  });
});


describe('GoldXpChart domain', () => {
  it('keeps a nonzero vertical domain for a single finite / all-equal series', () => {
    const flat = {
      ...review,
      series: {
        radiant_gold_adv: [0, null, 0],
        radiant_xp_adv: [0, null, 0],
        perspective: 'radiant',
      },
      facts: {},
    } as Review;
    wrap(<GoldXpChart review={flat} mode="gold"/>);
    const chart = screen.getByTestId('gold-xp-chart');
    const path = chart.querySelector('[data-series="gold"]');
    expect(path).toBeTruthy();
    expect(path!.getAttribute('d') || '').not.toMatch(/NaN/);
    expect(path!.getAttribute('d') || '').toMatch(/M/);
  });
});
describe('InsightCard Evidence button', () => {
  it('is disabled without a handler and reports (0-based index, trigger) on click', () => {
    const insight = review.insights[0];
    wrap(<InsightCard insight={insight} index={1} review={review} streaming={false}/>);
    expect((screen.getByRole('button', { name: 'Evidence' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    const onEvidence = vi.fn();
    wrap(<InsightCard insight={insight} index={1} review={review} streaming={false} onEvidence={onEvidence}/>);
    const button = screen.getByRole('button', { name: 'Evidence' });
    fireEvent.click(button);
    expect(onEvidence).toHaveBeenCalledWith(0, button);
  });
});

describe('EvidenceSheet', () => {
  // jsdom lacks PointerEvent; a MouseEvent with a pointer* type carries clientY.
  const pt = (target: Element, type: 'pointerdown' | 'pointermove' | 'pointerup', clientY: number) =>
    fireEvent(target, new MouseEvent(type, { bubbles: true, clientY }));
  const open = async (onClose = vi.fn()) => {
    const utils = wrap(<EvidenceSheet onClose={onClose}><EvidenceBody review={review} claim={0} onPage={() => {}} onClose={onClose}/></EvidenceSheet>);
    // Let the enter-animation requestAnimationFrame + focus effect run.
    await act(async () => { vi.advanceTimersByTime(50); });
    return { ...utils, onClose };
  };

  it('opens as a modal dialog, snaps at 55% and focuses the container', async () => {
    await open();
    const dialog = screen.getByRole('dialog', { name: 'Evidence' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.style.transform).toContain('translateY(40.');
    expect(document.activeElement).toBe(dialog);
  });

  it('toggles 55% ↔ 92% on handle tap and closes via ✕ / Esc / scrim', async () => {
    const { onClose } = await open();
    const dialog = screen.getByRole('dialog', { name: 'Evidence' });
    const handle = screen.getByTestId('evidence-handle');
    pt(handle, 'pointerdown', 500);
    pt(handle, 'pointerup', 500);
    expect(dialog.style.transform).toBe('translateY(0%)');
    pt(handle, 'pointerdown', 100);
    pt(handle, 'pointerup', 100);
    expect(dialog.style.transform).toContain('translateY(40.');
    // Esc closes (after the 320ms exit animation).
    fireEvent.keyDown(document, { key: 'Escape' });
    act(() => { vi.advanceTimersByTime(400); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes immediately under prefers-reduced-motion', async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    try {
      const { onClose } = await open();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      window.matchMedia = original;
    }
  });

  it('drags down past the threshold to close', async () => {
    const { onClose } = await open();
    const handle = screen.getByTestId('evidence-handle');
    pt(handle, 'pointerdown', 100);
    pt(handle, 'pointermove', 500);
    pt(handle, 'pointerup', 500);
    act(() => { vi.advanceTimersByTime(400); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('traps Tab focus inside the sheet', async () => {
    await open();
    const dialog = screen.getByRole('dialog', { name: 'Evidence' });
    const buttons = within(dialog).getAllByRole('button').filter(b => !(b as HTMLButtonElement).disabled);
    expect(buttons.length).toBeGreaterThan(1);
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(last);
  });
});

describe('EvidencePanel', () => {
  it('shows the empty state without a claim and the body with one', () => {
    wrap(<EvidencePanel open={false}/>);
    expect(screen.getByText('The proof for every claim shows up here')).toBeTruthy();
    cleanup();
    wrap(<EvidencePanel open><EvidenceBody review={review} claim={0} onPage={() => {}}/></EvidencePanel>);
    expect(screen.getByTestId('evidence-body')).toBeTruthy();
    expect(screen.queryByText('The proof for every claim shows up here')).toBeNull();
  });
});
