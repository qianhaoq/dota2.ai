import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReplayIngest, isReplayUrl, replayUrl } from '../../lib/matchReview/replayIngest/index.js';
import { createParseRequestBudget, createParseRequestTracker } from '../../lib/matchReview/matchParse.js';
import { replayStatusPayload } from '../../packages/review-engine/src/replay.js';
import { createReplayIngestHandler } from '../../lib/matchReview/replayIngest/endpoint.js';
import { createRequire } from 'node:module';
const express = createRequire(import.meta.url)('express');
import { createServer } from 'node:http';
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir,{recursive:true,force:true}); });
async function home() { const p = await mkdtemp(join(tmpdir(),'ingest-test-')); dirs.push(p); return p; }
const raw = {match_id:42,replay_url:'https://replay413.dota2.com.cn/570/42_1.dem.bz2',cluster:413,replay_salt:1,players:[]};
describe('official replay acquisition boundary', () => {
  it.each(['http://replay1.valve.net/a','https://replay413.dota2.com.cn/a','https://replay2.steamcontent.com/a'])('allows %s', url => expect(isReplayUrl(url)).toBe(true));
  it.each(['https://evil.test/a','https://replay1.valve.net.evil.test/a','file:///tmp/x','https://u:p@replay1.valve.net/a','https://replay1.valve.net:8080/a','https://replay1.valve.net:443/a','http://replay1.valve.net:80/a','http://198.18.0.1/a','https://replay1.valve.net@evil.test/a'])('rejects %s', url => expect(isReplayUrl(url)).toBe(false));
  it('constructs only from validated numeric match metadata', () => {
    expect(replayUrl({match_id:42,cluster:413,replay_salt:1})).toBe('https://replay413.valve.net/570/42_1.dem.bz2');
    expect(replayUrl({match_id:42,cluster:'evil.test',replay_salt:1})).toBeNull();
  });
  it('disabled flag and absent binary never download', async () => {
    const fetchImpl = vi.fn();
    for (const env of [{},{REPLAY_INGEST_ENABLED:'1'},{DOTA_EXTRACT_BIN:'/fake'}]) {
      const ingest = createReplayIngest({env,fetchImpl});
      expect((await ingest.submit(raw,'client')).status).toBe('replay_ingest_disabled');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('rejects invalid URL before download and records fetch-time metadata', async () => {
    const dir = await home(), fetchImpl = vi.fn();
    const ingest = createReplayIngest({env:{REPLAY_INGEST_ENABLED:'1',DOTA_EXTRACT_BIN:'/fake',REPLAY_HOME:dir},fetchImpl});
    expect((await ingest.submit({...raw,replay_url:'https://evil.test'},'client')).status).toBe('replay_invalid_url');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await ingest.read(42)).toMatchObject({replay_url_present:true,replay_salt:1,cluster:413,status:'replay_invalid_url'});
  });
  it.each([[404,'replay_expired'],[410,'replay_expired'],[500,'replay_cdn_error']])('classifies HTTP %s honestly', async (code,status) => {
    const dir = await home();
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(null,{status:Number(code)}));
    const ingest = createReplayIngest({env:{REPLAY_INGEST_ENABLED:'1',DOTA_EXTRACT_BIN:'/fake',REPLAY_HOME:dir},fetchImpl});
    expect((await ingest.submit(raw,'client')).status).toBe(status);
    expect(await ingest.read(42)).toMatchObject({http_status:code,status,url_host:'replay413.dota2.com.cn'});
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({redirect:'error'});
  });
  it('deduplicates in flight and cools failures down, then enforces budget', async () => {
    let now = 0; const dir = await home();
    const fetchImpl = vi.fn(async () => new Response(null,{status:500}));
    const tracker = createParseRequestTracker({now:()=>now,failureCooldownMs:1000});
    const budget = createParseRequestBudget({now:()=>now,globalMax:1,perClientMax:1});
    const ingest = createReplayIngest({env:{REPLAY_INGEST_ENABLED:'1',DOTA_EXTRACT_BIN:'/fake',REPLAY_HOME:dir},fetchImpl,tracker,budget});
    await ingest.submit(raw,'client');
    expect((await ingest.submit(raw,'client')).status).toBe('replay_cdn_error');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 1001;
    expect((await ingest.submit(raw,'client')).status).toBe('throttled');
  });
  it('download size cap prevents extractor invocation and cleans temp directory', async () => {
    const dir = await home(), extract = vi.fn();
    const ingest = createReplayIngest({env:{REPLAY_INGEST_ENABLED:'1',DOTA_EXTRACT_BIN:'/fake',REPLAY_HOME:dir},maxDownload:10,fetchImpl:async()=>new Response('0123456789012'),extract});
    expect((await ingest.submit(raw,'client')).status).toBe('replay_failed');
    expect(extract).not.toHaveBeenCalled();
    const {readdir} = await import('node:fs/promises'); expect(await readdir(dir)).toEqual(['42.json']);
  });
  it('returns bilingual first-party messages', () => {
    expect(replayStatusPayload('replay_pending','en').message).toContain('First-party');
    expect(replayStatusPayload('replay_pending','zh').message).toContain('本站');
    expect(replayStatusPayload('replay_cdn_error','zh').message).toContain('未核实');
  });
  it('disabled HTTP endpoint is CSRF guarded and does no match fetch', async () => {
    const app = express(); app.use(express.json()); const getMatchDetail = vi.fn();
    app.post('/api/review/:matchId/replay-ingest',createReplayIngestHandler({ingest:createReplayIngest({env:{}}),getMatchDetail,resolveClientIp:()=> 'client'}));
    const server = createServer(app); await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const addr = server.address(); if (!addr || typeof addr === 'string') throw new Error('address');
    const url = `http://127.0.0.1:${addr.port}/api/review/42/replay-ingest`;
    try {
      expect((await fetch(url,{method:'POST'})).status).toBe(415);
      const response = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lang:'zh'})});
      expect(await response.json()).toMatchObject({status:'replay_ingest_disabled',message:expect.stringContaining('本站')});
      expect(getMatchDetail).not.toHaveBeenCalled();
    } finally { await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())); }
  });
});

