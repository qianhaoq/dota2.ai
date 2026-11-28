// Minimal injected bucket contract over the GCS JSON API; no cloud call until an
// explicitly configured store performs an operation. Uses workload identity.
/** @param {string} name @param {{fetchImpl?: typeof fetch, tokenProvider?: () => Promise<string>}} [options] */
export function createGcsBucket(name,{fetchImpl=fetch,tokenProvider}={}){
 if(!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(name))throw new Error('invalid_bucket');
 const token=tokenProvider??(async()=>{const r=await fetchImpl('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',{headers:{'Metadata-Flavor':'Google'},signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error('workload_identity_unavailable');return (await r.json()).access_token;});
 async function request(url,options={},key,method){
  for(let attempt=1;attempt<=6;attempt++){
   let r;
   try{r=await fetchImpl(url,{...options,headers:{Authorization:`Bearer ${await token()}`,...options.headers},signal:AbortSignal.timeout(30000)});}catch(error){console.error('replay_store_request',{key,method,status:null,attempt,retryAfter:null});throw Object.assign(new Error(error?.message==='workload_identity_unavailable'?'workload_identity_unavailable':'gcs_request_failed'),{code:error?.code});}
   if(r.ok)return r;
   const retryAfter=r.headers.get('Retry-After');
   // Missing snapshots and CAS conflicts are expected transaction control flow.
   if(r.status!==404&&r.status!==412)console.error('replay_store_request',{key,method,status:r.status,attempt,retryAfter});
   if((r.status===429||r.status===503)&&attempt<6){
    const seconds=Number(retryAfter),date=Date.parse(retryAfter);
    const delay=retryAfter==null?0:Number.isFinite(seconds)?seconds*1000:Number.isFinite(date)?date-Date.now():0;
    await r.body?.cancel();
    await new Promise(done=>setTimeout(done,Math.max(1000*2**(attempt-1),delay)));continue;
   }
   throw Object.assign(new Error('gcs_request_failed'),{code:r.status});
  }
 }
 return {
  async list(prefix=''){
   const names=[];
   let pageToken='';
   for(let page=0;page<5;page++){
    const params=new URLSearchParams({fields:'items(name),nextPageToken',maxResults:'200'});
    if(prefix)params.set('prefix',prefix);
    if(pageToken)params.set('pageToken',pageToken);
    const data=await (await request(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(name)}/o?${params}`,{},prefix,'list')).json();
    for(const item of data?.items??[])if(typeof item?.name==='string')names.push(item.name);
    if(!data?.nextPageToken)break;
    pageToken=String(data.nextPageToken);
   }
   return names;
  },
  file(key){const base=`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(name)}/o/${encodeURIComponent(key)}`;return {
  async getMetadata(){return [await (await request(base,{},key,'getMetadata')).json()];},
  async delete({preconditionOpts}={}){const condition=preconditionOpts?.ifGenerationMatch;await request(base+(condition!=null?'?ifGenerationMatch='+encodeURIComponent(condition):''),{method:'DELETE'},key,'delete');},
  async download({preconditionOpts}={}){const condition=preconditionOpts?.ifGenerationMatch;return [Buffer.from(await (await request(base+'?alt=media'+(condition!=null?'&ifGenerationMatch='+encodeURIComponent(condition):''),{},key,'download')).arrayBuffer())];},
  async save(body,{preconditionOpts}={}){const condition=preconditionOpts?.ifGenerationMatch;const res=await request(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(name)}/o?uploadType=media&name=${encodeURIComponent(key)}`+(condition!=null?'&ifGenerationMatch='+encodeURIComponent(condition):''),{method:'POST',headers:{'Content-Type':'application/json'},body},key,'save');return [await res.json().catch(()=>({}))];},
  };},
 };
}
