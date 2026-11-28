/**
 * Where a match's replay address comes from.
 *
 * OpenDota's match record carries `replay_url` only for games it has already
 * dealt with; for most games just played it has none. The Steam Game
 * Coordinator knows the cluster and salt of any recent game, so when the
 * match record gives no address and a GC retriever is configured, it is
 * asked. A GC request is scarce (about a hundred a day per Steam account), so
 * it is made only then, never first.
 *
 * Returns a record `replayUrl()` can read (replay_url, or cluster +
 * replay_salt + match_id), or the match record as it was when no source has
 * an address: the pipeline then reports `no_replay_url`.
 */
import { replayUrl } from '../matchReview/replayIngest/discovery.js';

/** Classify a Steam GC failure into a stable metric tag without leaking any upstream text or secrets. */
export function classifyGcFailure(error) {
  const code = String(error?.code ?? error?.name ?? '').toLowerCase();
  const status = Number(error?.status);
  if (status === 429 || /budget|quota|limit|429/.test(code)) return 'gc_rate_limited';
  if (status === 404 || /not_found|no_match|404/.test(code)) return 'gc_not_found';
  if (status >= 500 || /timeout|abort|connect|network|unavail|5\d\d/.test(code)) return 'gc_unavailable';
  return 'gc_error';
}

/**
 * @param {{ getMatchDetail: (id: number) => Promise<any>, gc?: { fetchMatch: (id: number) => Promise<any> } | null, log?: (msg: string) => void }} deps
 * @returns {(matchId: number) => Promise<any>}
 */
export function createReplaySource({ getMatchDetail, gc = null, log = () => {} }) {
  return async (matchId) => {
    let match = null; let failed = null;
    try { match = await getMatchDetail(matchId); } catch (error) { failed = error; }
    if (match && replayUrl(match)) return match;
    if (!gc) {
      log(`replay_source match=${matchId} outcome=gc_not_configured`);
      if (failed) throw failed;
      return match;
    }
    try {
      const fromGc = await gc.fetchMatch(matchId);
      if (fromGc && replayUrl({ ...fromGc, match_id: fromGc.match_id ?? matchId })) {
        log(`replay_source match=${matchId} outcome=gc_ok`);
        const startTime = Number.isFinite(match?.start_time) ? match.start_time : (Number.isFinite(fromGc.start_time) ? fromGc.start_time : null);
        const duration = Number.isFinite(match?.duration) ? match.duration : (Number.isFinite(fromGc.duration) ? fromGc.duration : null);
        return {
          match_id: matchId,
          cluster: fromGc.cluster,
          replay_salt: fromGc.replay_salt,
          ...(fromGc.replay_url ? { replay_url: fromGc.replay_url } : {}),
          ...(startTime != null ? { start_time: startTime } : {}),
          ...(duration != null ? { duration } : {}),
        };
      }
      log(`replay_source match=${matchId} outcome=gc_no_replay`);
    } catch (error) {
      log(`replay_source match=${matchId} outcome=${classifyGcFailure(error)} detail=${error?.code ?? error?.name ?? 'error'}`);
    }
    if (!match && failed) throw failed;
    return match;
  };
}
