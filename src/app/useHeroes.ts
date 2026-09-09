import { useEffect, useState } from 'react';
import { fetchHeroes } from '../services/dotaApiService';
import type { Hero, Language } from '../types';

/**
 * Module-level cache so the shell mentor rail, training picker and knowledge
 * lens share one heroes fetch per language. Navigating between workspaces must
 * not unload or refetch this list.
 */
const heroesCache = new Map<Language, Hero[]>();

export function useHeroes(lang: Language): { heroes: Hero[]; isLoading: boolean } {
  const [heroes, setHeroes] = useState<Hero[]>(() => heroesCache.get(lang) ?? []);
  const [isLoading, setIsLoading] = useState(() => !heroesCache.has(lang));

  useEffect(() => {
    let cancelled = false;
    const cached = heroesCache.get(lang);
    if (cached) {
      setHeroes(cached);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    fetchHeroes(lang)
      .then((data) => {
        heroesCache.set(lang, data);
        if (!cancelled) {
          setHeroes(data);
          setIsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lang]);

  return { heroes, isLoading };
}

/** The default mentor is an expression layer, not a fact source. */
export function findMentor(heroes: Hero[]): Hero | null {
  return heroes.find((h) => (h.name || '').toLowerCase() === 'rubick' || h.id === 86) ?? null;
}
