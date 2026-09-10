import React, { useState, useMemo } from 'react';
import { Hero, Attribute, Language } from '../../types';
import { X, Search, RotateCcw } from 'lucide-react';
import { useOverlayFocus } from '../../utils/useOverlayFocus';

interface HeroPickerOverlayProps {
  lang: Language;
  isOpen: boolean;
  onClose: () => void;
  allHeroes: Hero[];
  isLoading: boolean;
  draft: { radiant: Hero[]; dire: Hero[] };
  selectionSide: 'radiant' | 'dire';
  onSideChange: (side: 'radiant' | 'dire') => void;
  mySide: 'radiant' | 'dire';
  onMySideChange: (side: 'radiant' | 'dire') => void;
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
  mySide,
  onMySideChange,
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
    mySideLabel: lang === 'zh' ? '己方' : 'My side',
    editingSide: lang === 'zh' ? '编辑' : 'Editing',
    close: lang === 'zh' ? '关闭' : 'Close',
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

  const { closeRef, searchRef } = useOverlayFocus(isOpen);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div 
        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
        onClick={onClose}
      />
      
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="hero-picker-title"
        className="relative w-full h-full sm:h-auto sm:max-h-[85vh] sm:max-w-2xl bg-k3-surface sm:border sm:border-k3-border-subtle sm:rounded-lg flex flex-col overflow-hidden animate-in zoom-in-95 duration-200 sm:m-4 pt-safe pb-safe px-safe"
      >
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 sm:px-4 py-3 border-b border-k3-border-subtle bg-k3-surface sm:flex sm:flex-row sm:gap-3">
          <h2 id="hero-picker-title" className="font-semibold text-k3-text-primary text-sm sm:text-base truncate min-w-0 sm:flex-shrink-0">{t.title}</h2>
          <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0 sm:order-last">
            <button
              type="button"
              onClick={onReset}
              className="p-2.5 sm:p-2 text-k3-text-tertiary hover:text-k3-text-primary hover:bg-k3-elevated rounded-lg transition-colors min-w-[40px] min-h-[40px] flex items-center justify-center touch-manipulation"
              title={t.reset}
              aria-label={t.reset}
            >
              <RotateCcw size={18} className="sm:w-4 sm:h-4" />
            </button>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label={t.close}
              className="p-2.5 sm:p-2 text-k3-text-tertiary hover:text-k3-text-primary hover:bg-k3-elevated rounded-lg transition-colors min-w-[40px] min-h-[40px] flex items-center justify-center touch-manipulation"
            >
              <X size={20} className="sm:w-[18px] sm:h-[18px]" />
            </button>
          </div>
          <div className="col-span-2 sm:col-auto flex flex-col gap-1.5 min-w-0 sm:flex-1">
            <div className="flex items-center gap-1 min-w-0">
              <span className="text-[10px] text-k3-text-tertiary flex-shrink-0 w-8 sm:w-auto sm:mr-1">{t.mySideLabel}</span>
              <button
                type="button"
                onClick={() => onMySideChange('radiant')}
                data-testid="my-side-radiant"
                className={`flex-1 sm:flex-none px-2 sm:px-2.5 py-1.5 text-[10px] sm:text-xs font-medium rounded-lg transition-colors min-h-[36px] touch-manipulation ${
                  mySide === 'radiant'
                    ? 'bg-k3-radiant/15 text-k3-radiant border border-k3-radiant/30'
                    : 'text-k3-text-tertiary hover:bg-k3-elevated border border-transparent'
                }`}
              >
                {t.radiant}
              </button>
              <button
                type="button"
                onClick={() => onMySideChange('dire')}
                data-testid="my-side-dire"
                className={`flex-1 sm:flex-none px-2 sm:px-2.5 py-1.5 text-[10px] sm:text-xs font-medium rounded-lg transition-colors min-h-[36px] touch-manipulation ${
                  mySide === 'dire'
                    ? 'bg-k3-dire/15 text-k3-dire border border-k3-dire/30'
                    : 'text-k3-text-tertiary hover:bg-k3-elevated border border-transparent'
                }`}
              >
                {t.dire}
              </button>
            </div>
            <div className="flex items-center gap-1 min-w-0">
              <span className="text-[10px] text-k3-text-tertiary flex-shrink-0 w-8 sm:w-auto sm:mr-1">{t.editingSide}</span>
              <button
                type="button"
                onClick={() => onSideChange('radiant')}
                className={`flex-1 sm:flex-none px-2 sm:px-2.5 py-1.5 text-[10px] sm:text-xs font-medium rounded-lg transition-colors min-h-[40px] touch-manipulation ${
                  selectionSide === 'radiant'
                    ? 'bg-k3-radiant/15 text-k3-radiant border border-k3-radiant/30'
                    : 'text-k3-text-tertiary hover:bg-k3-elevated border border-transparent'
                }`}
              >
                {t.radiant} ({draft.radiant.length}/5)
              </button>
              <button
                type="button"
                onClick={() => onSideChange('dire')}
                className={`flex-1 sm:flex-none px-2 sm:px-2.5 py-1.5 text-[10px] sm:text-xs font-medium rounded-lg transition-colors min-h-[40px] touch-manipulation ${
                  selectionSide === 'dire'
                    ? 'bg-k3-dire/15 text-k3-dire border border-k3-dire/30'
                    : 'text-k3-text-tertiary hover:bg-k3-elevated border border-transparent'
                }`}
              >
                {t.dire} ({draft.dire.length}/5)
              </button>
            </div>
          </div>
        </div>

