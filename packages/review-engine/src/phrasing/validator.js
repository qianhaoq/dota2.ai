import { STATIC_HEROES } from '../staticHeroes.js';
import { SLOT } from './slots.js';
const result = reason => ({ ok: !reason, reason });
/** Numbers inside slots are identifiers, never literal prose. */
export function validateSlots(slots, { allowedFactIds, requiredFactIds = [] }) {
  if (typeof slots !== 'string' || !slots.trim()) return result('malformed_slots');
  const ids = [...slots.matchAll(SLOT)].map(m => m[1]);
  const prose = slots.replace(SLOT, '');
  if (/[{}]/.test(prose)) return result('malformed_slots');
  if (/[0-9０-９一二三四五六七八九十百千万两零]/.test(prose)) return result('literal_number');
  if (/<|>|```|ignore|system\s*:|instructions?|忽略|指令/i.test(prose)) return result('unsafe_output');
  if (ids.some(id => !allowedFactIds.includes(id))) return result('unknown_fact');
  if (requiredFactIds.some(id => !ids.includes(id))) return result('missing_required_fact');
  return result(null);
}
// Capture decorated numbers as a whole, preserving units and signs in comparison.
const numbers = text => text.match(/[▼▲]?[+−–-]?(?:\d+:\d{2}|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:[kK]|%)?/g) ?? [];
const normalize = token => token.replace(/,/g, '').replace(/[−–]/g, '-').replace(/^▼/, '-').replace(/^▲/, '+').replace(/k$/i, 'k');
const clean = text => String(text).toLowerCase().replace(/_/g, ' ');
const mentions = (text, name) => name && (/[\u3400-\u9fff]/.test(name) ? text.includes(name) : new RegExp(`(?<![a-z])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z])`, 'i').test(text));
/** Fail closed for entities: prose may only name heroes/items backed by evidence.
 * @param {string} text
 * @param {{facts: Record<string, any>, roster?: any[], purchases?: any[], dataGaps?: any[], lang?: string}} context
 */
export function validateRendered(text, { facts, roster = [], purchases = [], dataGaps = [], lang = 'en' }) {
  if (typeof text !== 'string' || /[{}０-９]|[+−–-]{2}/.test(text)) return result('malformed_render');
  const allowed = new Set(Object.values(facts).flatMap(/** @param {any} f */ f => numbers(f.display?.[lang] ?? '').concat(numbers(f.display?.t ?? ''))).map(normalize));
  if (numbers(text).some(n => !allowed.has(normalize(n)))) return result('fabricated_number');
  if (dataGaps.some(g => (g.topic ?? g) === 'death_locations') && /\b(vision|wards?|position|coordinates)\b|视野|站位|坐标|位置/i.test(text)) return result('data_gap');
  const prose = clean(text);
  for (const hero of Object.values(STATIC_HEROES)) {
    if ([hero.nameEn, hero.nameZh, hero.internalSlug].some(n => mentions(prose, clean(n))) && !roster.some(r => (r.hero ?? r) === hero.internalSlug || r.hero_id === hero.id)) return result('hero_not_in_roster');
  }
  // Item entities must be quoted or referenced by a slot. Removing trusted displays
  // leaves a small, auditable coaching vocabulary; unknown item names fail closed.
  let remaining = prose;
  for (const f of Object.values(facts)) remaining = remaining.split(clean(f.display?.[lang] ?? '\0')).join(' ');
  for (const hero of Object.values(STATIC_HEROES)) for (const n of [hero.nameEn, hero.nameZh, hero.internalSlug]) remaining = remaining.split(clean(n)).join(' ');
  for (const p of purchases) remaining = remaining.split(clean(p.item ?? p)).join(' ');
  const vocabulary = new Set('a an the your team gold change global low recovery deaths of while behind review these first next game economy last hits safe resource collection practice consistent avoid fights worst minute turning point match evidence timeline laning at from to and in is was by total lost gained focus on improve prioritize'.split(' '));
  if (lang === 'en' && (remaining.match(/[a-z]+/g) ?? []).some(w => !vocabulary.has(w))) return result('unbacked_entity_or_prose');
  if (lang === 'zh' && /[a-z]|[\u3400-\u9fff]/i.test(remaining.replace(/转折点|复查|这些|死亡|下局|发育|比赛|证据|经济|变化|全局|低点|回升段|次|共|对线|时间线/g, ''))) return result('unbacked_entity_or_prose');
  return result(null);
}
