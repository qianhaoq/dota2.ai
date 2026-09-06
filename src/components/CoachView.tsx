import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Hero, DraftState, Attribute, Language } from '../types';
import HeroCard from './HeroCard';
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
import { 
  Swords, RotateCcw, Sparkles, Search, AlertTriangle, X, 
  ChevronDown, ChevronUp, MessageSquare, Zap, Target, 
  TrendingUp, BarChart3, Send, Plus, Minus
} from 'lucide-react';

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
  
  const [showHeroPicker, setShowHeroPicker] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [attrFilter, setAttrFilter] = useState<Attribute | 'All'>('All');

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

  const t = useMemo(() => ({
    radiant: lang === 'zh' ? '天辉' : 'Radiant',
    dire: lang === 'zh' ? '夜魇' : 'Dire',
    coach: lang === 'zh' ? 'AI 教练' : 'AI Coach',
    welcome: lang === 'zh' 
      ? '欢迎来到 AI 教练！选择双方英雄，然后点击下方按钮获取实时分析。' 
      : 'Welcome to AI Coach! Pick heroes for both teams, then click a button below.',
    welcomeHint: lang === 'zh'
      ? '💡 提示：点击顶部的 + 号添加英雄'
      : '💡 Tip: Click the + icons above to add heroes',
    analyzeAction: lang === 'zh' ? '分析阵容' : 'Analyze',
    playbookAction: lang === 'zh' ? '本局打法' : 'Playbook',
    suggestAction: lang === 'zh' ? '推荐下一手' : 'Next Pick',
    metaAction: lang === 'zh' ? '看看大盘' : 'Meta Tier',
    inputPlaceholder: lang === 'zh' 
      ? '输入战术问题或补充信息...' 
      : 'Ask a tactical question or add context...',
    pickHeroes: lang === 'zh' ? '选择英雄' : 'Pick Heroes',
    search: lang === 'zh' ? '搜索英雄...' : 'Search heroes...',
    reset: lang === 'zh' ? '重置' : 'Reset',
    cancel: lang === 'zh' ? '取消' : 'Cancel',
    thinking: lang === 'zh' ? '思考中...' : 'Thinking...',
    grounded: lang === 'zh' ? '基于 OpenDota 数据' : 'Grounded in OpenDota',
    ungrounded: lang === 'zh' ? '数据未验证' : 'Unverified',
    selectSide: lang === 'zh' ? '选择阵营' : 'Select side',
    noHeroesYet: lang === 'zh' ? '点击 + 添加英雄' : 'Click + to add heroes',
    winRate: lang === 'zh' ? '胜率' : 'WR',
    vs: lang === 'zh' ? '对' : 'vs',
    counters: lang === 'zh' ? '克制' : 'counters',
    items: lang === 'zh' ? '出装' : 'Items',
    start: lang === 'zh' ? '出门' : 'Start',
    early: lang === 'zh' ? '前期' : 'Early',
    mid: lang === 'zh' ? '中期' : 'Mid',
    late: lang === 'zh' ? '后期' : 'Late',
    tierS: lang === 'zh' ? 'S级强势' : 'S-Tier',
    tierA: lang === 'zh' ? 'A级推荐' : 'A-Tier',
    analyzing: lang === 'zh' ? '正在分析阵容...' : 'Analyzing lineup...',
    generatingPlaybook: lang === 'zh' ? '正在生成本局打法...' : 'Generating playbook...',
    fetchingSuggestions: lang === 'zh' ? '正在获取推荐英雄...' : 'Fetching hero suggestions...',
    fetchingMeta: lang === 'zh' ? '正在获取大盘数据...' : 'Fetching meta data...',
    needHeroes: lang === 'zh' ? '请先选择英雄' : 'Please select heroes first',
    needAllies: lang === 'zh' ? '请先选择己方英雄' : 'Please select your heroes first',
    suggestionsTitle: lang === 'zh' ? '推荐英雄' : 'Recommended Heroes',
    metaTitle: lang === 'zh' ? '当前版本强势英雄' : 'Current Meta Heroes',
    yourSide: lang === 'zh' ? '你的阵营' : 'Your side',
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

  const filteredHeroes = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    return allHeroes.filter(hero => {
      let matchesSearch = true;
      if (query) {
        const nameMatch = hero.name?.toLowerCase().includes(query);
        const nameZhMatch = hero.nameZh?.toLowerCase().includes(query);
        const nameEnMatch = hero.nameEn?.toLowerCase().includes(query);
        const aliasMatch = hero.aliases?.some(alias => alias.toLowerCase().includes(query));
        matchesSearch = nameMatch || nameZhMatch || nameEnMatch || aliasMatch || false;
      }
      const matchesAttr = attrFilter === 'All' || hero.attribute === attrFilter;
      return matchesSearch && matchesAttr;
    });
  }, [allHeroes, searchQuery, attrFilter]);

  const pickedIds = useMemo(() => 
    new Set([...draft.radiant.map(h => h.id), ...draft.dire.map(h => h.id)]),
    [draft]
  );

  const hasHeroes = draft.radiant.length > 0 || draft.dire.length > 0;

  const renderMarkdown = (text: string) => {
    return text.split('\n').map((line, idx) => {
      if (line.startsWith('## ')) {
        return <h3 key={idx} className="text-dota-gold font-bold text-base mt-3 mb-1.5 border-b border-dota-gold/20 pb-1">{line.replace('## ', '')}</h3>;
      }
      if (line.startsWith('### ')) {
        return <h4 key={idx} className="text-white font-semibold text-sm mt-2 mb-1">{line.replace('### ', '')}</h4>;
      }
      if (line.startsWith('**') && line.endsWith('**')) {
        return <strong key={idx} className="block mt-1.5 text-white text-sm">{line.replace(/\*\*/g, '')}</strong>;
      }
      if (line.startsWith('- ') || line.startsWith('* ')) {
        return <li key={idx} className="ml-4 list-disc marker:text-dota-gold pl-1 text-gray-300 text-sm">{line.replace(/^[-*] /, '')}</li>;
      }
      if (line.trim() === '') return <br key={idx} />;
      return <p key={idx} className="text-gray-300 text-sm">{line}</p>;
    });
  };

  return (
    <div className="flex flex-col h-full max-w-5xl mx-auto">
      {/* Compact Draft Context Bar */}
      <div className="glass-panel rounded-xl p-2 sm:p-3 mb-3 sm:mb-4 flex-shrink-0">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 sm:gap-4">
          {/* Radiant Side */}
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1.5 sm:mb-2">
              <button
                onClick={() => setSelectionSide('radiant')}
                className={`text-[10px] sm:text-xs font-display tracking-wider px-1.5 sm:px-2 py-0.5 rounded transition-colors ${
                  selectionSide === 'radiant' 
                    ? 'bg-dota-green text-white' 
                    : 'text-dota-green hover:bg-dota-green/20'
                }`}
              >
                {t.radiant}
              </button>
              <div className="flex-1 h-px bg-dota-green/30" />
            </div>
            <div className="flex gap-1 sm:gap-1.5 justify-center sm:justify-start">
              {Array.from({ length: 5 }).map((_, i) => (
                <div 
                  key={`rad-${i}`} 
                  className="w-8 h-11 sm:w-10 sm:h-14 bg-black/40 rounded border border-dashed border-gray-600 flex items-center justify-center relative group cursor-pointer"
                  onClick={() => {
                    if (!draft.radiant[i]) {
                      setSelectionSide('radiant');
                      setShowHeroPicker(true);
                    }
                  }}
                >
                  {draft.radiant[i] ? (
                    <>
                      <img 
                        src={draft.radiant[i].img} 
                        alt={draft.radiant[i].name}
                        className="w-full h-full object-cover rounded"
                      />
                      <button 
                        onClick={(e) => { e.stopPropagation(); removeHero('radiant', i); }}
                        className="absolute -top-1 -right-1 w-4 h-4 bg-red-600 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 sm:transition-opacity"
                      >
                        <Minus size={10} />
                      </button>
                    </>
                  ) : (
                    <Plus size={12} className="text-gray-600 group-hover:text-dota-green" />
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* VS Divider - Hidden on mobile, visible on sm+ */}
          <div className="hidden sm:flex flex-col items-center">
            <Swords size={20} className="text-dota-gold mb-1" />
            <span className="text-[10px] text-gray-500 font-display">VS</span>
          </div>

          {/* Mobile VS + Actions Row */}
          <div className="flex sm:hidden items-center justify-between py-1">
            <div className="flex items-center gap-1">
              <Swords size={16} className="text-dota-gold" />
              <span className="text-[10px] text-gray-500 font-display">VS</span>
            </div>
            <div className="flex gap-1">
              <button
                onClick={() => setShowHeroPicker(!showHeroPicker)}
                className="p-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors"
                title={t.pickHeroes}
              >
                {showHeroPicker ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
              <button
                onClick={resetAll}
                className="p-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400 transition-colors"
                title={t.reset}
              >
                <RotateCcw size={16} />
              </button>
            </div>
          </div>

          {/* Dire Side */}
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1.5 sm:mb-2">
              <div className="flex-1 h-px bg-dota-red/30" />
              <button
                onClick={() => setSelectionSide('dire')}
                className={`text-[10px] sm:text-xs font-display tracking-wider px-1.5 sm:px-2 py-0.5 rounded transition-colors ${
                  selectionSide === 'dire' 
                    ? 'bg-dota-red text-white' 
                    : 'text-dota-red hover:bg-dota-red/20'
                }`}
              >
                {t.dire}
              </button>
            </div>
            <div className="flex gap-1 sm:gap-1.5 justify-center sm:justify-end">
              {Array.from({ length: 5 }).map((_, i) => (
                <div 
                  key={`dire-${i}`} 
                  className="w-8 h-11 sm:w-10 sm:h-14 bg-black/40 rounded border border-dashed border-gray-600 flex items-center justify-center relative group cursor-pointer"
                  onClick={() => {
                    if (!draft.dire[i]) {
                      setSelectionSide('dire');
                      setShowHeroPicker(true);
                    }
                  }}
                >
                  {draft.dire[i] ? (
                    <>
                      <img 
                        src={draft.dire[i].img} 
                        alt={draft.dire[i].name}
                        className="w-full h-full object-cover rounded"
                      />
                      <button 
                        onClick={(e) => { e.stopPropagation(); removeHero('dire', i); }}
                        className="absolute -top-1 -right-1 w-4 h-4 bg-red-600 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 sm:transition-opacity"
                      >
                        <Minus size={10} />
                      </button>
                    </>
                  ) : (
                    <Plus size={12} className="text-gray-600 group-hover:text-dota-red" />
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Actions - Desktop only */}
          <div className="hidden sm:flex gap-1">
            <button
              onClick={() => setShowHeroPicker(!showHeroPicker)}
              className="p-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors"
              title={t.pickHeroes}
            >
              {showHeroPicker ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
            </button>
            <button
              onClick={resetAll}
              className="p-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400 transition-colors"
              title={t.reset}
            >
              <RotateCcw size={18} />
            </button>
          </div>
        </div>

        {/* Hero Picker Drawer */}
        {showHeroPicker && (
          <div className="mt-3 pt-3 border-t border-gray-700">
            <div className="flex gap-2 mb-3">
              <div className="relative flex-1">
                <Search className="absolute left-2 top-1.5 text-gray-500" size={14} />
                <input 
                  type="text" 
                  placeholder={t.search}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-gray-900 border border-gray-700 rounded pl-8 pr-2 py-1 text-xs text-white focus:outline-none focus:border-dota-gold"
                />
              </div>
              <div className="flex gap-1">
                {(['All', Attribute.STRENGTH, Attribute.AGILITY, Attribute.INTELLIGENCE, Attribute.UNIVERSAL] as const).map(attr => (
                  <button
                    key={attr}
                    onClick={() => setAttrFilter(attr)}
                    className={`px-2 py-1 rounded text-[10px] font-bold uppercase transition-colors ${
                      attrFilter === attr 
                        ? 'bg-gray-700 text-white' 
                        : 'bg-transparent text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    {attr === 'All' ? (lang === 'zh' ? '全' : 'ALL') : attr.substring(0,3)}
                  </button>
                ))}
              </div>
            </div>
            
            <div className="max-h-[180px] sm:max-h-[200px] overflow-y-auto custom-scrollbar">
              {isHeroesLoading ? (
                <div className="flex items-center justify-center py-8 text-gray-500 text-sm">
                  <div className="w-4 h-4 border-2 border-dota-gold border-t-transparent rounded-full animate-spin mr-2" />
                  Loading...
                </div>
              ) : (
                <div className="grid grid-cols-6 sm:grid-cols-8 md:grid-cols-10 lg:grid-cols-12 gap-1 sm:gap-1.5">
                  {filteredHeroes.map(hero => {
                    const isPicked = pickedIds.has(hero.id);
                    return (
                      <div 
                        key={hero.id} 
                        className={`cursor-pointer ${isPicked ? 'opacity-30 grayscale pointer-events-none' : ''}`}
                        onClick={() => handleHeroSelect(hero)}
                      >
                        <div className="w-full aspect-[3/4] relative group">
                          <img 
                            src={hero.img} 
                            alt={hero.name}
                            className="w-full h-full object-cover rounded border border-gray-700 group-hover:border-dota-gold transition-colors"
                          />
                          <div className="absolute bottom-0 left-0 right-0 bg-black/70 py-0.5 text-[7px] sm:text-[8px] text-center text-gray-300 truncate px-0.5">
                            {hero.name}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Coach Conversation Area - Main Hero */}
      <div className="glass-panel rounded-xl flex-1 flex flex-col overflow-hidden">
        {/* Coach Header */}
        <div className="px-4 py-3 border-b border-gray-700/50 flex items-center gap-2">
          <div className={`w-8 h-8 rounded-full bg-gradient-to-br from-dota-gold to-amber-700 flex items-center justify-center ${isLoading ? 'animate-pulse' : ''}`}>
            <MessageSquare size={16} className="text-black" />
          </div>
          <span className="font-display text-white tracking-wider">{t.coach}</span>
          {isLoading && (
            <span className="text-xs text-gray-400 ml-auto flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 bg-dota-gold rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 bg-dota-gold rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 bg-dota-gold rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
            </span>
          )}
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-gray-400">
              <div className="w-16 h-16 rounded-full bg-gradient-to-br from-dota-gold/20 to-amber-700/20 flex items-center justify-center mb-4">
                <MessageSquare size={32} className="text-dota-gold" />
              </div>
              <p className="text-center text-sm mb-2">{t.welcome}</p>
              <p className="text-center text-xs text-gray-500">{t.welcomeHint}</p>
              {!hasHeroes && (
                <button
                  onClick={() => setShowHeroPicker(true)}
                  className="mt-4 px-4 py-2 bg-dota-gold/20 hover:bg-dota-gold/30 text-dota-gold text-sm rounded-lg border border-dota-gold/30 transition-colors"
                >
                  {t.pickHeroes}
                </button>
              )}
            </div>
          ) : (
            messages.map((msg) => (
              <div 
                key={msg.id} 
                className={`flex ${msg.type === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div className={`max-w-[85%] rounded-lg ${
                  msg.type === 'user' 
                    ? 'bg-dota-blue/20 border border-dota-blue/30 px-4 py-2' 
                    : 'bg-gray-800/50 border border-gray-700/50 px-4 py-3'
                }`}>
                  {msg.type === 'user' ? (
                    <div className="flex items-center gap-2 text-sm text-blue-200">
                      {msg.action === 'analyze' && <Sparkles size={14} />}
                      {msg.action === 'playbook' && <Target size={14} />}
                      {msg.action === 'suggest' && <TrendingUp size={14} />}
                      {msg.action === 'meta' && <BarChart3 size={14} />}
                      <span>{msg.content}</span>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {/* Grounded indicator */}
                      {!msg.isStreaming && msg.grounded !== undefined && (
                        <div className={`inline-flex items-center gap-1.5 text-[10px] px-2 py-0.5 rounded-full ${
                          msg.grounded ? 'bg-dota-green/20 text-dota-green' : 'bg-yellow-500/20 text-yellow-400'
                        }`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${msg.grounded ? 'bg-dota-green' : 'bg-yellow-400'}`} />
                          {msg.grounded ? t.grounded : t.ungrounded}
                        </div>
                      )}

                      {/* Matchup chips */}
                      {msg.matchupData && (msg.matchupData.radiantAdvantages.length > 0 || msg.matchupData.direAdvantages.length > 0) && (
                        <div className="flex flex-wrap gap-1.5 mb-2">
                          {msg.matchupData.radiantAdvantages.slice(0, 3).map((adv, idx) => (
                            <span key={`rad-${idx}`} className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 bg-dota-green/10 border border-dota-green/30 rounded">
                              <Zap size={10} className="text-dota-green" />
                              <span className="text-dota-green">{adv.hero}</span>
                              <span className="text-gray-400">{t.vs}</span>
                              <span className="text-gray-300">{adv.vsHero}</span>
                              <span className="text-dota-green font-bold">+{adv.advantage.toFixed(1)}%</span>
                            </span>
                          ))}
                          {msg.matchupData.direAdvantages.slice(0, 3).map((adv, idx) => (
                            <span key={`dire-${idx}`} className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 bg-dota-red/10 border border-dota-red/30 rounded">
                              <Zap size={10} className="text-dota-red" />
                              <span className="text-dota-red">{adv.hero}</span>
                              <span className="text-gray-400">{t.vs}</span>
                              <span className="text-gray-300">{adv.vsHero}</span>
                              <span className="text-dota-red font-bold">+{adv.advantage.toFixed(1)}%</span>
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Playbook item builds */}
                      {msg.playbookData && msg.playbookData.length > 0 && (
                        <div className="space-y-2 mb-3">
                          {msg.playbookData.map((hero) => {
                            const heroDisplayName = lang === 'zh' ? (hero.nameZh || hero.heroName) : (hero.nameEn || hero.heroName);
                            const heroDisplayRoles = lang === 'zh' && hero.rolesZh ? hero.rolesZh : hero.roles;
                            return (
                              <div key={hero.heroId} className="bg-gray-900/50 rounded p-2 border border-gray-700/50">
                                <div className="flex items-center gap-2 mb-1.5">
                                  <span className="text-white text-xs font-medium">{heroDisplayName}</span>
                                  {heroDisplayRoles && heroDisplayRoles.length > 0 && (
                                    <span className="text-gray-500 text-[9px]">{heroDisplayRoles.slice(0, 2).join('/')}</span>
                                  )}
                                  {hero.winRate && (
                                    <span className="text-gray-400 text-[10px] ml-auto">{t.winRate}: {hero.winRate}%</span>
                                  )}
                                </div>
                                <div className="space-y-1">
                                  {hero.items.startGame.length > 0 && (
                                    <div className="flex items-center gap-1.5">
                                      <span className="text-gray-500 text-[9px] w-6">{t.start}</span>
                                      <div className="flex gap-0.5">
                                        {hero.items.startGame.slice(0, 4).map((item, idx) => (
                                          <img key={idx} src={item.img} alt={item.name} title={item.name} className="w-5 h-5 rounded border border-gray-600" />
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                  {hero.items.earlyGame.length > 0 && (
                                    <div className="flex items-center gap-1.5">
                                      <span className="text-gray-500 text-[9px] w-6">{t.early}</span>
                                      <div className="flex gap-0.5">
                                        {hero.items.earlyGame.slice(0, 4).map((item, idx) => (
                                          <img key={idx} src={item.img} alt={item.name} title={item.name} className="w-5 h-5 rounded border border-gray-600" />
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                  {hero.items.midGame.length > 0 && (
                                    <div className="flex items-center gap-1.5">
                                      <span className="text-gray-500 text-[9px] w-6">{t.mid}</span>
                                      <div className="flex gap-0.5">
                                        {hero.items.midGame.slice(0, 4).map((item, idx) => (
                                          <img key={idx} src={item.img} alt={item.name} title={item.name} className="w-5 h-5 rounded border border-gray-600" />
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                  {hero.items.lateGame.length > 0 && (
                                    <div className="flex items-center gap-1.5">
                                      <span className="text-gray-500 text-[9px] w-6">{t.late}</span>
                                      <div className="flex gap-0.5">
                                        {hero.items.lateGame.slice(0, 4).map((item, idx) => (
                                          <img key={idx} src={item.img} alt={item.name} title={item.name} className="w-5 h-5 rounded border border-gray-600" />
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </div>
                                {/* Matchup advantages */}
                                {hero.vsEnemies.length > 0 && (
                                  <div className="flex flex-wrap gap-1 mt-1.5 pt-1.5 border-t border-gray-700/50">
                                    {hero.vsEnemies.slice(0, 3).map((vs, idx) => {
                                      const adv = parseFloat(vs.advantage);
                                      const enemyName = lang === 'zh' ? (vs.enemyNameZh || vs.enemy) : (vs.enemyNameEn || vs.enemy);
                                      return (
                                        <span 
                                          key={idx}
                                          className={`text-[9px] px-1.5 py-0.5 rounded ${
                                            adv >= 0 ? 'bg-dota-green/10 text-dota-green' : 'bg-dota-red/10 text-dota-red'
                                          }`}
                                        >
                                          {t.vs} {enemyName}: {adv >= 0 ? '+' : ''}{vs.advantage}%
                                        </span>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Suggestions cards */}
                      {msg.suggestions && msg.suggestions.length > 0 && (
                        <div className="grid grid-cols-2 gap-2 mb-3">
                          {msg.suggestions.slice(0, 6).map((s) => {
                            const suggestionName = lang === 'zh' ? (s.nameZh || s.name) : (s.nameEn || s.name);
                            const suggestionRoles = lang === 'zh' && s.rolesZh ? s.rolesZh : s.roles;
                            return (
                              <button
                                key={s.id}
                                onClick={() => {
                                  const hero = allHeroes.find(h => h.id === s.id);
                                  if (hero) handleHeroSelect(hero);
                                }}
                                className="flex items-center gap-2 p-2 bg-gray-900/50 hover:bg-gray-700/50 border border-gray-700/50 hover:border-dota-gold/50 rounded transition-colors text-left"
                              >
                                <div className="flex-1 min-w-0">
                                  <span className="text-white text-xs font-medium block truncate">{suggestionName}</span>
                                  {suggestionRoles && suggestionRoles.length > 0 && (
                                    <span className="text-gray-500 text-[9px]">{suggestionRoles.slice(0, 2).join('/')}</span>
                                  )}
                                </div>
                                {s.bestAdvantage && parseFloat(s.bestAdvantage) > 0 && (
                                  <span className="text-dota-green text-[10px] font-bold flex-shrink-0">+{s.bestAdvantage}%</span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      )}

                      {/* Meta tier list */}
                      {msg.tierHeroes && msg.tierHeroes.length > 0 && (
                        <div className="space-y-1.5 mb-3">
                          {msg.tierHeroes.slice(0, 10).map((hero) => {
                            const displayName = lang === 'zh' ? (hero.nameZh || hero.name) : (hero.nameEn || hero.name);
                            const displayRoles = lang === 'zh' && hero.rolesZh ? hero.rolesZh : hero.roles;
                            return (
                              <div 
                                key={hero.id}
                                onClick={() => {
                                  const h = allHeroes.find(ah => ah.id === hero.id);
                                  if (h) handleHeroSelect(h);
                                }}
                                className="flex items-center gap-2 p-1.5 bg-gray-900/50 hover:bg-gray-700/50 rounded cursor-pointer transition-colors"
                              >
                                <span className={`w-5 h-5 flex items-center justify-center text-[10px] font-bold rounded ${
                                  hero.tier === 'S' ? 'bg-dota-gold/30 text-dota-gold' :
                                  hero.tier === 'A' ? 'bg-green-500/30 text-green-400' :
                                  'bg-gray-600/30 text-gray-400'
                                }`}>
                                  {hero.tier}
                                </span>
                                <img src={hero.icon} alt="" className="w-5 h-5 rounded" />
                                <span className="text-white text-xs flex-1 truncate">{displayName}</span>
                                {displayRoles && displayRoles.length > 0 && (
                                  <span className="text-gray-500 text-[9px] hidden sm:inline">{displayRoles.slice(0, 2).join('/')}</span>
                                )}
                                <span className="text-dota-green text-[10px] font-mono">{hero.winRate.toFixed(1)}%</span>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Text content */}
                      {msg.content && (
                        <div className="prose prose-invert prose-sm max-w-none">
                          {renderMarkdown(msg.content)}
                        </div>
                      )}

                      {/* Streaming cursor */}
                      {msg.isStreaming && (
                        <span className="inline-block w-2 h-4 bg-dota-gold animate-pulse ml-1" />
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Quick Action Chips + Input */}
        <div className="p-2 sm:p-3 border-t border-gray-700/50 bg-black/30">
          {/* Side indicator + Quick Actions */}
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 mb-2 sm:mb-3">
            {hasHeroes && (
              <span className={`text-[10px] px-2 py-0.5 rounded-full mr-1 ${
                selectionSide === 'radiant' 
                  ? 'bg-dota-green/20 text-dota-green border border-dota-green/30' 
                  : 'bg-dota-red/20 text-dota-red border border-dota-red/30'
              }`}>
                {t.yourSide}: {selectionSide === 'radiant' ? t.radiant : t.dire}
              </span>
            )}
            <button
              onClick={handleAnalyze}
              disabled={isLoading || !hasHeroes}
              className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 bg-gradient-to-r from-dota-red/80 to-red-900/80 hover:from-dota-red hover:to-red-800 text-white text-xs sm:text-sm font-medium rounded-full transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Sparkles size={12} className="sm:w-3.5 sm:h-3.5" />
              {t.analyzeAction}
            </button>
            <button
              onClick={handlePlaybook}
              disabled={isLoading || (selectionSide === 'radiant' ? draft.radiant.length === 0 : draft.dire.length === 0)}
              className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 bg-gradient-to-r from-blue-600/80 to-blue-800/80 hover:from-blue-600 hover:to-blue-700 text-white text-xs sm:text-sm font-medium rounded-full transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Target size={12} className="sm:w-3.5 sm:h-3.5" />
              {t.playbookAction}
            </button>
            <button
              onClick={handleSuggest}
              disabled={isLoading || (selectionSide === 'radiant' ? draft.radiant.length >= 5 : draft.dire.length >= 5)}
              className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 bg-gradient-to-r from-green-600/80 to-green-800/80 hover:from-green-600 hover:to-green-700 text-white text-xs sm:text-sm font-medium rounded-full transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <TrendingUp size={12} className="sm:w-3.5 sm:h-3.5" />
              {t.suggestAction}
            </button>
            <button
              onClick={handleMeta}
              disabled={isLoading}
              className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 bg-gradient-to-r from-purple-600/80 to-purple-800/80 hover:from-purple-600 hover:to-purple-700 text-white text-xs sm:text-sm font-medium rounded-full transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <BarChart3 size={12} className="sm:w-3.5 sm:h-3.5" />
              {t.metaAction}
            </button>
            {isLoading && (
              <button
                onClick={cancelStream}
                className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs sm:text-sm font-medium rounded-full transition-all"
              >
                <X size={12} className="sm:w-3.5 sm:h-3.5" />
                {t.cancel}
              </button>
            )}
          </div>

          {/* Input */}
          <form onSubmit={handleSubmit} className="flex gap-2">
            <input
              type="text"
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              placeholder={t.inputPlaceholder}
              disabled={isLoading}
              className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm text-white focus:outline-none focus:border-dota-gold transition-colors placeholder-gray-600 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={isLoading || !userInput.trim()}
              className="px-3 sm:px-4 py-1.5 sm:py-2 bg-dota-gold hover:bg-amber-500 text-black font-medium rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Send size={16} className="sm:w-[18px] sm:h-[18px]" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};

export default CoachView;
