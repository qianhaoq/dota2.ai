import { A2UIBlock, LessonMode } from '../../types';
import { MatchupData, HeroSuggestion, TierHero, PlaybookHero } from '../../services/geminiService';
import type { MatchFact } from '../../types/matchReview';
import type { ReviewCardsPayload } from '../../types/reviewCards';

export type CoachAction = 'analyze' | 'playbook' | 'suggest' | 'meta' | 'review';

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
  matchFact?: MatchFact | null;
  /** 结构化复盘卡片（Fact → Insight → Drill） */
  reviewCards?: ReviewCardsPayload | null;
  /** 复盘追问（仅 markdown 流，不重复渲染 fact spine） */
  reviewFollowUp?: boolean;
  /** 复盘等流式请求失败时的错误信息（不写入 content，避免误渲染为复盘正文） */
  error?: string;
}

export interface CoachSession {
  id: string;
  query?: string;
  action?: CoachAction;
  lesson?: LessonMode;
  message: CoachMessage;
  blocks: A2UIBlock[];
}
