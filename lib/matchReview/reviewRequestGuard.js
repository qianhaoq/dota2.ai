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