it('aborts a disconnected download, records a short retry window and cleans work files', async () => {
  const dir = await home(); const controller = new AbortController();
  let began!: () => void; const started = new Promise<void>(resolve=>{began=resolve;});
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    began();
    return await new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(init.signal?.reason),{once:true}));
  });
  const ingest = createReplayIngest({env:{REPLAY_INGEST_ENABLED:'1',DOTA_EXTRACT_BIN:'/fake',REPLAY_HOME:dir},fetchImpl});
  const task = ingest.submit(raw,'client',{signal:controller.signal});
  const rejected = expect(task).rejects.toMatchObject({name:'AbortError'});
  await started; controller.abort(); await rejected;
  expect(await ingest.read(42)).toMatchObject({status:'replay_failed',reason:'client_aborted'});
  const {readdir} = await import('node:fs/promises'); expect(await readdir(dir)).toEqual(['42.json']);
});

it.each([[3,'bz2'],[4,'zstd']])('persists verified v%s %s facts through suffix-less download; GET overlay is read-only', async (version,format) => {
  const dir = await home(); const {createHash} = await import('node:crypto');
  const demo = Buffer.from('PBDEMS2 compact extractor test input');
  const sha256 = createHash('sha256').update(demo).digest('hex');
  const {mkdir} = await import('node:fs/promises');
  const fixture = await readFile(new URL('../../packages/review-engine/test/fixtures/replay-events.json',import.meta.url),'utf8');
  const events: unknown[] = JSON.parse(fixture);
  const extract = vi.fn(async (_bin: string, args: string[]) => {
    if (args.includes('--decompress-only')) {
      expect(args[0]).toBe(join(args[1],'download'));
      expect(await readFile(args[0])).toEqual(compressed);
      await writeFile(join(args[1],'replay.dem'),demo);
      return {ok:true,format,bytes:demo.length,sha256};
    }
    await mkdir(join(args[1],'trace'));
    await writeFile(join(args[1],'trace','events.jsonl'),events.map(e=>JSON.stringify(e)).join('\n')+'\n');
    return {ok:true,trace_version:version,match_id:42,clock:{unit:'seconds',zero:'horn_game_start'},ms:1};
  });
  const compressed = format === 'zstd' ? Buffer.from('28b52ffd01020304','hex') : Buffer.from('BZh fixture');
  const fetchImpl = vi.fn(async(url: Parameters<typeof fetch>[0])=>{ expect(String(url)).toMatch(/\.dem\.bz2$/); return new Response(compressed); });
  const ingest = createReplayIngest({env:{REPLAY_INGEST_ENABLED:'1',DOTA_EXTRACT_BIN:'/fake',REPLAY_HOME:dir},fetchImpl,extract});
  const match = {...raw,od_data:{has_parsed:false},players:[{hero_id:60,player_slot:132},{hero_id:2,player_slot:0}]};
  expect(await ingest.overlay(match)).toEqual({...match,replay_ingest_available:true}); expect(fetchImpl).not.toHaveBeenCalled();
  expect((await ingest.submit(match,'client')).status).toBe('replay_parsed');
  const artifact = await ingest.read(42);
  expect(artifact).toMatchObject({download_bytes:compressed.length,download_sha256:createHash('sha256').update(compressed).digest('hex'),compression_format:format,demo_sha256:sha256,status:'replay_parsed',trace_version:version,extractor_match_id:42,clock:{unit:'seconds',zero:'horn_game_start'}});
  expect((await ingest.overlay(match)).players[0].deaths_log[0]).toMatchObject({time:72.5,x:100,y:-200});
  expect((await ingest.submit(match,'client')).status).toBe('replay_parsed');
  expect(fetchImpl).toHaveBeenCalledTimes(1); expect(extract).toHaveBeenCalledTimes(2);
  const disabled = createReplayIngest({env:{REPLAY_HOME:dir},fetchImpl});
  const retained = await disabled.overlay(match);
  expect(retained.replay_ingest_available).toBe(false);
  expect(retained.players[0].deaths_log[0]).toMatchObject({time:72.5,x:100,y:-200});
});

