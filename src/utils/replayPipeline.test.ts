import {it,expect,afterEach,vi} from 'vitest';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileJobStore} from '../../lib/matchReview/replayIngest/jobStore.js';
import {FileArtifactStore} from '../../lib/matchReview/replayIngest/artifactStore.js';
import {FileQueue} from '../../lib/matchReview/replayIngest/queue.js';
import {reconcile} from '../../lib/matchReview/replayIngest/reconciler.js';
import {createReplayIngest} from '../../lib/matchReview/replayIngest/index.js';
import {verifyNewArtifact} from '../../lib/matchReview/replayIngest/verify.js';
const dirs:string[]=[];
async function home(){const dir=await mkdtemp(join(tmpdir(),'pipeline-'));dirs.push(dir);return dir;}
afterEach(async()=>{await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
it('durably attaches duplicates, recovers an outbox and fences a crashed worker',async()=>{
 let now=100;const dir=await home();const jobs=new FileJobStore(join(dir,'jobs'),{now:()=>now,leaseMs:1000});const queue=new FileQueue(join(dir,'queue'));
 const raw={match_id:42};const a=await jobs.create(raw,'ip');const b=await jobs.create(raw,'ip');expect(b.jobId).toBe(a.jobId);expect(b.attached).toBe(true);
 // Recreate all clients, as if the submit process exited before enqueue.
 const restarted=new FileJobStore(join(dir,'jobs'),{now:()=>now,leaseMs:1000});await reconcile({jobStore:restarted,queue,now:()=>now});
 await reconcile({jobStore:restarted,queue,now:()=>now});expect(await queue.pending()).toHaveLength(1);
 const first=await jobs.lease(a.jobId,a.generation);expect(first).toBeTruthy();expect(await jobs.lease(a.jobId,a.generation)).toBeNull();
 now+=1001;const second=await restarted.lease(a.jobId,a.generation);expect(second.token).toBeGreaterThan(first.token);
 await expect(jobs.publish(a.jobId,first.token,{generation:1})).rejects.toThrow('stale_lease');
 await restarted.publish(a.jobId,second.token,{generation:1,sha256:'good'});
 await restarted.update(a.jobId,second.token,{status:'failed'});expect((await jobs.get(a.jobId)).status).toBe('ready');
 expect((await jobs.create(raw,'ip')).attached).toBe(true);
});
it('enforces each adjudicated budget with injectable thresholds',async()=>{
 for(const budget of ['dailyJobs','hourlyJobs','ipTenMinutes','attempts','bytes','workerSeconds']){
  const jobs=new FileJobStore(await home(),{budgets:{[budget]:0}});expect((await jobs.create({match_id:1},'ip')).status).toBe('throttled');
 }
 const jobs=new FileJobStore(await home(),{budgets:{bytes:5}});const j=await jobs.create({match_id:1},'ip'),lease=await jobs.lease(j.jobId,j.generation);
 await expect(jobs.charge(j.jobId,lease.token,{bytes:6})).rejects.toThrow('resource_limited');
 expect((await jobs.create({match_id:2},'ip')).status).toBe('throttled');
});
it('counts rolling IP limits across a UTC midnight boundary',async()=>{
 let now=86400000-1000;const jobs=new FileJobStore(await home(),{now:()=>now});
 expect((await jobs.create({match_id:1},'same-ip')).status).toBe('queued');
 expect((await jobs.create({match_id:2},'same-ip')).status).toBe('queued');
 expect((await jobs.create({match_id:3},'same-ip')).status).toBe('queued');
 now+=2000;
 expect((await jobs.create({match_id:4},'same-ip')).status).toBe('throttled');
});
it('counts rolling hourly limits across a UTC midnight boundary',async()=>{
 let now=86400000-2000;const jobs=new FileJobStore(await home(),{now:()=>now,budgets:{dailyJobs:100,ipTenMinutes:100,hourlyJobs:2}});
 expect((await jobs.create({match_id:1},'ip-a')).status).toBe('queued');
 expect((await jobs.create({match_id:2},'ip-b')).status).toBe('queued');
 now+=3000;
 expect((await jobs.create({match_id:3},'ip-c')).status).toBe('throttled');
});

it('resets daily job, attempt, and byte caps at the UTC day boundary',async()=>{
 let now=86400000-1000;
 const jobs=new FileJobStore(await home(),{now:()=>now,budgets:{dailyJobs:1,hourlyJobs:100,ipTenMinutes:100,attempts:1,bytes:10,workerSeconds:10},leaseMs:1000});
 const first=await jobs.create({match_id:1},'ip-a');
 expect(first.status).toBe('queued');
 expect((await jobs.create({match_id:2},'ip-b')).status).toBe('throttled');
 const lease=await jobs.lease(first.jobId,first.generation);
 await jobs.charge(first.jobId,lease.token,{bytes:10,workerSeconds:10});
 await expect(jobs.charge(first.jobId,lease.token,{bytes:1})).rejects.toThrow('resource_limited');
 now+=2000;
 expect((await jobs.create({match_id:2},'ip-b')).status).toBe('queued');
 now+=1001;
 const next=await jobs.lease(String(2),1);
 expect(next).toBeTruthy();
 await jobs.charge(next.jobId,next.token,{bytes:10,workerSeconds:10});
});
it('re-leases a downloading job after the worker lease expires, without starting a new generation',async()=>{
 let now=1000;const jobs=new FileJobStore(await home(),{now:()=>now,leaseMs:1000});
 const j=await jobs.create({match_id:11},'ip');
 const first=await jobs.lease(j.jobId,j.generation);
 await jobs.update(j.jobId,first.token,{status:'downloading'});
 expect(await jobs.lease(j.jobId,j.generation)).toBeNull();
 expect((await jobs.create({match_id:11},'ip')).attached).toBe(true);
 expect((await jobs.get(j.jobId)).generation).toBe(1);
 now+=1001;
 const second=await jobs.lease(j.jobId,j.generation);
 expect(second.token).toBeGreaterThan(first.token);
 expect(second.generation).toBe(1);
 expect(second.status).toBe('downloading');
 await jobs.publish(j.jobId,second.token,{generation:1,sha256:'recovered'});
 expect((await jobs.get(j.jobId)).status).toBe('ready');
});

it('keeps artifacts immutable and verifies checksums',async()=>{
 const dir=await home(),store=new FileArtifactStore(dir);const p=await store.put(1,1,{test:'verified'});expect(await store.read(p)).toEqual({test:'verified'});expect(await store.put(1,1,{test:'verified'})).toEqual(p);
 await writeFile(join(dir,`1-1-${p.sha256}.json`),'{}');await expect(store.read(p)).rejects.toThrow('artifact_checksum');
});
it('async submission survives caller abort, never downloads on read, and runs independently',async()=>{
 const dir=await home(),fetchImpl=vi.fn(async()=>new Response(null,{status:404}));
 const ingest=createReplayIngest({env:{REPLAY_HOME:dir,REPLAY_INGEST_ENABLED:'1',DOTA_EXTRACT_BIN:'/fake'},fetchImpl});
 if(!('drain' in ingest))throw new Error('async pipeline required');
 const controller=new AbortController();controller.abort();const a=await ingest.submit({match_id:42,players:[],cluster:1,replay_salt:1},'ip',{signal:controller.signal});
 expect(a).toMatchObject({jobId:'42',job_status:'queued'});await ingest.overlay({match_id:42});expect(fetchImpl).not.toHaveBeenCalled();
 expect((await ingest.submit({match_id:42},'ip')).jobId).toBe(a.jobId);await ingest.drain();expect(fetchImpl).toHaveBeenCalledTimes(1);expect((await ingest.jobStore.get(a.jobId)).status).toBe('expired');
});
it('requires new-download identity and clock; fort discrepancy only makes timing partial',()=>{
 const raw={match_id:1,duration:100,players:[{hero_id:60,player_slot:132}]};
 const a={extractor_match_id:1,trace_version:4,clock:{unit:'seconds',zero:'horn_game_start',name:'server_tick_pause_adjusted',tick_interval:1/30,game_start_time:200},players:[{hero_id:60,player_slot:132,extractor_hero_key:'npc_dota_hero_night_stalker'}],objectives:[{key:'npc_dota_badguys_fort',time:105}]};
 expect(verifyNewArtifact(raw,a).timed_review).toBe('full');expect(verifyNewArtifact(raw,{...a,objectives:[{key:'npc_dota_badguys_fort',time:106}]}).timed_review).toBe('partial');
 for(const patch of [{extractor_match_id:2},{trace_version:3},{clock:null},{players:[{hero_id:14,player_slot:132}]}])expect(()=>verifyNewArtifact(raw,{...a,...patch})).toThrow('invalid');
});
it('returns HTTP 202 with the durable job id before a worker runs',async()=>{
 const {createReplayIngestHandler}=await import('../../lib/matchReview/replayIngest/endpoint.js');
 const {createRequire}=await import('node:module');const express=createRequire(import.meta.url)('express');const {createServer}=await import('node:http');
 const dir=await home(),fetchImpl=vi.fn(),ingest=createReplayIngest({env:{REPLAY_HOME:dir,REPLAY_INGEST_ENABLED:'1',DOTA_EXTRACT_BIN:'/fake'},fetchImpl});
 const app=express();app.use(express.json());app.post('/api/review/:matchId/replay-ingest',createReplayIngestHandler({ingest,getMatchDetail:async()=>({match_id:42}),resolveClientIp:()=> 'ip'}));
 const server=createServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const addr=server.address();if(!addr||typeof addr==='string')throw new Error('address');
 try{for(let i=0;i<2;i++){const res=await fetch(`http://127.0.0.1:${addr.port}/api/review/42/replay-ingest`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});expect(res.status).toBe(202);expect(await res.json()).toMatchObject({jobId:'42',job_status:'queued'});}expect(fetchImpl).not.toHaveBeenCalled();}
 finally{await new Promise<void>(r=>server.close(()=>r()));}
});
it('releases a filesystem transaction on process death',async()=>{
 const {spawn}=await import('node:child_process');const dir=await home();
 const moduleUrl=new URL('../../lib/matchReview/replayIngest/storage.js',import.meta.url).href;
 const child=spawn(process.execPath,['--input-type=module','-e',`import {FileState} from ${JSON.stringify(moduleUrl)};await new FileState(${JSON.stringify(dir)}).transaction(async()=>{process.stdout.write('locked');await new Promise(()=>{});});`],{stdio:['ignore','pipe','pipe']});
 await new Promise<void>((r,j)=>{child.once('error',j);child.stdout.once('data',()=>r());});child.kill('SIGKILL');await new Promise(r=>child.once('exit',r));
 const jobs=new FileJobStore(dir);expect((await jobs.create({match_id:42},'ip')).status).toBe('queued');
});
it('expires publication pointers and purges old job details without dropping active jobs',async()=>{
 let now=100;const dir=await home();const jobs=new FileJobStore(dir,{now:()=>now});const j=await jobs.create({match_id:1,players:[]},'ip');const l=await jobs.lease(j.jobId,j.generation);await jobs.publish(j.jobId,l.token,{generation:1});
 now+=31*86400000;await jobs.maintain();expect((await jobs.get(j.jobId)).raw).toBeUndefined();expect((await jobs.get(j.jobId)).pointer).toBeTruthy();
 now+=60*86400000;await jobs.maintain();expect((await jobs.get(j.jobId)).pointer).toBeUndefined();expect((await jobs.get(j.jobId)).status).toBe('expired');
 expect((await jobs.create({match_id:1},'ip')).generation).toBe(2);
});
it('reads hard caps from environment and throttles the fourth daily job',async()=>{
 const dir=await home();
 const ingest=createReplayIngest({env:{REPLAY_HOME:dir,REPLAY_INGEST_ENABLED:'1',DOTA_EXTRACT_BIN:'/fake',REPLAY_BUDGET_DAILY_JOBS:'3',REPLAY_BUDGET_ATTEMPTS:'3',REPLAY_BUDGET_BYTES:'768000000',REPLAY_BUDGET_WORKER_SECONDS:'2700'}});
 if(!('drain' in ingest))throw new Error('async pipeline required');
 expect((await ingest.submit({match_id:1},'ip-a')).job_status).toBe('queued');
 expect((await ingest.submit({match_id:2},'ip-b')).job_status).toBe('queued');
 expect((await ingest.submit({match_id:3},'ip-c')).job_status).toBe('queued');
 expect((await ingest.submit({match_id:4},'ip-d')).job_status).toBe('throttled');
});
it('enables web submit from a shared bucket without an extractor binary',async()=>{
 const dir=await home();
 const ingest=createReplayIngest({env:{REPLAY_INGEST_ENABLED:'1',REPLAY_GCS_BUCKET:'test-bucket'},jobStore:new FileJobStore(join(dir,'jobs')),artifactStore:new FileArtifactStore(join(dir,'artifacts')),queue:new FileQueue(join(dir,'queue'))});
 if(!('drain' in ingest))throw new Error('bucket-backed submit required');
 const submitted=await ingest.submit({match_id:99,cluster:1,replay_salt:1},'ip');
 expect(submitted).toMatchObject({jobId:'99',job_status:'queued'});
});
it('IAM-dispatches the private worker after enqueue and keeps 202 if dispatch fails',async()=>{
 const dir=await home();
 const calls:string[]=[];
 const dispatchFetch=vi.fn(async(url:string,init?:RequestInit)=>{
  calls.push(`${init?.method??'GET'} ${url}`);
  if(String(url).includes('/identity?'))return new Response('identity-token',{status:200});
  if(String(url).endsWith('/run'))return new Response('retry',{status:500});
  return new Response('no',{status:404});
 });
 const ingest=createReplayIngest({env:{REPLAY_HOME:dir,REPLAY_INGEST_ENABLED:'1',REPLAY_WORKER_URL:'https://worker.example.run.app'},dispatchFetch,jobStore:new FileJobStore(join(dir,'jobs')),artifactStore:new FileArtifactStore(join(dir,'artifacts')),queue:new FileQueue(join(dir,'queue'))});
 const submitted=await ingest.submit({match_id:7},'ip');
 expect(submitted).toMatchObject({jobId:'7',job_status:'queued',dispatch_error:'worker_dispatch_failed'});
 expect(calls).toEqual([
  'GET http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=https%3A%2F%2Fworker.example.run.app',
  'POST https://worker.example.run.app/run',
 ]);
});
it('selects a public IPv4 even when official DNS also returns AAAA',async()=>{
 const {selectPublicReplayAddress,isPublicReplayV4}=await import('../../lib/matchReview/replayIngest/download.js');
 expect(isPublicReplayV4('198.18.0.1')).toBe(false);
 expect(isPublicReplayV4('10.0.0.1')).toBe(false);
 expect(selectPublicReplayAddress([{address:'2600:1f18::1',family:6}])).toEqual({address:'2600:1f18::1',family:6});
 expect(selectPublicReplayAddress([{address:'198.18.0.1',family:4}])).toBeNull();
 const mixed=selectPublicReplayAddress([{address:'2600:1f18::1',family:6},{address:'155.133.248.1',family:4}]);
 expect(mixed).toEqual({address:'155.133.248.1',family:4});
 expect(selectPublicReplayAddress([{address:'198.18.0.1',family:4},{address:'2600:1f18::1',family:6}])).toBeNull();
});

it('still reads a published artifact after ingestion is disabled',async()=>{
 const dir=await home();
 const enabled=createReplayIngest({env:{REPLAY_HOME:dir,REPLAY_INGEST_ENABLED:'1',DOTA_EXTRACT_BIN:'/fake'}});
 if(!('jobStore' in enabled)||!('artifactStore' in enabled)||!('queue' in enabled))throw new Error('async pipeline required');
 const jobs=enabled.jobStore,artifacts=enabled.artifactStore;
 const j=await jobs.create({match_id:88,players:[]},'ip');const l=await jobs.lease(j.jobId,j.generation);
 const pointer=await artifacts.put(88,j.generation,{extractor_match_id:88,trace_version:4,players:[]});
 await jobs.publish(j.jobId,l.token,pointer);
 const disabled=createReplayIngest({env:{REPLAY_HOME:dir,REPLAY_INGEST_ENABLED:'0'},jobStore:jobs,artifactStore:artifacts,queue:enabled.queue});
 expect(disabled.enabled).toBe(false);
 const artifact=await disabled.read(88);
 expect(artifact).toMatchObject({extractor_match_id:88,generation:pointer.generation});
 const overlay=await disabled.overlay({match_id:88,players:[]});
 expect(overlay.replay_generation).toBe(pointer.generation);
 expect(overlay.replay_ingest_available).toBe(false);
 expect((await disabled.submit({match_id:89},'ip')).status).toBe('replay_ingest_disabled');
});
it('charges bytes and worker seconds to the UTC day they actually accrue',async()=>{
 let now=86400000-1000;
 const jobs=new FileJobStore(await home(),{now:()=>now,budgets:{dailyJobs:10,hourlyJobs:100,ipTenMinutes:100,attempts:10,bytes:10,workerSeconds:10},leaseMs:10_000});
 const first=await jobs.create({match_id:1},'ip-a');
 const lease=await jobs.lease(first.jobId,first.generation);
 await jobs.charge(first.jobId,lease.token,{bytes:10,workerSeconds:10});
 now+=2000;
 await jobs.charge(first.jobId,lease.token,{bytes:5,workerSeconds:5});
 const second=await jobs.create({match_id:2},'ip-b');
 expect(second.status).toBe('queued');
 const next=await jobs.lease(second.jobId,second.generation);
 await expect(jobs.charge(next.jobId,next.token,{bytes:6,workerSeconds:6})).rejects.toThrow('resource_limited');
});

it('keeps the default-home file store when only ingest is disabled',()=>{
 const disabled=createReplayIngest({env:{REPLAY_INGEST_ENABLED:'0'}});
 expect(disabled.enabled).toBe(false);
 expect('jobStore' in disabled).toBe(true);
 expect('artifactStore' in disabled).toBe(true);
});
