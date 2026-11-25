/**
 * Where each model lives and which key it needs. Pure: reads an env object,
 * returns the settings for an OpenAI-compatible client. No key is ever
 * returned in a loggable field other than `apiKey`. Server and scripts only:
 * a page imports models.js (ids and names), never this file.
 *
 * - deepseek: DEEPSEEK_API_KEY, model from DEEPSEEK_MODEL (default
 *   deepseek-flash = DeepSeek 4.1 Flash). The deep review is an offline job
 *   with no 40 s deadline, so thinking is ON unless DEEP_REVIEW_THINKING=disabled
 *   (the server's DEEPSEEK_THINKING default stays off for its streaming routes).
 * - glm: GLM_API_KEY, Zhipu's OpenAI-compatible endpoint. Checked live on
 *   2026-11-25 with glm-5.3-flash and glm-5.3: tool calls come back in the
 *   OpenAI shape; the 5.3 models always think and answer `thinking: disabled`
 *   with error 1210, so "disabled" is sent as `reasoning_effort: low`
 *   (low | high | max; the provider's default is max). glm-5.4 answered 1220
 *   (no access through the API) that day, and glm-5.3 took 24 minutes for one
 *   review (models.js): both are known here but not offered unless
 *   AGENT_MODELS names them.
 * - kimi: KIMI_API_KEY, Kimi K3.1 Pro. It always thinks, takes
 *   `reasoning_effort` (low | high | max, default max) and no `thinking`
 *   field, and wants the assistant message of a tool-call round sent back
 *   whole (loop.js does). Two kinds of key, on four addresses, none of them
 *   interchangeable:
 *   · a Kimi Code membership key (`sk-kimi-…`): api.kimi.com/coding/v1
 *     (China, the default for such a key) or api.kimi.ai/coding/v1; the model
 *     is called `k3.1-pro` there. Checked live on 2026-11-25: a tool-call
 *     round and its answer, with the reasoning sent back.
 *   · a Moonshot platform key (pay as you go): api.moonshot.cn/v1 (the
 *     default for any other key) or api.moonshot.ai/v1; the model is
 *     `kimi-k3.1-pro`. From its docs (platform.kimi.ai, read 2026-11-25);
 *     not called from here.
 *   KIMI_BASE_URL picks one of the four, and nothing else is accepted, so a
 *   key cannot be sent anywhere else.
 */
import { resolveDeepSeekConfig } from '../llmConfig.js';
import { AGENT_MODEL_IDS, DEFAULT_AGENT_MODEL } from './models.js';

export const DEEP_REVIEW_PROVIDERS = ['deepseek', 'glm', 'kimi'];
export const DEFAULT_GLM_MODEL = 'glm-5.3-flash';
/** Each Kimi address and what K3.1 Pro is called on it. */
const KIMI_ENDPOINTS = Object.freeze({
  'https://api.moonshot.cn/v1': 'kimi-k3.1-pro',
  'https://api.moonshot.ai/v1': 'kimi-k3.1-pro',
  'https://api.kimi.com/coding/v1': 'k3.1-pro',
  'https://api.kimi.ai/coding/v1': 'k3.1-pro',
});
const KIMI_CODE_KEY = /^sk-kimi-/;
const MODEL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const EFFORTS = new Set(['low', 'high', 'max']);
/** Offered when their key is set and AGENT_MODELS does not say otherwise. Not glm-5.3 or glm-5.4: see above. */
export const DEFAULT_OFFERED_MODELS = Object.freeze(['deepseek-flash', 'kimi-k3.1-pro', 'glm-5.3-flash']);

const named = (v, fallback) => (typeof v === 'string' && MODEL_NAME.test(v.trim()) ? v.trim() : fallback);
const effortOf = (v, thinking) => (EFFORTS.has(String(v ?? '').trim()) ? String(v).trim() : thinking === 'disabled' ? 'low' : null);

/**
 * @param {'deepseek' | 'glm' | 'kimi'} provider
 * @param {string | null} model the upstream model name, or null for the provider's own (env, then default)
 */
