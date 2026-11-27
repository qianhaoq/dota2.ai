/**
 * The review agent model catalog. Shared by the review page, the server, and
 * the scripts. Only DeepSeek 4.1 Flash is offered on the site; where a model
 * lives and which key it needs is the server's alone (providers.js).
 *
 * `minutes`: [shortest, longest] the model took to write one review of a
 * 45-minute game (match 9091400302, Tidehunter, Chinese) over several
 * production runs.
 */
export const AGENT_MODELS = Object.freeze([
  { id: 'deepseek-flash', label: 'DeepSeek 4.1 Flash', minutes: [2, 3] },
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
 * @param {'en' | 'zh' | 'ru'} lang
 */
export function modelWait(id, lang) {
  const m = modelMinutes(id);
  if (!m) return null;
  const n = m[0] === m[1] ? String(m[0]) : `${m[0]}–${m[1]}`;
  if (lang === 'zh') return `约 ${n} 分钟`;
  if (lang === 'ru') return `около ${n} мин.`;
  return `about ${n} minutes`;
}
/**
 * Whether a review by this model needs the longer time limit, and its own wait told to the reader. By what the
 * model is, never by whether a server happens to make it its default. One that was not timed is not assumed
 * to be quick.
 */
export const writesSlowly = (id) => { const t = modelMinutes(id); return t == null || t[1] > 5; };
