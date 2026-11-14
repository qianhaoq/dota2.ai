import {FileState} from './storage.js';
export class FileQueue {
 constructor(home){this.state=new FileState(home);}
 async enqueue(job){return this.state.transaction(s=>{s.tasks??={};const name=job.taskName;s.tasks[name]??={jobId:job.jobId,generation:job.generation,name};return name;});}
 async pending(){return Object.values((await this.state.read()).tasks??{});}
 async ack(name){return this.state.transaction(s=>{delete s.tasks?.[name];});}
}
export class CloudTasksQueue {
 constructor(client,parent,url,serviceAccountEmail){Object.assign(this,{client,parent,url,serviceAccountEmail});}
 async enqueue(job){const name=`${this.parent}/tasks/${job.taskName}`;try{await this.client.createTask({parent:this.parent,task:{name,httpRequest:{httpMethod:'POST',url:this.url,oidcToken:{serviceAccountEmail:this.serviceAccountEmail},headers:{'Content-Type':'application/json'},body:Buffer.from(JSON.stringify({jobId:job.jobId,generation:job.generation})).toString('base64')}}});}catch(e){if(e.code!==6)throw e;}return name;}
}

// Cloud Run + GCS default: the outbox is the queue. An authenticated worker
// invocation drains it; an operator can invoke again after a crash. No Tasks API.
export class GcsQueue extends FileQueue {
 constructor(state){super('/unused');this.state=state;}
}
