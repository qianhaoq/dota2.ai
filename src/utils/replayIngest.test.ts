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

it('persists verified facts after download, decompression and parsing; GET overlay is read-only', async () => {
  const dir = await home(); const {createHash} = await import('node:crypto');
  const demo = Buffer.from('PBDEMS2 compact extractor test input');
  const sha256 = createHash('sha256').update(demo).digest('hex');
  const {mkdir} = await import('node:fs/promises');
  const fixture = await readFile(new URL('../../packages/review-engine/test/fixtures/replay-events.json',import.meta.url),'utf8');
  const events: unknown[] = JSON.parse(fixture);
  const extract = vi.fn(async (_bin: string, args: string[]) => {
    if (args.includes('--decompress-only')) {
      await writeFile(join(args[1],'replay.dem'),demo);
      return {ok:true,bytes:demo.length,sha256};
    }
    await mkdir(join(args[1],'trace'));
    await writeFile(join(args[1],'trace','events.jsonl'),events.map(e=>JSON.stringify(e)).join('\n')+'\n');
    return {ok:true,trace_version:3,ms:1};
  });
  const fetchImpl = vi.fn(async()=>new Response(demo));
  const ingest = createReplayIngest({env:{REPLAY_INGEST_ENABLED:'1',DOTA_EXTRACT_BIN:'/fake',REPLAY_HOME:dir},fetchImpl,extract});
  const match = {...raw,od_data:{has_parsed:false},players:[{hero_id:60,player_slot:132},{hero_id:2,player_slot:0}]};
  expect(await ingest.overlay(match)).toEqual(match); expect(fetchImpl).not.toHaveBeenCalled();
  expect((await ingest.submit(match,'client')).status).toBe('replay_parsed');
  const artifact = await ingest.read(42);
  expect(artifact).toMatchObject({download_bytes:demo.length,download_sha256:sha256,demo_sha256:sha256,status:'replay_parsed'});
  expect((await ingest.overlay(match)).players[0].deaths_log[0]).toMatchObject({time:72.5,x:100,y:-200});
  expect((await ingest.submit(match,'client')).status).toBe('replay_parsed');
  expect(fetchImpl).toHaveBeenCalledTimes(1); expect(extract).toHaveBeenCalledTimes(2);
});

it('no URL and a network outage remain distinct unavailable states', async () => {
  for (const [match,status] of [[{...raw,replay_url:null,cluster:null},'replay_unavailable'],[raw,'replay_cdn_error']] as const) {
    const dir = await home(); const fetchImpl = vi.fn(async()=>{throw new TypeError('network');});
    const ingest = createReplayIngest({env:{REPLAY_INGEST_ENABLED:'1',DOTA_EXTRACT_BIN:'/fake',REPLAY_HOME:dir},fetchImpl});
    expect((await ingest.submit(match,'client')).status).toBe(status);
    expect(fetchImpl).toHaveBeenCalledTimes(status === 'replay_unavailable' ? 0 : 1);
  }
});
