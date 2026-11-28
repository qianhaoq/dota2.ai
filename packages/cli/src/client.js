import { buildReview, heroByInput, normalizeMatchId, validateReview } from '@dota2ai/review-engine';

export const invalid = (message = 'Invalid input') => Object.assign(new Error(message), { code: 'INVALID_INPUT' });
export function normalizeInput({ match_id, hero, lang = 'en' } = {}) {
  const idStr = normalizeMatchId(match_id);
  if (!idStr) throw invalid('Invalid match ID');
  if (!['en', 'zh'].includes(lang)) throw invalid('Language must be en or zh');
  let heroId;
  if (hero != null && hero !== '') {
    if (!['string', 'number'].includes(typeof hero)) throw invalid('Invalid hero');
    heroId = heroByInput(hero)?.id;
    if (!heroId) throw invalid('Unknown hero');
  }
  return { matchId: Number(idStr), heroId, lang };
}
/** Shared API/offline adapter. Offline reads only OpenDota configuration. */
export function createReviewClient({ offline = false, env = process.env, fetchImpl = globalThis.fetch, fetchMatch, now = () => new Date().toISOString() } = {}) {
  return async input => {
    const { matchId, heroId, lang } = normalizeInput(input);
    if (fetchMatch) {
      const raw = await fetchMatch(matchId, { signal: AbortSignal.timeout(30000) });
      if (!raw?.match_id || raw.error) throw Object.assign(new Error('Match not found'), { code: 'MATCH_NOT_FOUND' });
      return buildReview(raw, { heroId, lang, fetchedAt: now(), presetFollowups: true });
    }
    const url = offline ? new URL(`https://api.opendota.com/api/matches/${matchId}`) : new URL(`/api/v1/review/${matchId}`, env.DOTA2AI_API_BASE || 'https://dota2.ai');
    if (offline) {
      if (env.OPENDOTA_API_KEY) url.searchParams.set('api_key', env.OPENDOTA_API_KEY);
    } else {
      if (heroId != null) url.searchParams.set('hero', String(heroId));
      url.searchParams.set('lang', lang);
    }
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    const body = await response.json();
    if (!response.ok || body?.code || (offline && (!body?.match_id || body.error))) {
      const code = body?.code === 'INVALID_INPUT' ? 'INVALID_INPUT' : response.status === 404 ? 'MATCH_NOT_FOUND' : 'INTERNAL';
      throw Object.assign(new Error(code), { code });
    }
    const review = offline ? buildReview(body, { heroId, lang, fetchedAt: now(), presetFollowups: true }) : body;
    if (!validateReview(review).ok) throw new Error('Invalid upstream review');
    return review;
  };
}
