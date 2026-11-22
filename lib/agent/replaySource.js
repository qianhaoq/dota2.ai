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

/**
 * @param {{ getMatchDetail: (id: number) => Promise<any>, gc?: { fetchMatch: (id: number) => Promise<any> } | null, log?: (msg: string) => void }} deps
 * @returns {(matchId: number) => Promise<any>}
 */
export function createReplaySource({ getMatchDetail, gc = null, log = () => {} }) {
  return async (matchId) => {
    let match = null; let failed = null;
    try { match = await getMatchDetail(matchId); } catch (error) { failed = error; }
    if (match && replayUrl(match)) return match;
    if (!gc) { if (failed) throw failed; return match; }
    try {
      const fromGc = await gc.fetchMatch(matchId);
      if (fromGc && replayUrl({ ...fromGc, match_id: fromGc.match_id ?? matchId })) {
        log(`replay address for match=${matchId} from the game coordinator`);
        return { match_id: matchId, cluster: fromGc.cluster, replay_salt: fromGc.replay_salt, ...(fromGc.replay_url ? { replay_url: fromGc.replay_url } : {}) };
      }
    } catch (error) {
      log(`game coordinator has no answer for match=${matchId}: ${error?.code ?? error?.name ?? 'error'}`);
    }
    if (!match && failed) throw failed;
    return match;
  };
}
