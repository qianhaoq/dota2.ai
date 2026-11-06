// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { buildReview } from '../../../packages/review-engine/src/index.js';
import { createJournalStore } from '../../features/journal/journalStore';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Review } from './types';
import PracticeGoal from './PracticeGoal';
const raw = JSON.parse(readFileSync('src/fixtures/match9035042364.parsed.json','utf8'));
const review = buildReview(raw,{heroId:14,lang:'en',fetchedAt:'2026-11-05T00:00:00Z'}) as unknown as Review;
const insight = review.insights.find(i=>i.id==='next_game')!;
afterEach(cleanup);
function mount(store:ReturnType<typeof createJournalStore>) {
  window.localStorage.clear();
  return render(<MemoryRouter initialEntries={['/?lang=en']}><I18nProvider><PracticeGoal review={review} insight={insight} store={store}/></I18nProvider></MemoryRouter>);
}
it('saves one editable goal in the existing journal, resumes and marks completion as self-report', () => {
  const data = new Map<string,string>();
  const storage = {getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value)}};
  const store = createJournalStore(storage);
  mount(store);
  fireEvent.click(screen.getByRole('button',{name:'Save one practice goal'}));
  fireEvent.change(screen.getByLabelText('Action'),{target:{value:'Check the next objective before moving'}});
  fireEvent.click(screen.getByRole('button',{name:'Save on this device'}));
  expect(screen.getByRole('status').textContent).toBe('Saved on this device');
  expect(store.getNotes()).toHaveLength(1);
  expect(store.getNotes()[0]).toMatchObject({authority:'hypothesis',contextId:'match:9035042364:14',done:false});
  fireEvent.click(screen.getByRole('checkbox',{name:'I checked this myself'}));
  expect(store.getNotes()[0].done).toBe(true);
  cleanup();
  mount(createJournalStore(storage));
  expect(screen.getByText('Check the next objective before moving')).toBeTruthy();
  expect(screen.queryByRole('button',{name:'Save one practice goal'})).toBeNull();
});
it('reports memory-only persistence and refuses a full journal without claiming success', () => {
  const store = createJournalStore(null);
  mount(store);
  fireEvent.click(screen.getByRole('button',{name:'Save one practice goal'}));
  fireEvent.click(screen.getByRole('button',{name:'Save on this device'}));
  expect(screen.getByRole('status').textContent).toContain('session only');
  cleanup();
  const full = createJournalStore(null);
  for(let i=0;i<100;i++) full.addNote({key:String(i),title:'Existing',trigger:'Before',action:'Observe',check:'Review',contextId:'fixture',authority:'hypothesis'});
  mount(full);
  fireEvent.click(screen.getByRole('button',{name:'Save one practice goal'}));
  fireEvent.click(screen.getByRole('button',{name:'Save on this device'}));
  expect(screen.getByRole('alert').textContent).toContain('journal is full');
  expect(full.getNotes()).toHaveLength(100);
  expect(screen.queryByTestId('practice-goal-saved')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
  fireEvent.click(screen.getByRole('button',{name:'Save one practice goal'}));
  expect(screen.queryByRole('alert')).toBeNull();
});
