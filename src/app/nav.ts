/**
 * V3 primary navigation (docs/design/tactical-coach-v3/docs/DESIGN.md §2):
 * four first-level destinations only — 战术室 / 英雄修炼 / 英雄图鉴 / 战术笔记.
 * Draft, review and items live inside the tactical room, not on the nav bar.
 */

import type { Language } from '../types';

export const NAV_IDS = ['tactical', 'training', 'knowledge', 'journal'] as const;
export type NavId = (typeof NAV_IDS)[number];

export interface NavDescriptor {
  id: NavId;
  zh: string;
  en: string;
  symbol: string;
}

export const NAV_ITEMS: readonly NavDescriptor[] = [
  { id: 'tactical', zh: '战术室', en: 'Tactical Room', symbol: '◇' },
  { id: 'training', zh: '英雄修炼', en: 'Hero Training', symbol: '✧' },
  { id: 'knowledge', zh: '英雄图鉴', en: 'Hero Codex', symbol: '▦' },
  { id: 'journal', zh: '战术笔记', en: 'Tactical Journal', symbol: '▤' },
];

export function navLabel(item: NavDescriptor, lang: Language): string {
  return lang === 'zh' ? item.zh : item.en;
}

export function isNavId(value: unknown): value is NavId {
  return typeof value === 'string' && (NAV_IDS as readonly string[]).includes(value);
}

/** Tactical-room workspaces (start = motive landing). */
export const TACTICAL_WORKSPACES = ['start', 'review', 'draft', 'items'] as const;
export type TacticalWorkspaceId = (typeof TACTICAL_WORKSPACES)[number];

export interface TacticalWorkspaceDescriptor {
  id: TacticalWorkspaceId;
  zh: string;
  en: string;
}

export const TACTICAL_WORKSPACE_ITEMS: readonly TacticalWorkspaceDescriptor[] = [
  { id: 'start', zh: '入口', en: 'Start' },
  { id: 'review', zh: '复盘', en: 'Review' },
  { id: 'draft', zh: '阵容', en: 'Draft' },
  { id: 'items', zh: '装备', en: 'Items' },
];

export function tacticalWorkspaceLabel(id: TacticalWorkspaceId, lang: Language): string {
  const item = TACTICAL_WORKSPACE_ITEMS.find((w) => w.id === id);
  if (!item) return id;
  return lang === 'zh' ? item.zh : item.en;
}
