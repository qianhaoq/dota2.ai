/**
 * POST /api/chat 请求体校验（纯逻辑，无网络访问，便于单测）。
 *
 * 前端按 Gemini 格式上送 history：{ role: 'user' | 'model', parts: [{text}] }
 * （见 src/services/geminiService.ts chatWithShopkeeper / LoreChat.tsx），
 * 而服务端要喂给 DeepSeek 的 OpenAI 兼容接口，因此这里一并完成：
 * - 'model' 角色映射为 'assistant'；'system' 及任何其它角色一律丢弃，
 *   绝不转发（防提示注入：客户端不许自带 system 指令）。
 * - 文本取 parts[].text（字符串）拼接，或回退到整条 content 字符串；
 *   拼不出非空文本的条目丢弃。
 * - 条数与字符数双重封顶，超预算从最旧的历史开始丢。
 *
 * 服务端只按 [system 提示词, ...清洗后的 history, {role:'user', content:message}]
 * 组装消息，message 之外的任何自由文本都不进入提示词。
 */

import { normalizeUiLang } from './aiLanguage.js';

/** 单条 message 上限（按 trim 后长度计）。 */
export const CHAT_MESSAGE_MAX_CHARS = 2000;
/** history 最多保留的条数（取最近的 N 条）。 */
export const CHAT_HISTORY_MAX_ITEMS = 12;
/** history + message 合计字符上限（超出从最旧条目开始丢）。 */
export const CHAT_TOTAL_MAX_CHARS = 8000;

const CHAT_HISTORY_ROLES = new Set(['user', 'assistant']);

/** 'model'（Gemini 风格）→ 'assistant'；'user'/'assistant' 原样；其余（含 'system'）丢弃。 */
function entryRole(role) {
  if (role === 'model') return 'assistant';
  return CHAT_HISTORY_ROLES.has(role) ? role : null;
}

/** 取一条 history 的文本：parts[].text 字符串拼接，回退整条 content 字符串；取不到返回 null。 */
function entryText(entry) {
  if (Array.isArray(entry.parts)) {
    const joined = entry.parts
      .filter((part) => part && typeof part === 'object' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
    if (joined.trim() !== '') return joined;
  }
  if (typeof entry.content === 'string' && entry.content.trim() !== '') {
    return entry.content;
  }
  return null;
}

/**
 * 校验 /api/chat 请求体。
 * @param {unknown} body 请求体
 * @param {{ maxMessageChars?: number, maxHistoryItems?: number, maxTotalChars?: number }} [opts]
 * @returns {{ ok: true, message: string, history: Array<{role:'user'|'assistant', content:string}>, lang: 'zh'|'en' }
 *          | { ok: false, status: 400, error: 'invalid_body'|'invalid_message'|'invalid_history'|'message_too_long' }}
 */
export function validateChatRequest(body, opts = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'invalid_body' };
  }

  if (typeof body.message !== 'string' || body.message.trim() === '') {
    return { ok: false, status: 400, error: 'invalid_message' };
  }
  const message = body.message.trim();
  const maxMessageChars = opts.maxMessageChars ?? CHAT_MESSAGE_MAX_CHARS;
  const maxTotalChars = opts.maxTotalChars ?? CHAT_TOTAL_MAX_CHARS;
  // message 单条超限，或 message 自身就撑爆总预算，都不可能靠丢历史补救。
  if (message.length > maxMessageChars || message.length > maxTotalChars) {
    return { ok: false, status: 400, error: 'message_too_long' };
  }

  if (body.history != null && !Array.isArray(body.history)) {
    return { ok: false, status: 400, error: 'invalid_history' };
  }

  const maxHistoryItems = opts.maxHistoryItems ?? CHAT_HISTORY_MAX_ITEMS;
  const sanitized = [];
  for (const entry of body.history ?? []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const role = entryRole(entry.role);
    if (!role) continue;
    const content = entryText(entry);
    if (content === null) continue;
    sanitized.push({ role, content });
  }
  const recent = sanitized.slice(-maxHistoryItems);

  // 从最旧的条目开始丢，直到 history + message 合计字符进预算。
  const history = [];
  let totalChars = message.length;
  for (let i = recent.length - 1; i >= 0; i--) {
    const entry = recent[i];
    if (totalChars + entry.content.length > maxTotalChars) break;
    totalChars += entry.content.length;
    history.unshift(entry);
  }

  return { ok: true, message, history, lang: normalizeUiLang(body.lang) };
}

const CHAT_REQUEST_ERROR_TEXT = {
  invalid_body: { zh: '请求体格式错误', en: 'Invalid request body' },
  invalid_message: { zh: '消息不能为空', en: 'Message must be a non-empty string' },
  invalid_history: { zh: '历史消息格式错误', en: 'Invalid chat history' },
};

/** 校验失败时给客户端看的本地化文案（message_too_long 带具体上限）。 */
export function chatRequestErrorMessage(error, lang, maxMessageChars = CHAT_MESSAGE_MAX_CHARS) {
  if (error === 'message_too_long') {
    return lang === 'zh'
      ? `消息过长（上限 ${maxMessageChars} 字符），请缩短后重试`
      : `Message too long (limit ${maxMessageChars} characters), please shorten it`;
  }
  const text = CHAT_REQUEST_ERROR_TEXT[error];
  return lang === 'zh' ? text?.zh ?? '请求无效' : text?.en ?? 'Invalid request';
}
