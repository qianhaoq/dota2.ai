/**
 * Which model runs the deep review. Pure: reads an env object, returns the
 * settings for an OpenAI-compatible client. No key is ever returned in a
 * loggable field other than `apiKey`.
 *
 * - deepseek: DEEPSEEK_API_KEY, model from DEEPSEEK_MODEL (default
 *   deepseek-flash = DeepSeek 4.1 Flash). The deep review is an offline job
 *   with no 40 s deadline, so thinking is ON unless DEEP_REVIEW_THINKING=disabled
 *   (the server's DEEPSEEK_THINKING default stays off for its streaming routes).
 * - glm: GLM_API_KEY, model from GLM_MODEL (default glm-5.3-flash), Zhipu's
 *   OpenAI-compatible endpoint. Checked live on 2026-11-22: tool calls come
 *   back in the OpenAI shape and the model reasons by default.
 */
import { resolveDeepSeekConfig } from '../llmConfig.js';

export const DEEP_REVIEW_PROVIDERS = ['deepseek', 'glm'];
export const DEFAULT_GLM_MODEL = 'glm-5.3-flash';
const MODEL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * @param {string} name
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ ok: true, provider: string, baseURL: string, apiKey: string, model: string, thinking: 'enabled' | 'disabled', extraBody: object } | { ok: false, error: 'unknown_provider' | 'missing_key', needs?: string }}
 */
export function deepReviewProvider(name, env = {}) {
  const thinking = env.DEEP_REVIEW_THINKING === 'disabled' ? 'disabled' : 'enabled';
  if (name === 'deepseek') {
    if (!env.DEEPSEEK_API_KEY) return { ok: false, error: 'missing_key', needs: 'DEEPSEEK_API_KEY' };
    return { ok: true, provider: 'deepseek', baseURL: 'https://api.deepseek.com', apiKey: env.DEEPSEEK_API_KEY, model: resolveDeepSeekConfig(env).model, thinking, extraBody: { thinking: { type: thinking } } };
  }
  if (name === 'glm') {
    if (!env.GLM_API_KEY) return { ok: false, error: 'missing_key', needs: 'GLM_API_KEY' };
    const model = typeof env.GLM_MODEL === 'string' && MODEL_NAME.test(env.GLM_MODEL.trim()) ? env.GLM_MODEL.trim() : DEFAULT_GLM_MODEL;
    return { ok: true, provider: 'glm', baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKey: env.GLM_API_KEY, model, thinking, extraBody: { thinking: { type: thinking } } };
  }
  return { ok: false, error: 'unknown_provider' };
}
