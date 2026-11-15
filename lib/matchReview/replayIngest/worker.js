import {isStoreFailure} from './storeFailure.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createReplayIngest as createParser} from './legacy.js';
import {verifyNewArtifact} from './verify.js';
import {sanitizeExtractorDiagnostic,pickExtractorDiagnostics} from './extractor.js';
import {fetchReplay} from './download.js';
export function createByteCharger(charge,{threshold=1_048_576,intervalMs=2000}={}){
 let pending=0,last=Date.now(),running;
 async function flush(){
  if(running){await running;return flush();}
  const n=pending;if(!n)return;pending=0;last=Date.now();
  running=Promise.resolve().then(()=>charge(n));
  try{await running;}catch(error){if(error?.message!=='resource_limited')pending+=n;throw error;}finally{running=undefined;}
 }
 return {add(bytes){pending+=bytes;if(pending>=threshold||Date.now()-last>=intervalMs)return flush();return Promise.resolve();},flush};
}
export function createChargeQueue(){let tail=Promise.resolve();return function enqueue(task){const run=tail.then(()=>task(),()=>task());tail=run.then(()=>{},()=>{});return run;};}
export async function commitElapsedCharge(charge,started,chargedSeconds,now=Date.now){const seconds=(now()-started)/1000;const delta=seconds-chargedSeconds;if(delta<=0)return chargedSeconds;try{await charge({workerSeconds:delta});return seconds;}catch(error){if(error?.message==='resource_limited')throw Object.assign(error,{advancedTo:seconds});throw error;}}
export function createWorker({jobStore,artifactStore,env,fetchImpl=fetchReplay,extract,parserOptions={},onError=()=>{}}){
 return async function run({jobId,generation}){
  const job=await jobStore.lease(jobId,generation);if(!job)return false;
  const started=Date.now();let home,chargedSeconds=0,succeeded=false;const controller=new AbortController();
  const charger=createByteCharger(bytes=>jobStore.charge(jobId,job.token,{bytes}));
  const account=createChargeQueue();
  async function chargeElapsed(){try{chargedSeconds=await commitElapsedCharge(usage=>jobStore.charge(jobId,job.token,usage),started,chargedSeconds);}catch(error){if(error?.message==='resource_limited'&&Number.isFinite(error.advancedTo))chargedSeconds=error.advancedTo;throw error;}}
  let heartbeatError;const beat=setInterval(()=>{account(async()=>{await Promise.all([jobStore.heartbeat(jobId,job.token),chargeElapsed()]);}).catch(e=>{heartbeatError=e;controller.abort(e);});},Math.max(10,Math.min(20000,Math.floor(jobStore.leaseMs/3))));
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
   await charger.flush();
   const pointer=await artifactStore.put(job.matchId,generation,artifact);
   clearInterval(beat);await account(()=>chargeElapsed());if(heartbeatError)throw heartbeatError;
   await jobStore.publish(jobId,job.token,pointer);succeeded=true;return true;
  } catch(e){
   clearInterval(beat);
   try{onError(e);}catch{}
   await charger.flush().catch(()=>{});
   const states={replay_store_error:'store_error',gcs_request_failed:'store_error',store_contention:'store_error',workload_identity_unavailable:'store_error',replay_unavailable:'unavailable',replay_expired:'expired',replay_cdn_error:'cdn_error',replay_invalid_url:'invalid',throttled:'throttled',invalid:'invalid',resource_limited:'resource_limited'};
   const diagnostics=pickExtractorDiagnostics(e.diagnostics);
   const last_error=sanitizeExtractorDiagnostic(String(diagnostics.last_error||e?.message||e),2048);
   await jobStore.update(jobId,job.token,{status:isStoreFailure(e,controller.signal)?'store_error':states[e.status??e.message]??'failed',last_error,...diagnostics,last_error}).catch(()=>{});return false;
  } finally{clearInterval(beat);if(!succeeded)await account(()=>chargeElapsed()).catch(()=>{});await account(async()=>{});if(home)await rm(home,{recursive:true,force:true});}
 };
}
