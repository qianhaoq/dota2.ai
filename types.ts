export enum Attribute {
  STRENGTH = 'Strength',
  AGILITY = 'Agility',
  INTELLIGENCE = 'Intelligence',
  UNIVERSAL = 'Universal'
}

export interface Hero {
  id: number;
  name: string;
  attribute: Attribute;
  img: string;
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