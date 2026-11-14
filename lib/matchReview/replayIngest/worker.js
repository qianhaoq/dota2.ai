import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createReplayIngest as createParser} from './legacy.js';
import {verifyNewArtifact} from './verify.js';
import {fetchReplay} from './download.js';
export function createByteCharger(charge,{threshold=1_048_576,intervalMs=2000}={}){let pending=0,last=Date.now();async function flush(){const n=pending;if(!n)return;pending=0;last=Date.now();try{await charge(n);}catch(error){if(error?.message!=='resource_limited')pending+=n;throw error;}}return {add(bytes){pending+=bytes;if(pending>=threshold||Date.now()-last>=intervalMs)return flush();return Promise.resolve();},flush};}
export function createChargeQueue(){let tail=Promise.resolve();return function enqueue(task){const run=tail.then(()=>task(),()=>task());tail=run.then(()=>{},()=>{});return run;};}
export async function commitElapsedCharge(charge,started,chargedSeconds,now=Date.now){const seconds=(now()-started)/1000;const delta=seconds-chargedSeconds;if(delta<=0)return chargedSeconds;try{await charge({workerSeconds:delta});return seconds;}catch(error){if(error?.message==='resource_limited')throw Object.assign(error,{advancedTo:seconds});throw error;}}
export function createWorker({jobStore,artifactStore,env,fetchImpl=fetchReplay,extract,parserOptions={},onError=()=>{}}){
 return async function run({jobId,generation}){
  const job=await jobStore.lease(jobId,generation);if(!job)return false;
  const started=Date.now();let home,chargedSeconds=0;const controller=new AbortController();
  const charger=createByteCharger(bytes=>jobStore.charge(jobId,job.token,{bytes}));
  const account=createChargeQueue();
  async function chargeElapsed(){try{chargedSeconds=await commitElapsedCharge(usage=>jobStore.charge(jobId,job.token,usage),started,chargedSeconds);}catch(error){if(error?.message==='resource_limited'&&Number.isFinite(error.advancedTo))chargedSeconds=error.advancedTo;throw error;}}
  let heartbeatError;const beat=setInterval(()=>{account(async()=>{await jobStore.heartbeat(jobId,job.token);await chargeElapsed();}).catch(e=>{heartbeatError=e;controller.abort(e);});},Math.max(10,Math.min(20000,Math.floor(jobStore.leaseMs/3))));
  async function settleElapsed(){clearInterval(beat);await account(()=>chargeElapsed());}
  try {
   home=await mkdtemp(join(tmpdir(),'replay-worker-'));
   const parser=createParser({...parserOptions,env:{...env,REPLAY_HOME:home,REPLAY_INGEST_ENABLED:'1'},fetchImpl,extract,strictVerification:true,
    onPhase:status=>jobStore.update(jobId,job.token,{status}),onDownload:bytes=>charger.add(bytes)});
   const result=await parser.submit(job.raw,'worker',{signal:controller.signal});
   if(heartbeatError)throw heartbeatError;
   if(result.status!=='replay_parsed'){
    const failure=await parser.read(job.matchId);
    throw Object.assign(new Error(result.status),{status:result.status,diagnostics:failure});
   }
   const artifact=verifyNewArtifact(job.raw,await parser.read(job.matchId));
   await settleElapsed();
   await charger.flush();
   const pointer=await artifactStore.put(job.matchId,generation,artifact);
   await jobStore.publish(jobId,job.token,pointer);return true;
  } catch(e){
   try{onError(e);}catch{}
   await charger.flush().catch(()=>{});
   const states={replay_unavailable:'unavailable',replay_expired:'expired',replay_cdn_error:'cdn_error',replay_invalid_url:'invalid',throttled:'throttled',invalid:'invalid',resource_limited:'resource_limited'};
   await settleElapsed().catch(()=>{});
   const diagnostics={};for(const key of ['last_error','http_status','download_bytes','url_host','dns_reason','stream_error','phase']){const value=e.diagnostics?.[key];if(typeof value==='string'||typeof value==='number'&&Number.isFinite(value))diagnostics[key]=value;}
   await jobStore.update(jobId,job.token,{status:states[e.status??e.message]??'failed',last_error:String(e?.message||e),...diagnostics}).catch(()=>{});return false;
  } finally{clearInterval(beat);await account(async()=>{});if(home)await rm(home,{recursive:true,force:true});}
 };
}
