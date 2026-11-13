// Minimal injected bucket contract over the GCS JSON API; no cloud call until an
// explicitly configured store performs an operation. Uses workload identity.
export function createGcsBucket(name,{fetchImpl=fetch,tokenProvider}={}){
 if(!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(name))throw new Error('invalid_bucket');
 const token=tokenProvider??(async()=>{const r=await fetchImpl('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',{headers:{'Metadata-Flavor':'Google'},signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error('workload_identity_unavailable');return (await r.json()).access_token;});
 async function request(url,options={}){const r=await fetchImpl(url,{...options,headers:{Authorization:`Bearer ${await token()}`,...options.headers},signal:AbortSignal.timeout(30000)});if(!r.ok)throw Object.assign(new Error('gcs_request_failed'),{code:r.status});return r;}
 return {file(key){const base=`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(name)}/o/${encodeURIComponent(key)}`;return {
  async getMetadata(){return [await (await request(base)).json()];},
  async download({preconditionOpts}={}){const condition=preconditionOpts?.ifGenerationMatch;return [Buffer.from(await (await request(base+'?alt=media'+(condition!=null?'&ifGenerationMatch='+encodeURIComponent(condition):''))).arrayBuffer())];},
  async save(body,{preconditionOpts}={}){const condition=preconditionOpts?.ifGenerationMatch;await request(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(name)}/o?uploadType=media&name=${encodeURIComponent(key)}`+(condition!=null?'&ifGenerationMatch='+encodeURIComponent(condition):''),{method:'POST',headers:{'Content-Type':'application/json'},body});},
 };}};
}
