/**
 * LLM/Provider error hygiene（QA P2 #5/#4）：DeepSeek/Gemini/OpenAI SDK 的
 * 原始错误可能带认证细节或密钥尾巴（"…abcd"、Bearer、sk-…、key=…），绝不能
 * 进入 JSON/SSE 响应体。客户端只拿到通用本地化 error code + message；细节
 * （provider、status、error class、脱敏 message）以结构化 JSON 记服务端日志。
 */

const REDACTED = '[REDACTED]';
// Cap for redacted log text — provider messages can embed full request bodies.
const MAX_REDACTED_LENGTH = 500;
const MAX_RAW_LENGTH = 2000;

// Each pattern runs over the whole text in order; later patterns only see
// text the earlier ones left behind.
const SECRET_PATTERNS = [
  // sk-… keys (OpenAI / DeepSeek style), including partial `sk-proj-****xxxx`
  /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{5,}/g,
  // Google API keys (Gemini)
  /\bAIza[A-Za-z0-9_-]{10,}/g,
  // Authorization headers
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // key=value / api_key: value / "token": "value" style pairs
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|key|secret|password)\b["']?\s*[=:]\s*["']?[A-Za-z0-9._~+/=-]{6,}/gi,
  // masked key tails: …abcd (Unicode ellipsis U+2026) / ****abcd / ...e5Fg
  /(?:\u2026|\.{3}|\*{3,})[A-Za-z0-9_-]{3,}/g,
];

/**
 * Credential-specific patterns (everything above): used on their own by the
 * global console wrapper, which must not apply the generic long-run
 * heuristic below (it would eat structured event names / UUIDs) nor cap the
 * line length (it would truncate durable JSON records such as feedback).
 */
const CREDENTIAL_PATTERNS = [
  // sk-… keys, Google API keys, Bearer/Basic auth (same as SECRET_PATTERNS)
  SECRET_PATTERNS[0],
  SECRET_PATTERNS[1],
  SECRET_PATTERNS[2],
  // name/value pairs under credential-ish names — JSON (incl. escaped and
  // unterminated), util.inspect fields, env/config dumps (STEAM_WEB_API_KEY=…,
  // OPENDOTA_API_KEY: '…'), header-ish `token: …`. The name may be prefixed
  // with `X_` / `x-` (so `_API_KEY` suffixes match); the value is matched up to
  // its structural delimiter: a quoted value runs to the closing quote (any
  // characters, so `p@ssw0rd!` / bcrypt `$2b$…` are covered; an unterminated
  // quote runs to end of line), an unquoted one to whitespace/`,;&}]`.
  // Free-form user content (the feedback record) is written through
  // logUnredacted() instead, so this can stay broad.
  /(?:\b|(?<=[_-]))(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?key|token|key|secret|password|passwd|pwd|credentials?)\b\\?["']?\s*[=:]\s*(?:\\?"[^"\\\r\n]+|'[^'\r\n]+|[^\s"',;&}\]\\]{6,})/gi,
  // URL query values  ?key=… / &token=… / &sig=… (keep the parameter name)
  /(?<=[?&](?:key|token|password|secret|sig|signature)=)[A-Za-z0-9._~+/%=-]{6,}/gi,
  // `Authorization: <anything>` header lines (scheme-less tokens, JWTs)
  /\bAuthorization\b\\?["']?\s*[:=]\s*\\?["']?(?:(?:Bearer|Basic|Token)\s+)?[^\s"',;\\]{6,}/gi,
];


// leftover long secret-shaped runs (raw keys without a known prefix)
SECRET_PATTERNS.push(/[A-Za-z0-9_-]{20,}/g);

/**
 * Coerce any value to a string with anything secret-shaped redacted
 * (API keys, Bearer tokens, key=… params, masked key tails, long key-like
 * runs). Over-redaction is acceptable: the result only feeds server logs.
 * @param {unknown} value
 * @returns {string}
 */
export function redactSecrets(value) {
  let text = String(value ?? '').slice(0, MAX_RAW_LENGTH);
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, REDACTED);
  }
  return text.slice(0, MAX_REDACTED_LENGTH);
}

