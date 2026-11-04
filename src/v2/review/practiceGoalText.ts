import type { Insight } from './types';

/** Select an existing action sentence verbatim; all supporting facts stay in evidence. */
export function practiceGoalText(insight: Insight): string {
  const text = insight.claim.text.trim();
  if (insight.id !== 'next_game') return text;
  const sentences = text.split(/(?<=[。.!?！？])\s*/).filter(Boolean);
  return sentences.find(sentence => /^(?:Next game\b|下一局|优先练习|Practice consistent\b)/i.test(sentence)) ?? text;
}
