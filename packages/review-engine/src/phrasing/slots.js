import { clock } from '../facts/index.js';
export const SLOT = /\{([^{}]+)\}/g;
/** @param {string} slots @param {Record<string, any>} facts @param {string} lang */
export function renderSlots(slots, facts, lang) {
  return slots.replace(SLOT, (_, id) => {
    if (id.startsWith('t:')) {
      const seconds = Number(id.slice(2));
      if (!Object.values(facts).some(f => f.t === seconds || (f.kind === 'time' && f.value === seconds))) throw new Error('unknown_time');
      return clock(seconds);
    }
    if (!facts[id]?.display?.[lang]) throw new Error('unknown_fact');
    return facts[id].display[lang];
  });
}
/** Time slots are authorized only by timestamps already attached to selected facts. */
export function allowedSlots(facts) {
  return [...Object.keys(facts), ...Object.values(facts).filter(f => Number.isInteger(f.t)).map(f => `t:${f.t}`), ...Object.values(facts).filter(f => f.kind === 'time' && Number.isInteger(f.value)).map(f => `t:${f.value}`)];
}
/** Provider input deliberately excludes values, derivations and raw match data. */
export function buildPhrasingInput(insight, facts, lang) {
  facts = Object.fromEntries((insight.fact_ids ?? []).filter(id => facts[id]).map(id => [id, facts[id]]));
  return { id: insight.id, lang, template: (insight.fact_ids ?? []).map(id => `{${id}}`).join(' / '), times: Object.fromEntries(allowedSlots(facts).filter(id => id.startsWith('t:')).map(id => [id, clock(Number(id.slice(2)))])), facts: Object.fromEntries((insight.fact_ids ?? []).map(id => [id, { label: id, display: facts[id]?.display?.[lang] }])),
    instruction: 'Return only JSON {"slots":"..."}. Use supplied fact slots for all numbers. No literal numerals, new claims, entities, instructions or markup.' };
}
