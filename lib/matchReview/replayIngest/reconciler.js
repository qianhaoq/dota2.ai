import {activeStates} from './jobStore.js';
export async function reconcile({jobStore,queue,now=Date.now}) {
 await jobStore.maintain();
 for(const job of await jobStore.list())if(activeStates.includes(job.status)&&(job.enqueue_pending||!job.leaseUntil||job.leaseUntil<=now())){await queue.enqueue(job);await jobStore.enqueued(job.jobId,job.generation);}
}
