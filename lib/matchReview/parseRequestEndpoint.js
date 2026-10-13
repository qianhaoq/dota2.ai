/**
 * 复盘解析状态（只读）与显式解析请求端点。
 *
 * 背景（Codex P1）：解析提交的去重/预算都是单实例内存态，Cloud Run 多实例
 * 自动扩缩时，事实加载路径上的自动提交会在实例间叠加，合力打爆 OpenDota
 * 的解析配额。因此：
 * - 事实加载（GET /api/review/:id）与复盘流（POST /api/review/:id）只「读」
 *   解析状态：已解析 → parsed；tracker 里已有 pending/failed/冷却条目 →
 *   原样上报；否则 → unparsed（提示用户可显式请求解析），绝不提交。
 * - POST /api/review/:matchId/parse-request 是唯一调用 submitParseRequest
 *   的路径（去重/冷却、全局与单客户端预算、trusted-proxy 客户端 IP、断开
 *   即中止），并以 CSRF/直连防护要求「非简单请求」特征（JSON content-type
 *   或 X-Requested-With）；GET 一律 405。
 *
 * 依赖全部注入（submitParseRequest/getMatchDetail/resolveClientIp/守卫），
 * server.js 只做装配，行为在单测里用真实 express 应用验证。
 */
import { isMatchParsed, parseStatusPayload } from './matchParse.js';
import { validateParseRequestPost } from './reviewRequestGuard.js';
import { mapOpenDotaFetchError } from './openDotaErrors.js';
import { normalizeUiLang } from '../aiLanguage.js';

/**
 * 只读解析状态解析器：供事实 GET 与复盘 POST 共用，永不提交解析。
 * @param {{
 *   tracker: ReturnType<typeof import('./matchParse.js').createParseRequestTracker>,
 *   isMatchParsedImpl?: (match: object | null | undefined) => boolean,
 * }} options
 * @returns {(matchId: number, matchData: object, lang: string) =>
 *   { status: string, jobId: number | null, retryAfterSec: number | null, message: string }}
 */
export function createReadOnlyParseStatusResolver(options = {}) {
  const { tracker } = options;
  if (!tracker) {
    throw new TypeError('createReadOnlyParseStatusResolver requires a tracker');
  }
  const checkParsed = options.isMatchParsedImpl ?? isMatchParsed;

  return function resolveReviewParseStatus(matchId, matchData, lang) {
    if (checkParsed(matchData)) {
      return parseStatusPayload('parsed', { lang });
    }
    // 只读镜像 tracker 现状（pending/failed/中止冷却窗口），不补交。
    const active = tracker.active(matchId);
    if (active) {
      return parseStatusPayload(active.failed ? 'failed' : 'pending', {
        jobId: active.jobId,
        retryAfterSec: active.retryAfterSec,
        lang,
      });
    }
    return parseStatusPayload('unparsed', { lang });
  };
}

/**
 * 显式解析请求端点的 express 处理器（唯一提交路径）。
 * @param {{
 *   submitParseRequest: (matchId: number, clientIp: string, opts?: { signal?: AbortSignal, lang?: string }) => Promise<object>,
 *   getMatchDetail: (matchId: number, options?: object) => Promise<object>,
 *   resolveClientIp: (req: object) => string,
 *   guard?: (req: object) => { ok: boolean, status?: number, errorZh?: string, errorEn?: string },
 *   log?: (msg: string) => void,
 * }} options
 */
export function createReviewParseRequestHandler(options = {}) {
  const { submitParseRequest, getMatchDetail, resolveClientIp } = options;
  if (typeof submitParseRequest !== 'function'
    || typeof getMatchDetail !== 'function'
    || typeof resolveClientIp !== 'function') {
    throw new TypeError(
      'createReviewParseRequestHandler requires submitParseRequest, getMatchDetail and resolveClientIp',
    );
  }
  const guard = options.guard ?? validateParseRequestPost;
  const log = options.log ?? (() => {});

  return async function handleMatchReviewParseRequest(req, res) {
    const lang = normalizeUiLang(req.body?.lang ?? req.query.lang ?? 'en');
    const isZh = lang === 'zh';
    const matchId = Number(req.params.matchId);

    if (!Number.isFinite(matchId) || matchId <= 0) {
      return res.status(400).json({ error: isZh ? '无效的比赛 ID' : 'Invalid match ID' });
    }

    const postGuard = guard(req);
    if (!postGuard.ok) {
      return res.status(postGuard.status).json({
        error: isZh ? postGuard.errorZh : postGuard.errorEn,
      });
    }

    // 断开即中止：与 handleMatchReview 相同的两模式清理 —— 客户端断开时
    // 中止上游（比赛详情拉取与解析提交），不再为已离开的客户端补交配额。
    let clientGone = false;
    const abortController = new AbortController();
    const abortUpstream = () => {
      if (res.writableEnded) return;
      clientGone = true;
      abortController.abort();
    };
    const detachAbortListeners = () => {
      res.removeListener('close', abortUpstream);
      req.removeListener('aborted', abortUpstream);
    };
    res.on('close', abortUpstream);
    req.on('aborted', abortUpstream);

    try {
      const matchData = await getMatchDetail(matchId, { signal: abortController.signal });
      if (clientGone) return;

      // 已解析：直接答复，不消耗预算也不提交。
      if (isMatchParsed(matchData)) {
        log(`match=${matchId} already parsed — no submission`);
        return res.json(parseStatusPayload('parsed', { lang }));
      }

      const parse = await submitParseRequest(matchId, resolveClientIp(req), {
        signal: abortController.signal,
        lang,
      });
      if (clientGone) return;
      return res.json(parse);
    } catch (error) {
      // submitParseRequest 对客户端断开中止原样重抛：此时客户端已断开，
      // 任何响应都写不出去，静默退出（监听器在 finally 里统一拆掉）。
      if (clientGone || abortController.signal.aborted || error?.name === 'AbortError') return;
      console.error('Match parse request error:', error);
      const mapped = mapOpenDotaFetchError(error, isZh);
      return res.status(mapped.status).json(mapped.body);
    } finally {
      detachAbortListeners();
    }
  };
}

/**
 * GET 守卫：显式 405 JSON，避免落进 SPA fallback 返回 index.html。
 * （与 /api/suggestions、/api/feedback 的 GET 守卫同一约定。）
 */
export function rejectParseRequestGet(_req, res) {
  res.status(405).json({ error: 'Use POST' });
}
