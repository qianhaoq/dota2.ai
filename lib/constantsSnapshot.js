/**
 * OpenDota constants shipped with the build (scripts/refresh-data.mjs), so the
 * server makes no constants requests at runtime. A missing or broken file is
 * null: the server then falls back to fetching, as before.
 */
import { readFileSync } from 'node:fs';

const DIR = new URL('./data/constants/', import.meta.url);

function read(name, minEntries) {
  try {
    const data = JSON.parse(readFileSync(new URL(`${name}.json`, DIR), 'utf8'));
    return data && typeof data === 'object' && Object.keys(data).length >= minEntries ? data : null;
  } catch {
    return null;
  }
}

/** @returns {{ heroes: object|null, items: object|null, abilities: object|null, meta: { patch?: string, fetched?: string } | null }} */
export function loadConstantsSnapshot() {
  return {
    heroes: read('heroes', 100),
    items: read('items', 100),
    abilities: read('abilities', 100),
    meta: read('meta', 1),
  };
}
