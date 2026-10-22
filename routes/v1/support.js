import { createHmac, randomBytes } from 'node:crypto';
import { resolveClientIp } from '../../lib/clientIp.js';

export const DAY = 86400000;
export function createCache({ max = 500, now = Date.now } = {}) {
  const entries = new Map();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      if (entry.until <= now()) return undefined;
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value, ttl) {
      entries.delete(key);
      entries.set(key, { value, until: now() + ttl });
      while (entries.size > max) entries.delete(entries.keys().next().value);
    },
  };
}
export function createLimiter({ capacity, windowMs, now = Date.now }) {
  const buckets = new Map();
  return key => {
    const time = now();
    const old = buckets.get(key) ?? { tokens: capacity, at: time };
    const tokens = Math.min(capacity, old.tokens + Math.max(0, time - old.at) * capacity / windowMs);
    buckets.delete(key);
    buckets.set(key, { tokens: tokens >= 1 ? tokens - 1 : tokens, at: time });
    while (buckets.size > 10000) buckets.delete(buckets.keys().next().value);
    return tokens >= 1 ? 0 : Math.max(1, Math.ceil((1 - tokens) * windowMs / capacity / 1000));
  };
}
export function createIpKey(now = Date.now) {
  let day, salt;
  return req => {
    const current = Math.floor(now() / DAY);
    if (day !== current) { day = current; salt = randomBytes(32); }
    const ip = resolveClientIp({ peerAddress: req.socket.remoteAddress, forwardedFor: req.headers['x-forwarded-for'], trustedProxyHops: process.env.TRUSTED_PROXY_HOPS });
    return createHmac('sha256', salt).update(ip).digest('hex');
  };
}
export const errorBody = code => ({ code, retryable: ['UPSTREAM_TIMEOUT', 'RATE_LIMITED', 'INTERNAL'].includes(code), message_key: `err.${code.toLowerCase()}` });
export function classify(error) {
  if (['MATCH_NOT_FOUND', 'UPSTREAM_TIMEOUT', 'RATE_LIMITED', 'INVALID_INPUT'].includes(error?.code)) return error.code;
  if (error?.status === 404 || /HTTP 404/.test(error?.message ?? '')) return 'MATCH_NOT_FOUND';
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || /timeout|fetch failed|network/i.test(error?.message ?? '') || error?.status >= 500) return 'UPSTREAM_TIMEOUT';
  return 'INTERNAL';
}
export const securityHeaders = (req, res, next) => {
  res.set({
    'Content-Security-Policy-Report-Only': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://cdn.cloudflare.steamstatic.com; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'",
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
};
export function startSse(res) {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  let id = 0, ended = false;
  const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': ping\n\n'); }, 15000);
  const stop = () => { ended = true; clearInterval(heartbeat); };
  res.on('close', stop);
  return {
    send(event, data, eventId = ++id) {
      if (ended || res.destroyed) return;
      id = eventId;
      res.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (event === 'error' || event === 'done') { stop(); res.end(); }
    },
    close: stop,
  };
}
