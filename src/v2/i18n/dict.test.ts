import { describe, it, expect } from 'vitest';
import { en } from './en';
import { zh } from './zh';

describe('dictionary parity', () => {
  it('zh has exactly the en keys', () => {
    const enKeys = Object.keys(en).sort();
    const zhKeys = Object.keys(zh).sort();
    expect(zhKeys).toEqual(enKeys);
  });

  it('no empty strings in either dictionary', () => {
    for (const [key, value] of Object.entries(en)) {
      expect(value.trim(), `en.${key}`).not.toBe('');
    }
    for (const [key, value] of Object.entries(zh)) {
      expect(value.trim(), `zh.${key}`).not.toBe('');
    }
  });
});
