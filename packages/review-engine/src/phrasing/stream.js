import { allowedSlots, renderSlots } from './slots.js';
import { validateSlots, validateRendered } from './validator.js';
import { refusal } from './templates.js';
/** @param {AsyncIterable<string>|Iterable<string>} chunks @param {any} options */
export async function* validateStream(chunks, options) {
  let buffer = '';
  const seen = new Set();
  const validate = sentence => {
    const check = validateSlots(sentence, { allowedFactIds: options.allowedFactIds ?? allowedSlots(options.facts) });
    if (!check.ok) return null;
    try {
      const text = renderSlots(sentence, options.facts, options.lang);
      if (!validateRendered(text, options).ok) return null;
      for (const id of options.requiredFactIds ?? []) if (sentence.includes(`{${id}}`)) seen.add(id);
      return text;
    } catch { return null; }
  };
  for await (const chunk of chunks) {
    buffer += chunk;
    // Slot ids can contain periods: split punctuation only outside braces.
    let depth = 0, start = 0;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] === '{') depth++;
      if (buffer[i] === '}') depth--;
      if (depth <= 0 && /[。！？.!?\n]/.test(buffer[i])) {
        const text = validate(buffer.slice(start, i + 1));
        if (text === null) { yield refusal(options.lang); return; }
        yield text; start = i + 1;
      }
    }
    buffer = buffer.slice(start);
    if (buffer.length > 16000) { yield refusal(options.lang); return; }
  }
  if (buffer.trim()) { const text = validate(buffer); if (text === null) { yield refusal(options.lang); return; } yield text; }
  if ((options.requiredFactIds ?? []).some(id => !seen.has(id))) yield refusal(options.lang);
}
