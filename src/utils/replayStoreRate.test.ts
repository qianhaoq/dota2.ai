import {it,expect,vi,afterEach} from 'vitest';
import {createGcsBucket} from '../../lib/matchReview/replayIngest/gcs.js';
import {GcsJobStore} from '../../lib/matchReview/replayIngest/jobStore.js';
import {createByteCharger} from '../../lib/matchReview/replayIngest/worker.js';
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
function fake({failures=[] as number[],cas=false,retryAfter='2'}={}){
 let state:any={},generation=0,active=0,maxActive=0;const saves:number[]=[];
 const fetchImpl=vi.fn(async(input:RequestInfo | URL,options?:RequestInit)=>{const url=String(input);
  if(options?.method==='POST'){
   active++;maxActive=Math.max(maxActive,active);
   try{
    saves.push(Date.now());await Promise.resolve();
    const status=failures.shift();if(status)return new Response('',{status,headers:{'Retry-After':retryAfter}});
    if(cas){cas=false;return new Response('',{status:412});}
    if(saves.length>1&&saves.at(-1)!-saves.at(-2)!<1000)return new Response('',{status:429});
    state=JSON.parse(String(options.body));generation++;return new Response('{}');
   }finally{active--;}
  }
  if(!generation)return new Response('',{status:404});
  return new Response(JSON.stringify(url.includes('alt=media')?state:{generation}));
 });
 const bucket=createGcsBucket('test-bucket',{fetchImpl,tokenProvider:async()=>'secret'});
 return {bucket,saves,failures,conflict(){cas=true;},get state(){return state;},get maxActive(){return maxActive;}};
}
async function clocked<T>(work:()=>Promise<T>){const p=work();await vi.runAllTimersAsync();return p;}
it.each([16384,65536])('backpressures 28MB synthetic chunks of %i at the object write floor',async chunk=>{
 vi.useFakeTimers();const f=fake();const store=new GcsJobStore(f.bucket);
 await clocked(()=>store.create({match_id:42},'ip'));const job=await clocked(()=>store.lease('42',1));
 const charger=createByteCharger((bytes:number)=>store.charge('42',job.token,{bytes}));
 const total=28_442_608;
 await clocked(async()=>{for(let n=0;n<total;n+=chunk)await charger.add(Math.min(chunk,total-n));await charger.flush();});
 expect(f.state.budget[job.attemptDay].bytes).toBe(total);expect(f.maxActive).toBe(1);
 expect(f.saves.every((t,i)=>!i||t-f.saves[i-1]>=1000)).toBe(true);
});
it('coalesces heartbeat, seconds, bytes and phase; CAS retries commit once',async()=>{
 vi.useFakeTimers();const f=fake();const store=new GcsJobStore(f.bucket);
 await clocked(()=>store.create({match_id:42},'ip'));const job=await clocked(()=>store.lease('42',1));
 f.conflict();const before=f.saves.length;vi.setSystemTime(Date.now()+100);
 await clocked(()=>Promise.all([store.charge('42',job.token,{bytes:500,workerSeconds:2}),store.charge('42',job.token,{bytes:700,workerSeconds:3}),store.heartbeat('42',job.token),store.update('42',job.token,{status:'downloading'})]));
 expect(f.saves.length-before).toBe(2);expect(f.state.budget[job.attemptDay]).toMatchObject({bytes:1200,workerSeconds:5});expect(f.state.jobs['42'].leaseUntil).toBeGreaterThan(job.leaseUntil);expect(f.maxActive).toBe(1);
});
it('honors Retry-After with single flight and charges once',async()=>{
 vi.useFakeTimers();vi.spyOn(console,'error').mockImplementation(()=>{});const f=fake();const store=new GcsJobStore(f.bucket);
 await clocked(()=>store.create({match_id:42},'ip'));const job=await clocked(()=>store.lease('42',1));
 await clocked(()=>store.charge('42',job.token,{bytes:42}));expect(f.state.budget[job.attemptDay].bytes).toBe(42);
 f.failures.push(429);const before=f.saves.length;
 await clocked(()=>store.charge('42',job.token,{bytes:100,workerSeconds:2}));
 expect(f.saves[before+1]-f.saves[before]).toBeGreaterThanOrEqual(2000);expect(f.state.budget[job.attemptDay]).toMatchObject({bytes:142,workerSeconds:2});expect(f.maxActive).toBe(1);
});
it.each([429,503])('exhausted %i stops the synthetic source at the failed batch',async status=>{
 vi.useFakeTimers();vi.spyOn(console,'error').mockImplementation(()=>{});
 const f=fake({failures:Array(6).fill(status)});const store=new GcsJobStore(f.bucket);
 const charger=createByteCharger((bytes:number)=>store.state.transaction((s:any)=>{s.bytes=(s.bytes??0)+bytes;}));
 let consumed=0;
 const run=(async()=>{for(let i=0;i<100;i++){consumed+=65536;await charger.add(65536);}await charger.flush();})();
 const check=expect(run).rejects.toThrow('gcs_request_failed');await vi.runAllTimersAsync();await check;
 expect(consumed).toBe(1048576);expect(f.saves).toHaveLength(6);expect(f.maxActive).toBe(1);expect(f.state.bytes).toBeUndefined();
});
it('commits limited usage once and rejects stale lease mutations',async()=>{
 vi.useFakeTimers();const f=fake();const store=new GcsJobStore(f.bucket,{budgets:{bytes:100}});
 await clocked(()=>store.create({match_id:42},'ip'));const job=await clocked(()=>store.lease('42',1));
 const charger=createByteCharger((bytes:number)=>store.charge('42',job.token,{bytes}),{threshold:100});
 const limited=expect(charger.add(101)).rejects.toThrow('resource_limited');await vi.runAllTimersAsync();await limited;
 await charger.flush();expect(f.state.budget[job.attemptDay].bytes).toBe(101);
 const stale=expect(store.charge('42',job.token+1,{bytes:50})).rejects.toThrow('stale_lease');await vi.runAllTimersAsync();await stale;
 expect(f.state.budget[job.attemptDay].bytes).toBe(101);
});
