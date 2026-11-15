// AbortError wrappers can hide the storage error that stopped the worker.
export function isStoreFailure(error,signal){
 const seen=new Set();
 function matches(value){
  if(!value||seen.has(value))return false;
  seen.add(value);
  return ['gcs_request_failed','store_contention','workload_identity_unavailable'].includes(value.message)||matches(value.cause);
 }
 return matches(error)||matches(signal?.reason);
}
