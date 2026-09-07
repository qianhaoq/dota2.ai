import { useEffect, useRef } from 'react';

/** Coarse pointers (touch, switch) should not auto-focus a text field (IME zoom / keyboard). */
export function shouldFocusSearchOnOpen(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return !window.matchMedia('(pointer: coarse)').matches;
}

/**
 * Move focus into a modal when it opens and restore the trigger on close.
 * Close control on coarse pointers; search input on fine pointers.
 */
export function useOverlayFocus(isOpen: boolean) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return undefined;

    restoreRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    const target = shouldFocusSearchOnOpen() ? searchRef.current : closeRef.current;
    target?.focus();

    return () => {
      restoreRef.current?.focus?.();
    };
  }, [isOpen]);

  return { closeRef, searchRef };
}