it('no URL and a network outage remain distinct unavailable states', async () => {
  for (const [match,status] of [[{...raw,replay_url:null,cluster:null},'replay_unavailable'],[raw,'replay_cdn_error']] as const) {
    const dir = await home(); const fetchImpl = vi.fn(async()=>{throw new TypeError('network');});
    const ingest = createReplayIngest({env:{REPLAY_INGEST_ENABLED:'1',DOTA_EXTRACT_BIN:'/fake',REPLAY_HOME:dir},fetchImpl});
    expect((await ingest.submit(match,'client')).status).toBe(status);
    expect(fetchImpl).toHaveBeenCalledTimes(status === 'replay_unavailable' ? 0 : 1);
  }
});

it('streams only nearest real-hero death samples and reads optional metadata', async () => {
  const {readReviewEvents,readReplaySupplement} = await import('../../lib/matchReview/replayIngest/extractor.js');
  const dir = await home();
  const event = {type:'DOTA_COMBATLOG_DEATH',t:10,target:'npc_dota_hero_axe',target_hero:true,target_illusion:false};
  await writeFile(join(dir,'events.jsonl'),[event,{type:'DOTA_COMBATLOG_PLAYERSTATS',t:10},{type:'DOTA_COMBATLOG_TEAM_BUILDING_KILL',t:12,target:'npc_dota_badguys_fort'}].map(e=>JSON.stringify(e)).join('\n'));
  const trace = await readReviewEvents(join(dir,'events.jsonl'));
  expect(trace.rows).toBe(3); expect(trace.events.map(e=>e.trace_index)).toEqual([0,2]);
  await writeFile(join(dir,'metadata.json'),JSON.stringify({players:[{player_slot:0,camps_stacked:9}]}));
  await writeFile(join(dir,'states.jsonl'),[
    {hero:'axe',entity_kind:'real_hero',t:9.8,x:1,y:2,life_state:0},
    {hero:'axe',entity_kind:'illusion',t:10,x:999,y:999},
    {hero:'axe',entity_kind:'real_hero',t:10.05,x:3,y:4,life_state:0},
    {hero:'axe',entity_kind:'real_hero',t:10.3,x:5,y:6}
  ].map(s=>JSON.stringify(s)).join('\n'));
  const result = await readReplaySupplement(dir,trace.events);
  expect(result.metadata.players[0].camps_stacked).toBe(9);
  expect(result.positions).toEqual([{t:10.05,x:3,y:4,source_path:'trace/states.jsonl[2]',death_source_path:'trace/events.jsonl[0]'}]);
  await rm(join(dir,'states.jsonl')); await rm(join(dir,'metadata.json'));
  expect(await readReplaySupplement(dir,trace.events)).toEqual({metadata:null,positions:[]});
});


