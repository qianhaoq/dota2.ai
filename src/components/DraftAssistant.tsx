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
import { Swords, RotateCcw, Sparkles, Search, AlertTriangle, X, Lightbulb, TrendingUp, Zap, Shield, User, Users, Trophy, BookOpen, ChevronDown, ChevronUp } from 'lucide-react';

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
  const [matchupData, setMatchupData] = useState<MatchupData | null>(null);
  
  // Streaming controller ref
  const streamControllerRef = useRef<AbortController | null>(null);
  
  // Suggestions state
  const [suggestions, setSuggestions] = useState<HeroSuggestion[]>([]);
  const [isSuggestionsLoading, setIsSuggestionsLoading] = useState(false);
  
  // Meta tier state (大盘)
  const [tierHeroes, setTierHeroes] = useState<TierHero[]>([]);
  const [isTierLoading, setIsTierLoading] = useState(false);
  const [tierRole, setTierRole] = useState<string>('');
  const [showTierPanel, setShowTierPanel] = useState(false);
  
  // Playbook state (本局打法)
  const [showPlaybook, setShowPlaybook] = useState(false);
  const [playbookData, setPlaybookData] = useState<PlaybookHero[]>([]);
  const [playbookAnalysis, setPlaybookAnalysis] = useState('');
  const [isPlaybookLoading, setIsPlaybookLoading] = useState(false);
  const playbookControllerRef = useRef<AbortController | null>(null);
  
  // Filter states
  const [searchQuery, setSearchQuery] = useState('');
  const [attrFilter, setAttrFilter] = useState<Attribute | 'All'>('All');
  const [roleFilter, setRoleFilter] = useState<string | null>(null);
  
  // Role definitions for filtering
  const ROLES = [
    { en: 'Carry', zh: '核心' },
    { en: 'Support', zh: '辅助' },
    { en: 'Nuker', zh: '爆发' },
    { en: 'Disabler', zh: '控制' },
    { en: 'Initiator', zh: '先手' },
    { en: 'Durable', zh: '肉盾' },
  ];

  // Load heroes on mount and when language changes
  useEffect(() => {
    const loadData = async () => {
      setIsHeroesLoading(true);
      const data = await fetchHeroes(lang);
      setAllHeroes(data);
      setIsHeroesLoading(false);
    };
    loadData();
  }, [lang]);

  // Fetch suggestions when draft changes
  const updateSuggestions = useCallback(async (currentDraft: DraftState, side: 'radiant' | 'dire', role?: string | null) => {
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
    const result = await fetchSuggestions(allies, enemies, side, role || undefined, lang);
    setSuggestions(result);
    setIsSuggestionsLoading(false);
  }, [lang]);

  useEffect(() => {
    updateSuggestions(draft, selectionSide, roleFilter);
  }, [draft, selectionSide, roleFilter, updateSuggestions]);
  
  // Get draft phase hint
  const getDraftPhase = useMemo(() => {
    const allyCount = selectionSide === 'radiant' ? draft.radiant.length : draft.dire.length;
    const enemyCount = selectionSide === 'radiant' ? draft.dire.length : draft.radiant.length;
    const totalPicked = allyCount + enemyCount;
    
    if (totalPicked <= 2) return { phase: 'early', label: lang === 'zh' ? '前期选人' : 'Early Draft' };
    if (totalPicked <= 6) return { phase: 'mid', label: lang === 'zh' ? '中期选人' : 'Mid Draft' };
    return { phase: 'late', label: lang === 'zh' ? '后期补位' : 'Late Draft' };
  }, [draft, selectionSide, lang]);

  // Fetch tier data when panel is opened
  useEffect(() => {
    if (showTierPanel && tierHeroes.length === 0) {
      setIsTierLoading(true);
      fetchTierList(lang, tierRole || undefined, 15)
        .then(data => {
          setTierHeroes(data.heroes);
        })
        .finally(() => setIsTierLoading(false));
    }
  }, [showTierPanel, lang, tierRole, tierHeroes.length]);

  // Refetch tier when role filter changes
  useEffect(() => {
    if (showTierPanel) {
      setIsTierLoading(true);
      fetchTierList(lang, tierRole || undefined, 15)
        .then(data => {
          setTierHeroes(data.heroes);
        })
        .finally(() => setIsTierLoading(false));
    }
  }, [tierRole, lang, showTierPanel]);

  const handlePlaybook = () => {
    const allies = selectionSide === 'radiant' ? draft.radiant : draft.dire;
    const enemies = selectionSide === 'radiant' ? draft.dire : draft.radiant;
    
    if (allies.length === 0) return;
    
    if (playbookControllerRef.current) {
      playbookControllerRef.current.abort();
    }
    
    setShowPlaybook(true);
    setIsPlaybookLoading(true);
    setPlaybookAnalysis('');
    setPlaybookData([]);
    
    playbookControllerRef.current = fetchPlaybookStream(
      allies,
      enemies,
      selectionSide,
      lang,
      undefined,
      {
        onData: (data, _focusHero) => {
          setPlaybookData(data);
        },
        onChunk: (text) => {
          setPlaybookAnalysis(prev => prev + text);
        },
        onComplete: () => {
          setIsPlaybookLoading(false);
          playbookControllerRef.current = null;
        },
        onError: (error) => {
          setPlaybookAnalysis(prev => prev || `Error: ${error}`);
          setIsPlaybookLoading(false);
          playbookControllerRef.current = null;
        }
      }
    );
  };

  const handleCancelPlaybook = () => {
    if (playbookControllerRef.current) {
      playbookControllerRef.current.abort();
      playbookControllerRef.current = null;
      setIsPlaybookLoading(false);
    }
  };

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
    setMatchupData(null);
    
    streamControllerRef.current = analyzeDraftStream(
      draft.radiant,
      draft.dire,
      lang,
      userContext,
      {
        onChunk: (text) => {
          setAnalysis(prev => prev + text);
        },
        onMatchupData: (data) => {
          setMatchupData(data);
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
    if (playbookControllerRef.current) {
      playbookControllerRef.current.abort();
      playbookControllerRef.current = null;
    }
    setDraft({ radiant: [], dire: [] });
    setAnalysis('');
    setUserContext('');
    setIsLoading(false);
    setSuggestions([]);
    setIsGrounded(false);
    setMatchupData(null);
    setShowPlaybook(false);
    setPlaybookData([]);
    setPlaybookAnalysis('');
    setIsPlaybookLoading(false);
  };

  const handleSuggestionClick = (suggestion: HeroSuggestion) => {
    const hero = allHeroes.find(h => h.id === suggestion.id);
    if (hero) {
      handleHeroSelect(hero);
    }
  };

  // Filter Logic with Chinese name and alias support
  const filteredHeroes = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    
    return allHeroes.filter(hero => {
      // Search matching: name, nameZh, nameEn, aliases
      let matchesSearch = true;
      if (query) {
        const nameMatch = hero.name?.toLowerCase().includes(query);
        const nameZhMatch = hero.nameZh?.toLowerCase().includes(query);
        const nameEnMatch = hero.nameEn?.toLowerCase().includes(query);
        const aliasMatch = hero.aliases?.some(alias => alias.toLowerCase().includes(query));
        matchesSearch = nameMatch || nameZhMatch || nameEnMatch || aliasMatch || false;
      }
      
      // Attribute filter
      const matchesAttr = attrFilter === 'All' || hero.attribute === attrFilter;
      
      // Role filter
      const matchesRole = !roleFilter || hero.roles?.includes(roleFilter);
      
      return matchesSearch && matchesAttr && matchesRole;
    });
  }, [allHeroes, searchQuery, attrFilter, roleFilter]);

  const t = {
      radiant: lang === 'zh' ? '天辉' : 'RADIANT',
      dire: lang === 'zh' ? '夜魇' : 'DIRE',
      select: lang === 'zh' ? '选择' : 'Select',
      selecting: lang === 'zh' ? '选择中' : 'Selecting',
      heroPool: lang === 'zh' ? '英雄池' : 'Hero Pool',
      search: lang === 'zh' ? '搜索英雄/别名...' : 'Search hero/alias...',
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
      matchupAdvantages: lang === 'zh' ? '对位优势' : 'Matchup Advantages',
      vs: lang === 'zh' ? '对' : 'vs',
      games: lang === 'zh' ? '场' : 'games',
      countersPick: lang === 'zh' ? '克制' : 'counters',
      basedOnGames: lang === 'zh' ? '基于' : 'Based on',
      // Role filter (from main)
      roleFilter: lang === 'zh' ? '角色筛选' : 'Filter by Role',
      allRoles: lang === 'zh' ? '全部' : 'All',
      draftPhase: lang === 'zh' ? '选人阶段' : 'Draft Phase',
      // Meta tier panel (大盘)
      metaTier: lang === 'zh' ? '大盘数据' : 'Meta Tier',
      topHeroes: lang === 'zh' ? '热门英雄' : 'Top Heroes',
      carry: lang === 'zh' ? '核心' : 'Carry',
      support: lang === 'zh' ? '辅助' : 'Support',
      dataSource: lang === 'zh' ? '数据来源: OpenDota' : 'Source: OpenDota',
      // Playbook (本局打法)
      playbook: lang === 'zh' ? '本局打法' : 'Playbook',
      playbookTitle: lang === 'zh' ? '本局怎么打' : 'How to Win This Game',
      playbookPrompt: lang === 'zh' ? '选择己方英雄后点击"本局打法"获取出装和对线建议' : 'Select your heroes then click "Playbook" for item builds and lane tips',
      itemBuild: lang === 'zh' ? '推荐出装' : 'Item Builds',
      startItems: lang === 'zh' ? '出门' : 'Start',
      earlyItems: lang === 'zh' ? '前期' : 'Early',
      midItems: lang === 'zh' ? '中期' : 'Mid',
      lateItems: lang === 'zh' ? '后期' : 'Late',
      vsMatchup: lang === 'zh' ? '对位' : 'Matchup',
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
           <div className="flex flex-col gap-3 border-b border-gray-700 pb-3 flex-shrink-0">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                <h4 className="text-dota-gold font-display text-sm uppercase tracking-widest whitespace-nowrap">{t.heroPool}</h4>
                
                <div className="flex flex-wrap gap-2 w-full sm:w-auto">
                  <div className="relative flex-grow sm:flex-grow-0">
                    <Search className="absolute left-2 top-1.5 text-gray-500" size={14} />
                    <input 
                      type="text" 
                      placeholder={t.search}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full sm:w-48 bg-gray-900 border border-gray-700 rounded pl-8 pr-2 py-1 text-xs text-white focus:outline-none focus:border-dota-gold"
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
              
              {/* Role Filter Chips */}
              <div className="flex flex-wrap gap-1.5 items-center">
                <span className="text-gray-500 text-[10px] mr-1">{t.roleFilter}:</span>
                <button
                  onClick={() => setRoleFilter(null)}
                  className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
                    !roleFilter 
                      ? 'bg-dota-gold/20 text-dota-gold border border-dota-gold/50' 
                      : 'bg-gray-800 text-gray-400 border border-gray-700 hover:border-gray-500'
                  }`}
                >
                  {t.allRoles}
                </button>
                {ROLES.map(role => (
                  <button
                    key={role.en}
                    onClick={() => setRoleFilter(roleFilter === role.en ? null : role.en)}
                    className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
                      roleFilter === role.en 
                        ? 'bg-dota-gold/20 text-dota-gold border border-dota-gold/50' 
                        : 'bg-gray-800 text-gray-400 border border-gray-700 hover:border-gray-500'
                    }`}
                  >
                    {lang === 'zh' ? role.zh : role.en}
                  </button>
                ))}
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
      <div className="lg:col-span-4 flex flex-col h-full overflow-hidden gap-4">
        {/* Meta Tier Panel (大盘) - Collapsible */}
        <div className="glass-panel rounded-xl p-3 flex-shrink-0">
          <button 
            onClick={() => setShowTierPanel(!showTierPanel)}
            className="w-full flex items-center justify-between text-left"
          >
            <div className="flex items-center gap-2">
              <Trophy size={16} className="text-dota-gold" />
              <span className="text-dota-gold font-display text-sm tracking-wider">{t.metaTier}</span>
            </div>
            {showTierPanel ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
          </button>
          
          {showTierPanel && (
            <div className="mt-3 pt-3 border-t border-gray-700/50">
              {/* Role filter */}
              <div className="flex gap-1 mb-3 flex-wrap">
                {['', 'Carry', 'Support', 'Nuker', 'Initiator', 'Durable'].map(role => (
                  <button
                    key={role}
                    onClick={() => setTierRole(role)}
                    className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
                      tierRole === role 
                        ? 'bg-dota-gold/20 text-dota-gold border border-dota-gold/50' 
                        : 'bg-gray-800 text-gray-400 border border-gray-700 hover:border-gray-500'
                    }`}
                  >
                    {role || t.allRoles}
                  </button>
                ))}
              </div>
              
              {/* Tier list */}
              {isTierLoading ? (
                <div className="flex items-center justify-center py-4 text-gray-400 text-xs gap-2">
                  <div className="w-3 h-3 border border-dota-gold border-t-transparent rounded-full animate-spin"></div>
                  {t.loading}
                </div>
              ) : (
                <div className="space-y-1.5 max-h-[200px] overflow-y-auto custom-scrollbar pr-1">
                  {tierHeroes.slice(0, 10).map((hero) => (
                    <div 
                      key={hero.id}
                      className="flex items-center gap-2 p-1.5 bg-gray-800/50 rounded hover:bg-gray-700/50 transition-colors cursor-pointer"
                      onClick={() => {
                        const h = allHeroes.find(ah => ah.id === hero.id);
                        if (h) handleHeroSelect(h);
                      }}
                    >
                      <span className={`w-5 h-5 flex items-center justify-center text-[10px] font-bold rounded ${
                        hero.tier === 'S' ? 'bg-dota-gold/30 text-dota-gold' :
                        hero.tier === 'A' ? 'bg-green-500/30 text-green-400' :
                        'bg-gray-600/30 text-gray-400'
                      }`}>
                        {hero.tier}
                      </span>
                      <img src={hero.icon} alt="" className="w-5 h-5 rounded" />
                      <span className="text-white text-xs flex-1 truncate">{hero.name}</span>
                      <span className="text-dota-green text-[10px] font-mono">{hero.winRate.toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              )}
              <p className="text-gray-500 text-[10px] mt-2 text-center">{t.dataSource}</p>
            </div>
          )}
        </div>

        <div className="glass-panel rounded-xl flex-grow p-6 flex flex-col relative overflow-hidden">
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
                    className="flex-1 py-3 bg-gradient-to-r from-dota-red to-red-900 text-white font-display font-bold text-sm tracking-widest rounded shadow-lg hover:shadow-red-900/50 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {isLoading ? (
                        <>
                            <div className="animate-spin h-5 w-5 border-2 border-white border-t-transparent rounded-full"></div>
                            {t.divining}
                        </>
                    ) : (
                        <>
                            <Sparkles size={18} /> {t.analyze}
                        </>
                    )}
                </button>
                <button 
                    onClick={handlePlaybook}
                    disabled={isPlaybookLoading || (selectionSide === 'radiant' ? draft.radiant.length === 0 : draft.dire.length === 0)}
                    className="flex-1 py-3 bg-gradient-to-r from-blue-600 to-blue-800 text-white font-display font-bold text-sm tracking-widest rounded shadow-lg hover:shadow-blue-900/50 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {isPlaybookLoading ? (
                        <>
                            <div className="animate-spin h-5 w-5 border-2 border-white border-t-transparent rounded-full"></div>
                        </>
                    ) : (
                        <>
                            <BookOpen size={18} /> {t.playbook}
                        </>
                    )}
                </button>
                {(isLoading || isPlaybookLoading) && (
                  <button 
                    onClick={() => { handleCancelAnalysis(); handleCancelPlaybook(); }}
                    className="px-3 py-3 bg-gray-700 hover:bg-gray-600 text-white font-display font-bold text-sm tracking-widest rounded shadow-lg transition-all flex items-center justify-center"
                  >
                    <X size={18} />
                  </button>
                )}
               </div>
            </div>

            {/* Suggestions Panel */}
            {(suggestions.length > 0 || isSuggestionsLoading || (draft.radiant.length > 0 || draft.dire.length > 0)) && (draft.radiant.length < 5 || draft.dire.length < 5) && (
              <div className="flex-shrink-0 mb-4 bg-[#0f1014]/50 rounded-lg p-3 border border-dota-gold/30">
                {/* Header with phase hint */}
                <div className="flex items-center gap-2 mb-2">
                  <Lightbulb size={16} className="text-dota-gold" />
                  <span className="text-dota-gold text-sm font-display tracking-wider">{t.suggestions}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                    getDraftPhase.phase === 'early' ? 'bg-blue-500/20 text-blue-400' :
                    getDraftPhase.phase === 'mid' ? 'bg-yellow-500/20 text-yellow-400' :
                    'bg-purple-500/20 text-purple-400'
                  }`}>
                    {getDraftPhase.label}
                  </span>
                  <span className="text-gray-500 text-xs ml-auto">
                    {selectionSide === 'radiant' ? t.radiant : t.dire}
                  </span>
                </div>
                
                {/* Role filter chips in suggestions */}
                <div className="flex flex-wrap gap-1 mb-2">
                  <button
                    onClick={() => setRoleFilter(null)}
                    className={`px-1.5 py-0.5 rounded text-[9px] transition-colors ${
                      !roleFilter 
                        ? 'bg-dota-gold/30 text-dota-gold' 
                        : 'bg-gray-800/50 text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    {t.allRoles}
                  </button>
                  {ROLES.slice(0, 4).map(role => (
                    <button
                      key={role.en}
                      onClick={() => setRoleFilter(roleFilter === role.en ? null : role.en)}
                      className={`px-1.5 py-0.5 rounded text-[9px] transition-colors ${
                        roleFilter === role.en 
                          ? 'bg-dota-gold/30 text-dota-gold' 
                          : 'bg-gray-800/50 text-gray-500 hover:text-gray-300'
                      }`}
                    >
                      {lang === 'zh' ? role.zh : role.en}
                    </button>
                  ))}
                </div>
                
                {isSuggestionsLoading ? (
                  <div className="flex items-center gap-2 text-gray-400 text-xs py-2">
                    <div className="w-3 h-3 border border-dota-gold border-t-transparent rounded-full animate-spin"></div>
                    {t.suggestionsLoading}
                  </div>
                ) : suggestions.length > 0 ? (
                  <div className="flex flex-col gap-1.5">
                    {suggestions.map((s) => (
                      <button
                        key={s.id}
                        onClick={() => handleSuggestionClick(s)}
                        className="group flex items-center gap-2 px-2.5 py-2 bg-gray-800/80 hover:bg-gray-700 border border-gray-700 hover:border-dota-gold/50 rounded transition-all text-xs w-full text-left"
                      >
                        <span className="text-white font-medium min-w-[70px]">{s.name}</span>
                        {/* Role tags */}
                        {s.roles && s.roles.length > 0 && (
                          <div className="flex gap-0.5">
                            {(lang === 'zh' && s.rolesZh ? s.rolesZh : s.roles).slice(0, 2).map((role: string, idx: number) => (
                              <span key={idx} className="text-[9px] px-1 py-0.5 bg-gray-700/50 text-gray-400 rounded">
                                {role}
                              </span>
                            ))}
                          </div>
                        )}
                        {s.reasons.length > 0 ? (
                          <div className="flex flex-wrap gap-1 flex-1">
                            {s.reasons.slice(0, 2).map((r, idx) => (
                              <span 
                                key={idx} 
                                className="inline-flex items-center gap-0.5 text-[9px] px-1 py-0.5 bg-dota-green/10 border border-dota-green/30 rounded"
                                title={`${t.basedOnGames} ${r.gamesPlayed || '50+'} ${t.games}`}
                              >
                                <TrendingUp size={8} className="text-dota-green" />
                                <span className="text-white">{lang === 'zh' && r.enemyZh ? r.enemyZh : r.enemy}</span>
                                <span className="text-dota-green font-bold">+{r.advantage}%</span>
                              </span>
                            ))}
                          </div>
                        ) : s.winRate ? (
                          <span className="text-gray-400 text-[10px]">
                            {t.winRate}: {s.winRate}%
                          </span>
                        ) : null}
                        {s.bestAdvantage && parseFloat(s.bestAdvantage) > 0 && (
                          <span className="text-dota-green text-[10px] font-bold ml-auto">
                            +{s.bestAdvantage}%
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-gray-500 text-xs">{t.noSuggestions}</p>
                )}
              </div>
            )}

            {/* Matchup Chips - shows data-driven advantages at a glance */}
            {matchupData && (matchupData.radiantAdvantages.length > 0 || matchupData.direAdvantages.length > 0) && (
              <div className="flex-shrink-0 mb-3 bg-[#0f1014]/50 rounded-lg p-3 border border-gray-700/50">
                <div className="flex items-center gap-2 mb-2">
                  <Zap size={14} className="text-dota-gold" />
                  <span className="text-dota-gold text-xs font-display tracking-wider">{t.matchupAdvantages}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {matchupData.radiantAdvantages.slice(0, 3).map((adv, idx) => (
                    <div 
                      key={`rad-adv-${idx}`}
                      className="flex items-center gap-1.5 px-2 py-1 bg-dota-green/10 border border-dota-green/30 rounded text-xs"
                      title={`${t.basedOnGames} ${adv.games} ${t.games}`}
                    >
                      <Shield size={10} className="text-dota-green" />
                      <span className="text-dota-green font-medium">{adv.hero}</span>
                      <span className="text-gray-400">{t.vs}</span>
                      <span className="text-gray-300">{adv.vsHero}</span>
                      <span className="text-dota-green font-bold">+{adv.advantage}%</span>
                    </div>
                  ))}
                  {matchupData.direAdvantages.slice(0, 3).map((adv, idx) => (
                    <div 
                      key={`dire-adv-${idx}`}
                      className="flex items-center gap-1.5 px-2 py-1 bg-dota-red/10 border border-dota-red/30 rounded text-xs"
                      title={`${t.basedOnGames} ${adv.games} ${t.games}`}
                    >
                      <Swords size={10} className="text-dota-red" />
                      <span className="text-dota-red font-medium">{adv.hero}</span>
                      <span className="text-gray-400">{t.vs}</span>
                      <span className="text-gray-300">{adv.vsHero}</span>
                      <span className="text-dota-red font-bold">+{adv.advantage}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Content Area - SCROLLABLE */}
            <div className="flex-grow overflow-y-auto custom-scrollbar pr-2 mb-4">
                {/* Show Playbook when active */}
                {showPlaybook ? (
                  <div className="space-y-4 text-sm leading-relaxed pb-4">
                    {/* Playbook Header */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <BookOpen size={18} className="text-blue-400" />
                        <h3 className="text-blue-400 font-display tracking-wider">{t.playbookTitle}</h3>
                      </div>
                      <button 
                        onClick={() => setShowPlaybook(false)}
                        className="text-gray-400 hover:text-white text-xs"
                      >
                        {t.oracle} →
                      </button>
                    </div>
                    
                    {/* Item Builds Summary */}
                    {playbookData.length > 0 && (
                      <div className="space-y-3">
                        {playbookData.map((hero) => (
                          <div key={hero.heroId} className="bg-gray-800/50 rounded-lg p-3 border border-gray-700/50">
                            <div className="flex items-center gap-2 mb-2">
                              <span className="text-white font-medium">{hero.heroName}</span>
                              {hero.winRate && (
                                <span className="text-gray-400 text-xs">{t.winRate}: {hero.winRate}%</span>
                              )}
                            </div>
                            
                            {/* Item stages */}
                            <div className="space-y-1.5">
                              {hero.items.startGame.length > 0 && (
                                <div className="flex items-center gap-2">
                                  <span className="text-gray-500 text-[10px] w-8">{t.startItems}</span>
                                  <div className="flex gap-1">
                                    {hero.items.startGame.slice(0, 4).map((item, idx) => (
                                      <img key={idx} src={item.img} alt={item.name} title={item.name} className="w-6 h-6 rounded border border-gray-600" />
                                    ))}
                                  </div>
                                </div>
                              )}
                              {hero.items.earlyGame.length > 0 && (
                                <div className="flex items-center gap-2">
                                  <span className="text-gray-500 text-[10px] w-8">{t.earlyItems}</span>
                                  <div className="flex gap-1">
                                    {hero.items.earlyGame.slice(0, 4).map((item, idx) => (
                                      <img key={idx} src={item.img} alt={item.name} title={item.name} className="w-6 h-6 rounded border border-gray-600" />
                                    ))}
                                  </div>
                                </div>
                              )}
                              {hero.items.midGame.length > 0 && (
                                <div className="flex items-center gap-2">
                                  <span className="text-gray-500 text-[10px] w-8">{t.midItems}</span>
                                  <div className="flex gap-1">
                                    {hero.items.midGame.slice(0, 4).map((item, idx) => (
                                      <img key={idx} src={item.img} alt={item.name} title={item.name} className="w-6 h-6 rounded border border-gray-600" />
                                    ))}
                                  </div>
                                </div>
                              )}
                              {hero.items.lateGame.length > 0 && (
                                <div className="flex items-center gap-2">
                                  <span className="text-gray-500 text-[10px] w-8">{t.lateItems}</span>
                                  <div className="flex gap-1">
                                    {hero.items.lateGame.slice(0, 4).map((item, idx) => (
                                      <img key={idx} src={item.img} alt={item.name} title={item.name} className="w-6 h-6 rounded border border-gray-600" />
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                            
                            {/* Matchup data */}
                            {hero.vsEnemies.length > 0 && (
                              <div className="mt-2 pt-2 border-t border-gray-700/50">
                                <div className="flex flex-wrap gap-1">
                                  {hero.vsEnemies.slice(0, 3).map((vs, idx) => {
                                    const adv = parseFloat(vs.advantage);
                                    return (
                                      <span 
                                        key={idx}
                                        className={`text-[10px] px-1.5 py-0.5 rounded ${
                                          adv >= 0 ? 'bg-dota-green/10 text-dota-green' : 'bg-dota-red/10 text-dota-red'
                                        }`}
                                      >
                                        vs {vs.enemy}: {adv >= 0 ? '+' : ''}{vs.advantage}%
                                      </span>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    
                    {/* DeepSeek Analysis */}
                    {playbookAnalysis && (
                      <div className="mt-4 pt-4 border-t border-gray-700">
                        <div className="flex items-center gap-1.5 text-xs px-2 py-1 rounded-full w-fit bg-dota-green/20 text-dota-green mb-3">
                          <span className="w-1.5 h-1.5 rounded-full bg-dota-green"></span>
                          {t.grounded}
                        </div>
                        {playbookAnalysis.split('\n').map((line, idx) => {
                          if (line.startsWith('##')) return <h3 key={idx} className="text-blue-400 font-bold text-lg mt-4 mb-2 border-b border-blue-400/20 pb-1">{line.replace('##', '')}</h3>;
                          if (line.startsWith('**')) return <strong key={idx} className="block mt-2 text-white">{line.replace(/\*\*/g, '')}</strong>;
                          if (line.startsWith('- ')) return <li key={idx} className="ml-4 list-disc marker:text-blue-400 pl-1 text-gray-300">{line.replace('- ', '')}</li>;
                          if (line.startsWith('* ')) return <li key={idx} className="ml-4 list-disc marker:text-blue-400 pl-1 text-gray-300">{line.replace('* ', '')}</li>;
                          return <p key={idx} className="text-gray-300">{line}</p>;
                        })}
                        {isPlaybookLoading && <span className="inline-block w-2 h-4 bg-blue-400 animate-pulse ml-1"></span>}
                      </div>
                    )}
                    
                    {/* Loading state */}
                    {isPlaybookLoading && !playbookAnalysis && playbookData.length === 0 && (
                      <div className="flex items-center justify-center py-8 text-gray-400 gap-2">
                        <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"></div>
                        {t.divining}
                      </div>
                    )}
                  </div>
                ) : analysis ? (
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