import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TRUSTED_PROXY_HOPS,
  MAX_TRUSTED_PROXY_HOPS,
  parseTrustedProxyHops,
  isPrivateOrLoopbackIp,
  parseForwardedFor,
  clientIpFromForwardedFor,
  resolveClientIp,
} from '../../lib/clientIp.js';
import { createParseRequestBudget } from '../../lib/matchReview/matchParse.js';

// Cloud Run serving infra peer (100.64/10 CGNAT) and a Google Front End IP.
const CLOUD_RUN_PEER = '100.100.1.1';
const LB_IP = '34.117.5.5';

describe('parseTrustedProxyHops', () => {
  it('falls back to the Cloud Run domain-mapping default (1) for missing or invalid input', () => {
    expect(DEFAULT_TRUSTED_PROXY_HOPS).toBe(1);
    expect(parseTrustedProxyHops(undefined)).toBe(1);
    expect(parseTrustedProxyHops('')).toBe(1);
    expect(parseTrustedProxyHops('abc')).toBe(1);
    expect(parseTrustedProxyHops('-1')).toBe(1);
  });

  it('accepts explicit hop counts', () => {
    expect(parseTrustedProxyHops('0')).toBe(0);
    expect(parseTrustedProxyHops('1')).toBe(1);
    expect(parseTrustedProxyHops('2')).toBe(2);
    expect(parseTrustedProxyHops('2.9')).toBe(2); // fractional floors to the whole count
    expect(parseTrustedProxyHops(3)).toBe(3);
  });

  it('caps absurd values so the pick window cannot drift into spoofable entries', () => {
    expect(parseTrustedProxyHops('99')).toBe(MAX_TRUSTED_PROXY_HOPS);
    expect(MAX_TRUSTED_PROXY_HOPS).toBeLessThanOrEqual(5);
  });
});

describe('isPrivateOrLoopbackIp', () => {
  it('treats loopback, RFC 1918 and Cloud Run CGNAT ranges as trusted proxies', () => {
    for (const ip of [
      '127.0.0.1',
      '::1',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      '100.64.0.1',
      '100.127.255.255',
      '::ffff:10.1.2.3',
      'fe80::1',
      'fd00::1',
    ]) {
      expect(isPrivateOrLoopbackIp(ip), ip).toBe(true);
    }
  });

  it('rejects public peers and empty/unknown values', () => {
    for (const ip of [
      '203.0.113.5',
      '34.117.5.5',
      '172.32.0.1',
      '100.63.0.1',
      '100.128.0.1',
      '',
      'unknown',
    ]) {
      expect(isPrivateOrLoopbackIp(ip), ip).toBe(false);
    }
  });
});

describe('parseForwardedFor', () => {
  it('splits, trims and drops empty entries', () => {
    expect(parseForwardedFor(' a , b ')).toEqual(['a', 'b']);
    expect(parseForwardedFor(' , , 203.0.113.7, ')).toEqual(['203.0.113.7']);
  });

  it('returns an empty list for missing or non-string headers', () => {
    expect(parseForwardedFor(undefined)).toEqual([]);
    expect(parseForwardedFor(null)).toEqual([]);
    expect(parseForwardedFor(123)).toEqual([]);
    expect(parseForwardedFor('   ')).toEqual([]);
  });
});

describe('clientIpFromForwardedFor', () => {
  it('picks XFF[len - hops]: the entry just left of the trusted proxy appends', () => {
    // Domain mapping (verified): GFE appends exactly one entry — the client.
    expect(clientIpFromForwardedFor(['198.51.100.9'], 1)).toBe('198.51.100.9');
    // External HTTPS LB in front: appends "<client-ip>,<lb-ip>".
    expect(clientIpFromForwardedFor(['203.0.113.7', LB_IP], 2)).toBe('203.0.113.7');
  });

  it('returns undefined when hops is zero or the chain is shorter than configured', () => {
    expect(clientIpFromForwardedFor(['203.0.113.7', LB_IP], 0)).toBeUndefined();
    expect(clientIpFromForwardedFor(['198.51.100.9'], 2)).toBeUndefined();
    expect(clientIpFromForwardedFor([], 1)).toBeUndefined();
  });
});

