import React, { useMemo, useState } from 'react';
import { Language, Hero, A2UIBlock, A2UIAction } from '../../types';
import {
  Sparkles, Target, TrendingUp, BarChart3, Zap, Film,
  Check, AlertTriangle, X,
} from 'lucide-react';
import { MatchupData, TierHero, PlaybookHero } from '../../services/geminiService';
import type { CoachSession } from './coachMessage';
import { sessionTitle } from '../../utils/coachBlocks';
import { shouldShowCoachFailureAlert, isCoachUserAbortError } from '../../utils/coachInflight';
import { groupMarkdownSegments } from '../../utils/markdownLines';
import { primaryReviewFollowUpContext, type ReviewFollowUpContext } from '../../utils/reviewSurface';
import ReviewInsightCards from './ReviewInsightCards';
import { ActionChipBar, CardSkeleton, SectionCard, StatusNotice } from './a2ui';

interface ResultCardProps {
  session: CoachSession;
  lang: Language;
  allHeroes: Hero[];
  onSelectHero: (hero: Hero) => void;
  mentorName?: string;
  expanded?: boolean;
  onDismiss?: () => void;
  onReviewFollowUp?: (question: string, context: ReviewFollowUpContext) => void;
  canSubmitReviewFollowUpForContext?: (context: ReviewFollowUpContext) => boolean;
}

