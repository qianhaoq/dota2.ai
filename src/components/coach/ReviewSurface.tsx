import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Film, ChevronDown, ChevronUp, Loader2, X, Check, AlertTriangle } from 'lucide-react';
import type { Language } from '../../types';
import type { A2UIBlock } from '../../types';
import type { CoachSession } from './coachMessage';
import ReviewInsightCards from './ReviewInsightCards';
import {
  findPrimaryReviewSession,
  getReviewSurfacePhase,
  reviewSurfaceProgressLabel,
  reviewNoticeBlocks,
  reviewFactSpineBlocks,
  isReviewAiFollowUpAvailable,
  type ReviewFollowUpContext,
} from '../../utils/reviewSurface';
import { MarkdownBody } from './ResultCard';
import { scrollOffsetWithinContainer } from '../../utils/coachScroll';

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

const SlotSkeleton: React.FC<{ label: string }> = ({ label }) => (
  <div
    className="rounded-lg border border-k3-border-subtle/60 bg-k3-elevated/20 p-3 animate-pulse"
    aria-hidden="true"
  >
    <div className="h-3 w-24 rounded bg-k3-elevated mb-2" />
    <div className="h-4 w-3/4 max-w-xs rounded bg-k3-elevated mb-2" />
    <div className="h-3 w-full rounded bg-k3-elevated/70" />
    <p className="text-[10px] text-k3-text-tertiary mt-2">{label}</p>
  </div>
);

const FactSpineSection: React.FC<{ block: A2UIBlock; lang: Language }> = ({ block, lang }) => (
  <section className="rounded-lg border border-k3-border-subtle/70 bg-k3-elevated/15 px-3 py-2.5">
    {block.title && (
      <h4 className="text-[11px] font-semibold text-k3-text-tertiary uppercase tracking-wide mb-1.5">
        {block.title}
      </h4>
    )}
    {block.reviewSection === 'lanes' && (
      <p className="text-[10px] text-k3-text-tertiary mb-2 italic">
        {lang === 'zh' ? '根据录像站位推断' : 'Inferred from replay positioning'}
      </p>
    )}
    {block.markdown && <MarkdownBody text={block.markdown} />}
  </section>
);

const CollapsibleSection: React.FC<{
  title: string;
  defaultOpen?: boolean;
  compactDefault?: boolean;
  preview?: string;
  children: React.ReactNode;
}> = ({ title, defaultOpen = false, compactDefault = false, preview, children }) => {
  const [open, setOpen] = useState(defaultOpen);
  const collapsed = compactDefault && !open;

  return (
    <section className="rounded-lg border border-k3-border-subtle/70 bg-k3-elevated/15 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left touch-manipulation min-h-[44px]"
      >
        <span className="text-sm font-medium text-k3-text-primary truncate">{title}</span>
        <span className="flex items-center gap-1 text-[11px] text-k3-text-tertiary flex-shrink-0 min-w-0">
          {collapsed && preview && (
            <span className="inline truncate max-w-[8rem] sm:max-w-[12rem]">{preview}</span>
          )}
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>
      {open && <div className="px-3 pb-3 pt-0">{children}</div>}
    </section>
  );
};

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

  const phase = getReviewSurfacePhase(cards, Boolean(message?.matchFact), isStreaming);
  const progressLabel = reviewSurfaceProgressLabel(phase, lang, isStreaming);

  const t = useMemo(() => ({
    surfaceTitle: lang === 'zh' ? '复盘工作区' : 'Review workspace',
    dismiss: lang === 'zh' ? '收起复盘' : 'Dismiss review',
    askThis: lang === 'zh' ? '追问这场' : 'Ask about this match',
    followups: lang === 'zh' ? '继续问拉比克' : 'Ask Rubick',
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
          {!isStreaming && (
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
            <div
              key={block.id}
              data-testid="review-surface-notice"
              className="rounded-lg border border-yellow-500/25 bg-yellow-500/5 px-3 py-2.5"
            >
              {block.title && (
                <p className="text-[11px] font-semibold text-yellow-400/90 mb-1">{block.title}</p>
              )}
              {block.markdown && <MarkdownBody text={block.markdown} />}
            </div>
          ))}

          {blockByKind.get('match_summary') ? (
            <ReviewInsightCards
              block={blockByKind.get('match_summary')!}
              lang={lang}
              variant="surface"
              {...insightFollowUpProps}
            />
          ) : message?.matchFact && isStreaming ? (
            <SlotSkeleton label={t.loadingSummary} />
          ) : factSpineBlocks.length > 0 ? (
            <div className="space-y-2" data-testid="review-surface-fact-spine">
              {factSpineBlocks.map((block) => (
                <FactSpineSection key={block.id} block={block} lang={lang} />
              ))}
            </div>
          ) : null}

          {blockByKind.get('primary_mistake') ? (
            <div data-review-slot="primary_mistake">
              <p className="text-[11px] font-semibold text-k3-text-tertiary uppercase tracking-wide mb-1.5 px-0.5">
                {t.mistake}
              </p>
              <ReviewInsightCards
                block={blockByKind.get('primary_mistake')!}
                lang={lang}
                variant="hero"
                {...insightFollowUpProps}
              />
            </div>
          ) : cards && !cards.primary_mistake && isStreaming && (
            <SlotSkeleton label={t.loadingMistake} />
          )}

          {blockByKind.get('drill') ? (
            <div data-review-slot="drill">
              <p className="text-[11px] font-semibold text-k3-text-tertiary uppercase tracking-wide mb-1.5 px-0.5">
                {t.drill}
              </p>
              <ReviewInsightCards
                block={blockByKind.get('drill')!}
                lang={lang}
                variant="surface"
                {...insightFollowUpProps}
              />
            </div>
          ) : cards?.primary_mistake && !cards.drill && isStreaming && (
            <SlotSkeleton label={t.loadingDrill} />
          )}

          {blockByKind.get('phases') && (
            <CollapsibleSection
              title={t.phases}
              compactDefault={mobileCompact}
              defaultOpen={!mobileCompact}
              preview={cards?.phases?.[0]?.label}
            >
              <ReviewInsightCards
                block={blockByKind.get('phases')!}
                lang={lang}
                variant="surface"
              />
            </CollapsibleSection>
          )}

          {blockByKind.get('key_moments') && (
            <CollapsibleSection
              title={t.moments}
              compactDefault={mobileCompact}
              defaultOpen={false}
              preview={momentsPreview}
            >
              <ReviewInsightCards
                block={blockByKind.get('key_moments')!}
                lang={lang}
                variant="timeline"
              />
            </CollapsibleSection>
          )}

          {blockByKind.get('mentor_note') && (
            <CollapsibleSection title={t.mentor} defaultOpen={false}>
              <ReviewInsightCards
                block={blockByKind.get('mentor_note')!}
                lang={lang}
                variant="surface"
              />
            </CollapsibleSection>
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
