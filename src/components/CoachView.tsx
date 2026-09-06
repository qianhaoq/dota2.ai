import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Hero, DraftState, Language } from '../types';
import HeroDetail from './HeroDetail';
import ProMatchStrip from './ProMatchStrip';
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
  DraftStrip, 
  HeroPickerOverlay, 
  ChatMessage, 
  IntentChips, 
  WelcomeState 
} from './coach';

interface CoachViewProps {
  lang: Language;
}

interface CoachMessage {
  id: string;
  type: 'user' | 'coach';
  action?: 'analyze' | 'playbook' | 'suggest' | 'meta';
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
  
  const [draft, setDraft] = useState<DraftState>({ radiant: [], dire: [] });
  const [selectionSide, setSelectionSide] = useState<'radiant' | 'dire'>('radiant');
  
  const [messages, setMessages] = useState<CoachMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [userInput, setUserInput] = useState('');
  
  const streamControllerRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  
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
    addCoachMessage({ type: 'user', action: 'analyze', content: userMsg });
    setUserInput('');

    const msgId = addCoachMessage({ 
      type: 'coach', 
      action: 'analyze',
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
  }, [draft, lang, userInput, addCoachMessage, updateCoachMessage, cancelStream, t]);

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
      content: lang === 'zh' ? '本局怎么打？' : 'How should we play this game?' 
    });

    const msgId = addCoachMessage({ 
      type: 'coach', 
      action: 'playbook',
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
      content: lang === 'zh' ? '推荐下一手选什么？' : 'What should we pick next?' 
    });

    try {
      const suggestions = await fetchSuggestions(allies, enemies, selectionSide, undefined, lang);
      addCoachMessage({ 
        type: 'coach', 
        action: 'suggest',
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
    <div className="flex flex-col h-[100dvh] bg-k3-base overflow-hidden">
      {/* Draft Strip - Fixed at top, ~64px */}
      <DraftStrip
        lang={lang}
        draft={draft}
        selectionSide={selectionSide}
        onSideChange={setSelectionSide}
        onOpenPicker={() => setShowHeroPicker(true)}
        onRemoveHero={removeHero}
        onHeroDetail={setDetailHeroId}
      />

      {/* Pro/Public Matches - Light ticker strip ~40px */}
      <div className="max-w-content mx-auto w-full px-6 pt-2">
        <ProMatchStrip lang={lang} />
      </div>

      {/* Main Chat Area - flex-1 overflow */}
      <div 
        ref={messagesContainerRef}
        className="flex-1 overflow-y-auto custom-scrollbar relative"
      >
        {messages.length === 0 ? (
          <WelcomeState 
            lang={lang} 
            hasHeroes={hasHeroes}
            onOpenPicker={() => setShowHeroPicker(true)}
          />
        ) : (
          <div className="max-w-content mx-auto w-full px-6 py-4">
            {messages.map((msg) => (
              <ChatMessage
                key={msg.id}
                message={msg}
                lang={lang}
                allHeroes={allHeroes}
                onSelectHero={handleHeroSelect}
              />
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}

        {/* Jump to latest button - accent color */}
        {showJumpToLatest && (
          <button
            onClick={scrollToLatest}
            className="fixed bottom-36 left-1/2 -translate-x-1/2 px-4 py-2 bg-k3-accent hover:bg-k3-accent/90 text-k3-base text-xs font-semibold rounded-full shadow-lg transition-all z-10 flex items-center gap-1"
          >
            <ChevronDown size={14} />
            {t.jumpToLatest}
          </button>
        )}
      </div>

      {/* Composer Area - Fixed height at bottom */}
      <div className="border-t border-k3-border-subtle bg-k3-surface">
        <div className="max-w-content mx-auto w-full px-6 py-4">
          {/* Intent Chips */}
          <div className="mb-3">
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
          </div>

          {/* Input Field - 24px radius, bg-input */}
          <form onSubmit={handleSubmit} className="flex gap-3">
            <input
              type="text"
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              placeholder={t.inputPlaceholder}
              disabled={isLoading}
              className="flex-1 bg-k3-input border border-k3-border-subtle rounded-composer px-4 py-3 text-sm text-k3-text-primary focus:outline-none focus:border-k3-accent focus:ring-1 focus:ring-k3-accent/30 transition-all placeholder:text-k3-text-tertiary disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={isLoading || !userInput.trim()}
              className="w-[36px] h-[36px] my-auto flex items-center justify-center bg-k3-accent hover:bg-k3-accent/90 rounded-full transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Send size={16} className="text-k3-base" />
            </button>
          </form>
        </div>
      </div>

      {/* Hero Picker Overlay - Fixed fullscreen with dim backdrop */}
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
