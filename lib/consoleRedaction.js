/**
 * Global console redaction（QA P2）：三方依赖会直接往全局 console 打原始
 * provider 输出——openai SDK 的 streaming.js 在 SSE chunk JSON.parse 失败时
 * console.error('Could not parse message into JSON:', chunk)，chunk 里可能带
 * Bearer/sk-…/api_key=…。包装后的每个方法先把每个参数过 redactSecrets 再
 * 转发给原方法（redactCredentials：只打码凭据形状，不截断、不套用通用长 token
 * 启发式——否则 feedback JSON 记录会被截断、event 名/UUID 被误杀），密钥永远到不了 stdout/Cloud Logging。生产入口见
 * lib/installConsoleRedaction.js（server.js 的第一个 import）。
 */
import { inspect } from 'node:util';
import { redactCredentials } from './llmErrors.js';

// Marks a console object whose methods are already wrapped → install is idempotent.
const REDACTION_INSTALLED = Symbol('consoleRedactionInstalled');

// Tight caps so stringifying a logged object stays cheap (huge arrays/strings
// are truncated before redaction, not after).
const INSPECT_OPTIONS = {
  depth: 2,
  maxArrayLength: 20,
  maxStringLength: 4000,
  breakLength: Infinity,
};

/**
 * One console argument → a redactable value. Strings and stringified objects
 * are redacted in full; primitives can't carry credentials and pass through so
 * util.format specifiers (%d/%s/…) keep working.
 * @param {unknown} value
 * @returns {unknown}
 */
function redactArgument(value) {
  try {
    if (typeof value === 'string') return redactCredentials(value);
    if (value instanceof Error) {
      // Stack and message can each embed key material (URLs with ?api_key=…).
      return redactCredentials(`${value.name}: ${value.message}\n${value.stack ?? ''}`);
    }
    if (value != null && typeof value === 'object') {
      let text;
      try {
        // Fast path for plain JSON data; throws on circular refs / BigInt,
        // returns undefined for function-only objects.
        text = JSON.stringify(value);
      } catch {
        text = undefined;
      }
      if (typeof text !== 'string') text = inspect(value, INSPECT_OPTIONS);
      return redactCredentials(text);
    }
    return value;
  } catch {
    // Never throw out of a console wrapper — and never forward the raw value.
    return '[REDACTED:unredactable]';
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
    consoleObj[method] = (...args) => original.call(consoleObj, ...args.map(redactArgument));
  }

  consoleObj[REDACTION_INSTALLED] = { uninstall };
  return uninstall;
}
