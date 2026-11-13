import {mkdir,writeFile,readFile,link,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
export const checksum=body=>createHash('sha256').update(body).digest('hex');
const key=p=>`${p.matchId}-${p.generation}-${p.sha256}.json`;
const encode=(matchId,generation,artifact)=>{const body=JSON.stringify(artifact);if(Buffer.byteLength(body)>8_000_000)throw new Error('artifact_size_limit');return {body,pointer:{matchId,generation,sha256:checksum(body)}};};
export class FileArtifactStore {
 constructor(home){this.home=home;}
 async put(id,generation,artifact){
  const {body,pointer}=encode(id,generation,artifact);await mkdir(this.home,{recursive:true,mode:0o700});
  const temp=join(this.home,randomUUID()+'.part');
  try{await writeFile(temp,body,{mode:0o600});try{await link(temp,join(this.home,key(pointer)));}catch(e){if(e.code!=='EEXIST')throw e;await this.read(pointer);}}finally{await rm(temp,{force:true});}
  return pointer;
 }
 async read(pointer){if(!/^[a-f0-9]{64}$/.test(pointer.sha256)||!Number.isSafeInteger(pointer.matchId)||!Number.isSafeInteger(pointer.generation))throw new Error('invalid_pointer');const body=await readFile(join(this.home,key(pointer)),'utf8');if(checksum(body)!==pointer.sha256)throw new Error('artifact_checksum');return JSON.parse(body);}
}
export class GcsArtifactStore {
 constructor(bucket){this.bucket=bucket;}
 async put(id,generation,artifact){const {body,pointer}=encode(id,generation,artifact);try{await this.bucket.file('artifacts/'+key(pointer)).save(body,{resumable:false,preconditionOpts:{ifGenerationMatch:0}});}catch(e){if(e.code!==412)throw e;await this.read(pointer);}return pointer;}
 async read(pointer){const [bytes]=await this.bucket.file('artifacts/'+key(pointer)).download();if(checksum(bytes)!==pointer.sha256)throw new Error('artifact_checksum');return JSON.parse(bytes);}
}
