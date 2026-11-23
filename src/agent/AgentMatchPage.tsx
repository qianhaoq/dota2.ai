import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Shell } from '../coach/CoachApp';
import { fetchCoachReport } from '../coach/api';
import { markReviewed } from '../coach/accountInput';
import { checkGoal, checkRules, needsReplay, useActiveGoal, type GoalCheck, type GoalRule, type ReplayDeaths } from '../coach/goalStore';
import type { CoachReport } from '../coach/types';
import { SafeImg, useLang } from '../coach/ui';
import { trackReviewViewed } from '../services/analytics';
import { parseMatchInput } from '../v2/parseMatchInput';
import { AgentApiError, fetchAvailability, fetchEvidence, fetchReview, prepareMatch, startReview, type AgentHero, type Availability, type ParseState, type ReviewState } from './api';
import { ChatRail, stepLabel, type ChatHandle } from './ChatRail';
import { ReviewDoc, type GoalContext } from './ReviewDoc';
import './agent.css';

/**
 * /r/:matchId — one game, one line from question to answer:
 *
 *   pick your hero → (one click) → fetch the replay → parse it → the coach
 *   goes through it → the review, with the coach beside it.
 *
 * The click is the reader's: nothing that costs a download or a model call
 * starts on its own. Every wait says what is happening. When the replay
 * cannot be had, the page says why and shows the scoreboard; it does not
 * put a guess in the review's place.
 */

const T = {
  loading: { en: 'Opening the match…', zh: '正在打开对局…' },
  invalid: { en: 'That is not a match ID.', zh: '这不是一个比赛编号。' },
  home: { en: 'Back to the start', zh: '回到首页' },
  match: { en: 'Match', zh: '比赛' },
  notFound: { en: 'This match could not be opened', zh: '这场比赛打不开' },
  notFoundBody: { en: 'Neither the match record nor a parsed replay could be found. Check the ID, or try again in a minute.', zh: '既没有找到比赛记录，也没有解析过的录像。请检查编号，或一分钟后再试。' },
  pick: { en: 'Which hero did you play?', zh: '你玩的是哪个英雄？' },
  pickSub: { en: 'The review is written for one player: what you could have done differently.', zh: '复盘是写给一个人的：你本可以怎么打。' },
  radiant: { en: 'Radiant', zh: '天辉' },
  dire: { en: 'Dire', zh: '夜魇' },
  change: { en: 'Change hero', zh: '换英雄' },
  goTitle: { en: 'Review this game', zh: '复盘这一局' },
  goBody: { en: 'The coach watches the replay — every death, every ultimate, the fights that turned the game, your build — and writes what to change. About two to three minutes.', zh: '教练会把录像看一遍——每次阵亡、每个大招、转折的团战、你的出装——然后写出该改什么。大约两到三分钟。' },
  go: { en: 'Review my game', zh: '开始复盘' },
  working: { en: 'Working on your review', zh: '正在准备你的复盘' },
  leave: { en: 'You can keep this page open; the review appears here when it is done.', zh: '页面开着就行，写完会出现在这里。' },
  s1: { en: 'Fetch the replay', zh: '取录像' },
  s2: { en: 'Read the replay', zh: '解析录像' },
  s3: { en: 'The coach goes through it', zh: '教练看录像' },
  s4: { en: 'Write the review', zh: '写复盘' },
  failedTitle: { en: 'The review did not come out', zh: '这次复盘没有写出来' },
  failedBody: { en: 'The coach could not finish a review it could back with the replay. Try again.', zh: '教练没能写出一份有录像依据的复盘。可以再试一次。' },
  retry: { en: 'Try again', zh: '再试一次' },
  goneTitle: { en: 'The replay of this game is no longer available', zh: '这局的录像已经没有了' },
  goneBody: { en: 'Valve keeps replays for about two weeks. Without the replay there is nothing to review honestly, so nothing is shown in its place.', zh: 'Valve 只保留大约两周的录像。没有录像就没有可以诚实复盘的东西，所以这里不放替代内容。' },
  noUrlTitle: { en: 'The replay is not ready yet', zh: '录像还没准备好' },
  noUrlBody: { en: 'A game that just ended takes a few minutes before its replay can be fetched. Try again shortly.', zh: '刚打完的比赛要等几分钟才能取到录像。稍后再试。' },
  parseFailedTitle: { en: 'The replay could not be read', zh: '录像没有解析出来' },
  parseFailedBody: { en: 'Fetching or reading the replay failed. It usually works on a second try.', zh: '取录像或解析时出了问题，通常再试一次就好。' },
  offTitle: { en: 'Replay reviews are not switched on here', zh: '这里还没有开启录像复盘' },
  offBody: { en: 'This site cannot fetch replays right now, so it cannot review this game.', zh: '这个站点现在取不了录像，所以无法复盘这一局。' },
  unavailable: { en: 'The coach is not available right now.', zh: '教练暂时不可用。' },
  rate: { en: 'Too many reviews started from here. Try again in a few minutes.', zh: '从这里发起的复盘太多了，过几分钟再试。' },
  busy: { en: 'The coach is at capacity. Try again later.', zh: '教练现在忙不过来，稍后再试。' },
  unknownHero: { en: 'That hero is not in this game.', zh: '这局里没有这个英雄。' },
  scoreboard: { en: 'Scoreboard', zh: '记分板' },
  checked: { en: 'Times and numbers in this review were checked against the replay records.', zh: '这份复盘里的时间点和数字已经和录像记录核对过。' },
  dropped: { en: 'removed for lack of evidence', zh: '条因缺少依据被删去' },
  q1: { en: 'Which of my deaths was the most avoidable?', zh: '我哪一次阵亡最不应该？' },
  qFinding: { en: 'what exactly should I have done instead?', zh: '具体应该怎么打？' },
  goalCheck: { en: 'Your goal, in this game', zh: '你的目标，这一局' },
  ruleChecks: { en: 'Your rule, in this game', zh: '你的规则，这一局' },
  goalResult: { met: { en: 'Met', zh: '达成' }, missed: { en: 'Missed', zh: '未达成' }, no_opportunity: { en: 'Did not come up', zh: '这局没遇到' }, unknown: { en: 'Can’t tell yet', zh: '暂时判断不了' } } as Record<string, Bi>,
} as const;

