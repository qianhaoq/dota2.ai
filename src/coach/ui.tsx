import React, { useState } from 'react';
import { useI18n } from '../v2/i18n/I18nProvider';
import type { Bi } from './types';

export type Lang = 'en' | 'zh';

/** An image that collapses to a same-size placeholder if the CDN fails. */
export function SafeImg({ src, alt, className, title }: { src: string; alt: string; className?: string; title?: string }) {
  // Remember which URL failed, not just "failed": a reused instance that gets
  // a new src (e.g. switching players in the deaths list) must try it.
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  if (brokenSrc === src) return <span className={`cx-img-missing ${className ?? ''}`} title={title ?? alt} aria-label={alt} role="img" />;
  return <img src={src} alt={alt} title={title} className={className} loading="lazy" onError={() => setBrokenSrc(src)} />;
}

export const clock = (s: number) => `${s < 0 ? '-' : ''}${Math.floor(Math.abs(s) / 60)}:${String(Math.abs(Math.round(s)) % 60).padStart(2, '0')}`;
export const k = (n: number) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
export const signedK = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${k(Math.abs(n))}`;

export function useLang() {
  const { lang, setLang } = useI18n();
  const L = (b: Bi | undefined | null) => (b ? b[lang as Lang] ?? b.en : '');
  return { lang: lang as Lang, setLang, L };
}
