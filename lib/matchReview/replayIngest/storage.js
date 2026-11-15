import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
export class FileState {
 constructor(home){this.home=home;}
 async read(){try{return JSON.parse(await readFile(join(this.home,'state.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return {};throw e;}}
 async transaction(fn){
  await mkdir(this.home,{recursive:true,mode:0o700});
  // The kernel releases flock even when a writer dies. A child holds the lock
  // only while the parent owns its stdin pipe; there is no stale-lock timeout.
  const child=spawn('flock',['-x',join(this.home,'state.lock'),process.execPath,'-e',"process.stdout.write('locked\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"],{stdio:['pipe','pipe','pipe']});
  child.stdin.on('error',()=>{});child.stderr.resume();
  try {
   await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',()=>reject(new Error('store_lock_failed')));child.stdout.once('data',resolve);});
   const state=await this.read();const result=await fn(state);const tmp=join(this.home,randomUUID()+'.part');
   try{await writeFile(tmp,JSON.stringify(state),{mode:0o600});await rename(tmp,join(this.home,'state.json'));}finally{await rm(tmp,{force:true});}
   return result;
  } finally{child.stdin.end();}
 }
}
// Inject an authenticated GCS bucket. Object-generation preconditions serialize
// transactions across Cloud Run instances. No SDK/client is constructed here.
const writers=new WeakMap();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export class GcsState {
 constructor(bucket,key='jobs/state.json',{minWriteIntervalMs=1000}={}){
  let keys=writers.get(bucket);if(!keys)writers.set(bucket,keys=new Map());
  if(keys.has(key))return keys.get(key);
  this.file=bucket.file(key);this.minWriteIntervalMs=minWriteIntervalMs;this.lastSave=-Infinity;this.tail=Promise.resolve();this.pending=[];keys.set(key,this);
 }
 exclusive(task){const run=this.tail.then(task);this.tail=run.catch(()=>{});return run;}
 async loadSnapshot(){for(let attempt=0;attempt<20;attempt++){try{const [meta]=await this.file.getMetadata();const [bytes]=await this.file.download({preconditionOpts:{ifGenerationMatch:meta.generation}});return {state:JSON.parse(bytes),generation:meta.generation,updated:Number.isFinite(Date.parse(meta.updated))?Date.parse(meta.updated):undefined};}catch(e){if(e.code===404)return {state:{},generation:0};if(e.code===412)continue;throw e;}}throw new Error('store_contention');}
 snapshot(){return this.exclusive(()=>this.loadSnapshot());}
 async read(){return this.exclusive(async()=> (await this.loadSnapshot()).state);}
 transaction(fn){return new Promise((resolve,reject)=>{
  this.pending.push({fn,resolve,reject});
  if(this.scheduled)return;
  this.scheduled=true;
  this.exclusive(async()=>{
   let batch=[];
   try{
    await sleep(Math.max(0,this.lastSave+this.minWriteIntervalMs-Date.now()));
    batch=this.pending.splice(0);this.scheduled=false;
    for(let i=0;i<20;i++){
     const snapshot=await this.loadSnapshot();let state=snapshot.state;const results=[];
     for(const item of batch){const next=structuredClone(state);try{const value=await item.fn(next);state=next;results.push({value});}catch(error){results.push({error});}}
     try{
      await sleep(Math.max(0,Math.max(this.lastSave,snapshot.updated??-Infinity)+this.minWriteIntervalMs-Date.now()));
      // Count attempts too: a rejected save must not trigger another early write.
      this.lastSave=Date.now();
      await this.file.save(JSON.stringify(state),{resumable:false,preconditionOpts:{ifGenerationMatch:snapshot.generation}}).finally(()=>{this.lastSave=Date.now();});
      batch.forEach((item,n)=>results[n].error?item.reject(results[n].error):item.resolve(results[n].value));return;
     }catch(error){if(error.code!==412)throw error;}
    }
    throw new Error('store_contention');
   }catch(error){batch.forEach(item=>item.reject(error));}
  });
 });}
}
