import React, { useMemo, useState } from 'react';
import { Language, Hero, A2UIBlock, A2UIAction } from '../../types';
import {
  Sparkles, Target, TrendingUp, BarChart3, Zap,
  ChevronDown, ChevronUp, Check, AlertTriangle,
} from 'lucide-react';
import { MatchupData, TierHero, PlaybookHero } from '../../services/geminiService';
import type { CoachSession } from './coachMessage';
import { sessionTitle } from '../../utils/coachBlocks';

interface ResultCardProps {
  session: CoachSession;
  lang: Language;
  allHeroes: Hero[];
  onSelectHero: (hero: Hero) => void;
  mentorName?: string;
  expanded?: boolean;
}

const MarkdownBody: React.FC<{ text: string; streaming?: boolean }> = ({ text, streaming }) => {
  const lines = text.split('\n');
  return (
    <>
      {lines.map((line, idx) => {
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
              <span className="min-w-0 break-words">{line.replace(/^[-*] /, '')}</span>
            </li>
          );
        }
        if (line.trim() === '') return <div key={idx} className="h-2" />;
        return <p key={idx} className="text-k3-text-secondary text-sm leading-relaxed break-words">{line}</p>;
      })}
      {streaming && (
        <span className="inline-block w-0.5 h-4 bg-k3-text-secondary animate-pulse ml-0.5 align-middle" />
      )}
    </>
  );
};

