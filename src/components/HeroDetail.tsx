import React, { useState, useEffect, useMemo } from 'react';
import { Language, Attribute } from '../types';
import { Shield, Sword, Book, Zap, Target, Heart, Sparkles, Clock, Droplet, Info, X } from 'lucide-react';

interface HeroAbility {
  key: string;
  name: string;
  description: string;
  lore?: string;
  img: string | null;
  behavior?: string;
  dmgType?: string;
  bkbPierce?: string;
  dispellable?: string;
  cooldown?: number | number[];
  manaCost?: number | number[];
  isUltimate?: boolean;
}

interface HeroBaseStats {
  baseHealth?: number;
  baseMana?: number;
  baseArmor?: number;
  baseMr?: number;
  baseAttackMin?: number;
  baseAttackMax?: number;
  baseStr?: number;
  baseAgi?: number;
  baseInt?: number;
  strGain?: number;
  agiGain?: number;
  intGain?: number;
  attackRange?: number;
  moveSpeed?: number;
}

interface HeroDetailData {
  id: number;
  name: string;
  nameZh: string;
  nameEn: string;
  aliases: string[];
  shortName: string;
  primaryAttr: string;
  attackType: string;
  roles: string[];
  rolesZh: string[];
  img: string;
  imgFull: string;
  imgVert: string;
  icon: string;
  winRate: string | null;
  pickRate: number | null;
  gamesPlayed: number | null;
  abilities: HeroAbility[];
  bio: string;
  baseStats: HeroBaseStats;
  complexity?: number;
}

interface HeroDetailProps {
  heroId: number;
  lang: Language;
  onClose?: () => void;
}

const ATTR_CONFIG: Record<string, { icon: any; color: string; bgColor: string; label: { zh: string; en: string } }> = {
  'str': { icon: Shield, color: 'text-red-500', bgColor: 'bg-red-500/20', label: { zh: '力量', en: 'Strength' } },
  'agi': { icon: Sword, color: 'text-green-500', bgColor: 'bg-green-500/20', label: { zh: '敏捷', en: 'Agility' } },
  'int': { icon: Book, color: 'text-blue-500', bgColor: 'bg-blue-500/20', label: { zh: '智力', en: 'Intelligence' } },
  'all': { icon: Zap, color: 'text-purple-500', bgColor: 'bg-purple-500/20', label: { zh: '全能', en: 'Universal' } },
};

