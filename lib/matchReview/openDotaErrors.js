/**
 * OpenDota 上游错误 → HTTP 响应的映射（纯逻辑，无 IO，便于单测）。
 * 从 server.js 抽出：解析请求端点（parseRequestEndpoint.js）与比赛事实/
 * 复盘路由需要同一份映射，放在 lib 里避免两处漂移。
 */

/** 值得重试的上游 HTTP 状态（请求超时/过早/限流/服务端错误）。 */
export function isRetryableHttpStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

/**
 * @param {unknown} error
 * @param {boolean} isZh
 * @returns {{ status: number, body: { error: string, upstream?: string, upstreamStatus?: number, retryable?: boolean } }}
 */
export function mapOpenDotaFetchError(error, isZh) {
  const upstreamStatus = typeof error?.status === 'number'
    ? error.status
    : (() => {
        const m = /HTTP (\d{3})/.exec(error?.message || '');
        return m ? Number(m[1]) : undefined;
      })();
  const isUpstream = error?.upstream === 'opendota'
    || upstreamStatus != null
    || /opendota|fetch failed|timeout|network/i.test(error?.message || '');
  const retryable = error?.retryable === true
    || (upstreamStatus != null && isRetryableHttpStatus(upstreamStatus))
    || (upstreamStatus == null && isUpstream);

  if (upstreamStatus === 404) {
    return {
      status: 404,
      body: {
        error: isZh ? '找不到这场比赛' : 'Match not found',
        upstream: 'opendota',
        upstreamStatus: 404,
        retryable: false,
      },
    };
  }

  if (retryable) {
    return {
      status: 503,
      body: {
        error: isZh
          ? 'OpenDota 暂时不可用，请稍后重试'
          : 'OpenDota is temporarily unavailable. Please retry in a moment.',
        upstream: 'opendota',
        upstreamStatus,
        retryable: true,
      },
    };
  }

  if (isUpstream) {
    return {
      status: 502,
      body: {
        error: isZh ? '拉取比赛失败' : 'Failed to load match',
        upstream: 'opendota',
        upstreamStatus,
        retryable: false,
      },
    };
  }

  return {
    status: 500,
    body: {
      error: error?.message || (isZh ? '拉取比赛失败' : 'Failed to load match'),
      retryable: false,
    },
  };
}

/**
 * 是否 OpenDota 拉取错误（决定复盘路由用上游映射还是普通 500 兜底）。
 * @param {unknown} error
 * @returns {boolean}
 */
export function isOpenDotaFetchError(error) {
  if (!error) return false;
  if (error.upstream === 'opendota') return true;
  if (typeof error.status === 'number') return true;
  return /HTTP \d{3}/.test(error.message || '');
}
