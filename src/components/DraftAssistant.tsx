import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Hero, DraftState, Attribute, Language } from '../types';
import HeroCard from './HeroCard';
import { analyzeDraftStream, fetchSuggestions, HeroSuggestion } from '../services/geminiService';
import { fetchHeroes } from '../services/dotaApiService';
import { Swords, RotateCcw, Sparkles, Search, AlertTriangle, X, Lightbulb, TrendingUp } from 'lucide-react';

interface DraftAssistantProps {
    lang: Language;
}

const DraftAssistant: React.FC<DraftAssistantProps> = ({ lang }) => {
  const [allHeroes, setAllHeroes] = useState<Hero[]>([]);
  const [isHeroesLoading, setIsHeroesLoading] = useState(true);
  
  const [draft, setDraft] = useState<DraftState>({ radiant: [], dire: [] });
  const [selectionSide, setSelectionSide] = useState<'radiant' | 'dire'>('radiant');
  const [analysis, setAnalysis] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [isGrounded, setIsGrounded] = useState(false);
  const [userContext, setUserContext] = useState('');
  
  // Streaming controller ref
  const streamControllerRef = useRef<AbortController | null>(null);
  
  // Suggestions state
  const [suggestions, setSuggestions] = useState<HeroSuggestion[]>([]);
  const [isSuggestionsLoading, setIsSuggestionsLoading] = useState(false);
  
  // Filter states
  const [searchQuery, setSearchQuery] = useState('');
  const [attrFilter, setAttrFilter] = useState<Attribute | 'All'>('All');

  // Load heroes on mount
  useEffect(() => {
    const loadData = async () => {
      setIsHeroesLoading(true);
      const data = await fetchHeroes();
      setAllHeroes(data);
      setIsHeroesLoading(false);
    };
    loadData();
  }, []);

  // Fetch suggestions when draft changes
  const updateSuggestions = useCallback(async (currentDraft: DraftState, side: 'radiant' | 'dire') => {
    const allies = side === 'radiant' ? currentDraft.radiant : currentDraft.dire;
    const enemies = side === 'radiant' ? currentDraft.dire : currentDraft.radiant;
    
    if (allies.length >= 5) {
      setSuggestions([]);
      return;
    }
    
    if (enemies.length === 0 && allies.length === 0) {
      setSuggestions([]);
      return;
    }
    
    setIsSuggestionsLoading(true);
    const result = await fetchSuggestions(allies, enemies, side);
    setSuggestions(result);
    setIsSuggestionsLoading(false);
  }, []);

  useEffect(() => {
    updateSuggestions(draft, selectionSide);
  }, [draft, selectionSide, updateSuggestions]);

  const handleHeroSelect = (hero: Hero) => {
    // Check if hero is already picked anywhere
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
  };

  const removeHero = (side: 'radiant' | 'dire', index: number) => {
    setDraft(prev => {
      const newList = [...prev[side]];
      newList.splice(index, 1);
      return { ...prev, [side]: newList };
    });
  };

  const handleAnalyze = () => {
    if (draft.radiant.length === 0 && draft.dire.length === 0) return;
    
    // Cancel any existing stream
    if (streamControllerRef.current) {
      streamControllerRef.current.abort();
    }
    
    setIsLoading(true);
    setAnalysis('');
    setIsGrounded(false);
    
    streamControllerRef.current = analyzeDraftStream(
      draft.radiant,
      draft.dire,
      lang,
      userContext,
      {
        onChunk: (text) => {
          setAnalysis(prev => prev + text);
        },
        onComplete: (grounded) => {
          setIsLoading(false);
          setIsGrounded(grounded);
          streamControllerRef.current = null;
        },
        onError: (error) => {
          setAnalysis(`The Ancient is under attack! (Error: ${error})`);
          setIsLoading(false);
          streamControllerRef.current = null;
        }
      }
    );
  };

  const handleCancelAnalysis = () => {
    if (streamControllerRef.current) {
      streamControllerRef.current.abort();
      streamControllerRef.current = null;
      setIsLoading(false);
      if (!analysis) {
        setAnalysis('');
      }
    }
  };

  const resetDraft = () => {
    // Cancel any ongoing stream
    if (streamControllerRef.current) {
      streamControllerRef.current.abort();
      streamControllerRef.current = null;
    }
    setDraft({ radiant: [], dire: [] });
    setAnalysis('');
    setUserContext('');
    setIsLoading(false);
    setSuggestions([]);
    setIsGrounded(false);
  };

  const handleSuggestionClick = (suggestion: HeroSuggestion) => {
    const hero = allHeroes.find(h => h.id === suggestion.id);
    if (hero) {
      handleHeroSelect(hero);
    }
  };

  // Filter Logic
  const filteredHeroes = allHeroes.filter(hero => {
    const matchesSearch = hero.name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesAttr = attrFilter === 'All' || hero.attribute === attrFilter;
    return matchesSearch && matchesAttr;
  });

  const t = {
      radiant: lang === 'zh' ? '天辉' : 'RADIANT',
      dire: lang === 'zh' ? '夜魇' : 'DIRE',
      select: lang === 'zh' ? '选择' : 'Select',
      selecting: lang === 'zh' ? '选择中' : 'Selecting',
      heroPool: lang === 'zh' ? '英雄池' : 'Hero Pool',
      search: lang === 'zh' ? '搜索...' : 'Search...',
      loading: lang === 'zh' ? '正在加载 Dota2 API...' : 'Loading Heroes from Valve API...',
      noHeroes: lang === 'zh' ? '未找到英雄' : 'No heroes found',
      oracle: lang === 'zh' ? '战局预言' : 'Battle Oracle',
      selectPrompt: lang === 'zh' ? '请选择双方英雄以开启远古智慧。' : 'Select heroes for both sides to invoke the ancient wisdom.',
      analyze: lang === 'zh' ? '开始分析' : 'ANALYZE MATCHUP',
      divining: lang === 'zh' ? '推演中...' : 'DIVINING...',
      cancel: lang === 'zh' ? '取消' : 'CANCEL',
      contextPlaceholder: lang === 'zh' ? '添加战术背景（例如：我们想打前期推进，或者针对敌方核心...）' : 'Add context (e.g. We want to push early, or counter their carry...)',
      suggestions: lang === 'zh' ? '推荐英雄' : 'Suggested Picks',
      suggestionsLoading: lang === 'zh' ? '分析中...' : 'Analyzing...',
      noSuggestions: lang === 'zh' ? '选择敌方英雄以获取推荐' : 'Pick enemy heroes to get suggestions',
      counterTip: lang === 'zh' ? '克制' : 'counters',
      winRate: lang === 'zh' ? '胜率' : 'WR',
      grounded: lang === 'zh' ? '基于 OpenDota 数据' : 'Grounded in OpenDota',
      ungrounded: lang === 'zh' ? '数据未验证' : 'Unverified data',
  };

  const isError = analysis.includes("The Ancient is under attack") || analysis.includes("Server Error");

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 h-full pb-4">
      {/* Left Col: Draft Board */}
      <div className="lg:col-span-8 flex flex-col gap-6 h-full">
        
        {/* Teams Display */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 flex-shrink-0">
          {/* Radiant Team */}
          <div className="glass-panel p-4 rounded-xl border-l-4 border-l-dota-green">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-display text-dota-green text-xl tracking-wider">{t.radiant}</h3>
              <button 
                onClick={() => setSelectionSide('radiant')}
                className={`px-3 py-1 text-xs rounded uppercase tracking-widest transition-colors ${selectionSide === 'radiant' ? 'bg-dota-green text-white' : 'bg-gray-800 text-gray-400'}`}
              >
                {selectionSide === 'radiant' ? t.selecting : t.select}
              </button>
            </div>
            {/* Grid Layout - No Scroll */}
            <div className="grid grid-cols-5 gap-2 w-full">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={`rad-${i}`} className="w-full aspect-[3/4] bg-black/40 rounded border border-dashed border-gray-600 flex items-center justify-center relative">
                  {draft.radiant[i] ? (
                    <div className="absolute inset-0" onClick={() => removeHero('radiant', i)}>
                      <HeroCard hero={draft.radiant[i]} small={false} isSelected={false} />
                    </div>
                  ) : (
                    <span className="text-gray-600 text-xl md:text-2xl font-display">{i + 1}</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Dire Team */}
          <div className="glass-panel p-4 rounded-xl border-l-4 border-l-dota-red">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-display text-dota-red text-xl tracking-wider">{t.dire}</h3>
              <button 
                onClick={() => setSelectionSide('dire')}
                className={`px-3 py-1 text-xs rounded uppercase tracking-widest transition-colors ${selectionSide === 'dire' ? 'bg-dota-red text-white' : 'bg-gray-800 text-gray-400'}`}
              >
                {selectionSide === 'dire' ? t.selecting : t.select}
              </button>
            </div>
            {/* Grid Layout - No Scroll */}
            <div className="grid grid-cols-5 gap-2 w-full">
               {Array.from({ length: 5 }).map((_, i) => (
                <div key={`dire-${i}`} className="w-full aspect-[3/4] bg-black/40 rounded border border-dashed border-gray-600 flex items-center justify-center relative">
                  {draft.dire[i] ? (
                    <div className="absolute inset-0" onClick={() => removeHero('dire', i)}>
                      <HeroCard hero={draft.dire[i]} small={false} isSelected={false} />
                    </div>
                  ) : (
                    <span className="text-gray-600 text-xl md:text-2xl font-display">{i + 1}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Hero Pool */}
        <div className="glass-panel p-4 rounded-xl flex-grow overflow-hidden flex flex-col min-h-[300px]">
           <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-4 gap-3 border-b border-gray-700 pb-3 flex-shrink-0">
              <h4 className="text-dota-gold font-display text-sm uppercase tracking-widest whitespace-nowrap">{t.heroPool}</h4>
              
              <div className="flex flex-wrap gap-2 w-full sm:w-auto">
                <div className="relative flex-grow sm:flex-grow-0">
                  <Search className="absolute left-2 top-1.5 text-gray-500" size={14} />
                  <input 
                    type="text" 
                    placeholder={t.search}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full sm:w-40 bg-gray-900 border border-gray-700 rounded pl-8 pr-2 py-1 text-xs text-white focus:outline-none focus:border-dota-gold"
                  />
                </div>
                
                <div className="flex gap-1">
                   {(['All', Attribute.STRENGTH, Attribute.AGILITY, Attribute.INTELLIGENCE, Attribute.UNIVERSAL] as const).map(attr => (
                     <button
                        key={attr}
                        onClick={() => setAttrFilter(attr)}
                        className={`
                          p-1.5 rounded border text-[10px] font-bold uppercase transition-colors
                          ${attrFilter === attr 
                            ? 'bg-gray-700 border-gray-500 text-white' 
                            : 'bg-transparent border-transparent text-gray-500 hover:text-gray-300'}
                        `}
                        title={attr}
                     >
                       {attr === 'All' ? (lang === 'zh' ? '全部' : 'ALL') : attr.substring(0,3)}
                     </button>
                   ))}
                </div>
              </div>
           </div>

           <div className="overflow-y-auto pr-2 custom-scrollbar flex-grow">
             {isHeroesLoading ? (
               <div className="h-40 flex items-center justify-center text-gray-500 gap-2">
                 <div className="w-4 h-4 border-2 border-dota-gold border-t-transparent rounded-full animate-spin"></div>
                 {t.loading}
               </div>
             ) : (
               <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-2">
                 {filteredHeroes.map(hero => {
                   const isPicked = [...draft.radiant, ...draft.dire].find(h => h.id === hero.id);
                   return (
                     <div key={hero.id} className={isPicked ? 'opacity-30 grayscale pointer-events-none' : ''}>
                       <HeroCard 
                          hero={hero} 
                          small 
                          onClick={() => handleHeroSelect(hero)}
                       />
                     </div>
                   );
                 })}
                 {filteredHeroes.length === 0 && (
                   <div className="col-span-full text-center text-gray-500 py-8 text-xs">{t.noHeroes}</div>
                 )}
               </div>
             )}
           </div>
        </div>

      </div>

      {/* Right Col: Analysis & Oracle Input */}
      <div className="lg:col-span-4 flex flex-col h-full overflow-hidden">
        <div className="glass-panel rounded-xl flex-grow p-6 flex flex-col h-full relative overflow-hidden">
            <div className="flex justify-between items-center mb-4 flex-shrink-0">
                <h2 className="font-display text-2xl text-white">{t.oracle}</h2>
                <div className="flex gap-2">
                     <button 
                        onClick={resetDraft}
                        className="p-2 rounded-full hover:bg-gray-700 text-gray-400 transition"
                        title="Reset"
                    >
                        <RotateCcw size={20} />
                    </button>
                </div>
            </div>

            {/* Top Input Section */}
            <div className="flex-shrink-0 bg-[#0f1014]/50 rounded-lg p-2 border border-gray-700/50 mb-4">
               <textarea
                 value={userContext}
                 onChange={(e) => setUserContext(e.target.value)}
                 placeholder={t.contextPlaceholder}
                 className="w-full bg-transparent text-sm text-gray-200 focus:outline-none resize-none custom-scrollbar mb-2 placeholder-gray-600"
                 rows={3}
               />
               <div className="flex gap-2">
                 <button 
                    onClick={handleAnalyze}
                    disabled={isLoading || (draft.radiant.length === 0 && draft.dire.length === 0)}
                    className="flex-1 py-3 bg-gradient-to-r from-dota-red to-red-900 text-white font-display font-bold text-lg tracking-widest rounded shadow-lg hover:shadow-red-900/50 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {isLoading ? (
                        <>
                            <div className="animate-spin h-5 w-5 border-2 border-white border-t-transparent rounded-full"></div>
                            {t.divining}
                        </>
                    ) : (
                        <>
                            <Sparkles size={20} /> {t.analyze}
                        </>
                    )}
                </button>
                {isLoading && (
                  <button 
                    onClick={handleCancelAnalysis}
                    className="px-4 py-3 bg-gray-700 hover:bg-gray-600 text-white font-display font-bold text-sm tracking-widest rounded shadow-lg transition-all flex items-center justify-center gap-1"
                  >
                    <X size={18} /> {t.cancel}
                  </button>
                )}
               </div>
            </div>

            {/* Suggestions Panel */}
            {(suggestions.length > 0 || isSuggestionsLoading) && (draft.radiant.length < 5 || draft.dire.length < 5) && (
              <div className="flex-shrink-0 mb-4 bg-[#0f1014]/50 rounded-lg p-3 border border-dota-gold/30">
                <div className="flex items-center gap-2 mb-2">
                  <Lightbulb size={16} className="text-dota-gold" />
                  <span className="text-dota-gold text-sm font-display tracking-wider">{t.suggestions}</span>
                  <span className="text-gray-500 text-xs ml-auto">
                    {selectionSide === 'radiant' ? t.radiant : t.dire}
                  </span>
                </div>
                {isSuggestionsLoading ? (
                  <div className="flex items-center gap-2 text-gray-400 text-xs py-2">
                    <div className="w-3 h-3 border border-dota-gold border-t-transparent rounded-full animate-spin"></div>
                    {t.suggestionsLoading}
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {suggestions.map((s) => (
                      <button
                        key={s.id}
                        onClick={() => handleSuggestionClick(s)}
                        className="group flex items-center gap-1.5 px-2 py-1.5 bg-gray-800/80 hover:bg-gray-700 border border-gray-700 hover:border-dota-gold/50 rounded transition-all text-xs"
                        title={s.reasons.map(r => `${t.counterTip} ${r.enemy}: ${r.winRate}%`).join('\n')}
                      >
                        <span className="text-white font-medium">{s.name}</span>
                        {s.reasons.length > 0 && (
                          <span className="text-dota-green text-[10px]">
                            <TrendingUp size={10} className="inline mr-0.5" />
                            {s.reasons[0].advantage}%
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
                {suggestions.length === 0 && !isSuggestionsLoading && (draft.dire.length === 0 && draft.radiant.length === 0) && (
                  <p className="text-gray-500 text-xs">{t.noSuggestions}</p>
                )}
              </div>
            )}

            {/* Analysis Content - SCROLLABLE AREA */}
            <div className="flex-grow overflow-y-auto custom-scrollbar pr-2 mb-4">
                {analysis ? (
                    <div className={`space-y-4 text-sm leading-relaxed pb-4 ${isError ? 'text-red-400 border border-red-500/30 bg-red-900/10 p-4 rounded' : 'text-gray-300'}`}>
                        {isError && <div className="flex items-center gap-2 font-bold mb-2"><AlertTriangle size={16}/> ERROR</div>}
                        
                        {/* Grounded indicator */}
                        {!isError && !isLoading && analysis && (
                          <div className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-full w-fit ${isGrounded ? 'bg-dota-green/20 text-dota-green' : 'bg-yellow-500/20 text-yellow-400'}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${isGrounded ? 'bg-dota-green' : 'bg-yellow-400'}`}></span>
                            {isGrounded ? t.grounded : t.ungrounded}
                          </div>
                        )}
                        
                        {/* Simple rendering of markdown-like text */}
                        {analysis.split('\n').map((line, idx) => {
                            if (line.startsWith('##')) return <h3 key={idx} className="text-dota-gold font-bold text-lg mt-4 mb-2 border-b border-dota-gold/20 pb-1">{line.replace('##', '')}</h3>;
                            if (line.startsWith('**')) return <strong key={idx} className="block mt-2 text-white">{line.replace(/\*\*/g, '')}</strong>;
                            if (line.startsWith('* ')) return <li key={idx} className="ml-4 list-disc marker:text-dota-red pl-1">{line.replace('* ', '')}</li>;
                            return <p key={idx}>{line}</p>;
                        })}
                        
                        {/* Streaming cursor */}
                        {isLoading && <span className="inline-block w-2 h-4 bg-dota-gold animate-pulse ml-1"></span>}
                    </div>
                ) : (
                    <div className="flex flex-col items-center justify-center h-full text-gray-500 opacity-50 min-h-[150px]">
                        <Swords size={64} className="mb-4" />
                        <p className="text-center px-4">{t.selectPrompt}</p>
                    </div>
                )}
            </div>

        </div>
      </div>
    </div>
  );
};

export default DraftAssistant;