import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Shell } from '../coach/CoachApp';
import { fetchCoachReport } from '../coach/api';
import { markReviewed } from '../coach/accountInput';
import { checkGoal, checkRules, habitCurve, needsReplay, replayRefs, useActiveGoal, type GoalCheck, type GoalRule, type ReplayRecords } from '../coach/goalStore';
import type { CoachReport } from '../coach/types';
import { SafeImg, useLang } from '../coach/ui';
import { trackEvent, trackOnce, trackReviewViewed, trafficSource } from '../services/analytics';
import { parseMatchInput } from '../v2/parseMatchInput';
import { AgentApiError, fetchAvailability, fetchEvidence, fetchReview, prepareMatch, startReview, type AgentHero, type Availability, type ParseState, type ReviewState } from './api';
import { ChatRail, stepLabel, type ChatHandle } from './ChatRail';
import { MatchBoard } from './MatchBoard';
import { PLANS, planKey } from '../../lib/agent/plans.js';
import { DEFAULT_AGENT_MODEL, modelId, modelLabel, modelWait, writesSlowly } from '../../lib/agent/models.js';
import { ReviewDoc, type GoalContext } from './ReviewDoc';
import { WaitDeaths } from './WaitDeaths';
import { ShareBar } from './ShareBar';
import { useReadyCallback } from './readyCallback';
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
  fromTeam: { en: 'A teammate sent you this game.', zh: '队友把这局发给了你。' },
  radiant: { en: 'Radiant', zh: '天辉' },
  dire: { en: 'Dire', zh: '夜魇' },
  change: { en: 'Change hero', zh: '换英雄' },
  goTitle: { en: 'Review this game', zh: '复盘这一局' },
  goBody: { en: 'The coach watches the replay — every death, every ultimate, the fights that turned the game, your build — and writes what to change.', zh: '教练会把录像看一遍——每次阵亡、每个大招、转折的团战、你的出装——然后写出该改什么。' },
  goTime: { en: 'About two to three minutes.', zh: '大约两到三分钟。' },
  // A model that writes slowly: how long it took when it was timed (lib/agent/models.js), never a promise.
  goTimeSlow: { en: 'With {m}, expect {t} (as timed on a real game)', zh: '用 {m} 写，预计{t}（按实测）' },
  // …beside the quick one, when the reader can pick it here.
  goTimeQuick: { en: '; {d} takes {t}.', zh: '；{d} {t}。' },
  // While it is being written: who writes it and how long that takes, so a long wait is one the reader was told of.
  workTime: { en: '{m} is writing it: expect {t}.', zh: '由 {m} 撰写，预计{t}。' },
  go: { en: 'Review my game', zh: '开始复盘' },
  planAsk: { en: 'What were you going for this game? (optional)', zh: '这局你想怎么打？（可选）' },
  planWhy: { en: 'Say it, and the review reads the game against it: whether your play fit it, whether it suited these line-ups, and where it broke. The replay cannot show what you meant to do.', zh: '选了，复盘就会对照它来读这局：你的打法是否贴合，这个思路面对双方阵容是否站得住，没打成断在哪里。录像本身看不出你想怎么打。' },
  planNone: { en: 'Don\'t say', zh: '不说' },
  modelAsk: { en: 'Which model writes it?', zh: '由哪个模型来写？' },
  modelWhy: { en: 'Each model reads the same replay with the same tools, and its review is checked against the replay the same way. A review by another model is kept beside the first, so you can compare them.', zh: '每个模型读的是同一份录像、用同一套工具，写出的复盘也按同样的方式和录像核对。换一个模型写的复盘会另存一份，可以对比着看。' },
  modelBy: { en: 'Written by', zh: '撰写模型' },
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
  noUrlWaiting: { en: 'A game that just ended takes a few minutes before its replay can be fetched. Leave this page open: it will try again by itself in a few minutes. Or come back later.', zh: '刚打完的比赛要等几分钟才能取到录像。这个页面开着就行，过几分钟会自动再试一次；也可以稍后再回来。' },
  parseFailedTitle: { en: 'The replay could not be read', zh: '录像没有解析出来' },
  parseFailedBody: { en: 'Fetching or reading the replay failed. It usually works on a second try.', zh: '取录像或解析时出了问题，通常再试一次就好。' },
  offTitle: { en: 'Replay reviews are not switched on here', zh: '这里还没有开启录像复盘' },
  offBody: { en: 'This site cannot fetch replays right now, so it cannot review this game.', zh: '这个站点现在取不了录像，所以无法复盘这一局。' },
  unavailable: { en: 'The coach is not available right now.', zh: '教练暂时不可用。' },
  rate: { en: 'Too many reviews started from here. Try again in a few minutes.', zh: '从这里发起的复盘太多了，过几分钟再试。' },
  busy: { en: 'The coach is at capacity. Try again later.', zh: '教练现在忙不过来，稍后再试。' },
  rateWait: { en: 'Too many reviews started from here. It starts on its own in {t}.', zh: '从这里发起的复盘太多了，{t} 后自动开始。' },
  busyWait: { en: 'The coach is at capacity. It tries again on its own in {t}.', zh: '教练现在忙不过来，{t} 后自动再试。' },
  unknownHero: { en: 'That hero is not in this game.', zh: '这局里没有这个英雄。' },
  scoreboard: { en: 'Scoreboard', zh: '记分板' },
  checked: { en: 'Times and numbers in this review were checked against the replay records.', zh: '这份复盘里的时间点和数字已经和录像记录核对过。' },
  dropped: { en: 'removed for lack of evidence', zh: '条因缺少依据被删去' },
  q1: { en: 'Which of my deaths was the most avoidable?', zh: '我哪一次阵亡最不应该？' },
  qFinding: { en: 'what exactly should I have done instead?', zh: '具体应该怎么打？' },
  goalCheck: { en: 'Your goal, in this game', zh: '你的目标，这一局' },
  checkOnly: { en: 'Only check my goal', zh: '只检查目标' },
  curve: { en: 'Game by game', zh: '一局一局' },
  curveFrom: { en: 'the game the goal came from', zh: '定下目标的那局' },
  checkOnlyWhy: { en: 'Reads the replay and counts what your goal is about — about a minute, no review written.', zh: '只读录像、数一数目标说的那件事——大约一分钟，不写复盘。' },
  checkingGoal: { en: 'Reading the replay to check your goal…', zh: '正在读录像，检查你的目标…' },
  goalFrom: { en: 'set after game #{id}', zh: '来自 #{id} 那局的复盘' },
  ruleChecks: { en: 'Your rule, in this game', zh: '你的规则，这一局' },
  goalResult: { met: { en: 'Met', zh: '达成' }, missed: { en: 'Missed', zh: '未达成' }, no_opportunity: { en: 'Did not come up', zh: '这局没遇到' }, unknown: { en: 'Can’t tell yet', zh: '暂时判断不了' } } as Record<string, Bi>,
} as const;

