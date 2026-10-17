import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { Language } from '../../types';
import { en, type DictKey } from './en';
import { zh } from './zh';
import {
  applyDocumentLang,
  browserLanguageTags,
  normalizeLang,
  persistLang,
  readStoredLang,
  resolveLang,
} from './resolveLang';

export interface I18nContextValue {
  lang: Language;
  setLang: (lang: Language) => void;
  t: (key: DictKey) => string;
}

const DICTS = { en, zh } as const;

const I18nContext = createContext<I18nContextValue | null>(null);

/**
 * Shared language state for both the legacy app and the v2 shell.
 * Must be rendered inside a Router (it reads/writes the URL `lang` param).
 * Resolution priority: URL > localStorage > browser > 'en' (see resolveLang).
 */
export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const urlLang = useMemo(
    () => normalizeLang(new URLSearchParams(location.search).get('lang')),
    [location.search],
  );

  const [lang, setLangState] = useState<Language>(() =>
    resolveLang({ urlLang, storedLang: readStoredLang(), browserLanguages: browserLanguageTags() }),
  );

  // A valid ?lang= in the URL always wins (shared/deep links).
  useEffect(() => {
    if (urlLang && urlLang !== lang) setLangState(urlLang);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlLang]);

  // Persist the resolved language and keep <html lang> in sync.
  useEffect(() => {
    persistLang(lang);
    applyDocumentLang(lang);
  }, [lang]);

  // Toggling writes localStorage (via the effect) AND the URL lang param via
  // history replace, keeping every other param (and the hash) intact.
  const setLang = useCallback(
    (next: Language) => {
      setLangState(next);
      const params = new URLSearchParams(location.search);
      params.set('lang', next);
      navigate(
        { pathname: location.pathname, search: `?${params.toString()}`, hash: location.hash },
        { replace: true },
      );
    },
    [location, navigate],
  );

  const t = useCallback((key: DictKey) => DICTS[lang][key] ?? en[key] ?? key, [lang]);

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

const FALLBACK: I18nContextValue = { lang: 'en', setLang: () => {}, t: (key) => en[key] ?? key };

/** Works without a provider (falls back to EN) so legacy usage can't break. */
export function useI18n(): I18nContextValue {
  return useContext(I18nContext) ?? FALLBACK;
}
