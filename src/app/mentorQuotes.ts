import type { NavId } from './nav';

/** One mentor line per destination — expression layer, not facts. */
export const QUOTES: Record<NavId, { zh: string; en: string }> = {
  tactical: { zh: '不急着告诉你答案。先一起看清局面。', en: 'No rush to the answer — see the situation first.' },
  training: { zh: '先做一次判断。答案留在下一步。', en: 'Make a call first. The answer waits a step.' },
  knowledge: { zh: '认识一个技能，要从使用它的时机开始。', en: 'Know an ability by when to use it.' },
  journal: { zh: '下一局，只带走一个值得练习的动作。', en: 'Take one practicable action into the next game.' },
};
