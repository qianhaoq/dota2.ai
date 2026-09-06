import React, { useState, useMemo } from 'react';
import { Hero, Attribute, Language } from '../../types';
import { X, Search, RotateCcw } from 'lucide-react';

interface HeroPickerOverlayProps {
  lang: Language;
  isOpen: boolean;
  onClose: () => void;
  allHeroes: Hero[];
  isLoading: boolean;
  draft: { radiant: Hero[]; dire: Hero[] };
  selectionSide: 'radiant' | 'dire';
  onSideChange: (side: 'radiant' | 'dire') => void;
  onSelectHero: (hero: Hero) => void;
  onReset: () => void;
}

const HeroPickerOverlay: React.FC<HeroPickerOverlayProps> = ({
  lang,
  isOpen,
  onClose,
  allHeroes,
  isLoading,
  draft,
  selectionSide,
  onSideChange,
  onSelectHero,
  onReset,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [attrFilter, setAttrFilter] = useState<Attribute | 'All'>('All');

  const t = {
    title: lang === 'zh' ? '选择英雄' : 'Pick Heroes',
    radiant: lang === 'zh' ? '天辉' : 'Radiant',
    dire: lang === 'zh' ? '夜魇' : 'Dire',
    search: lang === 'zh' ? '搜索英雄...' : 'Search heroes...',
    reset: lang === 'zh' ? '重置' : 'Reset',
    all: lang === 'zh' ? '全部' : 'All',
    selectingFor: lang === 'zh' ? '正在为' : 'Picking for',
  };

  const pickedIds = useMemo(() => 
    new Set([...draft.radiant.map(h => h.id), ...draft.dire.map(h => h.id)]),
    [draft]
  );

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

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop - dim */}
      <div 
        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
        onClick={onClose}
      />
      
      {/* Modal */}
      <div className="relative w-full max-w-2xl max-h-[85vh] bg-k3-surface border border-k3-border-subtle rounded-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200 m-4">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-k3-border-subtle">
          <div className="flex items-center gap-3">
            <h2 className="font-semibold text-k3-text-primary">{t.title}</h2>
            <div className="flex gap-1">
              <button
                onClick={() => onSideChange('radiant')}
                className={`px-2.5 py-1 text-xs font-medium rounded-lg transition-colors ${
                  selectionSide === 'radiant'
                    ? 'bg-k3-radiant/15 text-k3-radiant border border-k3-radiant/30'
                    : 'text-k3-text-tertiary hover:bg-k3-elevated border border-transparent'
                }`}
              >
                {t.radiant} ({draft.radiant.length}/5)
              </button>
              <button
                onClick={() => onSideChange('dire')}
                className={`px-2.5 py-1 text-xs font-medium rounded-lg transition-colors ${
                  selectionSide === 'dire'
                    ? 'bg-k3-dire/15 text-k3-dire border border-k3-dire/30'
                    : 'text-k3-text-tertiary hover:bg-k3-elevated border border-transparent'
                }`}
              >
                {t.dire} ({draft.dire.length}/5)
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onReset}
              className="p-2 text-k3-text-tertiary hover:text-k3-text-primary hover:bg-k3-elevated rounded-lg transition-colors"
              title={t.reset}
            >
              <RotateCcw size={16} />
            </button>
            <button
              onClick={onClose}
              className="p-2 text-k3-text-tertiary hover:text-k3-text-primary hover:bg-k3-elevated rounded-lg transition-colors"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex gap-2 px-4 py-2 border-b border-k3-border-subtle">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-k3-text-tertiary" size={14} />
            <input 
              type="text" 
              placeholder={t.search}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-k3-input border border-k3-border-subtle rounded-lg pl-9 pr-3 py-2 text-sm text-k3-text-primary focus:outline-none focus:border-k3-accent placeholder:text-k3-text-tertiary"
              autoFocus
            />
          </div>
          <div className="flex gap-1">
            {(['All', Attribute.STRENGTH, Attribute.AGILITY, Attribute.INTELLIGENCE, Attribute.UNIVERSAL] as const).map(attr => (
              <button
                key={attr}
                onClick={() => setAttrFilter(attr)}
                className={`px-2.5 py-1.5 rounded-lg text-[10px] font-bold uppercase transition-colors ${
                  attrFilter === attr 
                    ? 'bg-k3-accent/15 text-k3-accent border border-k3-accent/30' 
                    : 'text-k3-text-tertiary hover:text-k3-text-secondary hover:bg-k3-elevated border border-transparent'
                }`}
              >
                {attr === 'All' ? t.all : attr.substring(0,3)}
              </button>
            ))}
          </div>
        </div>
        
        {/* Hero Grid */}
        <div className="flex-1 overflow-y-auto p-3 custom-scrollbar">
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-k3-text-tertiary text-sm">
              <div className="w-5 h-5 border-2 border-k3-accent border-t-transparent rounded-full animate-spin mr-3" />
              Loading heroes...
            </div>
          ) : (
            <div className="grid grid-cols-6 sm:grid-cols-8 md:grid-cols-10 gap-1.5">
              {filteredHeroes.map(hero => {
                const isPicked = pickedIds.has(hero.id);
                return (
                  <button 
                    key={hero.id} 
                    disabled={isPicked}
                    className={`relative group aspect-[3/4] rounded-lg overflow-hidden transition-all border ${
                      isPicked 
                        ? 'opacity-30 grayscale cursor-not-allowed border-transparent' 
                        : 'border-transparent hover:border-k3-accent hover:scale-105'
                    }`}
                    onClick={() => !isPicked && onSelectHero(hero)}
                  >
                    <img 
                      src={hero.img} 
                      alt={hero.name}
                      className="w-full h-full object-cover"
                    />
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent py-1 px-0.5">
                      <span className="text-[8px] sm:text-[9px] text-k3-text-secondary block text-center truncate">
                        {lang === 'zh' ? (hero.nameZh || hero.name) : hero.name}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Current Draft Preview */}
        <div className="px-4 py-3 border-t border-k3-border-subtle bg-k3-base">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <span className="text-k3-radiant text-xs font-medium">{t.radiant}</span>
              <div className="flex gap-1">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={`rad-preview-${i}`} className="w-7 h-7 rounded-lg bg-k3-surface border border-k3-border-subtle overflow-hidden">
                    {draft.radiant[i] && (
                      <img src={draft.radiant[i].img} alt="" className="w-full h-full object-cover" />
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex gap-1">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={`dire-preview-${i}`} className="w-7 h-7 rounded-lg bg-k3-surface border border-k3-border-subtle overflow-hidden">
                    {draft.dire[i] && (
                      <img src={draft.dire[i].img} alt="" className="w-full h-full object-cover" />
                    )}
                  </div>
                ))}
              </div>
              <span className="text-k3-dire text-xs font-medium">{t.dire}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default HeroPickerOverlay;
