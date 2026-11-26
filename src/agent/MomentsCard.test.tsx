// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EvidenceCard } from './EvidenceCard';

/** The key_moments card: the stretch, where the player was — and "not known" when the fights could not be read (Codex on #389). */
const serve = (record: any) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'ok', ref: 'moments:beastmaster', kind: 'moments', record, names: {} }), { status: 200, headers: { 'content-type': 'application/json' } })));
const open = async (lang: 'en' | 'zh', id: string) => {
  render(<ul><EvidenceCard matchId={id} hero="beastmaster" lang={lang} item={{ refs: ['moments:beastmaster'], fact: 'f' }} onAsk={() => {}} /></ul>);
  fireEvent.click(screen.getByRole('button', { name: lang === 'en' ? 'Show the record' : '看原始记录' }));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the key moments card', () => {
  it('shows the stretch with its fights and the split, never the chances', async () => {
    serve({ ref: 'moments:beastmaster', read: true, stretch: { from: '25:00', to: '33:00', my_team_win_chance_from: 67, my_team_win_chance_to: 28, fights: [{ ref: 'fight:9', clock: '25:25–25:30', change: -19, me: 'in_it' }] }, falls_by_my_part: { in_it: 1, dead: 0, elsewhere: 0, not_known: 0 }, fights_read: 13, fights_not_read: 0 });
    await open('en', '8100000001');
    const text = document.querySelector('.ag-rec')!.textContent!;
    expect(text).toContain('Where the chance fell most · 25:00–33:00');
    expect(text).toContain('in the fight100%');
    expect(text).not.toMatch(/67|28/);
  });

  it('with fights that could not be read and none that could, the split is "not known" — not "no fight lost any"', async () => {
    serve({ ref: 'moments:beastmaster', read: true, stretch: null, falls_by_my_part: { in_it: null, dead: null, elsewhere: null, not_known: null }, fights_read: 0, fights_not_read: 14 });
    await open('zh', '8100000002');
    const text = document.querySelector('.ag-rec')!.textContent!;
    expect(text).toContain('不确定');
    expect(text).not.toContain('没有哪场团战让我方胜率下降');
    expect(text).toContain('读不出胜率变化的团战');
    expect(text).toContain('14');
  });

  it('every fight read and none lost any chance: then it says so', async () => {
    serve({ ref: 'moments:beastmaster', read: true, stretch: null, falls_by_my_part: { in_it: null, dead: null, elsewhere: null, not_known: null }, fights_read: 5, fights_not_read: 0 });
    await open('en', '8100000003');
    expect(document.querySelector('.ag-rec')!.textContent).toContain('no fight lost the team any chance');
  });
});
