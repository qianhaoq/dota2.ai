/**
 * Validate POST /api/review requests before paid upstream work.
 * @param {{ headers: Record<string, string | string[] | undefined>, method?: string }} req
 */
export function validateReviewPostRequest(req) {
  if (req.method !== 'POST') {
    return { ok: true };
  }

  const contentType = String(req.headers['content-type'] || '')
    .split(';')[0]
    .trim()
    .toLowerCase();

  if (contentType !== 'application/json') {
    return {
      ok: false,
      status: 415,
      errorZh: '复盘请求需要 Content-Type: application/json',
      errorEn: 'Review requests require Content-Type: application/json',
    };
  }

  return validateSameOrigin(req);
}

/**
 * Validate POST /api/review/:matchId/parse-request before submitting an
 * OpenDota parse (the only automatic-submission path left). Drive-by/CSRF
 * protection: the request must be a "non-simple" request — either a JSON
 * content-type (cross-site forms cannot send it without a CORS preflight)
 * or a custom header (X-Requested-With), which browsers likewise refuse to
 * let cross-site form posts set. GET is rejected by the route itself.
 * @param {{ headers: Record<string, string | string[] | undefined> }} req
 */
export function validateParseRequestPost(req) {
  const contentType = String(req.headers['content-type'] || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const hasCustomHeader = Boolean(req.headers['x-requested-with']);

  if (contentType !== 'application/json' && !hasCustomHeader) {
    return {
      ok: false,
      status: 415,
      errorZh: '解析请求需要 Content-Type: application/json 或 X-Requested-With 请求头',
      errorEn: 'Parse requests require Content-Type: application/json or an X-Requested-With header',
    };
  }

  return validateSameOrigin(req);
}

/**
 * Origin/host 一致性检查（两个 POST 守卫共用）。Origin 缺失（同源 fetch /
 * curl）时放行，存在且与 Host 不一致时拒绝。
 * @param {{ headers: Record<string, string | string[] | undefined> }} req
 */
function validateSameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && host) {
    try {
      const originHost = new URL(String(origin)).host;
      if (originHost !== String(host)) {
        return {
          ok: false,
          status: 403,
          errorZh: '不允许跨源复盘请求',
          errorEn: 'Cross-origin review requests are not allowed',
        };
      }
    } catch {
      return {
        ok: false,
        status: 403,
        errorZh: '无效的 Origin',
        errorEn: 'Invalid Origin header',
      };
    }
  }

  return { ok: true };
}
