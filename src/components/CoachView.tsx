import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Hero, DraftState, Language, LessonMode } from '../types';
import HeroDetail from './HeroDetail';
import {
  analyzeDraftStream,
  fetchSuggestions,
  fetchTierList,
  fetchPlaybookStream,
  fetchMatchReviewStream,
} from '../services/geminiService';
import { fetchHeroes } from '../services/dotaApiService';
import { buildPracticeUserContext, heroDisplayName, resolveAnalyzeUserMessage, resolveCoachingLineup } from '../utils/practiceContext';
import { appendStreamChunk, generateMessageId } from '../utils/streamAccumulator';
import { pairCoachSessions } from '../utils/coachBlocks';
import { findPrimaryReviewSession, canSubmitReviewFollowUpForContext, findInflightCoachSession, primaryReviewFollowUpContext, type ReviewFollowUpContext } from '../utils/reviewSurface';
import { resolveCoachComposerState, shouldSubmitReviewFollowUp } from '../utils/coachComposer';
import {
  clearStreamingCoachMessages,
  coachCancelledMessage,
  coachFetchTimeoutMessage,
  awaitWithTimeout,
  claimCoachInflightGeneration,
  invalidateCoachInflightGeneration,
  isCoachInflightCurrent,
  META_FETCH_TIMEOUT_MS,
  SUGGEST_FETCH_TIMEOUT_MS,
  finalizeReviewCoachMessage,
} from '../utils/coachInflight';
import { X } from 'lucide-react';
import {
  HeroPickerOverlay,
  MentorStage,
  MentorPicker,
  HomeModules,
  CoachCanvas,
  CoachComposer,
  ReviewSurface,
} from './coach';
import type { CoachMessage } from './coach/coachMessage';
import {
  EMPTY_DRAFT,
  acceptHeroOntoDraft,
  clearStaleSuggestionMessages,
  clearStaleSuggestionsForPracticeHero,
  draftHasHeroes,
  resolveLessonDraftSwitch,
  type DraftSide,
} from '../utils/draftContext';

interface CoachViewProps {
  lang: Language;
  /**
   * External lesson switch (e.g. tactical-room motive entries). Bump `nonce`
   * to re-apply the same mode. This is a soft switch: it changes the active
   * workspace without auto-running a task — generation stays explicit.
   */
  lessonRequest?: { mode: LessonMode; nonce: number } | null;
}

