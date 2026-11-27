/**
 * DeepSeek provider settings for the review agent. Pure: reads an env object,
 * returns the settings for an OpenAI-compatible client. No key is ever
 * returned in a loggable field other than `apiKey`. Server and scripts only:
 * a page imports models.js (ids and names), never this file.
 *
 * - deepseek: DEEPSEEK_API_KEY, model from DEEPSEEK_MODEL (default
 *   deepseek-flash = DeepSeek 4.1 Flash). The deep review is an offline job
 *   with no 40 s deadline, so thinking is ON unless DEEP_REVIEW_THINKING=disabled
 *   (the server's DEEPSEEK_THINKING default stays off for its streaming routes).
 */
import { resolveDeepSeekConfig } from '../llmConfig.js';
import { AGENT_MODEL_IDS, DEFAULT_AGENT_MODEL } from './models.js';

export const DEEP_REVIEW_PROVIDERS = ['deepseek'];
/** Offered when DEEPSEEK_API_KEY is set. */
export const DEFAULT_OFFERED_MODELS = Object.freeze(['deepseek-flash']);

/**
 * @param {'deepseek'} provider
 * @param {string | null} model the upstream model name, or null for the provider's own (env, then default)
 */
function settings(provider, model, env) {
  const thinking = env.DEEP_REVIEW_THINKING === 'disabled' ? 'disabled' : 'enabled';
  if (provider === 'deepseek') {
    if (!env.DEEPSEEK_API_KEY) return { ok: false, error: 'missing_key', needs: 'DEEPSEEK_API_KEY' };
    return {
      ok: true,
      provider,
      baseURL: 'https://api.deepseek.com',
      apiKey: env.DEEPSEEK_API_KEY,
      model: model ?? resolveDeepSeekConfig(env).model,
      thinking,
      extraBody: { thinking: { type: thinking } },
    };
  }
  return { ok: false, error: 'unknown_provider' };
}

/**
 * DeepSeek provider settings with the model its own env names.
 * @param {string} name
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ ok: true, provider: string, baseURL: string, apiKey: string, model: string, thinking: 'enabled' | 'disabled', extraBody: object } | { ok: false, error: 'unknown_provider' | 'missing_key', needs?: string }}
 */
export function deepReviewProvider(name, env = {}) {
  return settings(name, null, env);
}

/** A model id of models.js → its provider and the model name sent upstream (null: the provider's own). */
const BY_ID = {
  // DEEPSEEK_MODEL decides what the DeepSeek entry sends.
  'deepseek-flash': ['deepseek', null],
};

/**
 * The settings for one model id of models.js.
 * @returns {ReturnType<typeof deepReviewProvider> & { id?: string }}
 */
export function agentModel(id, env = {}) {
  const spec = Object.hasOwn(BY_ID, id) ? BY_ID[id] : null;
  if (!spec) return { ok: false, error: 'unknown_provider' };
  const out = settings(spec[0], spec[1], env);
  return out.ok ? { ...out, id } : out;
}

/**
 * The models this server offers: DeepSeek only, when DEEPSEEK_API_KEY is set.
 * @returns {{ default: string | null, models: (ReturnType<typeof agentModel> & { ok: true, id: string })[], skipped: { id: string, error: string, needs?: string }[] }}
 */
export function agentModels(env = {}) {
  const models = [];
  const skipped = [];
  for (const id of AGENT_MODEL_IDS) {
    if (!DEFAULT_OFFERED_MODELS.includes(id)) continue;
    const m = agentModel(id, env);
    if (m.ok) models.push(m); else skipped.push({ id, error: m.error, ...(m.needs ? { needs: m.needs } : {}) });
  }
  return { default: models.find((m) => m.id === DEFAULT_AGENT_MODEL)?.id ?? models[0]?.id ?? null, models, skipped };
}