const HeroDetail: React.FC<HeroDetailProps> = ({ heroId, lang, onClose }) => {
  const [hero, setHero] = useState<HeroDetailData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedAbility, setSelectedAbility] = useState<HeroAbility | null>(null);

  useEffect(() => {
    const fetchHeroDetail = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/meta/heroes/${heroId}?lang=${lang}`);
        if (!response.ok) {
          throw new Error('Failed to fetch hero detail');
        }
        const data = await response.json();
        setHero(data.hero);
        if (data.hero.abilities?.length > 0) {
          setSelectedAbility(data.hero.abilities[0]);
        }
      } catch (err: any) {
        setError(err.message || 'Unknown error');
      } finally {
        setIsLoading(false);
      }
    };
    fetchHeroDetail();
  }, [heroId, lang]);

  const t = useMemo(() => ({
    loading: lang === 'zh' ? '加载中...' : 'Loading...',
    error: lang === 'zh' ? '加载失败' : 'Failed to load',
    retry: lang === 'zh' ? '重试' : 'Retry',
    abilities: lang === 'zh' ? '技能' : 'Abilities',
    background: lang === 'zh' ? '背景故事' : 'Background',
    stats: lang === 'zh' ? '基础属性' : 'Base Stats',
    winRate: lang === 'zh' ? '胜率' : 'Win Rate',
    games: lang === 'zh' ? '场次' : 'Games',
    roles: lang === 'zh' ? '定位' : 'Roles',
    attackType: lang === 'zh' ? '攻击类型' : 'Attack Type',
    melee: lang === 'zh' ? '近战' : 'Melee',
    ranged: lang === 'zh' ? '远程' : 'Ranged',
    cooldown: lang === 'zh' ? '冷却' : 'CD',
    manaCost: lang === 'zh' ? '魔法消耗' : 'Mana',
    ultimate: lang === 'zh' ? '终极技能' : 'Ultimate',
    noAbilitySelected: lang === 'zh' ? '选择一个技能查看详情' : 'Select an ability to view details',
    noBio: lang === 'zh' ? '暂无官方背景' : 'No official lore available',
    health: lang === 'zh' ? '生命' : 'HP',
    mana: lang === 'zh' ? '魔法' : 'Mana',
    armor: lang === 'zh' ? '护甲' : 'Armor',
    damage: lang === 'zh' ? '攻击' : 'DMG',
    moveSpeed: lang === 'zh' ? '移速' : 'MS',
    range: lang === 'zh' ? '攻击距离' : 'Range',
    aliases: lang === 'zh' ? '别名' : 'Aliases',
  }), [lang]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-white/20 border-t-white rounded-full animate-spin" />
          <span className="text-gray-400">{t.loading}</span>
        </div>
      </div>
    );
  }

  if (error || !hero) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center">
          <p className="text-red-400 mb-3">{t.error}</p>
          <button
            onClick={() => window.location.reload()}
            className="text-white hover:underline"
          >
            {t.retry}
          </button>
        </div>
      </div>
    );
  }

  const attrConfig = ATTR_CONFIG[hero.primaryAttr] || ATTR_CONFIG['all'];
  const AttrIcon = attrConfig.icon;
  const displayRoles = lang === 'zh' ? hero.rolesZh : hero.roles;

  const formatCooldown = (cd: number | number[] | undefined): string => {
    if (!cd) return '-';
    if (Array.isArray(cd)) return cd.join('/');
    return cd.toString();
  };

  const formatManaCost = (mc: number | number[] | undefined): string => {
    if (!mc) return '-';
    if (Array.isArray(mc)) return mc.join('/');
    return mc.toString();
  };

  return (
    <div className="flex flex-col lg:flex-row gap-4 h-full overflow-y-auto lg:overflow-hidden">
      {/* Left Panel - Hero Info */}
      <div className="lg:w-1/3 flex-shrink-0 space-y-4">
        {/* Hero Card */}
        <div className="bg-[#111111] border border-white/5 rounded-xl overflow-hidden">
          <div className="relative h-48 sm:h-64">
            <img
              src={hero.imgVert}
              alt={hero.name}
              className="w-full h-full object-cover"
              onError={(e) => {
                (e.target as HTMLImageElement).src = hero.img;
              }}
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black via-black/30 to-transparent" />
            <div className="absolute bottom-0 left-0 right-0 p-4">
              <div className="flex items-center gap-2 mb-1">
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${attrConfig.bgColor} ${attrConfig.color}`}>
                  <AttrIcon size={12} />
                  {attrConfig.label[lang]}
                </span>
                <span className="text-xs text-gray-400">
                  {hero.attackType === 'Melee' ? t.melee : t.ranged}
                </span>
              </div>
              <h1 className="text-2xl font-display font-bold text-white">{hero.name}</h1>
              {hero.nameZh !== hero.nameEn && (
                <p className="text-sm text-gray-300">{lang === 'zh' ? hero.nameEn : hero.nameZh}</p>
              )}
            </div>
          </div>

          <div className="p-4 space-y-3">
            {/* Roles */}
            {displayRoles?.length > 0 && (
              <div>
                <span className="text-xs text-gray-500">{t.roles}</span>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {displayRoles.map((role, idx) => (
                    <span
                      key={idx}
                      className="px-2 py-0.5 bg-gray-800 rounded text-xs text-gray-300 border border-gray-700"
                    >
                      {role}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Aliases */}
            {hero.aliases?.length > 0 && (
              <div>
                <span className="text-xs text-gray-500">{t.aliases}</span>
                <p className="text-sm text-gray-400 mt-0.5">
                  {hero.aliases.slice(0, 5).join('、')}
                </p>
              </div>
            )}

            {/* Win Rate */}
            {hero.winRate && (
              <div className="flex items-center gap-4">
                <div>
                  <span className="text-xs text-gray-500">{t.winRate}</span>
                  <p className={`text-lg font-bold ${parseFloat(hero.winRate) >= 50 ? 'text-dota-green' : 'text-dota-red'}`}>
                    {hero.winRate}%
                  </p>
                </div>
                {hero.gamesPlayed && (
                  <div>
                    <span className="text-xs text-gray-500">{t.games}</span>
                    <p className="text-sm text-gray-300">{hero.gamesPlayed.toLocaleString()}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Base Stats */}
        {hero.baseStats && (
          <div className="bg-[#111111] border border-white/5 rounded-xl p-4">
            <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
              <Target size={16} className="text-dota-gold" />
              {t.stats}
            </h3>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="bg-gray-800/50 rounded-lg p-2">
                <Heart size={14} className="mx-auto text-red-400 mb-1" />
                <p className="text-xs text-gray-500">{t.health}</p>
                <p className="text-sm font-bold text-white">{hero.baseStats.baseHealth || '-'}</p>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-2">
                <Droplet size={14} className="mx-auto text-blue-400 mb-1" />
                <p className="text-xs text-gray-500">{t.mana}</p>
                <p className="text-sm font-bold text-white">{hero.baseStats.baseMana || '-'}</p>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-2">
                <Shield size={14} className="mx-auto text-yellow-400 mb-1" />
                <p className="text-xs text-gray-500">{t.armor}</p>
                <p className="text-sm font-bold text-white">{hero.baseStats.baseArmor?.toFixed(1) || '-'}</p>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-2">
                <Sword size={14} className="mx-auto text-orange-400 mb-1" />
                <p className="text-xs text-gray-500">{t.damage}</p>
                <p className="text-sm font-bold text-white">
                  {hero.baseStats.baseAttackMin && hero.baseStats.baseAttackMax
                    ? `${hero.baseStats.baseAttackMin}-${hero.baseStats.baseAttackMax}`
                    : '-'}
                </p>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-2">
                <Zap size={14} className="mx-auto text-green-400 mb-1" />
                <p className="text-xs text-gray-500">{t.moveSpeed}</p>
                <p className="text-sm font-bold text-white">{hero.baseStats.moveSpeed || '-'}</p>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-2">
                <Target size={14} className="mx-auto text-purple-400 mb-1" />
                <p className="text-xs text-gray-500">{t.range}</p>
                <p className="text-sm font-bold text-white">{hero.baseStats.attackRange || '-'}</p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Right Panel - Abilities & Lore */}
      <div className="flex-1 space-y-4 lg:overflow-y-auto lg:h-full custom-scrollbar">
        {/* Abilities */}
        {hero.abilities?.length > 0 && (
          <div className="bg-[#111111] border border-white/5 rounded-xl p-4">
            <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
              <Sparkles size={16} className="text-dota-gold" />
              {t.abilities}
            </h3>

            {/* Ability Icons */}
            <div className="flex flex-wrap gap-2 mb-4">
              {hero.abilities.map((ability) => (
                <button
                  key={ability.key}
                  onClick={() => setSelectedAbility(ability)}
                  className={`relative w-12 h-12 rounded-lg overflow-hidden border-2 transition-all ${
                    selectedAbility?.key === ability.key
                      ? 'border-dota-gold shadow-[0_0_10px_rgba(212,175,55,0.5)]'
                      : 'border-gray-700 hover:border-gray-500'
                  }`}
                >
                  {ability.img ? (
                    <img
                      src={ability.img}
                      alt={ability.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full bg-gray-800 flex items-center justify-center">
                      <Sparkles size={16} className="text-gray-600" />
                    </div>
                  )}
                  {ability.isUltimate && (
                    <div className="absolute top-0 right-0 w-2 h-2 bg-dota-gold rounded-full" />
                  )}
                </button>
              ))}
            </div>

            {/* Selected Ability Detail */}
            {selectedAbility ? (
              <div className="bg-gray-900/50 rounded-lg p-4 border border-gray-700">
                <div className="flex items-start gap-3 mb-3">
                  {selectedAbility.img && (
                    <img
                      src={selectedAbility.img}
                      alt={selectedAbility.name}
                      className="w-14 h-14 rounded-lg border border-gray-600"
                    />
                  )}
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h4 className="text-lg font-bold text-white">{selectedAbility.name}</h4>
                      {selectedAbility.isUltimate && (
                        <span className="px-1.5 py-0.5 bg-dota-gold/20 text-dota-gold text-xs rounded">
                          {t.ultimate}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-4 mt-1 text-xs text-gray-400">
                      {selectedAbility.cooldown && (
                        <span className="flex items-center gap-1">
                          <Clock size={12} />
                          {t.cooldown}: {formatCooldown(selectedAbility.cooldown)}s
                        </span>
                      )}
                      {selectedAbility.manaCost && (
                        <span className="flex items-center gap-1">
                          <Droplet size={12} className="text-blue-400" />
                          {t.manaCost}: {formatManaCost(selectedAbility.manaCost)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <p className="text-sm text-gray-300 leading-relaxed">
                  {selectedAbility.description || (lang === 'zh' ? '暂无描述' : 'No description available')}
                </p>
                {selectedAbility.lore && (
                  <p className="mt-3 text-xs text-gray-500 italic border-l-2 border-dota-gold/30 pl-3">
                    {selectedAbility.lore}
                  </p>
                )}
              </div>
            ) : (
              <div className="bg-gray-900/50 rounded-lg p-6 text-center text-gray-500 border border-gray-700">
                <Info size={24} className="mx-auto mb-2 opacity-50" />
                <p className="text-sm">{t.noAbilitySelected}</p>
              </div>
            )}
          </div>
        )}

        {/* Background/Lore */}
        <div className="bg-[#111111] border border-white/5 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
            <Book size={16} className="text-dota-gold" />
            {t.background}
          </h3>
          <div className="bg-gray-900/50 rounded-lg p-4 border border-gray-700">
            <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-line">
              {hero.bio || t.noBio}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default HeroDetail;