export const MarkdownBody: React.FC<{ text: string; streaming?: boolean }> = ({ text, streaming }) => {
  const segments = groupMarkdownSegments(text);
  return (
    <>
      {segments.map((segment, idx) => {
        if (segment.type === 'heading') {
          return <h4 key={idx} className="text-k3-text-primary font-medium text-sm mt-3 mb-1.5">{segment.text}</h4>;
        }
        if (segment.type === 'strong') {
          return <strong key={idx} className="block mt-2 text-k3-text-primary text-sm">{segment.text}</strong>;
        }
        if (segment.type === 'list') {
          return (
            <ul key={idx} className="list-none my-0 pl-0">
              {segment.items.map((item, itemIdx) => (
                <li key={itemIdx} className="ml-3 text-k3-text-secondary text-sm leading-relaxed flex items-start gap-2 my-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-k3-text-tertiary mt-2 flex-shrink-0" />
                  <span className="min-w-0 break-words">{item}</span>
                </li>
              ))}
            </ul>
          );
        }
        if (segment.type === 'blank') return <div key={idx} className="h-2" />;
        return <p key={idx} className="text-k3-text-secondary text-sm leading-relaxed break-words">{segment.text}</p>;
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
  onDismiss,
  onReviewFollowUp,
  canSubmitReviewFollowUpForContext,
}) => {
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const message = session.message;
  const followUpContext = useMemo(
    () => primaryReviewFollowUpContext(session),
    [session],
  );
  const followUpActionsEnabled = useMemo(
    () => Boolean(
      followUpContext
      && canSubmitReviewFollowUpForContext?.(followUpContext),
    ),
    [followUpContext, canSubmitReviewFollowUpForContext],
  );

  const t = useMemo(() => ({
    grounded: lang === 'zh' ? '基于 OpenDota 数据' : 'Grounded in OpenDota',
    groundedShort: lang === 'zh' ? '数据' : 'Data',
    ungrounded: lang === 'zh' ? '判断，数据未验证' : 'Judgment, unverified',
    ungroundedShort: lang === 'zh' ? '未验证' : 'Unverified',
    vs: lang === 'zh' ? '对' : 'vs',
    winRate: lang === 'zh' ? '胜率' : 'WR',
    start: lang === 'zh' ? '出门' : 'Start',
    early: lang === 'zh' ? '前期' : 'Early',
    mid: lang === 'zh' ? '中期' : 'Mid',
    late: lang === 'zh' ? '后期' : 'Late',
    showMore: lang === 'zh' ? '展开' : 'Expand',
    showLess: lang === 'zh' ? '收起' : 'Collapse',
    laneInference: lang === 'zh' ? '根据录像站位推断' : 'Inferred from replay positioning',
    thinking: mentorName
      ? (lang === 'zh' ? `${mentorName}在看数据` : `${mentorName} is reading the numbers`)
      : (lang === 'zh' ? '分析中…' : 'Analyzing…'),
    dismiss: lang === 'zh' ? '收起' : 'Dismiss',
  }), [lang, mentorName]);

  const ActionIcon = () => {
    switch (session.action) {
      case 'analyze': return <Sparkles size={14} className="text-k3-text-secondary flex-shrink-0" />;
      case 'playbook': return <Target size={14} className="text-k3-text-secondary flex-shrink-0" />;
      case 'suggest': return <TrendingUp size={14} className="text-k3-text-secondary flex-shrink-0" />;
      case 'meta': return <BarChart3 size={14} className="text-k3-text-secondary flex-shrink-0" />;
      case 'review': return <Film size={14} className="text-k3-text-secondary flex-shrink-0" />;
      default: return <Sparkles size={14} className="text-k3-text-secondary flex-shrink-0" />;
    }
  };

  const isSectionOpen = (id: string, markdown?: string, defaultOpen?: boolean) => {
    if (openSections[id] !== undefined) return openSections[id];
    if (!expanded) return false;
    if (defaultOpen !== undefined) return defaultOpen;
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
      <div className="flex flex-wrap gap-1.5 min-w-0">
        {chips.map(({ key, side, adv }) => (
          <span
            key={key}
            className={`inline-flex items-center gap-1 text-[10px] sm:text-[11px] px-2 py-1 rounded-full max-w-full min-w-0 ${
              side === 'radiant'
                ? 'bg-k3-radiant/10 border border-k3-radiant/20'
                : 'bg-k3-dire/10 border border-k3-dire/20'
            }`}
          >
            <Zap size={10} className={`${side === 'radiant' ? 'text-k3-radiant' : 'text-k3-dire'} flex-shrink-0`} />
            <span className={`${side === 'radiant' ? 'text-k3-radiant font-medium' : 'text-k3-dire font-medium'} truncate max-w-[4.5rem] sm:max-w-none`}>{adv.hero}</span>
            <span className="text-k3-text-tertiary flex-shrink-0">{t.vs}</span>
            <span className="text-k3-text-secondary truncate max-w-[4.5rem] sm:max-w-none">{adv.vsHero}</span>
            <span className={`${side === 'radiant' ? 'text-k3-radiant' : 'text-k3-dire'} font-bold flex-shrink-0`}>
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
                    <span className="text-k3-text-tertiary text-[9px] w-8 flex-shrink-0">{label}</span>
                    <div className="flex gap-0.5 min-w-0 overflow-hidden">
                      {items.slice(0, 4).map((item, idx) => (
                        <img key={idx} src={item.img} alt={item.name} title={item.name} className="w-[18px] h-[18px] sm:w-8 sm:h-8 rounded border border-k3-border-subtle flex-shrink-0" />
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
    <ActionChipBar
      actions={actions}
      onAction={(action) => {
        if (action.heroId == null) return;
        const hero = allHeroes.find((h) => h.id === action.heroId);
        if (hero) onSelectHero(hero);
      }}
    />
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
        <div className="flex items-center gap-1 flex-shrink-0">
          {!message.isStreaming && message.grounded !== undefined && (
            <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded-full max-w-[42%] sm:max-w-none ${
              message.grounded
                ? 'bg-k3-radiant/10 text-k3-radiant border border-k3-radiant/20'
                : 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20'
            }`}>
              {message.grounded ? <Check size={10} className="flex-shrink-0" /> : <AlertTriangle size={10} className="flex-shrink-0" />}
              <span className="truncate sm:hidden">{message.grounded ? t.groundedShort : t.ungroundedShort}</span>
              <span className="hidden sm:inline">{message.grounded ? t.grounded : t.ungrounded}</span>
            </span>
          )}
          {onDismiss && !message.isStreaming && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label={t.dismiss}
              className="p-1.5 rounded-md text-k3-text-tertiary hover:text-k3-text-secondary hover:bg-k3-elevated/60 min-w-[36px] min-h-[36px] flex items-center justify-center touch-manipulation"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </header>

      <div className="p-3 sm:p-4 space-y-3 min-w-0">
        {message.isStreaming && session.action === 'meta' && !message.tierHeroes?.length && !message.error && (
          <div className="space-y-2">
            <p className="text-sm text-k3-text-secondary italic">{t.thinking}</p>
            <CardSkeleton variant="grid" />
          </div>
        )}

        {message.isStreaming && session.blocks.length === 0 && !message.error
          && session.action !== 'meta' && (
          <p className="text-sm text-k3-text-secondary italic">{t.thinking}</p>
        )}

        {message.isStreaming && session.action === 'review' && message.reviewCards && !message.reviewCards.primary_mistake && !message.error && (
          <p className="text-sm text-k3-text-secondary italic animate-pulse">
            {lang === 'zh' ? '拉比克正在提炼关键失误…' : 'Rubick is distilling the key mistake…'}
          </p>
        )}

        {shouldShowCoachFailureAlert(message) && (
          <StatusNotice
            tone="error"
            icon={<AlertTriangle size={16} className="text-red-400" />}
            title={
              isCoachUserAbortError(message.error)
                ? (lang === 'zh' ? '已取消' : 'Cancelled')
                : message.action === 'review'
                  ? (lang === 'zh' ? '复盘失败' : 'Review failed')
                  : (lang === 'zh' ? '请求失败' : 'Request failed')
            }
          >
            {message.error}
          </StatusNotice>
        )}

        {session.blocks.map((block) => {
          const isReview = block.type === 'review';
          const isReviewInsight = block.type === 'reviewInsight';
          const reviewDefaultOpen = block.reviewSection === 'summary'
            || block.reviewSection === 'lanes'
            || block.reviewSection === 'howToWin'
            || block.reviewCardKind === 'match_summary'
            || block.reviewCardKind === 'primary_mistake'
            || block.reviewCardKind === 'drill';

          const body = (
            <>
              {block.type === 'matchups' && renderMatchups(block)}
              {block.type === 'actions' && block.actions && renderActions(block.actions)}
              {block.type === 'tier' && renderTier(block)}
              {block.playbook && renderPlaybook(block)}
              {isReviewInsight && (
                <ReviewInsightCards
                  block={block}
                  lang={lang}
                  onFollowUp={onReviewFollowUp}
                  followUpContext={followUpContext ?? undefined}
                  followUpActionsEnabled={followUpActionsEnabled}
                />
              )}
              {block.reviewSection === 'lanes' && (
                <p className="text-[10px] text-k3-text-tertiary mb-2 italic">{t.laneInference}</p>
              )}
              {block.markdown && !(isReviewInsight && block.reviewCardKind === 'mentor_note') && (
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
          const framed = isReview || isReviewInsight;
          const open = isSectionOpen(
            block.id,
            block.markdown,
            framed ? reviewDefaultOpen : undefined,
          );

          return (
            <SectionCard
              key={block.id}
              title={block.title}
              framed={framed}
              collapsible={long || framed}
              open={open}
              onToggle={(next) => setOpenSections((prev) => ({ ...prev, [block.id]: next }))}
              preview={(block.markdown || '').replace(/\n/g, ' ').slice(0, 80)}
              expandLabel={t.showMore}
              collapseLabel={t.showLess}
            >
              {body}
            </SectionCard>
          );
        })}
      </div>
    </article>
  );
};

export default ResultCard;
