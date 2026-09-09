export enum Attribute {
  STRENGTH = 'Strength',
  AGILITY = 'Agility',
  INTELLIGENCE = 'Intelligence',
  UNIVERSAL = 'Universal'
}

export interface Hero {
  id: number;
  name: string;
  nameZh?: string;
  nameEn?: string;
  aliases?: string[];
  attribute: Attribute;
  roles?: string[];
  rolesZh?: string[];
  img: string;
  imgFallback?: string;
  icon?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: Date;
}

export enum AppTab {
  DRAFT = 'draft',
  LORE = 'lore',
  GUIDE = 'guide'
}

export interface DraftState {
  radiant: Hero[];
  dire: Hero[];
}

export type Language = 'en' | 'zh';

/** 带练课表模式 */
export type LessonMode = 'bp' | 'match' | 'items' | 'mind' | 'review';

/**
 * A2UI（agent-to-UI）生成式卡片块。
 * 教练流式结果映射到这些块，而不是纯聊天气泡。
 */
export type A2UIBlockType =
  | 'section'
  | 'actions'
  | 'matchups'
  | 'tier'
  | 'markdown'
  | 'review'
  | 'reviewInsight';

export interface A2UIAction {
  id: string;
  label: string;
  subtitle?: string;
  meta?: string;
  heroId?: number;
}

export interface A2UIBlock {
  id: string;
  type: A2UIBlockType;
  title?: string;
  markdown?: string;
  actions?: A2UIAction[];
  /** analyze 流的对位数据（MatchupData） */
  matchups?: unknown;
  /** playbook 流出装（PlaybookHero[]） */
  playbook?: unknown;
  /** meta 梯队（TierHero[]） */
  tierHeroes?: unknown;
  /** 复盘 MatchFact */
  matchFact?: unknown;
  /** 复盘子区块 */
  reviewSection?: 'summary' | 'lanes' | 'economy' | 'timeline' | 'pov' | 'howToWin';
  /** AI 复盘卡片子类型 */
  reviewCardKind?:
    | 'match_summary'
    | 'phases'
    | 'primary_mistake'
    | 'key_moments'
    | 'drill'
    | 'followups'
    | 'mentor_note'
    | 'item_compare'
    | 'farm_benchmarks'
    | 'matchup_context';
  /** 结构化复盘卡片数据 */
  reviewCards?: import('./types/reviewCards').ReviewCardsPayload;
}