type Lang = 'en' | 'zh';
/** The four steps of the wait, and which one is live. */
export function journeyStep(avail: Availability | null, state: ReviewState | null): number {
  if (state?.status === 'running') return state.steps.length >= 6 ? 3 : 2;
  if (avail && !avail.trace && avail.parse?.status === 'running') return ['extracting', 'building', 'storing'].includes(avail.parse.stage ?? '') ? 1 : 0;
  return avail?.trace ? 2 : 0;
}

type Bi = Record<'en' | 'zh', string>;
const intentKey = (matchId: string, hero: string, lang: string) => `dota2ai.review-intent.${matchId}.${hero}.${lang}`;
const session = () => { try { return window.sessionStorage; } catch { return null; } };

const Portrait: React.FC<{ hero: AgentHero; report: CoachReport | null; lang: Lang }> = ({ hero, report, lang }) => {
  const img = report?.players.find((p) => p.hero.id === hero.hero_id)?.hero.img;
  return img ? <SafeImg src={img} alt={hero[lang]} className="ag-portrait" /> : <span className="ag-portrait ag-portrait--blank" aria-hidden="true" />;
};

export const AgentMatchPage: React.FC = () => {
  const { matchId = '' } = useParams();
  const [search, setSearch] = useSearchParams();
  const { lang } = useLang();
  const t = (b: Bi) => b[lang];
  const valid = parseMatchInput(matchId) === matchId;
  const [avail, setAvail] = useState<Availability | null>(null);
  const [report, setReport] = useState<CoachReport | null | 'failed'>(null);
  const [state, setState] = useState<ReviewState | null>(null);
  const [intent, setIntent] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Counts finished availability requests, successful or not, so the poll below always gets its next turn.
  const [availTick, setAvailTick] = useState(0);
  const resumed = useRef(false);
  // The match whose trace is known to exist but has not been loaded here yet; it means nothing for another match.
  const [expectFor, setExpectFor] = useState<string | null>(null);
  const expectTrace = expectFor === matchId;
  const chat = useRef<ChatHandle>(null);

  // The match on screen now. An availability answer for a match the reader has left is dropped.
  const onMatch = useRef(matchId);
  onMatch.current = matchId;
  const loadAvail = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await fetchAvailability(matchId, signal);
      if (onMatch.current !== matchId) return;
      setAvail(next);
    } catch (e) {
      if ((e as Error).name === 'AbortError' || onMatch.current !== matchId) return;
      // A request that failed tells us nothing: keep what we know. With nothing known yet the page stays on
      // "opening" and asks again (below), rather than conclude that reviews are switched off.
    }
    setAvailTick((n) => n + 1);
  }, [matchId]);

  useEffect(() => {
    if (!valid) return undefined;
    const ac = new AbortController();
    setAvail(null); setReport(null);
    void loadAvail(ac.signal);
    fetchCoachReport(matchId, { signal: ac.signal }).then(setReport).catch((e) => { if (e.name !== 'AbortError') setReport('failed'); });
    return () => ac.abort();
  }, [matchId, valid, loadAvail]);

  const board = report && report !== 'failed' ? report : null;
  // The roster: from the replay when it is parsed, else from the scoreboard (same hero keys).
  const roster: AgentHero[] = useMemo(() => {
    if (avail?.trace) return avail.heroes;
    return (board?.players ?? []).map((p) => ({ hero: p.hero.slug, team: p.radiant ? 'radiant' as const : 'dire' as const, hero_id: p.hero.id, en: p.hero.en, zh: p.hero.zh }));
  }, [avail, board]);

  // The first answer has not come (the request failed): ask again every few seconds.
  useEffect(() => {
    if (!valid || avail || availTick === 0) return undefined;
    // After a handful of tries the page stops waiting and says what it can (the scoreboard, if that loaded).
    if (availTick >= 5) { setAvail({ trace: false, model_configured: false, can_parse: false, heroes: [], parse: { status: 'none' } }); return undefined; }
    const timer = setTimeout(() => { void loadAvail(); }, 3000);
    return () => clearTimeout(timer);
  }, [valid, avail, availTick, loadAvail]);

  // ?hero=<key>, or an older ?p=<slot> link resolved through the scoreboard.
  const hero = useMemo(() => {
    const key = search.get('hero');
    if (key) return roster.find((h) => h.hero === key) ?? null;
    const slot = search.has('p') ? Number(search.get('p')) : null;
    const id = slot != null && board ? board.players[slot]?.hero.id : null;
    return id != null ? roster.find((h) => h.hero_id === id) ?? null : null;
  }, [roster, search, board]);
  const heroKey = hero?.hero ?? null;
  const hasTrace = avail?.trace === true;
  const parse = avail && !avail.trace ? avail.parse ?? { status: 'none' as const } : null;

  const pickHero = (key: string | null) => {
    const next = new URLSearchParams(search);
    next.delete('p'); next.delete('pos');
    if (key) next.set('hero', key); else next.delete('hero');
    setSearch(next, { replace: false });
  };

  // The reader's "go" survives a reload of this tab, so a parse they started still ends in their review.
  useEffect(() => { setIntent(heroKey ? session()?.getItem(intentKey(matchId, heroKey, lang)) === '1' : false); setNotice(null); }, [matchId, heroKey, lang]);
  const want = (on: boolean) => { if (!heroKey) return; setIntent(on); try { if (on) session()?.setItem(intentKey(matchId, heroKey, lang), '1'); else session()?.removeItem(intentKey(matchId, heroKey, lang)); } catch { /* storage blocked */ } };

  // What the reader is looking at now. An answer that was asked for under another hero or language
  // belongs to that selection and is dropped when it arrives.
  const selection = `${matchId}|${heroKey}|${lang}`;
  const selected = useRef(selection);
  selected.current = selection;
  const [reviewTick, setReviewTick] = useState(0);
  const loadReview = useCallback(async (signal?: AbortSignal) => {
    if (!heroKey) return;
    const asked = `${matchId}|${heroKey}|${lang}`;
    try {
      const next = await fetchReview(matchId, heroKey, lang, signal);
      if (selected.current === asked) setState(next);
    } catch (e) {
      if ((e as Error).name === 'AbortError' || selected.current !== asked) return;
      // A request that failed is not a review that failed: while one is running, keep waiting and ask again.
      setState((prev) => (prev?.status === 'running' ? prev : { status: 'failed' }));
    }
    if (selected.current === asked) setReviewTick((n) => n + 1);
  }, [matchId, heroKey, lang]);

  useEffect(() => {
    setState(null);
    if (!heroKey || !hasTrace) return undefined;
    const ac = new AbortController();
    void loadReview(ac.signal);
    return () => ac.abort();
  }, [heroKey, hasTrace, loadReview]);

  // While something is being worked on, ask how far it is every couple of seconds.
  const parsing = parse?.status === 'running';
  useEffect(() => {
    // Also while a trace is known to exist that this page has not loaded yet (prepare answered "ready").
    if (!parsing && !(expectTrace && !hasTrace)) return undefined;
    const timer = setTimeout(() => { void loadAvail(); }, 2500);
    return () => clearTimeout(timer);
  }, [parsing, expectTrace, hasTrace, availTick, loadAvail]);
  useEffect(() => {
    if (state?.status !== 'running') return undefined;
    const timer = setTimeout(() => { void loadReview(); }, 2500);
    return () => clearTimeout(timer);
  }, [state, reviewTick, loadReview]);

  /** What prepare answered is the parse state now: a refresh that fails right after must not lose it. */
  const applyParse = (p: ParseState) => {
    if (p.status === 'running' || p.status === 'failed') setAvail((prev) => (prev && !prev.trace ? { ...prev, parse: p } : prev));
    // Someone else's parse finished in between: the trace is there but this page has not seen it yet.
    if (p.status === 'ready') setExpectFor(matchId);
    setAvailTick((n) => n + 1);
  };
  const refuse = (e: unknown) => {
    const status = e instanceof AgentApiError ? e.status : 0;
    setNotice(t(status === 429 ? T.rate : status === 503 ? T.busy : T.unavailable));
    want(false);
  };
  // One start per click: the request is marked in flight before it leaves, so the effect that carries on
  // after a parse cannot send a second one while the first has not answered.
  // The lock belongs to a selection: a start still out for another hero does not block this one's.
  const beginning = useRef<string | null>(null);
  const begin = useCallback(async () => {
    const asked = `${matchId}|${heroKey}|${lang}`;
    if (!heroKey || beginning.current === asked) return;
    beginning.current = asked;
    try { const next = await startReview(matchId, heroKey, lang); if (selected.current === asked) setState(next); } catch (e) { if (selected.current === asked) refuse(e); } finally { if (beginning.current === asked) beginning.current = null; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId, heroKey, lang]);

  /** The one click: fetch and parse the replay if needed, then the review follows on its own. */
  async function go() {
    setNotice(null); want(true); resumed.current = true;
    if (hasTrace) { await begin(); return; }
    try { const p = await prepareMatch(matchId); if (onMatch.current !== matchId) return; applyParse(p); void loadAvail(); } catch (e) { if (onMatch.current === matchId) refuse(e); }
  }

  // A parse seen running may yet die with its instance: seeing it run re-arms the one-time restart below.
  useEffect(() => { if (parsing) resumed.current = false; }, [parsing]);

  // The reader said go, then came back to a parse that is no longer running (it died with its instance,
  // or failed and its retry time passed): start it again once, rather than wait on nothing.
  useEffect(() => {
    if (!intent || resumed.current || !avail || avail.trace || !avail.can_parse || avail.parse?.status !== 'none') return;
    resumed.current = true;
    prepareMatch(matchId).then((p) => { if (onMatch.current !== matchId) return; applyParse(p); void loadAvail(); }).catch((e) => { if (onMatch.current === matchId) refuse(e); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent, avail, matchId, loadAvail]);

  // The replay just became available and the reader asked for a review: carry on without a second click.
  useEffect(() => {
    if (intent && hasTrace && state?.status === 'none') void begin();
  }, [intent, hasTrace, state, begin]);

  const ready = state?.status === 'ready';
  useEffect(() => {
    if (!ready || !heroKey) return;
    want(false);
    markReviewed(matchId);
    trackReviewViewed(matchId, { hero: heroKey, kind: 'agent' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, matchId, heroKey]);

  // The player's seat on the scoreboard: what a goal needs, and what a later game is judged by.
  const seat = board && hero ? board.players.find((p) => p.hero.id === hero.hero_id) ?? null : null;
  const goalContext: GoalContext | null = board && seat && board.match.start_time ? { fromStart: board.match.start_time, accountId: seat.account_id ?? null, heroId: seat.hero.id } : null;
  // A goal set from an earlier game is checked against this one (same judge as the games page).
  const activeGoalNow = useActiveGoal();
  const [goalCheck, setGoalCheck] = useState<GoalCheck | null>(null);
  const [ruleChecks, setRuleChecks] = useState<{ rule: GoalRule; check: GoalCheck }[]>([]);
  // What a rule is counted on comes from this game's replay: its death counts, once the replay is parsed.
  // `for` ties the counts to the selection they were read for, so another hero's never judge this one.
  const wantsReplay = Boolean(activeGoalNow && needsReplay(activeGoalNow) && hasTrace && heroKey);
  const [replayDeaths, setReplayDeaths] = useState<{ for: string; record: ReplayDeaths } | null>(null);
  useEffect(() => {
    if (!wantsReplay || !heroKey) return undefined;
    let alive = true;
    fetchEvidence(matchId, heroKey, lang, `deaths:${heroKey}`).then((r) => { if (alive) setReplayDeaths({ for: `${matchId}|${heroKey}`, record: r.record }); }).catch(() => {});
    return () => { alive = false; };
  }, [wantsReplay, matchId, heroKey, lang]);
  const replay = replayDeaths && replayDeaths.for === `${matchId}|${heroKey}` ? replayDeaths.record : null;
  useEffect(() => {
    setGoalCheck(activeGoalNow && board && seat ? checkGoal(activeGoalNow, board, seat.slot, replay) : null);
    setRuleChecks(activeGoalNow && board && seat ? checkRules(activeGoalNow, board, seat.slot, replay) : []);
  }, [activeGoalNow, board, seat, replay]);

  const ask = (label: string, refs: string[]) => chat.current?.ask(label, refs);
  const suggestions = useMemo(() => {
    if (state?.status !== 'ready') return [];
    const first = state.review.findings[0]?.title;
    return [...(first ? [lang === 'zh' ? `「${first}」——${T.qFinding.zh}` : `"${first}" — ${T.qFinding.en}`] : []), T.q1[lang]];
  }, [state, lang]);

  if (!valid) return <Shell><div className="ag-state"><h1>{t(T.invalid)}</h1><Link to={`/?lang=${lang}`} className="ag-btn">{t(T.home)}</Link></div></Shell>;
  if (!avail || (report === null && !avail.trace)) return <Shell><div className="ag-state" role="status"><p className="ag-pulse">{t(T.loading)}</p></div></Shell>;

  const header = (
    <header className="ag-head">
      <p className="cx-eyebrow">{t(T.match)} {matchId}{board?.match?.patch ? ` · ${board.match.patch}` : ''}</p>
      {hero && (
        <div className="ag-head-hero">
          <Portrait hero={hero} report={board} lang={lang} />
          <strong>{hero[lang]}</strong>
          <span className={`ag-team is-${hero.team}`}>{t(T[hero.team])}</span>
          <button type="button" className="ag-link" onClick={() => pickHero(null)}>{t(T.change)}</button>
        </div>
      )}
      {goalCheck && activeGoalNow && (
        <p className="ag-goalcheck">
          <span>{t(T.goalCheck)}</span>
          <b>{activeGoalNow.action[lang]}</b>
          <span className={`cx-goal-result is-${goalCheck.result}`}>{t(T.goalResult[goalCheck.result])}</span>
          <em>{goalCheck.evidence[lang]}</em>
        </p>
      )}
      {ruleChecks.length > 0 && (
        <ul className="ag-rulechecks" aria-label={t(T.ruleChecks)}>
          {ruleChecks.map(({ rule, check }) => (
            <li key={rule.finding} className="ag-goalcheck">
              <span>{t(T.ruleChecks)}</span>
              <b>{rule.when}{lang === 'zh' ? '：' : ': '}{rule.do}</b>
              <span className={`cx-goal-result is-${check.result}`}>{t(T.goalResult[check.result])}</span>
              <em>{check.evidence[lang]}</em>
            </li>
          ))}
        </ul>
      )}
    </header>
  );
  const scoreboard = board && (
    <section className="ag-board" aria-label={t(T.scoreboard)}>
      <h2>{t(T.scoreboard)}</h2>
      <ul>
        {board.players.map((p) => (
          <li key={p.slot} className={p.radiant ? 'is-radiant' : 'is-dire'}>
            {p.hero.img ? <SafeImg src={p.hero.img} alt={p.hero[lang]} className="ag-portrait" /> : <span className="ag-portrait ag-portrait--blank" />}
            <span>{p.hero[lang]}</span>
            <span className="ag-kda">{p.kda.join(' / ')}</span>
          </li>
        ))}
      </ul>
    </section>
  );
  const dead = (title: Bi, body: Bi, retry = false) => (
    <Shell>{header}<div className="ag-state"><h1>{t(title)}</h1><p>{t(body)}</p>{retry && <button type="button" className="ag-btn is-primary" onClick={go}>{t(T.retry)}</button>}{notice && <p className="ag-warn" role="alert">{notice}</p>}</div>{scoreboard}</Shell>
  );

  if (roster.length === 0) return dead(T.notFound, T.notFoundBody);

  if (!hero) {
    return (
      <Shell>
        {header}
        <section className="ag-pick">
          <h1>{t(T.pick)}</h1>
          <p className="ag-pick-sub">{t(T.pickSub)}</p>
          {search.has('hero') && <p className="ag-warn" role="alert">{t(T.unknownHero)}</p>}
          {(['radiant', 'dire'] as const).map((team) => (
            <div key={team} className="ag-pick-team">
              <p className={`ag-team is-${team}`}>{t(T[team])}</p>
              <div className="ag-pick-row">
                {roster.filter((h) => h.team === team).map((h) => (
                  <button key={h.hero} type="button" onClick={() => pickHero(h.hero)}>
                    <Portrait hero={h} report={board} lang={lang} />
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
            <ReviewDoc matchId={matchId} review={state.review} lang={lang} onAsk={ask} goalContext={goalContext} />
            <p className="ag-checked">{t(T.checked)}{state.verification.dropped > 0 ? ` ${state.verification.dropped} ${t(T.dropped)}.` : ''}</p>
          </div>
          <ChatRail ref={chat} matchId={matchId} hero={hero.hero} lang={lang} suggestions={suggestions} />
        </div>
      </Shell>
    );
  }

  // No replay, and none to be had.
  if (parse?.status === 'failed') {
    if (parse.reason === 'replay_gone') return dead(T.goneTitle, T.goneBody);
    if (parse.reason === 'no_replay_url') return dead(T.noUrlTitle, T.noUrlBody, true);
    return dead(T.parseFailedTitle, T.parseFailedBody, !parse.final);
  }
  if (!hasTrace && !avail.can_parse) return dead(T.offTitle, T.offBody);
  if (state?.status === 'failed') return dead(T.failedTitle, T.failedBody, true);
  if (state?.status === 'unavailable' || (hasTrace && !avail.model_configured)) return dead(T.failedTitle, T.unavailable);

  // Something is running, or the reader said go and the next request is about to leave.
  const working = parsing || state?.status === 'running' || (intent && !notice && (!hasTrace || state === null || state.status === 'none'));
  if (working) {
    const live = journeyStep(avail, state);
    const steps = [T.s1, T.s2, T.s3, T.s4];
    return (
      <Shell>
        {header}
        <div className="ag-state" role="status">
          <h1>{t(T.working)}</h1>
          <p>{t(T.leave)}</p>
          <ol className="ag-journey">
            {steps.map((s, i) => (
              <li key={i} className={i < live ? 'is-done' : i === live ? 'is-live' : ''}>
                <span className="ag-journey-dot" aria-hidden="true" />
                <div>
                  <strong>{t(s)}</strong>
                  {i === 2 && state?.status === 'running' && state.steps.length > 0 && <ol className="ag-steps">{state.steps.map((x, j) => <li key={j}>{stepLabel(x, lang)}</li>)}</ol>}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      {header}
      <div className="ag-state">
        {hasTrace && !state ? <p className="ag-pulse" role="status">{t(T.loading)}</p> : (
          <>
            <h1>{t(T.goTitle)}</h1>
            <p>{t(T.goBody)}</p>
            <button type="button" className="ag-btn is-primary" onClick={go}>{t(T.go)}</button>
            {state?.status === 'unknown_hero' && <p className="ag-warn">{t(T.unknownHero)}</p>}
            {notice && <p className="ag-warn" role="alert">{notice}</p>}
          </>
        )}
      </div>
      {scoreboard}
    </Shell>
  );
};
