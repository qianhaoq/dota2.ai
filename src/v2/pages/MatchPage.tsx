import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import V2Shell from '../V2Shell';
import Composer from '../components/Composer';
import { useI18n } from '../i18n/I18nProvider';
import type { DictKey } from '../i18n/en';
import { en } from '../i18n/en';
import { useFlags } from '../FlagsProvider';
import { isSafeMatchId } from '../parseMatchInput';
import { readSse, useReviewStream } from '../review/useReviewStream';
import type { Followup, Review, StreamError } from '../review/types';
import { trackEvent } from '../../services/analytics';
import { reviewViewed } from '../review/analytics';
import AiText from '../review/AiText';
import InsightCard from '../review/InsightCard';
import FakedoorCard from '../review/FakedoorCard';
import ResultHeader from '../review/ResultHeader';
import { control, surface, ToolTrace, HeroGrid, HeroCollapsedRow, MiniChart, FollowupChips, RefusalBubble, Share, JumpToLatest, FactChip } from '../review/ConversationCards';
interface Turn {
    id: number;
    question: string;
    text: string;
    status: 'streaming' | 'done' | 'error';
    error?: StreamError;
    gaps: Review['data_gaps'];
    factIds: string[];
    followup?: Followup;
}
const failure: StreamError = { code: 'INTERNAL', retryable: true, message_key: 'err.internal' };
export default function MatchPage() {
    const { matchId = '' } = useParams();
    const [params] = useSearchParams();
    const hero = params.get('hero');
    const { lang, t } = useI18n();
    const flags = useFlags();
    const navigate = useNavigate(), location = useLocation();
    const valid = isSafeMatchId(matchId);
    const stream = useReviewStream(matchId, hero, lang, valid);
    const review = stream.done?.review;
    const [picker, setPicker] = useState(false);
    const [turns, setTurns] = useState<Turn[]>([]);
    const [asked, setAsked] = useState<string[]>([]);
    const [inputError, setInputError] = useState(false);
    const scroll = useRef<HTMLDivElement>(null), stick = useRef(true);
    const [away, setAway] = useState(false);
    const request = useRef<AbortController | null>(null), epoch = useRef(0), turnId = useRef(0), busy = useRef(false);
    const context = `${matchId}:${hero}:${lang}`;
    const contextRef = useRef(context);
    contextRef.current = context;
    const [reduced, setReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
    useEffect(() => {
        const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
        if (!media)
            return;
        const change = () => setReduced(media.matches);
        media.addEventListener?.('change', change);
        return () => media.removeEventListener?.('change', change);
    }, []);
    useEffect(() => {
        ++epoch.current;
        request.current?.abort();
        busy.current = false;
        setTurns([]);
        setAsked([]);
        setPicker(false);
        setInputError(false);
        stick.current = true;
        setAway(false);
        return () => {
            ++epoch.current;
            request.current?.abort();
            busy.current = false;
        };
    }, [context, valid]);
    useEffect(() => {
        if (!stream.insights.some(Boolean))
            return;
        const player = review?.player ?? stream.resultHeader?.player;
        if (player)
            reviewViewed(matchId, String(player.hero_id), { state: stream.done?.state ?? (stream.insights.find(Boolean)?.status === 'insufficient' ? 'insufficient' : stream.resultHeader?.match.parsed ? 'parsed' : 'unparsed'), lang, phrasing: stream.insights.find(Boolean)?.claim.phrasing ?? 'template' });
    }, [matchId, lang, stream.insights, stream.resultHeader, stream.done, review]);
    useEffect(() => {
        if (scroll.current && stick.current)
            scroll.current.scrollTop = scroll.current.scrollHeight;
    }, [stream, turns]);
    useEffect(() => {
        if (stream.status === 'done' && params.get('claim'))
            document.getElementById(`claim-${params.get('claim')}`)?.scrollIntoView?.({ behavior: 'instant' });
    }, [stream.status, params]);
    const errorText = (error: StreamError) => t(Object.hasOwn(en, error.message_key) ? error.message_key as DictKey : 'err.internal');
    const start = async (turn: Turn) => {
        const ac = new AbortController();
        request.current = ac;
        busy.current = true;
        const rev = ++epoch.current, stamped = context;
        const current = () => !ac.signal.aborted && rev === epoch.current && stamped === contextRef.current;
        let complete = false, collected = '';
        const update = (fn: (t: Turn) => Turn) => {
            if (current())
                setTurns(prev => prev.map(t => t.id === turn.id ? fn(t) : t));
        };
        const timeout = setTimeout(() => {
            if (current()) {
                setTurns(prev => prev.map(t => t.id === turn.id ? { ...t, status: 'error', error: failure } : t));
                busy.current = false;
                ac.abort();
            }
        }, 60000);
        try {
            const response = await fetch(`/api/v1/review/${matchId}/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, signal: ac.signal, body: JSON.stringify({ hero, lang, ...(turn.followup ? { followup_id: turn.followup.id } : { question: turn.question }) }) });
            await readSse(response, ac.signal, frame => {
                if (!current() || complete)
                    return;
                if (frame.event === 'token' && frame.data.target === 'answer') {
                    collected = frame.data.mode === 'replace_start' ? '' : collected + (frame.data.delta ?? '');
                    if (!reduced)
                        update(t => ({ ...t, text: collected }));
                }
                if (frame.event === 'done') {
                    complete = true;
                    update(t => ({ ...t, text: frame.data.answer ?? collected, status: 'done' }));
                    return true;
                }
                if (frame.event === 'error') {
                    complete = true;
                    update(t => ({ ...t, status: 'error', error: frame.data }));
                    return true;
                }
            });
            if (!complete && current())
                throw new Error('incomplete');
        }
        catch {
            update(t => ({ ...t, status: 'error', error: failure }));
        }
        finally {
            clearTimeout(timeout);
            if (rev === epoch.current)
                busy.current = false;
        }
    };
    const ask = (question: string, followup?: Followup) => {
        if (!review?.player || busy.current || !question.trim())
            return;
        if (question.length > 300 && !followup) {
            setInputError(true);
            return;
        }
        setInputError(false);
        // Mirror approved free-question routing; unsupported topics are tied to registered gaps.
        const unsupported = /\b(vision|wards?|position|coordinates|build|items?|baseline|bracket)\b|视野|站位|坐标|位置|出装|同段位/i.test(question);
        const inferred = !unsupported ? review.followups.find(f => f.id === (/\b(deaths?|killed|killers?)\b|死亡|击杀者/i.test(question) ? 'death_list' : /\b(laning|lane|last hits?)\b|对线|补刀/i.test(question) ? 'laning_0_10' : '')) : undefined;
        const answerable = followup?.answerable ?? inferred?.answerable ?? false;
        trackEvent('followup_clicked', { followup_id: followup?.id ?? 'free', answerable });
        if (followup)
            setAsked(prev => [...prev, followup.id]);
        const topic = followup?.gap ?? (/build|items?|出装/i.test(question) ? 'build_vs_lineup' : /baseline|bracket|同段位/i.test(question) ? 'laning_baseline' : /position|coordinates|位置|坐标/i.test(question) ? 'death_locations' : undefined);
        const gaps = answerable ? [] : review.data_gaps.filter(g => !topic || g.topic === topic);
        const turn: Turn = { id: ++turnId.current, question, text: '', status: 'streaming', gaps, factIds: (followup ?? inferred)?.fact_ids ?? [], followup };
        setTurns(prev => [...prev, turn]);
        void start(turn);
    };
    const stop = () => {
        ++epoch.current;
        request.current?.abort();
        busy.current = false;
        setTurns(prev => prev.map(t => t.status === 'streaming' ? { ...t, status: 'done' } : t));
    };
    const streaming = turns.some(t => t.status === 'streaming');
    const player = review?.player ?? stream.resultHeader?.player;
    if (!valid)
        return <V2Shell><p role="alert">{t('invalidMatch')}</p></V2Shell>;
    return <V2Shell topBarAction={review?.player ? <Share matchId={matchId} hero={hero} lang={lang} claim={params.get('claim') ?? '1'} review={review}/> : undefined} scrollRef={scroll} onScroll={() => {
        const el = scroll.current!;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 120;
        setAway(!stick.current);
    }} composer={<Composer mode={review?.player ? 'followUp' : 'match'} disabled={streaming} onStop={stop} currentMatchId={matchId} onSubmitQuestion={q => ask(q)}/>}>
    <div className="space-y-[8px]"><div className="flex justify-end"><div className={`${surface} text-d2-15`}><b className="block">{matchId}</b><span className="text-d2-12 text-d2-ink-4">{t('matchChipTitle')}</span></div></div>
      <ToolTrace steps={stream.steps} done={stream.status === 'done'} timings={stream.done?.timings}/>
      {stream.error && <div role="alert" className={surface}>{errorText(stream.error)} {stream.error.retryable && <button className={control} onClick={stream.retry}>{t('btnRetry')}</button>}</div>}
      {(picker || stream.done?.state === 'needs_hero') && <HeroGrid roster={review?.roster ?? stream.heroPick} pick={h => {
                setPicker(false);
                if (h.hero_id === player?.hero_id)
                    return;
                const next = new URLSearchParams(location.search);
                next.set('hero', h.hero);
                navigate({ pathname: location.pathname, search: `?${next}` }, { replace: true });
            }}/>}
      {player && <HeroCollapsedRow hero={player.hero} change={() => setPicker(true)}/>}
      {player && <ResultHeader heroName={player.hero.replaceAll('_', ' ')} heroSlug={player.hero} kda="" isRadiant={player.team === 'radiant'} outcome={player.result} duration={review?.facts['ancient.fell']?.display[lang] ?? ''} chart={review?.series ? <MiniChart series={review.series}/> : undefined}/>}
      {stream.insights.map((insight, i) => insight && <InsightCard key={i} insight={insight} index={i + 1} review={review} streaming={stream.status === 'streaming'}/>)}
      {stream.done && stream.done.state !== 'parsed' && stream.done.state !== 'needs_hero' && <p className="text-d2-13 text-d2-warn">{t('insufficientBadge')}</p>}
      {review?.player && <FollowupChips followups={stream.followups} asked={asked} disabled={streaming} ask={f => ask(f.label, f)}/>}
      {inputError && <p role="alert">{t('questionTooLong')}</p>}
      {turns.map(turn => <section key={turn.id} className="pt-[16px] space-y-[8px]"><div className="flex justify-end"><p className="rounded-[18px_18px_6px_18px] bg-d2-surface-3 px-[14px] py-[10px] max-w-[82%] break-words text-d2-15 font-medium">{turn.question}</p></div><AiText text={turn.text} streaming={turn.status === 'streaming'}/>{turn.gaps.length > 0 && <RefusalBubble gaps={turn.gaps}/>}<div className="flex flex-wrap gap-[8px]">{turn.factIds.map(id => review?.facts[id] && <FactChip key={id} fact={review.facts[id]}/>)}</div>{turn.error && <div role="alert">{errorText(turn.error)}{turn.error.retryable && <button className={control} disabled={streaming} onClick={() => {
        setTurns(prev => prev.map(t => t.id === turn.id ? { ...t, status: 'streaming', error: undefined, text: '' } : t));
        void start(turn);
    }}>{t('btnRetry')}</button>}</div>}</section>)}
      {review?.player && flags.fakedoor_v2 && (stream.fakedoor || stream.status === 'done') && <FakedoorCard />}
      {away && <JumpToLatest jump={() => {
                stick.current = true;
                setAway(false);
                if (scroll.current)
                    scroll.current.scrollTop = scroll.current.scrollHeight;
            }}/>}
    </div>
  </V2Shell>;
}
