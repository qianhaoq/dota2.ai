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
export class GcsState {
 constructor(bucket,key='jobs/state.json'){this.file=bucket.file(key);}
 async snapshot(){for(let attempt=0;attempt<20;attempt++){try{const [meta]=await this.file.getMetadata();const [bytes]=await this.file.download({preconditionOpts:{ifGenerationMatch:meta.generation}});return {state:JSON.parse(bytes),generation:meta.generation};}catch(e){if(e.code===404)return {state:{},generation:0};if(e.code===412)continue;throw e;}}throw new Error('store_contention');}
 async read(){return (await this.snapshot()).state;}
 async transaction(fn){for(let i=0;i<20;i++){const {state,generation}=await this.snapshot();const result=await fn(state);try{await this.file.save(JSON.stringify(state),{resumable:false,preconditionOpts:{ifGenerationMatch:generation}});return result;}catch(e){if(e.code!==412)throw e;}}throw new Error('store_contention');}
}
