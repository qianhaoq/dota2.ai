import {createHash} from 'node:crypto';
import {FileState,GcsState} from './storage.js';
export const DEFAULT_BUDGETS={dailyJobs:100,ipTenMinutes:3,hourlyJobs:60,attempts:150,bytes:25_600_000_000,workerSeconds:72000};
export const activeStates=['queued','discovering','downloading','verifying','extracting','compacting'];
export class JobStore {
 constructor(state,{now=Date.now,budgets={},leaseMs=900000}={}){this.state=state;this.now=now;this.budgets={...DEFAULT_BUDGETS,...budgets};this.leaseMs=leaseMs;}
 async get(id){return (await this.state.read()).jobs?.[id]??null;}
 async list(){return Object.values((await this.state.read()).jobs??{});}
 async create(raw,client){const now=this.now(),ip=createHash('sha256').update(client).digest('hex');return this.state.transaction(s=>{
  s.jobs??={};s.budget??={};const id=String(raw.match_id),prior=s.jobs[id];
  if(prior&&(activeStates.includes(prior.status)||prior.pointer))return {...prior,attached:true};
  const day=String(Math.floor(now/86400000));const b=s.budget[day]??={jobs:[],attempts:0,bytes:0,workerSeconds:0};
  const over=b.jobs.length>=this.budgets.dailyJobs||b.jobs.filter(j=>j.at>now-3600000).length>=this.budgets.hourlyJobs||b.jobs.filter(j=>j.ip===ip&&j.at>now-600000).length>=this.budgets.ipTenMinutes||b.attempts>=this.budgets.attempts||b.bytes>=this.budgets.bytes||b.workerSeconds>=this.budgets.workerSeconds;
  if(over)return {jobId:id,status:'throttled'};
  b.jobs.push({at:now,ip});const generation=(prior?.generation??0)+1;
  return s.jobs[id]={jobId:id,matchId:raw.match_id,raw,generation,status:'queued',createdAt:now,enqueue_pending:true,taskName:`replay-${id}-${generation}`,token:prior?.token??0};
 });}
 async enqueued(id,generation){return this.state.transaction(s=>{const j=s.jobs?.[id];if(j?.generation===generation)j.enqueue_pending=false;});}
 async lease(id,generation){return this.state.transaction(s=>{const j=s.jobs?.[id],now=this.now();if(!j||j.generation!==generation||!activeStates.includes(j.status)||j.leaseUntil>now)return null;
  const day=String(Math.floor(now/86400000));const b=s.budget[day]??={jobs:[],attempts:0,bytes:0,workerSeconds:0};
  if(b.attempts>=this.budgets.attempts||b.bytes>=this.budgets.bytes||b.workerSeconds>=this.budgets.workerSeconds){j.status='resource_limited';return null;}
  b.attempts++;j.token++;j.leaseUntil=now+this.leaseMs;j.attemptDay=day;return {...j};});}
 async update(id,token,patch){return this.state.transaction(s=>{const j=s.jobs?.[id];if(!j||j.token!==token||j.leaseUntil<=this.now())throw new Error('stale_lease');if(j.pointer&&patch.status!=='ready')return j;Object.assign(j,patch);return {...j};});}
 async heartbeat(id,token){return this.update(id,token,{leaseUntil:this.now()+this.leaseMs});}
 async charge(id,token,{bytes=0,workerSeconds=0}) {const over=await this.state.transaction(s=>{const j=s.jobs?.[id];if(!j||j.token!==token||j.leaseUntil<=this.now())throw new Error('stale_lease');const b=s.budget[j.attemptDay];b.bytes+=bytes;b.workerSeconds+=workerSeconds;return b.bytes>this.budgets.bytes||b.workerSeconds>this.budgets.workerSeconds;});if(over)throw new Error('resource_limited');}
 async maintain(){return this.state.transaction(s=>{for(const [id,j] of Object.entries(s.jobs??{})){if(j.pointer&&j.publishedAt+90*86400000<=this.now()){delete j.pointer;j.status='expired';}if(!activeStates.includes(j.status)&&j.createdAt+30*86400000<=this.now())delete j.raw;}for(const day of Object.keys(s.budget??{}))if(Number(day)<Math.floor(this.now()/86400000)-1)delete s.budget[day];});}
 async expire(id,generation){return this.state.transaction(s=>{const j=s.jobs?.[id];if(j?.generation===generation&&j.pointer){delete j.pointer;j.status='expired';}});}
 async publish(id,token,pointer){return this.update(id,token,{pointer,publishedAt:this.now(),status:'ready',enqueue_pending:false});}
}
export class FileJobStore extends JobStore {constructor(home,options){super(new FileState(home),options);}}
export class GcsJobStore extends JobStore {constructor(bucket,options){super(new GcsState(bucket),options);}}
