import {it,expect,vi,afterEach} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileJobStore} from '../../lib/matchReview/replayIngest/jobStore.js';
import {createWorker} from '../../lib/matchReview/replayIngest/worker.js';

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
