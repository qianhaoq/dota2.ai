import { allowedSlots, buildPhrasingInput, renderSlots } from './slots.js';
import { renderTemplate } from './templates.js';
import { validateSlots, validateRendered } from './validator.js';
import { dailyBudget } from './budget.js';
/** @param {{insight:any, facts:any, lang:string, complete?:Function, budget?:any, roster?:any[], purchases?:any[], dataGaps?:any[], timeoutMs?:number, log?:Function}} options */
export async function phraseInsight({
  insight, facts, lang, complete, budget = dailyBudget,
  roster = [], purchases = [], dataGaps = [], timeoutMs = 8000, log = console.warn,
}) {
  const fallback = renderTemplate(insight, facts, lang);
  if (!complete || insight.answerable === false || insight.status === 'insufficient' || !budget.enabled()) return fallback;
  const selected = Object.fromEntries((insight.fact_ids ?? []).filter(id => facts[id]).map(id => [id, facts[id]]));
  const controller = new AbortController();
  let timer;
  try {
    const input = buildPhrasingInput(insight, selected, lang);
    input.approved_clauses = fallback.slots;
    input.instruction += ' Only reorder the complete approved_clauses sentences; preserve each sentence exactly.';
    const pending = Promise.resolve().then(() => complete(input, { signal: controller.signal })).then(response => {
      // Charge completed calls even when validation fails or the caller timed out.
      budget.record(response?.usage ?? {
        prompt_tokens: JSON.stringify(input).length,
        completion_tokens: String(response?.text ?? response).length,
      });
      return response;
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('timeout'));
      }, timeoutMs);
    });
    const response = await Promise.race([pending, timeout]);
    const parsed = JSON.parse(typeof response === 'string' ? response : response.text);
    if (!parsed || Object.keys(parsed).join() !== 'slots') throw new Error('invalid_json_shape');
    const check = validateSlots(parsed.slots, { approvedSlots: fallback.slots, allowedFactIds: allowedSlots(selected), requiredFactIds: insight.required_fact_ids ?? insight.fact_ids });
    if (!check.ok) throw new Error(check.reason);
    const text = renderSlots(parsed.slots, selected, lang);
    const rendered = validateRendered(text, { facts: selected, roster, purchases, dataGaps, lang });
    if (!rendered.ok) throw new Error(rendered.reason);
    return { text, slots: parsed.slots, phrasing: 'llm' };
  } catch (error) {
    const reasons = ['fact_clause_mismatch', 'timeout', 'invalid_json_shape', 'malformed_slots', 'literal_number', 'unsafe_output', 'unknown_fact', 'unknown_time', 'missing_required_fact', 'malformed_render', 'fabricated_number', 'data_gap', 'hero_not_in_roster', 'unbacked_entity_or_prose'];
    const reason = error instanceof SyntaxError ? 'invalid_json' : error instanceof Error && reasons.includes(error.message) ? error.message : 'provider_error';
    log('validator_reject', { reason });
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}
