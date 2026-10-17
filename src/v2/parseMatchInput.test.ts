import { describe, expect, it } from 'vitest';
import { parseMatchInput } from './parseMatchInput';

describe('parseMatchInput — bare ids', () => {
  it('accepts pure digits (1–20) as exact strings', () => {
    expect(parseMatchInput('9035042364')).toBe('9035042364');
    expect(parseMatchInput(' 9035042364\n')).toBe('9035042364');
    expect(parseMatchInput('7')).toBe('7');
  });

  it('accepts ids up to Number.MAX_SAFE_INTEGER; rejects anything above it (server does Number(matchId))', () => {
    expect(parseMatchInput('9035042364')).toBe('9035042364');
    expect(parseMatchInput('9007199254740991')).toBe('9007199254740991'); // MAX_SAFE_INTEGER
    expect(parseMatchInput('9007199254740992')).toBeNull(); // MAX_SAFE_INTEGER + 1
    expect(parseMatchInput('12345678901234567')).toBeNull(); // 17 digits
    expect(parseMatchInput('https://opendota.com/matches/9007199254740992')).toBeNull();
  });

  it('rejects ids longer than 20 digits instead of truncating', () => {
    expect(parseMatchInput('123456789012345678901234')).toBeNull();
    expect(parseMatchInput('https://opendota.com/matches/123456789012345678901234')).toBeNull();
  });

  it('rejects non-numeric junk', () => {
    expect(parseMatchInput('')).toBeNull();
    expect(parseMatchInput(null)).toBeNull();
    expect(parseMatchInput(undefined)).toBeNull();
    expect(parseMatchInput('hello world')).toBeNull();
    expect(parseMatchInput('9035042364abc')).toBeNull();
    expect(parseMatchInput('-9035042364')).toBeNull();
  });
});

describe('parseMatchInput — match URLs', () => {
  it('accepts http/https URLs on the supported hosts', () => {
    expect(parseMatchInput('https://www.opendota.com/matches/9035042364')).toBe('9035042364');
    expect(parseMatchInput('http://opendota.com/matches/123')).toBe('123');
    expect(parseMatchInput('https://dotabuff.com/matches/9876543210')).toBe('9876543210');
    expect(parseMatchInput('https://stratz.com/matches/42')).toBe('42');
    expect(parseMatchInput('HTTPS://OPENDOTA.COM/MATCHES/42')).toBe('42');
    expect(parseMatchInput('https://eu.stratz.com/matches/42')).toBe('42'); // subdomain
    expect(parseMatchInput('https://opendota.com/matches/42/timelines?foo=1')).toBe('42'); // trailing path/query
  });

  it('treats scheme-less host prefixes as https', () => {
    expect(parseMatchInput('opendota.com/matches/9035042364')).toBe('9035042364');
    expect(parseMatchInput('www.dotabuff.com/matches/55')).toBe('55');
    expect(parseMatchInput('//stratz.com/matches/55')).toBe('55');
  });

  it('rejects non-http protocols', () => {
    expect(parseMatchInput('javascript:alert(1)')).toBeNull();
    expect(parseMatchInput('javascript://opendota.com/matches/1')).toBeNull();
    expect(parseMatchInput('data:text/html,opendota.com/matches/1')).toBeNull();
    expect(parseMatchInput('ftp://opendota.com/matches/1')).toBeNull();
    expect(parseMatchInput('file://opendota.com/matches/1')).toBeNull();
  });

  it('rejects lookalike and unsupported hosts', () => {
    expect(parseMatchInput('https://opendota.com.evil.test/matches/1')).toBeNull();
    expect(parseMatchInput('https://evilopendota.com/matches/1')).toBeNull();
    expect(parseMatchInput('https://evil.com/matches/1')).toBeNull();
    expect(parseMatchInput('opendota.com.evil.test/matches/1')).toBeNull();
    expect(parseMatchInput('https://opendota.com/wrong/1')).toBeNull();
    expect(parseMatchInput('opendota.com/matches/12abc')).toBeNull();
  });
});
