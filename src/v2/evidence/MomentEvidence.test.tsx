// @vitest-environment jsdom
import React from 'react';
import {it,expect,afterEach,vi} from 'vitest';
import {render,cleanup,screen} from '@testing-library/react';
import {readFileSync} from 'node:fs';
import {MemoryRouter,Routes,Route} from 'react-router-dom';
import {buildReview} from '../../../packages/review-engine/src/buildReview.js';
import {applyReplayArtifact} from '../../../packages/review-engine/src/replay.js';
import {I18nProvider} from '../i18n/I18nProvider';
import EvidenceBody from './EvidenceBody';
import MatchPage from '../pages/MatchPage';
import type {Review} from '../review/types';
vi.mock('../../services/analytics',()=>({trackEvent:vi.fn()}));
const a=JSON.parse(readFileSync('data/replay-facts/9080127650.json','utf8'));
const r=buildReview(applyReplayArtifact({match_id:a.match_id,duration:1906,players:a.players},a),{heroId:60,lang:'en',fetchedAt:a.fetched_at}) as Review;
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it.each([3,4])('renders the exact cited facts of later moment %s',claim=>{
 render(<MemoryRouter><I18nProvider><EvidenceBody review={r} claim={claim} onPage={()=>{}}/></I18nProvider></MemoryRouter>);
 const body=screen.getByTestId('moment-evidence');
 expect(Array.from(body.querySelectorAll('[data-fact-id]')).map(e=>e.getAttribute('data-fact-id'))).toEqual(r.insights[claim].fact_ids);
 for(const id of r.insights[claim].fact_ids)expect(body.textContent).toContain(r.facts[id].display.en);
 expect(body.textContent).not.toMatch(/state_sample|net_worth_t|xp_t|gold_t|playerstats|trace_version|trace\/|sample_t/);
 expect(screen.queryByText('Who killed you')).toBeNull();
});
it.each([4,5])('opens 908 deep link claim=%s with that moment evidence',async claim=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(r),{headers:{'Content-Type':'application/json'}})));
 render(<MemoryRouter initialEntries={[`/m/9080127650?hero=night_stalker&lang=en&claim=${claim}&view=evidence`]}><I18nProvider><Routes><Route path="/m/:matchId" element={<MatchPage/>}/></Routes></I18nProvider></MemoryRouter>);
 const body=await screen.findByTestId('moment-evidence');
 expect(Array.from(body.querySelectorAll('[data-fact-id]')).map(e=>e.getAttribute('data-fact-id'))).toEqual(r.insights[claim-1].fact_ids);
});
