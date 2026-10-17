import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import V2Shell from '../V2Shell';
import Composer from '../components/Composer';
import { useI18n } from '../i18n/I18nProvider';
import { MatchFactsError, fetchMatchFacts, type MatchFactsResult } from '../../services/dotaApiService';
import { fetchMatchReviewStream } from '../../services/geminiService';
import { trackEvent, trackReviewViewed } from '../../services/analytics';
import { followUpKind } from '../../utils/analyticsClient';
import { getPresetFollowUps } from '../../utils/reviewConclusions';
import type { MatchPlayerFact } from '../../types/matchReview';
import { parseMatchInput } from '../parseMatchInput';
import { buildCarryQuery } from '../carryQuery';
import ProgressTrace from '../review/ProgressTrace';
import HeroPicker from '../review/HeroPicker';
import ResultHeader from '../review/ResultHeader';
import InsightCard from '../review/InsightCard';
import ParseNotice from '../review/ParseNotice';
import FakedoorCard from '../review/FakedoorCard';
import AiText from '../review/AiText';
import { resolveHeroParam } from '../review/resolveHero';
import { IconMatch } from '../review/icons';
import type { DictKey } from '../i18n/en';

/** Match ids are strings end-to-end (QA P2) — 1–20 digits, never coerced. */
const MATCH_ID_RE = /^\d{1,20}$/;

interface FollowUpTurn {
  id: number;
  question: string;
  answer: string;
  status: 'streaming' | 'done' | 'error';
  error?: string;
}

type ConclusionField = 'turningPoint' | 'topMistake' | 'nextGameRule';

const CARD_DEFS: Array<{ key: ConclusionField; labelKey: DictKey; icon: 'turn' | 'fix' | 'next' }> = [
  { key: 'turningPoint', labelKey: 'cardTurning', icon: 'turn' },
  { key: 'topMistake', labelKey: 'cardMistake', icon: 'fix' },
  { key: 'nextGameRule', labelKey: 'cardNext', icon: 'next' },
];

/**
 * `/m/:matchId?hero=&lang=` — the conversational review page. One chat thread:
 * user match chip → tool-trace progress → hero picker (or the `?hero=` param
 * resolved against the roster) → result header + exactly 3 conclusion cards →
 * preset chips / composer follow-ups streamed via POST /api/review/:id. All
 * numbers come from the API payload verbatim; nothing is computed here.
 */
