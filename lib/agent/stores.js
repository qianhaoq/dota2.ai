/**
 * Where the agent keeps things: one small blob interface (`get(key)` →
 * Buffer | null, `put(key, body)`, `delete(key)`), over a directory or a GCS
 * bucket, and the trace store on top of it. Reads never throw: a missing or
 * unreadable object is null. Deleting what is not there is not an error.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { linkHeroNames } from '../../packages/review-engine/src/trace/build.js';

const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/;
const MATCH_ID = /^[1-9]\d{0,14}$/;
/** Max decompressed trace JSON size (32 MB) to guard against gzip bombs. */
export const MAX_TRACE_JSON_BYTES = 32 * 1024 * 1024;
const contentGen = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

/** Blobs as files in `dir`. Writes are atomic (temp file, then rename). */
export function createFileStore(dir, fs = { mkdir, readFile, rename, rm, writeFile }) {
  let n = 0;
  /** Serialize in-process CAS writes per key so concurrent callers observe real conflict semantics. */
  const locks = new Map();
  const serialize = (key, fn) => {
    const prev = locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const tail = next.catch(() => {}).finally(() => { if (locks.get(key) === tail) locks.delete(key); });
    locks.set(key, tail);
    return next;
  };
  return {
    async get(key) {
      if (!dir || !KEY.test(key)) return null;
      try { return await fs.readFile(join(dir, key)); } catch { return null; }
    },
    async getWithMeta(key) {
      if (!dir || !KEY.test(key)) throw new Error('invalid_key');
      try {
        const body = await fs.readFile(join(dir, key));
        return { exists: true, body, generation: contentGen(body) };
      } catch (err) {
        if (err?.code === 'ENOENT') return { exists: false, body: null, generation: '0' };
        throw err;
      }
    },
    async put(key, body) {
      if (!dir || !KEY.test(key)) throw new Error('invalid_key');
      await fs.mkdir(dir, { recursive: true });
      const tmp = join(dir, `.${key}.${process.pid}.${n += 1}.tmp`);
      await fs.writeFile(tmp, body);
      await fs.rename(tmp, join(dir, key));
    },
    /** @returns {Promise<{ ok: true, generation?: string } | { ok: false, conflict: true }>} */
    async putIfMatch(key, body, expectedGeneration) {
      if (!dir || !KEY.test(key)) throw new Error('invalid_key');
      const expected = String(expectedGeneration);
      return serialize(key, async () => {
        await fs.mkdir(dir, { recursive: true });
        const target = join(dir, key);
        if (expected === '0') {
          try {
            await fs.writeFile(target, body, { flag: 'wx' });
            return { ok: true, generation: contentGen(body) };
          } catch (err) {
            if (err?.code === 'EEXIST') return { ok: false, conflict: true };
            throw err;
          }
        }
        let current;
        try { current = await fs.readFile(target); } catch (err) {
          if (err?.code === 'ENOENT') return { ok: false, conflict: true };
          throw err;
        }
        if (contentGen(current) !== expected) return { ok: false, conflict: true };
        const tmp = join(dir, `.${key}.${process.pid}.${n += 1}.tmp`);
        await fs.writeFile(tmp, body);
        await fs.rename(tmp, target);
        return { ok: true, generation: contentGen(body) };
      });
    },
    async deleteIfMatch(key, expectedGeneration) {
      if (!dir || !KEY.test(key)) throw new Error('invalid_key');
      const expected = String(expectedGeneration);
      return serialize(key, async () => {
        const target = join(dir, key);
        let current;
        try { current = await fs.readFile(target); } catch (err) {
          if (err?.code === 'ENOENT') return { ok: false, conflict: true };
          throw err;
        }
        if (contentGen(current) !== expected) return { ok: false, conflict: true };
        await fs.rm(target, { force: true });
        return { ok: true };
      });
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
    async getWithMeta(key) {
      if (!KEY.test(key)) throw new Error('invalid_key');
      const file = bucket.file(prefix + key);
      let meta;
      try { [meta] = await file.getMetadata(); } catch (err) {
        if (err?.code === 404) return { exists: false, body: null, generation: '0' };
        throw err;
      }
      const generation = String(meta?.generation ?? '');
      if (!generation) throw Object.assign(new Error('missing_generation'), { code: 'missing_generation' });
      const [body] = await file.download({ preconditionOpts: { ifGenerationMatch: generation } });
      return { exists: true, body, generation };
    },
    async put(key, body) {
      if (!KEY.test(key)) throw new Error('invalid_key');
      await bucket.file(prefix + key).save(body);
    },
    /** @returns {Promise<{ ok: true, generation?: string } | { ok: false, conflict: true }>} */
    async putIfMatch(key, body, expectedGeneration) {
      if (!KEY.test(key)) throw new Error('invalid_key');
      try {
        const res = await bucket.file(prefix + key).save(body, { preconditionOpts: { ifGenerationMatch: String(expectedGeneration) } });
        const generation = res?.[0]?.generation != null ? String(res[0].generation) : undefined;
        return { ok: true, ...(generation ? { generation } : {}) };
      } catch (err) {
        if (err?.code === 412) return { ok: false, conflict: true };
        throw err;
      }
    },
    async deleteIfMatch(key, expectedGeneration) {
      if (!KEY.test(key)) throw new Error('invalid_key');
      try {
        await bucket.file(prefix + key).delete({ preconditionOpts: { ifGenerationMatch: String(expectedGeneration) } });
        return { ok: true };
      } catch (err) {
        if (err?.code === 404 || err?.code === 412) return { ok: false, conflict: true };
        throw err;
      }
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
      try { trace = JSON.parse(gunzipSync(body, { maxOutputLength: MAX_TRACE_JSON_BYTES }).toString('utf8')); } catch { return null; }
      if (trace?.schema !== 'dota2.ai/match-trace@1' || String(trace.match_id) !== id) return null;
      linkHeroNames(trace);
      cache.set(id, trace);
      while (cache.size > keep) cache.delete(cache.keys().next().value);
      return trace;
    },
    /** The verified gzipped trace bytes as stored, or null when missing or corrupt. */
    async raw(matchId) {
      const id = String(matchId);
      if (!blobs || !MATCH_ID.test(id)) return null;
      const body = await blobs.get(name(id));
      if (!body) return null;
      if (!cache.has(id)) {
        let trace;
        try { trace = JSON.parse(gunzipSync(body, { maxOutputLength: MAX_TRACE_JSON_BYTES }).toString('utf8')); } catch { return null; }
        if (trace?.schema !== 'dota2.ai/match-trace@1' || String(trace.match_id) !== id) return null;
        linkHeroNames(trace);
        cache.set(id, trace);
        while (cache.size > keep) cache.delete(cache.keys().next().value);
      }
      return body;
    },
    async put(matchId, body) {
      const id = String(matchId);
      if (!blobs || !MATCH_ID.test(id)) throw new Error('invalid_match');
      cache.delete(id);
      await blobs.put(name(id), body);
    },
    evict(matchId) {
      cache.delete(String(matchId));
    },
  };
}

/** JSON documents in a blob store. */
export function createJsonStore(blobs) {
  const cas = typeof blobs?.getWithMeta === 'function' && typeof blobs?.putIfMatch === 'function';
  return {
    async get(key) {
      const body = blobs ? await blobs.get(key) : null;
      if (!body) return null;
      try { return JSON.parse(body.toString('utf8')); } catch { return null; }
    },
    async put(key, value) { if (blobs) await blobs.put(key, Buffer.from(JSON.stringify(value))); },
    async delete(key) { if (blobs?.delete) await blobs.delete(key); },
    ...(cas ? {
      async getWithMeta(key) {
        const res = await blobs.getWithMeta(key);
        if (!res.exists || !res.body) return { exists: false, value: null, generation: res.generation };
        try { return { exists: true, value: JSON.parse(res.body.toString('utf8')), generation: res.generation }; } catch { return { exists: true, value: null, generation: res.generation }; }
      },
      async putIfMatch(key, value, expectedGeneration) {
        return blobs.putIfMatch(key, Buffer.from(JSON.stringify(value)), expectedGeneration);
      },
      ...(typeof blobs?.deleteIfMatch === 'function' ? {
        async deleteIfMatch(key, expectedGeneration) {
          return blobs.deleteIfMatch(key, expectedGeneration);
        },
      } : {}),
    } : {}),
  };
}
