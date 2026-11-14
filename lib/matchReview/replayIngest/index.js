import {createGcsBucket} from './gcs.js';
import {GcsState} from './storage.js';
import {join} from 'node:path';
import {createReplayIngest as legacyIngest} from './legacy.js';
import {FileJobStore,GcsJobStore,budgetsFromEnv} from './jobStore.js';
import {FileArtifactStore,GcsArtifactStore} from './artifactStore.js';
import {FileQueue,GcsQueue} from './queue.js';
import {reconcile} from './reconciler.js';
import {createWorker} from './worker.js';
import {createWorkerDispatcher} from './dispatch.js';
import {applyReplayArtifact} from './artifact.js';
import {replayStatusPayload} from '../../../packages/review-engine/src/replay.js';
export {isReplayUrl,replayUrl} from './discovery.js';
const statuses={ready:'replay_parsed',unavailable:'replay_unavailable',expired:'replay_expired',cdn_error:'replay_cdn_error',invalid:'replay_failed',failed:'replay_failed',resource_limited:'replay_failed',throttled:'throttled'};
export function createReplayIngest(options={}){
 const env=options.env??process.env,home=env.REPLAY_HOME||'/tmp/dota2ai-replays';
 const legacy=legacyIngest(options);
 // Existing baked artifacts remain readable; explicit home config supplies the
 // durable local store. Shared cloud stores are injected by the worker host.
 const bucket=env.REPLAY_GCS_BUCKET?createGcsBucket(env.REPLAY_GCS_BUCKET,options.gcsOptions):null;
 const storeOptions={...options.storeOptions,budgets:{...budgetsFromEnv(env),...options.storeOptions?.budgets}};
 const jobStore=options.jobStore??(bucket?new GcsJobStore(bucket,storeOptions):new FileJobStore(join(home,'jobs'),storeOptions));
 const artifactStore=options.artifactStore??(bucket?new GcsArtifactStore(bucket):new FileArtifactStore(join(home,'artifacts')));
 const queue=options.queue??(bucket?new GcsQueue(new GcsState(bucket,'queue/state.json')):new FileQueue(join(home,'queue')));
 // Web submit may enqueue to a shared bucket without bundling the extractor; the
 // designated worker still requires DOTA_EXTRACT_BIN (or COACH_EXTRACT_BIN).
 const asyncEnabled=env.REPLAY_INGEST_ENABLED==='1'&&Boolean(jobStore)&&(legacy.enabled||Boolean(bucket)||Boolean(env.REPLAY_WORKER_URL));
 if(!jobStore)return legacy;
 const worker=createWorker({...options,env,jobStore,artifactStore});
 async function read(id){const job=await jobStore.get(String(id));if(job?.pointer){if(job.publishedAt+90*86400000<=jobStore.now())return {match_id:id,status:'replay_expired',generation:job.generation};try{return {...await artifactStore.read(job.pointer),generation:job.pointer.generation};}catch(e){if(e.code==='ENOENT'||e.code===404)return {match_id:id,status:'replay_expired',generation:job.generation};if(e.message==='artifact_checksum'||e.message==='invalid_pointer'||e instanceof SyntaxError)return {match_id:id,status:'replay_failed',generation:job.generation,reason:e.message||'artifact_invalid'};throw e;}}if(job)return {match_id:id,status:statuses[job.status]??'replay_pending',generation:job.generation};return legacy.read(id);}
 async function overlay(raw){const artifact=await read(raw.match_id);return {...(artifact?applyReplayArtifact(raw,artifact):raw),replay_generation:artifact?.generation??0,replay_ingest_available:asyncEnabled,replay_auto_enabled:asyncEnabled&&env.REPLAY_AUTO_ENABLED==='1'};}
 return {enabled:asyncEnabled,async:true,jobStore,artifactStore,queue,read,overlay,
  /** @param {any} raw @param {string} client @param {{lang?:string,signal?:AbortSignal}} [options] */
  async submit(raw,client,{lang='en'}={}){if(!asyncEnabled)return {...replayStatusPayload('replay_ingest_disabled',lang),ingest_available:false,jobId:null,job_status:'disabled'};const prior=await read(raw.match_id);if(prior?.status==='replay_expired')await jobStore.expire(String(raw.match_id),prior.generation);const job=await jobStore.create(raw,client);if(job.enqueue_pending){await queue.enqueue(job);await jobStore.enqueued(job.jobId,job.generation);}const payload={...replayStatusPayload(statuses[job.status]??'replay_pending',lang),jobId:job.jobId,job_status:job.status,generation:job.generation};if(env.REPLAY_WORKER_URL&&['queued','discovering','downloading','verifying','extracting','compacting'].includes(job.status)){try{await (options.dispatcher??createWorkerDispatcher({env,fetchImpl:options.dispatchFetch??fetch})).dispatch();}catch(error){payload.dispatch_error=error.message;}}return payload;},
  async drain(){if(!asyncEnabled)return;await reconcile({jobStore,queue});for(const task of await queue.pending()){await worker(task);const job=await jobStore.get(task.jobId);if(job&&!['queued','discovering','downloading','verifying','extracting','compacting'].includes(job.status))await queue.ack(task.name);}},
  run:asyncEnabled?worker:async()=>false,
 };
}
