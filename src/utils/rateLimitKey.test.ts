import { describe, it, expect } from 'vitest';
import { rateLimitKey, RATE_LIMIT_KEY_MAX_CHARS } from '../../lib/rateLimitKey.js';

describe('rateLimitKey — IPv6 grouped by /64 prefix', () => {
  it('gives every address in one /64 the same key', () => {
    expect(rateLimitKey('2001:db8:1:2::5')).toBe('2001:db8:1:2::/64');
    expect(rateLimitKey('2001:db8:1:2:ffff::1')).toBe('2001:db8:1:2::/64');
    expect(rateLimitKey('2001:db8:1:2:0:0:0:9')).toBe('2001:db8:1:2::/64');
    // Full (non-::) form with leading zeros canonicalizes to the same key.
    expect(rateLimitKey('2001:0db8:0001:0002:0003:0004:0005:0006')).toBe('2001:db8:1:2::/64');
  });

  it('keeps different /64 blocks apart', () => {
    expect(rateLimitKey('2001:db8:1:2::5')).not.toBe(rateLimitKey('2001:db8:1:3::5'));
    expect(rateLimitKey('2001:db8:1:2::5')).not.toBe(rateLimitKey('2600:1f18::1'));
  });

  it('lowercases and strips zone ids before grouping', () => {
    expect(rateLimitKey('2001:DB8:1:2::AB')).toBe(rateLimitKey('2001:db8:1:2::ab'));
    expect(rateLimitKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(rateLimitKey('fe80::2%wlan0')).toBe(rateLimitKey('fe80::1'));
  });

  it('groups loopback/link-local into their /64 buckets', () => {
    expect(rateLimitKey('::1')).toBe('0:0:0:0::/64');
    expect(rateLimitKey('::2')).toBe('0:0:0:0::/64');
    expect(rateLimitKey('fe80::a')).toBe(rateLimitKey('fe80::b'));
  });

  it('NAT64-style embedded IPv4 stays IPv6 (only ::ffff/96 maps to IPv4)', () => {
    expect(rateLimitKey('64:ff9b::1.2.3.4')).toBe('64:ff9b:0:0::/64');
  });
});

describe('rateLimitKey — IPv4-mapped IPv6 normalizes to plain IPv4', () => {
  it('maps the dotted form', () => {
    expect(rateLimitKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('maps the hex form to the same dotted address', () => {
    // ::ffff:0102:0304 == ::ffff:1.2.3.4
    expect(rateLimitKey('::ffff:0102:0304')).toBe('1.2.3.4');
    expect(rateLimitKey('::FFFF:0102:0304')).toBe('1.2.3.4');
  });

  it('shares one bucket with the bare IPv4 address', () => {
    expect(rateLimitKey('::ffff:1.2.3.4')).toBe(rateLimitKey('1.2.3.4'));
    expect(rateLimitKey('::ffff:0102:0304')).toBe(rateLimitKey('1.2.3.4'));
  });
});

describe('rateLimitKey — IPv4 stays per address', () => {
  it('returns the address itself', () => {
    expect(rateLimitKey('203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitKey('0.0.0.0')).toBe('0.0.0.0');
    expect(rateLimitKey('255.255.255.255')).toBe('255.255.255.255');
  });

  it('keeps neighbouring addresses apart', () => {
    expect(rateLimitKey('203.0.113.7')).not.toBe(rateLimitKey('203.0.113.8'));
  });
});

describe('rateLimitKey — invalid input falls back to a bounded raw string', () => {
  it('passes unparseable strings through (distinct garbage stays distinct)', () => {
    expect(rateLimitKey('not-an-ip')).toBe('not-an-ip');
    expect(rateLimitKey('999.1.1.1')).toBe('999.1.1.1');
    expect(rateLimitKey('1.2.3.4:80')).toBe('1.2.3.4:80');
    // Plausible-but-broken IPv6 (double ::, too few groups) stays raw.
    expect(rateLimitKey('2001:db8::1::2')).toBe('2001:db8::1::2');
    expect(rateLimitKey('2001:db8')).toBe('2001:db8');
  });

  it('bounds the fallback key and maps empties to unknown', () => {
    expect(rateLimitKey('')).toBe('unknown');
    expect(rateLimitKey(undefined)).toBe('unknown');
    expect(rateLimitKey(null)).toBe('unknown');
    const long = 'x'.repeat(200);
    expect(rateLimitKey(long)).toHaveLength(RATE_LIMIT_KEY_MAX_CHARS);
    expect(rateLimitKey(long)).toBe('x'.repeat(RATE_LIMIT_KEY_MAX_CHARS));
  });
});
