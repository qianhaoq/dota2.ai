import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Film, Loader2, X, Check, AlertTriangle } from 'lucide-react';
import type { Language } from '../../types';
import type { A2UIBlock } from '../../types';
import type { CoachSession } from './coachMessage';
import ReviewInsightCards from './ReviewInsightCards';
import {
  findPrimaryReviewSession,
  getReviewSurfacePhase,
  reviewSurfaceProgressLabel,
  shouldShowReviewSurfaceProgress,
  isReviewSurfaceStoppedEarly,
  reviewNoticeBlocks,
  reviewFactSpineBlocks,
  isReviewAiFollowUpAvailable,
  type ReviewFollowUpContext,
} from '../../utils/reviewSurface';
import { MarkdownBody } from './ResultCard';
import { scrollOffsetWithinContainer } from '../../utils/coachScroll';
import { CardSkeleton, InsightCard, SectionCard, StatusNotice } from './a2ui';

interface ReviewSurfaceProps {
  sessions: CoachSession[];
  dismissedSessionIds: ReadonlySet<string>;
  lang: Language;
  onDismiss: (sessionId: string) => void;
  onReviewFollowUp?: (question: string, context: ReviewFollowUpContext) => void;
  onComposeFollowUp?: (text: string, context: ReviewFollowUpContext) => void;
  followUpAllowed?: boolean;
  scrollContainerRef?: React.RefObject<HTMLElement | null>;
}

const FactSpineSection: React.FC<{ block: A2UIBlock; lang: Language }> = ({ block, lang }) => (
  <InsightCard framed label={block.title}>
    {block.reviewSection === 'lanes' && (
      <p className="text-[10px] text-k3-text-tertiary mb-2 italic">
        {lang === 'zh' ? '根据录像站位推断' : 'Inferred from replay positioning'}
      </p>
    )}
    {block.markdown && <MarkdownBody text={block.markdown} />}
  </InsightCard>
);

