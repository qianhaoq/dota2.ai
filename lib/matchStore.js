/**
 * Durable cache for OpenDota data that does not change, in one GCS bucket
 * (MATCH_CACHE_BUCKET), shared by every instance and every deploy:
 *
 * - Parsed matches, at `matches/{id}.json`: a parsed match is immutable, so it
 *   is written once (create-only) and read forever. Unparsed matches are never
 *   written: they become parsed later.
 * - Time-boxed results (pro-case explorer queries), at `results/{key}.json`
 *   with the time they were fetched; a reader passes the age it accepts.
 *
 * The store is a cache, never a dependency: every read is bounded
 * (readTimeoutMs) and any failure — missing object, GCS down, bad JSON, no
 * credentials — is a miss. Writes are fire-and-forget.
 */
import { createHash } from 'node:crypto';

const MATCH_ID = /^\d{1,20}$/;

/**
 * @param {{
 *   bucket: { file: (key: string) => { download: (o?: object) => Promise<[Buffer]>, save: (body: string, o?: object) => Promise<void> } },
 *   isParsed: (match: object) => boolean,
 *   readTimeoutMs?: number,
 *   now?: () => number,
 *   log?: (msg: string) => void,
 * }} options
 */
export function createMatchStore({ bucket, isParsed, readTimeoutMs = 1500, now = () => Date.now(), log = () => {} }) {
  const stats = { hits: 0, misses: 0, errors: 0, writes: 0, writeSkips: 0, writeErrors: 0 };
  const writing = new Set();

  async function readJson(key) {
    let timer;
    try {
      const [buf] = await Promise.race([
        bucket.file(key).download(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('match_store_timeout')), readTimeoutMs); }),
      ]);
      return JSON.parse(buf.toString('utf8'));
    } catch (err) {
      if (err?.code !== 404) {
        stats.errors += 1;
        log(`read ${key} failed: ${err?.message || err}${err?.code ? ` (${err.code})` : ''}`);
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function writeOnce(key, value) {
    if (writing.has(key)) return;
    writing.add(key);
    // Create-only: an existing object (another instance won the race) is fine.
    bucket.file(key).save(JSON.stringify(value), { preconditionOpts: { ifGenerationMatch: 0 } })
      .then(() => { stats.writes += 1; })
      .catch((err) => {
        if (err?.code === 412) { stats.writeSkips += 1; return; }
        stats.writeErrors += 1;
        log(`write ${key} failed: ${err?.message || err}${err?.code ? ` (${err.code})` : ''}`);
      })
      .finally(() => writing.delete(key));
  }

  /** A stored parsed match, or null. */
  async function getMatch(matchId) {
    if (!MATCH_ID.test(String(matchId))) return null;
    const data = await readJson(`matches/${matchId}.json`);
    if (data && typeof data === 'object' && isParsed(data)) {
      stats.hits += 1;
      return data;
    }
    stats.misses += 1;
    return null;
  }

  /** Store a match if it is parsed (otherwise it would freeze an incomplete copy). */
  function putMatch(matchId, data) {
    if (!MATCH_ID.test(String(matchId)) || !data || typeof data !== 'object' || !isParsed(data)) {
      stats.writeSkips += 1;
      return;
    }
    writeOnce(`matches/${matchId}.json`, data);
  }

  /**
   * Replace a stored match with a fuller copy of the same game, and only
   * then: `isLesser(current)` must say the stored copy is the poorer one. The
   * write is conditional on the exact object that was read, so two writers
   * cannot cross and a fuller copy is never overwritten. Fire-and-forget.
   * @param {number|string} matchId
   * @param {object} data
   * @param {(current: object) => boolean} isLesser
   */
  function replaceMatch(matchId, data, isLesser) {
    if (!MATCH_ID.test(String(matchId)) || !data || typeof data !== 'object' || !isParsed(data) || isLesser(data)) {
      stats.writeSkips += 1;
      return;
    }
    const key = `matches/${matchId}.json`;
    if (writing.has(key)) return;
    writing.add(key);
    (async () => {
      const file = bucket.file(key);
      const [meta] = await file.getMetadata();
      const generation = meta?.generation;
      if (generation == null) { stats.writeSkips += 1; return; }
      const [buf] = await file.download({ preconditionOpts: { ifGenerationMatch: generation } });
      if (!isLesser(JSON.parse(buf.toString('utf8')))) { stats.writeSkips += 1; return; }
      await file.save(JSON.stringify(data), { preconditionOpts: { ifGenerationMatch: generation } });
      stats.writes += 1;
    })().catch((err) => {
      // Changed or removed meanwhile: someone else's copy stands.
      if (err?.code === 412 || err?.code === 404) { stats.writeSkips += 1; return; }
      stats.writeErrors += 1;
      log(`replace ${key} failed: ${err?.message || err}${err?.code ? ` (${err.code})` : ''}`);
    }).finally(() => writing.delete(key));
  }

  const resultKey = (name) => `results/${createHash('sha256').update(String(name)).digest('hex').slice(0, 40)}.json`;

  /** A stored result no older than maxAgeMs, or null. */
  async function getResult(name, maxAgeMs) {
    const rec = await readJson(resultKey(name));
    if (rec && Number.isFinite(rec.at) && now() - rec.at <= maxAgeMs && 'value' in rec) {
      stats.hits += 1;
      return rec.value;
    }
    stats.misses += 1;
    return null;
  }

  /** Store a time-boxed result; later writes replace it (no create-only here). */
  function putResult(name, value) {
    const key = resultKey(name);
    if (writing.has(key)) return;
    writing.add(key);
    bucket.file(key).save(JSON.stringify({ at: now(), value }))
      .then(() => { stats.writes += 1; })
      .catch((err) => { stats.writeErrors += 1; log(`write ${key} failed: ${err?.message || err}`); })
      .finally(() => writing.delete(key));
  }

  return { getMatch, putMatch, replaceMatch, getResult, putResult, snapshot: () => ({ ...stats }) };
}
