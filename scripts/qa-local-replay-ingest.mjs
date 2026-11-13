#!/usr/bin/env node
// Explicit operator QA only. fetchImpl serves local bytes; never contacts a CDN.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createReplayIngest } from '../lib/matchReview/replayIngest/index.js';
import { runExtractor } from '../lib/matchReview/replayIngest/extractor.js';
import { parseSiteKnowledge } from '../packages/review-engine/src/siteKnowledge.js';
import { buildReview } from '../packages/review-engine/src/buildReview.js';
const [matchPath, compressedPath, bz2Path, output] = process.argv.slice(2);
assert(output && process.env.DOTA_EXTRACT_BIN, 'Usage: DOTA_EXTRACT_BIN=... node scripts/qa-local-replay-ingest.mjs match.json official.dem.bz2 tiny.dem.bz2 output');
await mkdir(output,{recursive:true});
const home = await mkdtemp(join(output,'ingest-'));
const raw = JSON.parse(await readFile(matchPath,'utf8'));
assert.equal(raw.match_id,9080127650); assert.equal(raw.duration,1906);
assert.equal(raw.players.find(p=>p.player_slot===132).hero_id,60);
const compressed = await readFile(compressedPath);
assert.equal(compressed.subarray(0,4).toString('hex'),'28b52ffd');
let requests = 0;
const ingest = createReplayIngest({onError:e=>console.error('worker:',e.message),env:{REPLAY_INGEST_ENABLED:'1',DOTA_EXTRACT_BIN:process.env.DOTA_EXTRACT_BIN,REPLAY_HOME:home},fetchImpl:async url=>{
  assert.match(url,/\.dem\.bz2$/); requests++; return new Response(compressed,{status:200});
}});
const submitted=await ingest.submit(raw,'local-qa',{lang:'zh'});
assert.equal(submitted.status,'replay_pending'); assert.equal(typeof submitted.jobId,'string');
assert.equal((await ingest.submit(raw,'local-qa',{lang:'zh'})).jobId,submitted.jobId);
assert.equal(requests,0);
await ingest.drain();
assert.equal((await ingest.jobStore.get(submitted.jobId)).status,'ready');
assert.equal((await ingest.submit(raw,'local-qa')).jobId,submitted.jobId);
assert.equal(requests,1);
const artifact = await ingest.read(raw.match_id);
assert.equal(artifact.extractor_match_id,9080127650);
assert.equal(artifact.trace_version,4); assert.equal(artifact.compression_format,'zstd');
assert.equal(artifact.download_sha256,'e055b3c6a2ca3118953bc08b58f389cedf241c6748f5ae4312afd1208254a540');
assert.equal(artifact.clock.unit,'seconds'); assert.equal(artifact.clock.zero,'horn_game_start');
const player = artifact.players.find(p=>p.player_slot===132);
assert.equal(player.hero_id,60); assert.equal(player.extractor_hero_key,'npc_dota_hero_night_stalker'); assert(player.net_worth_t.length); assert.equal(player.gold_t,undefined);
const fort = artifact.objectives.find(e=>e.key==='npc_dota_badguys_fort');
assert(Math.abs(fort.time-1906.7667846679688)<0.01);
assert.equal(fort.time,artifact.clock.game_end.t);
assert(player.deaths_log.length); assert(player.purchase_log.length);
const overlay = await ingest.overlay({...raw,players:raw.players.map(({personaname,account_id,...p})=>p)});
const kb = parseSiteKnowledge(JSON.parse(await readFile(new URL('../data/site-knowledge.v1.json',import.meta.url),'utf8')));
const options = {heroId:60,lang:'zh',fetchedAt:artifact.fetched_at,presetFollowups:true,kb};
const review = buildReview(overlay,options);
assert(!Object.keys(review.facts).some(id=>id.startsWith('kb.')), 'General KB requires explicit selection; zero stacks proves no precheck');
const contextual = buildReview(overlay,{...options,kbContextIds:kb.map(e=>e.id)});
const contextualFacts = Object.values(contextual.facts).filter(f=>f.id.startsWith('kb.'));
assert.equal(contextualFacts.length,kb.length);
for (const f of contextualFacts) {
  assert.equal(f.value.match_assessment,'not_evaluable');
  assert.deepEqual(f.value.support_fact_ids,[]); assert.deepEqual(f.value.contradiction_fact_ids,[]);
}
assert.deepEqual(review.insights.map(i=>i.id),['hook_death','void_dismember','darkness_scythe','skeleton_before_bkb','bkb_windows']);
for(const i of review.insights) { assert(i.kind); assert(i.prompt); assert(i.fact_ids.every(id=>review.facts[id])); }
assert.equal(player.deaths_log.length,8);
assert.equal(review.deaths[5].killer,'npc_dota_wraith_king_skeleton_warrior');
assert(Math.abs(review.facts['use.bkb.1'].value.ended_at-1654.2)<0.01);
assert(Math.abs(review.facts['use.bkb.2'].value.ended_at-1805.27)<0.01);
assert(Math.abs(review.facts['purchase.bkb_after_skeleton'].t-1563.47)<0.01);
assert(!JSON.stringify(review.insights).match(/state_sample|net_worth_t|xp_t|gold_t|playerstats|trace_version|trace\/|sample_t/));
assert(review.data_gaps.some(g=>g.topic==='build_vs_lineup'));
for (const f of Object.values(review.facts).filter(f=>f.source_path?.startsWith('trace/events.jsonl'))) assert.equal(f.citation,'r1');
assert(!Object.keys(review.facts).some(id=>id.startsWith('net_worth.at.')),'Uncalibrated graph bins cannot support minute facts');
// Real bzip2 through the same suffix-less decompression contract. Tiny fixture
// is header-only (19 bytes), so it intentionally cannot produce a match review.
const bzDir = await mkdtemp(join(output,'bz2-'));
let bz;
try {
  const body = await readFile(bz2Path); assert.equal(body.subarray(0,3).toString(),'BZh');
  await copyFile(bz2Path,join(bzDir,'download'));
  bz = await runExtractor(process.env.DOTA_EXTRACT_BIN,[join(bzDir,'download'),bzDir,'--decompress-only','--max-bytes','512000000'],AbortSignal.timeout(30000));
  assert.equal(bz.format,'bz2'); assert.equal(bz.ok,true);
} finally { await rm(bzDir,{recursive:true,force:true}); }
const evidence = {source:'local_file_site_submit',production_auto_download_proven:false,requests,home,extractor_match_id:artifact.extractor_match_id,clock:artifact.clock,compression:artifact.compression_format,bzip2:bz,identity:{hero_id:60,hero:'Night Stalker',player_slot:132},net_worth_source:player.net_worth_source,net_worth_bins:player.net_worth_t.length,net_worth_label:'净资产 / Net worth',net_worth_timing:player.net_worth_timing,kb_applicability:{unselected_attached:0,explicit_context:contextualFacts},earned_gold_emitted:false,fort,deaths:player.deaths_log,purchases:player.purchase_log,data_gaps:review.data_gaps,limitations:'Already-obtained official file through site submit(), not production CDN success. Production dota2-ai-00125-5lb @45c63132 remains off; node:20-alpine has no extractor. No CDN request, deployment or config change.'};
await writeFile(join(output,'artifact.json'),JSON.stringify(artifact,null,2));
await writeFile(join(output,'review-contextual.json'),JSON.stringify(contextual,null,2));
await writeFile(join(output,'review.json'),JSON.stringify(review,null,2));
await writeFile(join(output,'evidence.json'),JSON.stringify(evidence,null,2));
console.log(JSON.stringify({status:artifact.status,output,fort,bzip2:bz.format,facts:Object.keys(review.facts).length}));
