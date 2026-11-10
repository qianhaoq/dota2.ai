#!/usr/bin/env node
import { readFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { hashFile, runExtractor, readReviewEvents, readReplaySupplement } from '../lib/matchReview/replayIngest/extractor.js';
import { adaptReplayEvents, applyReplayArtifact } from '../packages/review-engine/src/replay.js';
import { buildReview } from '../packages/review-engine/src/buildReview.js';

// Local operator tool: match JSON, actual dem, hero id, lang, output directory,
// optionally an existing extract directory (trace/). No network, credentials or names in evidence.
const [matchPath, demo, hero, lang = 'en', output, existingExtract] = process.argv.slice(2);
if (!matchPath || !demo || !output || !Number.isSafeInteger(Number(hero)) || !['en','zh'].includes(lang)) throw new Error('Usage: review-from-demo.mjs match.json[.gz] match.dem heroId en|zh outputDir [extractDir]');
const body = await readFile(matchPath);
const raw = JSON.parse((matchPath.endsWith('.gz') ? gunzipSync(body) : body).toString());
const started = Date.now();
const hash = await hashFile(demo);
const signal = AbortSignal.timeout(300000);
let temp, summary;
try {
  let extracted = existingExtract;
  if (!extracted) {
    const bin = process.env.DOTA_EXTRACT_BIN || process.env.COACH_EXTRACT_BIN;
    if (!bin) throw new Error('DOTA_EXTRACT_BIN is required to parse a local dem');
    temp = await mkdtemp(join(tmpdir(),'review-demo-')); extracted = temp;
    summary = await runExtractor(bin, [demo,temp,'--max-bytes','512000000','--max-output-bytes','512000000','--quiet'], signal);
    if (summary.trace_version !== 3) throw new Error('Unsupported extractor trace version');
  }
  const trace = await readReviewEvents(join(extracted,'trace','events.jsonl'), signal);
  const supplement = await readReplaySupplement(join(extracted,'trace'), trace.events, signal);
  const artifact = adaptReplayEvents(raw, trace.events, {demo_bytes:hash.bytes,demo_sha256:hash.sha256,fetched_at:new Date().toISOString(),source:'operator_local_demo',trace_version:3}, supplement.metadata, supplement.positions);
  // Redact identity from the review as well as the fixture/evidence.
  raw.players = raw.players.map(({personaname,account_id,...p}) => p);
  const review = buildReview(applyReplayArtifact(raw,artifact), {heroId:Number(hero),lang,fetchedAt:artifact.fetched_at,presetFollowups:true});
  const evidence = {match_id:raw.match_id,source:'operator_local_demo',download_performed:false,existing_extract:Boolean(existingExtract),demo_bytes:hash.bytes,demo_sha256:hash.sha256,elapsed_ms:Date.now()-started,extractor:summary ?? null,event_rows:trace.rows,review_event_rows:trace.events.length,deaths:artifact.players.reduce((n,p)=>n+p.deaths_log.length,0),purchases:artifact.players.reduce((n,p)=>n+p.purchase_log.length,0),death_coordinates:artifact.players.flatMap(p=>p.deaths_log).filter(d=>Number.isFinite(d.x)).length,facts:Object.keys(review.facts).length,data_gaps:review.data_gaps};
  evidence.coverage = {objectives:artifact.objectives.length,lh_at_10_players:artifact.players.filter(p=>Number.isFinite(p.lh_t?.[10])).length,net_worth_players:artifact.players.filter(p=>p.gold_t?.length).length,gold_bins:artifact.radiant_gold_adv?.length ?? 0,metadata_purchases:0};
  evidence.samples = {death:artifact.players.flatMap(p=>p.deaths_log).find(d=>d.position_source),purchase:artifact.players.flatMap(p=>p.purchase_log)[0],lh:artifact.players.find(p=>p.lh_t?.[10])?.metadata_source_path,objective:artifact.objectives[0],gold_source:artifact.gold_source,gold_derivation:artifact.gold_derivation};
  await mkdir(output,{recursive:true});
  await writeFile(join(output,'artifact.json'),JSON.stringify(artifact,null,2));
  await writeFile(join(output,'review.json'),JSON.stringify(review,null,2));
  await writeFile(join(output,'evidence.json'),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence));
} finally { if(temp) await rm(temp,{recursive:true,force:true}); }
