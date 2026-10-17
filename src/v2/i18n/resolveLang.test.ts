// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  applyDocumentLang,
  LANG_STORAGE_KEY,
  normalizeLang,
  persistLang,
  readStoredLang,
  resolveLang,
} from './resolveLang';

describe('resolveLang', () => {
  it('URL beats storage beats browser beats default', () => {
    expect(resolveLang({ urlLang: 'zh', storedLang: 'en', browserLanguages: ['en-US'] })).toBe('zh');
    expect(resolveLang({ urlLang: 'en', storedLang: 'zh', browserLanguages: ['zh-CN'] })).toBe('en');
    expect(resolveLang({ storedLang: 'zh', browserLanguages: ['en-US'] })).toBe('zh');
    expect(resolveLang({ browserLanguages: ['zh-TW'], detectBrowser: true })).toBe('zh');
    expect(resolveLang({ browserLanguages: ['en-US'], detectBrowser: true })).toBe('en');
    expect(resolveLang({})).toBe('en');
  });

  it('ignores the browser by default (first visit lands on English)', () => {
    expect(resolveLang({ browserLanguages: ['zh-CN'] })).toBe('en');
    expect(resolveLang({ browserLanguages: ['zh-TW'], detectBrowser: false })).toBe('en');
    expect(resolveLang({ browserLanguages: ['zh'], detectBrowser: true })).toBe('zh');
  });

  it('ignores invalid values at every step', () => {
    expect(resolveLang({ urlLang: 'fr', storedLang: 'zh' })).toBe('zh');
    expect(resolveLang({ urlLang: '', storedLang: 'english', browserLanguages: ['zh'], detectBrowser: true })).toBe('zh');
    expect(resolveLang({ urlLang: 'ZH' })).toBe('en'); // case-sensitive: only exact en|zh
    expect(resolveLang({ urlLang: null, storedLang: null, browserLanguages: null, detectBrowser: true })).toBe('en');
  });

  it('maps zh-CN and zh-TW browser languages to zh when detection is enabled', () => {
    expect(resolveLang({ browserLanguages: ['zh-CN', 'en'], detectBrowser: true })).toBe('zh');
    expect(resolveLang({ browserLanguages: ['zh-TW'], detectBrowser: true })).toBe('zh');
    expect(resolveLang({ browserLanguages: ['en-GB', 'zh-Hans'], detectBrowser: true })).toBe('zh');
  });

  it('normalizeLang accepts only exact en/zh', () => {
    expect(normalizeLang('en')).toBe('en');
    expect(normalizeLang('zh')).toBe('zh');
    expect(normalizeLang('zh-CN')).toBeNull();
    expect(normalizeLang(undefined)).toBeNull();
    expect(normalizeLang(42)).toBeNull();
  });
});

describe('persistence + document lang', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.lang = '';
  });

  it('persists to localStorage d2ai.lang and reads it back', () => {
    persistLang('zh');
    expect(window.localStorage.getItem(LANG_STORAGE_KEY)).toBe('zh');
    expect(readStoredLang()).toBe('zh');
    persistLang('en');
    expect(readStoredLang()).toBe('en');
  });

  it('readStoredLang survives a throwing localStorage (private mode)', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readStoredLang()).toBeNull();
    expect(() => persistLang('zh')).not.toThrow();
    spy.mockRestore();
  });

  it('sets documentElement.lang to en or zh-CN', () => {
    applyDocumentLang('zh');
    expect(document.documentElement.lang).toBe('zh-CN');
    applyDocumentLang('en');
    expect(document.documentElement.lang).toBe('en');
  });
});
