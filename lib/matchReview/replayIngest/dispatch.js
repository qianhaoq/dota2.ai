// IAM-authenticated start of the private worker. The caller holds this request
// open so Cloud Run keeps CPU allocated for the drain. Never grant allUsers.
export function createWorkerDispatcher({env=process.env,fetchImpl=fetch}={}){
 const url=String(env.REPLAY_WORKER_URL||'').replace(/\/$/,'');
 const timeout=Number(env.REPLAY_WORKER_DISPATCH_TIMEOUT_MS||900000);
 return {async dispatch(){
  if(!url)return {skipped:true,reason:'no_worker_url'};
  const audience=encodeURIComponent(url);
  const tok=await fetchImpl(`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${audience}`,{headers:{'Metadata-Flavor':'Google'},signal:AbortSignal.timeout(10000)});
  if(!tok.ok)throw new Error('worker_identity_failed');
  const token=(await tok.text()).trim();
  if(!token)throw new Error('worker_identity_failed');
  const res=await fetchImpl(`${url}/run`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(Number.isFinite(timeout)&&timeout>0?timeout:900000)});
  if(!res.ok)throw Object.assign(new Error('worker_dispatch_failed'),{code:res.status});
  return {ok:true,status:res.status};
 }};
}