function settings(provider, model, env) {
  const thinking = env.DEEP_REVIEW_THINKING === 'disabled' ? 'disabled' : 'enabled';
  if (provider === 'deepseek') {
    if (!env.DEEPSEEK_API_KEY) return { ok: false, error: 'missing_key', needs: 'DEEPSEEK_API_KEY' };
    return { ok: true, provider, baseURL: 'https://api.deepseek.com', apiKey: env.DEEPSEEK_API_KEY, model: model ?? resolveDeepSeekConfig(env).model, thinking, extraBody: { thinking: { type: thinking } } };
  }
  if (provider === 'glm') {
    if (!env.GLM_API_KEY) return { ok: false, error: 'missing_key', needs: 'GLM_API_KEY' };
    const effort = effortOf(env.GLM_REASONING_EFFORT, thinking);
    return { ok: true, provider, baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKey: env.GLM_API_KEY, model: model ?? named(env.GLM_MODEL, DEFAULT_GLM_MODEL), thinking, extraBody: { thinking: { type: 'enabled' }, ...(effort ? { reasoning_effort: effort } : {}) } };
  }
  if (provider === 'kimi') {
    if (!env.KIMI_API_KEY) return { ok: false, error: 'missing_key', needs: 'KIMI_API_KEY' };
    const asked = String(env.KIMI_BASE_URL ?? '').trim().replace(/\/+$/, '');
    if (asked && !Object.hasOwn(KIMI_ENDPOINTS, asked)) return { ok: false, error: 'invalid_base_url', needs: 'KIMI_BASE_URL' };
    const baseURL = asked || (KIMI_CODE_KEY.test(env.KIMI_API_KEY) ? 'https://api.kimi.com/coding/v1' : 'https://api.moonshot.cn/v1');
    const effort = effortOf(env.KIMI_REASONING_EFFORT, thinking);
    // K3.1 Pro by the name this address knows it by (the same model either way); KIMI_MODEL is for scripts trying another one.
    return { ok: true, provider, baseURL, apiKey: env.KIMI_API_KEY, model: model ?? named(env.KIMI_MODEL, KIMI_ENDPOINTS[baseURL]), thinking, extraBody: effort ? { reasoning_effort: effort } : {} };
  }
  return { ok: false, error: 'unknown_provider' };
}

/**
 * A provider with the model its own env names (scripts: `--provider glm` with GLM_MODEL=…).
 * @param {string} name
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ ok: true, provider: string, baseURL: string, apiKey: string, model: string, thinking: 'enabled' | 'disabled', extraBody: object } | { ok: false, error: 'unknown_provider' | 'missing_key' | 'invalid_base_url', needs?: string }}
 */
export function deepReviewProvider(name, env = {}) {
  return settings(name, null, env);
}

/** A model id of models.js → its provider and the model name sent upstream (null: the provider's own). */
const BY_ID = {
  // DEEPSEEK_MODEL still decides what the DeepSeek entry sends, as it did before there was a choice.
  'deepseek-flash': ['deepseek', null],
  'kimi-k3.1-pro': ['kimi', null],
  'glm-5.3-flash': ['glm', 'glm-5.3-flash'],
  'glm-5.3': ['glm', 'glm-5.3'],
  'glm-5.4': ['glm', 'glm-5.4'],
};

/**
 * The settings for one model id of models.js.
 * @returns {ReturnType<typeof deepReviewProvider> & { id?: string }}
 */
export function agentModel(id, env = {}) {
  const spec = Object.hasOwn(BY_ID, id) ? BY_ID[id] : null;
  if (!spec) return { ok: false, error: 'unknown_provider' };
  // An id is one model: the script-only override of what the Kimi entry sends does not apply to it.
  const out = settings(spec[0], spec[1], spec[0] === 'kimi' ? { ...env, KIMI_MODEL: undefined } : env);
  return out.ok ? { ...out, id } : out;
}

/**
 * The models this server offers: those AGENT_MODELS names (comma separated ids; default
 * DEFAULT_OFFERED_MODELS) whose key is set, in the order of models.js. `default` is the one a request
 * without a model gets: models.js's first when it is offered, else the first that is.
 * @returns {{ default: string | null, models: (ReturnType<typeof agentModel> & { ok: true, id: string })[], skipped: { id: string, error: string, needs?: string }[] }}
 */
export function agentModels(env = {}) {
  const asked = String(env.AGENT_MODELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const wanted = new Set(asked.length ? asked : DEFAULT_OFFERED_MODELS);
  const models = []; const skipped = [];
  for (const id of AGENT_MODEL_IDS) {
    if (!wanted.has(id)) continue;
    const m = agentModel(id, env);
    if (m.ok) models.push(m); else skipped.push({ id, error: m.error, ...(m.needs ? { needs: m.needs } : {}) });
  }
  for (const id of asked) if (!AGENT_MODEL_IDS.includes(id)) skipped.push({ id: id.slice(0, 40), error: 'unknown_model' });
  return { default: models.find((m) => m.id === DEFAULT_AGENT_MODEL)?.id ?? models[0]?.id ?? null, models, skipped };
}
