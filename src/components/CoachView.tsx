import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Hero, DraftState, Language } from '../types';
import HeroDetail from './HeroDetail';
import { 
  analyzeDraftStream, 
  fetchSuggestions, 
  fetchTierList,
  fetchPlaybookStream,
  HeroSuggestion, 
  MatchupData,
  TierHero,
  PlaybookHero
} from '../services/geminiService';
import { fetchHeroes } from '../services/dotaApiService';
import { Send, X, ChevronDown } from 'lucide-react';
import { 
  DraftContextChip,
  HeroPickerOverlay, 
  ChatMessage, 
  IntentChips, 
  MentorStage,
  MentorPicker,
  LessonRail,
} from './coach';
import type { LessonMode } from './coach';

interface CoachViewProps {
  lang: Language;
}

interface CoachMessage {
  id: string;
  type: 'user' | 'coach';
  action?: 'analyze' | 'playbook' | 'suggest' | 'meta';
  lesson?: LessonMode;
  content: string;
  isStreaming?: boolean;
  grounded?: boolean;
  matchupData?: MatchupData | null;
  playbookData?: PlaybookHero[];
  suggestions?: HeroSuggestion[];
  tierHeroes?: TierHero[];
}

const CoachView: React.FC<CoachViewProps> = ({ lang }) => {
  const [allHeroes, setAllHeroes] = useState<Hero[]>([]);
  const [isHeroesLoading, setIsHeroesLoading] = useState(true);
  
  const [mentor, setMentor] = useState<Hero | null>(null);
  const [lesson, setLesson] = useState<LessonMode>('mind');
  
  const [draft, setDraft] = useState<DraftState>({ radiant: [], dire: [] });
  const [selectionSide, setSelectionSide] = useState<'radiant' | 'dire'>('radiant');
  
  const [messages, setMessages] = useState<CoachMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [userInput, setUserInput] = useState('');
  
  const streamControllerRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  
  const [showMentorPicker, setShowMentorPicker] = useState(false);
  const [showHeroPicker, setShowHeroPicker] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [detailHeroId, setDetailHeroId] = useState<number | null>(null);

  useEffect(() => {
    const loadData = async () => {
      setIsHeroesLoading(true);
      const data = await fetchHeroes(lang);
      setAllHeroes(data);
      setIsHeroesLoading(false);
    };
    loadData();
  }, [lang]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;
      setShowJumpToLatest(!isNearBottom && messages.length > 0);
    };

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [messages.length]);

  const t = useMemo(() => ({
    inputPlaceholder: lang === 'zh' 
      ? '输入问题，或点击上方快捷按钮...' 
      : 'Ask a question, or use the quick actions above...',
    thinking: lang === 'zh' ? '思考中...' : 'Thinking...',
    needHeroes: lang === 'zh' ? '请先选择英雄' : 'Please select heroes first',
    needAllies: lang === 'zh' ? '请先选择己方英雄' : 'Please select your heroes first',
    jumpToLatest: lang === 'zh' ? '跳到最新' : 'Jump to latest',
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

  const removeHero = useCallback((side: 'radiant' | 'dire', index: number) => {
    setDraft(prev => {
      const newList = [...prev[side]];
      newList.splice(index, 1);
      return { ...prev, [side]: newList };
    });
  }, []);

  const addCoachMessage = useCallback((message: Omit<CoachMessage, 'id'>) => {
    const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    setMessages(prev => [...prev, { ...message, id }]);
    return id;
  }, []);

  const updateCoachMessage = useCallback((id: string, updates: Partial<CoachMessage>) => {
    setMessages(prev => prev.map(msg => 
      msg.id === id ? { ...msg, ...updates } : msg
    ));
  }, []);

  const cancelStream = useCallback(() => {
    if (streamControllerRef.current) {
      streamControllerRef.current.abort();
      streamControllerRef.current = null;
      setIsLoading(false);
    }
  }, []);

  const handleAnalyze = useCallback(() => {
    if (draft.radiant.length === 0 && draft.dire.length === 0) {
      addCoachMessage({ type: 'coach', content: t.needHeroes });
      return;
    }

    cancelStream();
    setIsLoading(true);

    const userMsg = userInput.trim() || (lang === 'zh' ? '分析当前阵容' : 'Analyze current lineup');
    addCoachMessage({ type: 'user', action: 'analyze', lesson, content: userMsg });
    setUserInput('');

    const msgId = addCoachMessage({ 
      type: 'coach', 
      action: 'analyze',
      lesson,
      content: '', 
      isStreaming: true 
    });

    streamControllerRef.current = analyzeDraftStream(
      draft.radiant,
      draft.dire,
      lang,
      userMsg,
      {
        onChunk: (text) => {
          setMessages(prev => prev.map(msg => 
            msg.id === msgId ? { ...msg, content: msg.content + text } : msg
          ));
        },
        onMatchupData: (data) => {
          updateCoachMessage(msgId, { matchupData: data });
        },
        onComplete: (grounded) => {
          updateCoachMessage(msgId, { isStreaming: false, grounded });
          setIsLoading(false);
          streamControllerRef.current = null;
        },
        onError: (error) => {
          updateCoachMessage(msgId, { 
            content: `Error: ${error}`, 
            isStreaming: false 
          });
          setIsLoading(false);
          streamControllerRef.current = null;
        }
      }
    );
  }, [draft, lang, userInput, lesson, addCoachMessage, updateCoachMessage, cancelStream, t]);

  const handlePlaybook = useCallback(() => {
    const allies = selectionSide === 'radiant' ? draft.radiant : draft.dire;
    const enemies = selectionSide === 'radiant' ? draft.dire : draft.radiant;
    
    if (allies.length === 0) {
      addCoachMessage({ type: 'coach', content: t.needAllies });
      return;
    }

    cancelStream();
    setIsLoading(true);

    addCoachMessage({ 
      type: 'user', 
      action: 'playbook',
      lesson: 'match',
      content: lang === 'zh' ? '本局怎么打？' : 'How should we play this game?' 
    });

    const msgId = addCoachMessage({ 
      type: 'coach', 
      action: 'playbook',
      lesson: 'match',
      content: '', 
      isStreaming: true,
      playbookData: []
    });

    streamControllerRef.current = fetchPlaybookStream(
      allies,
      enemies,
      selectionSide,
      lang,
      undefined,
      {
        onData: (data) => {
          updateCoachMessage(msgId, { playbookData: data });
        },
        onChunk: (text) => {
          setMessages(prev => prev.map(msg => 
            msg.id === msgId ? { ...msg, content: msg.content + text } : msg
          ));
        },
        onComplete: () => {
          updateCoachMessage(msgId, { isStreaming: false, grounded: true });
          setIsLoading(false);
          streamControllerRef.current = null;
        },
        onError: (error) => {
          updateCoachMessage(msgId, { 
            content: `Error: ${error}`, 
            isStreaming: false 
          });
          setIsLoading(false);
          streamControllerRef.current = null;
        }
      }
    );
  }, [draft, selectionSide, lang, addCoachMessage, updateCoachMessage, cancelStream, t]);

  const handleSuggest = useCallback(async () => {
    const allies = selectionSide === 'radiant' ? draft.radiant : draft.dire;
    const enemies = selectionSide === 'radiant' ? draft.dire : draft.radiant;
    
    if (allies.length >= 5) {
      addCoachMessage({ type: 'coach', content: lang === 'zh' ? '阵容已满' : 'Lineup is full' });
      return;
    }

    setIsLoading(true);
    addCoachMessage({ 
      type: 'user', 
      action: 'suggest',
      lesson: 'bp',
      content: lang === 'zh' ? '推荐下一手选什么？' : 'What should we pick next?' 
    });

    try {
      const suggestions = await fetchSuggestions(allies, enemies, selectionSide, undefined, lang);
      addCoachMessage({ 
        type: 'coach', 
        action: 'suggest',
        lesson: 'bp',
        content: suggestions.length > 0 
          ? (lang === 'zh' ? '根据对位数据，推荐以下英雄：' : 'Based on matchup data, I recommend:')
          : (lang === 'zh' ? '暂无推荐，请先选择敌方英雄' : 'No recommendations yet, select enemy heroes first'),
        suggestions,
        grounded: true
      });
    } catch (error) {
      addCoachMessage({ type: 'coach', content: `Error: ${error}` });
    }
    setIsLoading(false);
  }, [draft, selectionSide, lang, addCoachMessage]);

  const handleMeta = useCallback(async () => {
    setIsLoading(true);
    addCoachMessage({ 
      type: 'user', 
      action: 'meta',
      content: lang === 'zh' ? '当前版本哪些英雄强势？' : 'Which heroes are strong this patch?' 
    });

    try {
      const data = await fetchTierList(lang, undefined, 12);
      addCoachMessage({ 
        type: 'coach', 
        action: 'meta',
        content: lang === 'zh' ? '当前版本强势英雄榜：' : 'Current meta tier list:',
        tierHeroes: data.heroes,
        grounded: true
      });
    } catch (error) {
      addCoachMessage({ type: 'coach', content: `Error: ${error}` });
    }
    setIsLoading(false);
  }, [lang, addCoachMessage]);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (!userInput.trim() || isLoading) return;
    handleAnalyze();
  }, [userInput, isLoading, handleAnalyze]);

  const resetAll = useCallback(() => {
    cancelStream();
    setDraft({ radiant: [], dire: [] });
    setMessages([]);
    setUserInput('');
  }, [cancelStream]);

  const scrollToLatest = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const hasHeroes = draft.radiant.length > 0 || draft.dire.length > 0;
  const hasAllies = selectionSide === 'radiant' ? draft.radiant.length > 0 : draft.dire.length > 0;
  const alliesFull = selectionSide === 'radiant' ? draft.radiant.length >= 5 : draft.dire.length >= 5;

  return (
    <div className="flex flex-col h-full min-h-0 bg-k3-base overflow-hidden">
      {/* Main Chat Area - flex-1 overflow */}
      <div 
        ref={messagesContainerRef}
        className="flex-1 overflow-y-auto custom-scrollbar relative"
      >
        {messages.length === 0 ? (
          <MentorStage
            lang={lang}
            mentor={mentor}
            lesson={lesson}
            onLessonChange={setLesson}
            draft={draft}
            selectionSide={selectionSide}
            onOpenMentorPicker={() => setShowMentorPicker(true)}
            onOpenDraftPicker={() => setShowHeroPicker(true)}
            onHeroDetail={setDetailHeroId}
            isLoading={isLoading}
            onAnalyze={handleAnalyze}
            onPlaybook={handlePlaybook}
            onSuggest={handleSuggest}
            onMeta={handleMeta}
            onCancel={cancelStream}
            userInput={userInput}
            setUserInput={setUserInput}
            onSubmit={handleSubmit}
          />
        ) : (
          <div className="max-w-3xl mx-auto w-full px-6 py-4">
            {/* Mentor Context Bar - pinned at top of conversation */}
            {mentor && (
              <div className="flex items-center justify-between py-3 mb-4 border-b border-k3-border-subtle sticky top-0 bg-k3-base z-10">
                <div className="flex items-center gap-3">
                  <img 
                    src={mentor.icon || mentor.img} 
                    alt={mentor.name}
                    className="w-8 h-8 rounded-lg object-cover"
                  />
                  <span className="text-sm text-k3-text-primary font-medium">
                    {lang === 'zh' ? (mentor.nameZh || mentor.name) : mentor.name}
                  </span>
                  <span className="text-xs text-k3-text-tertiary">·</span>
                  <LessonRail
                    lang={lang}
                    currentLesson={lesson}
                    onLessonChange={setLesson}
                    isLoading={isLoading}
                    compact
                  />
                </div>
                <button
                  onClick={() => setShowMentorPicker(true)}
                  className="text-xs text-k3-text-tertiary hover:text-k3-text-secondary transition-colors"
                >
                  {lang === 'zh' ? '换导师' : 'Change mentor'}
                </button>
              </div>
            )}
            {messages.map((msg) => (
              <ChatMessage
                key={msg.id}
                message={msg}
                lang={lang}
                allHeroes={allHeroes}
                onSelectHero={handleHeroSelect}
                mentor={mentor}
              />
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}

        {/* Jump to latest button */}
        {showJumpToLatest && (
          <button
            onClick={scrollToLatest}
            className="fixed bottom-36 left-1/2 -translate-x-1/2 px-4 py-2 bg-k3-primary-bg hover:bg-k3-primary-bg/90 text-k3-primary-text text-xs font-medium rounded-lg shadow-lg transition-all z-10 flex items-center gap-1"
          >
            <ChevronDown size={14} />
            {t.jumpToLatest}
          </button>
        )}
      </div>

      {/* Composer Area - Fixed at bottom, always visible */}
      {messages.length > 0 && (
        <div className="border-t border-k3-border-subtle bg-k3-base">
          <div className="max-w-3xl mx-auto w-full px-6 py-3">
            {/* Draft Context Chip */}
            <div className="mb-2">
              <DraftContextChip
                lang={lang}
                draft={draft}
                selectionSide={selectionSide}
                onOpenPicker={() => setShowHeroPicker(true)}
                onHeroDetail={setDetailHeroId}
              />
            </div>

            {/* Lesson actions or streaming controls */}
            <div className="mb-3 flex items-center gap-3">
              {isLoading ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-k3-text-secondary">
                    {mentor 
                      ? (lang === 'zh' ? `${mentor.nameZh || mentor.name}在看数据` : `${mentor.name} is reading the numbers`)
                      : (lang === 'zh' ? '分析中...' : 'Analyzing...')}
                  </span>
                  <button
                    onClick={cancelStream}
                    className="px-3 py-1.5 text-sm bg-k3-primary-bg text-k3-primary-text rounded-lg hover:bg-white transition-colors"
                  >
                    {lang === 'zh' ? '停止' : 'Stop'}
                  </button>
                </div>
              ) : (
                <IntentChips
                  lang={lang}
                  isLoading={isLoading}
                  hasHeroes={hasHeroes}
                  hasAllies={hasAllies}
                  alliesFull={alliesFull}
                  selectionSide={selectionSide}
                  onAnalyze={handleAnalyze}
                  onPlaybook={handlePlaybook}
                  onSuggest={handleSuggest}
                  onMeta={handleMeta}
                  onCancel={cancelStream}
                />
              )}
            </div>

            {/* Input Field - Unified container with embedded send button */}
            <form onSubmit={handleSubmit}>
              <div className="relative flex items-center bg-k3-input border border-k3-border-subtle rounded-composer focus-within:border-k3-text-tertiary/50 transition-all">
                <input
                  type="text"
                  value={userInput}
                  onChange={(e) => setUserInput(e.target.value)}
                  placeholder={mentor 
                    ? (lang === 'zh' ? `问${mentor.nameZh || mentor.name}一个问题...` : `Ask ${mentor.name} a question...`)
                    : t.inputPlaceholder}
                  disabled={isLoading}
                  className="flex-1 bg-transparent px-4 py-3 pr-14 text-sm text-k3-text-primary focus:outline-none placeholder:text-k3-text-tertiary disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={isLoading || !userInput.trim()}
                  className={`absolute right-2 w-9 h-9 flex items-center justify-center rounded-full transition-all ${
                    userInput.trim() && !isLoading
                      ? 'bg-k3-primary-bg hover:bg-white text-k3-primary-text cursor-pointer'
                      : 'bg-k3-elevated text-k3-text-tertiary cursor-not-allowed'
                  }`}
                >
                  <Send size={16} />
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Mentor Picker Overlay - Single select mentor */}
      <MentorPicker
        lang={lang}
        isOpen={showMentorPicker}
        onClose={() => setShowMentorPicker(false)}
        allHeroes={allHeroes}
        isLoading={isHeroesLoading}
        currentMentor={mentor}
        onSelectMentor={(hero) => {
          setMentor(hero);
          setMessages([]);
        }}
        onDismissMentor={() => {
          setMentor(null);
          setMessages([]);
        }}
      />

      {/* Hero Picker Overlay - For draft context (radiant/dire) */}
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

      {/* Hero Detail Modal */}
      {detailHeroId && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="relative w-full max-w-4xl max-h-[90vh] bg-k3-surface rounded-2xl border border-k3-border-subtle overflow-hidden">
            <button
              onClick={() => setDetailHeroId(null)}
              className="absolute top-4 right-4 z-10 p-2 bg-k3-elevated hover:bg-k3-border-subtle rounded-lg transition-colors"
            >
              <X size={20} className="text-k3-text-secondary" />
            </button>
            <div className="p-4 sm:p-6 overflow-y-auto max-h-[90vh]">
              <HeroDetail heroId={detailHeroId} lang={lang} onClose={() => setDetailHeroId(null)} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CoachView;
