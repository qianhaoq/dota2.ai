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

describe('fake-door copy', () => {
  it('does not name a price or monthly fee in en or zh', () => {
    for (const [lang, dict] of [['en', en], ['zh', zh]] as const) {
      const blob = Object.values(dict).join('\n');
      expect(blob, lang).not.toMatch(/\$\s*\d/);
      expect(blob, lang).not.toMatch(/\d+\s*\/\s*(mo|month|月)/i);
      expect(dict.fdBody, `${lang}.fdBody`).not.toMatch(/charge|收费|\$/i);
    }
  });
});

