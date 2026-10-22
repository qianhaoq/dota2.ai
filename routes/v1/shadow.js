import { buildReview } from '../../packages/review-engine/src/buildReview.js';
/** Only registers work: legacy data and responses are never modified. */
export function scheduleShadow(res, { raw, heroId, lang, legacy, logger = console, enabled = process.env.SHADOW_DIFF !== 'false' && process.env.SHADOW_DIFF !== '0' }) {
  if (!enabled) return;
  res.once('finish', () => setImmediate(() => {
    try {
      const review = buildReview(raw, { heroId, lang, fetchedAt: new Date().toISOString() });
      const turning = review.insights.find(i => i.id === 'turning_point');
      const fix = review.insights.find(i => i.id === 'fix_this');
      const v1Time = legacy.turningPoint?.evidence?.[1]?.time;
      const v1Minute = typeof v1Time === 'string' && /^\d+:\d{2}$/.test(v1Time) ? Number(v1Time.split(':')[0]) + Number(v1Time.split(':')[1]) / 60 : null;
      logger.log(JSON.stringify({ event: 'shadow_diff', matchId: raw.match_id,
        turning_minute_v1: v1Minute,
        v2: turning ? turning.time.to / 60 : null, fix_kind: fix?.pattern ?? null,
        numbers_mismatch: (review.facts['deaths.total']?.value ?? null) !== (raw.players?.find(p => p.hero_id === heroId)?.deaths ?? null),
      }));
    } catch { /* Shadow comparisons must never affect the legacy request. */ }
  }));
}
