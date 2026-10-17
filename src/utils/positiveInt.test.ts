import { describe, it, expect } from 'vitest';
import { parsePositiveInt } from '../../lib/positiveInt.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('parsePositiveInt (env int parsing)', () => {
  it('falls back for values that floor to 0', () => { expect(parsePositiveInt('0.5', 7)).toBe(7); expect(parsePositiveInt(0.9, 7)).toBe(7); });
  it('accepts plain, scientific-notation, and float strings (trimmed)', () => {
    expect(parsePositiveInt('40000', 1)).toBe(40000);
    expect(parsePositiveInt('4e4', 1)).toBe(40000);
    expect(parsePositiveInt('1e9', 1)).toBe(1_000_000_000);
    expect(parsePositiveInt('  25000  ', 1)).toBe(25000);
    expect(parsePositiveInt('2.9e3', 1)).toBe(2900); // 2900.0 floored
    expect(parsePositiveInt('2.9', 1)).toBe(2);      // fractional part floored
  });

  it('accepts numbers as-is', () => {
    expect(parsePositiveInt(40000, 1)).toBe(40000);
    expect(parsePositiveInt(1e9, 1)).toBe(1e9);
    expect(parsePositiveInt(2.9, 1)).toBe(2);
  });

  it('falls back to the default on anything non-finite, non-positive, or non-numeric', () => {
    for (const invalid of ['abc', '', '   ', '-5', '0', 'Infinity', '-Infinity', 'NaN', null, undefined, {}, NaN, 0, -5, Infinity]) {
      expect(parsePositiveInt(invalid as unknown as string, 42)).toBe(42);
    }
  });

  it('keeps huge finite values huge (callers clamp to their own ceiling)', () => {
    // '1e9' must NOT collapse to 1 (the parseInt bug this fixes).
    expect(Number.parseInt('1e9', 10)).toBe(1); // the old behaviour, for contrast
    expect(parsePositiveInt('1e9', 40)).toBe(1_000_000_000);
    expect(parsePositiveInt(String(Number.MAX_SAFE_INTEGER), 40)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects hex/octal/binary literals that Number() would accept', () => {
    // Number('0x1F40') === 8000 — a base prefix in an env value is a config
    // mistake, never a valid decimal budget.
    for (const literal of ['0x1F40', '0o17', '0b101', '0X1f40', ' 0x10 ', '1_000']) {
      expect(parsePositiveInt(literal, 42)).toBe(42);
    }
  });

  it('still accepts plain decimal and exponent forms', () => {
    expect(parsePositiveInt('8000', 1)).toBe(8000);
    expect(parsePositiveInt('8e3', 1)).toBe(8000);
    expect(parsePositiveInt('8E3', 1)).toBe(8000);
    expect(parsePositiveInt('8e+3', 1)).toBe(8000);
  });

  it('clamps to the optional { max } upper bound', () => {
    expect(parsePositiveInt('8000', 1, { max: 100 })).toBe(100);
    expect(parsePositiveInt('100', 1, { max: 100 })).toBe(100);
    expect(parsePositiveInt('20', 1, { max: 100 })).toBe(20);
    // max applies to number inputs too; fallback is untouched by max.
    expect(parsePositiveInt(5000, 1, { max: 100 })).toBe(100);
    expect(parsePositiveInt('abc', 7, { max: 100 })).toBe(7);
  });
});

describe('envPositiveInt (server.js wiring)', () => {
  it('server.js parses env ints via parsePositiveInt, not parseInt', () => {
    const src = readFileSync(join(__dirname, '../../server.js'), 'utf8');
    expect(src).toMatch(/return parsePositiveInt\(process\.env\[name\], fallback, max != null \? \{ max \} : undefined\);/);
    expect(src).not.toMatch(/parseInt\(process\.env\[name\]/);
  });

  it('caps the parse-submission budgets at 100 global / 20 per client', () => {
    const src = readFileSync(join(__dirname, '../../server.js'), 'utf8');
    expect(src).toMatch(/envPositiveInt\('PARSE_BUDGET_GLOBAL_MAX', 10, 100\)/);
    expect(src).toMatch(/envPositiveInt\('PARSE_BUDGET_PER_CLIENT_MAX', 3, 20\)/);
  });
});
