import { useSyncExternalStore } from 'react';

export type Dota2AiSurface = 'web' | 'dsh';

export interface DiscussInHostPayload {
  matchId: string;
  hero: string;
  lang: 'en' | 'zh' | 'ru';
  text: string;
}

export interface Dota2AiRuntimeConfig {
  surface: Dota2AiSurface;
  /** Public site origin used for external share links when hosted inside DSH (`127.0.0.1` / `file://`). */
  publicOrigin?: string;
  /** Host transport replacing browser `fetch` for `/api/*` requests (e.g. DSH Typert RPC). */
  apiFetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Open or append a prompt in a DSH conversation session from a match review. */
  onDiscussInHost?: (payload: DiscussInHostPayload) => void | Promise<void>;
}

const DEFAULT_RUNTIME: Dota2AiRuntimeConfig = Object.freeze({ surface: 'web' });

let current: Dota2AiRuntimeConfig = DEFAULT_RUNTIME;
const listeners = new Set<() => void>();

export function configureDota2AiRuntime(next: Partial<Dota2AiRuntimeConfig> | null): () => void {
  current = next ? Object.freeze({ ...DEFAULT_RUNTIME, ...next }) : DEFAULT_RUNTIME;
  for (const listener of listeners) listener();
  return () => {
    current = DEFAULT_RUNTIME;
    for (const listener of listeners) listener();
  };
}

export function getDota2AiRuntime(): Dota2AiRuntimeConfig {
  return current;
}

export function useDota2AiRuntime(): Dota2AiRuntimeConfig {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => DEFAULT_RUNTIME,
  );
}

/** Perform an `/api/*` request through the configured host transport, or browser `fetch` on the web. */
export function runtimeFetch(input: string, init?: RequestInit): Promise<Response> {
  if (current.apiFetch) {
    return init === undefined ? current.apiFetch(input) : current.apiFetch(input, init);
  }
  return init === undefined ? globalThis.fetch(input) : globalThis.fetch(input, init);
}

/** Clean origin for external share links — never `127.0.0.1` or `file://` with a DSH token. */
export function shareOrigin(): string {
  if (current.publicOrigin) return current.publicOrigin.replace(/\/+$/, '');
  if (current.surface === 'dsh') return 'https://dota2.ai';
  return typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'https://dota2.ai';
}
