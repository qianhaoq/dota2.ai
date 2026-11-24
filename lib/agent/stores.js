/**
 * Where the agent keeps things: one small blob interface (`get(key)` →
 * Buffer | null, `put(key, body)`, `delete(key)`), over a directory or a GCS
 * bucket, and the trace store on top of it. Reads never throw: a missing or
 * unreadable object is null. Deleting what is not there is not an error.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/;
const MATCH_ID = /^[1-9]\d{0,14}$/;

/** Blobs as files in `dir`. Writes are atomic (temp file, then rename). */
export function createFileStore(dir, fs = { mkdir, readFile, rename, rm, writeFile }) {
  let n = 0;
  return {
    async get(key) {
      if (!dir || !KEY.test(key)) return null;
      try { return await fs.readFile(join(dir, key)); } catch { return null; }
    },
    async put(key, body) {
      if (!dir || !KEY.test(key)) throw new Error('invalid_key');
      await fs.mkdir(dir, { recursive: true });
      const tmp = join(dir, `.${key}.${process.pid}.${n += 1}.tmp`);
      await fs.writeFile(tmp, body);
      await fs.rename(tmp, join(dir, key));
    },
    async delete(key) {
      if (!dir || !KEY.test(key)) return;
      await fs.rm(join(dir, key), { force: true });
    },
  };
}

/** Blobs as objects under `prefix` in a bucket (the createGcsBucket contract). */
export function createBucketStore(bucket, prefix = '') {
  return {
    async get(key) {
      if (!KEY.test(key)) return null;
      try { const [buf] = await bucket.file(prefix + key).download(); return buf; } catch { return null; }
    },
    async put(key, body) {
      if (!KEY.test(key)) throw new Error('invalid_key');
      await bucket.file(prefix + key).save(body);
    },
    async delete(key) {
      if (!KEY.test(key)) return;
      try { await bucket.file(prefix + key).delete(); } catch { /* not there, or not allowed: the caller has already overwritten it */ }
    },
  };
}

/** Match traces in a blob store, the few most recent kept parsed in memory. */
export function createTraceStore(blobs, { keep = 4 } = {}) {
  const cache = new Map();
  const name = (id) => `${id}.trace.json.gz`;
  return {
    async get(matchId) {
      const id = String(matchId);
      if (!blobs || !MATCH_ID.test(id)) return null;
      if (cache.has(id)) { const t = cache.get(id); cache.delete(id); cache.set(id, t); return t; }
      const body = await blobs.get(name(id));
      if (!body) return null;
      let trace;
      try { trace = JSON.parse(gunzipSync(body).toString('utf8')); } catch { return null; }
      if (trace?.schema !== 'dota2.ai/match-trace@1' || String(trace.match_id) !== id) return null;
      cache.set(id, trace);
      while (cache.size > keep) cache.delete(cache.keys().next().value);
      return trace;
    },
    async put(matchId, body) {
      const id = String(matchId);
      if (!blobs || !MATCH_ID.test(id)) throw new Error('invalid_match');
      cache.delete(id);
      await blobs.put(name(id), body);
    },
  };
}

/** JSON documents in a blob store. */
export function createJsonStore(blobs) {
  return {
    async get(key) {
      const body = blobs ? await blobs.get(key) : null;
      if (!body) return null;
      try { return JSON.parse(body.toString('utf8')); } catch { return null; }
    },
    async put(key, value) { if (blobs) await blobs.put(key, Buffer.from(JSON.stringify(value))); },
    async delete(key) { if (blobs?.delete) await blobs.delete(key); },
  };
}
