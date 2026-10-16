import { describe, it, expect } from 'vitest';
import { parseMatchId } from '../../lib/matchReview/parseMatchId.js';

describe('parseMatchId — raw ids', () => {
  it('parses a plain numeric id (string or number)', () => {
    expect(parseMatchId('8985182860')).toBe(8985182860);
    expect(parseMatchId(8985182860 as unknown as string)).toBe(8985182860);
  });

  it('trims surrounding whitespace', () => {
    expect(parseMatchId('  8985182860\n')).toBe(8985182860);
  });

  it('returns null for empty or non-match input', () => {
    expect(parseMatchId('')).toBeNull();
    expect(parseMatchId(null)).toBeNull();
    expect(parseMatchId(undefined)).toBeNull();
    expect(parseMatchId('not a match id')).toBeNull();
  });
});

describe('parseMatchId — pasted match URLs', () => {
  it('parses OpenDota URLs with or without scheme / www / trailing path / query', () => {
    expect(parseMatchId('https://www.opendota.com/matches/8985182860')).toBe(8985182860);
    expect(parseMatchId('https://opendota.com/matches/8985182860')).toBe(8985182860);
    expect(parseMatchId('http://www.opendota.com/matches/8985182860')).toBe(8985182860);
    expect(parseMatchId('opendota.com/matches/8985182860')).toBe(8985182860);
    expect(parseMatchId('www.opendota.com/matches/8985182860')).toBe(8985182860);
    expect(parseMatchId('https://www.opendota.com/matches/8985182860/overview')).toBe(8985182860);
    expect(parseMatchId('https://www.opendota.com/matches/8985182860?tab=benchmarks')).toBe(8985182860);
  });

  it('parses Dotabuff URLs with or without scheme / www / trailing path / query', () => {
    expect(parseMatchId('https://www.dotabuff.com/matches/8985182860')).toBe(8985182860);
    expect(parseMatchId('dotabuff.com/matches/8985182860')).toBe(8985182860);
    expect(parseMatchId('https://www.dotabuff.com/matches/8985182860/items')).toBe(8985182860);
    expect(parseMatchId('https://www.dotabuff.com/matches/8985182860?lobby_type=ranked')).toBe(8985182860);
  });

  it('parses STRATZ URLs with or without scheme / www / trailing path / query', () => {
    expect(parseMatchId('https://stratz.com/matches/8985182860')).toBe(8985182860);
    expect(parseMatchId('https://www.stratz.com/matches/8985182860')).toBe(8985182860);
    expect(parseMatchId('stratz.com/matches/8985182860')).toBe(8985182860);
    expect(parseMatchId('https://www.stratz.com/matches/8985182860/benchmarks')).toBe(8985182860);
    expect(parseMatchId('https://www.stratz.com/matches/8985182860?lang=zh-CN')).toBe(8985182860);
  });

  it('is case-insensitive on the host', () => {
    expect(parseMatchId('https://WWW.STRATZ.COM/matches/8985182860')).toBe(8985182860);
    expect(parseMatchId('OpenDota.com/matches/8985182860')).toBe(8985182860);
  });

  it('rejects unknown hosts and non-match paths on known hosts', () => {
    expect(parseMatchId('https://evil.test/matches/8985182860')).toBeNull();
    expect(parseMatchId('https://opendota.com/heroes/8985182860')).toBeNull();
    expect(parseMatchId('https://stratz.com/matches/not-a-number')).toBeNull();
    expect(parseMatchId('https://dotabuff.com/matches/')).toBeNull();
  });
});
