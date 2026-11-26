// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EvidenceCard } from './EvidenceCard';

/** The lane card, for a lane read from the replay (Codex on #392: it read the record's gold field and threw). */
const serve = (record: any) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'ok', ref: 'lane:beastmaster', kind: 'lane', record, names: {} }), { status: 200, headers: { 'content-type': 'application/json' } })));
const open = async (id: string) => {
  render(<ul><EvidenceCard matchId={id} hero="beastmaster" lang="en" item={{ refs: ['lane:beastmaster'], fact: 'f' }} onAsk={() => {}} /></ul>);
  fireEvent.click(screen.getByRole('button', { name: 'Show the record' }));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const replay = { ref: 'lane:beastmaster', hero: 'beastmaster', my_deaths_before_10_00_total: 1, my_deaths_before_10_00: [{ clock: '4:01', killer: 'phantom_assassin' }], read_from: 'replay', lane: 'bot', heroes_in_lane: { beastmaster: 'me', phantom_assassin: 'enemy' }, last_hits_at_5_00: { beastmaster: 15, phantom_assassin: 18 }, last_hits_at_10_00: { beastmaster: 35, phantom_assassin: 38 }, denies_at_10_00: { beastmaster: 3, phantom_assassin: null }, lane_gold_earned_before_10_00: { my_team: 5735, enemy: 6301 }, lane_result: 'lost' };

describe('the lane card for a lane read from the replay', () => {
  it('shows the earned gold, the note, and the table, with "–" where a number is not known', async () => {
    serve(replay);
    await open('8200000001');
    const text = document.querySelector('.ag-rec')!.textContent!;
    expect(text).toContain('gold earned before 10:00, from the replay 5735 : 6301');
    expect(text).toContain('Last hits are at least these');
    const pa = Array.from(document.querySelectorAll('.ag-lane tbody tr')).find((tr) => tr.textContent!.includes('phantom'))!;
    expect(Array.from(pa.querySelectorAll('td')).map((td) => td.textContent)).toEqual(['18', '38', '–', '–', '–']);
  });

  it("with the result withheld (a hero's lane not known) it still renders", async () => {
    serve({ ...replay, lane_gold_earned_before_10_00: null, lane_result: null });
    await open('8200000002');
    expect(document.querySelector('.ag-rec')!.textContent).toContain('Last hits are at least these');
  });
});
