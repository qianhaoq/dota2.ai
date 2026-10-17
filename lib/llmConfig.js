/**
 * DeepSeek 模型与 thinking 模式配置（纯函数，无网络访问，便于单测）。
 *
 * 依据 DeepSeek 官方文档 https://api-docs.deepseek.com/ （2026-10-17 核对）：
 * - 推荐模型名为 `deepseek-flash`（DeepSeek-V4.1-Flash-1017）与
 *   `deepseek-v4-pro`。旧名 `deepseek-chat` / `deepseek-reasoner` 按官方
 *   V4 发布公告（https://api-docs.deepseek.com/news/news260424/）已于
 *   2026-07-24 退役，Chat Completions 文档只列出上述两个名字；因此这里把旧名
 *   一律映射到默认模型（legacyMappedFrom 记录原值，便于启动日志告警），绝不
 *   原样发给上游。
 * - 官方文档说明 deepseek-flash 默认开启 thinking（effort high），会显著增加
 *   延迟；而复盘卡片和追问都在 40s deadline（REVIEW_CARD_COMPLETION_DEADLINE_MS）
 *   内作答，所以这里默认 disabled，可用 DEEPSEEK_THINKING=enabled 打开。
 */

export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-flash';

/** 已退役的旧模型名：映射到 DEFAULT_DEEPSEEK_MODEL，不原样发送。 */
export const LEGACY_DEEPSEEK_MODELS = new Set(['deepseek-chat', 'deepseek-reasoner']);

/**
 * 可在公开端点（/api/health）原样展示的模型名白名单：官方文档列出的两个
 * 推荐名。自定义部署名（内部别名 / 网关名 / 退役旧名）不外泄，统一报
 * 'deepseek-custom'。
 */
export const PUBLIC_DEEPSEEK_MODELS = new Set(['deepseek-flash', 'deepseek-v4-pro']);

const MODEL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const THINKING_MODES = new Set(['enabled', 'disabled']);

/** Key-shaped contiguous run (no separators): 24+ alphanumerics. */
const HIGH_ENTROPY_RUN_PATTERN = /[a-z0-9]{24,}/i;

/**
 * Credential heuristics for model-name-shaped values (QA P2)：误把 API key /
 * token 粘进 DEEPSEEK_MODEL 时，这个值绝不能进启动日志，也不该发给上游。
 * 宁可过杀——判定为 credential 只意味着回退默认模型 / 日志打码。
 * @param {string} model 已 trim 的非空字符串
 */
function looksLikeCredential(model) {
  const lower = model.toLowerCase();
  return lower.startsWith('sk-')
    || lower.startsWith('sk_')
    || /key|token|secret|passw|pwd|bearer|auth|credential/.test(lower)
    || model.length > 40
    || HIGH_ENTROPY_RUN_PATTERN.test(model);
}

/**
 * 解析 DeepSeek 请求配置。非法值一律回退默认，绝不抛错（启动路径）。
 * @param {Record<string, unknown>} env 例如 process.env
 * extraBody 合并进 chat.completions.create 的请求体；legacyMappedFrom 为被映射掉的旧模型名（无则 null）；
 * credentialMappedFrom 为「长得像 API key / token」而被整体忽略的 DEEPSEEK_MODEL 原值
 * （无则 null）——调用方只能告警「看起来是密钥」，绝不能把原值写进日志。
 * @returns {{ model: string, thinking: 'enabled' | 'disabled', extraBody: Record<string, unknown>, legacyMappedFrom: string | null, credentialMappedFrom: string | null }}
 */
export function resolveDeepSeekConfig(env = {}) {
  const rawModel = typeof env.DEEPSEEK_MODEL === 'string' ? env.DEEPSEEK_MODEL.trim() : '';
  const credentialMappedFrom = rawModel && looksLikeCredential(rawModel) ? rawModel : null;
  const valid = rawModel && !credentialMappedFrom && MODEL_NAME_PATTERN.test(rawModel) ? rawModel : '';
  const legacyMappedFrom = valid && LEGACY_DEEPSEEK_MODELS.has(valid.toLowerCase()) ? valid : null;
  const model = valid && !legacyMappedFrom ? valid : DEFAULT_DEEPSEEK_MODEL;

  const rawThinking = typeof env.DEEPSEEK_THINKING === 'string' ? env.DEEPSEEK_THINKING.trim() : '';
  const thinking = THINKING_MODES.has(rawThinking) ? rawThinking : 'disabled';

  // 显式带上解析出的 thinking 开关（V4 系列默认开启 thinking）。
  const extraBody = { thinking: { type: thinking } };
  return { model, thinking, extraBody, legacyMappedFrom, credentialMappedFrom };
}

/** loggableModelName 对非白名单/credential 形状一律返回的占位符。 */
export const REDACTED_CUSTOM_MODEL = '[redacted-custom-model]';

/**
 * 启动日志等服务器端日志可安全原样输出的模型名（QA P2）：仅白名单
 * （官方推荐名 / 退役旧名）原样返回；其余任何自定义名一律打码为
 * '[redacted-custom-model]'（credential 启发式必然不完备，宁可全打码）。
 * @param {unknown} model
 * @returns {string}
 */
export function loggableModelName(model) {
  if (typeof model !== 'string') return REDACTED_CUSTOM_MODEL;
  const value = model.trim();
  if (!value) return REDACTED_CUSTOM_MODEL;
  if (PUBLIC_DEEPSEEK_MODELS.has(value) || LEGACY_DEEPSEEK_MODELS.has(value.toLowerCase())) {
    return value;
  }
  // Every non-allowlisted name is masked: credential heuristics are inherently
  // incomplete (Codex P1), and a custom deployment name is not worth the risk.
  return REDACTED_CUSTOM_MODEL;
}

/**
 * 公开端点（/api/health）的 model 字段白名单：只有官方推荐名原样返回，
 * 其他任何值（自定义部署名、内部别名、退役旧名、非法输入）一律报
 * 'deepseek-custom'，避免把部署细节泄露给匿名访问者。provider 字段不受
 * 影响（始终 'deepseek'）。
 * @param {unknown} model
 * @returns {string}
 */
export function publicModelName(model) {
  return typeof model === 'string' && PUBLIC_DEEPSEEK_MODELS.has(model) ? model : 'deepseek-custom';
}
