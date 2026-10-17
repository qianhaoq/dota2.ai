import { useEffect } from 'react';

/**
 * Keeps `--app-height` on the document root in sync with the visual viewport
 * so the sticky composer stays above the iOS keyboard. Runs once for the whole
 * app (called above <Routes>) so it also applies on direct /new or /m loads.
 */
export function useVisualViewportHeight(): void {
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => {
      const height = window.visualViewport?.height ?? window.innerHeight;
      root.style.setProperty('--app-height', `${Math.round(height)}px`);
    };
    sync();
    const vv = window.visualViewport;
    vv?.addEventListener('resize', sync);
    window.addEventListener('resize', sync);
    window.addEventListener('orientationchange', sync);
    return () => {
      vv?.removeEventListener('resize', sync);
      window.removeEventListener('resize', sync);
      window.removeEventListener('orientationchange', sync);
    };
  }, []);
}
