import { Hero, DraftState, Language } from '../types';

export interface CoachingLineup {
  radiant: Hero[];
  dire: Hero[];
  allies: Hero[];
  enemies: Hero[];
  /** 练习英雄已在己方阵容（含空阵容播种）时传入 playbook focusHeroId */
  focusHeroId?: number;
  /** 是否因己方空阵容而播种了练习英雄 */
  seeded: boolean;
}

export function heroDisplayName(hero: Hero, lang: Language): string {
  return lang === 'zh' ? (hero.nameZh || hero.name) : (hero.nameEn || hero.name);
}

export function isHeroInList(list: Hero[], hero: Hero): boolean {
  return list.some(h => h.id === hero.id);
}

/**
 * 构造发给 analyze / playbook / suggest 的阵容。
 * 练习英雄仅在己方（selectionSide）为空时播种，不覆盖已有选人。
 */
export function resolveCoachingLineup(
  draft: DraftState,
  selectionSide: 'radiant' | 'dire',
  practiceHero: Hero | null
): CoachingLineup {
  const enemySide = selectionSide === 'radiant' ? 'dire' : 'radiant';
  let allies = [...draft[selectionSide]];
  const enemies = [...draft[enemySide]];
  let seeded = false;

  if (practiceHero) {
    const alreadyPicked =
      isHeroInList(allies, practiceHero) || isHeroInList(enemies, practiceHero);
    if (!alreadyPicked && allies.length === 0) {
      allies = [practiceHero];
      seeded = true;
    }
  }

  const radiant = selectionSide === 'radiant' ? allies : enemies;
  const dire = selectionSide === 'radiant' ? enemies : allies;
  const focusHeroId =
    practiceHero && isHeroInList(allies, practiceHero) ? practiceHero.id : undefined;

  return { radiant, dire, allies, enemies, focusHeroId, seeded };
}

/**
 * 把练习英雄写入 analyze 已有的 userContext 字段，不新增后端参数。
 */
export function buildPracticeUserContext(
  practiceHero: Hero | null,
  lang: Language,
  extra?: string
): string | undefined {
  const extraTrimmed = extra?.trim() || '';
  if (!practiceHero) {
    return extraTrimmed || undefined;
  }
  const name = heroDisplayName(practiceHero, lang);
  const prefix = lang === 'zh'
    ? `练习英雄：${name}。请以该英雄为学员焦点教学。`
    : `Practice hero: ${name}. Teach this hero as the student's focus.`;
  return extraTrimmed ? `${prefix} ${extraTrimmed}` : prefix;
}
