import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Shell } from '../coach/CoachApp';
import { fetchCoachReport } from '../coach/api';
import type { CoachReport } from '../coach/types';
import { SafeImg, useLang } from '../coach/ui';
import { parseMatchInput } from '../v2/parseMatchInput';
import { markReviewed } from '../coach/accountInput';
import { trackReviewViewed } from '../services/analytics';
import { AgentApiError, fetchAvailability, fetchReview, startReview, type AgentHero, type Availability, type ReviewState } from './api';
import { ChatRail, stepLabel, type ChatHandle } from './ChatRail';
import { ReviewDoc } from './ReviewDoc';
import './agent.css';

/**
 * /r/:matchId — the match page. An agent investigates the replay and writes
 * the review; the reader checks it against the cited records and asks the
 * coach anything else. Without a parsed replay there is no review: the page
 * says so and shows the scoreboard, it does not guess.
 */

const T = {
  loading: { en: 'Opening the match…', zh: '正在打开对局…' },
  invalid: { en: 'That is not a match ID.', zh: '这不是一个比赛编号。' },
  home: { en: 'Back to the start', zh: '回到首页' },
  match: { en: 'Match', zh: '比赛' },
  noTraceTitle: { en: 'This game has no parsed replay yet', zh: '这局还没有解析过的录像' },
  noTraceBody: { en: 'The coach reviews a game from its replay: positions, cooldowns, every cast. Without it there is nothing to review honestly, so nothing is shown in its place. Replays are available for about two weeks after a game.', zh: '教练靠录像复盘：站位、冷却、每一次施法。没有录像就没有可以诚实复盘的东西，所以这里不放替代内容。录像在赛后大约两周内可用。' },
  scoreboard: { en: 'Scoreboard', zh: '记分板' },
  pick: { en: 'Which hero did you play?', zh: '你玩的是哪个英雄？' },
  radiant: { en: 'Radiant', zh: '天辉' },
  dire: { en: 'Dire', zh: '夜魇' },
  change: { en: 'Change hero', zh: '换英雄' },
  startTitle: { en: 'No review of this hero yet', zh: '这个英雄还没有复盘' },
  startBody: { en: 'The coach will go through the replay — deaths, ultimate usage, the fights that turned the game, the build — and write the review. About two minutes.', zh: '教练会把录像过一遍——阵亡、大招使用、转折团战、出装——然后写出复盘。大约两分钟。' },
  start: { en: 'Review my game', zh: '开始复盘' },
  runningTitle: { en: 'The coach is going through the replay', zh: '教练正在看录像' },
  runningBody: { en: 'You can leave this page open; the review appears here when it is done.', zh: '可以把页面开着，复盘写完会出现在这里。' },
  writing: { en: 'Writing the review…', zh: '正在写复盘…' },
  failedTitle: { en: 'The review did not come out', zh: '这次复盘没有写出来' },
  failedBody: { en: 'The coach could not finish a review it could back with the replay. Try again.', zh: '教练没能写出一份有录像依据的复盘。可以再试一次。' },
  retry: { en: 'Try again', zh: '再试一次' },
  unavailable: { en: 'The coach is not available right now.', zh: '教练暂时不可用。' },
  rate: { en: 'Too many reviews started from here. Try again in a few minutes.', zh: '从这里发起的复盘太多了，过几分钟再试。' },
  busy: { en: 'The coach is at capacity. Try again later.', zh: '教练现在忙不过来，稍后再试。' },
  unknownHero: { en: 'That hero is not in this game.', zh: '这局里没有这个英雄。' },
  checked: { en: 'Times and numbers in this review were checked against the replay records.', zh: '这份复盘里的时间点和数字已经和录像记录核对过。' },
  dropped: { en: 'removed for lack of evidence', zh: '条因缺少依据被删去' },
  q1: { en: 'Which of my deaths was the most avoidable?', zh: '我哪一次阵亡最不应该？' },
  qFinding: { en: 'what exactly should I have done instead?', zh: '具体应该怎么打？' },
} as const;

type Lang = 'en' | 'zh';

