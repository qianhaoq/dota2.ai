import { expect, it } from 'vitest';
import { practiceGoalText } from './practiceGoalText';
import type { Insight } from './types';
const insight = (text:string) => ({id:'next_game',claim:{text}} as Insight);
it('keeps the next-game action verbatim while evidence retains the historical purchase text',()=>{
  expect(practiceGoalText(insight('This game: 13 CS. Next game aim for at least 13 CS at 10:00. Purchased BKB at 44:33.'))).toBe('Next game aim for at least 13 CS at 10:00.');
  expect(practiceGoalText(insight('本局补刀13。下一局10分钟补刀至少13。44:33购入黑皇杖。'))).toBe('下一局10分钟补刀至少13。');
  expect(practiceGoalText(insight('Unrecognized wording is retained.'))).toBe('Unrecognized wording is retained.');
  expect(practiceGoalText(insight('This game is recorded. Next game check 1.5 minutes before moving. Historical detail follows.'))).toBe('Next game check 1.5 minutes before moving.');
});
