/**
 * The reviews a first visitor is sent to: the home page's example and the
 * agent one-liner's match, in both languages. A new prompt version hides the
 * reviews stored under the old one, and the first visitor after a deploy then
 * waited minutes on a page meant to show what the product does. The instance
 * starting up asks for each one that is missing, so it is ready, or on its
 * way, before anyone opens it.
 */
export const SHOWCASE_REVIEWS = Object.freeze([
  { matchId: '9091400302', hero: 'tidehunter', lang: 'en' },
  { matchId: '9100904020', hero: 'beastmaster', lang: 'en' },
]);

/**
 * Start each showcase review that is not there yet. Only "none" starts one:
 * a review that is there, running (here or on another instance) or just
 * failed is left alone, so instances starting together do not each pay for
 * it and a review that keeps failing is not retried on every start. Never
 * throws. Resolves with what was done for each, in the list's order.
 *
 * @param {{ status: Function, start: Function }} service
 * @param {{ list?: ReadonlyArray<{ matchId: string, hero: string, lang: string }>, log?: (msg: string) => void }} [opts]
 */
export function warmShowcase(service, { list = SHOWCASE_REVIEWS, log = () => {} } = {}) {
  // All at once: the instance waits for this before it takes requests.
  return Promise.all(list.map(async ({ matchId, hero, lang }) => {
    let result;
    try {
      const now = await service.status(matchId, hero, lang);
      if (now.status === 'none') result = `started:${(await service.start(matchId, hero, lang)).status}`;
      else if (now.status === 'ready' && now.stale_version && !now.refresh_failed) result = `started:${(await service.start(matchId, hero, lang, { refresh: true })).status}`;
      else result = now.status;
    } catch (error) {
      result = `error:${error?.name ?? 'error'}`;
    }
    log(`showcase match=${matchId} hero=${hero} lang=${lang} -> ${result}`);
    return result;
  }));
}
