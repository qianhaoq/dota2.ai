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
 */
import { DATAFEED, buildReleaseNotes, currentReleases, fetchBoth, mergeReleases } from './valveNotes.js';
import { useLiveNotes } from './data.js';

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
    if (got === inUse) return;
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
