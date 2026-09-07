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
import { buildPracticeUserContext, heroDisplayName, resolveCoachingLineup } from '../utils/practiceContext';
import { appendStreamChunk, generateMessageId } from '../utils/streamAccumulator';
import { pairCoachSessions } from '../utils/coachBlocks';
import { X } from 'lucide-react';
import {
  HeroPickerOverlay,
  MentorStage,
  MentorPicker,
  HomeModules,
  CoachCanvas,
  CoachComposer,
} from './coach';
import type { CoachMessage } from './coach/coachMessage';

interface CoachViewProps {
  lang: Language;
}

const CoachView: React.FC<CoachViewProps> = ({ lang }) => {
  const [allHeroes, setAllHeroes] = useState<Hero[]>([]);
  const [isHeroesLoading, setIsHeroesLoading] = useState(true);
  const [mentor, setMentor] = useState<Hero | null>(null);
  const [practiceHero, setPracticeHero] = useState<Hero | null>(null);
  const [lesson, setLesson] = useState<LessonMode>('mind');
  const [draft, setDraft] = useState<DraftState>({ radiant: [], dire: [] });
  const [selectionSide, setSelectionSide] = useState<'radiant' | 'dire'>('radiant');
  const [messages, setMessages] = useState<CoachMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [userInput, setUserInput] = useState('');
  const streamControllerRef = useRef<AbortController | null>(null);
  const activeReviewRef = useRef<{ matchId: number; heroId?: number } | null>(null);
  const [showMentorPicker, setShowMentorPicker] = useState(false);
  const [showHeroPicker, setShowHeroPicker] = useState(false);
  const [detailHeroId, setDetailHeroId] = useState<number | null>(null);

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
    if (selectionSide === 'radiant') {
      if (draft.radiant.length < 5) {
        setDraft(prev => ({ ...prev, radiant: [...prev.radiant, hero] }));
      }
    } else {
      if (draft.dire.length < 5) {
        setDraft(prev => ({ ...prev, dire: [...prev.dire, hero] }));
      }
    }
  }, [draft, selectionSide]);

  const addCoachMessage = useCallback((message: Omit<CoachMessage, 'id'>) => {
    const id = generateMessageId();
    setMessages(prev => [...prev, { ...message, id }]);
    return id;
  }, []);

  const updateCoachMessage = useCallback((id: string, updates: Partial<CoachMessage>) => {
    setMessages(prev => prev.map(msg => msg.id === id ? { ...msg, ...updates } : msg));
  }, []);

  const cancelStream = useCallback(() => {
    if (streamControllerRef.current) {
      streamControllerRef.current.abort();
      streamControllerRef.current = null;
      setIsLoading(false);
    }
  }, []);

  const coaching = useMemo(
    () => resolveCoachingLineup(draft, selectionSide, practiceHero),
    [draft, selectionSide, practiceHero]
  );

  const handleAnalyze = useCallback(() => {
    if (coaching.radiant.length === 0 && coaching.dire.length === 0) {
      addCoachMessage({ type: 'coach', content: t.needHeroes });
      return;
    }
    cancelStream();
    setIsLoading(true);
    const practiceName = practiceHero ? heroDisplayName(practiceHero, lang) : null;
    const defaultMsg = practiceName
      ? (lang === 'zh' ? `分析练习英雄 ${practiceName}` : `Analyze practice hero ${practiceName}`)
      : (lang === 'zh' ? '分析当前阵容' : 'Analyze current lineup');
    const userMsg = userInput.trim() || defaultMsg;
    const userContext = buildPracticeUserContext(practiceHero, lang, userMsg);
    addCoachMessage({ type: 'user', action: 'analyze', lesson, content: userMsg });
    setUserInput('');
    const msgId = addCoachMessage({ type: 'coach', action: 'analyze', lesson, content: '', isStreaming: true });
    streamControllerRef.current = analyzeDraftStream(
      coaching.radiant, coaching.dire, lang, userContext,
      {
        onChunk: (text) => {
          setMessages(prev => appendStreamChunk(prev, msgId, text));
        },
        onMatchupData: (data) => { updateCoachMessage(msgId, { matchupData: data }); },
        onComplete: (grounded) => {
          updateCoachMessage(msgId, { isStreaming: false, grounded });
          setIsLoading(false);
          streamControllerRef.current = null;
        },
        onError: (error) => {
          updateCoachMessage(msgId, { content: `Error: ${error}`, isStreaming: false });
          setIsLoading(false);
          streamControllerRef.current = null;
        }
      }
    );
  }, [coaching, practiceHero, lang, userInput, lesson, addCoachMessage, updateCoachMessage, cancelStream, t]);

  const handlePlaybook = useCallback(() => {
    if (coaching.allies.length === 0) {
      addCoachMessage({ type: 'coach', content: t.needAllies });
      return;
    }
    cancelStream();
    setIsLoading(true);
    const practiceName = practiceHero ? heroDisplayName(practiceHero, lang) : null;
    const playbookMsg = practiceName
      ? (lang === 'zh' ? `本局怎么打${practiceName}？` : `How should we play ${practiceName} this game?`)
      : (lang === 'zh' ? '本局怎么打？' : 'How should we play this game?');
    addCoachMessage({ type: 'user', action: 'playbook', lesson: 'match', content: playbookMsg });
    const msgId = addCoachMessage({ type: 'coach', action: 'playbook', lesson: 'match', content: '', isStreaming: true, playbookData: [] });
    streamControllerRef.current = fetchPlaybookStream(
      coaching.allies, coaching.enemies, selectionSide, lang, coaching.focusHeroId,
      {
        onData: (data) => { updateCoachMessage(msgId, { playbookData: data }); },
        onChunk: (text) => {
          setMessages(prev => appendStreamChunk(prev, msgId, text));
        },
        onComplete: () => {
          updateCoachMessage(msgId, { isStreaming: false, grounded: true });
          setIsLoading(false);
          streamControllerRef.current = null;
        },
        onError: (error) => {
          updateCoachMessage(msgId, { content: `Error: ${error}`, isStreaming: false });
          setIsLoading(false);
          streamControllerRef.current = null;
        }
      }
    );
  }, [coaching, practiceHero, selectionSide, lang, addCoachMessage, updateCoachMessage, cancelStream, t]);

  const handleReview = useCallback((matchId: number, heroId?: number, followUp?: string) => {
    cancelStream();
    setIsLoading(true);
    setLesson('review');
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
    });
    streamControllerRef.current = fetchMatchReviewStream(
      matchId, lang, heroId ?? practiceHero?.id, followUp,
      {
        onData: (matchFact) => { updateCoachMessage(msgId, { matchFact }); },
        onChunk: (text) => {
          setMessages(prev => appendStreamChunk(prev, msgId, text));
        },
        onComplete: (grounded) => {
          updateCoachMessage(msgId, { isStreaming: false, grounded });
          setIsLoading(false);
          streamControllerRef.current = null;
        },
        onError: (error) => {
          updateCoachMessage(msgId, { error, isStreaming: false });
          setIsLoading(false);
          streamControllerRef.current = null;
        },
      }
    );
  }, [allHeroes, practiceHero, lang, addCoachMessage, updateCoachMessage, cancelStream]);

  const handleReviewFollowUp = useCallback((question: string) => {
    const ctx = activeReviewRef.current;
    if (!ctx) return;
    handleReview(ctx.matchId, ctx.heroId, question);
  }, [handleReview]);

  const handleSuggest = useCallback(async () => {
    if (coaching.allies.length >= 5) {
      addCoachMessage({ type: 'coach', content: lang === 'zh' ? '阵容已满' : 'Lineup is full' });
      return;
    }
    setIsLoading(true);
    const practiceName = practiceHero ? heroDisplayName(practiceHero, lang) : null;
    const suggestMsg = practiceName
      ? (lang === 'zh' ? `围绕${practiceName}，推荐下一手选什么？` : `Around ${practiceName}, what should we pick next?`)
      : (lang === 'zh' ? '推荐下一手选什么？' : 'What should we pick next?');
    addCoachMessage({ type: 'user', action: 'suggest', lesson: 'bp', content: suggestMsg });
    try {
      const suggestions = await fetchSuggestions(coaching.allies, coaching.enemies, selectionSide, undefined, lang);
      addCoachMessage({
        type: 'coach', action: 'suggest', lesson: 'bp',
        content: suggestions.length > 0
          ? (lang === 'zh' ? '根据对位数据，推荐以下英雄：' : 'Based on matchup data, I recommend:')
          : (lang === 'zh' ? '暂无推荐，请先选择敌方英雄' : 'No recommendations yet, select enemy heroes first'),
        suggestions, grounded: true
      });
    } catch (error) {
      addCoachMessage({ type: 'coach', content: `Error: ${error}` });
    }
    setIsLoading(false);
  }, [coaching, practiceHero, selectionSide, lang, addCoachMessage]);

  const handleMeta = useCallback(async () => {
    setIsLoading(true);
    addCoachMessage({ type: 'user', action: 'meta', content: lang === 'zh' ? '当前版本哪些英雄强势？' : 'Which heroes are strong this patch?' });
    try {
      const data = await fetchTierList(lang, undefined, 12);
      addCoachMessage({ type: 'coach', action: 'meta', content: lang === 'zh' ? '当前版本强势英雄榜：' : 'Current meta tier list:', tierHeroes: data.heroes, grounded: true });
    } catch (error) {
      addCoachMessage({ type: 'coach', content: `Error: ${error}` });
    }
    setIsLoading(false);
  }, [lang, addCoachMessage]);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (!userInput.trim() || isLoading) return;
    if (lesson === 'review' && activeReviewRef.current) {
      handleReviewFollowUp(userInput.trim());
      return;
    }
    handleAnalyze();
  }, [userInput, isLoading, lesson, handleAnalyze, handleReviewFollowUp]);

  const resetAll = useCallback(() => {
    cancelStream();
    activeReviewRef.current = null;
    setDraft({ radiant: [], dire: [] });
    setMessages([]);
    setUserInput('');
  }, [cancelStream]);

  const handleLessonAction = useCallback((lessonMode: LessonMode) => {
    setLesson(lessonMode);
    if (lessonMode === 'review') return;
    switch (lessonMode) {
      case 'bp': handleAnalyze(); break;
      case 'match': handlePlaybook(); break;
      case 'items':
      case 'mind': handleAnalyze(); break;
    }
  }, [handleAnalyze, handlePlaybook]);

  const sessions = useMemo(() => pairCoachSessions(messages, lang), [messages, lang]);
  const hasResults = sessions.length > 0;
  const mentorName = mentor
    ? (lang === 'zh' ? (mentor.nameZh || mentor.name) : mentor.name)
    : undefined;

  return (
    <div className="flex flex-col h-full min-h-0 bg-k3-base overflow-hidden">
      {hasResults && (
        <div className="flex-shrink-0 border-b border-k3-border-subtle bg-k3-base min-w-0 overflow-x-hidden">
          <MentorStage
            lang={lang}
            mentor={mentor}
            practiceHero={practiceHero}
            density="compact"
            onOpenPracticePicker={() => setShowMentorPicker(true)}
          />
          <HomeModules
            lang={lang}
            density="compact"
            allHeroes={allHeroes}
            practiceHero={practiceHero}
            lesson={lesson}
            onLessonChange={handleLessonAction}
            draft={draft}
            selectionSide={selectionSide}
            onOpenPracticePicker={() => setShowMentorPicker(true)}
            onOpenDraftPicker={() => setShowHeroPicker(true)}
            onHeroDetail={setDetailHeroId}
            isLoading={isLoading}
            onMeta={handleMeta}
            onStartReview={handleReview}
          />
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar">
        {!hasResults ? (
          <div className="min-h-full flex flex-col items-center justify-start px-3 sm:px-4 pt-4 sm:pt-6 pb-3">
            <MentorStage
              lang={lang}
              mentor={mentor}
              practiceHero={practiceHero}
              density="hero"
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
              onOpenPracticePicker={() => setShowMentorPicker(true)}
              onOpenDraftPicker={() => setShowHeroPicker(true)}
              onHeroDetail={setDetailHeroId}
              isLoading={isLoading}
              onMeta={handleMeta}
              onStartReview={handleReview}
            />
          </div>
        ) : (
          <CoachCanvas
            sessions={sessions}
            lang={lang}
            allHeroes={allHeroes}
            onSelectHero={handleHeroSelect}
            mentorName={mentorName}
          />
        )}
      </div>

      <CoachComposer
        lang={lang}
        userInput={userInput}
        setUserInput={setUserInput}
        onSubmit={handleSubmit}
        isLoading={isLoading}
        onCancel={cancelStream}
        mentorName={mentorName}
      />

      <MentorPicker
        lang={lang}
        isOpen={showMentorPicker}
        onClose={() => setShowMentorPicker(false)}
        allHeroes={allHeroes}
        isLoading={isHeroesLoading}
        currentMentor={practiceHero}
        onSelectMentor={(hero) => { cancelStream(); setPracticeHero(hero); }}
        onDismissMentor={() => { setPracticeHero(null); }}
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
