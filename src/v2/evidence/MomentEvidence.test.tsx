// @vitest-environment jsdom
import React from 'react';
import {it,expect,afterEach,vi} from 'vitest';
import {render,cleanup,screen,fireEvent,waitFor} from '@testing-library/react';
import {readFileSync} from 'node:fs';
import {MemoryRouter,Routes,Route} from 'react-router-dom';
import {buildReview} from '../../../packages/review-engine/src/buildReview.js';
import {applyReplayArtifact} from '../../../packages/review-engine/src/replay.js';
import {I18nProvider} from '../i18n/I18nProvider';
import {itemDisplayName} from './itemNames';
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

for(const [match,heroId] of [[9080127650,60],[9089115713,74],[9088239359,71]]) it.each(['zh','en'] as const)(`pages actual persisted moments and shows dictionary purchases for ${match} (%s)`,async lang=>{
 const a=JSON.parse(readFileSync(`data/replay-facts/${match}.json`,'utf8'));
 const review=buildReview(applyReplayArtifact({match_id:match,players:a.players},a),{heroId,lang,fetchedAt:a.fetched_at}) as Review;
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(review),{headers:{'Content-Type':'application/json'}})));
 const view=render(<MemoryRouter initialEntries={[`/m/${match}?hero=${heroId}&lang=${lang}&claim=4&view=evidence`]}><I18nProvider><Routes><Route path="/m/:matchId" element={<MatchPage/>}/></Routes></I18nProvider></MemoryRouter>);
 const body=await screen.findByTestId('moment-evidence');
 for(const card of review.insights){expect(card.claim.text).not.toMatch(/→| · |死亡记录|Death recorded/);expect(card.title).not.toMatch(/Verified fight clip|已核实交战片段/);}
 expect(body.textContent).toContain(review.facts[review.insights[review.insights.length>=4?3:0].fact_ids[0]].display[lang]);
 if(review.insights.length>=5){
 const next=screen.getByRole('button',{name:lang==='zh'?'下一条洞察':'Next insight'});
 // Use the existing pager, preserving its actual-length boundary.
 fireEvent.click(next);
 await waitFor(()=>expect(screen.getByTestId('evidence-body').getAttribute('data-claim')).toBe('4'));
 for(const id of review.insights[4].fact_ids)expect(screen.getByTestId('moment-evidence').textContent).toContain(review.facts[id].display[lang]);
 }
 const disclosure=view.container.querySelector('[data-testid="replay-provenance"] details');
 expect(disclosure).toBeTruthy();expect(disclosure?.hasAttribute('open')).toBe(false);
 expect(disclosure?.textContent).toContain('SHA-256');
 expect(view.container.querySelector('[data-testid="moment-evidence"]')?.textContent).not.toMatch(/trace\/|SHA-256|何时送达|when.*delivered/);
 for(const purchase of review.purchases ?? [])expect(view.container.textContent).toContain(itemDisplayName(purchase.item,lang));
 if(match===9080127650)expect(view.container.textContent).toContain('-1:19');
});

it.each([0,2])('handles a review with %s qualifying insights without padding',length=>{
 const review={...r,insights:r.insights.slice(0,length)};
 const onPage=vi.fn();
 const view=render(<MemoryRouter initialEntries={['/?lang=en']}><I18nProvider><EvidenceBody review={review} claim={Math.max(0,length-1)} onPage={onPage}/></I18nProvider></MemoryRouter>);
 if(!length){expect(view.container.textContent).toBe('');expect(screen.queryByTestId('evidence-pager')).toBeNull();}
 else {expect(screen.getByTestId('evidence-pager').textContent).toContain('2/2');expect((screen.getByRole('button',{name:'Next insight'}) as HTMLButtonElement).disabled).toBe(true);}
 expect(onPage).not.toHaveBeenCalled();
});
