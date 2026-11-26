export type Language = 'en' | 'zh' | 'ru';

/**
 * Pure language resolution for the d2ai shell. Priority:
 *   URL ?lang= (en|zh|ru) > localStorage `d2ai.lang` > browser language > 'en'
 * Invalid values are ignored at every step. Browser languages starting with
 * "zh" (zh-CN, zh-TW, …) map to zh, and "ru" (ru, ru-RU, …) map to ru.
 *
 * The browser step is opt-in (`detectBrowser: true`, wired to the build-time
 * VITE_LANG_DETECT_BROWSER=1 flag in I18nProvider); by default a first-time
 * visitor always lands on English.
 *
 * Everything DOM/storage-touching is isolated in small guarded helpers so the
 * resolution itself stays unit-testable in a node environment.
 */

export const LANG_STORAGE_KEY = 'd2ai.lang';

export function normalizeLang(value: unknown): Language | null {
  if (value === 'en' || value === 'zh' || value === 'ru') return value;
  return null;
}

export interface ResolveLangInput {
  /** Raw value of the URL `lang` param (null/undefined when absent). */
  urlLang?: string | null;
  /** Raw value stored under `d2ai.lang` (null/undefined when absent). */
  storedLang?: string | null;
  /** Browser language tags, e.g. navigator.languages. */
  browserLanguages?: readonly string[] | null;
  /** Opt-in: consult `browserLanguages` (default false → English first visit). */
  detectBrowser?: boolean;
}

export function resolveLang({ urlLang, storedLang, browserLanguages, detectBrowser = false }: ResolveLangInput): Language {
  const fromUrl = normalizeLang(urlLang);
  if (fromUrl) return fromUrl;
  const fromStorage = normalizeLang(storedLang);
  if (fromStorage) return fromStorage;
  if (detectBrowser && Array.isArray(browserLanguages)) {
    for (const tag of browserLanguages) {
      if (typeof tag !== 'string') continue;
      const lower = tag.toLowerCase();
      if (lower.startsWith('zh')) return 'zh';
      if (lower.startsWith('ru')) return 'ru';
    }
  }
  return 'en';
}

/** localStorage read guarded for Safari private mode and SSR-ish contexts. */
export function readStoredLang(): string | null {
  try {
    return window.localStorage.getItem(LANG_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Persist the resolved language; failures (private mode) are ignored. */
export function persistLang(lang: Language): void {
  try {
    window.localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    /* private mode: language simply won't persist */
  }
}

export function browserLanguageTags(): readonly string[] {
  try {
    if (typeof navigator === 'undefined') return [];
    if (Array.isArray(navigator.languages) && navigator.languages.length > 0) return navigator.languages;
    return navigator.language ? [navigator.language] : [];
  } catch {
    return [];
  }
}

/** `<html lang>`: 'en', 'zh-CN' (never bare 'zh'), or 'ru'. */
export function applyDocumentLang(lang: Language): void {
  try {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang === 'ru' ? 'ru' : 'en';
  } catch {
    /* no document (tests/SSR): skip */
  }
}
