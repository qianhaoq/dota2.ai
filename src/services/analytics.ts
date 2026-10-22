/**
 * 前端埋点客户端：fire-and-forget，绝不抛错、绝不阻塞 UI。
 * - anonId：localStorage 里的随机标识（无 PII），由 initAnalytics 初始化
 * - return_visit：老访客每个浏览器会话发一次
 * - review_viewed：每个 matchId 每次会话发一次
 * 发送优先 navigator.sendBeacon（页面卸载也可靠），退回 fetch keepalive。
 */

import {
  buildEventPayload,
  resolveAnonId,
  decideReturnVisit,
  localDayStamp,
  daysSinceFirstVisit,
  type AnalyticsEventName,
  type AnalyticsProps,
  type StorageLike,
  claimReviewViewed,
} from '../utils/analyticsClient';

const EVENTS_URL = '/api/events';

let cachedAnonId: string | null = null;
let identityResolved = false;
let initialized = false;
const reviewViewedMatches = new Set<string>();

/** 惰性解析 anonId：组件在 initAnalytics 之前发事件也能带上 id。 */
function resolveIdentity(): string | null {
  if (identityResolved) return cachedAnonId;
  identityResolved = true;
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    cachedAnonId = resolveAnonId(window.localStorage).anonId;
  } catch {
    cachedAnonId = null;
  }
  return cachedAnonId;
}

/** 应用启动时调用一次：初始化 anonId，并按需发 return_visit。 */
export function initAnalytics(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  try {
    const { anonId } = resolveAnonId(window.localStorage);
    cachedAnonId = anonId;
    identityResolved = true;
    const days = daysSinceFirstVisit(window.localStorage, anonId);
    if (window.sessionStorage && decideReturnVisit(window.localStorage, window.sessionStorage, localDayStamp())) {
      trackEvent('return_visit', { days_since_first: days });
    }
  } catch {
    // 埋点永远不能搞挂应用。
  }
}

/** 上报一条白名单事件；所有异常都被吞掉。 */
export function trackEvent(event: AnalyticsEventName, props?: AnalyticsProps): void {
  try {
    const body = JSON.stringify(buildEventPayload(event, props, resolveIdentity()));
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const sent = navigator.sendBeacon(
        EVENTS_URL,
        new Blob([body], { type: 'application/json' }),
      );
      if (sent) return;
    }
    void fetch(EVENTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // fire-and-forget
  }
}

/**
 * 三结论首屏展示时上报，每个 matchId 每次会话只发一次。v2 页面传字符串
 * ID（与数字 ID 共享同一去重键），事件名与 props 与 legacy 完全一致。
 */
export function trackReviewViewed(matchId: number | string): void {
  const id = typeof matchId === 'number' ? String(matchId) : matchId;
  const valid = typeof matchId === 'number' ? Number.isFinite(matchId) : /^\d{1,20}$/.test(id);
  if (!valid || reviewViewedMatches.has(id)) return;
  reviewViewedMatches.add(id);
  // Persist per browser session so a refresh does not re-count the view.
  let session: StorageLike | null = null;
  try { session = typeof window !== 'undefined' ? window.sessionStorage : null; } catch { session = null; }
  if (session && !claimReviewViewed(session, id)) return;
  // 比赛 ID 超过服务端数值 props 上限（1e9），以标识字符串形式上报。
  trackEvent('review_viewed', { matchId: id });
}
