import React, { createContext, useContext, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { resolveFlags, type Flags } from './flags';

const FlagsContext = createContext<Flags | null>(null);

/** Resolves flags from build env + current route + (allowed) ?ff= override. */
export const FlagsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { pathname, search } = useLocation();
  const flags = useMemo(
    () =>
      resolveFlags({
        env: import.meta.env as Record<string, string | undefined>,
        pathname,
        search,
        allowOverride: Boolean(import.meta.env.DEV) || import.meta.env.VITE_ALLOW_FF_OVERRIDE === '1',
      }),
    [pathname, search],
  );
  return <FlagsContext.Provider value={flags}>{children}</FlagsContext.Provider>;
};

/** Falls back to env-based defaults (path '/') when no provider is present. */
export function useFlags(): Flags {
  const fromContext = useContext(FlagsContext);
  return useMemo(
    () =>
      fromContext ??
      resolveFlags({
        env: import.meta.env as Record<string, string | undefined>,
        pathname: '/',
        search: '',
      }),
    [fromContext],
  );
}
