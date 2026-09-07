import React, { useMemo, useState, useEffect, useRef } from 'react';
import { Language, Hero } from '../../types';
import type { MatchFact } from '../../types/matchReview';
import { Film, Search, ChevronDown, Loader2 } from 'lucide-react';
import { parseMatchId } from '../../utils/parseMatchId';
import { isHeroInMatch, rosterFromMatchFact } from '../../utils/reviewRoster';
import { fetchMatchFacts } from '../../services/dotaApiService';

interface ReviewEntryProps {
  lang: Language;
  allHeroes: Hero[];
  practiceHero: Hero | null;
  isLoading: boolean;
  defaultExpanded?: boolean;
  density?: 'full' | 'compact';
  onStartReview: (matchId: number, heroId?: number) => void;
}

const ReviewEntry: React.FC<ReviewEntryProps> = ({
  lang,
  allHeroes,
  practiceHero,
  isLoading,
  defaultExpanded = false,
  density = 'full',
  onStartReview,
}) => {
  const [matchInput, setMatchInput] = useState('');
  const [heroId, setHeroId] = useState<number | ''>('');
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [factsLoading, setFactsLoading] = useState(false);
  const [factsError, setFactsError] = useState<string | null>(null);
  const [matchFact, setMatchFact] = useState<MatchFact | null>(null);
  const factsRequestIdRef = useRef(0);

  const invalidateFactsRequest = () => {
    factsRequestIdRef.current += 1;
    setFactsLoading(false);
  };

  useEffect(() => {
    return () => {
      factsRequestIdRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (defaultExpanded) setExpanded(true);
  }, [defaultExpanded]);

  useEffect(() => {
    if (isLoading) setExpanded(false);
  }, [isLoading]);

  const t = useMemo(() => ({
    title: lang === 'zh' ? '复盘一局' : 'Review a match',
    subtitle: lang === 'zh' ? '输入比赛 ID 或 OpenDota / Dotabuff 链接' : 'Match ID or OpenDota / Dotabuff URL',
    placeholder: lang === 'zh' ? '8985182860 或 opendota.com/matches/...' : '8985182860 or opendota.com/matches/...',
    fetch: lang === 'zh' ? '拉取比赛' : 'Load match',
    fetching: lang === 'zh' ? '正在拉取比赛…' : 'Loading match…',
    hero: lang === 'zh' ? '选择本局英雄' : 'Pick a hero from this match',
    heroHint: lang === 'zh' ? '仅显示本场出场英雄' : 'Only heroes who played this match',
    start: lang === 'zh' ? '开始复盘' : 'Start review',
    invalid: lang === 'zh' ? '请输入有效的比赛 ID 或链接' : 'Enter a valid match ID or URL',
    needHero: lang === 'zh' ? '请选择复盘英雄' : 'Select a hero to review',
    changeMatch: lang === 'zh' ? '换一场' : 'Change match',
    radiant: lang === 'zh' ? '天辉' : 'Radiant',
    dire: lang === 'zh' ? '夜魇' : 'Dire',
    emptyRoster: lang === 'zh' ? '这场比赛没有可用英雄数据' : 'No hero data for this match',
  }), [lang]);

  const parsedId = parseMatchId(matchInput);
  const roster = useMemo(() => rosterFromMatchFact(matchFact, allHeroes), [matchFact, allHeroes]);
  const factsReady = Boolean(matchFact && parsedId && matchFact.summary.matchId === parsedId);

  useEffect(() => {
    if (!factsReady) return;
    if (isHeroInMatch(matchFact, heroId)) return;
    const practiceId = practiceHero?.id;
    if (practiceId && isHeroInMatch(matchFact, practiceId)) {
      setHeroId(practiceId);
      return;
    }
    setHeroId('');
  }, [factsReady, matchFact, practiceHero?.id, heroId]);

  const handleFetchFacts = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!parsedId || factsLoading || isLoading) return;
    const requestId = factsRequestIdRef.current + 1;
    factsRequestIdRef.current = requestId;
    setFactsLoading(true);
    setFactsError(null);
    setMatchFact(null);
    setHeroId('');
    try {
      const fact = await fetchMatchFacts(parsedId, lang);
      if (factsRequestIdRef.current !== requestId) return;
      setMatchFact(fact);
    } catch (err) {
      if (factsRequestIdRef.current !== requestId) return;
      const message = err instanceof Error ? err.message : t.invalid;
      setFactsError(message);
    } finally {
      if (factsRequestIdRef.current === requestId) {
        setFactsLoading(false);
      }
    }
  };

  const handleStart = (e: React.FormEvent) => {
    e.preventDefault();
    if (!parsedId || !heroId || !factsReady) return;
    onStartReview(parsedId, Number(heroId));
  };

  const handleChangeMatch = () => {
    invalidateFactsRequest();
    setMatchFact(null);
    setHeroId('');
    setFactsError(null);
  };

  const handleMatchInput = (value: string) => {
    setMatchInput(value);
    const nextId = parseMatchId(value);
    if (factsLoading || (matchFact && nextId !== matchFact.summary.matchId)) {
      invalidateFactsRequest();
      setMatchFact(null);
      setHeroId('');
      setFactsError(null);
    }
  };

  const summary = matchFact?.summary;
  const winnerLabel = summary
    ? (lang === 'zh' ? summary.winnerLabelZh : summary.winnerLabelEn)
    : '';

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
        <div className={`mt-2 p-3 rounded-xl border border-k3-border-subtle bg-k3-surface space-y-3 ${density === 'compact' ? 'max-h-[46vh] overflow-y-auto custom-scrollbar' : ''}`}>
          {!factsReady ? (
            <form onSubmit={handleFetchFacts} className="space-y-3">
              <p className="text-[11px] text-k3-text-tertiary">{t.subtitle}</p>
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-k3-text-tertiary" />
                <input
                  type="text"
                  value={matchInput}
                  onChange={(e) => handleMatchInput(e.target.value)}
                  placeholder={t.placeholder}
                  className="w-full pl-9 pr-3 py-2.5 rounded-lg bg-k3-elevated border border-k3-border-subtle text-sm text-k3-text-primary placeholder:text-k3-text-tertiary min-h-[44px]"
                  inputMode="numeric"
                  autoComplete="off"
                />
              </div>
              {matchInput && !parsedId && (
                <p className="text-xs text-yellow-400">{t.invalid}</p>
              )}
              {factsError && (
                <p className="text-xs text-yellow-400">{factsError}</p>
              )}
              <button
                type="submit"
                disabled={factsLoading || isLoading || !parsedId}
                className="w-full py-2.5 rounded-lg bg-k3-text-primary text-k3-base text-sm font-medium disabled:opacity-40 min-h-[44px] touch-manipulation inline-flex items-center justify-center gap-2"
              >
                {factsLoading && <Loader2 size={14} className="animate-spin" />}
                {factsLoading ? t.fetching : t.fetch}
              </button>
            </form>
          ) : (
            <form onSubmit={handleStart} className="space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm text-k3-text-primary font-medium truncate">
                    {lang === 'zh' ? `比赛 ${summary?.matchId}` : `Match ${summary?.matchId}`}
                  </p>
                  <p className="text-[11px] text-k3-text-tertiary">
                    {winnerLabel}
                    {summary?.durationFormatted ? ` · ${summary.durationFormatted}` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleChangeMatch}
                  className="text-xs text-k3-text-secondary hover:text-k3-text-primary min-h-[36px] px-2 touch-manipulation flex-shrink-0"
                >
                  {t.changeMatch}
                </button>
              </div>

              <div>
                <label className="text-[11px] text-k3-text-tertiary block mb-1">{t.hero}</label>
                <p className="text-[11px] text-k3-text-tertiary/80 mb-2">{t.heroHint}</p>
                {roster.length === 0 ? (
                  <p className="text-xs text-yellow-400">{t.emptyRoster}</p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {roster.map(({ player, hero }) => {
                      const selected = heroId === player.heroId;
                      const name = lang === 'zh'
                        ? (hero?.nameZh || player.nameZh || player.displayName)
                        : (hero?.nameEn || hero?.name || player.nameEn || player.displayName);
                      return (
                        <button
                          key={`${player.playerSlot}-${player.heroId}`}
                          type="button"
                          onClick={() => setHeroId(player.heroId)}
                          className={`flex items-center gap-2 px-2 py-2 rounded-lg border text-left min-h-[44px] touch-manipulation ${
                            selected
                              ? 'border-k3-text-primary/40 bg-k3-elevated text-k3-text-primary'
                              : 'border-k3-border-subtle bg-k3-elevated/50 text-k3-text-secondary hover:text-k3-text-primary'
                          }`}
                        >
                          {hero?.icon || hero?.img ? (
                            <img src={hero.icon || hero.img} alt="" className="w-6 h-6 rounded object-cover flex-shrink-0" />
                          ) : (
                            <span className="w-6 h-6 rounded bg-k3-surface flex-shrink-0" />
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block text-xs font-medium truncate">{name}</span>
                            <span className="block text-[10px] text-k3-text-tertiary">
                              {player.isRadiant ? t.radiant : t.dire}
                              {` · ${player.kills}/${player.deaths}/${player.assists}`}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {heroId === '' && (
                <p className="text-xs text-k3-text-tertiary">{t.needHero}</p>
              )}

              <button
                type="submit"
                disabled={isLoading || heroId === ''}
                className="w-full py-2.5 rounded-lg bg-k3-text-primary text-k3-base text-sm font-medium disabled:opacity-40 min-h-[44px] touch-manipulation"
              >
                {t.start}
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
};

export default ReviewEntry;