const CoachView: React.FC<CoachViewProps> = ({ lang, lessonRequest }) => {
  const [allHeroes, setAllHeroes] = useState<Hero[]>([]);
  const [isHeroesLoading, setIsHeroesLoading] = useState(true);
  const [mentor, setMentor] = useState<Hero | null>(null);
  const [practiceHero, setPracticeHero] = useState<Hero | null>(null);
  const [lesson, setLesson] = useState<LessonMode>('mind');
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  /** editingSide — which side the picker writes into (DESIGN.md mySide vs editingSide). */
  const [selectionSide, setSelectionSide] = useState<'radiant' | 'dire'>('radiant');
  /** mySide — ally perspective for analyze/playbook; independent of editingSide. */
  const [mySide, setMySide] = useState<'radiant' | 'dire'>('radiant');
  /** True once the user explicitly picked My side; blocks first-pick emptyBefore inference. */
  const mySideExplicitRef = useRef(false);
  const [contextRevision, setContextRevision] = useState(0);
  const draftSnapshotRef = useRef<DraftState>(EMPTY_DRAFT);
  const [messages, setMessages] = useState<CoachMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [userInput, setUserInput] = useState('');
  const streamControllerRef = useRef<AbortController | null>(null);
  const inflightTaskRef = useRef(0);
  const prevInflightSessionIdRef = useRef<string | null>(null);
  const activeReviewRef = useRef<{ matchId: number; heroId?: number } | null>(null);
  const pendingFollowUpContextRef = useRef<ReviewFollowUpContext | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [showMentorPicker, setShowMentorPicker] = useState(false);
  const [showHeroPicker, setShowHeroPicker] = useState(false);
  const [detailHeroId, setDetailHeroId] = useState<number | null>(null);
  const [dismissedSessionIds, setDismissedSessionIds] = useState<string[]>([]);
  const [lastDismissedSessionId, setLastDismissedSessionId] = useState<string | null>(null);
  const [composerFocusToken, setComposerFocusToken] = useState(0);

  useEffect(() => {
    const loadData = async () => {
      setIsHeroesLoading(true);
      const data = await fetchHeroes(lang);
      setAllHeroes(data);
      const rubick = data.find(h => (h.name || '').toLowerCase() === 'rubick' || h.id === 86);
      setMentor(rubick || null);
      setIsHeroesLoading(false);
    };
    loadData();
  }, [lang]);

  const t = useMemo(() => ({
    needHeroes: lang === 'zh' ? '请先选择英雄' : 'Please select heroes first',
    needAllies: lang === 'zh' ? '请先选择己方英雄' : 'Please select your heroes first',
  }), [lang]);

  const handleHeroSelect = useCallback((hero: Hero) => {
    const isPicked = [...draft.radiant, ...draft.dire].find(h => h.id === hero.id);
    if (isPicked) return;
    // Practice hero seeds the ally side on an empty board, so a practice-only
    // lineup counts as non-empty for first-pick side inference — picking an
    // enemy first must not flip mySide to the opposing side.
    const emptyBefore = !draftHasHeroes(draft) && !practiceHero;
    if (draft[selectionSide].length >= 5) return;
    setDraft(prev => ({ ...prev, [selectionSide]: [...prev[selectionSide], hero] }));
    if (lesson === 'review') {
      // Picker edits made during review are intentional: persist them into the
      // snapshot (guarded against the snapshot board) so leave-review restore
      // keeps the picks. Live draft is still updated above for visible feedback.
      const board = draftSnapshotRef.current;
      const snapshotPicked = [...board.radiant, ...board.dire].find(h => h.id === hero.id);
      if (!snapshotPicked && board[selectionSide].length < 5) {
        draftSnapshotRef.current = { ...board, [selectionSide]: [...board[selectionSide], hero] };
      }
    }
    if (emptyBefore && !mySideExplicitRef.current) setMySide(selectionSide);
    setContextRevision((n) => n + 1);
  }, [draft, selectionSide, lesson, practiceHero]);

  const addCoachMessage = useCallback((message: Omit<CoachMessage, 'id'>) => {
    const id = generateMessageId();
    setMessages(prev => [...prev, { ...message, id }]);
    return id;
  }, []);

  const updateCoachMessage = useCallback((id: string, updates: Partial<CoachMessage>) => {
    setMessages(prev => prev.map(msg => msg.id === id ? { ...msg, ...updates } : msg));
  }, []);

  const cancelStream = useCallback(() => {
    invalidateCoachInflightGeneration(inflightTaskRef);
    if (streamControllerRef.current) {
      streamControllerRef.current.abort();
      streamControllerRef.current = null;
    }
    setIsLoading(false);
    setMessages((prev) => clearStreamingCoachMessages(prev, coachCancelledMessage(lang)));
  }, [lang]);

  const finishStream = useCallback((streamGen: number) => {
    if (!isCoachInflightCurrent(inflightTaskRef, streamGen)) return;
    setIsLoading(false);
    streamControllerRef.current = null;
  }, []);

  const coaching = useMemo(
    () => resolveCoachingLineup(draft, mySide, practiceHero),
    [draft, mySide, practiceHero]
  );

  const handleAnalyze = useCallback((options?: { ignoreComposerInput?: boolean; draftOverride?: DraftState }) => {
    const lineup = options?.draftOverride
      ? resolveCoachingLineup(options.draftOverride, mySide, practiceHero)
      : coaching;
    if (lineup.radiant.length === 0 && lineup.dire.length === 0) {
      addCoachMessage({ type: 'coach', content: t.needHeroes });
      return;
    }
    cancelStream();
    setIsLoading(true);
    const streamGen = claimCoachInflightGeneration(inflightTaskRef);
    const practiceName = practiceHero ? heroDisplayName(practiceHero, lang) : null;
    const defaultMsg = practiceName
      ? (lang === 'zh' ? `分析练习英雄 ${practiceName}` : `Analyze practice hero ${practiceName}`)
      : (lang === 'zh' ? '分析当前阵容' : 'Analyze current lineup');
    const userMsg = resolveAnalyzeUserMessage(userInput, defaultMsg, options?.ignoreComposerInput);
    const userContext = buildPracticeUserContext(practiceHero, lang, userMsg);
    addCoachMessage({ type: 'user', action: 'analyze', lesson, content: userMsg });
    setUserInput('');
    const msgId = addCoachMessage({ type: 'coach', action: 'analyze', lesson, content: '', isStreaming: true, allySide: mySide, contextRevision });
    streamControllerRef.current = analyzeDraftStream(
      lineup.radiant, lineup.dire, lang, userContext,
      {
        onChunk: (text) => {
          if (!isCoachInflightCurrent(inflightTaskRef, streamGen)) return;
          setMessages(prev => appendStreamChunk(prev, msgId, text));
        },
        onMatchupData: (data) => {
          if (!isCoachInflightCurrent(inflightTaskRef, streamGen)) return;
          updateCoachMessage(msgId, { matchupData: data });
        },
        onComplete: (grounded) => {
          if (!isCoachInflightCurrent(inflightTaskRef, streamGen)) return;
          updateCoachMessage(msgId, { isStreaming: false, grounded });
          finishStream(streamGen);
        },
        onError: (error) => {
          if (!isCoachInflightCurrent(inflightTaskRef, streamGen)) return;
          updateCoachMessage(msgId, { content: `Error: ${error}`, isStreaming: false });
          finishStream(streamGen);
        }
      }
    );
  }, [coaching, mySide, contextRevision, practiceHero, lang, userInput, lesson, addCoachMessage, updateCoachMessage, cancelStream, finishStream, t]);

  const handlePlaybook = useCallback((options?: { draftOverride?: DraftState }) => {
    const lineup = options?.draftOverride
      ? resolveCoachingLineup(options.draftOverride, mySide, practiceHero)
      : coaching;
    if (lineup.allies.length === 0) {
      addCoachMessage({ type: 'coach', content: t.needAllies });
      return;
    }
    cancelStream();
    setIsLoading(true);
    const streamGen = claimCoachInflightGeneration(inflightTaskRef);
    const practiceName = practiceHero ? heroDisplayName(practiceHero, lang) : null;
    const playbookMsg = practiceName
      ? (lang === 'zh' ? `本局怎么打${practiceName}？` : `How should we play ${practiceName} this game?`)
      : (lang === 'zh' ? '本局怎么打？' : 'How should we play this game?');
    addCoachMessage({ type: 'user', action: 'playbook', lesson: 'match', content: playbookMsg });
    const msgId = addCoachMessage({ type: 'coach', action: 'playbook', lesson: 'match', content: '', isStreaming: true, playbookData: [], allySide: mySide, contextRevision });
    streamControllerRef.current = fetchPlaybookStream(
      lineup.allies, lineup.enemies, mySide, lang, lineup.focusHeroId,
      {
        onData: (data) => {
          if (!isCoachInflightCurrent(inflightTaskRef, streamGen)) return;
          updateCoachMessage(msgId, { playbookData: data });
        },
        onChunk: (text) => {
          if (!isCoachInflightCurrent(inflightTaskRef, streamGen)) return;
          setMessages(prev => appendStreamChunk(prev, msgId, text));
        },
        onComplete: () => {
          if (!isCoachInflightCurrent(inflightTaskRef, streamGen)) return;
          updateCoachMessage(msgId, { isStreaming: false, grounded: true });
          finishStream(streamGen);
        },
        onError: (error) => {
          if (!isCoachInflightCurrent(inflightTaskRef, streamGen)) return;
          updateCoachMessage(msgId, { content: `Error: ${error}`, isStreaming: false });
          finishStream(streamGen);
        }
      }
    );
  }, [coaching, practiceHero, mySide, contextRevision, lang, addCoachMessage, updateCoachMessage, cancelStream, finishStream, t]);

  /** State-only lesson switch: isolates review vs draft boards; never auto-runs a task. */
  const applyLessonSwitch = useCallback((lessonMode: LessonMode) => {
    const switched = resolveLessonDraftSwitch({
      currentLesson: lesson,
      nextLesson: lessonMode,
      liveDraft: draft,
      snapshot: draftSnapshotRef.current,
    });
    draftSnapshotRef.current = switched.snapshot;
    if (switched.enteringReview || switched.leavingReview) {
      setDraft(switched.draft);
    }
    if (switched.leavingReview) {
      setContextRevision((n) => n + 1);
      pendingFollowUpContextRef.current = null;
      setUserInput('');
    }
    if (lessonMode !== 'review') {
      pendingFollowUpContextRef.current = null;
    }
    setLesson(switched.lesson);
    return switched;
  }, [lesson, draft]);

  const handleLessonAction = useCallback((lessonMode: LessonMode) => {
    const switched = applyLessonSwitch(lessonMode);
    if (lessonMode === 'review') return;
    if (switched.leavingReview) {
      const analyzeOpts = { ignoreComposerInput: true, draftOverride: switched.draft };
      switch (lessonMode) {
        case 'bp': handleAnalyze(analyzeOpts); break;
        case 'match': handlePlaybook({ draftOverride: switched.draft }); break;
        case 'items':
        case 'mind': handleAnalyze(analyzeOpts); break;
      }
      return;
    }
    switch (lessonMode) {
      case 'bp': handleAnalyze(); break;
      case 'match': handlePlaybook(); break;
      case 'items':
      case 'mind': handleAnalyze(); break;
    }
  }, [applyLessonSwitch, handleAnalyze, handlePlaybook]);

  /** Accept onto request-time allySide + practiceHero when provided; never live editing state. */
  const handleAcceptSuggestion = useCallback((hero: Hero, allySide?: DraftSide, practiceHeroId?: number | null) => {
    const side = allySide ?? mySide;
    const boundPractice = practiceHeroId !== undefined
      ? (practiceHeroId == null ? null : allHeroes.find((h) => h.id === practiceHeroId) ?? null)
      : practiceHero;
    if (lesson === 'review') {
      // Review live draft is disposable; persist onto the intentional snapshot, then leave
      // review so restore surfaces the pick (avoids wipe on leave-review).
      const board = draftSnapshotRef.current;
      if ([...board.radiant, ...board.dire].find(h => h.id === hero.id)) return;
      if (board[side].length >= 5) return;
      draftSnapshotRef.current = acceptHeroOntoDraft(board, side, hero, boundPractice);
      applyLessonSwitch('bp');
      return;
    }
    const isPicked = [...draft.radiant, ...draft.dire].find(h => h.id === hero.id);
    if (isPicked) return;
    if (draft[side].length >= 5) return;
    // Materialize the request-time practice hero alongside the accepted pick when
    // the ally board is empty — resolveCoachingLineup only seeds it into an empty board.
    setDraft(prev => acceptHeroOntoDraft(prev, side, hero, boundPractice));
    setContextRevision((n) => n + 1);
  }, [lesson, draft, mySide, practiceHero, allHeroes, applyLessonSwitch]);

  const handleReview = useCallback((matchId: number, heroId?: number, followUp?: string) => {
    if (!followUp) {
      pendingFollowUpContextRef.current = null;
      setUserInput('');
    }
    cancelStream();
    setIsLoading(true);
    const streamGen = claimCoachInflightGeneration(inflightTaskRef);
    applyLessonSwitch('review');
    activeReviewRef.current = { matchId, heroId };
    const hero = heroId ? allHeroes.find((h) => h.id === heroId) : practiceHero;
    const heroName = hero ? heroDisplayName(hero, lang) : null;
    const userMsg = followUp
      ? followUp
      : (lang === 'zh'
        ? `复盘比赛 ${matchId}${heroName ? ` · ${heroName}` : ''}`
        : `Review match ${matchId}${heroName ? ` · ${heroName}` : ''}`);
    addCoachMessage({ type: 'user', action: 'review', lesson: 'review', content: userMsg });
    if (followUp) setUserInput('');
    const msgId = addCoachMessage({
      type: 'coach', action: 'review', lesson: 'review', content: '', isStreaming: true,
      ...(followUp ? { reviewFollowUp: true } : {}),
    });
    streamControllerRef.current = fetchMatchReviewStream(
      matchId, lang, heroId ?? practiceHero?.id, followUp,
      {
        onData: (matchFact) => {
          if (!isCoachInflightCurrent(inflightTaskRef, streamGen)) return;
          updateCoachMessage(msgId, { matchFact });
        },
        onReviewCards: (reviewCards) => {
          if (!isCoachInflightCurrent(inflightTaskRef, streamGen)) return;
          updateCoachMessage(msgId, { reviewCards });
        },
        onReviewNotice: (notice) => {
          if (!isCoachInflightCurrent(inflightTaskRef, streamGen)) return;
          updateCoachMessage(msgId, { error: notice });
        },
        onChunk: (text) => {
          if (!isCoachInflightCurrent(inflightTaskRef, streamGen)) return;
          setMessages(prev => appendStreamChunk(prev, msgId, text));
        },
        onComplete: (grounded) => {
          if (!isCoachInflightCurrent(inflightTaskRef, streamGen)) return;
          updateCoachMessage(msgId, { isStreaming: false, grounded });
          finishStream(streamGen);
        },
        onError: (error) => {
          if (!isCoachInflightCurrent(inflightTaskRef, streamGen)) return;
          setMessages((prev) => prev.map((msg) => (
            msg.id === msgId ? finalizeReviewCoachMessage(msg, { error }) : msg
          )));
          finishStream(streamGen);
        },
      }
    );
  }, [allHeroes, practiceHero, lang, addCoachMessage, updateCoachMessage, cancelStream, finishStream, applyLessonSwitch]);

  const sessions = useMemo(() => pairCoachSessions(messages, lang), [messages, lang]);
  const activeReviewSession = useMemo(() => findPrimaryReviewSession(sessions), [sessions]);
  const inflightSession = useMemo(() => findInflightCoachSession(sessions), [sessions]);
  const composerBusy = Boolean(inflightSession) || isLoading;

  useEffect(() => {
    const inflightId = inflightSession?.id ?? null;
    if (prevInflightSessionIdRef.current && !inflightId) {
      setIsLoading(false);
    }
    prevInflightSessionIdRef.current = inflightId;
  }, [inflightSession]);
  const composerState = useMemo(
    () => resolveCoachComposerState({
      lesson,
      sessions,
      isLoading,
      inflightSession,
      activeReviewSession,
    }),
    [lesson, sessions, isLoading, inflightSession, activeReviewSession],
  );
  const surfaceFollowUpAllowed = composerState.reviewFollowUpSubmittable && !isLoading;

  useEffect(() => {
    const ctx = primaryReviewFollowUpContext(activeReviewSession);
    if (ctx) activeReviewRef.current = ctx;
  }, [activeReviewSession]);

  const handleReviewFollowUp = useCallback((
    question: string,
    context?: ReviewFollowUpContext,
  ) => {
    if (isLoading) return;
    const displayedCtx = primaryReviewFollowUpContext(activeReviewSession);
    const ctx = context ?? pendingFollowUpContextRef.current ?? displayedCtx;
    if (!ctx || !canSubmitReviewFollowUpForContext(sessions, ctx)) return;
    pendingFollowUpContextRef.current = null;
    handleReview(ctx.matchId, ctx.heroId, question);
  }, [handleReview, isLoading, activeReviewSession, sessions]);

  const handleComposeFollowUp = useCallback((text: string, context: ReviewFollowUpContext) => {
    pendingFollowUpContextRef.current = context;
    applyLessonSwitch('review');
    setUserInput(text);
    setComposerFocusToken((t) => t + 1);
  }, [applyLessonSwitch]);

  const handleSuggest = useCallback(async () => {
    if (coaching.allies.length >= 5) {
      addCoachMessage({ type: 'coach', content: lang === 'zh' ? '阵容已满' : 'Lineup is full' });
      return;
    }
    // Bind the session to ally + practice hero at request time — accept must
    // use these even if the user flips My side / practice hero before tapping.
    const requestSide = mySide;
    const requestRevision = contextRevision;
    const requestPracticeHeroId = practiceHero?.id ?? null;
    cancelStream();
    setIsLoading(true);
    const taskId = claimCoachInflightGeneration(inflightTaskRef);
    const practiceName = practiceHero ? heroDisplayName(practiceHero, lang) : null;
    const suggestMsg = practiceName
      ? (lang === 'zh' ? `围绕${practiceName}，推荐下一手选什么？` : `Around ${practiceName}, what should we pick next?`)
      : (lang === 'zh' ? '推荐下一手选什么？' : 'What should we pick next?');
    addCoachMessage({ type: 'user', action: 'suggest', lesson: 'bp', content: suggestMsg, allySide: requestSide, practiceHeroId: requestPracticeHeroId, contextRevision: requestRevision });
    try {
      const suggestions = await awaitWithTimeout(
        fetchSuggestions(coaching.allies, coaching.enemies, requestSide, undefined, lang),
        SUGGEST_FETCH_TIMEOUT_MS,
      );
      if (inflightTaskRef.current !== taskId) return;
      addCoachMessage({
        type: 'coach', action: 'suggest', lesson: 'bp',
        content: suggestions.length > 0
          ? (lang === 'zh' ? '根据对位数据，推荐以下英雄：' : 'Based on matchup data, I recommend:')
          : (lang === 'zh' ? '暂无推荐，请先选择敌方英雄' : 'No recommendations yet, select enemy heroes first'),
        suggestions, grounded: true,
        allySide: requestSide,
        practiceHeroId: requestPracticeHeroId,
        contextRevision: requestRevision,
      });
    } catch (error) {
      if (inflightTaskRef.current !== taskId) return;
      const message = error instanceof Error && error.message === 'timeout'
        ? coachFetchTimeoutMessage(lang)
        : String(error);
      addCoachMessage({ type: 'coach', content: `Error: ${message}` });
    } finally {
      if (inflightTaskRef.current === taskId) {
        setIsLoading(false);
      }
    }
  }, [coaching, practiceHero, mySide, contextRevision, lang, addCoachMessage, cancelStream]);

  const handleMeta = useCallback(async () => {
    cancelStream();
    setIsLoading(true);
    const taskId = claimCoachInflightGeneration(inflightTaskRef);
    addCoachMessage({ type: 'user', action: 'meta', content: lang === 'zh' ? '当前版本哪些英雄强势？' : 'Which heroes are strong this patch?' });
    const msgId = addCoachMessage({ type: 'coach', action: 'meta', content: '', isStreaming: true, allySide: mySide, contextRevision });
    try {
      const data = await awaitWithTimeout(fetchTierList(lang, undefined, 12), META_FETCH_TIMEOUT_MS);
      if (inflightTaskRef.current !== taskId) return;
      updateCoachMessage(msgId, {
        content: lang === 'zh' ? '当前版本强势英雄榜：' : 'Current meta tier list:',
        tierHeroes: data.heroes,
        grounded: true,
        isStreaming: false,
      });
    } catch (error) {
      if (inflightTaskRef.current !== taskId) return;
      const message = error instanceof Error && error.message === 'timeout'
        ? coachFetchTimeoutMessage(lang)
        : String(error);
      updateCoachMessage(msgId, { content: `Error: ${message}`, isStreaming: false });
    } finally {
      if (inflightTaskRef.current === taskId) {
        setIsLoading(false);
      }
    }
  }, [lang, mySide, contextRevision, addCoachMessage, updateCoachMessage, cancelStream]);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (!userInput.trim()) return;
    const pendingCtx = lesson === 'review' ? pendingFollowUpContextRef.current : null;
    const displayedCtx = primaryReviewFollowUpContext(activeReviewSession);
    const retainedRef = activeReviewRef.current;
    const hasRetainedMatchContext = Boolean(pendingCtx || displayedCtx || retainedRef);
    if (shouldSubmitReviewFollowUp(lesson, Boolean(pendingCtx), composerState, hasRetainedMatchContext)) {
      if (isLoading) return;
      // Ready follow-up: require AI-available gate.
      if (composerState.reviewFollowUpSubmittable) {
        const ctx = pendingCtx ?? displayedCtx;
        if (!ctx || !canSubmitReviewFollowUpForContext(sessions, ctx)) return;
        handleReviewFollowUp(userInput.trim());
        return;
      }
      // Incomplete / cancelled primary: restart/follow-up with retained match id.
      const matchId = pendingCtx?.matchId ?? displayedCtx?.matchId ?? retainedRef?.matchId;
      const heroId = pendingCtx?.heroId ?? displayedCtx?.heroId ?? retainedRef?.heroId;
      if (matchId == null) return;
      pendingFollowUpContextRef.current = null;
      handleReview(matchId, heroId, userInput.trim());
      return;
    }
    if (isLoading) return;
    handleAnalyze();
  }, [userInput, isLoading, lesson, composerState, activeReviewSession, sessions, handleAnalyze, handleReview, handleReviewFollowUp]);

  const resetAll = useCallback(() => {
    cancelStream();
    activeReviewRef.current = null;
    pendingFollowUpContextRef.current = null;
    setDraft(EMPTY_DRAFT);
    draftSnapshotRef.current = EMPTY_DRAFT;
    setMySide('radiant');
    mySideExplicitRef.current = false;
    setContextRevision((n) => n + 1);
    setMessages([]);
    setUserInput('');
    setDismissedSessionIds([]);
    setLastDismissedSessionId(null);
  }, [cancelStream]);

  const dismissSession = useCallback((sessionId: string) => {
    setDismissedSessionIds((prev) => (prev.includes(sessionId) ? prev : [...prev, sessionId]));
    setLastDismissedSessionId(sessionId);
  }, []);

  const undoDismissSession = useCallback(() => {
    if (!lastDismissedSessionId) return;
    setDismissedSessionIds((prev) => prev.filter((id) => id !== lastDismissedSessionId));
    setLastDismissedSessionId(null);
  }, [lastDismissedSessionId]);


  // Soft-switch from the shell (motive entries / workspace tabs). Generation stays explicit.
  // Guarded by nonce so a manual LessonRail switch inside CoachView is never overridden.
  const appliedLessonNonceRef = useRef(-1);
  useEffect(() => {
    if (!lessonRequest || appliedLessonNonceRef.current === lessonRequest.nonce) return;
    appliedLessonNonceRef.current = lessonRequest.nonce;
    applyLessonSwitch(lessonRequest.mode);
  }, [lessonRequest, applyLessonSwitch]);

  const dismissedSessionIdSet = useMemo(() => new Set(dismissedSessionIds), [dismissedSessionIds]);
  const hasResults = sessions.some((s) => !dismissedSessionIdSet.has(s.id));
  const mentorName = mentor
    ? (lang === 'zh' ? (mentor.nameZh || mentor.name) : mentor.name)
    : undefined;

  return (
    <div className="flex flex-col h-full min-h-0 bg-k3-base overflow-hidden" data-context-revision={contextRevision} data-my-side={mySide}>
      <div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar">
        <div className={`flex flex-col items-center justify-start px-3 sm:px-4 ${hasResults ? 'pt-2 sm:pt-3 pb-3' : 'pt-4 sm:pt-6 pb-6'}`}>
          <MentorStage
            lang={lang}
            mentor={mentor}
            practiceHero={practiceHero}
            density={hasResults ? 'compact' : 'hero'}
            onOpenPracticePicker={() => setShowMentorPicker(true)}
          />
          <HomeModules
            lang={lang}
            density="full"
            allHeroes={allHeroes}
            practiceHero={practiceHero}
            lesson={lesson}
            onLessonChange={handleLessonAction}
            draft={draft}
            selectionSide={selectionSide}
            mySide={mySide}
            onOpenPracticePicker={() => setShowMentorPicker(true)}
            onOpenDraftPicker={() => setShowHeroPicker(true)}
            onHeroDetail={setDetailHeroId}
            onMeta={handleMeta}
            onStartReview={handleReview}
            coachBusy={composerBusy}
            onAnalyze={() => handleAnalyze()}
            onPlaybook={handlePlaybook}
            onSuggest={handleSuggest}
            onCancelStream={cancelStream}
          />
          {lesson === 'review' && (
          <ReviewSurface
            sessions={sessions}
            dismissedSessionIds={dismissedSessionIdSet}
            lang={lang}
            onDismiss={dismissSession}
            onReviewFollowUp={handleReviewFollowUp}
            onComposeFollowUp={handleComposeFollowUp}
            followUpAllowed={surfaceFollowUpAllowed}
            scrollContainerRef={scrollContainerRef}
          />
          )}
          {sessions.length > 0 && (
            <div className="w-full max-w-3xl min-w-0 mt-3">
              <CoachCanvas
                sessions={sessions}
                dismissedSessionIds={dismissedSessionIdSet}
                lastDismissedSessionId={lastDismissedSessionId}
                lang={lang}
                allHeroes={allHeroes}
                onSelectHero={handleAcceptSuggestion}
                onInspectHero={setDetailHeroId}
                onDismissSession={dismissSession}
                onUndoDismiss={undoDismissSession}
                mentorName={mentorName}
                scrollContainerRef={scrollContainerRef}
                onReviewFollowUp={handleReviewFollowUp}
                canSubmitReviewFollowUpForContext={(ctx) => (
                  !isLoading && canSubmitReviewFollowUpForContext(sessions, ctx)
                )}
              />
            </div>
          )}
        </div>
      </div>

      <CoachComposer
        lang={lang}
        userInput={userInput}
        setUserInput={setUserInput}
        onSubmit={handleSubmit}
        isLoading={composerBusy}
        onCancel={cancelStream}
        mentorName={mentorName}
        allowInputWhileLoading={composerState.allowInputWhileLoading}
        disableInput={composerState.inputDisabled}
        submitDisabled={composerState.submitDisabled}
        focusToken={composerFocusToken}
      />

      <MentorPicker
        lang={lang}
        isOpen={showMentorPicker}
        onClose={() => setShowMentorPicker(false)}
        allHeroes={allHeroes}
        isLoading={isHeroesLoading}
        currentMentor={practiceHero}
        onSelectMentor={(hero) => {
          const nextId = hero.id;
          if (practiceHero?.id !== nextId) {
            cancelStream();
            setMessages((prev) => clearStaleSuggestionsForPracticeHero(prev, nextId));
            setContextRevision((n) => n + 1);
          }
          setPracticeHero(hero);
        }}
        onDismissMentor={() => {
          if (practiceHero != null) {
            cancelStream();
            setMessages((prev) => clearStaleSuggestionsForPracticeHero(prev, null));
            setContextRevision((n) => n + 1);
          }
          setPracticeHero(null);
        }}
      />

      <HeroPickerOverlay
        lang={lang}
        isOpen={showHeroPicker}
        onClose={() => setShowHeroPicker(false)}
        allHeroes={allHeroes}
        isLoading={isHeroesLoading}
        draft={draft}
        selectionSide={selectionSide}
        onSideChange={setSelectionSide}
        mySide={mySide}
        onMySideChange={(side) => {
          mySideExplicitRef.current = true;
          if (side !== mySide) {
            cancelStream();
            setMessages((prev) => clearStaleSuggestionMessages(prev, side));
          }
          setMySide(side);
          setContextRevision((n) => n + 1);
        }}
        onSelectHero={handleHeroSelect}
        onReset={resetAll}
      />

      {detailHeroId && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-0 sm:p-4">
          <div className="relative w-full h-full sm:h-auto sm:max-w-4xl sm:max-h-[90vh] min-h-0 bg-k3-surface sm:rounded-2xl border-0 sm:border sm:border-k3-border-subtle overflow-hidden flex flex-col pt-safe pb-safe px-safe">
            <button
              type="button"
              onClick={() => setDetailHeroId(null)}
              aria-label={lang === 'zh' ? '关闭' : 'Close'}
              className="absolute top-safe-offset right-safe-offset z-10 p-2 bg-k3-elevated hover:bg-k3-border-subtle rounded-lg transition-colors min-w-[40px] min-h-[40px] flex items-center justify-center touch-manipulation"
            >
              <X size={20} className="text-k3-text-secondary" />
            </button>
            <div className="p-3 sm:p-6 overflow-y-auto min-h-0 flex-1">
              <HeroDetail heroId={detailHeroId} lang={lang} onClose={() => setDetailHeroId(null)} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CoachView;