        {/* Filters - stack on mobile */}
        <div className="flex flex-col sm:flex-row gap-2 px-3 sm:px-4 py-2 border-b border-k3-border-subtle">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-k3-text-tertiary" size={16} />
            <input 
              ref={searchRef}
              type="text" 
              placeholder={t.search}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-k3-input border border-k3-border-subtle rounded-sm pl-10 pr-3 py-2.5 sm:py-2 text-base sm:text-sm text-k3-text-primary focus:outline-none focus:border-k3-text-tertiary placeholder:text-k3-text-tertiary"
            />
          </div>
          <div className="flex gap-1 overflow-x-auto pb-1 sm:pb-0 -mx-1 px-1 sm:mx-0 sm:px-0">
            {(['All', Attribute.STRENGTH, Attribute.AGILITY, Attribute.INTELLIGENCE, Attribute.UNIVERSAL] as const).map(attr => (
              <button
                key={attr}
                onClick={() => setAttrFilter(attr)}
                className={`px-2.5 py-2 sm:py-1.5 rounded-sm text-[11px] sm:text-[10px] font-medium uppercase transition-colors min-h-[40px] min-w-[44px] flex-shrink-0 touch-manipulation ${
                  attrFilter === attr 
                    ? 'bg-k3-text-primary text-k3-base' 
                    : 'text-k3-text-tertiary hover:text-k3-text-secondary hover:bg-k3-elevated'
                }`}
              >
                {attr === 'All' ? t.all : attr.substring(0,3)}
              </button>
            ))}
          </div>
        </div>
        
        {/* Hero Grid - responsive columns, touch-friendly cells */}
        <div className="flex-1 overflow-y-auto p-2 sm:p-3 custom-scrollbar">
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-k3-text-tertiary text-sm">
              <div className="w-5 h-5 border-2 border-k3-text-secondary border-t-transparent rounded-full animate-spin mr-3" />
              Loading heroes...
            </div>
          ) : (
            <div className="grid grid-cols-4 sm:grid-cols-8 md:grid-cols-10 gap-1.5 sm:gap-1.5">
              {filteredHeroes.map(hero => {
                const isPicked = pickedIds.has(hero.id);
                return (
                  <button 
                    key={hero.id} 
                    disabled={isPicked}
                    className={`relative group aspect-[3/4] rounded-sm overflow-hidden transition-all border touch-manipulation ${
                      isPicked 
                        ? 'opacity-30 grayscale cursor-not-allowed border-transparent' 
                        : 'border-transparent hover:border-k3-text-tertiary active:scale-95 sm:hover:scale-105'
                    }`}
                    onClick={() => !isPicked && onSelectHero(hero)}
                  >
                    <img 
                      src={hero.img} 
                      alt={hero.name}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent py-1 px-0.5">
                      <span className="text-[9px] sm:text-[9px] text-k3-text-secondary block text-center truncate">
                        {lang === 'zh' ? (hero.nameZh || hero.name) : hero.name}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Current Draft Preview - compact on mobile */}
        <div className="px-3 sm:px-4 py-2 sm:py-3 border-t border-k3-border-subtle bg-k3-base flex-shrink-0 min-w-0">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 min-w-0 overflow-x-auto scrollbar-hide">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-k3-radiant text-[10px] sm:text-xs font-medium flex-shrink-0">{t.radiant}</span>
              <div className="flex gap-0.5 min-w-0">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={`rad-preview-${i}`} className="w-8 h-8 rounded-sm bg-k3-surface border border-k3-border-subtle overflow-hidden flex-shrink-0">
                    {draft.radiant[i] && (
                      <img src={draft.radiant[i].img} alt="" className="w-full h-full object-cover" />
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-k3-dire text-[10px] sm:text-xs font-medium flex-shrink-0 md:hidden">{t.dire}</span>
              <div className="flex gap-0.5 min-w-0">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={`dire-preview-${i}`} className="w-8 h-8 rounded-sm bg-k3-surface border border-k3-border-subtle overflow-hidden flex-shrink-0">
                    {draft.dire[i] && (
                      <img src={draft.dire[i].img} alt="" className="w-full h-full object-cover" />
                    )}
                  </div>
                ))}
              </div>
              <span className="text-k3-dire text-[10px] sm:text-xs font-medium flex-shrink-0 hidden md:inline">{t.dire}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default HeroPickerOverlay;
