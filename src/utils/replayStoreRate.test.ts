import {it,expect,vi,afterEach} from 'vitest';
import {createGcsBucket} from '../../lib/matchReview/replayIngest/gcs.js';
import {GcsJobStore} from '../../lib/matchReview/replayIngest/jobStore.js';
import {createByteCharger} from '../../lib/matchReview/replayIngest/worker.js';
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
function fake({failures=[] as number[],cas=false,retryAfter='2'}={}){
 let state:any={},generation=0,active=0,maxActive=0,uncertain=false,rejected=false;const saves:number[]=[];
 const fetchImpl=vi.fn(async(input:RequestInfo | URL,options?:RequestInit)=>{const url=String(input);
  if(options?.method==='POST'){
   active++;maxActive=Math.max(maxActive,active);
   try{
    saves.push(Date.now());await Promise.resolve();
    if(rejected){rejected=false;throw new Error('dropped request');}
    const status=failures.shift();if(status)return new Response('',{status,headers:{'Retry-After':retryAfter}});
    if(cas){cas=false;return new Response('',{status:412});}
    if(saves.length>1&&saves.at(-1)!-saves.at(-2)!<1000)return new Response('',{status:429});
    state=JSON.parse(String(options.body));generation++;if(uncertain){uncertain=false;throw new Error('dropped response');}return new Response('{}');
   }finally{active--;}
  }
  if(!generation)return new Response('',{status:404});
  return new Response(JSON.stringify(url.includes('alt=media')?state:{generation}));
 });
 const bucket=createGcsBucket('test-bucket',{fetchImpl,tokenProvider:async()=>'secret'});
 return {bucket,saves,failures,failNext(committed:boolean){if(committed)uncertain=true;else rejected=true;},conflict(){cas=true;},get state(){return state;},get maxActive(){return maxActive;}};
}
async function clocked<T>(work:()=>Promise<T>){const p=work();await vi.runAllTimersAsync();return p;}
it.each([16384,65536])('coalesces 28MB synthetic chunks of %i with bounded backpressure',async chunk=>{
 vi.useFakeTimers();const f=fake();const store=new GcsJobStore(f.bucket);
 await clocked(()=>store.create({match_id:42},'ip'));const job=await clocked(()=>store.lease('42',1));
 const charger=createByteCharger((bytes:number)=>store.charge('42',job.token,{bytes}),{minWriteIntervalMs:store.state.minWriteIntervalMs});
 const started=Date.now(),total=28_442_608;
 await clocked(async()=>{for(let n=0;n<total;n+=chunk)await charger.add(Math.min(chunk,total-n));await charger.flush();});
 expect(Date.now()-started).toBeLessThan(5000);
 expect(f.state.budget[job.attemptDay].bytes).toBe(total);expect(f.maxActive).toBe(1);
 expect(f.saves.every((t,i)=>!i||t-f.saves[i-1]>=1000)).toBe(true);
});
it.each([16384,65536])('pumps 8MiB chunks of %i without advancing the write-floor clock',async chunk=>{
 vi.useFakeTimers();const f=fake();const store=new GcsJobStore(f.bucket);
 await clocked(()=>store.create({match_id:42},'ip'));const job=await clocked(()=>store.lease('42',1));
 const charger=createByteCharger((bytes:number,chargeId:string)=>store.charge('42',job.token,{bytes,chargeId}),{minWriteIntervalMs:store.state.minWriteIntervalMs});
 await clocked(()=>charger.add(1_048_576));
 const start=Date.now(),before=f.saves.length;
 for(let n=0;n<8*1_048_576;n+=chunk)await charger.add(chunk);
 expect(Date.now()).toBe(start);expect(f.saves).toHaveLength(before);
 await vi.advanceTimersByTimeAsync(999);expect(f.saves).toHaveLength(before);
 await vi.runAllTimersAsync();
 expect(f.state.budget[job.attemptDay].bytes).toBe(9*1_048_576);
 await charger.flush();expect(f.maxActive).toBe(1);
 expect(f.saves.every((t,i)=>!i||t-f.saves[i-1]>=1000)).toBe(true);
});
it('backpressures above 16MiB and bills the full pending batch at the floor',async()=>{
 vi.useFakeTimers();const f=fake();const store=new GcsJobStore(f.bucket);
 await clocked(()=>store.create({match_id:42},'ip'));const job=await clocked(()=>store.lease('42',1));
 const charger=createByteCharger((bytes:number,chargeId:string)=>store.charge('42',job.token,{bytes,chargeId}),{minWriteIntervalMs:1000});
 await clocked(()=>charger.add(1_048_576));
 for(let n=0;n<256;n++)await charger.add(65536);
 let finished=false;const blocked=charger.add(65536).then(()=>{finished=true;});
 await vi.advanceTimersByTimeAsync(999);expect(finished).toBe(false);
 await vi.runAllTimersAsync();await blocked;expect(finished).toBe(true);
 await charger.flush();expect(f.state.budget[job.attemptDay].bytes).toBe(17*1_048_576+65536);
 expect(f.maxActive).toBe(1);expect(f.saves.every((t,i)=>!i||t-f.saves[i-1]>=1000)).toBe(true);
});

