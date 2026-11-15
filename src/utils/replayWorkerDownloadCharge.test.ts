import {it,expect,vi,afterEach} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileJobStore} from '../../lib/matchReview/replayIngest/jobStore.js';
import {createWorker} from '../../lib/matchReview/replayIngest/worker.js';
import {createReplayIngest} from '../../lib/matchReview/replayIngest/legacy.js';

afterEach(()=>vi.restoreAllMocks());

it('does not extract after a scheduled download charge hits the budget',async()=>{
 const home=await mkdtemp(join(tmpdir(),'worker-download-limit-'));
 try{
  const store=new FileJobStore(home,{budgets:{bytes:1000}});
  Object.assign(store.state,{minWriteIntervalMs:1});
  const raw={match_id:42,replay_url:'https://replay413.dota2.com.cn/570/42_1.dem.bz2',cluster:413,replay_salt:1,duration:100,players:[]};
  const job=await store.create(raw,'ip');
  const extract=vi.fn(async()=>{throw new Error('extract_should_not_run');});
  const fetchImpl=vi.fn(async()=>new Response(Buffer.alloc(1_048_576)));
  const put=vi.fn();
  const publish=vi.spyOn(store,'publish');
  const ok=await createWorker({
   jobStore:store,
   artifactStore:{put},
   extract,
   fetchImpl,
   env:{REPLAY_HOME:join(home,'parser'),REPLAY_INGEST_ENABLED:'1',DOTA_EXTRACT_BIN:'/fake'},
   onError:()=>{},
  })(job);
  expect(ok).toBe(false);
  expect(extract).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
  expect(await store.get(job.jobId)).toMatchObject({status:'resource_limited'});
 }finally{await rm(home,{recursive:true,force:true});}
});

it('records resource_limited when cleanup flush retries a dropped over-budget charge',async()=>{
 const home=await mkdtemp(join(tmpdir(),'worker-cleanup-limit-'));
 try{
  const store=new FileJobStore(home,{budgets:{bytes:1000}});
  Object.assign(store.state,{minWriteIntervalMs:1});
  const raw={match_id:42,replay_url:'https://replay413.dota2.com.cn/570/42_1.dem.bz2',cluster:413,replay_salt:1,duration:100,players:[]};
  const job=await store.create(raw,'ip');
  let releaseSecond!:()=>void;
  const second=new Promise<void>(resolve=>{releaseSecond=resolve;});
  const transaction=store.state.transaction.bind(store.state);
  let droppedOnce=false;
  vi.spyOn(store.state,'transaction').mockImplementation(async(fn:any)=>{
   const result=await transaction(fn);
   if(!droppedOnce&&(await store.state.read()).jobs[job.jobId].appliedCharges?.length){
    droppedOnce=true;
    setTimeout(()=>releaseSecond(),20);
    throw new Error('gcs_request_failed');
   }
   return result;
  });
  const {Readable}=await import('node:stream');
  const fetchImpl=vi.fn(async()=>{
   const stream=new Readable({read(){}});
   queueMicrotask(()=>stream.push(Buffer.alloc(1_048_576)));
   second.then(()=>{stream.push(Buffer.alloc(65536));stream.push(null);});
   return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>);
  });
  const extract=vi.fn(async()=>{throw new Error('extract_should_not_run');});
  const put=vi.fn();
  const publish=vi.spyOn(store,'publish');
  const charge=vi.spyOn(store,'charge');
  const ok=await createWorker({
   jobStore:store,
   artifactStore:{put},
   extract,
   fetchImpl,
   env:{REPLAY_HOME:join(home,'parser'),REPLAY_INGEST_ENABLED:'1',DOTA_EXTRACT_BIN:'/fake'},
   onError:()=>{},
  })(job);
  expect(ok).toBe(false);
  expect(extract).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
  expect(await store.get(job.jobId)).toMatchObject({status:'resource_limited',last_error:'resource_limited',http_status:200,download_bytes:1_048_576+65536,phase:'downloading',stream_error:'gcs_request_failed'});
  const byteCharges=charge.mock.calls.filter(([, ,usage]:any)=>usage?.bytes);
  expect(byteCharges.length).toBe(2);
  expect(byteCharges[1]).toEqual(byteCharges[0]);
  const state=await store.state.read();
  const ticket=byteCharges[0][2].chargeId;
  expect(Object.values(state.budget)[0]).toMatchObject({bytes:1_048_576});
  expect(state.jobs[job.jobId].appliedCharges.filter((id:string)=>id===ticket)).toHaveLength(1);
 }finally{await rm(home,{recursive:true,force:true});}
});

