import React from 'react';
import CoachView from '../../components/CoachView';
import type { Language, LessonMode } from '../../types';

export interface CoachSessionProps {
  lang: Language;
  /**
   * Soft lesson switch owned by the tactical room. One CoachSession instance
   * is shared by the review and draft workspaces so SSE streams, review
   * surfaces and drafts survive workspace navigation.
   */
  lessonRequest: { mode: LessonMode; nonce: number } | null;
}

/**
 * V3 wrapper around the existing CoachView: the streaming coach, ReviewEntry
 * intake, pinned ReviewSurface and follow-up flows all keep working unchanged.
 */
const CoachSession: React.FC<CoachSessionProps> = ({ lang, lessonRequest }) => (
  <CoachView lang={lang} lessonRequest={lessonRequest} />
);

export default CoachSession;
