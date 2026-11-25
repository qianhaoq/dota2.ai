/**
 * Keeps the patch advisor's notes (lib/patch/data.js) on the newest release:
 * Valve's patch list is checked at most once per `ttlMs`; when its newest
 * release is not the one in use, the major patch and every letter update
 * after it are built from the datafeed (lib/patch/valveNotes.js) and swapped
 * in. Until then — or when Valve cannot be read — the notes in use stay: the
 * committed snapshot at first, the last good live set after.
 *
 * A letter update whose two languages do not line up is not taken, and
 * neither is anything after it: updates are read in order, never skipped.
 * A set already in use is only ever replaced by a longer or newer one.
 */
import { DATAFEED, buildReleaseNotes, currentReleases, fetchBoth, mergeReleases } from './valveNotes.js';
import { useLiveNotes } from './data.js';

/**
 * Whether the releases `next` ('7.42,7.42a,7.42b') should replace those in use: nothing in use yet, a newer
 * major patch, or the same major with more of its updates. Never fewer: an update that was good stays.
 */
export function advances(next, inUse) {
  if (!inUse) return true;
  const a = next.split(','); const b = inUse.split(',');
  if (a[0] !== b[0]) return a[0].localeCompare(b[0], 'en', { numeric: true }) > 0;
  return a.length > b.length && b.every((v, i) => a[i] === v);
}

/**
 * @param {{ fetchJson: (url: string) => Promise<any>, apply?: (notes: object) => void, now?: () => number, ttlMs?: number, log?: (msg: string) => void }} deps
 */
export function createLiveNotes(deps) {
  const { fetchJson } = deps;
  const apply = deps.apply ?? useLiveNotes;
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? 30 * 60_000;
  const log = deps.log ?? (() => {});
  let inUse = null; // the releases in use, e.g. '7.42,7.42a'
  let checkedAt = -Infinity;
  let running = null;

  async function refresh() {
    const list = (await fetchJson(`${DATAFEED}/patchnoteslist?language=english`))?.patches;
    const wanted = currentReleases(list);
    if (!wanted.length) throw new Error('patch list: unexpected shape');
    checkedAt = now();
    if (wanted.join() === inUse) return;
    const [heroes, abilityLists, itemLists] = await Promise.all([fetchBoth(fetchJson, 'herolist'), fetchBoth(fetchJson, 'abilitylist'), fetchBoth(fetchJson, 'itemlist')]);
    const lists = { heroList: heroes.en?.result?.data?.heroes ?? [], abilityLists, itemLists };
    const built = [];
    for (const version of wanted) {
      try {
        built.push(buildReleaseNotes({ version, notes: await fetchBoth(fetchJson, `patchnotes?version=${encodeURIComponent(version)}`), ...lists }));
      } catch (err) {
        log(`patch notes ${version} not taken: ${err?.message ?? err}`);
        break;
      }
    }
    if (!built.length) return;
    const got = built.map((r) => r.version).join();
    // Only forward: a rebuild that came up short (an update Valve did not serve this time) keeps the set in use.
    if (!advances(got, inUse)) return;
    apply(mergeReleases(built, new Date(now()).toISOString().slice(0, 10)));
    inUse = got;
    log(`patch advisor notes: ${got}`);
  }

  /**
   * Starts a check when one is due; waits for it at most `waitMs` (the notes in use answer meanwhile).
   * Never throws.
   */
  async function ensure(waitMs = 3000) {
    if (!running && now() - checkedAt >= ttlMs) {
      running = refresh()
        .catch((err) => { log(`patch notes refresh failed: ${err?.message ?? err}`); checkedAt = now() - ttlMs + 60_000; })
        .finally(() => { running = null; });
    }
    if (running) await Promise.race([running, new Promise((r) => setTimeout(r, waitMs).unref?.())]);
  }

  return { ensure, inUse: () => inUse };
}
