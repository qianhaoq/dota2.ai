// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { buildReview } from '../../../packages/review-engine/src/index.js';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Review } from '../review/types';
import { windowMoments } from './labels';
import WindowContext from './WindowContext';
const raw = JSON.parse(readFileSync('src/fixtures/match9035042364.parsed.json','utf8'));
const make = (heroId = 14) => buildReview(raw,{heroId,lang:'en',fetchedAt:'2026-11-05T00:00:00Z'}) as unknown as Review;
const translate = (key: string) => key;
afterEach(cleanup);
it('aligns deaths, key purchases and objectives with inclusive window boundaries', () => {
  const review = make();
  const insight = {...review.insights[0], time:{from:600,to:900}};
  review.objectives = [{t:750,type:'building_kill',key:'npc_dota_goodguys_tower1_mid',team:'dire',fact_id:'o'}];
  review.deaths = [{t:599,killer:null,team_gold_diff_at_t:null},{t:600,killer:null,team_gold_diff_at_t:null},{t:901,killer:null,team_gold_diff_at_t:null}];
  review.purchases = [{t:900,item:'black_king_bar',key_item:true},{t:800,item:'branches',key_item:false}];
  const rows = windowMoments(review,insight,'en',translate as any);
  expect(rows.map(r=>r.t)).toEqual([600,750,900]);
  expect(rows.every(r=>r.hl === false)).toBe(true);
  expect(rows.map(r=>r.label)).toContain('windowDeath');
  expect(windowMoments(review,{...insight,status:'insufficient'},'en',translate as any)).toEqual([]);
});
it('renders engine displays with unknown XP rather than zero, in both languages', () => {
  for (const lang of ['en','zh']) {
    const review = make();
    delete review.facts['xp.at.10'];
    const expected = review.facts['gold.at.10'].display[lang as 'en'|'zh'];
    render(<MemoryRouter initialEntries={[`/?lang=${lang}`]}><I18nProvider><WindowContext review={review} insight={review.insights[0]}/></I18nProvider></MemoryRouter>);
    const table = screen.getByTestId('economy-checkpoints');
    expect(within(table).getByText(expected)).toBeTruthy();
    expect(within(table).getByText(lang==='zh'?'未知':'Unknown')).toBeTruthy();
    expect(screen.getByTestId('window-context').textContent).toContain(lang==='zh'?'不能证明因果':'does not establish cause');
    cleanup();
  }
});
it('uses the selected Dire player perspective and never renders a future checkpoint', () => {
  const hero = raw.players.find((p:any)=>p.player_slot>=128).hero_id;
  const review = make(hero);
  expect(review.series.perspective).toBe('dire');
  expect(review.facts['gold.at.10'].value).toBe(-raw.radiant_gold_adv[10]);
  review.match.duration_s = 1100;
  render(<MemoryRouter initialEntries={['/?lang=en']}><I18nProvider><WindowContext review={review} insight={review.insights[0]}/></I18nProvider></MemoryRouter>);
  expect(screen.getByTestId('economy-checkpoints').textContent).toContain('10:00');
  expect(screen.getByTestId('economy-checkpoints').textContent).not.toContain('20:00');
});
