/**
 * Which upstream to ask first, and the fallback chain after it.
 *
 * UPSTREAM_PRIMARY=opendota (default) | steam_gc. During an OpenDota outage
 * an operator sets steam_gc so requests go straight to the self-hosted Steam
 * GC retriever instead of first failing at OpenDota. Only configured sources
 * are tried. Pure: no network, no env reads (the caller passes the value).
 */

export const SOURCES = /** @type {const} */ (['opendota', 'steam_gc', 'stratz']);
const PRIMARIES = new Set(['opendota', 'steam_gc']);

/** @param {unknown} value @returns {{ primary: 'opendota' | 'steam_gc', invalid: string | null }} */
export function parseUpstreamPrimary(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!v) return { primary: 'opendota', invalid: null };
  if (PRIMARIES.has(v)) return { primary: /** @type {'opendota' | 'steam_gc'} */ (v), invalid: null };
  // A typo must not silently pick a source: say so, keep the default.
  return { primary: 'opendota', invalid: v };
}

/**
 * @param {'match' | 'recent'} kind
 * @param {{ primary?: string, configured: Partial<Record<typeof SOURCES[number], boolean>> }} opts
 * @returns {(typeof SOURCES[number])[]}
 */
export function sourceOrder(kind, { primary = 'opendota', configured }) {
  // STRATZ can serve a single match; it has no recent-matches path here.
  const all = kind === 'recent' ? ['opendota', 'steam_gc'] : ['opendota', 'steam_gc', 'stratz'];
  const first = primary === 'steam_gc' ? 'steam_gc' : 'opendota';
  const ordered = [first, ...all.filter((s) => s !== first)];
  return /** @type {any} */ (ordered.filter((s) => configured?.[s]));
}

/**
 * Try `order` in turn. A 404 ("no such match"), an aborted caller, or a
 * non-retryable error marked `final` stops the chain: another source cannot
 * change those answers. If every source fails, the first (primary) error is
 * thrown, since it is the one callers already know how to map.
 *
 * @template T
 * @param {string[]} order
 * @param {Record<string, (signal?: AbortSignal) => Promise<T>>} fetchers
 * @param {{ signal?: AbortSignal, onFallback?: (from: string, to: string, err: any) => void }} [opts]
 * @returns {Promise<{ source: string, value: T }>}
 */
export async function fetchFromSources(order, fetchers, { signal, onFallback } = {}) {
  let firstErr;
  for (let i = 0; i < order.length; i++) {
    const source = order[i];
    try {
      return { source, value: await fetchers[source](signal) };
    } catch (err) {
      firstErr ??= err;
      if (err?.status === 404 || err?.final || signal?.aborted || i === order.length - 1) throw firstErr;
      onFallback?.(source, order[i + 1], err);
    }
  }
  throw firstErr ?? new Error('no upstream source configured');
}