const ReviewSurface: React.FC<ReviewSurfaceProps> = ({
  sessions,
  dismissedSessionIds,
  lang,
  onDismiss,
  onReviewFollowUp,
  onComposeFollowUp,
  followUpAllowed = true,
  scrollContainerRef,
}) => {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const autoScrolledSessionIdRef = useRef<string | null>(null);
  const [mobileCompact] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches
  ));

  const session = useMemo(() => findPrimaryReviewSession(sessions), [sessions]);
  const message = session?.message;
  const cards = message?.reviewCards;
  const dismissed = session ? dismissedSessionIds.has(session.id) : true;
  const isStreaming = Boolean(message?.isStreaming);
  const surfaceActivelyStreaming = isStreaming && !message?.error;

  const phase = getReviewSurfacePhase(cards, Boolean(message?.matchFact), surfaceActivelyStreaming);
  const progressLabel = surfaceActivelyStreaming
    && shouldShowReviewSurfaceProgress(message, phase, surfaceActivelyStreaming)
    ? reviewSurfaceProgressLabel(phase, lang, surfaceActivelyStreaming)
    : null;
  const stoppedEarly = isReviewSurfaceStoppedEarly(message);

  const t = useMemo(() => ({
    surfaceTitle: lang === 'zh' ? '复盘工作区' : 'Review workspace',
    dismiss: lang === 'zh' ? '收起复盘' : 'Dismiss review',
    askThis: lang === 'zh' ? '追问这场' : 'Ask about this match',
    followups: lang === 'zh' ? '下一步动作' : 'Next actions',
    grounded: lang === 'zh' ? '基于 OpenDota 数据' : 'Grounded in OpenDota',
    groundedShort: lang === 'zh' ? '数据' : 'Data',
    ungrounded: lang === 'zh' ? '判断，数据未验证' : 'Judgment, unverified',
    ungroundedShort: lang === 'zh' ? '未验证' : 'Unverified',
    summary: lang === 'zh' ? '摘要' : 'Summary',
    phases: lang === 'zh' ? '阶段节奏' : 'Phase spine',
    mistake: lang === 'zh' ? '本场主要失误' : 'Primary mistake',
    moments: lang === 'zh' ? '关键节点' : 'Key moments',
    drill: lang === 'zh' ? '下一局练习' : 'Next-game drill',
    mentor: lang === 'zh' ? '拉比克说' : 'From Rubick',
    loadingSummary: lang === 'zh' ? '加载比赛摘要…' : 'Loading summary…',
    loadingMistake: lang === 'zh' ? '提炼关键失误…' : 'Distilling mistake…',
    loadingDrill: lang === 'zh' ? '生成练习方案…' : 'Building drill…',
    stoppedEarly: lang === 'zh' ? '复盘已停止，以下为已加载内容。' : 'Review stopped — showing loaded content.',
  }), [lang]);

  const insightBlocks = useMemo(() => {
    if (!session) return [];
    return session.blocks.filter((b) => b.type === 'reviewInsight' && b.reviewCardKind);
  }, [session]);

  const noticeBlocks = useMemo(() => {
    if (!session) return [];
    return reviewNoticeBlocks(session.blocks);
  }, [session]);

  const factSpineBlocks = useMemo(() => {
    if (!session) return [];
    return reviewFactSpineBlocks(session.blocks);
  }, [session]);

  const followUpActionsEnabled = useMemo(
    () => followUpAllowed && isReviewAiFollowUpAvailable(message, noticeBlocks),
    [followUpAllowed, message, noticeBlocks],
  );

  const followUpContext = useMemo((): ReviewFollowUpContext | undefined => {
    const summary = cards?.match_summary;
    const matchId = summary?.matchId ?? message?.matchFact?.summary?.matchId;
    if (matchId == null || !session) return undefined;
    return {
      sessionId: session.id,
      matchId,
      heroId: summary?.heroId ?? message?.matchFact?.focusHeroId ?? undefined,
    };
  }, [cards, message, session]);

  const blockByKind = useMemo(() => {
    const map = new Map<string, A2UIBlock>();
    insightBlocks.forEach((b) => {
      if (b.reviewCardKind) map.set(b.reviewCardKind, b);
    });
    return map;
  }, [insightBlocks]);

  const headerSummary = cards?.match_summary;
  const matchId = headerSummary?.matchId
    ?? message?.matchFact?.summary?.matchId;
  const heroName = headerSummary?.heroName
    ?? message?.matchFact?.focusLens?.displayName;
  const resultLabel = headerSummary?.resultLabel;

  useEffect(() => {
    if (!session) return;
    if (dismissed) {
      autoScrolledSessionIdRef.current = null;
      return;
    }
    if (autoScrolledSessionIdRef.current === session.id) return;
    autoScrolledSessionIdRef.current = session.id;
    const container = scrollContainerRef?.current;
    const target = surfaceRef.current;
    if (!target) return;
    requestAnimationFrame(() => {
      if (container) {
        const top = scrollOffsetWithinContainer(container, target, 8);
        container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      } else {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }, [session?.id, dismissed, scrollContainerRef]);

  if (!session || dismissed) return null;

  const followupBlock = blockByKind.get('followups');
  const showFollowups = followupBlock && followUpActionsEnabled && !isStreaming;
  const showAskThis = headerSummary && onComposeFollowUp && followUpContext
    && followUpActionsEnabled && !showFollowups && !isStreaming;

  const momentsPreview = cards?.key_moments
    ?.slice(0, 3)
    .map((m) => m.timestampLabel)
    .join(' · ');

  const insightFollowUpProps = followUpActionsEnabled
    ? { followUpContext, onFollowUp: onReviewFollowUp, onComposeFollowUp }
    : { followUpContext, followUpActionsEnabled: false };

  return (
    <div
      ref={surfaceRef}
      data-testid="review-surface"
      className="w-full max-w-3xl min-w-0 mb-3"
    >
      <div className="rounded-xl border border-k3-border-subtle bg-k3-surface shadow-sm overflow-hidden">
        <header className="flex items-start gap-2 px-3 sm:px-4 py-2.5 border-b border-k3-border-subtle bg-k3-elevated/30">
          <Film size={16} className="text-k3-text-secondary flex-shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <p className="text-xs text-k3-text-tertiary uppercase tracking-wide">{t.surfaceTitle}</p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
              {heroName && (
                <span className="text-sm font-semibold text-k3-text-primary">{heroName}</span>
              )}
              {matchId != null && (
                <span className="text-[11px] text-k3-text-tertiary font-mono">#{matchId}</span>
              )}
              {resultLabel && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full border border-k3-border-subtle text-k3-text-secondary">
                  {resultLabel}
                </span>
              )}
              {!isStreaming && message?.grounded !== undefined && (
                <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full ${
                  message.grounded
                    ? 'bg-k3-radiant/10 text-k3-radiant border border-k3-radiant/20'
                    : 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20'
                }`}>
                  {message.grounded ? <Check size={10} className="flex-shrink-0" /> : <AlertTriangle size={10} className="flex-shrink-0" />}
                  <span className="truncate sm:hidden">{message.grounded ? t.groundedShort : t.ungroundedShort}</span>
                  <span className="hidden sm:inline">{message.grounded ? t.grounded : t.ungrounded}</span>
                </span>
              )}
            </div>
          </div>
          {!surfaceActivelyStreaming && (
            <button
              type="button"
              onClick={() => onDismiss(session.id)}
              aria-label={t.dismiss}
              className="p-1.5 rounded-md text-k3-text-tertiary hover:text-k3-text-secondary hover:bg-k3-elevated/60 min-w-[36px] min-h-[36px] flex items-center justify-center touch-manipulation flex-shrink-0"
            >
              <X size={14} />
            </button>
          )}
        </header>

        {progressLabel && (
          <div
            data-testid="review-surface-progress"
            className="flex items-center gap-2 px-3 sm:px-4 py-2 bg-k3-elevated/20 border-b border-k3-border-subtle/50"
          >
            <Loader2 size={14} className="text-k3-radiant animate-spin flex-shrink-0" />
            <span className="text-xs text-k3-text-secondary">{progressLabel}</span>
          </div>
        )}

        <div className="p-3 sm:p-4 space-y-3">
          {noticeBlocks.map((block) => (
            <StatusNotice
              key={block.id}
              testId="review-surface-notice"
              tone="warning"
              title={block.title}
            >
              {block.markdown && <MarkdownBody text={block.markdown} />}
            </StatusNotice>
          ))}

          {stoppedEarly && noticeBlocks.length === 0 && (
            <StatusNotice testId="review-surface-stopped-early" tone="neutral">
              {t.stoppedEarly}
            </StatusNotice>
          )}

          {blockByKind.get('match_summary') ? (
            <ReviewInsightCards
              block={blockByKind.get('match_summary')!}
              lang={lang}
              variant="surface"
              {...insightFollowUpProps}
            />
          ) : message?.matchFact && surfaceActivelyStreaming ? (
            <CardSkeleton label={t.loadingSummary} />
          ) : factSpineBlocks.length > 0 ? (
            <div className="space-y-2" data-testid="review-surface-fact-spine">
              {factSpineBlocks.map((block) => (
                <FactSpineSection key={block.id} block={block} lang={lang} />
              ))}
            </div>
          ) : null}

          {blockByKind.get('primary_mistake') ? (
            <InsightCard slotKey="primary_mistake" label={t.mistake}>
              <ReviewInsightCards
                block={blockByKind.get('primary_mistake')!}
                lang={lang}
                variant="hero"
                {...insightFollowUpProps}
              />
            </InsightCard>
          ) : cards && !cards.primary_mistake && surfaceActivelyStreaming && (
            <CardSkeleton label={t.loadingMistake} />
          )}

          {blockByKind.get('drill') ? (
            <InsightCard slotKey="drill" label={t.drill}>
              <ReviewInsightCards
                block={blockByKind.get('drill')!}
                lang={lang}
                variant="surface"
                {...insightFollowUpProps}
              />
            </InsightCard>
          ) : cards?.primary_mistake && !cards.drill && surfaceActivelyStreaming && (
            <CardSkeleton label={t.loadingDrill} />
          )}

          {blockByKind.get('phases') && (
            <SectionCard
              title={t.phases}
              lang={lang}
              framed
              defaultOpen={!mobileCompact}
              preview={mobileCompact ? cards?.phases?.[0]?.label : undefined}
            >
              <ReviewInsightCards
                block={blockByKind.get('phases')!}
                lang={lang}
                variant="surface"
              />
            </SectionCard>
          )}

          {blockByKind.get('key_moments') && (
            <SectionCard
              title={t.moments}
              lang={lang}
              framed
              defaultOpen={false}
              preview={mobileCompact ? momentsPreview : undefined}
            >
              <ReviewInsightCards
                block={blockByKind.get('key_moments')!}
                lang={lang}
                variant="timeline"
              />
            </SectionCard>
          )}

          {blockByKind.get('mentor_note') && (
            <SectionCard title={t.mentor} lang={lang} framed defaultOpen={false}>
              <ReviewInsightCards
                block={blockByKind.get('mentor_note')!}
                lang={lang}
                variant="surface"
              />
            </SectionCard>
          )}
        </div>
      </div>

      {showFollowups && (
        <div
          data-testid="review-surface-followups"
          className="sticky bottom-0 z-[1] -mt-px px-3 sm:px-4 py-2.5 rounded-b-xl border border-t border-k3-border-subtle bg-k3-surface/95 backdrop-blur-sm shadow-[0_-4px_12px_rgba(0,0,0,0.15)]"
        >
          <p className="text-[10px] text-k3-text-tertiary mb-1.5">{t.followups}</p>
          <ReviewInsightCards
            block={followupBlock!}
            lang={lang}
            variant="chips"
            followUpContext={followUpContext}
            onFollowUp={onReviewFollowUp}
            onComposeFollowUp={onComposeFollowUp}
          />
        </div>
      )}

      {showAskThis && (
        <div className="px-3 sm:px-4 pb-3 pt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onComposeFollowUp!(
              lang === 'zh'
                ? `关于比赛 ${headerSummary!.matchId}，我还想问…`
                : `About match ${headerSummary!.matchId}, I want to ask…`,
              followUpContext!,
            )}
            className="text-xs px-3 py-2 rounded-full border border-k3-border-subtle bg-k3-elevated/40 text-k3-text-secondary hover:text-k3-text-primary touch-manipulation min-h-[40px]"
          >
            {t.askThis}
          </button>
        </div>
      )}
    </div>
  );
};

export default ReviewSurface;
