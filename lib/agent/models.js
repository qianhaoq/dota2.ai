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
 * `timed_minutes`: how long the model took to write one review of the same game (match 9091400302, Tidehunter,
 * Chinese) on 2026-11-25, to the minute; one run each, except the default (production, several runs). null: not
 * timed (GLM-5.4 could not be called through the API that day), and then the page says nothing about its speed.
 */
export const AGENT_MODELS = Object.freeze([
  { id: 'deepseek-flash', label: 'DeepSeek 4.1 Flash', timed_minutes: 2 },
  { id: 'kimi-k3.1-pro', label: 'Kimi K3.1 Pro', timed_minutes: 13 },
  { id: 'glm-5.3-flash', label: 'GLM-5.3 Flash', timed_minutes: 11 },
  { id: 'glm-5.3', label: 'GLM-5.3', timed_minutes: 24 },
  { id: 'glm-5.4', label: 'GLM-5.4', timed_minutes: null },
]);

export const DEFAULT_AGENT_MODEL = AGENT_MODELS[0].id;
export const AGENT_MODEL_IDS = Object.freeze(AGENT_MODELS.map((m) => m.id));
/** A model id as sent by a page or a queued task, or null: anything else is no model. */
export const modelId = (v) => (typeof v === 'string' && AGENT_MODEL_IDS.includes(v) ? v : null);
/** The name to show for an id; the id itself for one this build does not know. */
export const modelLabel = (id) => AGENT_MODELS.find((m) => m.id === id)?.label ?? String(id ?? '');
/** The minutes a model was timed at, or null when it was not timed (or is not known). */
export const modelMinutes = (id) => AGENT_MODELS.find((m) => m.id === id)?.timed_minutes ?? null;
/**
 * Whether a review by this model needs the longer time limit, and its own wait told to the reader. By what the
 * model is, never by whether a server happens to make it its default. One that was not timed is not assumed
 * to be quick.
 */
export const writesSlowly = (id) => { const t = modelMinutes(id); return t == null || t > 5; };