type Lang = 'en' | 'zh';
/** Longer than this (a day's parse ceiling, say), a refusal is said once and not waited out on the page. */
const MAX_AUTO_WAIT_SEC = 15 * 60;
/**
 * A replay that is not ready yet (the game just ended): how often the page asks whether it may be tried again,
 * and how many times it goes again by itself before leaving it to the reader. The server allows a new try five
 * minutes after a failed one. An object so a test can shorten the wait.
 */
export const REPLAY_NOT_READY = { askEveryMs: 30_000, triesByItself: 3 };
const clockOf = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
/** The four steps of the wait, and which one is live. */
export function journeyStep(avail: Availability | null, state: ReviewState | null): number {
  if (state?.status === 'running') return state.steps.length >= 6 ? 3 : 2;
  if (avail && !avail.trace && avail.parse?.status === 'running') return ['extracting', 'building', 'storing'].includes(avail.parse.stage ?? '') ? 1 : 0;
  return avail?.trace ? 2 : 0;
}

type Bi = Record<'en' | 'zh', string>;
const intentKey = (matchId: string, hero: string, lang: string, plan: string | null = null, model: string | null = null) => `dota2ai.review-intent.${matchId}.${hero}.${lang}${plan ? `.${plan}` : ''}${model ? `.m-${model}` : ''}`;
const session = () => { try { return window.sessionStorage; } catch { return null; } };

const Portrait: React.FC<{ hero: AgentHero; report: CoachReport | null; lang: Lang }> = ({ hero, report, lang }) => {
  const img = report?.players.find((p) => p.hero.id === hero.hero_id)?.hero.img;
  return img ? <SafeImg src={img} alt={hero[lang]} className="ag-portrait" /> : <span className="ag-portrait ag-portrait--blank" aria-hidden="true" />;
};

