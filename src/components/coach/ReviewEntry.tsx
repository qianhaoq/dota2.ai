import React, { useMemo, useState, useEffect } from 'react';
import { Language, Hero } from '../../types';
import { Film, Search, ChevronDown } from 'lucide-react';
import { parseMatchId } from '../../utils/parseMatchId';

interface ReviewEntryProps {
  lang: Language;
  allHeroes: Hero[];
  practiceHero: Hero | null;
  isLoading: boolean;
  onStartReview: (matchId: number, heroId?: number) => void;
}

const ReviewEntry: React.FC<ReviewEntryProps> = ({
  lang,
  allHeroes,
  practiceHero,
  isLoading,
  onStartReview,
}) => {
  const [matchInput, setMatchInput] = useState('');
  const [heroId, setHeroId] = useState<number | ''>(practiceHero?.id ?? '');
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (practiceHero?.id) setHeroId(practiceHero.id);
  }, [practiceHero?.id]);

  const t = useMemo(() => ({
    title: lang === 'zh' ? '复盘一局' : 'Review a match',
    subtitle: lang === 'zh' ? '输入比赛 ID 或 OpenDota / Dotabuff 链接' : 'Match ID or OpenDota / Dotabuff URL',
    placeholder: lang === 'zh' ? '8985182860 或 opendota.com/matches/...' : '8985182860 or opendota.com/matches/...',
    hero: lang === 'zh' ? '复盘英雄' : 'Hero to review',
    heroOptional: lang === 'zh' ? '选择本局英雄（建议）' : 'Pick your hero (recommended)',
    start: lang === 'zh' ? '开始复盘' : 'Start review',
    invalid: lang === 'zh' ? '请输入有效的比赛 ID 或链接' : 'Enter a valid match ID or URL',
    needHero: lang === 'zh' ? '请选择复盘英雄' : 'Select a hero to review',
  }), [lang]);

  const parsedId = parseMatchId(matchInput);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!parsedId) return;
    const selectedHero = heroId === '' ? undefined : Number(heroId);
    if (!selectedHero) return;
    onStartReview(parsedId, selectedHero);
  };

  return (
    <div className="w-full min-w-0 max-w-xl mx-auto">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl border border-k3-border-subtle bg-k3-surface/80 hover:bg-k3-elevated/60 transition-colors min-h-[44px] touch-manipulation"
      >
        <span className="flex items-center gap-2 text-sm text-k3-text-primary font-medium">
          <Film size={16} className="text-k3-text-secondary flex-shrink-0" />
          {t.title}
        </span>
        <ChevronDown size={16} className={`text-k3-text-tertiary transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {expanded && (
        <form onSubmit={handleSubmit} className="mt-2 p-3 rounded-xl border border-k3-border-subtle bg-k3-surface space-y-3">
          <p className="text-[11px] text-k3-text-tertiary">{t.subtitle}</p>

          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-k3-text-tertiary" />
            <input
              type="text"
              value={matchInput}
              onChange={(e) => setMatchInput(e.target.value)}
              placeholder={t.placeholder}
              className="w-full pl-9 pr-3 py-2.5 rounded-lg bg-k3-elevated border border-k3-border-subtle text-sm text-k3-text-primary placeholder:text-k3-text-tertiary min-h-[44px]"
              inputMode="numeric"
              autoComplete="off"
            />
          </div>

          <div>
            <label className="text-[11px] text-k3-text-tertiary block mb-1">{t.hero}</label>
            <select
              value={heroId}
              onChange={(e) => setHeroId(e.target.value ? Number(e.target.value) : '')}
              className="w-full px-3 py-2.5 rounded-lg bg-k3-elevated border border-k3-border-subtle text-sm text-k3-text-primary min-h-[44px]"
            >
              <option value="">{t.heroOptional}</option>
              {allHeroes.map((h) => (
                <option key={h.id} value={h.id}>
                  {lang === 'zh' ? (h.nameZh || h.name) : h.name}
                </option>
              ))}
            </select>
          </div>

          {matchInput && !parsedId && (
            <p className="text-xs text-yellow-400">{t.invalid}</p>
          )}

          <button
            type="submit"
            disabled={isLoading || !parsedId || heroId === ''}
            className="w-full py-2.5 rounded-lg bg-k3-text-primary text-k3-base text-sm font-medium disabled:opacity-40 min-h-[44px] touch-manipulation"
          >
            {t.start}
          </button>
        </form>
      )}
    </div>
  );
};

export default ReviewEntry;
