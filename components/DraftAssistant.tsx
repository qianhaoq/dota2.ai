import React, { useState, useEffect } from 'react';
import { Hero, DraftState, Attribute } from '../types';
import HeroCard from './HeroCard';
import { analyzeDraft } from '../services/geminiService';
import { fetchHeroes } from '../services/dotaApiService';
import { Swords, RotateCcw, Sparkles, Search, Filter } from 'lucide-react';

const DraftAssistant: React.FC = () => {
  const [allHeroes, setAllHeroes] = useState<Hero[]>([]);
  const [isHeroesLoading, setIsHeroesLoading] = useState(true);
  
  const [draft, setDraft] = useState<DraftState>({ radiant: [], dire: [] });
  const [selectionSide, setSelectionSide] = useState<'radiant' | 'dire'>('radiant');
  const [analysis, setAnalysis] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  
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

  const handleAnalyze = async () => {
    if (draft.radiant.length === 0 && draft.dire.length === 0) return;
    
    setIsLoading(true);
    setAnalysis('');
    const result = await analyzeDraft(draft.radiant, draft.dire);
    setAnalysis(result);
    setIsLoading(false);
  };

  const resetDraft = () => {
    setDraft({ radiant: [], dire: [] });
    setAnalysis('');
  };

  // Filter Logic
  const filteredHeroes = allHeroes.filter(hero => {
    const matchesSearch = hero.name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesAttr = attrFilter === 'All' || hero.attribute === attrFilter;
    return matchesSearch && matchesAttr;
  });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 h-full">
      {/* Left Col: Draft Board */}
      <div className="lg:col-span-8 flex flex-col gap-6">
        
        {/* Teams Display */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Radiant Team */}
          <div className="glass-panel p-4 rounded-xl border-l-4 border-l-dota-green">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-display text-dota-green text-xl tracking-wider">RADIANT</h3>
              <button 
                onClick={() => setSelectionSide('radiant')}
                className={`px-3 py-1 text-xs rounded uppercase tracking-widest transition-colors ${selectionSide === 'radiant' ? 'bg-dota-green text-white' : 'bg-gray-800 text-gray-400'}`}
              >
                {selectionSide === 'radiant' ? 'Selecting' : 'Select'}
              </button>
            </div>
            <div className="flex gap-2 min-h-[80px] overflow-x-auto pb-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={`rad-${i}`} className="min-w-[4rem] w-16 h-20 md:w-20 md:h-24 bg-black/40 rounded border border-dashed border-gray-600 flex items-center justify-center relative flex-shrink-0">
                  {draft.radiant[i] ? (
                    <div className="absolute inset-0" onClick={() => removeHero('radiant', i)}>
                      <HeroCard hero={draft.radiant[i]} small={false} isSelected={false} />
                    </div>
                  ) : (
                    <span className="text-gray-600 text-2xl font-display">{i + 1}</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Dire Team */}
          <div className="glass-panel p-4 rounded-xl border-l-4 border-l-dota-red">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-display text-dota-red text-xl tracking-wider">DIRE</h3>
              <button 
                onClick={() => setSelectionSide('dire')}
                className={`px-3 py-1 text-xs rounded uppercase tracking-widest transition-colors ${selectionSide === 'dire' ? 'bg-dota-red text-white' : 'bg-gray-800 text-gray-400'}`}
              >
                {selectionSide === 'dire' ? 'Selecting' : 'Select'}
              </button>
            </div>
            <div className="flex gap-2 min-h-[80px] overflow-x-auto pb-2">
               {Array.from({ length: 5 }).map((_, i) => (
                <div key={`dire-${i}`} className="min-w-[4rem] w-16 h-20 md:w-20 md:h-24 bg-black/40 rounded border border-dashed border-gray-600 flex items-center justify-center relative flex-shrink-0">
                  {draft.dire[i] ? (
                    <div className="absolute inset-0" onClick={() => removeHero('dire', i)}>
                      <HeroCard hero={draft.dire[i]} small={false} isSelected={false} />
                    </div>
                  ) : (
                    <span className="text-gray-600 text-2xl font-display">{i + 1}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Hero Pool */}
        <div className="glass-panel p-4 rounded-xl flex-grow overflow-hidden flex flex-col max-h-[500px]">
           <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-4 gap-3 border-b border-gray-700 pb-3">
              <h4 className="text-dota-gold font-display text-sm uppercase tracking-widest whitespace-nowrap">Hero Pool</h4>
              
              <div className="flex flex-wrap gap-2 w-full sm:w-auto">
                <div className="relative flex-grow sm:flex-grow-0">
                  <Search className="absolute left-2 top-1.5 text-gray-500" size={14} />
                  <input 
                    type="text" 
                    placeholder="Search..." 
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
                       {attr === 'All' ? 'ALL' : attr.substring(0,3)}
                     </button>
                   ))}
                </div>
              </div>
           </div>

           <div className="overflow-y-auto pr-2 custom-scrollbar flex-grow">
             {isHeroesLoading ? (
               <div className="h-40 flex items-center justify-center text-gray-500 gap-2">
                 <div className="w-4 h-4 border-2 border-dota-gold border-t-transparent rounded-full animate-spin"></div>
                 Loading Heroes from Valve API...
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
                   <div className="col-span-full text-center text-gray-500 py-8 text-xs">No heroes found</div>
                 )}
               </div>
             )}
           </div>
        </div>

      </div>

      {/* Right Col: Analysis */}
      <div className="lg:col-span-4 flex flex-col h-full">
        <div className="glass-panel rounded-xl flex-grow p-6 flex flex-col h-full relative overflow-hidden min-h-[400px]">
            <div className="flex justify-between items-center mb-6">
                <h2 className="font-display text-2xl text-white">Battle Oracle</h2>
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

            {analysis ? (
                <div className="overflow-y-auto pr-2 space-y-4 text-gray-300 text-sm leading-relaxed custom-scrollbar pb-20 flex-grow">
                    {/* Simple rendering of markdown-like text */}
                    {analysis.split('\n').map((line, idx) => {
                        if (line.startsWith('##')) return <h3 key={idx} className="text-dota-gold font-bold text-lg mt-4 mb-2">{line.replace('##', '')}</h3>;
                        if (line.startsWith('**')) return <strong key={idx} className="block mt-2 text-white">{line.replace(/\*\*/g, '')}</strong>;
                        if (line.startsWith('* ')) return <li key={idx} className="ml-4 list-disc marker:text-dota-red">{line.replace('* ', '')}</li>;
                        return <p key={idx}>{line}</p>;
                    })}
                </div>
            ) : (
                <div className="flex flex-col items-center justify-center h-full text-gray-500 opacity-50 flex-grow">
                    <Swords size={64} className="mb-4" />
                    <p className="text-center px-4">Select heroes for both sides to invoke the ancient wisdom.</p>
                </div>
            )}

            <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-[#121212] via-[#121212] to-transparent z-10">
                 <button 
                    onClick={handleAnalyze}
                    disabled={isLoading || (draft.radiant.length === 0 && draft.dire.length === 0)}
                    className="w-full py-4 bg-gradient-to-r from-dota-red to-red-900 text-white font-display font-bold text-lg tracking-widest rounded shadow-lg hover:shadow-red-900/50 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {isLoading ? (
                        <>
                            <div className="animate-spin h-5 w-5 border-2 border-white border-t-transparent rounded-full"></div>
                            DIVINING...
                        </>
                    ) : (
                        <>
                            <Sparkles size={20} /> ANALYZE MATCHUP
                        </>
                    )}
                </button>
            </div>
        </div>
      </div>
    </div>
  );
};

export default DraftAssistant;