export const AgentMatchPage: React.FC = () => {
  const { matchId = '' } = useParams();
  const [search, setSearch] = useSearchParams();
  const { lang } = useLang();
  // How this visit arrived: a teammate's "send to my team" link, or someone's own review shared.
  const refParam = search.get('ref');
  const arrivedBy = refParam === 'team' || refParam === 'share' ? refParam : null;
  const t = (b: Bi) => b[lang];
  const valid = parseMatchInput(matchId) === matchId;
  const [avail, setAvail] = useState<Availability | null>(null);
  const [report, setReport] = useState<CoachReport | null | 'failed'>(null);
  const [state, setState] = useState<ReviewState | null>(null);
  // The selection (match|hero|lang|plan) the reader said "go" for. Kept as that key, not a flag, so the render in
  // which the selection changes cannot carry one selection's go over to the next.
  const [intentOf, setIntentOf] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Refused for now with a time to come back (429/503 + retryAfterSec): the page counts down and goes again
  // by itself, rather than leave a button that only earns the reader more refusals.
  // `for`: the selection (match, hero, language, plan) it was given for; another selection does not wait on it.
  // Each selection (match|hero|lang|plan) waits out its own refusal: a later one for another selection does not
  // replace it. A parse is the match's, so a refused one is waited out by every selection that joined it.
  const [waits, setWaits] = useState<Record<string, { until: number; kind: 'rate' | 'busy' }>>({});
  const [, setClock] = useState(0);
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
  // The plan the reader named for this game (?plan=), if any: a review made for it is its own review.
  const plan = planKey(search.get('plan'));
  const pickPlan = (key: string | null) => {
    const next = new URLSearchParams(search);
    if (key) next.set('plan', key); else next.delete('plan');
    setSearch(next, { replace: true });
  };
  // The model the reader chose (?model=), when this server offers it and it is not the default: a review written
  // by it is its own review. Anything else (none named, the default by name, one not offered here) is the default.
  const offered = avail?.models ?? [];
  const defaultModel = avail?.default_model ?? offered[0] ?? null;
  const named = modelId(search.get('model'));
  const model = named && named !== defaultModel && offered.includes(named) ? named : null;
  const pickModel = (id: string) => {
    const next = new URLSearchParams(search);
    if (id !== defaultModel) next.set('model', id); else next.delete('model');
    setSearch(next, { replace: true });
  };
  const modelPick = (label: string) => (
    <div className="ag-planpick-row" role="radiogroup" aria-label={label}>
      {offered.map((id) => (
        <button key={id} type="button" role="radio" aria-checked={(model ?? defaultModel) === id} className={`ag-chip-btn ${(model ?? defaultModel) === id ? 'is-on' : ''}`} onClick={() => pickModel(id)}>
          {modelLabel(id)}
          {/* The wait is part of the choice: said on the button, before the reader picks. Nothing for a model that was not timed. */}
          {modelWait(id, lang) && <span className="ag-chip-time"> · {modelWait(id, lang)}</span>}
        </button>
      ))}
    </div>
  );
  // How long the wait is, by which model writes (the one picked, else this server's default — which need not be
  // the quick one): two to three minutes for the quick one and where no model is named at all; for a slow one
  // what it took when timed; nothing for one that was not timed.
  const writer = model ?? defaultModel;
  // A link or a count outlives this server's setup, so it names the review by its writer's id — never by `model`,
  // which is null for whatever is the default here: a link shared while Kimi was the default must still open
  // Kimi's review once the default is another model, and DeepSeek's must still open DeepSeek's. (Null only
  // where the server lists no models: then there is one writer and nothing to tell apart.)
  const writtenBy = writer;
  const slow = writer != null && writesSlowly(writer);
  const timed = writer != null ? modelWait(writer, lang) : null;
  const quickWait = modelWait(DEFAULT_AGENT_MODEL, lang);
  const goTime = !slow ? t(T.goTime)
    : timed != null ? t(T.goTimeSlow).replace('{m}', modelLabel(writer)).replace('{t}', timed) + (offered.includes(DEFAULT_AGENT_MODEL) && quickWait ? t(T.goTimeQuick).replace('{d}', modelLabel(DEFAULT_AGENT_MODEL)).replace('{t}', quickWait) : lang === 'zh' ? '。' : '.')
      : null;
  // Said again while the review is being written, where the server names its models (else there is one writer,
  // whose two to three minutes the reader was told before the click).
  const workTime = writer != null && timed != null ? t(T.workTime).replace('{m}', modelLabel(writer)).replace('{t}', timed) : null;
  const hasTrace = avail?.trace === true;
  const parse = avail && !avail.trace ? avail.parse ?? { status: 'none' as const } : null;

  const pickHero = (key: string | null) => {
    const next = new URLSearchParams(search);
    next.delete('p'); next.delete('pos');
    if (key) next.set('hero', key); else next.delete('hero');
    setSearch(next, { replace: false });
  };

  // The reader's "go" survives a reload of this tab, so a parse they started still ends in their review.
  useEffect(() => { setIntentOf(heroKey && session()?.getItem(intentKey(matchId, heroKey, lang, plan, model)) === '1' ? `${matchId}|${heroKey}|${lang}|${plan ?? ''}|${model ?? ''}` : null); setNotice(null); }, [matchId, heroKey, lang, plan, model]);
  const want = (on: boolean) => { if (!heroKey) return; setIntentOf(on ? `${matchId}|${heroKey}|${lang}|${plan ?? ''}|${model ?? ''}` : null); try { if (on) session()?.setItem(intentKey(matchId, heroKey, lang, plan, model), '1'); else session()?.removeItem(intentKey(matchId, heroKey, lang, plan, model)); } catch { /* storage blocked */ } };

  // What the reader is looking at now. An answer that was asked for under another hero or language
  // belongs to that selection and is dropped when it arrives.
  const selection = `${matchId}|${heroKey}|${lang}|${plan ?? ''}|${model ?? ''}`;
  const selected = useRef(selection);
  selected.current = selection;
  const intent = intentOf === selection;
  /** The refusal's wait, when it was for what is on screen now. */
  const wait = waits[selection] ?? null;
  const [reviewTick, setReviewTick] = useState(0);
  const loadReview = useCallback(async (signal?: AbortSignal) => {
    if (!heroKey) return;
    const asked = `${matchId}|${heroKey}|${lang}|${plan ?? ''}|${model ?? ''}`;
    try {
      const next = await fetchReview(matchId, heroKey, lang, signal, plan, model);
      if (selected.current === asked) setState(next);
    } catch (e) {
      if ((e as Error).name === 'AbortError' || selected.current !== asked) return;
      // A request that failed is not a review that failed: while one is running, keep waiting and ask again.
      setState((prev) => (prev?.status === 'running' ? prev : { status: 'failed' }));
    }
    if (selected.current === asked) setReviewTick((n) => n + 1);
  }, [matchId, heroKey, lang, plan, model]);

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
  /** `askedFor`: the selection(s) the refused request was sent for, which the reader may since have left. */
  const refuse = (e: unknown, askedFor: string | string[] = selected.current) => {
    const asked = Array.isArray(askedFor) ? askedFor : [askedFor];
    const status = e instanceof AgentApiError ? e.status : 0;
    const after = e instanceof AgentApiError ? e.retryAfterSec ?? 0 : 0;
    const here = asked.includes(selected.current);
    const waits = (status === 429 || status === 503) && after > 0 && after <= MAX_AUTO_WAIT_SEC;
    // `waits`: the page counts this one down and goes again by itself.
    trackEvent('review_refused', { matchId, reason: status === 429 ? 'rate' : status === 503 ? 'busy' : 'unavailable', waits });
    if (waits) {
      // The reader still wants it: keep the intent, and go again when the server said it may.
      if (here) setNotice(null);
      const next = { until: Date.now() + after * 1000, kind: status === 429 ? 'rate' as const : 'busy' as const };
      setWaits((prev) => ({ ...prev, ...Object.fromEntries(asked.map((k) => [k, next])) }));
      return;
    }
    // Refused for good for a selection the reader has left: nothing on this one changes.
    if (!here) return;
    setNotice(t(status === 429 ? T.rate : status === 503 ? T.busy : T.unavailable));
    want(false);
  };
  // One start per click: the request is marked in flight before it leaves, so the effect that carries on
  // after a parse cannot send a second one while the first has not answered.
  // The lock belongs to a selection: a start still out for another hero does not block this one's.
  const beginning = useRef<string | null>(null);
  const begin = useCallback(async () => {
    const asked = `${matchId}|${heroKey}|${lang}|${plan ?? ''}|${model ?? ''}`;
    if (!heroKey || beginning.current === asked) return;
    beginning.current = asked;
    try { const next = await startReview(matchId, heroKey, lang, plan, model); if (selected.current === asked) setState(next); } catch (e) { refuse(e, asked); } finally { if (beginning.current === asked) beginning.current = null; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId, heroKey, lang, plan, model]);

  /** The one click: fetch and parse the replay if needed, then the review follows on its own. */
  const preparing = useRef<string | null>(null);
  /** The selections waiting on the parse request that is out now. */
  const joined = useRef<Set<string>>(new Set());
  /**
   * Check the goal set from an earlier game, without a review: fetch and parse the replay — no model call — and
   * the check in the header reads its counts as soon as the trace is there. The review is not started: the
   * reader's go is not given.
   */
  const [checkingOnly, setCheckingOnly] = useState<string | null>(null);
  async function checkOnly() {
    if (wait || hasTrace) return;
    // Its own event: a goal check is not a request for a review, and the funnel must not count it as one.
    trackEvent('goal_check_requested', { matchId, lang, ...(heroKey ? { hero: heroKey } : {}) });
    setNotice(null); setCheckingOnly(selection);
    await sendPrepare();
  }
  const checkOnlyRef = useRef(checkOnly);
  checkOnlyRef.current = checkOnly;
  const checkingOnlyRef = useRef(checkingOnly);
  checkingOnlyRef.current = checkingOnly;
  async function go() {
    if (wait) return;
    trackEvent('review_requested', { matchId, lang, ...(heroKey ? { hero: heroKey } : {}), step: hasTrace ? 'review' : 'parse', plan: Boolean(plan), ...(writtenBy ? { model: writtenBy } : {}) });
    setNotice(null); want(true); resumed.current = true;
    if (hasTrace) { await begin(); return; }
    await sendPrepare();
  }
  /**
   * Ask for this match's parse. One request out at a time per match: a go for another hero or plan of the
   * same match joins the one already out, and its answer (a refusal and its wait too) is that selection's too.
   */
  async function sendPrepare() {
    if (preparing.current === matchId) { joined.current.add(selection); return; }
    preparing.current = matchId;
    joined.current = new Set([selection]);
    try { const p = await prepareMatch(matchId); if (onMatch.current !== matchId) return; applyParse(p); void loadAvail(); } catch (e) { if (onMatch.current === matchId) refuse(e, [...joined.current]); } finally { if (preparing.current === matchId) preparing.current = null; }
  }
  const goRef = useRef(go);
  goRef.current = go;

  // Count the wait on screen down each second. It ends only while its selection is on screen: one that ran
  // out while the reader was elsewhere ends (and goes again) when they come back to it, not before.
  useEffect(() => {
    if (!wait) return undefined;
    const sel = selection;
    const end = () => setWaits((prev) => { const { [sel]: _done, ...rest } = prev; return rest; });
    if (Date.now() >= wait.until) { end(); return undefined; }
    const timer = setInterval(() => {
      if (Date.now() < wait.until) { setClock((n) => n + 1); return; }
      clearInterval(timer);
      end();
    }, 1000);
    return () => clearInterval(timer);
  }, [wait, selection]);
  // When the wait on screen ends, go again if the reader still wants that review.
  const waited = useRef<{ sel: string; wait: typeof wait }>({ sel: selection, wait });
  useEffect(() => {
    const was = waited.current;
    waited.current = { sel: selection, wait };
    if (was.sel === selection && was.wait && !wait && intent) void goRef.current();
    // A goal-only check that was refused with a wait goes again the same way: a goal check, not a review.
    else if (was.sel === selection && was.wait && !wait && checkingOnlyRef.current === selection) void checkOnlyRef.current();
  }, [wait, intent, selection]);
  const waitNotice = wait ? t(wait.kind === 'rate' ? T.rateWait : T.busyWait).replace('{t}', clockOf(Math.max(0, Math.ceil((wait.until - Date.now()) / 1000)))) : null;

  // A parse seen running may yet die with its instance: seeing it run re-arms the one-time restart below.
  useEffect(() => { if (parsing) resumed.current = false; }, [parsing]);

  // The replay of a game that just ended has no address for a few minutes, and the try fails. The reader said go:
  // keep asking, slowly, so that when the server lets it be tried again the restart below picks it up without
  // a second click. A few times only — a game whose replay never comes is not asked about for ever.
  const autoTries = useRef<Record<string, number>>({});
  const awaitingReplay = intent && !wait && !hasTrace && parse?.status === 'failed' && parse.reason === 'no_replay_url' && !parse.final && (autoTries.current[selection] ?? 0) < REPLAY_NOT_READY.triesByItself;
  // A try that failed at once was never seen running, so nothing re-armed the restart: waiting for a replay does.
  useEffect(() => { if (awaitingReplay) resumed.current = false; }, [awaitingReplay]);
  useEffect(() => {
    if (!awaitingReplay) return undefined;
    const timer = setTimeout(() => { void loadAvail(); }, REPLAY_NOT_READY.askEveryMs);
    return () => clearTimeout(timer);
  }, [awaitingReplay, availTick, loadAvail]);
  // So does coming back to a selection: one the reader said go for, left during a wait, and came back to after
  // it ran out is picked up again rather than left saying "working" with nothing running.
  useEffect(() => { resumed.current = false; }, [selection]);

  // The reader said go, then came back to a parse that is no longer running (it died with its instance,
  // or failed and its retry time passed): start it again once, rather than wait on nothing.
  useEffect(() => {
    if (!intent || wait || resumed.current || !avail || avail.trace || !avail.can_parse || avail.parse?.status !== 'none') return;
    resumed.current = true;
    autoTries.current[selection] = (autoTries.current[selection] ?? 0) + 1;
    void sendPrepare();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent, avail, matchId, loadAvail, wait]);

  // The replay just became available and the reader asked for a review: carry on without a second click.
  useEffect(() => {
    if (intent && hasTrace && state?.status === 'none' && !wait) void begin();
  }, [intent, hasTrace, state, begin, wait]);

  const ready = state?.status === 'ready';
  useEffect(() => {
    if (!ready || !heroKey) return;
    want(false);
    markReviewed(matchId);
    trackReviewViewed(matchId, { ui: 'agent', hero: heroKey, lang, ...(arrivedBy ? { ref: arrivedBy } : {}) });
    // The review the reader asked for here, and waited out, is done: counted once per review, whatever was
    // seen on this match before (a review that was already there counts as viewed, not as this).
    if (intent) { const src = trafficSource(); trackOnce(`${matchId}.${heroKey}.${lang}.${plan ?? ''}${model ? `.${model}` : ''}`, 'review_ready', { matchId, hero: heroKey, lang, ...(src ? { src } : {}), ...(writtenBy ? { model: writtenBy } : {}) }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, matchId, heroKey]);

  // The reader asked, and the page shows that it cannot be had: why, in the server's word. Once per review asked
  // for and reason — a replay that is not ready yet, tried again by itself, is one event, not one per try.
  // A review that is not available for a while (the model account refused one a moment ago) is shown as a failure
  // too, with the server's reason.
  const reviewDown = hasTrace && state?.status === 'unavailable' && typeof (state as any).reason === 'string';
  const failedStage = !intent ? null : parse?.status === 'failed' ? 'parse' : (hasTrace && state?.status === 'failed') || reviewDown ? 'review' : null;
  const failedReason = failedStage === 'parse' ? (parse as any).reason : failedStage === 'review' ? ((state as any).reason || 'unknown') : null;
  const failedFinal = failedStage === 'parse' ? Boolean((parse as any).final) : false;
  useEffect(() => {
    if (!failedStage || typeof failedReason !== 'string' || !heroKey) return;
    trackOnce(`${selection}.failed.${failedStage}.${failedReason}`, 'review_failed', { matchId, hero: heroKey, lang, stage: failedStage, reason: failedReason, final: failedFinal });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failedStage, failedReason, selection]);

  // Someone opened this game's page: the top of the funnel, once per match per session, before anything
  // has loaded, so one who leaves while it loads is counted too.
  useEffect(() => {
    // `src`: the community post this visit came from, if it came by one (kept for the session).
    const src = trafficSource();
    if (valid) trackOnce(matchId, 'match_opened', { matchId, lang, ...(arrivedBy ? { ref: arrivedBy } : {}), ...(src ? { src } : {}) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId]);

  // The player's seat on the scoreboard: what a goal needs, and what a later game is judged by.
  const seat = board && hero ? board.players.find((p) => p.hero.id === hero.hero_id) ?? null : null;
  const goalContext: GoalContext | null = board && seat && board.match.start_time ? { fromStart: board.match.start_time, accountId: seat.account_id ?? null, heroId: seat.hero.id } : null;
  // A goal set from an earlier game is checked against this one (same judge as the games page).
  const activeGoalNow = useActiveGoal();
  const [goalCheck, setGoalCheck] = useState<GoalCheck | null>(null);
  const [ruleChecks, setRuleChecks] = useState<{ rule: GoalRule; check: GoalCheck }[]>([]);
  // What a rule is counted on comes from this game's replay: the tool summaries its checks name, once the replay is parsed.
  // `for` ties the counts to the selection they were read for, so another hero's never judge this one.
  const wantsReplay = Boolean(activeGoalNow && needsReplay(activeGoalNow) && hasTrace && heroKey);
  const [replayCounts, setReplayCounts] = useState<{ for: string; records: Record<string, unknown> } | null>(null);
  const refs = useMemo(() => (wantsReplay && activeGoalNow && heroKey ? replayRefs(activeGoalNow, heroKey) : []), [wantsReplay, activeGoalNow, heroKey]);
  useEffect(() => {
    if (!wantsReplay || !heroKey) return undefined;
    let alive = true;
    // A summary that cannot be read stays out: its check is then "unknown", never a pass.
    Promise.all(refs.map((ref) => fetchEvidence(matchId, heroKey, lang, ref).then((r) => [ref, r.record] as const).catch(() => null)))
      .then((got) => { if (alive) setReplayCounts({ for: `${matchId}|${heroKey}`, records: Object.fromEntries(got.filter((x): x is readonly [string, unknown] => x !== null)) }); });
    return () => { alive = false; };
  }, [wantsReplay, refs, matchId, heroKey, lang]);
  const replay = useMemo<ReplayRecords>(() => (heroKey && replayCounts && replayCounts.for === `${matchId}|${heroKey}` ? { hero: heroKey, records: replayCounts.records } : null), [replayCounts, matchId, heroKey]);
  useEffect(() => {
    setGoalCheck(activeGoalNow && board && seat ? checkGoal(activeGoalNow, board, seat.slot, replay) : null);
    setRuleChecks(activeGoalNow && board && seat ? checkRules(activeGoalNow, board, seat.slot, replay) : []);
  }, [activeGoalNow, board, seat, replay]);

  // A goal from an earlier game that this game counts for, and that waits on this game's replay: it can be
  // checked by itself, before (or instead of) a review.
  const goalWaitsOnReplay = Boolean(activeGoalNow && needsReplay(activeGoalNow) && !hasTrace && (goalCheck?.result === 'unknown' || ruleChecks.some((r) => r.check.result === 'unknown')));
  const ask = (label: string, refs: string[]) => chat.current?.ask(label, refs);
  const suggestions = useMemo(() => {
    if (state?.status !== 'ready') return [];
    const first = state.review.findings[0]?.title;
    return [...(first ? [lang === 'zh' ? `「${first}」——${T.qFinding.zh}` : `"${first}" — ${T.qFinding.en}`] : []), T.q1[lang]];
  }, [state, lang]);

  // The wait as the tab's title, and "ready" (with a notification, if the reader asked for one) when the reader
  // is elsewhere: computed here, before the page picks what to show, from what decides that the wait is on screen.
  const waitShown = valid && Boolean(avail) && parse?.status !== 'failed' && state?.status !== 'failed' && state?.status !== 'unavailable'
    && (parsing || state?.status === 'running' || (intent && !notice && !wait && (!hasTrace || state === null || state.status === 'none')));
  const callback = useReadyCallback({
    matchId, selection, working: waitShown, step: journeyStep(avail, state), ready: state?.status === 'ready',
    lang, heroName: hero ? hero[lang] : null, verdict: state?.status === 'ready' ? state.review.verdict ?? null : null,
  });

  if (!valid) return <Shell><div className="ag-state"><h1>{t(T.invalid)}</h1><Link to={`/?lang=${lang}`} className="ag-btn">{t(T.home)}</Link></div></Shell>;
  if (!avail || (report === null && !avail.trace)) return <Shell><div className="ag-state" role="status"><p className="ag-pulse">{t(T.loading)}</p></div></Shell>;

  // A habit's count game by game, from the game the goal came from to this one: whether it is going down.
  // Read after this game's check is stored (goalCheck / ruleChecks), so this game is in it.
  const curveLine = (goalId: string) => {
    const curve = activeGoalNow && (goalCheck || ruleChecks.length) ? habitCurve(activeGoalNow, goalId) : null;
    if (!curve) return null;
    return (
      <span className="ag-curve" aria-label={`${t(T.curve)}: ${curve.map((p) => p.count).join(' → ')}`}>
        <span>{t(T.curve)}</span>
        {curve.map((p, i) => (
          <React.Fragment key={p.matchId}>
            {i > 0 && <span aria-hidden="true"> → </span>}
            <b className={p.matchId === Number(matchId) ? 'is-here' : ''} title={p.from ? t(T.curveFrom) : `#${p.matchId}`}>{p.count}</b>
          </React.Fragment>
        ))}
      </span>
    );
  };
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
          {/* The check's own label: it reads the same on any hero. The goal came from another game, so say which. */}
          <b>{activeGoalNow.goal.label[lang]}</b>
          <Link to={`/r/${activeGoalNow.fromMatch}?lang=${lang}`} className="ag-link">{t(T.goalFrom).replace('{id}', String(activeGoalNow.fromMatch))}</Link>
          <span className={`cx-goal-result is-${goalCheck.result}`}>{t(T.goalResult[goalCheck.result])}</span>
          <em>{goalCheck.evidence[lang]}</em>
          {curveLine(activeGoalNow.id)}
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
              {curveLine(`${activeGoalNow!.id}#${rule.finding}`)}
            </li>
          ))}
        </ul>
      )}
    </header>
  );
  const scoreboard = board && <MatchBoard report={board} hero={heroKey} lang={lang} replayLead={avail?.trace ? avail.radiant_gold_lead ?? avail.radiant_net_worth_lead ?? null : null} replayLeadIs={avail?.trace && avail.radiant_gold_lead ? 'gold' : 'net_worth'} />;
  // A parse the reader asked for to check the goal only: trying it again is the same request, not a review.
  // Only while the parse is what failed: once the replay is parsed there is no goal-only request left to repeat.
  const goalOnly = checkingOnly === selection && !intent && !hasTrace;
  // A reader who never asked for a review, on a page whose review status could not be read (a failed request, not a
  // failed review — that one carries a reason): trying again reads the status again; it does not ask for a review.
  const statusOnly = !intent && hasTrace && state?.status === 'failed' && !('reason' in state && state.reason);
  const again = () => { if (goalOnly) void checkOnly(); else if (statusOnly) void loadReview(); else void go(); };
  const dead = (title: Bi, body: Bi, retry = false) => (
    <Shell>{header}<div className="ag-state"><h1>{t(title)}</h1><p>{t(body)}</p>{retry && <button type="button" className="ag-btn is-primary" onClick={again} disabled={Boolean(wait)}>{t(T.retry)}</button>}{(notice ?? waitNotice) && <p className="ag-warn" role="alert">{notice ?? waitNotice}</p>}</div>{scoreboard}</Shell>
  );

  if (roster.length === 0) return dead(T.notFound, T.notFoundBody);

  if (!hero) {
    return (
      <Shell>
        {header}
        <section className="ag-pick">
          <h1>{t(T.pick)}</h1>
          {arrivedBy === 'team' && <p className="ag-pick-from">{t(T.fromTeam)}</p>}
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
            <ReviewDoc matchId={matchId} review={state.review} lang={lang} onAsk={ask} onPlan={(q) => chat.current?.send(q) ?? false} onReplan={(k) => pickPlan(k)} goalContext={goalContext} board={scoreboard} share={<ShareBar matchId={matchId} hero={hero.hero} lang={lang} plan={plan} model={writtenBy} />} quick={!slow} feedback={Number.isInteger(state.prompt_version) ? { plan, model: writtenBy, version: state.prompt_version as number } : null} />
            <p className="ag-checked">{t(T.checked)}{state.verification.dropped > 0 ? ` ${state.verification.dropped} ${t(T.dropped)}.` : ''}</p>
            {/* Which model wrote it, and the choice of another: after the review, not between the reader and its first line. */}
            {offered.length > 1 && (
              <div className="ag-modelbar is-after">
                <span>{t(T.modelBy)}</span>
                {modelPick(t(T.modelBy))}
              </div>
            )}
          </div>
          <ChatRail ref={chat} matchId={matchId} hero={hero.hero} lang={lang} suggestions={suggestions} plan={plan} model={model} />
        </div>
      </Shell>
    );
  }

  // No replay, and none to be had.
  if (parse?.status === 'failed') {
    if (parse.reason === 'replay_gone') return dead(T.goneTitle, T.goneBody);
    if (parse.reason === 'no_replay_url') return dead(T.noUrlTitle, awaitingReplay ? T.noUrlWaiting : T.noUrlBody, true);
    return dead(T.parseFailedTitle, T.parseFailedBody, !parse.final);
  }
  if (!hasTrace && !avail.can_parse) return dead(T.offTitle, T.offBody);
  if (state?.status === 'failed') return dead(T.failedTitle, T.failedBody, true);
  // Not available for a while (the model account refused a review a moment ago) is not a dead end: it can be tried again.
  if (state?.status === 'unavailable' || (hasTrace && !avail.model_configured)) return dead(T.failedTitle, T.unavailable, state?.status === 'unavailable' && state.retry_in_sec != null);

  // Something is running, or the reader said go and the next request is about to leave.
  const working = parsing || state?.status === 'running' || (intent && !notice && !wait && (!hasTrace || state === null || state.status === 'none'));
  // Parsing for the goal only: say that, not "working on your review".
  const checkingGoal = checkingOnly === selection && !intent && state?.status !== 'running';
  if (working) {
    const live = journeyStep(avail, state);
    const steps = [T.s1, T.s2, T.s3, T.s4];
    return (
      <Shell>
        {header}
        <div className="ag-state" role="status">
          <h1>{t(checkingGoal ? T.checkingGoal : T.working)}</h1>
          <p>{t(T.leave)}</p>
          {workTime && <p className="ag-worktime">{workTime}</p>}
          {callback.button}
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
        {/* The replay is parsed and the review is being written: the reader's own deaths, to watch meanwhile. Outside the status region, so a screen reader is not read the whole list as progress. */}
        {hasTrace && heroKey && !parsing && <WaitDeaths matchId={matchId} hero={heroKey} lang={lang} />}
        {/* The match record needs no replay: line-ups, items and the result are there from the first second of the wait, also while the replay is still being fetched. */}
        {scoreboard}
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
            <p>{t(T.goBody)}{lang === 'zh' ? '' : ' '}{goTime ?? ''}</p>
            <fieldset className="ag-planpick">
              <legend>{t(T.planAsk)}</legend>
              <p>{t(T.planWhy)}</p>
              <div className="ag-planpick-row" role="radiogroup" aria-label={t(T.planAsk)}>
                {[null, ...PLANS.map((p) => p.key)].map((k) => (
                  <button key={k ?? 'none'} type="button" role="radio" aria-checked={plan === k} className={`ag-chip-btn ${plan === k ? 'is-on' : ''}`} onClick={() => pickPlan(k)}>
                    {k ? PLANS.find((p) => p.key === k)!.label[lang] : t(T.planNone)}
                  </button>
                ))}
              </div>
            </fieldset>
            {offered.length > 1 && (
              <fieldset className="ag-planpick">
                <legend>{t(T.modelAsk)}</legend>
                <p>{t(T.modelWhy)}</p>
                {modelPick(t(T.modelAsk))}
              </fieldset>
            )}
            <button type="button" className="ag-btn is-primary" onClick={go} disabled={Boolean(wait)}>{t(T.go)}</button>
            {goalWaitsOnReplay && (
              <p className="ag-checkonly">
                <button type="button" className="ag-btn" onClick={checkOnly} disabled={Boolean(wait)}>{t(T.checkOnly)}</button>
                <span>{t(T.checkOnlyWhy)}</span>
              </p>
            )}
            {state?.status === 'unknown_hero' && <p className="ag-warn">{t(T.unknownHero)}</p>}
            {(notice ?? waitNotice) && <p className="ag-warn" role="alert">{notice ?? waitNotice}</p>}
          </>
        )}
      </div>
      {scoreboard}
    </Shell>
  );
};
