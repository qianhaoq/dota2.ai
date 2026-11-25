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
  pageKind,
  sourceFrom,
} from '../utils/analyticsClient';
import { TRAFFIC_SOURCES } from '../../lib/analyticsEvents.js';

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

const SOURCE_SESSION_KEY = 'dota2ai.src';
let sessionSource: string | null = null;

/**
 * The community a visit came from (`?src=` on the link it arrived by), kept for the browser session so the
 * match page and the finished review are counted for it even after the reader has moved on from that URL.
 * The first source of a session wins. Null when the visit did not come by such a link.
 */
export function trafficSource(): string | null {
  // The session's storage is the record; the in-memory copy only stands in where storage is blocked.
  try {
    const kept = typeof window !== 'undefined' ? window.sessionStorage?.getItem(SOURCE_SESSION_KEY) : null;
    if (kept && TRAFFIC_SOURCES.includes(kept)) return kept;
  } catch { /* storage blocked */ }
  return sessionSource;
}

function captureSource(): void {
  const src = sourceFrom(window.location.search, TRAFFIC_SOURCES);
  if (!src || trafficSource()) return;
  sessionSource = src;
  try { window.sessionStorage?.setItem(SOURCE_SESSION_KEY, src); } catch { /* the in-memory copy still holds */ }
  trackEvent('arrived', { src, page: pageKind(window.location.pathname) });
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
  try {
    captureSource();
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
export function trackReviewViewed(matchId: number | string, extra: AnalyticsProps = {}): void {
  const id = typeof matchId === 'number' ? String(matchId) : matchId;
  const valid = typeof matchId === 'number' ? Number.isFinite(matchId) : /^\d{1,20}$/.test(id);
  if (!valid || reviewViewedMatches.has(id)) return;
  reviewViewedMatches.add(id);
  // Persist per browser session so a refresh does not re-count the view.
  let session: StorageLike | null = null;
  try { session = typeof window !== 'undefined' ? window.sessionStorage : null; } catch { session = null; }
  if (session && !claimReviewViewed(session, id)) return;
  // 比赛 ID 超过服务端数值 props 上限（1e9），以标识字符串形式上报。
  trackEvent('review_viewed', { ...extra, matchId: id });
}

/**
 * An event that counts once per browser session for `key` (a match opened, say): a refresh or a second
 * render does not count it again.
 */
const sentOnce = new Set<string>();
export function trackOnce(key: string, event: AnalyticsEventName, props: AnalyticsProps = {}): void {
  const k = `dota2ai.once.${event}.${key}`;
  if (sentOnce.has(k)) return;
  sentOnce.add(k);
  try {
    const session = typeof window !== 'undefined' ? window.sessionStorage : null;
    if (session) { if (session.getItem(k) === '1') return; session.setItem(k, '1'); }
  } catch { /* storage blocked: the in-memory set still holds it for this page */ }
  trackEvent(event, props);
}
