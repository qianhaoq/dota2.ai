/**
 * 站内留言 / 假门（fake-door）兴趣表达的提交校验（纯逻辑，无 IO，便于单测）。
 *
 * 除原有「留言必须有 message」外，允许一条带 kind 的兴趣记录（如
 * 'fakedoor_steam_autoreview'）：message 可省略，contact 可选。没有 QQ 专属
 * 字段，也不生成 mailto 链接——后端只负责校验与落盘。
 */

/** 允许的反馈类别（kind）。 */
export const FEEDBACK_KINDS = new Set([
  'fakedoor_steam_autoreview',
  'evidence_claim_vote',
]);

/** message 的最大长度（按 UTF-16 码元截断，与既有端点一致）。 */
export const FEEDBACK_MAX_MESSAGE = 4000;
/** name / contact 等短字段的最大长度。 */
export const FEEDBACK_MAX_FIELD = 200;

/**
 * 校验并归一化一条 /api/feedback 提交。
 * @param {unknown} body 请求体
 * @returns {{ ok: true, kind: string | null, message: string, name: string, contact: string, matchId: string, hero: string, insightId: string } | { ok: false, error: 'invalid_body' | 'invalid_kind' | 'message_required' }}
 *  - 无 kind 时 message 必填（既有留言行为，保持不变）
 *  - kind 必须在 FEEDBACK_KINDS 白名单内，否则 invalid_kind
 *  - matchId / hero / insightId 可选，供 evidence_claim_vote 区分场次
 */
export function normalizeFeedbackSubmission(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'invalid_body' };
  }

  const kindRaw = typeof body.kind === 'string' ? body.kind.trim() : '';
  const categoryRaw = typeof body.category === 'string' ? body.category.trim() : '';
  const kind = kindRaw || categoryRaw;
  if (kind && !FEEDBACK_KINDS.has(kind)) {
    return { ok: false, error: 'invalid_kind' };
  }

  const messageRaw = body.message;
  if (!kind && (typeof messageRaw !== 'string' || !messageRaw.trim())) {
    return { ok: false, error: 'message_required' };
  }

  const message = typeof messageRaw === 'string' && messageRaw.trim()
    ? messageRaw.trim().slice(0, FEEDBACK_MAX_MESSAGE)
    : '';
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, FEEDBACK_MAX_FIELD) : '';
  const contact = typeof body.contact === 'string' ? body.contact.trim().slice(0, FEEDBACK_MAX_FIELD) : '';
  const matchId = body.matchId != null && body.matchId !== ''
    ? String(body.matchId).trim().slice(0, FEEDBACK_MAX_FIELD)
    : '';
  const hero = typeof body.hero === 'string' ? body.hero.trim().slice(0, FEEDBACK_MAX_FIELD) : '';
  const insightId = typeof body.insightId === 'string' ? body.insightId.trim().slice(0, FEEDBACK_MAX_FIELD) : '';

  return { ok: true, kind: kind || null, message, name, contact, matchId, hero, insightId };
}
