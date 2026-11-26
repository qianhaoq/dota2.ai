import { describe, it, expect } from 'vitest';
import { en } from './en';
import { zh } from './zh';
import { ru } from './ru';

describe('dictionary parity', () => {
  it('zh and ru have exactly the en keys', () => {
    const enKeys = Object.keys(en).sort();
    expect(Object.keys(zh).sort()).toEqual(enKeys);
    expect(Object.keys(ru).sort()).toEqual(enKeys);
  });

  it('no empty strings in any dictionary', () => {
    for (const [lang, dict] of [['en', en], ['zh', zh], ['ru', ru]] as const) {
      for (const [key, value] of Object.entries(dict)) {
        expect(value.trim(), `${lang}.${key}`).not.toBe('');
      }
    }
  });
});

describe('fake-door copy', () => {
  it('does not name a price or monthly fee in en, zh or ru', () => {
    for (const [lang, dict] of [['en', en], ['zh', zh], ['ru', ru]] as const) {
      const blob = Object.values(dict).join('\n');
      expect(blob, lang).not.toMatch(/\$\s*\d/);
      expect(blob, lang).not.toMatch(/\d+\s*\/\s*(mo|month|月|мес)/i);
      expect(dict.fdBody, `${lang}.fdBody`).not.toMatch(/charge|收费|\$/i);
    }
  });
});