it('pairs official coach metadata.jsonl with replay adaptation (last player row wins)', async () => {
  const {readReplaySupplement} = await import('../../lib/matchReview/replayIngest/extractor.js');
  const {adaptReplayEvents} = await import('../../packages/review-engine/src/replay.js');
  const dir = await home();
  const row = {source:'demo_metadata',timing:'postgame',players:[{player_slot:0,graph_net_worth:[60,100],camps_stacked:2,items:[],inventory_snapshots:[{game_time:600,last_hits:56}]}]};
  await writeFile(join(dir,'metadata.jsonl'),[
    JSON.stringify({...row,players:[]}),JSON.stringify(row),JSON.stringify({source:'other_callback'})
  ].join('\n'));
  const supplement = await readReplaySupplement(dir,[]);
  const a = adaptReplayEvents({match_id:42,duration:120,players:[{hero_id:2,player_slot:0}]},[],{},supplement.metadata);
  expect(a.players[0].lh_t[10]).toBe(56);
  expect(a.players[0].net_worth_t).toEqual([600,1000]);
  expect(a.players[0].metadata_source_path).toBe('trace/metadata.jsonl[1].players[player_slot=0]');
  expect(a.players[0].gold_t).toBeUndefined();
  await writeFile(join(dir,'metadata.jsonl'),' '.repeat(8000001));
  await expect(readReplaySupplement(dir,[])).rejects.toThrow('metadata_bytes_limit');
});


it('reports current capability through review parse status independently of stored jobs', async () => {
  const { createReadOnlyParseStatusResolver } = await import('../../lib/matchReview/parseRequestEndpoint.js');
  const resolve = createReadOnlyParseStatusResolver({tracker:createParseRequestTracker()});
  const dir = await home();
  const fetchImpl = vi.fn();
  for (const enabled of [false, true]) {
    const ingest = createReplayIngest({env:{REPLAY_HOME:dir,REPLAY_INGEST_ENABLED:enabled?'1':'0',DOTA_EXTRACT_BIN:'/fake'},fetchImpl});
    expect(resolve(42,await ingest.overlay(raw),'en')).toMatchObject({status:'unparsed',ingest_available:enabled});
  }
  await writeFile(join(dir,'42.json'),JSON.stringify({match_id:42,status:'replay_cdn_error'}));
  const disabled = createReplayIngest({env:{REPLAY_HOME:dir},fetchImpl});
  expect(resolve(42,await disabled.overlay(raw),'en')).toMatchObject({status:'replay_cdn_error',ingest_available:false});
  expect(fetchImpl).not.toHaveBeenCalled();
});


it('bounds extractor versions and rejects cross-match traces', async () => {
  const {extractorMetadata} = await import('../../lib/matchReview/replayIngest/extractor.js');
  for (const version of [undefined,2,5,99]) expect(()=>extractorMetadata({trace_version:version},42)).toThrow('Unsupported');
  expect(()=>extractorMetadata({trace_version:4,match_id:43},42)).toThrow('mismatch');
  expect(()=>extractorMetadata({trace_version:4,clock:{name:'demo_tick_30hz',unit:'ticks'}},42)).toThrow('match clock');
  expect(extractorMetadata({trace_version:3},42)).toEqual({trace_version:3});
});

it.each([undefined,'zip'])('rejects missing/unknown decompress-only format %s before parsing', async format => {
  const dir = await home();
  const extract = vi.fn(async()=>({ok:true,format,bytes:32,sha256:'a'.repeat(64)}));
  const ingest = createReplayIngest({env:{REPLAY_INGEST_ENABLED:'1',DOTA_EXTRACT_BIN:'/fake',REPLAY_HOME:dir},fetchImpl:async()=>new Response('compressed body'),extract});
  expect((await ingest.submit(raw,'client')).status).toBe('replay_failed');
  expect(extract).toHaveBeenCalledTimes(1);
});

it('retains denser net-worth graphs without interpreting graph indices as minutes', async () => {
  const {adaptReplayEvents,applyReplayArtifact} = await import('../../packages/review-engine/src/replay.js');
  const match = {...raw,duration:120,players:[{hero_id:60,player_slot:132}]};
  const a = adaptReplayEvents(match,[],{demo_bytes:32,demo_sha256:'a'.repeat(64),fetched_at:new Date().toISOString()},
    {players:[{player_slot:132,graph_net_worth:[60,65,75,90,100]}]});
  expect(a.players[0].net_worth_t).toEqual([600,650,750,900,1000]);
  expect(a.players[0].net_worth_timing).toBe('uncalibrated_graph_bins');
  expect(a.players[0].gold_t).toBeUndefined();
  expect(a.data_gaps).toContainEqual({topic:'net_worth_t',reason:'metadata_graph_timing_unverified'});
  expect(applyReplayArtifact(match,a).players[0].net_worth_t).toBeUndefined();
});
