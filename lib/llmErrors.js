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
const CREDENTIAL_NAME_SRC =
  '[A-Za-z0-9_-]*?(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?key|token|key|secret|password|passwd|pwd|credentials?)';

/** Double-encoded JSON string value: \\" ... \\" (or unterminated → EOL). */
const DBL_ENC_VALUE = '\\\\"(?:\\\\\\\\(?:\\\\\\\\|\\\\"|[^\\\\"\\r\\n])|[^\\\\"\\r\\n])*(?:\\\\"|$)';
/** JSON string value: " ... " (or unterminated → EOL). */
const JSON_VALUE = '"(?:\\\\.|[^"\\\\\\r\\n])*(?:"|$)';
/** util.inspect single-quoted value. */
const INSPECT_VALUE = "'(?:\\\\.|[^'\\\\\\r\\n])*(?:'|$)";
/** Unquoted value up to a structural delimiter. */
const UNQUOTED_VALUE = '[^\\s"\',;&}\\]\\\\]{1,}';

const CREDENTIAL_NAME_VALUE_RE = new RegExp(
  `\\b(${CREDENTIAL_NAME_SRC})\\b(\\\\?["']?\\s*(?:=>|[=:])\\s*)(${DBL_ENC_VALUE}|${JSON_VALUE}|${INSPECT_VALUE}|${UNQUOTED_VALUE})`,
  'gim',
);

/**
 * Replace only the VALUE of a name=value / "name": "value" match, keeping the
 * field name, separator and surrounding quotes so structured JSON / inspect
 * output stays parseable (Codex P1).
 * @param {string} _match
 * @param {string} name
 * @param {string} sep
 * @param {string} value
 */
function replaceCredentialValue(_match, name, sep, value) {
  if (value.startsWith('\\"')) return `${name}${sep}\\"${REDACTED}\\"`;
  if (value.startsWith('"')) return `${name}${sep}"${REDACTED}"`;
  if (value.startsWith("'")) return `${name}${sep}'${REDACTED}'`;
  return `${name}${sep}${REDACTED}`;
}

/**
 * Apply a list of patterns. Entries may be a RegExp (whole-match → [REDACTED])
 * or `{ re, replace }` (string or function replacement).
 * @param {string} text
 * @param {Array<RegExp | { re: RegExp, replace: string | ((...args: any[]) => string) }>} patterns
 */
function applyPatterns(text, patterns) {
  for (const entry of patterns) {
    if (entry instanceof RegExp) {
      text = text.replace(entry, REDACTED);
    } else {
      text = text.replace(entry.re, /** @type {any} */ (entry.replace));
    }
  }
  return text;
}

const CREDENTIAL_PATTERNS = [
  // Unmistakable prefixes — whole match may be replaced (no surrounding structure).
  SECRET_PATTERNS[0],
  SECRET_PATTERNS[1],
  // Keep the scheme word so "Bearer <token>" → "Bearer [REDACTED]".
  { re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: `$1 ${REDACTED}` },
  // name / value pairs — value-only replacement (see replaceCredentialValue).
  { re: CREDENTIAL_NAME_VALUE_RE, replace: replaceCredentialValue },
  // URL query values — lookbehind already keeps "?key=" / "&token=".
  /(?<=[?&](?:key|token|password|secret|sig|signature)=)[A-Za-z0-9._~+/%=-]{6,}/gi,
  // Authorization header — keep the header name + separator.
  { re: /\b(Authorization\b\\?["']?\s*[:=]\s*\\?["']?)(?:(?:Bearer|Basic|Token)\s+)?[^\s"',;\\]{6,}/gi, replace: `$1${REDACTED}` },
];

/**
 * Unmistakable secret shapes only (sk-… / AIza… / Bearer|Basic … / Authorization:).
 * Used on durable feedback records so ordinary prose survives while pasted API
 * keys still never reach Cloud Logging (Codex P1).
 */
const UNMISTAKABLE_SECRET_PATTERNS = [
  SECRET_PATTERNS[0],
  SECRET_PATTERNS[1],
  { re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: `$1 ${REDACTED}` },
  { re: /\b(Authorization\b["']?\s*[:=]\s*["']?)(?:(?:Bearer|Basic|Token)\s+)?[^\s"',;]{6,}/gi, replace: `$1${REDACTED}` },
];

// leftover long secret-shaped runs (raw keys without a known prefix)
SECRET_PATTERNS.push(/[A-Za-z0-9_-]{20,}/g);

/**
 * Coerce any value to a string with anything secret-shaped redacted
 * (API keys, Bearer tokens, key=… params, masked key tails, long key-like
 * runs). Over-redaction is acceptable: the result only feeds capped error logs.
 * @param {unknown} value
 * @returns {string}
 */
export function redactSecrets(value) {
  let text = String(value ?? '').slice(0, MAX_RAW_LENGTH);
  text = applyPatterns(text, SECRET_PATTERNS.map((re) => re));
  // SECRET_PATTERNS are plain RegExps; applyPatterns handles them.
  return text.slice(0, MAX_REDACTED_LENGTH);
}

/**
 * Redact credentials WITHOUT truncating and WITHOUT the generic long-token
 * heuristic, so ordinary structured log lines keep their content and length.
 * This is what the global console wrapper applies to every line.
 * @param {unknown} value
 * @returns {string}
 */
export function redactCredentials(value) {
  return applyPatterns(String(value ?? ''), CREDENTIAL_PATTERNS);
}

/**
 * Redact only unmistakable credential shapes (sk-… / AIza… / Bearer|Basic /
 * Authorization headers). Leaves ordinary prose — including `key=escape` and
 * `{ key: 'Escape' }` — intact. Used for durable feedback records that must
 * not lose user wording while still never logging pasted API keys.
 * @param {unknown} value
 * @returns {string}
 */
export function redactUnmistakableSecrets(value) {
  return applyPatterns(String(value ?? ''), UNMISTAKABLE_SECRET_PATTERNS);
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
