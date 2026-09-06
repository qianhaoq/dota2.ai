import React, { useState, useMemo } from 'react';
import { Hero, Attribute, Language } from '../../types';
import { X, Search } from 'lucide-react';

interface MentorPickerProps {
  lang: Language;
  isOpen: boolean;
  onClose: () => void;
  allHeroes: Hero[];
  isLoading: boolean;
  currentMentor: Hero | null;
  onSelectMentor: (hero: Hero) => void;
  onDismissMentor: () => void;
}

const MentorPicker: React.FC<MentorPickerProps> = ({
  lang,
  isOpen,
  onClose,
  allHeroes,
  isLoading,
  currentMentor,
  onSelectMentor,
  onDismissMentor,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [attrFilter, setAttrFilter] = useState<Attribute | 'All'>('All');

  const t = useMemo(() => ({
    title: lang === 'zh' ? '选英雄练习' : 'Pick a hero to practice',
    hint: lang === 'zh'
      ? '拉比克在线。选一位你要练的英雄。'
      : 'Rubick is live. Pick the hero you want to practice.',
    search: lang === 'zh' ? '搜索英雄...' : 'Search heroes...',
    dismiss: lang === 'zh' ? '清除练习' : 'Clear practice',
    all: lang === 'zh' ? '全部' : 'All',
    currentMentor: lang === 'zh' ? '当前练习' : 'Practicing',
    selectHim: lang === 'zh' ? '跟拉比克练这个' : 'Drill this with Rubick',
    close: lang === 'zh' ? '关闭' : 'Close',
  }), [lang]);

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

  const handleSelect = (hero: Hero) => {
    onSelectMentor(hero);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
        onClick={onClose}
      />

      <div className="relative w-full h-full sm:h-auto sm:max-h-[85vh] sm:max-w-2xl bg-k3-surface sm:border sm:border-k3-border-subtle sm:rounded-lg flex flex-col overflow-hidden animate-in zoom-in-95 duration-200 sm:m-4 pt-safe pb-safe">
        <div className="px-3 sm:px-4 py-3 sm:py-4 border-b border-k3-border-subtle bg-k3-surface">
          <div className="flex items-center justify-between mb-1 sm:mb-2">
            <h2 className="font-semibold text-k3-text-primary text-base sm:text-lg">{t.title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label={t.close}
              className="p-2.5 sm:p-2 text-k3-text-tertiary hover:text-k3-text-primary hover:bg-k3-elevated rounded-lg transition-colors min-w-[40px] min-h-[40px] flex items-center justify-center touch-manipulation"
            >
              <X size={20} className="sm:w-[18px] sm:h-[18px]" />
            </button>
          </div>
          <p className="text-xs sm:text-sm text-k3-text-secondary">{t.hint}</p>
        </div>

        {currentMentor && (
          <div className="px-3 sm:px-4 py-3 border-b border-k3-border-subtle bg-k3-base">
            <div className="flex items-center gap-2 sm:gap-3">
              <img
                src={currentMentor.img}
                alt={currentMentor.name}
                className="w-10 h-10 sm:w-12 sm:h-12 rounded-lg object-cover border border-k3-border-subtle flex-shrink-0"
              />
              <div className="flex-1 min-w-0">
                <span className="text-[10px] sm:text-xs text-k3-text-tertiary block">{t.currentMentor}</span>
                <span className="text-k3-text-primary font-medium text-sm sm:text-base truncate block">
                  {lang === 'zh' ? (currentMentor.nameZh || currentMentor.name) : currentMentor.name}
                </span>
                <span className="text-[10px] sm:text-xs text-k3-text-secondary">{t.selectHim}</span>
              </div>
              <button
                onClick={() => {
                  onDismissMentor();
                  onClose();
                }}
                className="px-2 sm:px-3 py-1.5 text-xs text-k3-text-tertiary hover:text-k3-dire hover:bg-k3-dire/10 rounded-lg transition-colors border border-k3-border-subtle min-h-[40px] touch-manipulation flex-shrink-0"
              >
                {t.dismiss}
              </button>
            </div>
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-2 px-3 sm:px-4 py-2 border-b border-k3-border-subtle">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-k3-text-tertiary" size={16} />
            <input
              type="text"
              placeholder={t.search}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-k3-input border border-k3-border-subtle rounded-sm pl-10 pr-3 py-2.5 sm:py-2 text-base sm:text-sm text-k3-text-primary focus:outline-none focus:border-k3-text-tertiary placeholder:text-k3-text-tertiary"
              autoFocus={typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches}
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

        <div className="flex-1 overflow-y-auto p-2 sm:p-3 custom-scrollbar">
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-k3-text-tertiary text-sm">
              <div className="w-5 h-5 border-2 border-k3-text-secondary border-t-transparent rounded-full animate-spin mr-3" />
              Loading heroes...
            </div>
          ) : (
            <div className="grid grid-cols-4 sm:grid-cols-8 md:grid-cols-10 gap-1.5">
              {filteredHeroes.map(hero => {
                const isCurrentMentor = currentMentor?.id === hero.id;
                return (
                  <button
                    key={hero.id}
                    className={`relative group aspect-[3/4] rounded-sm overflow-hidden transition-all border touch-manipulation ${
                      isCurrentMentor
                        ? 'border-k3-text-primary ring-1 ring-k3-text-primary'
                        : 'border-transparent hover:border-k3-text-tertiary active:scale-95 sm:hover:scale-105'
                    }`}
                    onClick={() => handleSelect(hero)}
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
                    {isCurrentMentor && (
                      <div className="absolute top-1 right-1 w-2 h-2 rounded-full bg-k3-text-primary" />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default MentorPicker;
