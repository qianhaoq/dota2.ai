import {it,expect,vi,afterEach} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileJobStore} from '../../lib/matchReview/replayIngest/jobStore.js';

// Synthetic parser reaches finalization while its scheduled byte charge is held.
const control=vi.hoisted(()=>({started:Promise.resolve(),artifact:{} as any}));
vi.mock('../../lib/matchReview/replayIngest/legacy.js',()=>({createReplayIngest:({onDownload}:any)=>({
 async submit(){await onDownload(1_048_576);await control.started;return {status:'replay_parsed'};},
 async read(){return control.artifact;}
})}));
import {createWorker} from '../../lib/matchReview/replayIngest/worker.js';
afterEach(()=>vi.restoreAllMocks());
it.each([false,true])('rejects overlapping committed byte limit before put with zero elapsed (dropped response: %s)',async dropped=>{
 const home=await mkdtemp(join(tmpdir(),'worker-limit-'));
 try{
  const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now);
  const store=new FileJobStore(home,{budgets:{bytes:1000}});
  // Enable scheduled charging without changing FileState persistence semantics.
  Object.assign(store.state,{minWriteIntervalMs:1});
  const raw={match_id:42,duration:100,players:[]};
  control.artifact={extractor_match_id:42,trace_version:4,clock:{unit:'seconds',zero:'horn_game_start',name:'server_tick_pause_adjusted',tick_interval:1/30,game_start_time:200},players:[],objectives:[]};
  const job=await store.create(raw,'ip');
  let started!:()=>void,release!:()=>void;
  control.started=new Promise<void>(resolve=>{started=resolve;});
  const held=new Promise<void>(resolve=>{release=resolve;});
  if(dropped){
   const transaction=store.state.transaction.bind(store.state);let droppedOnce=false;
   vi.spyOn(store.state,'transaction').mockImplementation(async(fn:any)=>{
    const result=await transaction(fn);
    if(!droppedOnce&&(await store.state.read()).jobs[job.jobId].appliedCharges?.length){droppedOnce=true;throw new Error('gcs_request_failed');}
    return result;
   });
  }
  const original=store.charge.bind(store);
  const charge=vi.spyOn(store,'charge').mockImplementation(async(id:string,token:number,usage:any)=>{started();await held;return original(id,token,usage);});
  const put=vi.fn(),publish=vi.spyOn(store,'publish');
  const run=createWorker({jobStore:store,artifactStore:{put},extract:vi.fn(),env:{},onError:()=>{}})(job);
  await control.started;
  // Let submit/read/verification enter final flush before rejecting the charge.
  await new Promise(resolve=>setTimeout(resolve,20));release();
  expect(await run).toBe(false);
  expect(put).not.toHaveBeenCalled();expect(publish).not.toHaveBeenCalled();
  expect(await store.get(job.jobId)).toMatchObject({status:'resource_limited'});
  expect(charge).toHaveBeenCalledTimes(dropped?2:1);
  if(dropped)expect(charge.mock.calls[1]).toEqual(charge.mock.calls[0]);
  const state=await store.state.read();
  expect(Object.values(state.budget)[0]).toMatchObject({bytes:1_048_576,workerSeconds:0});
  expect(state.jobs[job.jobId].appliedCharges).toHaveLength(1);
 }finally{await rm(home,{recursive:true,force:true});}
});
