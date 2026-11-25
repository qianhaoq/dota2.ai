/**
 * The models a reader can have a review written by. Shared by the review page
 * (the buttons), the server (which choices are accepted) and the scripts.
 * Only what may be shown: an id, a name, and how long it took. Where a model lives and which key
 * it needs is the server's alone (providers.js); a page never names an
 * address, an upstream model name or a key, only one of these ids.
 *
 * The order is the order of the buttons. The first is the default where it is
 * offered: a review asked for without a model is that one's. Its reviews are
 * stored without a model in their key (as every review was before there was a
 * choice), and that key is its alone: a server whose default is another model
 * stores that model's reviews under the model's id (service.js).
 *
 * `minutes`: [shortest, longest] the model took to write one review of the same game (match 9091400302,
 * Tidehunter, Chinese, a 45-minute game) on 2026-11-25, to the minute: the default over several production runs;
 * Kimi and GLM-5.3 Flash once from scripts/deep-review.mjs and once in production (13.4 and 13.0; 11.2 and 13.2
 * minutes); GLM-5.3 once. This is what the page tells a reader to expect, so it is what was measured and nothing
 * rounder. null: not timed (GLM-5.4 could not be called through the API that day), and then the page says
 * nothing about its speed.
 */
export const AGENT_MODELS = Object.freeze([
  { id: 'deepseek-flash', label: 'DeepSeek 4.1 Flash', minutes: [2, 3] },
  { id: 'kimi-k3.1-pro', label: 'Kimi K3.1 Pro', minutes: [13, 13] },
  { id: 'glm-5.3-flash', label: 'GLM-5.3 Flash', minutes: [11, 13] },
  { id: 'glm-5.3', label: 'GLM-5.3', minutes: [24, 24] },
  { id: 'glm-5.4', label: 'GLM-5.4', minutes: null },
]);

export const DEFAULT_AGENT_MODEL = AGENT_MODELS[0].id;
export const AGENT_MODEL_IDS = Object.freeze(AGENT_MODELS.map((m) => m.id));
/** A model id as sent by a page or a queued task, or null: anything else is no model. */
export const modelId = (v) => (typeof v === 'string' && AGENT_MODEL_IDS.includes(v) ? v : null);
/** The name to show for an id; the id itself for one this build does not know. */
export const modelLabel = (id) => AGENT_MODELS.find((m) => m.id === id)?.label ?? String(id ?? '');
/** [shortest, longest] minutes a model was timed at, or null when it was not timed (or is not known). */
export const modelMinutes = (id) => AGENT_MODELS.find((m) => m.id === id)?.minutes ?? null;
/**
 * The wait to tell a reader for a model, or null when it was not timed: "about 13 minutes", "about 11–13 minutes".
 * @param {string} id
 * @param {'en' | 'zh'} lang
 */
export function modelWait(id, lang) {
  const m = modelMinutes(id);
  if (!m) return null;
  const n = m[0] === m[1] ? String(m[0]) : `${m[0]}–${m[1]}`;
  return lang === 'zh' ? `约 ${n} 分钟` : `about ${n} minutes`;
}
/**
 * Whether a review by this model needs the longer time limit, and its own wait told to the reader. By what the
 * model is, never by whether a server happens to make it its default. One that was not timed is not assumed
 * to be quick.
 */
export const writesSlowly = (id) => { const t = modelMinutes(id); return t == null || t[1] > 5; };