const MatchPage: React.FC = () => {
  const { matchId: routeMatchId } = useParams<{ matchId: string }>();
  const matchId = routeMatchId ?? '';
  const validId = MATCH_ID_RE.test(matchId);
  const [searchParams] = useSearchParams();
  const heroParam = searchParams.get('hero');
  const location = useLocation();
  const navigate = useNavigate();
  const { lang, t } = useI18n();

  const [reloadKey, setReloadKey] = useState(0);
  const [phase, setPhase] = useState<'loading' | 'pick' | 'loadingHero' | 'results' | 'error'>('loading');
  const [facts, setFacts] = useState<MatchFactsResult | null>(null);
  const [heroFacts, setHeroFacts] = useState<MatchFactsResult | null>(null);
  const [error, setError] = useState<{ message: string; notFound: boolean } | null>(null);
  const [traceStep, setTraceStep] = useState(0);
  // Closed by default: with ?hero= deep links the grid must not flash; "Change" reopens it.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [turns, setTurns] = useState<FollowUpTurn[]>([]);
  const [asked, setAsked] = useState<string[]>([]);

  const heroPlayer = useMemo(
    () => resolveHeroParam(heroParam, facts?.matchFact.players),
    [heroParam, facts],
  );
  const heroId = heroPlayer?.heroId ?? null;

  // ---- scroll anchoring: auto-scroll only when the user is near the bottom ----
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const [away, setAway] = useState(false);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    stickRef.current = near;
    setAway(!near);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
    setAway(false);
  });

  // ---- follow-up streaming ----
  const turnIdRef = useRef(0);
  const streamRef = useRef<AbortController | null>(null);
  const prefillRef = useRef<string | null>(null);
  const streaming = turns.some((turn) => turn.status === 'streaming');

  useEffect(() => () => streamRef.current?.abort(), []);

  const startStream = (id: number, question: string) => {
    const controller = fetchMatchReviewStream(matchId, lang, heroId ?? undefined, question, {
      onData: () => {},
      onChunk: (text) =>
        setTurns((ts) => ts.map((x) => (x.id === id ? { ...x, answer: x.answer + text } : x))),
      onComplete: () => setTurns((ts) => ts.map((x) => (x.id === id ? { ...x, status: 'done' } : x))),
      onError: (message) =>
        setTurns((ts) =>
          ts.map((x) =>
            x.id === id
              ? { ...x, status: controller.signal.aborted ? 'done' : 'error', error: message }
              : x,
          ),
        ),
    });
    streamRef.current = controller;
  };

  const ask = (question: string, kind: 'preset' | 'custom') => {
    const q = question.trim();
    if (!q || streaming) return;
    trackEvent('followup_clicked', { kind });
    setAsked((prev) => (prev.includes(q) ? prev : [...prev, q]));
    // The id must be computed here, not inside the setTurns updater — React
    // defers updaters, so startStream would otherwise capture a stale id and
    // every streamed chunk would target a turn that doesn't exist yet.
    const id = ++turnIdRef.current;
    setTurns((ts) => [...ts, { id, question: q, answer: '', status: 'streaming' }]);
    stickRef.current = true;
    startStream(id, q);
  };

  const retryTurn = (turn: FollowUpTurn) => {
    if (streaming) return;
    stickRef.current = true;
    setTurns((ts) => ts.map((x) => (x.id === turn.id ? { ...x, answer: '', error: undefined, status: 'streaming' } : x)));
    startStream(turn.id, turn.question);
  };

  const onComposerQuestion = (value: string) => {
    ask(value, followUpKind(value, prefillRef.current));
  };

  const onChipAsk = (q: string) => {
    prefillRef.current = q;
    ask(q, 'preset');
  };

  // ---- data loading ----
  useEffect(() => {
    if (!validId) return undefined;
    const ac = new AbortController();
    setPhase('loading');
    setError(null);
    setFacts(null);
    setHeroFacts(null);
    setTurns([]);
    setAsked([]);
    setPickerOpen(false);
    fetchMatchFacts(matchId, lang, ac.signal)
      .then((res) => {
        if (ac.signal.aborted) return;
        setFacts(res);
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        const message = err instanceof Error ? err.message : '';
        const notFound =
          (err instanceof MatchFactsError && err.upstreamStatus === 404) || /not found/i.test(message);
        setError({ message: notFound ? '' : message, notFound });
        setPhase('error');
      });
    return () => ac.abort();
  }, [validId, matchId, lang, reloadKey]);

  useEffect(() => {
    if (!validId || !facts) return undefined;
    const player = resolveHeroParam(heroParam, facts.matchFact.players);
    if (!player) {
      setPhase('pick');
      return undefined;
    }
    const ac = new AbortController();
    setPhase('loadingHero');
    setError(null);
    fetchMatchFacts(matchId, lang, ac.signal, player.heroId)
      .then((res) => {
        if (ac.signal.aborted) return;
        setHeroFacts(res);
        setPhase('results');
        trackReviewViewed(matchId);
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        const message = err instanceof Error ? err.message : '';
        const notFound =
          (err instanceof MatchFactsError && err.upstreamStatus === 404) || /not found/i.test(message);
        setError({ message: notFound ? '' : message, notFound });
        setPhase('error');
      });
    return () => ac.abort();
  }, [validId, matchId, lang, reloadKey, facts, heroParam]);

  // Tool-trace steps advance on a timer while a request is in flight.
  useEffect(() => {
    if (phase === 'loadingHero') {
      setTraceStep(2);
      return undefined;
    }
    if (phase !== 'loading') return undefined;
    setTraceStep(0);
    const id = window.setInterval(() => setTraceStep((s) => Math.min(s + 1, 1)), 700);
    return () => window.clearInterval(id);
  }, [phase, matchId, lang, reloadKey]);

  const pick = (player: MatchPlayerFact) => {
    setPickerOpen(false);
    const slug = player.internalSlug || String(player.heroId);
    if (heroParam === slug) return;
    setTurns([]);
    setAsked([]);
    const params = new URLSearchParams(location.search);
    params.set('hero', slug);
    navigate({ pathname: `/m/${matchId}`, search: `?${params.toString()}` }, { replace: true });
  };

  if (!validId) {
    return (
      <V2Shell>
        <section className="pt-[20px]">
          <p className="m-0 text-d2-15 text-d2-ink-2 bg-d2-surface rounded-[12px] shadow-d2-1 p-[12px]">
            {t('invalidMatch')}
          </p>
        </section>
      </V2Shell>
    );
  }

  const conclusions = heroFacts?.threeConclusions ?? null;
  const presets = getPresetFollowUps(conclusions).filter((q) => !asked.includes(q));
  const summary = heroFacts?.matchFact.summary ?? null;
  const focus = heroFacts?.matchFact.focusLens ?? null;
  const heroName = focus?.displayName ?? heroPlayer?.displayName ?? '';
  const kda =
    focus?.kda ??
    (heroPlayer ? `${heroPlayer.kills}/${heroPlayer.deaths}/${heroPlayer.assists}` : '');
  const outcome =
    conclusions?.outcome ??
    (heroPlayer && summary ? (heroPlayer.isRadiant === summary.radiantWin ? 'win' : 'loss') : null);

  return (
    <V2Shell
      scrollRef={scrollRef}
      onScroll={handleScroll}
      composer={
        <Composer
          mode={phase === 'results' ? 'followUp' : 'match'}
          disabled={streaming}
          onStop={() => streamRef.current?.abort()}
          onSubmitQuestion={onComposerQuestion}
          currentMatchId={matchId}
        />
      }
    >
      {/* Turn 1 — the match the user asked about */}
      <section className="pt-[8px] space-y-[8px]">
        <div className="flex justify-end">
          <div className="inline-flex items-center gap-[10px] bg-d2-surface border border-d2-line-2 rounded-[14px_14px_6px_14px] py-[8px] pl-[8px] pr-[12px] shadow-d2-1 max-w-full">
            <span className="w-[32px] h-[32px] rounded-[9px] bg-d2-surface-2 grid place-items-center flex-none">
              <IconMatch />
            </span>
            <span className="min-w-0">
              <b className="block font-semibold text-d2-15 leading-[20px] text-d2-ink">
                {t('matchChipTitle')} <span className="d2-tnum">{matchId}</span>
              </b>
              <span className="block text-d2-12 leading-[16px] text-d2-ink-4">{t('matchChipSub')}</span>
            </span>
          </div>
        </div>

        {facts ? <ProgressTrace step={traceStep} done={phase !== 'loading' && phase !== 'loadingHero'} /> : null}

        {error && (
          <div className="bg-d2-down-bg border-l-[3px] border-d2-down rounded-[14px] px-[14px] py-[12px]">
            <p className="m-0 text-d2-15 text-d2-ink-2">
              {error.notFound ? t('errMatchNotFound') : error.message || t('errLoad')}
            </p>
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              className="mt-[8px] inline-flex items-center min-h-[36px] px-[14px] rounded-d2-control bg-d2-surface border border-d2-line-2 text-d2-13 font-semibold text-d2-ink-2 shadow-d2-1"
            >
              {t('btnRetry')}
            </button>
          </div>
        )}

        {facts && <ParseNotice matchId={matchId} parse={heroFacts?.parse ?? facts.parse} />}

        {facts && heroPlayer && !pickerOpen && phase !== 'error' && (
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="w-full flex items-center gap-[10px] min-h-[44px] px-[14px] rounded-[12px] bg-d2-surface shadow-d2-1 text-d2-13 text-d2-ink-3 text-left"
          >
            <span className="w-[28px] h-[28px] rounded-[7px] bg-[#ECEEF2] grid place-items-center text-d2-13 font-semibold text-d2-ink-2 flex-none" aria-hidden="true">
              {heroName.slice(0, 1)}
            </span>
            <span className="min-w-0 truncate">
              <b className="font-semibold text-d2-ink">
                {t('youPrefix')}: {heroName}
              </b>{' '}
              · {t(heroPlayer.isRadiant ? 'sideRadiant' : 'sideDire')} ·{' '}
              <span className="d2-tnum">{kda}</span>
            </span>
            <span className="ml-auto flex-none text-d2-accent font-semibold">{t('changeHero')}</span>
          </button>
        )}

        {facts && (!heroPlayer || pickerOpen) && phase !== 'error' && (
          <HeroPicker
            players={facts.matchFact.players}
            winner={facts.matchFact.summary.winner}
            selectedHeroId={heroId}
            onPick={pick}
          />
        )}
      </section>

      {/* Turn 2 — the review: header + exactly 3 conclusion cards */}
      {heroFacts && phase === 'results' && (
        <section className="mt-[24px] space-y-[8px]">
          {summary && (
            <ResultHeader
              heroName={heroName}
              kda={kda}
              isRadiant={heroPlayer?.isRadiant ?? true}
              outcome={outcome}
              duration={summary.durationFormatted}
            />
          )}

          {conclusions ? (
            CARD_DEFS.map(({ key, labelKey, icon }) => (
              <InsightCard key={key} label={t(labelKey)} icon={icon} conclusion={conclusions[key]} />
            ))
          ) : (
            <p className="m-0 text-d2-15 text-d2-ink-3 bg-d2-surface rounded-d2-card shadow-d2-2 p-[16px]">
              {t('noConclusions')}
            </p>
          )}

          {presets.length > 0 && (
            <div className="flex flex-wrap gap-[8px] pt-[4px]">
              {presets.map((q) => (
                <button
                  key={q}
                  type="button"
                  disabled={streaming}
                  onClick={() => onChipAsk(q)}
                  className="inline-flex items-center min-h-[44px] px-[14px] rounded-d2-chip bg-d2-surface border border-d2-line-2 text-d2-13 font-medium text-d2-ink-2 shadow-d2-1 transition-colors duration-d2-fast hover:border-d2-accent hover:text-d2-ink disabled:opacity-50"
                >
                  {q}
                </button>
              ))}
            </div>
          )}

          <FakedoorCard />
        </section>
      )}

      {/* Follow-up turns: user bubble + streamed AI answer */}
      {turns.map((turn) => (
        <section key={turn.id} className="mt-[24px] space-y-[8px]">
          <div className="flex justify-end">
            <div className="max-w-[82%] bg-[#ECEEF2] text-d2-ink rounded-[18px_18px_6px_18px] px-[14px] py-[10px] text-d2-15 font-medium break-words">
              {turn.question}
            </div>
          </div>
          {turn.status === 'error' ? (
            <div className="bg-d2-down-bg border-l-[3px] border-d2-down rounded-[14px] px-[14px] py-[12px]">
              <p className="m-0 text-d2-15 text-d2-ink-2">{t('errFollowUp')}</p>
              <button
                type="button"
                onClick={() => retryTurn(turn)}
                className="mt-[8px] inline-flex items-center min-h-[36px] px-[14px] rounded-d2-control bg-d2-surface border border-d2-line-2 text-d2-13 font-semibold text-d2-ink-2 shadow-d2-1"
              >
                {t('btnRetry')}
              </button>
            </div>
          ) : (
            <AiText text={turn.answer} streaming={turn.status === 'streaming'} />
          )}
        </section>
      ))}

      {away && (
        <div className="sticky bottom-[8px] z-[5] flex justify-center pointer-events-none">
          <button
            type="button"
            onClick={() => {
              const el = scrollRef.current;
              stickRef.current = true;
              setAway(false);
              if (el) el.scrollTop = el.scrollHeight;
            }}
            className="pointer-events-auto inline-flex items-center gap-[6px] h-[32px] px-[12px] rounded-d2-chip bg-d2-surface shadow-d2-3 text-d2-13 font-semibold text-d2-ink-2"
          >
            {t('jumpLatest')}
          </button>
        </div>
      )}
    </V2Shell>
  );
};

export default MatchPage;
