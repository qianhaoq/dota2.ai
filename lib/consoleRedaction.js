/**
 * Global console redaction（QA P2）：三方依赖会直接往全局 console 打原始
 * provider 输出——openai SDK 的 streaming.js 在 SSE chunk JSON.parse 失败时
 * console.error('Could not parse message into JSON:', chunk)，chunk 里可能带
 * Bearer/sk-…/api_key=…。包装后的每个方法先把每个参数过 redactSecrets 再
 * 转发给原方法（redactCredentials：只打码凭据形状，不截断、不套用通用长 token
 * 启发式——否则 feedback JSON 记录会被截断、event 名/UUID 被误杀），密钥永远到不了 stdout/Cloud Logging。生产入口见
 * lib/installConsoleRedaction.js（server.js 的第一个 import）。
 */
import { formatWithOptions } from 'node:util';
import { redactCredentials } from './llmErrors.js';

// Marks a console object whose methods are already wrapped → install is idempotent.
const REDACTION_INSTALLED = Symbol('consoleRedactionInstalled');

// Bounded inspection (same spirit as console's defaults) so a dependency
// logging a huge object can't block the event loop or flood logging; strings
// themselves are not truncated (feedback records stay complete).
const INSPECT_OPTIONS = {
  depth: 2,
  maxArrayLength: 20,
  maxStringLength: 4000,
  breakLength: Infinity,
};

// Hard ceiling on one formatted log line (≈ 64 KB) — protects against floods.
const MAX_LINE_LENGTH = 64 * 1024;

/**
 * Format ALL console arguments into the final line first (printf-style
 * substitutions like `('Authorization: Bearer %s', token)` included), THEN
 * redact the whole line: per-argument redaction would miss a bare token whose
 * credential context lives in the format string (Codex P1).
 * @param {unknown[]} args
 * @returns {string}
 */
export function formatAndRedact(args) {
  try {
    let line = formatWithOptions(INSPECT_OPTIONS, ...args);
    if (line.length > MAX_LINE_LENGTH) line = `${line.slice(0, MAX_LINE_LENGTH)}…[truncated]`;
    return redactCredentials(line);
  } catch {
    // Never throw out of a console wrapper — and never forward the raw value.
    return '[REDACTED:unformattable]';
  }
}

/**
 * Wrap the given console object's methods so every argument is redacted before
 * reaching the original implementation. Idempotent (a Symbol marks the console;
 * a second install is a no-op that returns the first install's uninstall).
 * @param {Record<string, any>} [consoleObj] console or a test double with the
 *   same method names
 * @param {{ methods?: string[] }} [options]
 * @returns {() => void} uninstall — restores the original methods
 */
export function installConsoleRedaction(consoleObj = console, { methods = ['error', 'warn', 'log', 'info', 'debug'] } = {}) {
  const existing = consoleObj[REDACTION_INSTALLED];
  if (existing) return existing.uninstall;

  const originals = new Map();
  const uninstall = () => {
    for (const [method, original] of originals) consoleObj[method] = original;
    originals.clear();
    delete consoleObj[REDACTION_INSTALLED];
  };

  for (const method of methods) {
    const original = consoleObj[method];
    if (typeof original !== 'function') continue;
    originals.set(method, original);
    // Forward ONE pre-formatted, redacted string; a lone string argument is not
    // re-substituted by util.format, so '%s' / '%%' in it print verbatim.
    consoleObj[method] = (...args) => original.call(consoleObj, formatAndRedact(args));
  }

  consoleObj[REDACTION_INSTALLED] = { uninstall };
  return uninstall;
}