const ResultCard: React.FC<ResultCardProps> = ({
  session,
  lang,
  allHeroes,
  onSelectHero,
  mentorName,
  expanded = true,
}) => {
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const message = session.message;

  const t = useMemo(() => ({
    grounded: lang === 'zh' ? '基于 OpenDota 数据' : 'Grounded in OpenDota',
    ungrounded: lang === 'zh' ? '判断，数据未验证' : 'Judgment, unverified',
    vs: lang === 'zh' ? '对' : 'vs',
    winRate: lang === 'zh' ? '胜率' : 'WR',
    start: lang === 'zh' ? '出门' : 'Start',
    early: lang === 'zh' ? '前期' : 'Early',
    mid: lang === 'zh' ? '中期' : 'Mid',
    late: lang === 'zh' ? '后期' : 'Late',
    showMore: lang === 'zh' ? '展开' : 'Expand',
    showLess: lang === 'zh' ? '收起' : 'Collapse',
    thinking: mentorName
      ? (lang === 'zh' ? `${mentorName}在看数据` : `${mentorName} is reading the numbers`)
      : (lang === 'zh' ? '分析中…' : 'Analyzing…'),
  }), [lang, mentorName]);

  const ActionIcon = () => {
    switch (session.action) {
      case 'analyze': return <Sparkles size={14} className="text-k3-text-secondary flex-shrink-0" />;
      case 'playbook': return <Target size={14} className="text-k3-text-secondary flex-shrink-0" />;
      case 'suggest': return <TrendingUp size={14} className="text-k3-text-secondary flex-shrink-0" />;
      case 'meta': return <BarChart3 size={14} className="text-k3-text-secondary flex-shrink-0" />;
      default: return <Sparkles size={14} className="text-k3-text-secondary flex-shrink-0" />;
    }
  };

  const isSectionOpen = (id: string, markdown?: string) => {
    if (openSections[id] !== undefined) return openSections[id];
    if (!expanded) return false;
    return !markdown || markdown.length < 900;
  };

  const renderMatchups = (block: A2UIBlock) => {
    const data = block.matchups as MatchupData | undefined;
    if (!data) return null;
    const chips = [
      ...data.radiantAdvantages.slice(0, 4).map((adv, idx) => ({ key: `rad-${idx}`, side: 'radiant' as const, adv })),
      ...data.direAdvantages.slice(0, 4).map((adv, idx) => ({ key: `dire-${idx}`, side: 'dire' as const, adv })),
    ];
    return (
      <div className="flex flex-wrap gap-1.5">
        {chips.map(({ key, side, adv }) => (
          <span
            key={key}
            className={`inline-flex items-center gap-1 text-[10px] sm:text-[11px] px-2 py-1 rounded-full whitespace-nowrap ${
              side === 'radiant'
                ? 'bg-k3-radiant/10 border border-k3-radiant/20'
                : 'bg-k3-dire/10 border border-k3-dire/20'
            }`}
          >
            <Zap size={10} className={side === 'radiant' ? 'text-k3-radiant' : 'text-k3-dire'} />
            <span className={side === 'radiant' ? 'text-k3-radiant font-medium' : 'text-k3-dire font-medium'}>{adv.hero}</span>
            <span className="text-k3-text-tertiary">{t.vs}</span>
            <span className="text-k3-text-secondary">{adv.vsHero}</span>
            <span className={`${side === 'radiant' ? 'text-k3-radiant' : 'text-k3-dire'} font-bold`}>
              +{adv.advantage.toFixed(1)}%
            </span>
          </span>
        ))}
      </div>
    );
  };

  const renderPlaybook = (block: A2UIBlock) => {
    const heroes = (block.playbook || []) as PlaybookHero[];
    return (
      <div className="space-y-2">
        {heroes.map((hero) => {
          const name = lang === 'zh' ? (hero.nameZh || hero.heroName) : (hero.nameEn || hero.heroName);
          const roles = lang === 'zh' && hero.rolesZh ? hero.rolesZh : hero.roles;
          return (
            <div key={hero.heroId} className="rounded-sm border border-k3-border-subtle bg-k3-elevated/40 p-2.5">
              <div className="flex flex-wrap items-center gap-1.5 mb-2">
                <span className="text-k3-text-primary text-sm font-medium">{name}</span>
                {roles && roles.length > 0 && (
                  <span className="text-k3-text-tertiary text-[10px] bg-k3-elevated px-1.5 py-0.5 rounded">
                    {roles.slice(0, 2).join(' / ')}
                  </span>
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
                  <div key={label} className="flex items-center gap-1 min-w-0">
                    <span className="text-k3-text-tertiary text-[9px] w-6 flex-shrink-0">{label}</span>
                    <div className="flex gap-0.5 min-w-0">
                      {items.slice(0, 4).map((item, idx) => (
                        <img key={idx} src={item.img} alt={item.name} title={item.name} className="w-5 h-5 rounded border border-k3-border-subtle flex-shrink-0" />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderActions = (actions: A2UIAction[]) => (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
      {actions.map((action) => (
        <button
          key={action.id}
          onClick={() => {
            if (action.heroId == null) return;
            const hero = allHeroes.find((h) => h.id === action.heroId);
            if (hero) onSelectHero(hero);
          }}
          className="flex items-center gap-2 p-2.5 bg-k3-elevated/40 hover:bg-k3-elevated border border-k3-border-subtle rounded-sm text-left min-h-[44px] touch-manipulation min-w-0"
        >
          <div className="flex-1 min-w-0">
            <span className="text-k3-text-primary text-xs font-medium block truncate">{action.label}</span>
            {action.subtitle && (
              <span className="text-k3-text-tertiary text-[9px]">{action.subtitle}</span>
            )}
          </div>
          {action.meta && (
            <span className="text-k3-radiant text-[10px] font-bold flex-shrink-0">{action.meta}</span>
          )}
        </button>
      ))}
    </div>
  );

  const renderTier = (block: A2UIBlock) => {
    const heroes = (block.tierHeroes || []) as TierHero[];
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
        {heroes.slice(0, 12).map((hero) => {
          const name = lang === 'zh' ? (hero.nameZh || hero.name) : (hero.nameEn || hero.name);
          const roles = lang === 'zh' && hero.rolesZh ? hero.rolesZh : hero.roles;
          return (
            <button
              key={hero.id}
              onClick={() => {
                const h = allHeroes.find((ah) => ah.id === hero.id);
                if (h) onSelectHero(h);
              }}
              className="flex items-center gap-2 p-2 bg-k3-elevated/40 hover:bg-k3-elevated rounded-sm text-left border border-k3-border-subtle min-h-[44px] touch-manipulation min-w-0"
            >
              <span className={`w-5 h-5 flex items-center justify-center text-[10px] font-bold rounded-sm flex-shrink-0 ${
                hero.tier === 'S' ? 'bg-k3-text-primary text-k3-base' :
                hero.tier === 'A' ? 'bg-k3-radiant/20 text-k3-radiant' :
                'bg-k3-elevated text-k3-text-tertiary'
              }`}>
                {hero.tier}
              </span>
              {hero.icon && <img src={hero.icon} alt="" className="w-5 h-5 rounded-sm flex-shrink-0" />}
              <span className="text-k3-text-primary text-xs flex-1 truncate min-w-0">{name}</span>
              {roles && roles.length > 0 && (
                <span className="text-k3-text-tertiary text-[9px] hidden sm:inline flex-shrink-0">{roles.slice(0, 2).join('/')}</span>
              )}
              <span className="text-k3-radiant text-[10px] font-mono flex-shrink-0">{hero.winRate.toFixed(1)}%</span>
            </button>
          );
        })}
      </div>
    );
  };

  const lastTextIndex = [...session.blocks].reverse().findIndex((b) => b.type === 'section' || b.type === 'markdown');
  const lastTextId = lastTextIndex >= 0 ? session.blocks[session.blocks.length - 1 - lastTextIndex].id : null;

  return (
    <article className="rounded-lg border border-k3-border-subtle bg-k3-surface overflow-hidden min-w-0">
      <header className="px-3 sm:px-4 py-2.5 border-b border-k3-border-subtle flex items-start gap-2 min-w-0">
        <ActionIcon />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-k3-text-primary font-medium break-words">{sessionTitle(session, lang)}</p>
          {mentorName && (
            <p className="text-[11px] text-k3-text-tertiary mt-0.5">{mentorName}</p>
          )}
        </div>
        {!message.isStreaming && message.grounded !== undefined && (
          <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded-full flex-shrink-0 ${
            message.grounded
              ? 'bg-k3-radiant/10 text-k3-radiant border border-k3-radiant/20'
              : 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20'
          }`}>
            {message.grounded ? <Check size={10} /> : <AlertTriangle size={10} />}
            {message.grounded ? t.grounded : t.ungrounded}
          </span>
        )}
      </header>

      <div className="p-3 sm:p-4 space-y-3 min-w-0">
        {message.isStreaming && session.blocks.length === 0 && (
          <p className="text-sm text-k3-text-secondary italic">{t.thinking}</p>
        )}

        {session.blocks.map((block) => {
          const body = (
            <>
              {block.type === 'matchups' && renderMatchups(block)}
              {block.type === 'actions' && block.actions && renderActions(block.actions)}
              {block.type === 'tier' && renderTier(block)}
              {block.playbook && renderPlaybook(block)}
              {block.markdown && (
                <MarkdownBody
                  text={block.markdown}
                  streaming={Boolean(message.isStreaming && block.id === lastTextId)}
                />
              )}
            </>
          );

          if (!block.title) {
            return <div key={block.id} className="min-w-0">{body}</div>;
          }

          const long = Boolean(block.markdown && block.markdown.length >= 900);
          const open = isSectionOpen(block.id, block.markdown);

          return (
            <section key={block.id} className="min-w-0">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <h3 className="text-k3-text-primary font-semibold text-sm flex items-center gap-2 min-w-0">
                  <span className="w-1 h-4 bg-k3-text-tertiary rounded-full flex-shrink-0" />
                  <span className="truncate">{block.title}</span>
                </h3>
                {long && (
                  <button
                    onClick={() => setOpenSections((prev) => ({ ...prev, [block.id]: !open }))}
                    className="text-[11px] text-k3-text-tertiary hover:text-k3-text-secondary flex items-center gap-1 min-h-[32px] touch-manipulation"
                  >
                    {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    {open ? t.showLess : t.showMore}
                  </button>
                )}
              </div>
              {open ? body : (
                <p className="text-xs text-k3-text-tertiary truncate">
                  {(block.markdown || '').replace(/\n/g, ' ').slice(0, 80)}
                </p>
              )}
            </section>
          );
        })}
      </div>
    </article>
  );
};

export default ResultCard;
