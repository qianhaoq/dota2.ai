import React, { useEffect, useMemo, useState } from 'react';
import { Language } from '../../types';
import { fetchReviewSuggestions, ReviewSuggestion } from '../../services/dotaApiService';
import { formatSuggestionSubtitle, formatSuggestionTitle } from '../../utils/reviewSuggestions';
import { awaitWithTimeout, REVIEW_SUGGESTIONS_TIMEOUT_MS } from '../../utils/coachInflight';
import { Loader2 } from 'lucide-react';

interface ReviewSuggestionsProps {
  lang: Language;
  disabled?: boolean;
  selectedMatchId?: number | null;
  onSelect: (matchId: number) => void;
}

const ReviewSuggestions: React.FC<ReviewSuggestionsProps> = ({
  lang,
  disabled = false,
  selectedMatchId = null,
  onSelect,
}) => {
  const [recent, setRecent] = useState<ReviewSuggestion[]>([]);
  const [highMmr, setHighMmr] = useState<ReviewSuggestion[]>([]);
  const [loading, setLoading] = useState(true);

  const t = useMemo(() => ({
    recent: lang === 'zh' ? '近期' : 'Recent',
    highMmr: lang === 'zh' ? '高分' : 'High MMR',
    orPaste: lang === 'zh' ? '或手动输入比赛 ID' : 'Or paste a match ID',
    empty: lang === 'zh' ? '暂无推荐，请手动输入' : 'No suggestions — paste a match ID',
  }), [lang]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    awaitWithTimeout(fetchReviewSuggestions(lang, 6), REVIEW_SUGGESTIONS_TIMEOUT_MS)
      .then((data) => {
        if (cancelled) return;
        setRecent(data.recent);
        setHighMmr(data.highMmr);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setRecent([]);
        setHighMmr([]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lang]);

  const hasSuggestions = recent.length > 0 || highMmr.length > 0;

  const renderChip = (suggestion: ReviewSuggestion) => {
    const selected = selectedMatchId === suggestion.matchId;
    const title = formatSuggestionTitle(suggestion, lang);
    const subtitle = formatSuggestionSubtitle(suggestion, lang);
    return (
      <button
        key={`${suggestion.kind}-${suggestion.matchId}`}
        type="button"
        disabled={disabled}
        onClick={() => onSelect(suggestion.matchId)}
        className={`flex-shrink-0 w-[148px] sm:w-[160px] text-left px-2.5 py-2 rounded-lg border transition-colors min-h-[56px] touch-manipulation ${
          selected
            ? 'border-k3-text-primary/40 bg-k3-elevated text-k3-text-primary'
            : 'border-k3-border-subtle bg-k3-elevated/50 text-k3-text-secondary hover:text-k3-text-primary hover:bg-k3-elevated/80'
        } disabled:opacity-40`}
      >
        <span className="block text-xs font-medium truncate">{title}</span>
        <span className="block text-[10px] text-k3-text-tertiary truncate mt-0.5">{subtitle}</span>
        <span className="block text-[10px] text-k3-text-tertiary/80 mt-0.5">#{suggestion.matchId}</span>
      </button>
    );
  };

  const renderSection = (label: string, items: ReviewSuggestion[]) => {
    if (items.length === 0) return null;
    return (
      <div className="space-y-1.5">
        <p className="text-[10px] uppercase tracking-wide text-k3-text-tertiary">{label}</p>
        <div className="flex gap-1.5 overflow-x-auto pb-1 custom-scrollbar -mx-0.5 px-0.5">
          {items.map(renderChip)}
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-k3-text-tertiary py-1">
        <Loader2 size={12} className="animate-spin" />
        {lang === 'zh' ? '加载推荐比赛…' : 'Loading suggestions…'}
      </div>
    );
  }

  if (!hasSuggestions) {
    return (
      <p className="text-[11px] text-k3-text-tertiary">{t.empty}</p>
    );
  }

  return (
    <div className="space-y-2.5">
      {renderSection(t.recent, recent)}
      {renderSection(t.highMmr, highMmr)}
      <p className="text-[10px] text-k3-text-tertiary/80">{t.orPaste}</p>
    </div>
  );
};

export default ReviewSuggestions;