it('records resource_limited when a prior store abort remains on the worker signal',async()=>{
 const home=await mkdtemp(join(tmpdir(),'worker-signal-limit-'));
 try{
  const frozen=Date.now();vi.spyOn(Date,'now').mockReturnValue(frozen);
  const store=new FileJobStore(home,{budgets:{bytes:1000},leaseMs:30});
  Object.assign(store.state,{minWriteIntervalMs:1});
  const raw={match_id:42,replay_url:'https://replay413.dota2.com.cn/570/42_1.dem.bz2',cluster:413,replay_salt:1,duration:100,players:[]};
  const job=await store.create(raw,'ip');
  let releaseSecond!:()=>void;
  const second=new Promise<void>(resolve=>{releaseSecond=resolve;});
  const transaction=store.state.transaction.bind(store.state);
  let droppedOnce=false;
  vi.spyOn(store.state,'transaction').mockImplementation(async(fn:any)=>{
   const result=await transaction(fn);
   if(!droppedOnce&&(await store.state.read()).jobs[job.jobId].appliedCharges?.length){
    droppedOnce=true;
    setTimeout(()=>releaseSecond(),20);
    throw new Error('gcs_request_failed');
   }
   return result;
  });
  const heartbeat=store.heartbeat.bind(store);
  vi.spyOn(store,'heartbeat').mockImplementation(async(...args:any[])=>{
   if(droppedOnce)throw new Error('gcs_request_failed');
   return heartbeat(...args);
  });
  const {Readable}=await import('node:stream');
  const fetchImpl=vi.fn(async()=>{
   const stream=new Readable({read(){}});
   queueMicrotask(()=>stream.push(Buffer.alloc(1_048_576)));
   second.then(()=>{stream.push(Buffer.alloc(65536));stream.push(null);});
   return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>);
  });
  const extract=vi.fn(async()=>{throw new Error('extract_should_not_run');});
  const put=vi.fn();
  const publish=vi.spyOn(store,'publish');
  const charge=vi.spyOn(store,'charge');
  const ok=await createWorker({
   jobStore:store,
   artifactStore:{put},
   extract,
   fetchImpl,
   env:{REPLAY_HOME:join(home,'parser'),REPLAY_INGEST_ENABLED:'1',DOTA_EXTRACT_BIN:'/fake'},
   onError:()=>{},
  })(job);
  expect(ok).toBe(false);
  expect(extract).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
  expect(await store.get(job.jobId)).toMatchObject({status:'resource_limited',last_error:'resource_limited'});
  const byteCharges=charge.mock.calls.filter(([, ,usage]:any)=>usage?.bytes);
  expect(byteCharges.length).toBe(2);
  expect(byteCharges[1]).toEqual(byteCharges[0]);
  const state=await store.state.read();
  expect(Object.values(state.budget)[0]).toMatchObject({bytes:1_048_576});
 }finally{await rm(home,{recursive:true,force:true});}
});

it('does not enter verifying if the download stage aborts during the tail flush',async()=>{
 const home=await mkdtemp(join(tmpdir(),'tail-flush-abort-'));
 try{
  const phases:string[]=[];
  let started!:()=>void;const start=new Promise<void>(resolve=>{started=resolve;});
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
  const controller=new AbortController();
  const extract=vi.fn(async()=>{throw new Error('extract_should_not_run');});
  const ingest=createReplayIngest({
   env:{REPLAY_HOME:home,REPLAY_INGEST_ENABLED:'1',DOTA_EXTRACT_BIN:'/fake'},
   fetchImpl:async()=>new Response(Buffer.alloc(8192)),
   extract,
   onPhase:((name:string)=>{phases.push(name);}) as ()=>Promise<void>,
   onDownloaded:async()=>{started();controller.abort(new Error('stage_timeout'));await held;},
  });
  const raw={match_id:42,replay_url:'https://replay413.dota2.com.cn/570/42_1.dem.bz2',cluster:413,replay_salt:1,players:[]};
  const pending=ingest.submit(raw,'client',{signal:controller.signal});
  await start;release();
  await expect(pending).rejects.toThrow('stage_timeout');
  expect(phases).toEqual(['discovering','downloading']);
  expect(extract).not.toHaveBeenCalled();
 }finally{await rm(home,{recursive:true,force:true});}
});