it.each([false,true])('retries a scheduled failed save exactly once (committed before error: %s)',async committed=>{
 vi.useFakeTimers();vi.spyOn(console,'error').mockImplementation(()=>{});
 const f=fake();const store=new GcsJobStore(f.bucket);
 await clocked(()=>store.create({match_id:42},'ip'));const job=await clocked(()=>store.lease('42',1));
 const charge=vi.fn((bytes:number,chargeId:string)=>store.charge('42',job.token,{bytes,chargeId}));
 const charger=createByteCharger(charge,{threshold:1000,minWriteIntervalMs:1000});
 f.failNext(committed);await charger.add(1000);await vi.runAllTimersAsync();
 expect(charge).toHaveBeenCalledTimes(1);
 await expect(charger.add(1)).rejects.toThrow('gcs_request_failed');
 await clocked(()=>charger.flush());
 expect(charge).toHaveBeenCalledTimes(2);
 expect(charge.mock.calls[1]).toEqual(charge.mock.calls[0]);
 expect(f.state.budget[job.attemptDay].bytes).toBe(1000);
 expect(f.state.jobs['42'].appliedCharges).toHaveLength(1);
 const saves=f.saves.length;await charger.flush();
 expect(charge).toHaveBeenCalledTimes(2);expect(f.saves).toHaveLength(saves);
});

it.each([false,true])('retries an in-flight scheduled failed save at final flush (committed before error: %s)',async committed=>{
 vi.useFakeTimers();vi.spyOn(console,'error').mockImplementation(()=>{});
 const f=fake();const store=new GcsJobStore(f.bucket);
 await clocked(()=>store.create({match_id:42},'ip'));const job=await clocked(()=>store.lease('42',1));
 const charge=vi.fn(async(bytes:number,chargeId:string)=>{
  await new Promise(resolve=>setTimeout(resolve,50));
  return store.charge('42',job.token,{bytes,chargeId});
 });
 const charger=createByteCharger(charge,{threshold:1000,minWriteIntervalMs:1000});
 f.failNext(committed);await charger.add(1000);
 await vi.advanceTimersByTimeAsync(0);expect(charge).toHaveBeenCalledTimes(1);
 // The scheduled charge is still waiting when the download's final flush joins it.
 const final=expect(charger.flush()).resolves.toBeUndefined();
 await vi.runAllTimersAsync();await final;
 expect(charge).toHaveBeenCalledTimes(2);
 expect(charge.mock.calls[1]).toEqual(charge.mock.calls[0]);
 expect(f.state.budget[job.attemptDay].bytes).toBe(1000);
 expect(f.state.jobs['42'].appliedCharges).toHaveLength(1);
 const saves=f.saves.length;await charger.flush();
 expect(charge).toHaveBeenCalledTimes(2);expect(f.saves).toHaveLength(saves);
});

