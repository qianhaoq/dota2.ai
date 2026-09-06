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
      case 'analyze': return <Sparkles size={14} className="text-k3-text-secondary" />;
      case 'playbook': return <Target size={14} className="text-k3-text-secondary" />;
      case 'suggest': return <TrendingUp size={14} className="text-k3-text-secondary" />;
      case 'meta': return <BarChart3 size={14} className="text-k3-text-secondary" />;
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
              <h3 key={idx} className="text-k3-text-primary font-semibold text-sm mt-4 mb-2 flex items-center gap-2">
                <span className="w-1 h-4 bg-k3-text-tertiary rounded-full" />
                {line.replace('## ', '')}
              </h3>
            );
          }
          if (line.startsWith('### ')) {
            return <h4 key={idx} className="text-k3-text-primary font-medium text-sm mt-3 mb-1.5">{line.replace('### ', '')}</h4>;
          }
          if (line.startsWith('**') && line.endsWith('**')) {
            return <strong key={idx} className="block mt-2 text-k3-text-primary text-sm">{line.replace(/\*\*/g, '')}</strong>;
          }
          if (line.startsWith('- ') || line.startsWith('* ')) {
            return (
              <li key={idx} className="ml-3 text-k3-text-secondary text-sm leading-relaxed flex items-start gap-2 my-0.5">
                <span className="w-1.5 h-1.5 rounded-full bg-k3-text-tertiary mt-2 flex-shrink-0" />
                <span>{line.replace(/^[-*] /, '')}</span>
              </li>
            );
          }
          if (line.trim() === '') return <div key={idx} className="h-2" />;
          return <p key={idx} className="text-k3-text-secondary text-sm leading-relaxed">{line}</p>;
        })}
        {shouldCollapse && (
          <button 
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="mt-3 flex items-center gap-1.5 text-xs text-k3-text-secondary hover:text-k3-text-primary transition-colors underline"
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
        <div className="max-w-[70%] bg-k3-elevated rounded-lg px-4 py-2.5 border border-k3-border-subtle">
          <div className="flex items-center gap-2 text-sm text-k3-text-primary">
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
        {/* AI indicator */}
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs text-k3-text-tertiary">AI Coach</span>
        </div>

        {/* Grounded indicator */}
        {!message.isStreaming && message.grounded !== undefined && (
          <div className={`inline-flex items-center gap-1.5 text-[10px] px-2 py-1 rounded-full ${
            message.grounded 
              ? 'bg-k3-radiant/10 text-k3-radiant border border-k3-radiant/20' 
              : 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20'
          }`}>
            {message.grounded ? <Check size={10} /> : <AlertTriangle size={10} />}
            {message.grounded ? t.grounded : t.ungrounded}
          </div>
        )}

        {/* Matchup chips - team semantics only */}
        {message.matchupData && (message.matchupData.radiantAdvantages.length > 0 || message.matchupData.direAdvantages.length > 0) && (
          <div className="flex flex-wrap gap-1.5">
            {message.matchupData.radiantAdvantages.slice(0, 3).map((adv, idx) => (
              <span key={`rad-${idx}`} className="inline-flex items-center gap-1 text-[10px] px-2 py-1 bg-k3-radiant/10 border border-k3-radiant/20 rounded-full">
                <Zap size={10} className="text-k3-radiant" />
                <span className="text-k3-radiant font-medium">{adv.hero}</span>
                <span className="text-k3-text-tertiary">{t.vs}</span>
                <span className="text-k3-text-secondary">{adv.vsHero}</span>
                <span className="text-k3-radiant font-bold">+{adv.advantage.toFixed(1)}%</span>
              </span>
            ))}
            {message.matchupData.direAdvantages.slice(0, 3).map((adv, idx) => (
              <span key={`dire-${idx}`} className="inline-flex items-center gap-1 text-[10px] px-2 py-1 bg-k3-dire/10 border border-k3-dire/20 rounded-full">
                <Zap size={10} className="text-k3-dire" />
                <span className="text-k3-dire font-medium">{adv.hero}</span>
                <span className="text-k3-text-tertiary">{t.vs}</span>
                <span className="text-k3-text-secondary">{adv.vsHero}</span>
                <span className="text-k3-dire font-bold">+{adv.advantage.toFixed(1)}%</span>
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
                <div key={hero.heroId} className="bg-k3-surface rounded-sm p-3 border border-k3-border-subtle">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-k3-text-primary text-sm font-medium">{heroDisplayName}</span>
                    {heroDisplayRoles && heroDisplayRoles.length > 0 && (
                      <span className="text-k3-text-tertiary text-[10px] bg-k3-elevated px-1.5 py-0.5 rounded">{heroDisplayRoles.slice(0, 2).join(' / ')}</span>
                    )}
                    {hero.winRate && (
                      <span className="text-k3-radiant text-[10px] ml-auto font-mono">{t.winRate}: {hero.winRate}%</span>
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
                        <span className="text-k3-text-tertiary text-[9px] w-6">{label}</span>
                        <div className="flex gap-0.5">
                          {items.slice(0, 4).map((item, idx) => (
                            <img key={idx} src={item.img} alt={item.name} title={item.name} className="w-5 h-5 rounded border border-k3-border-subtle" />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  {hero.vsEnemies.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2 pt-2 border-t border-k3-border-subtle">
                      {hero.vsEnemies.slice(0, 3).map((vs, idx) => {
                        const adv = parseFloat(vs.advantage);
                        const enemyName = lang === 'zh' ? (vs.enemyNameZh || vs.enemy) : (vs.enemyNameEn || vs.enemy);
                        return (
                          <span 
                            key={idx}
                            className={`text-[9px] px-1.5 py-0.5 rounded ${
                              adv >= 0 ? 'bg-k3-radiant/10 text-k3-radiant' : 'bg-k3-dire/10 text-k3-dire'
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
                  className="flex items-center gap-2 p-2.5 bg-k3-surface hover:bg-k3-elevated border border-k3-border-subtle rounded-sm transition-all text-left group"
                >
                  <div className="flex-1 min-w-0">
                    <span className="text-k3-text-primary text-xs font-medium block truncate">{suggestionName}</span>
                    {suggestionRoles && suggestionRoles.length > 0 && (
                      <span className="text-k3-text-tertiary text-[9px]">{suggestionRoles.slice(0, 2).join(' / ')}</span>
                    )}
                  </div>
                  {s.bestAdvantage && parseFloat(s.bestAdvantage) > 0 && (
                    <span className="text-k3-radiant text-[10px] font-bold flex-shrink-0">+{s.bestAdvantage}%</span>
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
                  className="flex items-center gap-2 p-2 bg-k3-surface hover:bg-k3-elevated rounded-sm transition-colors text-left group border border-k3-border-subtle"
                >
                  <span className={`w-5 h-5 flex items-center justify-center text-[10px] font-bold rounded-sm ${
                    hero.tier === 'S' ? 'bg-k3-text-primary text-k3-base' :
                    hero.tier === 'A' ? 'bg-k3-radiant/20 text-k3-radiant' :
                    'bg-k3-elevated text-k3-text-tertiary'
                  }`}>
                    {hero.tier}
                  </span>
                  <img src={hero.icon} alt="" className="w-5 h-5 rounded-sm" />
                  <span className="text-k3-text-primary text-xs flex-1 truncate">{displayName}</span>
                  {displayRoles && displayRoles.length > 0 && (
                    <span className="text-k3-text-tertiary text-[9px] hidden sm:inline">{displayRoles.slice(0, 2).join('/')}</span>
                  )}
                  <span className="text-k3-radiant text-[10px] font-mono">{hero.winRate.toFixed(1)}%</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Text content - lighter AI bubble */}
        {message.content && (
          <div className="bg-k3-surface rounded-lg px-4 py-3 border border-k3-border-subtle">
            {renderMarkdown(message.content)}
            {message.isStreaming && (
              <span className="inline-block w-0.5 h-4 bg-k3-text-secondary animate-pulse ml-0.5 -mb-0.5" />
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ChatMessage;
