// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EvidenceCard } from './EvidenceCard';

/** The draft card (#449 review): a line citing draft:<hero> opens the lanes and pairings it rests on. */
const serve = (record: any, names: Record<string, string> = {}) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'ok', ref: 'draft:beastmaster', kind: 'draft', record, names }), { status: 200, headers: { 'content-type': 'application/json' } })));
const open = async (id: string, lang: 'en' | 'zh' = 'en') => {
  render(<ul><EvidenceCard matchId={id} hero="beastmaster" lang={lang} item={{ refs: ['draft:beastmaster'], fact: 'f' }} onAsk={() => {}} /></ul>);
  fireEvent.click(screen.getByRole('button', { name: lang === 'zh' ? '看原始记录' : 'Show the record' }));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const pair = { hero: 'skywrath_mage', against: 'necrolyte', bracket: 'Legend–Ancient', lane_when_they_met: { lanes: 343, won: 32.7, even: 29.7, lost: 37.6, own_lanes_won: 40, own_lanes_lost: 35, reading: 'unfavoured' }, game: { games: 5238, win_rate: 47, own_win_rate: 46.1, reading: 'even' } };
const record = {
  ref: 'draft:beastmaster', hero: 'beastmaster', bracket_basis: 'the median public medal of the match',
  lanes: [
    { lane: 'mid', my_team: ['skywrath_mage'], enemy: ['necrolyte'], solo: { my_team: true, enemy: true }, pairings: [pair] },
    { lane: 'bot', my_lane: true, my_team: ['beastmaster'], enemy: ['phantom_assassin', 'venomancer'], shared_part_time_by: [{ hero: 'undying', side: 'my_team', share_of_lane_stage_here: 0.44 }], solo: { my_team: false, enemy: false }, pairings: [{ ...pair, hero: 'undying', against: 'venomancer', part_time: true }] },
  ],
  in_no_single_lane: [], gaps: [],
};

describe('the draft card', () => {
  it('shows each lane with its heroes, solo and part-time, and each pairing\'s public-game numbers', async () => {
    serve(record);
    await open('8300000001');
    const text = document.querySelector('.ag-rec')!.textContent!;
    expect(text).toContain('Public games · Legend–Ancient');
    expect(text).toContain('Mid lane');
    expect(text).toContain('(solo)');
    expect(text).toContain('343 lanes when they met · won 32.7% lost 37.6% · unfavoured');
    expect(text).toContain('win rate 47% · own 46.1% · even');
    expect(text).toContain('part-time 44%');
    // The English sentence of the bracket's basis is not put on the page.
    expect(text).not.toContain('median public medal');
  });

  it('in Chinese', async () => {
    serve(record);
    await open('8300000002', 'zh');
    const text = document.querySelector('.ag-rec')!.textContent!;
    expect(text).toContain('路人局');
    expect(text).toContain('中路');
    expect(text).toContain('碰面时对线');
    expect(text).toContain('吃亏');
  });

  it('with the bracket not known, each bracket\'s numbers on their own', async () => {
    const { bracket: _b, lane_when_they_met, game, ...rest } = pair;
    serve({ ...record, lanes: [{ ...record.lanes[0], pairings: [{ ...rest, by_bracket: [{ bracket: 'Herald–Guardian', lane_when_they_met: null, game }, { bracket: 'Divine–Immortal', lane_when_they_met, game: null }] }] }] });
    await open('8300000003');
    const text = document.querySelector('.ag-rec')!.textContent!;
    expect(text).toContain('Herald–Guardian');
    expect(text).toContain('Divine–Immortal');
  });
});
