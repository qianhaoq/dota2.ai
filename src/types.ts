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