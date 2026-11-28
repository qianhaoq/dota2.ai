import { heroByInput, normalizeMatchId } from '@dota2ai/review-engine';

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
