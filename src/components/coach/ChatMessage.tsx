import React, { useState } from 'react';
import { Language, Hero } from '../../types';
import { 
  Sparkles, Target, TrendingUp, BarChart3, Zap, 
  ChevronDown, ChevronUp, Check, AlertTriangle 
} from 'lucide-react';
import { MatchupData, HeroSuggestion, TierHero, PlaybookHero } from '../../services/geminiService';

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

interface ChatMessageProps {
  message: CoachMessage;
  lang: Language;
  allHeroes: Hero[];
  onSelectHero: (hero: Hero) => void;
}

const ChatMessage: React.FC<ChatMessageProps> = ({ message, lang, allHeroes, onSelectHero }) => {
  const [isCollapsed, setIsCollapsed] = useState(false);

  const t = {
    grounded: lang === 'zh' ? '基于 OpenDota 数据' : 'Grounded in OpenDota',
    ungrounded: lang === 'zh' ? '数据未验证' : 'Unverified',
    vs: lang === 'zh' ? '对' : 'vs',
    winRate: lang === 'zh' ? '胜率' : 'WR',
    start: lang === 'zh' ? '出门' : 'Start',
    early: lang === 'zh' ? '前期' : 'Early',
    mid: lang === 'zh' ? '中期' : 'Mid',
    late: lang === 'zh' ? '后期' : 'Late',
    showMore: lang === 'zh' ? '展开详情' : 'Show more',
    showLess: lang === 'zh' ? '收起' : 'Show less',
  };

  const ActionIcon = ({ action }: { action?: string }) => {
    switch (action) {
      case 'analyze': return <Sparkles size={14} className="text-amber-400" />;
      case 'playbook': return <Target size={14} className="text-blue-400" />;
      case 'suggest': return <TrendingUp size={14} className="text-emerald-400" />;
      case 'meta': return <BarChart3 size={14} className="text-purple-400" />;
      default: return null;
    }
  };

  const renderMarkdown = (text: string) => {
    const lines = text.split('\n');
    const hasMultipleSections = lines.filter(l => l.startsWith('## ')).length > 1;
    const shouldCollapse = hasMultipleSections && text.length > 800;

    const displayLines = shouldCollapse && isCollapsed 
      ? lines.slice(0, lines.findIndex((l, i) => i > 0 && l.startsWith('## ')) || 15)
      : lines;

    return (
      <>
        {displayLines.map((line, idx) => {
          if (line.startsWith('## ')) {
            return (
              <h3 key={idx} className="text-amber-400 font-semibold text-sm mt-4 mb-2 flex items-center gap-2">
                <span className="w-1 h-4 bg-amber-500/50 rounded-full" />
                {line.replace('## ', '')}
              </h3>
            );
          }
          if (line.startsWith('### ')) {
            return <h4 key={idx} className="text-gray-200 font-medium text-sm mt-3 mb-1.5">{line.replace('### ', '')}</h4>;
          }
          if (line.startsWith('**') && line.endsWith('**')) {
            return <strong key={idx} className="block mt-2 text-gray-100 text-sm">{line.replace(/\*\*/g, '')}</strong>;
          }
          if (line.startsWith('- ') || line.startsWith('* ')) {
            return (
              <li key={idx} className="ml-3 text-gray-300 text-sm leading-relaxed flex items-start gap-2 my-0.5">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500/40 mt-2 flex-shrink-0" />
                <span>{line.replace(/^[-*] /, '')}</span>
              </li>
            );
          }
          if (line.trim() === '') return <div key={idx} className="h-2" />;
          return <p key={idx} className="text-gray-300 text-sm leading-relaxed">{line}</p>;
        })}
        {shouldCollapse && (
          <button 
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="mt-3 flex items-center gap-1.5 text-xs text-amber-400 hover:text-amber-300 transition-colors"
          >
            {isCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            {isCollapsed ? t.showMore : t.showLess}
          </button>
        )}
      </>
    );
  };

  if (message.type === 'user') {
    return (
      <div className="flex justify-end mb-4">
        <div className="max-w-[85%] sm:max-w-[75%] bg-white/5 backdrop-blur border border-white/10 rounded-2xl rounded-tr-sm px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm text-gray-200">
            <ActionIcon action={message.action} />
            <span>{message.content}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start mb-5">
      <div className="max-w-[90%] sm:max-w-[85%] space-y-3">
        {/* Grounded indicator */}
        {!message.isStreaming && message.grounded !== undefined && (
          <div className={`inline-flex items-center gap-1.5 text-[10px] px-2 py-1 rounded-full ${
            message.grounded 
              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' 
              : 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20'
          }`}>
            {message.grounded ? <Check size={10} /> : <AlertTriangle size={10} />}
            {message.grounded ? t.grounded : t.ungrounded}
          </div>
        )}

        {/* Matchup chips */}
        {message.matchupData && (message.matchupData.radiantAdvantages.length > 0 || message.matchupData.direAdvantages.length > 0) && (
          <div className="flex flex-wrap gap-1.5">
            {message.matchupData.radiantAdvantages.slice(0, 3).map((adv, idx) => (
              <span key={`rad-${idx}`} className="inline-flex items-center gap-1 text-[10px] px-2 py-1 bg-emerald-500/10 border border-emerald-500/20 rounded-full">
                <Zap size={10} className="text-emerald-400" />
                <span className="text-emerald-300 font-medium">{adv.hero}</span>
                <span className="text-gray-500">{t.vs}</span>
                <span className="text-gray-400">{adv.vsHero}</span>
                <span className="text-emerald-400 font-bold">+{adv.advantage.toFixed(1)}%</span>
              </span>
            ))}
            {message.matchupData.direAdvantages.slice(0, 3).map((adv, idx) => (
              <span key={`dire-${idx}`} className="inline-flex items-center gap-1 text-[10px] px-2 py-1 bg-red-500/10 border border-red-500/20 rounded-full">
                <Zap size={10} className="text-red-400" />
                <span className="text-red-300 font-medium">{adv.hero}</span>
                <span className="text-gray-500">{t.vs}</span>
                <span className="text-gray-400">{adv.vsHero}</span>
                <span className="text-red-400 font-bold">+{adv.advantage.toFixed(1)}%</span>
              </span>
            ))}
          </div>
        )}

        {/* Playbook item builds */}
        {message.playbookData && message.playbookData.length > 0 && (
          <div className="space-y-2">
            {message.playbookData.map((hero) => {
              const heroDisplayName = lang === 'zh' ? (hero.nameZh || hero.heroName) : (hero.nameEn || hero.heroName);
              const heroDisplayRoles = lang === 'zh' && hero.rolesZh ? hero.rolesZh : hero.roles;
              return (
                <div key={hero.heroId} className="bg-white/5 rounded-xl p-3 border border-white/5">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-white text-sm font-medium">{heroDisplayName}</span>
                    {heroDisplayRoles && heroDisplayRoles.length > 0 && (
                      <span className="text-gray-500 text-[10px] bg-white/5 px-1.5 py-0.5 rounded">{heroDisplayRoles.slice(0, 2).join(' / ')}</span>
                    )}
                    {hero.winRate && (
                      <span className="text-emerald-400 text-[10px] ml-auto font-mono">{t.winRate}: {hero.winRate}%</span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {[
                      { items: hero.items.startGame, label: t.start },
                      { items: hero.items.earlyGame, label: t.early },
                      { items: hero.items.midGame, label: t.mid },
                      { items: hero.items.lateGame, label: t.late },
                    ].map(({ items, label }) => items.length > 0 && (
                      <div key={label} className="flex items-center gap-1">
                        <span className="text-gray-500 text-[9px] w-6">{label}</span>
                        <div className="flex gap-0.5">
                          {items.slice(0, 4).map((item, idx) => (
                            <img key={idx} src={item.img} alt={item.name} title={item.name} className="w-5 h-5 rounded border border-white/10" />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  {hero.vsEnemies.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2 pt-2 border-t border-white/5">
                      {hero.vsEnemies.slice(0, 3).map((vs, idx) => {
                        const adv = parseFloat(vs.advantage);
                        const enemyName = lang === 'zh' ? (vs.enemyNameZh || vs.enemy) : (vs.enemyNameEn || vs.enemy);
                        return (
                          <span 
                            key={idx}
                            className={`text-[9px] px-1.5 py-0.5 rounded ${
                              adv >= 0 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'
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
        {message.suggestions && message.suggestions.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {message.suggestions.slice(0, 6).map((s) => {
              const suggestionName = lang === 'zh' ? (s.nameZh || s.name) : (s.nameEn || s.name);
              const suggestionRoles = lang === 'zh' && s.rolesZh ? s.rolesZh : s.roles;
              return (
                <button
                  key={s.id}
                  onClick={() => {
                    const hero = allHeroes.find(h => h.id === s.id);
                    if (hero) onSelectHero(hero);
                  }}
                  className="flex items-center gap-2 p-2.5 bg-white/5 hover:bg-white/10 border border-white/5 hover:border-amber-500/30 rounded-xl transition-all text-left group"
                >
                  <div className="flex-1 min-w-0">
                    <span className="text-white text-xs font-medium block truncate group-hover:text-amber-400 transition-colors">{suggestionName}</span>
                    {suggestionRoles && suggestionRoles.length > 0 && (
                      <span className="text-gray-500 text-[9px]">{suggestionRoles.slice(0, 2).join(' / ')}</span>
                    )}
                  </div>
                  {s.bestAdvantage && parseFloat(s.bestAdvantage) > 0 && (
                    <span className="text-emerald-400 text-[10px] font-bold flex-shrink-0">+{s.bestAdvantage}%</span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Meta tier list */}
        {message.tierHeroes && message.tierHeroes.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {message.tierHeroes.slice(0, 10).map((hero) => {
              const displayName = lang === 'zh' ? (hero.nameZh || hero.name) : (hero.nameEn || hero.name);
              const displayRoles = lang === 'zh' && hero.rolesZh ? hero.rolesZh : hero.roles;
              return (
                <button 
                  key={hero.id}
                  onClick={() => {
                    const h = allHeroes.find(ah => ah.id === hero.id);
                    if (h) onSelectHero(h);
                  }}
                  className="flex items-center gap-2 p-2 bg-white/5 hover:bg-white/10 rounded-lg transition-colors text-left group"
                >
                  <span className={`w-5 h-5 flex items-center justify-center text-[10px] font-bold rounded ${
                    hero.tier === 'S' ? 'bg-amber-500/20 text-amber-400' :
                    hero.tier === 'A' ? 'bg-emerald-500/20 text-emerald-400' :
                    'bg-gray-600/20 text-gray-400'
                  }`}>
                    {hero.tier}
                  </span>
                  <img src={hero.icon} alt="" className="w-5 h-5 rounded" />
                  <span className="text-white text-xs flex-1 truncate group-hover:text-amber-400 transition-colors">{displayName}</span>
                  {displayRoles && displayRoles.length > 0 && (
                    <span className="text-gray-500 text-[9px] hidden sm:inline">{displayRoles.slice(0, 2).join('/')}</span>
                  )}
                  <span className="text-emerald-400 text-[10px] font-mono">{hero.winRate.toFixed(1)}%</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Text content */}
        {message.content && (
          <div className="bg-[#111111] rounded-2xl rounded-tl-sm px-4 py-3 border border-white/5">
            {renderMarkdown(message.content)}
            {message.isStreaming && (
              <span className="inline-block w-0.5 h-4 bg-amber-400 animate-pulse ml-0.5 -mb-0.5" />
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ChatMessage;
