/**
 * The OpenDota 429 cooldown, shared by every instance through one small GCS
 * object (`ratelimit/opendota.json` = { until, reason, at }), so when one
 * instance is told to back off, all of them stop calling OpenDota until then
 * and serve the data they already have.
 *
 * Same shape as createLocalCooldown() in ./opendota.js:
 * - get(): the later of this instance's own cooldown and the shared one. The
 *   shared object is re-read at most every `refreshMs`, bounded by
 *   `readTimeoutMs`; a failed or slow read keeps the last known value.
 * - set(until, reason): this instance stops at once; the shared object is
 *   written only when `until` is later than what it already says.
 *
 * Writes are last-writer-wins: two instances racing can at worst keep the
 * shorter of two cooldowns, and each still honours its own. This is an
 * approximation of a global limiter by design (no Redis).
 */
export function createSharedCooldown({ bucket, key = 'ratelimit/opendota.json', refreshMs = 5000, readTimeoutMs = 800, now = () => Date.now(), log = () => {} }) {
  let local = 0;
  let remote = 0;
  let readAt = -Infinity;
  let reading = null;
  const stats = { reads: 0, readErrors: 0, writes: 0, writeErrors: 0 };

  async function refresh() {
    stats.reads += 1;
    let timer;
    try {
      const [buf] = await Promise.race([
        bucket.file(key).download(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('cooldown_read_timeout')), readTimeoutMs); }),
      ]);
      const rec = JSON.parse(buf.toString('utf8'));
      remote = Number.isFinite(rec?.until) ? rec.until : 0;
    } catch (err) {
      if (err?.code === 404) remote = 0;
      else { stats.readErrors += 1; log(`read failed: ${err?.message || err}`); }
    } finally {
      clearTimeout(timer);
      readAt = now();
    }
  }

  async function get() {
    if (now() - readAt >= refreshMs) {
      reading ??= refresh().finally(() => { reading = null; });
      await reading;
    }
    return Math.max(local, remote);
  }

  function set(until, reason = '') {
    if (!Number.isFinite(until)) return;
    local = Math.max(local, until);
    if (until <= remote) return;
    remote = until;
    bucket.file(key).save(JSON.stringify({ until, reason: String(reason).slice(0, 120), at: now() }))
      .then(() => { stats.writes += 1; })
      .catch((err) => { stats.writeErrors += 1; log(`write failed: ${err?.message || err}`); });
  }

  return { get, set, snapshot: () => ({ shared: true, until: Math.max(local, remote) || null, ...stats }) };
}