/**
 * Redact credentials (sk-… / AIza… keys, Bearer/Basic auth, key=/token=/
 * secret= pairs, masked key tails) WITHOUT truncating and WITHOUT the generic
 * long-token heuristic, so ordinary structured log lines (event names, UUIDs,
 * full feedback JSON records) keep their content and length. This is what
 * the global console wrapper (lib/consoleRedaction.js) applies to every line.
 * @param {unknown} value
 * @returns {string}
 */
export function redactCredentials(value) {
  let text = String(value ?? '');
  for (const pattern of CREDENTIAL_PATTERNS) {
    text = text.replace(pattern, REDACTED);
  }
  return text;
}

/**
 * The ONLY error payload about LLM failures that ever crosses to the client:
 * a stable machine code plus a generic localized message. Never includes
 * provider text, status bodies, or anything derived from the error.
 * @param {string} lang normalized UI lang ('zh' | 'en')
 * @returns {{ error: string, message: string }}
 */
export function sanitizeLlmErrorForClient(lang) {
  return lang === 'zh'
    ? { error: 'ai_unavailable', message: 'AI 服务暂时不可用，请稍后重试' }
    : { error: 'ai_unavailable', message: 'AI service temporarily unavailable' };
}

/**
 * Generic payload for any non-LLM (or unclassified) server failure. Like
 * sanitizeLlmErrorForClient it never carries anything derived from the error:
 * unclassified errors can still be provider-derived (e.g. a SyntaxError from
 * the SDK parsing a malformed provider body embeds an excerpt of that body).
 * @param {string} lang normalized UI lang ('zh' | 'en')
 * @returns {{ error: string, message: string }}
 */
export function internalErrorForClient(lang) {
  return lang === 'zh'
    ? { error: 'internal_error', message: '服务器内部错误，请稍后重试' }
    : { error: 'internal_error', message: 'Internal Server Error' };
}

/**
 * Best-effort classification of openai SDK (DeepSeek/Gemini share it)
 * errors: the SDK subclasses never set `name`, so check the prototype chain
 * against the known class names plus an explicit `API…` name.
 * @param {unknown} err
 * @returns {boolean}
 */
const OPENAI_SDK_ERROR_CLASSES = new Set([
  'OpenAIError', 'APIError', 'APIUserAbortError', 'APIConnectionError',
  'APIConnectionTimeoutError', 'BadRequestError', 'AuthenticationError',
  'PermissionDeniedError', 'NotFoundError', 'ConflictError',
  'UnprocessableEntityError', 'RateLimitError', 'InternalServerError',
]);

export function isLlmSdkError(err) {
  if (!err || typeof err !== 'object') return false;
  if (typeof err.name === 'string' && /^API[A-Z]/.test(err.name)) return true;
  let proto = err;
  while (proto && proto !== Object.prototype) {
    if (OPENAI_SDK_ERROR_CLASSES.has(proto.constructor?.name)) return true;
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

/**
 * The openai SDK subclasses inherit `name` from Error ("Error") while our own
 * deadline errors set an explicit name — prefer the more specific of the two.
 * @param {unknown} error
 * @returns {string}
 */
function errorClassOf(error) {
  const ctor = error?.constructor?.name;
  if (typeof ctor === 'string' && ctor !== 'Error' && ctor !== 'Object') return ctor;
  if (typeof error?.name === 'string' && error.name) return error.name;
  return error == null ? 'unknown' : typeof error;
}

/**
 * One structured JSON log line for an LLM/provider failure: provider, HTTP
 * status, error class, and a redacted message — enough for Cloud Logging
 * metrics/debugging without leaking credentials into logs.
 * @param {(line: string) => void} sink
 * @param {{ event?: string, provider?: string, error?: unknown, severity?: string } & Record<string, unknown>} fields
 * @returns {string} the emitted line
 */
export function logLlmError(sink, { event = 'llm_error', provider, error, ...extra } = {}) {
  const line = JSON.stringify({
    severity: 'WARNING',
    event,
    ...(provider ? { provider } : {}),
    status: error?.status ?? null,
    errorClass: errorClassOf(error),
    message: redactSecrets(error?.message ?? error),
    ...extra,
  });
  (sink ?? console.error)(line);
  return line;
}
