/**
 * A sliding-window limit that can be looked at before it is taken:
 * `full(key)` reads, `tryConsume(key)` takes. The router admits a request in
 * one synchronous step — look at every limit, take the model budget, then
 * take the slots — so a request refused at any point leaves nothing reserved.
 */
export function createSlots({ limit, windowMs, now = () => Date.now(), maxKeys = 5000 }) {
  /** @type {Map<string, number[]>} */
  const hits = new Map();
  const live = (key, t) => {
    const kept = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
    if (kept.length) hits.set(key, kept); else hits.delete(key);
    return kept;
  };
  const wait = (kept, t) => (kept.length ? Math.max(1, Math.ceil((kept[0] + windowMs - t) / 1000)) : 1);
  return {
    full(key) { return live(String(key), now()).length >= limit; },
    retryAfterSec(key) { const t = now(); return wait(live(String(key), t), t); },
    tryConsume(key) {
      const k = String(key); const t = now();
      const kept = live(k, t);
      if (kept.length >= limit) return { ok: false, retryAfterSec: wait(kept, t), reason: 'client' };
      kept.push(t); hits.set(k, kept);
      while (hits.size > maxKeys) hits.delete(hits.keys().next().value);
      return { ok: true, retryAfterSec: 0 };
    },
    refund(key) {
      const k = String(key);
      const list = hits.get(k);
      if (!list?.length) return;
      list.pop();
      if (!list.length) hits.delete(k);
    },
  };
}
