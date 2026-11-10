import { validateParseRequestPost } from '../reviewRequestGuard.js';
import { replayStatusPayload } from '../../../packages/review-engine/src/replay.js';

export function createReplayIngestHandler({ ingest, getMatchDetail, resolveClientIp }) {
  return async (req, res) => {
    const lang = (req.body?.lang ?? req.query.lang) === 'zh' ? 'zh' : 'en';
    const id = req.params.matchId;
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) return res.status(400).json({error:'Invalid match ID'});
    const guard = validateParseRequestPost(req);
    if (!guard.ok) return res.status(guard.status).json({error:lang === 'zh' ? guard.errorZh : guard.errorEn});
    if (!ingest.enabled) return res.json(replayStatusPayload('replay_ingest_disabled', lang));
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', abort); req.on('aborted', abort);
    try {
      const raw = await getMatchDetail(Number(id), {signal:controller.signal});
      controller.signal.throwIfAborted();
      const result = await ingest.submit(raw, resolveClientIp(req), {signal:controller.signal, lang});
      if (!controller.signal.aborted) res.json(result);
    } catch {
      if (!controller.signal.aborted) res.status(502).json(replayStatusPayload('replay_failed', lang));
    } finally { res.removeListener('close', abort); req.removeListener('aborted', abort); }
  };
}
