import {it,expect,vi,afterEach} from 'vitest';
import http from 'node:http';
import {classifyReplayAddress,selectPublicReplayAddress,createPublicReplayLookup,fetchReplay} from '../../lib/matchReview/replayIngest/download.js';
import {createReplayIngest} from '../../lib/matchReview/replayIngest/index.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const v4={address:'34.126.231.241',family:4},v6={address:'2600:1900:4110:a29::',family:6};
afterEach(()=>vi.restoreAllMocks());
it('classifies denied ranges and mapped IPv4 without routing to them',()=>{
 for(const address of ['0.1.2.3','192.0.0.1','192.88.99.1','198.18.0.1','198.19.1.1','10.0.0.1','127.0.0.1','169.254.1.1','172.16.0.1','192.168.0.1','100.64.0.1','::','::1','fc00::1','fe80::1','2001:db8::1','2001:2::1','100::1','ff00::1','224.0.0.1','255.255.255.255','192.0.2.1','198.51.100.1','203.0.113.1','::ffff:10.0.0.1','64:ff9b::a00:1']){
  expect(selectPublicReplayAddress([{address,family:address.includes(':')?6:4}]),address).toBeNull();
 }
 expect(classifyReplayAddress('::ffff:192.168.0.1')).toBe('private');
 expect(classifyReplayAddress('64:ff9b:1::1')).toBe('other');
 expect(classifyReplayAddress('64:ff9b::227e:e7f1')).toBe('mapped_v4');
 expect(classifyReplayAddress('::ffff:227e:e7f1')).toBe('mapped_v4');
 expect(classifyReplayAddress('2001:10::1')).toBe('other');
 expect(classifyReplayAddress('2001:20::1')).toBe('other');
 expect(classifyReplayAddress('2002::1')).toBe('other');
 expect(selectPublicReplayAddress([{address:'::ffff:34.126.231.241',family:6}])).toBeNull();
 expect(selectPublicReplayAddress([{address:'64:ff9b::227e:e7f1',family:6}])).toBeNull();
 expect(selectPublicReplayAddress([{address:'2001:10::1',family:6}])).toBeNull();
});
it('uses IPv4 preference and a fail-closed IPv6 fallback',()=>{
 const bad={address:'198.18.0.1',family:4};
 expect(selectPublicReplayAddress([v6,v4])).toEqual(v4);
 expect(selectPublicReplayAddress([v6])).toEqual(v6);
 expect(selectPublicReplayAddress([bad,v6])).toBeNull();
 expect(selectPublicReplayAddress([bad,v4])).toEqual(v4);
});
it('resolves once at connection time and attaches DNS classifications on rejection',async()=>{
 for(const all of [true,false]){
  const lookup=vi.fn((_host,_options,cb)=>cb(null,[v6,v4]));
  const result=await new Promise(r=>createPublicReplayLookup(lookup)('replay184.valve.net',{all},(...args:any[])=>r(args)));
  expect(result).toEqual([null,all?[v4]:v4.address,4]);expect(lookup).toHaveBeenCalledExactlyOnceWith('replay184.valve.net',{all:true},expect.any(Function));
 }
 const error:any=await new Promise(r=>createPublicReplayLookup((_h,_o,cb)=>cb(null,[{address:'198.18.0.1',family:4},v6]))('replay184.valve.net',{},(e:any)=>r(e)));
 expect(error.message).toBe('replay_dns_not_public');expect(error.dns).toEqual({counts:{benchmark:1,public_v6:1},selected_family:null,selected_class:null,rejected_reason:'replay_dns_not_public'});
});
// Only the HTTP transport is redirected to localhost; DNS guard behavior is tested above.
async function localServer(handler:any,run:(url:string)=>Promise<void>){
 const server=http.createServer(handler);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const address=server.address();if(!address||typeof address==='string')throw Error('address');
 const get=http.get.bind(http);
 vi.spyOn(http,'get').mockImplementation(((_url:any,options:any,cb:any)=>get(`http://127.0.0.1:${address.port}/`,{signal:options.signal},cb)) as any);
 try{await run('http://replay184.valve.net/570/42_1.dem.bz2');}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
}
it('surfaces 302 without connecting to a private or off-allowlist Location',async()=>{
 for(const location of ['http://127.0.0.1/private','http://example.com/private']){
  let connections=0;
  await localServer((_req:any,res:any)=>{connections++;res.writeHead(302,{Location:location});res.end();},async url=>{
   const response=await fetchReplay(url);expect(response.status).toBe(302);expect(response.ok).toBe(false);await response.body.cancel();expect(connections).toBe(1);
  });vi.restoreAllMocks();
 }
});
it('persists DNS failure and partial stream diagnostics on durable jobs',async()=>{
 const home=await mkdtemp(join(tmpdir(),'download-test-'));const log=vi.spyOn(console,'error').mockImplementation(()=>{});
 try{
  const ingest=createReplayIngest({env:{REPLAY_HOME:home,REPLAY_INGEST_ENABLED:'1',DOTA_EXTRACT_BIN:'/fake'},fetchImpl:()=>Promise.reject(Object.assign(new Error('replay_dns_not_public'),{dns:{counts:{private:1}}}))});
  if(!('drain' in ingest))throw Error('async required');
  const job=await ingest.submit({match_id:42,cluster:184,replay_salt:1},'ip');await ingest.drain();
  expect(await ingest.jobStore.get(job.jobId)).toMatchObject({status:'cdn_error',dns_reason:'replay_dns_not_public',download_bytes:0,phase:'downloading',url_host:'replay184.valve.net'});
  await localServer((_req:any,res:any)=>{res.writeHead(200);res.write(Buffer.alloc(26040));setTimeout(()=>res.destroy(),30);},async url=>{
   const partial=createReplayIngest({env:{REPLAY_HOME:join(home,'partial'),REPLAY_INGEST_ENABLED:'1',DOTA_EXTRACT_BIN:'/fake'},fetchImpl:(_url:any,options:any)=>fetchReplay(url,options)});
   if(!('drain' in partial))throw Error('async required');
   const j=await partial.submit({match_id:43,cluster:184,replay_salt:1},'ip');await partial.drain();
   expect(await partial.jobStore.get(j.jobId)).toMatchObject({status:'cdn_error',http_status:200,download_bytes:26040,phase:'downloading',stream_error:expect.any(String)});
   expect(log).toHaveBeenCalledWith('replay_download_stream_failed','replay184.valve.net',200,26040,expect.any(String));
  });
 }finally{await rm(home,{recursive:true,force:true});}
});
it('aborts an active HTTP download',async()=>{
 await localServer((_req:any,res:any)=>{res.writeHead(200);res.write('start');},async url=>{
  const controller=new AbortController(),response=await fetchReplay(url,{signal:controller.signal});controller.abort();
  await expect(new Response(response.body).arrayBuffer()).rejects.toThrow();
 });
});
it('batches download byte charges instead of writing on every chunk',async()=>{
 const {createByteCharger}=await import('../../lib/matchReview/replayIngest/worker.js');
 const calls:number[]=[];const charger=createByteCharger(async(n:number)=>{calls.push(n);},{threshold:1000,intervalMs:60_000});
 const pending=charger.add(400);expect(typeof (pending as Promise<void>).then).toBe('function');await pending;await charger.add(400);expect(calls).toEqual([]);
 await charger.add(300);expect(calls).toEqual([1100]);
 await charger.add(50);await charger.flush();expect(calls).toEqual([1100,50]);
});
it('retries GCS 429 before failing a request',async()=>{
 const {createGcsBucket}=await import('../../lib/matchReview/replayIngest/gcs.js');
 let hits=0;
 const fetchImpl=vi.fn(async()=>{hits+=1;if(hits<3)return new Response('slow',{status:429});return new Response(JSON.stringify({generation:1,name:'o'}),{status:200,headers:{'Content-Type':'application/json'}});});
 const bucket=createGcsBucket('test-bucket',{fetchImpl,tokenProvider:async()=>'tok'});
 const [meta]=await bucket.file('jobs/state.json').getMetadata();
 expect(meta.generation).toBe(1);expect(hits).toBe(3);
});
it('every add call is thenable even when the batch does not flush',async()=>{
 const {createByteCharger}=await import('../../lib/matchReview/replayIngest/worker.js');
 const calls:number[]=[];
 const charger=createByteCharger(async(n:number)=>{calls.push(n);},{threshold:10_000,intervalMs:60_000});
 const results=await Promise.all([charger.add(1),charger.add(2),charger.add(3)]);
 expect(results).toEqual([undefined,undefined,undefined]);
 expect(calls).toEqual([]);
 await charger.flush();
 expect(calls).toEqual([6]);
});
