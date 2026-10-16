/**
 * Fake-door（假门）兴趣提交的纯逻辑：组装 POST /api/feedback 的请求体。
 * kind 必须在服务端白名单内（lib/feedbackStore.js），contact 可选。
 */

export const FAKEDOOR_STEAM_AUTOREVIEW_KIND = 'fakedoor_steam_autoreview' as const;

/** 与服务端 FEEDBACK_MAX_FIELD 一致。 */
export const FAKEDOOR_MAX_CONTACT = 200;

export interface FakedoorSubmission {
  kind: typeof FAKEDOOR_STEAM_AUTOREVIEW_KIND;
  contact?: string;
  lang: 'en' | 'zh';
}

/** 组装「绑定 Steam 自动复盘」假门提交：contact 为空时省略该字段。 */
export function buildFakedoorSubmission(contact?: string | null, lang: 'en' | 'zh' = 'en'): FakedoorSubmission {
  const trimmed = (contact ?? '').trim().slice(0, FAKEDOOR_MAX_CONTACT);
  const uiLang = lang === 'zh' ? 'zh' : 'en';
  return trimmed
    ? { kind: FAKEDOOR_STEAM_AUTOREVIEW_KIND, contact: trimmed, lang: uiLang }
    : { kind: FAKEDOOR_STEAM_AUTOREVIEW_KIND, lang: uiLang };
}