const Portrait: React.FC<{ hero: AgentHero; report: CoachReport | null; lang: Lang }> = ({ hero, report, lang }) => {
  const img = report?.players.find((p) => p.hero.id === hero.hero_id)?.hero.img;
  return img ? <SafeImg src={img} alt={hero[lang]} className="ag-portrait" /> : <span className="ag-portrait ag-portrait--blank" aria-hidden="true" />;
};

export const AgentMatchPage: React.FC = () => {
  const { matchId = '' } = useParams();
  const [search, setSearch] = useSearchParams();
  const { lang } = useLang();
  const t = (b: Record<Lang, string>) => b[lang];
  const valid = parseMatchInput(matchId) === matchId;
  const [avail, setAvail] = useState<Availability | null>(null);
  const [report, setReport] = useState<CoachReport | null>(null);
  const [state, setState] = useState<ReviewState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const chat = useRef<ChatHandle>(null);

  // The replay trace decides what this page can be; the scoreboard is optional decoration.
  useEffect(() => {
    if (!valid) return undefined;
    const ac = new AbortController();
    setAvail(null); setReport(null);
    fetchAvailability(matchId, ac.signal).then(setAvail).catch((e) => { if (e.name !== 'AbortError') setAvail({ trace: false, model_configured: false, heroes: [] }); });
    fetchCoachReport(matchId, { signal: ac.signal }).then(setReport).catch(() => {});
    return () => ac.abort();
  }, [matchId, valid]);

  // ?hero=<key>, or an older ?p=<slot> link resolved through the scoreboard.
  const hero = useMemo(() => {
    if (!avail?.trace) return null;
    const key = search.get('hero');
    if (key) return avail.heroes.find((h) => h.hero === key) ?? null;
    const slot = search.has('p') ? Number(search.get('p')) : null;
    const id = slot != null && report ? report.players[slot]?.hero.id : null;
    return id != null ? avail.heroes.find((h) => h.hero_id === id) ?? null : null;
  }, [avail, search, report]);
  const heroKey = hero?.hero ?? null;

  const pickHero = (key: string | null) => {
    const next = new URLSearchParams(search);
    next.delete('p'); next.delete('pos');
    if (key) next.set('hero', key); else next.delete('hero');
    setSearch(next, { replace: false });
  };

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!heroKey) return;
    try { setState(await fetchReview(matchId, heroKey, lang, signal)); } catch (e) { if ((e as Error).name !== 'AbortError') setState({ status: 'failed' }); }
  }, [matchId, heroKey, lang]);

  useEffect(() => {
    setState(null); setNotice(null);
    if (!heroKey) return undefined;
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [heroKey, load]);

  // While the agent works, ask how far it is every couple of seconds.
  useEffect(() => {
    if (state?.status !== 'running') return undefined;
    const timer = setTimeout(() => { void load(); }, 2500);
    return () => clearTimeout(timer);
  }, [state, load]);

  async function start() {
    if (!heroKey) return;
    setNotice(null);
    try { setState(await startReview(matchId, heroKey, lang)); } catch (e) {
      const status = e instanceof AgentApiError ? e.status : 0;
      setNotice(t(status === 429 ? T.rate : status === 503 ? T.busy : T.unavailable));
    }
  }

  // A finished review counts as "reviewed" on the player's games list, once.
  const ready = state?.status === 'ready';
  useEffect(() => {
    if (!ready || !heroKey) return;
    markReviewed(matchId);
    trackReviewViewed(matchId, { hero: heroKey, kind: 'agent' });
  }, [ready, matchId, heroKey]);

  const ask = (label: string, refs: string[]) => chat.current?.ask(label, refs);
  const suggestions = useMemo(() => {
    if (state?.status !== 'ready') return [];
    const first = state.review.findings[0]?.title;
    return [...(first ? [lang === 'zh' ? `「${first}」——${T.qFinding.zh}` : `"${first}" — ${T.qFinding.en}`] : []), t(T.q1)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, lang]);

  if (!valid) return <Shell><div className="ag-state"><h1>{t(T.invalid)}</h1><Link to={`/?lang=${lang}`} className="ag-btn">{t(T.home)}</Link></div></Shell>;
  if (!avail) return <Shell><div className="ag-state" role="status"><p className="ag-pulse">{t(T.loading)}</p></div></Shell>;

  const header = (
    <header className="ag-head">
      <p className="cx-eyebrow">{t(T.match)} {matchId}{report?.match?.patch ? ` · ${report.match.patch}` : ''}</p>
      {hero && (
        <div className="ag-head-hero">
          <Portrait hero={hero} report={report} lang={lang} />
          <strong>{hero[lang]}</strong>
          <span className={`ag-team is-${hero.team}`}>{t(T[hero.team])}</span>
          <button type="button" className="ag-link" onClick={() => pickHero(null)}>{t(T.change)}</button>
        </div>
      )}
    </header>
  );

  if (!avail.trace) {
    return (
      <Shell>
        {header}
        <div className="ag-state">
          <h1>{t(T.noTraceTitle)}</h1>
          <p>{t(T.noTraceBody)}</p>
        </div>
        {report && (
          <section className="ag-board" aria-label={t(T.scoreboard)}>
            <h2>{t(T.scoreboard)}</h2>
            <ul>
              {report.players.map((p) => (
                <li key={p.slot} className={p.radiant ? 'is-radiant' : 'is-dire'}>
                  {p.hero.img ? <SafeImg src={p.hero.img} alt={p.hero[lang]} className="ag-portrait" /> : <span className="ag-portrait ag-portrait--blank" />}
                  <span>{p.hero[lang]}</span>
                  <span className="ag-kda">{p.kda.join(' / ')}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </Shell>
    );
  }

  if (!hero) {
    const unknown = search.has('hero');
    return (
      <Shell>
        {header}
        <section className="ag-pick">
          <h1>{t(T.pick)}</h1>
          {unknown && <p className="ag-warn" role="alert">{t(T.unknownHero)}</p>}
          {(['radiant', 'dire'] as const).map((team) => (
            <div key={team} className="ag-pick-team">
              <p className={`ag-team is-${team}`}>{t(T[team])}</p>
              <div className="ag-pick-row">
                {avail.heroes.filter((h) => h.team === team).map((h) => (
                  <button key={h.hero} type="button" onClick={() => pickHero(h.hero)}>
                    <Portrait hero={h} report={report} lang={lang} />
                    <span>{h[lang]}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>
      </Shell>
    );
  }

  if (state?.status === 'ready') {
    return (
      <Shell wide>
        {header}
        <div className="ag-layout">
          <div>
            <ReviewDoc matchId={matchId} review={state.review} lang={lang} onAsk={ask} />
            <p className="ag-checked">{t(T.checked)}{state.verification.dropped > 0 ? ` ${state.verification.dropped} ${t(T.dropped)}.` : ''}</p>
          </div>
          <ChatRail ref={chat} matchId={matchId} hero={hero.hero} lang={lang} suggestions={suggestions} />
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      {header}
      <div className="ag-state" role="status">
        {!state && <p className="ag-pulse">{t(T.loading)}</p>}
        {state?.status === 'none' && (<><h1>{t(T.startTitle)}</h1><p>{t(T.startBody)}</p><button type="button" className="ag-btn is-primary" onClick={start} disabled={!avail.model_configured}>{t(T.start)}</button>{!avail.model_configured && <p className="ag-warn">{t(T.unavailable)}</p>}</>)}
        {state?.status === 'running' && (
          <>
            <h1>{t(T.runningTitle)}</h1>
            <p>{t(T.runningBody)}</p>
            <ol className="ag-steps ag-steps--big">
              {state.steps.map((s, i) => <li key={i}>{stepLabel(s, lang)}</li>)}
              <li className="is-live">{state.steps.length >= 6 ? t(T.writing) : '…'}</li>
            </ol>
          </>
        )}
        {state?.status === 'failed' && (<><h1>{t(T.failedTitle)}</h1><p>{t(T.failedBody)}</p><button type="button" className="ag-btn is-primary" onClick={start}>{t(T.retry)}</button></>)}
        {state?.status === 'unavailable' && <p className="ag-warn">{t(T.unavailable)}</p>}
        {state?.status === 'unknown_hero' && <p className="ag-warn">{t(T.unknownHero)}</p>}
        {notice && <p className="ag-warn" role="alert">{notice}</p>}
      </div>
    </Shell>
  );
};
