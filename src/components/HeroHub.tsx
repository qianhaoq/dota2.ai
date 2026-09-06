import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Hero, Attribute, Language } from '../types';
import { fetchHeroes } from '../services/dotaApiService';
import HeroDetail from './HeroDetail';
import { Search, Shield, Sword, Book, Zap, X, ChevronLeft, Users } from 'lucide-react';

interface HeroHubProps {
  lang: Language;
  initialHeroId?: number;
  onClose?: () => void;
}

const ATTR_CONFIG = {
  [Attribute.STRENGTH]: { icon: Shield, color: 'text-red-500', bgColor: 'bg-red-500/20', label: { zh: '力量', en: 'STR' } },
  [Attribute.AGILITY]: { icon: Sword, color: 'text-green-500', bgColor: 'bg-green-500/20', label: { zh: '敏捷', en: 'AGI' } },
  [Attribute.INTELLIGENCE]: { icon: Book, color: 'text-blue-500', bgColor: 'bg-blue-500/20', label: { zh: '智力', en: 'INT' } },
  [Attribute.UNIVERSAL]: { icon: Zap, color: 'text-purple-500', bgColor: 'bg-purple-500/20', label: { zh: '全能', en: 'UNI' } },
};

const HeroHub: React.FC<HeroHubProps> = ({ lang, initialHeroId, onClose }) => {
  const [allHeroes, setAllHeroes] = useState<Hero[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [attrFilter, setAttrFilter] = useState<Attribute | 'All'>('All');
  const [selectedHeroId, setSelectedHeroId] = useState<number | null>(initialHeroId || null);

  useEffect(() => {
    const loadHeroes = async () => {
      setIsLoading(true);
      const heroes = await fetchHeroes(lang);
      setAllHeroes(heroes);
      setIsLoading(false);
    };
    loadHeroes();
  }, [lang]);

  useEffect(() => {
    if (initialHeroId) {
      setSelectedHeroId(initialHeroId);
    }
  }, [initialHeroId]);

  const t = useMemo(() => ({
    title: lang === 'zh' ? '英雄百科' : 'Hero Encyclopedia',
    subtitle: lang === 'zh' ? '探索刀塔世界的传奇英雄' : 'Explore legendary heroes of Dota',
    search: lang === 'zh' ? '搜索英雄名称或别名...' : 'Search hero name or alias...',
    all: lang === 'zh' ? '全部' : 'All',
    totalHeroes: lang === 'zh' ? '共 {count} 位英雄' : '{count} heroes total',
    noResults: lang === 'zh' ? '未找到匹配的英雄' : 'No heroes found',
    back: lang === 'zh' ? '返回列表' : 'Back to list',
    clickToView: lang === 'zh' ? '点击查看详情' : 'Click to view details',
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

  const groupedHeroes = useMemo(() => {
    const groups: Record<Attribute, Hero[]> = {
      [Attribute.STRENGTH]: [],
      [Attribute.AGILITY]: [],
      [Attribute.INTELLIGENCE]: [],
      [Attribute.UNIVERSAL]: [],
    };
    filteredHeroes.forEach(hero => {
      if (groups[hero.attribute]) {
        groups[hero.attribute].push(hero);
      }
    });
    return groups;
  }, [filteredHeroes]);

  const handleHeroClick = useCallback((heroId: number) => {
    setSelectedHeroId(heroId);
  }, []);

  const handleBack = useCallback(() => {
    setSelectedHeroId(null);
  }, []);

  if (selectedHeroId) {
    return (
      <div className="h-full flex flex-col bg-[#0a0a0a] px-4 py-4">
        <button
          onClick={handleBack}
          className="flex items-center gap-2 text-gray-400 hover:text-white mb-4 transition-colors"
        >
          <ChevronLeft size={20} />
          <span>{t.back}</span>
        </button>
        <HeroDetail heroId={selectedHeroId} lang={lang} onClose={handleBack} />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-[#0a0a0a] px-4 py-4">
      {/* Header - Cleaner design */}
      <div className="max-w-6xl mx-auto w-full flex-shrink-0 mb-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center">
              <Users size={20} className="text-gray-300" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">{t.title}</h2>
              <p className="text-sm text-gray-500">{t.subtitle}</p>
            </div>
          </div>
          
          {onClose && (
            <button
              onClick={onClose}
              className="p-2 hover:bg-white/10 rounded-lg transition-colors"
            >
              <X size={20} className="text-gray-400" />
            </button>
          )}
        </div>

        {/* Search and Filters - Cleaner */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" size={18} />
            <input
              type="text"
              placeholder={t.search}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-[#1a1a1a] border border-white/10 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white focus:outline-none focus:border-white/20 transition-colors placeholder-gray-500"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white"
              >
                <X size={16} />
              </button>
            )}
          </div>

          <div className="flex gap-1.5">
            <button
              onClick={() => setAttrFilter('All')}
              className={`px-3 py-2 rounded-xl text-sm font-medium transition-colors ${
                attrFilter === 'All'
                  ? 'bg-white/15 text-white'
                  : 'bg-white/5 text-gray-400 hover:text-white hover:bg-white/10'
              }`}
            >
              {t.all}
            </button>
            {Object.entries(ATTR_CONFIG).map(([attr, config]) => {
              const Icon = config.icon;
              const isActive = attrFilter === attr;
              return (
                <button
                  key={attr}
                  onClick={() => setAttrFilter(attr as Attribute)}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium transition-colors ${
                    isActive
                      ? `${config.bgColor} ${config.color}`
                      : 'bg-white/5 text-gray-400 hover:text-white hover:bg-white/10'
                  }`}
                >
                  <Icon size={16} />
                  <span className="hidden sm:inline">{config.label[lang]}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-3 text-xs text-gray-500">
          {t.totalHeroes.replace('{count}', filteredHeroes.length.toString())}
          {' • '}
          <span className="text-gray-400">{t.clickToView}</span>
        </div>
      </div>

      {/* Hero Grid */}
      <div className="flex-1 overflow-y-auto custom-scrollbar max-w-6xl mx-auto w-full">
        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <div className="flex flex-col items-center gap-3">
              <div className="w-8 h-8 border-2 border-white/20 border-t-white rounded-full animate-spin" />
              <span className="text-gray-400 text-sm">Loading heroes...</span>
            </div>
          </div>
        ) : filteredHeroes.length === 0 ? (
          <div className="flex items-center justify-center h-64">
            <div className="text-center">
              <p className="text-gray-400 text-lg">{t.noResults}</p>
              <button
                onClick={() => { setSearchQuery(''); setAttrFilter('All'); }}
                className="mt-3 text-white hover:underline text-sm"
              >
                {lang === 'zh' ? '清除筛选' : 'Clear filters'}
              </button>
            </div>
          </div>
        ) : attrFilter === 'All' ? (
          <div className="space-y-6">
            {Object.entries(groupedHeroes).map(([attr, heroes]) => {
              if (heroes.length === 0) return null;
              const config = ATTR_CONFIG[attr as Attribute];
              const Icon = config.icon;
              return (
                <div key={attr} className="bg-[#111111] border border-white/5 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <Icon size={18} className={config.color} />
                    <h3 className={`font-semibold ${config.color}`}>
                      {config.label[lang]}
                    </h3>
                    <span className="text-xs text-gray-500">({heroes.length})</span>
                  </div>
                  <div className="grid grid-cols-5 sm:grid-cols-8 md:grid-cols-10 lg:grid-cols-12 gap-2">
                    {heroes.map(hero => (
                      <HeroGridItem
                        key={hero.id}
                        hero={hero}
                        onClick={() => handleHeroClick(hero.id)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="bg-[#111111] border border-white/5 rounded-xl p-4">
            <div className="grid grid-cols-5 sm:grid-cols-8 md:grid-cols-10 lg:grid-cols-12 gap-2">
              {filteredHeroes.map(hero => (
                <HeroGridItem
                  key={hero.id}
                  hero={hero}
                  onClick={() => handleHeroClick(hero.id)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

interface HeroGridItemProps {
  hero: Hero;
  onClick: () => void;
}

const HeroGridItem: React.FC<HeroGridItemProps> = ({ hero, onClick }) => {
  const [imgError, setImgError] = useState(false);

  return (
    <div
      onClick={onClick}
      className="group cursor-pointer"
    >
      <div className="relative aspect-[3/4] rounded-lg overflow-hidden border border-white/10 group-hover:border-white/30 transition-all duration-200 group-hover:scale-105">
        {!imgError ? (
          <img
            src={hero.img}
            alt={hero.name}
            onError={() => setImgError(true)}
            className="w-full h-full object-cover opacity-90 group-hover:opacity-100 transition-opacity"
          />
        ) : (
          <div className="w-full h-full bg-[#1a1a1a] flex items-center justify-center">
            <span className="text-xs text-gray-500 text-center px-1">{hero.name}</span>
          </div>
        )}
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent p-1.5">
          <p className="text-[9px] sm:text-[10px] text-white font-medium truncate text-center leading-tight">
            {hero.name}
          </p>
        </div>
      </div>
    </div>
  );
};

export default HeroHub;
