import { A2UIBlock, LessonMode } from '../../types';
import { MatchupData, HeroSuggestion, TierHero, PlaybookHero } from '../../services/geminiService';

export type CoachAction = 'analyze' | 'playbook' | 'suggest' | 'meta';

export interface CoachMessage {
  id: string;
  type: 'user' | 'coach';
  action?: CoachAction;
  lesson?: LessonMode;
  content: string;
  isStreaming?: boolean;
  grounded?: boolean;
  matchupData?: MatchupData | null;
  playbookData?: PlaybookHero[];
  suggestions?: HeroSuggestion[];
  tierHeroes?: TierHero[];
}

export interface CoachSession {
  id: string;
  query?: string;
  action?: CoachAction;
  lesson?: LessonMode;
  message: CoachMessage;
  blocks: A2UIBlock[];
}
