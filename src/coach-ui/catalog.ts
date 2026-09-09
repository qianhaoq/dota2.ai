/**
 * Trusted component/action catalog for the internal `dota-coach-ui/1` model.
 * NOT an official A2UI wire protocol. Components and actions are dual
 * whitelists: unknown components render a safe text fallback, unknown props
 * and dangerous schemes (RawHtml, eval, dynamic scripts) are rejected.
 */

import type { CoachSurfaceComponent } from './types';

export const CATALOG_ID = 'dota-coach-ui/1';

export const COMPONENTS: readonly CoachSurfaceComponent[] = Object.freeze([
  'CoachBrief',
  'TacticalMap',
  'DraftBoard',
  'ItemTradeoff',
  'DecisionFork',
  'TrainingDrill',
  'EvidenceLens',
  'KnowledgeLens',
  'PracticeCommit',
]);

export const ACTIONS = Object.freeze([
  'answer',
  'compare',
  'inspect',
  'save',
  'selectHero',
  'annotate',
  'retry',
] as const);

export type CoachAction = (typeof ACTIONS)[number];

export interface ComponentSpec {
  component: CoachSurfaceComponent;
  /** What the component is for. */
  purposeZh: string;
  purposeEn: string;
  /** Degraded rendering when data or capability is missing. */
  fallbackZh: string;
  fallbackEn: string;
}

/** Domain catalog from docs/design/tactical-coach-v3/docs/A2UI.md. */
export const CATALOG: Readonly<Record<CoachSurfaceComponent, ComponentSpec>> = Object.freeze({
  CoachBrief: {
    component: 'CoachBrief',
    purposeZh: '一句话要点、条件与边界',
    purposeEn: 'One-line takeaway with conditions and boundary',
    fallbackZh: '待澄清问题',
    fallbackEn: 'Pending clarification question',
  },
  TacticalMap: {
    component: 'TacticalMap',
    purposeZh: '英雄/标记/假设路线/图层',
    purposeEn: 'Heroes / markers / hypothesis routes / layers',
    fallbackZh: '关系图或非空间时间线',
    fallbackEn: 'Relation diagram or non-spatial timeline',
  },
  DraftBoard: {
    component: 'DraftBoard',
    purposeZh: '固定格、预览、采用、撤销',
    purposeEn: 'Fixed slots, preview, adopt, undo',
    fallbackZh: '已知阵容与任务澄清',
    fallbackEn: 'Known lineup and task clarification',
  },
  ItemTradeoff: {
    component: 'ItemTradeoff',
    purposeZh: '两条路线、前提、代价、改选条件',
    purposeEn: 'Two routes, premises, costs, switch conditions',
    fallbackZh: '先问经济/威胁缺口',
    fallbackEn: 'Ask for economy / threat gap first',
  },
  DecisionFork: {
    component: 'DecisionFork',
    purposeZh: '选分支、补假设、撤销',
    purposeEn: 'Pick a branch, add hypotheses, undo',
    fallbackZh: '不计算无依据的增益',
    fallbackEn: 'No gains computed without evidence',
  },
  TrainingDrill: {
    component: 'TrainingDrill',
    purposeZh: '先提交、再讲解、换变体',
    purposeEn: 'Commit first, explain after, switch variant',
    fallbackZh: '明确教学情境',
    fallbackEn: 'Label as teaching scenario',
  },
  EvidenceLens: {
    component: 'EvidenceLens',
    purposeZh: '事实字段、时刻、缺口',
    purposeEn: 'Fact fields, moments, gaps',
    fallbackZh: '局部错误',
    fallbackEn: 'Partial error',
  },
  KnowledgeLens: {
    component: 'KnowledgeLens',
    purposeZh: '英雄/技能/物品的情境知识',
    purposeEn: 'Situational knowledge of heroes / abilities / items',
    fallbackZh: '暂无资料/局部重试',
    fallbackEn: 'No data yet / partial retry',
  },
  PracticeCommit: {
    component: 'PracticeCommit',
    purposeZh: '保存、检查、完成、撤销',
    purposeEn: 'Save, check, complete, undo',
    fallbackZh: '本机会话状态',
    fallbackEn: 'Local session state',
  },
});

export function isKnownComponent(value: unknown): value is CoachSurfaceComponent {
  return typeof value === 'string' && (COMPONENTS as readonly string[]).includes(value);
}

export function isKnownAction(value: unknown): value is CoachAction {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);
}
