/**
 * 埋点客户端的纯逻辑部分（无浏览器 API、无网络，便于 node 单测）：
 * - 匿名 anonId 的生成 / 复用 / 持久化决策（localStorage 里只是一个随机
 *   标识符，无任何 PII）
 * - return_visit 的「每会话一次」判定（sessionStorage 标记）
 * - 事件 payload 组装（与 lib/analyticsEvents.js 的白名单口径一致）
 */

export type AnalyticsEventName =
  | 'review_viewed'
  | 'followup_clicked'
  | 'fakedoor_clicked'
  | 'return_visit';

export type AnalyticsProps = Record<string, string | number | boolean>;

export interface AnalyticsEventPayload {
  event: AnalyticsEventName;
  props: AnalyticsProps;
  anonId: string | null;
}

export const ANON_ID_STORAGE_KEY = 'dota2ai.anonId';
export const RETURN_VISIT_SESSION_KEY = 'dota2ai.returnVisitSent';

/** 与服务端 IDENTIFIER_RE 一致：短标识符，无空格、无自由文本。 */
const ANON_ID_RE = /^anon_(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-z]{6,12}\.[0-9a-z]{4,10})$/;

export function isValidAnonId(raw: unknown): raw is string {
  return typeof raw === 'string' && ANON_ID_RE.test(raw);
}

/** 最小 Storage 接口，单测用 Map 实现即可。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultRandomToken(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to Math.random
  }
  return `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`;
}

/** 生成一个随机匿名 id（anon_ 前缀 + UUID/随机串，无 PII）。 */
export function generateAnonId(randomToken: () => string = defaultRandomToken): string {
  return `anon_${randomToken()}`.slice(0, 64);
}

export interface AnalyticsIdentity {
  anonId: string;
  /** True 当 localStorage 里已存在合法 id —— 即该访客之前来过。 */
  isReturning: boolean;
}

/**
 * 读取或创建匿名 id：已有合法 id 直接复用并标记 isReturning；缺失/非法
 * （用户手改、旧格式）则重新生成并写回。存储异常（隐私模式等）静默降级，
 * 依然返回一个可用 id。
 */
export function resolveAnonId(
  storage: StorageLike,
  makeId: () => string = generateAnonId,
): AnalyticsIdentity {
  let existing: string | null = null;
  try {
    existing = storage.getItem(ANON_ID_STORAGE_KEY);
  } catch {
    existing = null;
  }
  if (isValidAnonId(existing)) {
    return { anonId: existing, isReturning: true };
  }
  const anonId = makeId();
  try {
    storage.setItem(ANON_ID_STORAGE_KEY, anonId);
  } catch {
    // 存储不可用：id 只在本次会话内存活，事件照发。
  }
  return { anonId, isReturning: false };
}

export const LAST_VISIT_DAY_STORAGE_KEY = 'dota2ai.lastVisitDay';

/** 本地日历日（YYYY-MM-DD），只用于比较是否跨天，不上报。 */
export function localDayStamp(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

/**
 * return_visit 判定：同一会话内（含刷新）只评估一次；只有当上次访问日
 * 存在且与今天不同（跨天回访）时才返回 true。首次访问只写入标记，绝不发；
 * 首访当天刷新 / 新开标签也不算回访。存储异常一律不发（宁缺毋滥）。
 */
export function decideReturnVisit(local: StorageLike, session: StorageLike, today: string): boolean {
  try {
    if (session.getItem(RETURN_VISIT_SESSION_KEY) === '1') return false;
    session.setItem(RETURN_VISIT_SESSION_KEY, '1');
    const lastDay = local.getItem(LAST_VISIT_DAY_STORAGE_KEY);
    local.setItem(LAST_VISIT_DAY_STORAGE_KEY, today);
    return typeof lastDay === 'string' && lastDay.length > 0 && lastDay !== today;
  } catch {
    return false;
  }
}

/** 组装 POST /api/events 的请求体；anonId 非法时归零为 null（事件照发）。 */
export function buildEventPayload(
  event: AnalyticsEventName,
  props?: AnalyticsProps,
  anonId?: string | null,
): AnalyticsEventPayload {
  return {
    event,
    props: props ?? {},
    anonId: isValidAnonId(anonId) ? anonId : null,
  };
}

/** Composer submit provenance: unchanged prefilled chip text = preset, anything else = custom. */
export function followUpKind(submitted: string, prefilled: string | null | undefined): 'preset' | 'custom' {
  return prefilled && submitted.trim() === prefilled.trim() ? 'preset' : 'custom';
}

export const REVIEW_VIEWED_SESSION_PREFIX = 'dota2ai.reviewViewed.';

/** Returns true (and marks) the first time a match is viewed in this browser session. */
export function claimReviewViewed(session: StorageLike, matchId: number): boolean {
  const key = `${REVIEW_VIEWED_SESSION_PREFIX}${matchId}`;
  try {
    if (session.getItem(key) === '1') return false;
    session.setItem(key, '1');
    return true;
  } catch {
    return true;
  }
}