it('rejects final flush overlapping a scheduled committed resource limit exactly once',async()=>{
 vi.useFakeTimers();const f=fake();const store=new GcsJobStore(f.bucket,{budgets:{bytes:1000}});
 await clocked(()=>store.create({match_id:42},'ip'));const job=await clocked(()=>store.lease('42',1));
 const charge=vi.fn(async(bytes:number,chargeId:string)=>{
  await new Promise(resolve=>setTimeout(resolve,50));
  return store.charge('42',job.token,{bytes,chargeId});
 });
 const charger=createByteCharger(charge,{minWriteIntervalMs:1000});
 await charger.add(1_048_576);await vi.advanceTimersByTimeAsync(0);
 expect(charge).toHaveBeenCalledTimes(1);
 const final=expect(charger.flush()).rejects.toThrow('resource_limited');
 await vi.runAllTimersAsync();await final;
 const saves=f.saves.length;
 await charger.flush();await charger.flush();
 expect(charge).toHaveBeenCalledTimes(1);expect(f.saves).toHaveLength(saves);
 expect(f.state.budget[job.attemptDay].bytes).toBe(1_048_576);
 expect(f.state.jobs['42'].appliedCharges).toHaveLength(1);
});

it('surfaces a scheduled committed resource limit at final flush without rebilling',async()=>{
 vi.useFakeTimers();const f=fake();const store=new GcsJobStore(f.bucket,{budgets:{bytes:1_048_576}});
 await clocked(()=>store.create({match_id:42},'ip'));const job=await clocked(()=>store.lease('42',1));
 const charger=createByteCharger((bytes:number,chargeId:string)=>store.charge('42',job.token,{bytes,chargeId}),{minWriteIntervalMs:1000});
 await clocked(()=>charger.add(1_048_576));await charger.add(1_048_576);
 await vi.runAllTimersAsync();
 const saves=f.saves.length;
 await expect(charger.flush()).rejects.toThrow('resource_limited');
 await charger.flush();expect(f.state.budget[job.attemptDay].bytes).toBe(2*1_048_576);
 expect(f.saves).toHaveLength(saves);
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

it('logs retries and terminal failures without logging expected snapshots or CAS conflicts',async()=>{
 vi.useFakeTimers();const log=vi.spyOn(console,'error').mockImplementation(()=>{});
 const responses=[404,412,429,503,403];
 const bucket=createGcsBucket('test-bucket',{tokenProvider:async()=>'secret-token',fetchImpl:async()=>new Response('',{status:responses.shift()!,headers:{'Retry-After':'2'}})});
 await expect(bucket.file('jobs/state.json').getMetadata()).rejects.toMatchObject({code:404});
 await expect(bucket.file('jobs/state.json').save('{}',{preconditionOpts:{ifGenerationMatch:0}})).rejects.toMatchObject({code:412});
 expect(log).not.toHaveBeenCalled();
 const failed=expect(bucket.file('jobs/state.json').save('{}')).rejects.toMatchObject({code:403});
 await vi.runAllTimersAsync();await failed;
 expect(log.mock.calls).toEqual([429,503,403].map((status,i)=>['replay_store_request',{key:'jobs/state.json',method:'save',status,attempt:i+1,retryAfter:'2'}]));
 expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret-token|https?:/);
});

it.each([true,false])('retries sticky usage tickets exactly once (committed before error: %s)',async committed=>{
 vi.useFakeTimers();vi.spyOn(console,'error').mockImplementation(()=>{});
 const f=fake();const store=new GcsJobStore(f.bucket);
 await clocked(()=>store.create({match_id:42},'ip'));const job=await clocked(()=>store.lease('42',1));
 f.failNext(committed);
 const charger=createByteCharger((bytes:number,chargeId:string)=>store.charge('42',job.token,{bytes,chargeId}));
 await charger.add(1000);
 const failed=expect(charger.flush()).rejects.toThrow('gcs_request_failed');await vi.runAllTimersAsync();await failed;
 await clocked(()=>charger.flush());
 expect(f.state.budget[job.attemptDay].bytes).toBe(1000);
 const {createElapsedCharger}=await import('../../lib/matchReview/replayIngest/worker.js');
 const started=Date.now();const chargeElapsed=createElapsedCharger((usage:any)=>store.charge('42',job.token,usage),started);
 vi.setSystemTime(started+20_000);f.failNext(committed);
 const elapsedFailed=expect(chargeElapsed()).rejects.toThrow('gcs_request_failed');await vi.runAllTimersAsync();await elapsedFailed;
 await clocked(()=>chargeElapsed());
 expect(f.state.budget[job.attemptDay].workerSeconds).toBe(20);
 expect(f.state.jobs['42'].appliedCharges).toHaveLength(2);
 vi.setSystemTime(started+30_000);await clocked(()=>chargeElapsed());
 expect(f.state.budget[job.attemptDay].workerSeconds).toBe(30);
});

it('spaces independent handles from object metadata and reapplies after a competing save',async()=>{
 vi.useFakeTimers();let state:any={},generation=0,updated=0;const saves:number[]=[];const active=[0,0],maxActive=[0,0];
 const handle=(index:number)=>createGcsBucket('shared-bucket',{tokenProvider:async()=>'secret',fetchImpl:async(input:any,options?:RequestInit)=>{
  const url=new URL(String(input));
  if(options?.method==='POST'){
   active[index]++;maxActive[index]=Math.max(maxActive[index],active[index]);
   try{await Promise.resolve();if(Number(url.searchParams.get('ifGenerationMatch'))!==generation)return new Response('',{status:412});
    state=JSON.parse(String(options.body));generation++;updated=Date.now();saves.push(updated);return new Response('{}');
   }finally{active[index]--;}
  }
  if(!generation)return new Response('',{status:404});
  return new Response(JSON.stringify(url.searchParams.has('alt')?state:{generation,updated:new Date(updated).toISOString()}));
 }});
 const a=new GcsJobStore(handle(0));await clocked(()=>a.create({match_id:42},'ip'));const job=await clocked(()=>a.lease('42',1));
 await clocked(()=>a.charge('42',job.token,{bytes:100,chargeId:'a'}));const at=saves.at(-1)!;
 vi.setSystemTime(at+500);const b=new GcsJobStore(handle(1));
 await clocked(()=>Promise.all([b.charge('42',job.token,{bytes:200,chargeId:'b'}),a.heartbeat('42',job.token)]));
 expect(saves.every((time,i)=>!i||time-saves[i-1]>=1000)).toBe(true);
 expect(state.budget[job.attemptDay].bytes).toBe(300);expect(maxActive).toEqual([1,1]);
});

it('duplicates succeed after a committed resource limit and retains only 32 tickets',async()=>{
 vi.useFakeTimers();const f=fake();const store=new GcsJobStore(f.bucket,{budgets:{bytes:100}});
 await clocked(()=>store.create({match_id:42},'ip'));const job=await clocked(()=>store.lease('42',1));
 const limited=expect(store.charge('42',job.token,{bytes:101,chargeId:'limited'})).rejects.toThrow('resource_limited');await vi.runAllTimersAsync();await limited;
 await clocked(()=>store.charge('42',job.token,{bytes:101,chargeId:'limited'}));
 expect(f.state.budget[job.attemptDay].bytes).toBe(101);
 // Zero usage still records tickets, even when the budget is already exceeded.
 for(let i=0;i<33;i++){
  const result=expect(store.charge('42',job.token,{chargeId:`next-${i}`})).rejects.toThrow('resource_limited');await vi.runAllTimersAsync();await result;
 }
 expect(f.state.jobs['42'].appliedCharges).toEqual(Array.from({length:32},(_,i)=>`next-${i+1}`));
});