describe('resolveClientIp', () => {
  it('ignores X-Forwarded-For entirely for direct public peers (spoof resistance)', () => {
    expect(resolveClientIp({
      peerAddress: '203.0.113.5',
      forwardedFor: '6.6.6.6, 6.6.6.7',
    })).toBe('203.0.113.5');
    expect(resolveClientIp({ peerAddress: '203.0.113.5' })).toBe('203.0.113.5');
  });

  it('picks the single GFE-appended entry for Cloud Run domain mapping (verified topology)', () => {
    // dota2.ai is a Cloud Run domain mapping (A records → Google Front End,
    // no external LB): GFE appends exactly one entry — the real client.
    expect(resolveClientIp({
      peerAddress: CLOUD_RUN_PEER,
      forwardedFor: '198.51.100.9',
    })).toBe('198.51.100.9');
  });

  it('does not return the LB address for external-LB chains (P1 regression)', () => {
    // With an HTTPS LB in front (hops=2), the LB appends "<client-ip>,<lb-ip>";
    // the old right-most pick returned the LB.
    const ip = resolveClientIp({
      peerAddress: CLOUD_RUN_PEER,
      forwardedFor: '203.0.113.7, 34.117.5.5',
      trustedProxyHops: 2,
    });
    expect(ip).toBe('203.0.113.7');
    expect(ip).not.toBe(LB_IP);
  });

  it('defaults to a single trusted hop', () => {
    expect(resolveClientIp({
      peerAddress: CLOUD_RUN_PEER,
      forwardedFor: '198.51.100.9',
      trustedProxyHops: undefined,
    })).toBe('198.51.100.9');
  });

  it('cannot be steered by caller-prefixed spoofed entries', () => {
    expect(resolveClientIp({
      peerAddress: CLOUD_RUN_PEER,
      forwardedFor: '6.6.6.6, 6.6.6.7, 198.51.100.9',
    })).toBe('198.51.100.9');
    // Exactly the trusted chain, no spoofed prefix: idx 0 is still the client.
    expect(resolveClientIp({
      peerAddress: CLOUD_RUN_PEER,
      forwardedFor: '198.51.100.9',
    })).toBe('198.51.100.9');
    // Over-counted hops pick a caller-controlled left-side entry — the exact
    // spoof that TRUSTED_PROXY_HOPS=2 would enable on the 1-entry production
    // chain. This documents why the value must match the real topology.
    expect(resolveClientIp({
      peerAddress: CLOUD_RUN_PEER,
      forwardedFor: '6.6.6.6, 198.51.100.9',
      trustedProxyHops: 2,
    })).toBe('6.6.6.6');
  });

  it('supports an external LB in front via TRUSTED_PROXY_HOPS=2', () => {
    expect(resolveClientIp({
      peerAddress: CLOUD_RUN_PEER,
      forwardedFor: '203.0.113.7, 34.117.5.5',
      trustedProxyHops: 2,
    })).toBe('203.0.113.7');
    expect(resolveClientIp({
      peerAddress: CLOUD_RUN_PEER,
      forwardedFor: '6.6.6.6, 203.0.113.7, 34.117.5.5',
      trustedProxyHops: 2,
    })).toBe('203.0.113.7');
  });

  it('falls back to the shared peer when the chain is shorter than the trusted hops', () => {
    // Never an attacker-controlled left-side entry — fail closed (shared bucket).
    expect(resolveClientIp({
      peerAddress: '10.0.0.5',
      forwardedFor: '198.51.100.9',
      trustedProxyHops: 2,
    })).toBe('10.0.0.5');
    expect(resolveClientIp({
      peerAddress: CLOUD_RUN_PEER,
      forwardedFor: undefined,
      trustedProxyHops: 2,
    })).toBe(CLOUD_RUN_PEER);
  });

  it('uses the peer when no trusted hops are configured', () => {
    expect(resolveClientIp({
      peerAddress: '127.0.0.1',
      forwardedFor: '6.6.6.6',
      trustedProxyHops: 0,
    })).toBe('127.0.0.1');
  });

  it('falls back to the peer when XFF is missing or empty', () => {
    expect(resolveClientIp({ peerAddress: CLOUD_RUN_PEER })).toBe(CLOUD_RUN_PEER);
    expect(resolveClientIp({ peerAddress: CLOUD_RUN_PEER, forwardedFor: '  ' })).toBe(CLOUD_RUN_PEER);
    expect(resolveClientIp({ peerAddress: CLOUD_RUN_PEER, forwardedFor: undefined })).toBe(CLOUD_RUN_PEER);
  });

  it('handles missing or unknown peers and IPv6-mapped private peers', () => {
    expect(resolveClientIp({})).toBe('unknown');
    expect(resolveClientIp({ peerAddress: null, forwardedFor: '1.2.3.4' })).toBe('unknown');
    expect(resolveClientIp({
      peerAddress: '::ffff:10.1.2.3',
      forwardedFor: '203.0.113.7',
    })).toBe('203.0.113.7');
  });

  it('caps the returned identity at 64 characters', () => {
    const longEntry = 'a'.repeat(200);
    const picked = resolveClientIp({
      peerAddress: CLOUD_RUN_PEER,
      forwardedFor: `${longEntry}, ${LB_IP}`,
      trustedProxyHops: 2,
    });
    expect(picked.length).toBe(64);
  });
});

describe('resolveClientIp × parse budget (per-client buckets)', () => {
  it('gives each user behind the same front end their own parse budget', () => {
    const budget = createParseRequestBudget({ perClientMax: 1, globalMax: 100 });
    const now = 1_000_000;
    // Production chain: one GFE-appended entry per user (domain mapping).
    const chain = (clientIp: string) => resolveClientIp({
      peerAddress: CLOUD_RUN_PEER,
      forwardedFor: clientIp,
    });

    expect(budget.tryConsume(chain('203.0.113.7'), now)).toBeNull();
    expect(budget.tryConsume(chain('203.0.113.7'), now + 1)?.scope).toBe('client');
    // A different user is not throttled by the first user's submissions.
    expect(budget.tryConsume(chain('198.51.100.9'), now + 2)).toBeNull();
  });
});
