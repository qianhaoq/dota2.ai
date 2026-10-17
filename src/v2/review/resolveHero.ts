import type { MatchPlayerFact } from '../../types/matchReview';

/**
 * Resolves the `?hero=` query param against the match roster: by internalSlug
 * (case-insensitive), English hero name (case-insensitive), or numeric heroId.
 * Returns null when the param is absent or matches nobody (caller shows the
 * hero picker then).
 */
export function resolveHeroParam(
  heroParam: string | null | undefined,
  players: MatchPlayerFact[] | null | undefined,
): MatchPlayerFact | null {
  if (!heroParam || !players || players.length === 0) return null;
  const needle = heroParam.trim().toLowerCase();
  if (!needle) return null;

  if (/^\d{1,4}$/.test(needle)) {
    // Numeric heroId comparison — the roster's heroId is a small server-side
    // number, safe to coerce (unlike the 32-bit match ids).
    const heroId = Number(needle);
    const byId = players.find((p) => p.heroId === heroId);
    if (byId) return byId;
  }

  return (
    players.find((p) => (p.internalSlug ?? '').toLowerCase() === needle)
    ?? players.find((p) => (p.nameEn ?? '').toLowerCase() === needle)
    ?? null
  );
}
