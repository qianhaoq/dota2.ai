import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { parseMatchInput } from '../v2/parseMatchInput';
import { CoachApiError, fetchCoachReport, fetchMatchup, fetchRecentMatches, requestParse } from './api';
import { markReviewed, markSeen, parseAccountInput, rememberAccount, rememberedAccount, reviewedMatches, seenUntil } from './accountInput';
import type { Bi, CoachReport, Evidence, Finding, Player, RecentMatch, RecentMatches, Review } from './types';
import { SafeImg, clock, k, useLang, type Lang } from './ui';
import { Emph, jumpToCases, revealRow, Deaths as DeathsChapter, Fights as FightsChapter, Items as ItemsChapter, Laning as LaningChapter, Matchups, Story as StoryChapter } from './Chapters';
import { Cases } from './Cases';
import { buildSurface } from '../../lib/coach/cards.js';
import { AccessModes, LiveSample } from './HomeBlocks';
import { accessSnippets } from './accessSnippets';
import { GoldTimeline } from './GoldTimeline';
import { QuickJump, detectSmartInput } from './QuickJump';
import { AskPanel, type AskHandle } from './AskPanel';
import { CURRENT_PATCH, itemIcon } from './patch';
import { trackEvent, trackReviewViewed } from '../services/analytics';
import { activeGoal, checkGoal, goalChecks, goalFromFinding, setGoal, useActiveGoal, type GoalCheck } from './goalStore';
import './coach.css';
import './cards.css';
import './review.css';

const EXAMPLE_MATCH = '9091400302';

export { SafeImg };

const UI = {
  tagline: { en: 'A post-match coach that shows its evidence.', zh: '一位拿证据说话的赛后教练。' },
  heroTitle: { en: 'Paste a match.\nGet a coach’s read.', zh: '贴一场比赛，\n得到一份教练复盘。' },
  placeholder: { en: 'Match ID or OpenDota / Dotabuff / STRATZ link', zh: '比赛 ID，或 OpenDota / Dotabuff / STRATZ 链接' },
  review: { en: 'Review', zh: '开始复盘' },
  invalid: { en: 'That does not look like a match ID.', zh: '这看起来不是一个比赛 ID。' },
  tryExample: { en: 'Try an example', zh: '试试示例' },
  detectedMatch: { en: 'Detected match #{id}', zh: '已识别为比赛 #{id}' },
  detectedAccount: { en: 'Detected Steam account {id} — opens recent games', zh: '已识别为 Steam 账号 {id}，将打开最近比赛' },
  p1t: { en: 'Evidence first', zh: '证据先行' },
  p1: { en: 'Every point links to the numbers behind it. No vibes, no invented patch facts.', zh: '每条结论都附带依据。不靠感觉，不编造版本数据。' },
  p2t: { en: 'Tells you what to do', zh: '直接告诉你怎么做' },
  p2: { en: 'Each finding ends in one thing to do next game — with pro games on similar heroes that did it, and did not.', zh: '每条发现都落到下一局要做的一件事，并附上相似英雄职业对局的正例和反例。' },
  p3t: { en: 'Says what it can’t see', zh: '说清楚看不到什么' },
  p3: { en: 'Unparsed match? You get what the data supports — and a button to parse the rest.', zh: '比赛还没解析？只给数据撑得住的结论，并提供一键解析。' },
  useAccount: { en: 'No match ID? Use your Steam friend code', zh: '找不到比赛 ID？用 Steam 好友代码' },
  orAccount: { en: 'Your Steam friend code — we list your recent games:', zh: '输入你的 Steam 好友代码，列出你最近的比赛：' },
  accountPlaceholder: { en: 'Friend code, SteamID64 or profile link', zh: '好友代码、SteamID64 或个人资料链接' },
  showRecent: { en: 'Show my games', zh: '列出我的比赛' },
  accountInvalid: { en: 'That is not a friend code. In Dota 2 or Steam, open your profile: the friend code is the number under your name.', zh: '这不是好友代码。在 Dota 2 或 Steam 里打开你的个人资料，名字下面那串数字就是好友代码。' },
  accountVanity: { en: 'Custom Steam URLs can’t be looked up. Paste your friend code or a steamcommunity.com/profiles/… link instead.', zh: '自定义的 Steam 链接没法查询。请改贴好友代码，或 steamcommunity.com/profiles/… 形式的链接。' },
  myGames: { en: 'My recent games', zh: '我的最近比赛' },
  myGamesShort: { en: 'My games', zh: '我的比赛' },
  recentTitle: { en: 'Your recent games', zh: '你最近的比赛' },
  recentSub: { en: 'Pick a game — the review opens on your hero.', zh: '选一场，复盘会直接打开你的英雄。' },
  recentEmpty: {
    en: 'No public games for this account. If it is yours, turn on “Expose Public Match Data” in Dota 2’s settings, play a game, then come back.',
    zh: '这个账号没有公开的比赛。如果是你的账号，请在 Dota 2 设置里打开「公开比赛数据」（Expose Public Match Data），打完一局再回来。',
  },
  recentFilterAll: { en: 'All', zh: '全部' },
  recentFilterUnreviewed: { en: 'Unreviewed', zh: '未复盘' },
  recentFilterRanked: { en: 'Ranked', zh: '天梯' },
  recentFilterEmpty: { en: 'No recent games match this filter.', zh: '当前筛选条件下没有比赛。' },
  notMe: { en: 'Not you? Forget this account', zh: '不是你？忘掉这个账号' },
  latestTitle: { en: 'Your latest game', zh: '你刚打完的那局' },
  latestCta: { en: 'Review it', zh: '复盘这局' },
  allRecent: { en: 'All recent games', zh: '全部最近比赛' },
  reviewedTag: { en: 'Reviewed', zh: '已复盘' },
  newTag: { en: 'New', zh: '新' },
  setGoal: { en: 'Make this my next-game goal', zh: '设为下局目标' },
  goalSet: { en: 'Your next-game goal', zh: '已设为下局目标' },
  goalClear: { en: 'Clear', zh: '取消' },
  goalCheckTitle: { en: 'Your goal', zh: '你的目标' },
  goalPill: { en: 'Goal', zh: '目标' },
  goalFrom: { en: 'set after game #{id}', zh: '来自 #{id} 那局的复盘' },
  goalHere: { en: 'You set this goal from this game. Play your next one — the coach checks it automatically.', zh: '目标就是从这局定的。打下一局，教练会自动核验。' },
  goalPending: { en: 'No game checked against it yet — play your next one, then open it here.', zh: '还没有对局核验过这个目标——打完下一局，再在这里打开它。' },
  goalTally: { en: '{met} of {n} games met', zh: '{n} 局里达成 {met} 局' },
  goalResult: {
    met: { en: 'Met', zh: '达成' }, missed: { en: 'Missed', zh: '未达成' },
    no_opportunity: { en: 'Did not come up', zh: '这局没遇到' }, unknown: { en: 'Can’t tell yet', zh: '暂时判断不了' },
  } as Record<string, Bi>,
  win: { en: 'Win', zh: '胜' },
  loss: { en: 'Loss', zh: '负' },
  patchEyebrow: { en: 'New patch', zh: '新版本' },
  patchTitle: { en: 'Patch {v} is live', zh: '{v} 版本已上线' },
  patchNewItems: { en: 'New items', zh: '新装备' },
  patchNotes: { en: 'Full patch notes', zh: '完整更新日志' },
  patchForCoach: { en: 'For your review', zh: '对复盘的影响' },
  patchCta: { en: 'Review your first {v} game', zh: '复盘你的第一场 {v}' },
  patchMore: { en: 'Key changes & impact on reviews', zh: '查看核心改动与对复盘的影响' },
  loading: { en: 'Reading the match…', zh: '正在读取比赛…' },
  radiant: { en: 'Radiant', zh: '天辉' },
  dire: { en: 'Dire', zh: '夜魇' },
  victory: { en: 'victory', zh: '胜利' },
  pick: { en: 'Which hero were you?', zh: '你玩的是哪个英雄？' },
  pickSub: { en: 'Pick one to get a review written for that seat.', zh: '选一个英雄，复盘会针对这个位置来写。' },
  rosterExpand: { en: 'Full 10-player items', zh: '展开 10 人详情' },
  rosterCompact: { en: 'Hide the items', zh: '收起 10 人详情' },
  askQuick: { en: 'Ask coach', zh: '追问教练' },
  verdictEyebrow: { en: 'Biggest lever', zh: '本局核心结论' },
  coachRead: { en: 'Coach’s read', zh: '教练结论' },
  forYou: { en: 'For you', zh: '你的问题' },
  forTeam: { en: 'For your team', zh: '全队的问题' },
  wentWell: { en: 'What went right', zh: '做得好的地方' },
  doNext: { en: 'What to do', zh: '怎么做' },
  role: { en: 'Seat', zh: '位置' },
  roleInferred: { en: 'Inferred from farm — lanes unknown until parsed.', zh: '按经济推断——解析前不知道分路。' },
  roleLanes: { en: 'Inferred from lanes and farm.', zh: '按分路和经济推断。' },
  roleUser: { en: 'Set by you.', zh: '由你指定。' },
  fixRole: { en: 'Wrong seat? Set it:', zh: '位置不对？手动指定：' },
  vsHero: { en: 'vs. other games on this hero', zh: '对比同英雄的其他对局' },
  items: { en: 'Final items', zh: '终局装备' },
  matchups: { en: 'Matchups', zh: '对位' },
  threats: { en: 'What the enemy brought', zh: '对方阵容的威胁' },
  timeline: { en: 'Key item timings', zh: '关键装备时间' },
  deaths: { en: 'Deaths', zh: '死亡记录' },
  caught: { en: 'caught', zh: '被抓' },
  fight: { en: 'in a fight', zh: '团战中' },
  notHeroTitle: { en: 'No hero got the kill: tower, creeps or neutrals', zh: '击杀者不是英雄：防御塔、小兵或野怪' },
  converted: { en: '→ objective lost', zh: '→ 丢了目标' },
  cantSee: { en: 'Not parsed yet — here is what we can’t see', zh: '比赛尚未解析——以下内容暂时看不到' },
  cantSeeSub: {
    en: 'OpenDota has not parsed the replay. The read above uses end-of-game data only. Parsing usually takes a few minutes while the replay is still available.',
    zh: 'OpenDota 还没有解析这场录像，上面的结论只用了终局数据。录像仍可下载时，解析通常需要几分钟。',
  },
  partialGaps: { en: 'This parse does not include', zh: '这次解析未包含' },
  parseBtn: { en: 'Parse this match', zh: '解析这场比赛' },
  parsePending: { en: 'Parse requested — checking every 20 seconds…', zh: '已提交解析——每 20 秒检查一次…' },
  parseThrottled: { en: 'Too many parse requests right now. Try again in a minute.', zh: '解析请求太多，请一分钟后再试。' },
  parseFailed: { en: 'OpenDota could not take the request. The replay may have expired.', zh: 'OpenDota 没有接受请求，录像可能已过期。' },
  parsedReady: { en: 'Full parse is ready — the review now includes laning, deaths and the gold graph.', zh: '解析完成——复盘已加入对线、死亡与经济曲线。' },
  parseGaveUp: { en: 'Still not parsed after 10 minutes. Come back later; the link keeps working.', zh: '10 分钟后仍未解析完成。稍后再来，链接一直有效。' },
  notFound: { en: 'OpenDota does not know this match. Check the ID — private or very new matches may not be visible yet.', zh: 'OpenDota 找不到这场比赛。请检查 ID——私密比赛或刚结束的比赛可能暂时不可见。' },
  upstream: { en: 'OpenDota did not answer in time. Try again in a moment.', zh: 'OpenDota 暂时没有响应，请稍后重试。' },
  rateLimited: { en: 'Slow down a little — too many requests from your network.', zh: '请求太频繁了，请稍等。' },
  retry: { en: 'Try again', zh: '重试' },
  refreshFailed: { en: 'Could not update the report — what you see may not reflect your latest change.', zh: '报告没能更新——当前显示的可能不是你最新的选择。' },
  newMatch: { en: 'Another match', zh: '换一场' },
  api: { en: 'For agents and scripts', zh: '给 agent 和脚本' },
  confidence: { high: { en: 'high confidence', zh: '高置信' }, medium: { en: 'medium confidence', zh: '中等置信' }, low: { en: 'low confidence', zh: '低置信' } } as Record<string, Bi>,
  needsParse: { en: 'needs parse', zh: '需解析' },
  noFindings: { en: 'Nothing in the data stands out for this seat.', zh: '数据里没有针对这个位置的突出问题。' },
  share: { en: 'Copy my link', zh: '复制我的链接' },
  shareTeam: { en: 'Send to my team', zh: '发给队友' },
  shareTeamText: {
    en: 'Our game #{id} reviewed by dota2.ai — pick your hero and see the one thing worth fixing:',
    zh: '我们那局 #{id} 的复盘（dota2.ai）——点开选你玩的英雄，看看你最该改的一件事：',
  },
  teamCopied: { en: 'Link copied — paste it to your team', zh: '链接已复制，发到队伍群里吧' },
  ranked: { en: 'Ranked', zh: '天梯' },
  footer: { en: 'Not affiliated with Valve. Match data from OpenDota.', zh: '粉丝项目，与 Valve 无关。比赛数据来自 OpenDota。' },
  parsed: { en: 'Parsed', zh: '已解析' },
  fromSteamGc: { en: 'Scoreboard from Valve’s game coordinator (OpenDota unavailable): no timeline yet', zh: '数据来自 Valve 游戏协调器（OpenDota 暂不可用）：只有终局计分板，暂无时间线' },
  fromStratz: { en: 'Data from STRATZ (OpenDota unavailable)', zh: '数据来自 STRATZ（OpenDota 暂不可用）' },
  copied: { en: 'Copied', zh: '已复制' },
} satisfies Record<string, Bi | Record<string, Bi>>;

const AREA: Record<Finding['area'], Bi> = {
  items: { en: 'Items', zh: '出装' }, farm: { en: 'Farm', zh: '发育' }, deaths: { en: 'Deaths', zh: '死亡' },
  fights: { en: 'Fights', zh: '团战' }, objectives: { en: 'Objectives', zh: '目标' }, team: { en: 'Team', zh: '全队' },
  laning: { en: 'Laning', zh: '对线' }, vision: { en: 'Vision', zh: '视野' },
};

const tally = (goalId: string) => {
  const counted = goalChecks(goalId).filter((c) => c.result === 'met' || c.result === 'missed');
  return { n: counted.length, met: counted.filter((c) => c.result === 'met').length };
};

/* ---------------------------------------------------------------- shell */

/** Compact active-goal indicator in the top bar; details open on click. */
const GoalNavBadge: React.FC = () => {
  const { lang, L } = useLang();
  const goal = useActiveGoal();
  const [open, setOpen] = useState(false);
  if (!goal) return null;
  const tl = tally(goal.id);
  return (
    <div className="cx-goal-nav">
      <button type="button" className="cx-goal-pill" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="cx-goal-dot" aria-hidden="true" />
        <span>{L(UI.goalPill)}{tl.n > 0 ? ` ${tl.met}/${tl.n}` : ''}</span>
      </button>
      {open && (
        <div className="cx-popover cx-goal-pop" role="dialog" aria-label={L(UI.goalCheckTitle)}>
          <p className="cx-eyebrow">{L(UI.goalCheckTitle)} · {L(UI.goalFrom).replace('{id}', String(goal.fromMatch))}</p>
          <p className="cx-goal-pop-label"><b>{L(goal.goal.label)}</b></p>
          {tl.n > 0 && <p className="cx-muted">{L(UI.goalTally).replace('{n}', String(tl.n)).replace('{met}', String(tl.met))}</p>}
          <div className="cx-goal-pop-actions">
            <Link to={`/r/${goal.fromMatch}?lang=${lang}`} onClick={() => setOpen(false)}>#{goal.fromMatch} →</Link>
            <button type="button" className="cx-linkbtn" onClick={() => { setGoal(null); setOpen(false); }}>{L(UI.goalClear)}</button>
          </div>
        </div>
      )}
    </div>
  );
};

const Shell: React.FC<{ children: React.ReactNode; wide?: boolean; isHome?: boolean; hideMyGames?: boolean }> = ({
  children,
  wide,
  isHome = false,
  hideMyGames = false,
}) => {
  const { lang, setLang, L } = useLang();
  const known = rememberedAccount();
  return (
    <div className="cx">
      <header className="cx-top">
        <Link to={`/?lang=${lang}`} className="cx-brand" aria-label="dota2.ai home">
          <span className="cx-mark" aria-hidden="true">◆</span> dota2<span className="cx-dot">.ai</span>
          <span className="cx-brand-sub">coach</span>
        </Link>
        <div className="cx-top-right">
          {!isHome && <QuickJump />}
          {known && !hideMyGames && (
            <Link to={`/p/${known}?lang=${lang}`} className="cx-top-link">{L(UI.myGamesShort)}</Link>
          )}
          <GoalNavBadge />
          <div className="cx-lang" role="group" aria-label="Language">
            <button type="button" aria-pressed={lang === 'en'} onClick={() => setLang('en')}>EN</button>
            <button type="button" aria-pressed={lang === 'zh'} onClick={() => setLang('zh')}>中文</button>
          </div>
        </div>
      </header>
      <main className={wide ? 'cx-main cx-main--wide' : 'cx-main'}>{children}</main>
      <footer className="cx-foot">
        <span>{L(UI.footer)}</span>
      </footer>
    </div>
  );
};

/* ----------------------------------------------------------------- home */

/** Coming back after a game: the newest one, one tap from its review. */
const LatestGame: React.FC<{ accountId: string }> = ({ accountId }) => {
  const { lang, L } = useLang();
  const [latest, setLatest] = useState<RecentMatch | null>(null);
  const goal = useActiveGoal();
  useEffect(() => {
    const ac = new AbortController();
    fetchRecentMatches(accountId, ac.signal).then((r) => setLatest(r.matches[0] ?? null)).catch(() => {});
    return () => ac.abort();
  }, [accountId]);
  const all = <Link to={`/p/${accountId}?lang=${lang}`} className="cx-account-known">{latest ? L(UI.allRecent) : L(UI.myGames)} →</Link>;
  if (!latest) return <p className="cx-example">{all}</p>;
  const reviewed = reviewedMatches().has(String(latest.match_id));
  return (
    <div className={`cx-latest ${goal ? 'has-goal' : ''}`}>
      <div className="cx-latest-card">
        <p className="cx-eyebrow">{L(UI.latestTitle)}</p>
        <div className="cx-latest-row">
          {latest.hero.icon ? <SafeImg src={latest.hero.icon} alt="" className="cx-recent-icon" /> : <span className="cx-recent-icon" />}
          <span className="cx-latest-text">
            <b>{latest.hero[lang]}</b>{' '}
            <span className={latest.won ? 'is-win' : latest.won === false ? 'is-loss' : ''}>{latest.won == null ? '' : L(latest.won ? UI.win : UI.loss)}</span>{' '}
            <span className="cx-recent-kda">{latest.kda ? latest.kda.join('/') : '—'}</span>
            {reviewed && <span className="cx-tag">{L(UI.reviewedTag)}</span>}
          </span>
          <Link to={`/r/${latest.match_id}?${latest.slot != null ? `p=${latest.slot}&` : ''}lang=${lang}`} className="cx-patch-cta cx-latest-cta">{L(UI.latestCta)}</Link>
        </div>
        <p className="cx-example">{all}</p>
      </div>
      {goal && <LatestGoal goal={goal} latest={latest} />}
    </div>
  );
};

/** Home: judge the newest game against the goal (one report fetch, only when it counts). */
const LatestGoal: React.FC<{ goal: NonNullable<ReturnType<typeof activeGoal>>; latest: RecentMatch }> = ({ goal, latest }) => {
  const { L } = useLang();
  const [check, setCheck] = useState<GoalCheck | null>(null);
  const counts = latest.match_id !== goal.fromMatch && (latest.start_time ?? 0) > goal.fromStart;
  useEffect(() => {
    if (!counts) return;
    const ac = new AbortController();
    fetchCoachReport(String(latest.match_id), { signal: ac.signal })
      .then((r) => {
        // Steam GC history has no seat: find this account in the game, or judge nothing.
        const acct = Number(goal.accountId ?? rememberedAccount());
        const seat = latest.slot ?? r.players.find((p) => p.account_id != null && p.account_id === acct)?.slot;
        if (seat != null) setCheck(checkGoal(goal, r, seat));
      })
      .catch(() => {});
    return () => ac.abort();
  }, [counts, goal, latest.match_id, latest.slot]);
  const tl = tally(goal.id);
  return (
    <div className="cx-latest-goal-card">
      <p className="cx-eyebrow">{L(UI.goalCheckTitle)}{tl.n > 0 ? ` · ${L(UI.goalTally).replace('{n}', String(tl.n)).replace('{met}', String(tl.met))}` : ''}</p>
      <p className="cx-latest-goal">
        <span>{L(goal.goal.label)}</span>
        {check ? <ResultPill r={check.result} /> : !counts ? <span className="cx-muted"> · {L(UI.goalHere)}</span> : null}
      </p>
      {check && <p className="cx-muted">{L(check.evidence)}</p>}
    </div>
  );
};

/* --------------------------------------------------------- recent games */

type RecentFilter = 'all' | 'unreviewed' | 'ranked';

/** Keyed by account: opening another player starts with fresh filters and a fresh "seen" mark. */
export const CoachPlayerPage: React.FC = () => {
  const { accountId = '' } = useParams();
  return <PlayerPage key={accountId} accountId={accountId} />;
};

const PlayerPage: React.FC<{ accountId: string }> = ({ accountId }) => {
  const { lang, L } = useLang();
  const navigate = useNavigate();
  const [data, setData] = useState<RecentMatches | null>(null);
  const [error, setError] = useState<CoachApiError | null>(null);
  const [filter, setFilter] = useState<RecentFilter>('all');
  const [heroFilter, setHeroFilter] = useState<number | null>(null);
  const goal = useActiveGoal();
  // Read once per visit, before this visit marks the list as seen.
  const [seen] = useState(() => (rememberedAccount() === accountId ? seenUntil() : null));
  const [reviewed] = useState(() => reviewedMatches());
  const valid = /^[1-9]\d{0,9}$/.test(accountId) && Number(accountId) <= 2 ** 32 - 1;
  const load = useCallback(async (signal?: AbortSignal) => {
    if (!valid) return;
    setError(null); setData(null);
    try {
      const r = await fetchRecentMatches(accountId, signal);
      setData(r);
      if (r.matches.length) {
        rememberAccount(accountId);
        markSeen(Math.max(...r.matches.map((x) => x.start_time ?? 0)));
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setError(e instanceof CoachApiError ? e : new CoachApiError('upstream', String(e), 0));
    }
  }, [accountId, valid]);
  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  // A goal belongs to the player it was set from. One without a recorded account (older
  // goals) is shown only on the account this browser remembers: unknown is not "yours".
  const isGoalOwner = Boolean(goal) && (goal!.accountId != null
    ? String(goal!.accountId) === accountId
    : rememberedAccount() === accountId);
  const checkByMatch = useMemo(() => {
    // Goal results belong to the goal's player: never show them on another account's games.
    if (!goal || !isGoalOwner) return new Map<number, GoalCheck>();
    return new Map(goalChecks(goal.id).map((c) => [c.matchId, c]));
    // isGoalOwner can flip once the page remembers this account (after its games load).
  }, [goal, accountId, isGoalOwner]);

  const topHeroes = useMemo(() => {
    if (!data) return [];
    const map = new Map<number, { hero: RecentMatch['hero']; count: number }>();
    for (const m of data.matches) {
      const prev = map.get(m.hero.id);
      map.set(m.hero.id, { hero: m.hero, count: (prev?.count ?? 0) + 1 });
    }
    return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 6);
  }, [data]);

  if (!valid) return <Shell hideMyGames><ErrorBlock text={L(UI.accountInvalid)} /></Shell>;
  if (error) {
    const text = error.status === 429 ? L(UI.rateLimited) : L(UI.upstream);
    return <Shell hideMyGames><ErrorBlock text={text} onRetry={() => void load()} /></Shell>;
  }
  if (!data) return <Shell hideMyGames><Skeleton label={L(UI.loading)} /></Shell>;

  const filtered = data.matches.filter((m) => {
    if (filter === 'unreviewed' && reviewed.has(String(m.match_id))) return false;
    if (filter === 'ranked' && !m.ranked) return false;
    if (heroFilter != null && m.hero.id !== heroFilter) return false;
    return true;
  });

  const tl = goal ? tally(goal.id) : null;

  return (
    <Shell hideMyGames>
      <section className="cx-recent">
        <div className="cx-recent-head">
          <div>
            <p className="cx-eyebrow">{L(UI.recentTitle)} · #{accountId}</p>
            <h1 className="cx-h2">{L(UI.recentSub)}</h1>
          </div>
          <button type="button" className="cx-ghost" onClick={() => { rememberAccount(null); navigate(`/?lang=${lang}`); }}>
            {L(UI.notMe)}
          </button>
        </div>

        {goal && isGoalOwner && (
          <div className="cx-goal cx-recent-goal">
            <div className="cx-recent-goal-top">
              <div>
                <p className="cx-eyebrow">{L(UI.goalCheckTitle)} · {L(UI.goalFrom).replace('{id}', String(goal.fromMatch))}</p>
                <p className="cx-goal-label"><b>{L(goal.goal.label)}</b></p>
                {tl && tl.n > 0 ? (
                  <div className="pl-progress">
                    <div className="pl-bar" role="progressbar" aria-valuemin={0} aria-valuemax={tl.n} aria-valuenow={tl.met} aria-label={L(UI.goalCheckTitle)}>
                      <span style={{ width: `${Math.round((tl.met / tl.n) * 100)}%` }} />
                    </div>
                    <p className="cx-goal-tally">{L(UI.goalTally).replace('{n}', String(tl.n)).replace('{met}', String(tl.met))}</p>
                  </div>
                ) : (
                  // Nothing checked yet: say so, never a "0/0" bar.
                  <p className="cx-goal-tally">{L(UI.goalPending)}</p>
                )}
              </div>
              <button type="button" className="cx-linkbtn" onClick={() => setGoal(null)}>{L(UI.goalClear)}</button>
            </div>
          </div>
        )}

        {data.matches.length === 0 ? (
          <p className="cx-recent-empty">{L(UI.recentEmpty)}</p>
        ) : (
          <>
            <div className="cx-recent-controls">
              <div className="cx-filter-bar" role="group" aria-label={L(UI.recentTitle)}>
                {([
                  ['all', UI.recentFilterAll],
                  ['unreviewed', UI.recentFilterUnreviewed],
                  ['ranked', UI.recentFilterRanked],
                ] as const).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className={`cx-filter-pill ${filter === id ? 'is-on' : ''}`}
                    aria-pressed={filter === id}
                    onClick={() => setFilter(id)}
                  >
                    {L(label)}
                  </button>
                ))}
              </div>
              {topHeroes.length > 1 && (
                <div className="cx-hero-filters" role="group" aria-label="Hero filter">
                  {topHeroes.map(({ hero }) => (
                    <button
                      key={hero.id}
                      type="button"
                      className={`cx-hero-chip ${heroFilter === hero.id ? 'is-on' : ''}`}
                      aria-pressed={heroFilter === hero.id}
                      onClick={() => setHeroFilter((cur) => (cur === hero.id ? null : hero.id))}
                    >
                      {hero.icon && <SafeImg src={hero.icon} alt="" />}
                      <span>{hero[lang]}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {filtered.length === 0 ? (
              <p className="cx-recent-empty">{L(UI.recentFilterEmpty)}</p>
            ) : (
              <ul className="cx-recent-list">
                {filtered.map((m) => {
                  const gc = checkByMatch.get(m.match_id);
                  return (
                    <li key={m.match_id}>
                      <Link to={`/r/${m.match_id}?${m.slot != null ? `p=${m.slot}&` : ''}lang=${lang}`} className="cx-recent-row">
                        {m.hero.icon ? <SafeImg src={m.hero.icon} alt="" className="cx-recent-icon" /> : <span className="cx-recent-icon" />}
                        <span className="cx-recent-hero">
                          {m.hero[lang]}
                          {seen != null && (m.start_time ?? 0) > seen && <span className="cx-tag cx-tag--new">{L(UI.newTag)}</span>}
                          {reviewed.has(String(m.match_id)) && <span className="cx-tag">{L(UI.reviewedTag)}</span>}
                          {gc && <ResultPill r={gc.result} />}
                        </span>
                        <span className={`cx-recent-result ${m.won ? 'is-win' : m.won === false ? 'is-loss' : ''}`}>
                          {m.won == null ? '—' : L(m.won ? UI.win : UI.loss)}
                        </span>
                        <span className="cx-recent-kda">{m.kda ? m.kda.join('/') : '—'}</span>
                        <span className="cx-recent-meta">
                          {m.mode ? L(m.mode) : ''}{m.ranked ? ` · ${L(UI.ranked)}` : ''}
                          {m.duration != null ? ` · ${clock(m.duration)}` : ''}
                          {m.start_time ? ` · ${new Date(m.start_time * 1000).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US')}` : ''}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </section>
    </Shell>
  );
};

/** The patch as one line; new items and what changed for reviews are one click away. */
const PatchNews: React.FC<{ onCta: () => void }> = ({ onCta }) => {
  const { lang, L } = useLang();
  const p = CURRENT_PATCH;
  const v = (b: Bi) => L(b).replace('{v}', p.version);
  return (
    <section className="cx-patch hm-patchbar" aria-labelledby="cx-patch-title">
      <details className="cx-patch-details">
        <summary>
          <span className="hm-patch-line">
            <time dateTime={p.date}>{p.date}</time>
            <h2 id="cx-patch-title">{v(UI.patchTitle)}</h2>
            <span className="hm-patch-count">{L(UI.patchNewItems)} {p.newItems.length}</span>
          </span>
        </summary>
        <div className="cx-patch-items">
          {p.newItems.map((it) => {
            const name = lang === 'zh' ? it.zh : it.en;
            return (
              <span key={it.key} className="cx-patch-item" title={name}>
                <SafeImg src={itemIcon(it.key)} alt="" className="cx-patch-icon" />
                <span>{name}</span>
              </span>
            );
          })}
        </div>
        <ul className="cx-patch-list">
          {p.highlights.map((h, i) => <li key={i}>{L(h)}</li>)}
        </ul>
        <p className="cx-patch-coach"><strong>{L(UI.patchForCoach)}</strong> {L(p.forCoach)}</p>
      </details>
      <div className="cx-patch-actions">
        <button type="button" className="cx-patch-cta" onClick={onCta}>{v(UI.patchCta)}</button>
        <a href={p.notesUrl} target="_blank" rel="noreferrer">{L(UI.patchNotes)} ↗</a>
      </div>
    </section>
  );
};

/** The review page's snippets: same commands and tool names as the home page (accessSnippets.ts). */
const AgentSnippets: React.FC<{ matchId: string }> = ({ matchId }) => {
  const { L } = useLang();
  const snippets = accessSnippets(matchId).filter((m) => m.lines.length);
  const [tab, setTab] = useState(snippets[0].mode);
  const cur = snippets.find((m) => m.mode === tab)!;
  return (
    <details className="cx-api cx-api-drawer">
      <summary>{L(UI.api)}</summary>
      <div className="cx-api-tabs" role="tablist" aria-label={L(UI.api)}>
        {snippets.map((m) => (
          <button key={m.mode} type="button" role="tab" aria-selected={tab === m.mode} className={tab === m.mode ? 'is-on' : ''} onClick={() => setTab(m.mode)}>
            {L(m.label)}
          </button>
        ))}
      </div>
      <pre><code>{cur.lines.join('\n')}</code></pre>
      <p className="cx-muted">{L(cur.note)}</p>
    </details>
  );
};

const HOME = {
  title: { en: 'Paste a match.', zh: '贴一场比赛。' },
  sub: { en: 'A post-match coach for Dota 2. Every point cites the numbers behind it, and it says plainly what the data cannot show — then tells you what to practise next game.', zh: 'Dota 2 赛后教练。每条结论都标明依据，数据看不到的会直说，然后告诉你下一局练什么。' },
  hint: { en: 'Match ID, link, or friend code', zh: '比赛 ID、链接或好友码' },
  samplesTitle: { en: 'Or open a sample review', zh: '或者，打开一份示例复盘' },
  samplesSub: { en: 'Match {id} · Dire victory', zh: '比赛 {id} · 夜魇胜利' },
  open: { en: 'Open the review', zh: '打开复盘' },
  modeLabel: { en: 'What are you pasting?', zh: '你要输入什么？' },
  modeMatch: { en: 'Match', zh: '比赛' },
  modeAccount: { en: 'Friend code', zh: '好友码' },
};

export const CoachHome: React.FC = () => {
  const { lang, L } = useLang();
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const [error, setError] = useState<'invalid' | 'vanity' | 'account' | null>(null);
  // A bare number is both a valid match ID and a valid friend code: the mode says which one it is.
  const [mode, setMode] = useState<'match' | 'account'>('match');
  const inputRef = useRef<HTMLInputElement>(null);
  const detected = useMemo(() => {
    if (mode === 'match') return detectSmartInput(value);
    const r = parseAccountInput(value);
    return r.ok ? { kind: 'account' as const, id: r.accountId } : { kind: 'none' as const };
  }, [value, mode]);
  const known = rememberedAccount();

  const go = (raw: string) => {
    if (mode === 'account') {
      const a = parseAccountInput(raw);
      if (a.ok) { navigate(`/p/${a.accountId}?lang=${lang}`); return; }
      setError(a.reason === 'vanity' ? 'vanity' : 'account');
      return;
    }
    const r = detectSmartInput(raw);
    if (r.kind === 'match') { navigate(`/r/${r.id}?lang=${lang}`); return; }
    if (r.kind === 'account') { navigate(`/p/${r.id}?lang=${lang}`); return; }
    setError(r.kind === 'vanity' ? 'vanity' : 'invalid');
  };

  const focusInput = () => { inputRef.current?.focus(); inputRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); };
  // The river lights up once the box holds something we can open (the page's one memorable moment).
  const state = detected.kind === 'match' || detected.kind === 'account' ? detected.kind : 'idle';

  return (
    <Shell isHome wide>
      <div className="hm-first">
      <div className="hm-left">
      <section className="cx-hero hm-map" data-state={state}>
        <svg className="hm-minimap" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <polygon className="hm-radiant" points="0,100 0,52 48,100" />
          <polygon className="hm-dire" points="100,0 52,0 100,48" />
          <path className="hm-lane" d="M6,94 L6,8 L92,8" />
          <path className="hm-lane" d="M8,94 L94,94 L94,8" />
          <path className="hm-lane" d="M10,90 L90,10" />
          <path className="hm-river" d="M0,30 C 28,40 40,62 70,100" />
        </svg>
        <div className="hm-core">
          <p className="cx-eyebrow">{L(UI.tagline)}</p>
          <h1 className="cx-h1 hm-title">{L(HOME.title)}</h1>
          <p className="hm-sub">{L(HOME.sub)}</p>
          <div className="hm-mode" role="radiogroup" aria-label={L(HOME.modeLabel)}>
            {(['match', 'account'] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? 'is-on' : ''}
                onClick={() => { setMode(m); setError(null); inputRef.current?.focus(); }}>
                {L(m === 'match' ? HOME.modeMatch : HOME.modeAccount)}
              </button>
            ))}
          </div>
          <form className="cx-search hm-ford" onSubmit={(e) => { e.preventDefault(); go(value); }}>
            <input
              ref={inputRef} aria-label={L(mode === 'match' ? UI.placeholder : UI.accountPlaceholder)}
              placeholder={L(mode === 'match' ? UI.placeholder : UI.accountPlaceholder)} value={value} inputMode="text" autoFocus
              onChange={(e) => { setValue(e.target.value); setError(null); }}
            />
            <button type="submit">{detected.kind === 'account' ? L(UI.showRecent) : L(UI.review)}</button>
          </form>
          <p className="hm-status" aria-live="polite">
            {mode === 'match' && detected.kind === 'match' && value.trim() !== detected.id
              ? <span className="cx-detect-pill is-match">{L(UI.detectedMatch).replace('{id}', detected.id)}</span>
              : detected.kind === 'account'
                ? <span className="cx-detect-pill is-account">{L(UI.detectedAccount).replace('{id}', detected.id)}</span>
                : mode === 'account' ? <span className="hm-hint">{L(UI.accountPlaceholder)}</span>
                : <span className="hm-hint">{L(HOME.hint)} · {L(UI.tryExample)}: <button type="button" className="hm-example" onClick={() => go(EXAMPLE_MATCH)}>{EXAMPLE_MATCH}</button></span>}
          </p>
          {error && <p className="cx-err" role="alert">{L(error === 'vanity' ? UI.accountVanity : error === 'account' ? UI.accountInvalid : UI.invalid)}</p>}
        </div>
      </section>

      {known && <div className="hm-latest"><LatestGame accountId={known} /></div>}
      </div>
      {/* The first screen's working object: the engine's own review of a real match, live. */}
      <LiveSample matchId={EXAMPLE_MATCH} />
      </div>

      <AccessModes matchId={EXAMPLE_MATCH} onWeb={focusInput} />

      <PatchNews onCta={focusInput} />
    </Shell>
  );
};

/* --------------------------------------------------------------- report */

export const CoachReportPage: React.FC = () => {
  const { matchId = '' } = useParams();
  const [search, setSearch] = useSearchParams();
  const { lang, L } = useLang();
  const [report, setReport] = useState<CoachReport | null>(null);
  const [error, setError] = useState<CoachApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [rosterExpanded, setRosterExpanded] = useState(false);
  const [askSeq, setAskSeq] = useState(0);
  const slot = search.has('p') ? Number(search.get('p')) : null;
  const posOverride = search.has('pos') ? Number(search.get('pos')) : null;
  const valid = parseMatchInput(matchId) === matchId;

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!valid) return;
    setLoading(true); setError(null);
    try {
      const r = await fetchCoachReport(matchId, { slot: slot ?? undefined, pos: posOverride ?? undefined, signal });
      setReport(r);
      return r;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setError(e instanceof CoachApiError ? e : new CoachApiError('upstream', String(e), 0));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [matchId, slot, posOverride, valid]);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  // One review_viewed per match per session; `ref` says whether a teammate's link brought them.
  const ref = search.get('ref');
  const viewedId = report?.match.id;
  const viewedParsed = report?.match.parsed;
  useEffect(() => {
    if (viewedId == null) return;
    markReviewed(viewedId);
    trackReviewViewed(viewedId, {
      ui: 'coach', surface: 'web', lang, state: viewedParsed ? 'parsed' : 'unparsed',
      ...(ref === 'team' || ref === 'share' ? { ref } : {}),
    });
  // Only when a new match loads; lang/ref changes are not new views.
  }, [viewedId]);

  const setParam = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(search);
    for (const [key, v] of Object.entries(patch)) (v == null ? next.delete(key) : next.set(key, v));
    setSearch(next, { replace: false });
  };

  if (!valid) {
    return <Shell><ErrorBlock text={L(UI.invalid)} /></Shell>;
  }
  if (error && !report) {
    const text = error.status === 404 ? L(UI.notFound) : error.status === 429 ? L(UI.rateLimited) : L(UI.upstream);
    return <Shell><ErrorBlock text={text} onRetry={() => void load()} /></Shell>;
  }
  if (!report) {
    return <Shell wide><Skeleton label={L(UI.loading)} /></Shell>;
  }

  const m = report.match;
  const selected = slot != null && slot >= 0 && slot <= 9 ? slot : null;
  const review = selected != null ? report.reviews[selected] : null;
  const player = selected != null ? report.players[selected] : null;
  return (
    <Shell wide>
      {review && player ? (
        <ReviewHeader
          report={report}
          review={review}
          player={player}
          pos={posOverride}
          onSetPos={(pos) => setParam({ pos: String(pos) })}
          onPick={(s) => setParam({ p: String(s), pos: null })}
          rosterOpen={rosterExpanded}
          onToggleRoster={() => setRosterExpanded((v) => !v)}
          onAskClick={() => setAskSeq((n) => n + 1)}
        />
      ) : (
        <MatchHeader report={report} slot={selected} pos={posOverride} />
      )}

      {notice && <p className="cx-notice" role="status">{notice}</p>}
      {error && (
        <p className="cx-notice cx-notice--error" role="alert">
          {error.status === 429 ? L(UI.rateLimited) : L(UI.refreshFailed)}{' '}
          <button type="button" className="cx-inline-btn" onClick={() => void load()}>{L(UI.retry)}</button>
        </p>
      )}

      {review && player ? (
        <>
          {/* Every player's final items, on demand: the header strip is enough to switch. */}
          {rosterExpanded && <Lineup report={report} selected={selected} onPick={(s) => setParam({ p: String(s), pos: null })} />}
          <GoalBanner report={report} slot={review.slot} />
          <ReviewBody
            report={report}
            review={review}
            player={player}
            pos={posOverride}
            loading={loading}
            askSeq={askSeq}
            onParsed={async () => {
              const r = await load();
              if (r?.match.parsed) setNotice(L(UI.parsedReady));
            }}
          />
        </>
      ) : (
        <>
          <Lineup report={report} selected={selected} onPick={(s) => setParam({ p: String(s), pos: null })} />
          {report.timeline && <GoldTimeline report={report} review={null} />}
          <div className="cx-pick">
            <h2>{L(UI.pick)}</h2>
            <p>{L(UI.pickSub)}</p>
          </div>
        </>
      )}

      <AgentSnippets matchId={String(m.id)} />
    </Shell>
  );
};

const ErrorBlock: React.FC<{ text: string; onRetry?: () => void }> = ({ text, onRetry }) => {
  const { lang, L } = useLang();
  return (
    <div className="cx-error">
      <p>{text}</p>
      <div className="cx-error-actions">
        {onRetry && <button type="button" onClick={onRetry}>{L(UI.retry)}</button>}
        <Link to={`/?lang=${lang}`}>{L(UI.newMatch)}</Link>
      </div>
    </div>
  );
};

const Skeleton: React.FC<{ label: string }> = ({ label }) => (
  <div className="cx-skeleton" role="status" aria-live="polite">
    <span className="cx-pulse" />
    <p>{label}</p>
  </div>
);

/** Share links: `ref` tells the next visit how it arrived; the team link has no seat, so each teammate picks their own. */
export function shareLinks(origin: string, matchId: number, slot: number | null, lang: Lang, pos: number | null = null) {
  const team = new URLSearchParams({ ref: 'team' });
  const self = new URLSearchParams();
  if (slot != null) self.set('p', String(slot));
  // A corrected role changes the review itself: the personal link must show the same review.
  if (slot != null && pos != null && Number.isInteger(pos) && pos >= 1 && pos <= 5) self.set('pos', String(pos));
  self.set('ref', 'share');
  if (lang === 'zh') { team.set('lang', 'zh'); self.set('lang', 'zh'); }
  return { team: `${origin}/r/${matchId}?${team}`, self: `${origin}/r/${matchId}?${self}` };
}

function useShareActions(matchId: number, slot: number | null, pos: number | null) {
  const { lang, L } = useLang();
  const [copied, setCopied] = useState<'self' | 'team' | null>(null);
  const links = shareLinks(window.location.origin, matchId, slot, lang, pos);
  const flash = (which: 'self' | 'team') => { setCopied(which); setTimeout(() => setCopied(null), 1800); };
  const copy = (text: string, which: 'self' | 'team') => {
    void navigator.clipboard?.writeText(text).then(() => {
      flash(which);
      trackEvent('report_shared', { target: which, method: 'copy', matchId: String(matchId) });
    }).catch(() => {});
  };
  const shareTeam = () => {
    const text = L(UI.shareTeamText).replace('{id}', String(matchId));
    if (typeof navigator.share === 'function' && window.matchMedia?.('(pointer: coarse)').matches) {
      navigator.share({ text, url: links.team })
        .then(() => trackEvent('report_shared', { target: 'team', method: 'native', matchId: String(matchId) }))
        .catch(() => {});
      return;
    }
    copy(`${text} ${links.team}`, 'team');
  };
  return { copied, copySelf: () => copy(links.self, 'self'), shareTeam };
}

/** Compact sticky bar once a hero is picked: inline position override + match meta + share + quick ask. */
/**
 * The review's header: who (hero, role, result, K/D/A), the match line, and a
 * strip of all ten heroes to switch player. Two actions only: share, ask.
 */
const ReviewHeader: React.FC<{
  report: CoachReport;
  review: Review;
  player: Player;
  pos: number | null;
  onSetPos: (pos: number) => void;
  onPick: (slot: number) => void;
  rosterOpen: boolean;
  onToggleRoster: () => void;
  onAskClick: () => void;
}> = ({ report, review, player, pos, onSetPos, onPick, rosterOpen, onToggleRoster, onAskClick }) => {
  const { L } = useLang();
  const m = report.match;
  const [roleOpen, setRoleOpen] = useState(false);
  const { copied, copySelf, shareTeam } = useShareActions(m.id, review.slot, pos);
  const winner = m.radiant_win ? UI.radiant : UI.dire;
  const roleNote = review.role.source === 'user' ? UI.roleUser : review.role.source === 'lanes' ? UI.roleLanes : UI.roleInferred;
  const side = (radiant: boolean) => report.players.filter((p) => p.radiant === radiant);

  return (
    <header className="rv-head">
      <div className="rv-who">
        {player.hero.icon ? <SafeImg src={player.hero.icon} alt="" className="rv-who-icon" /> : <span className="rv-who-icon" />}
        <div className="rv-who-text">
          <div className="rv-who-row">
            <h1 className="rv-name">{L(player.hero)}</h1>
            <div className="cx-role-inline">
              <button type="button" className="rv-role" aria-expanded={roleOpen} onClick={() => setRoleOpen((v) => !v)}>
                {L(review.role.label)} ▾
              </button>
              {roleOpen && (
                <div className="cx-popover cx-role-pop" role="dialog" aria-label={L(UI.role)}>
                  <p className="cx-muted">{L(roleNote)}</p>
                  <p className="cx-muted cx-fix-label">{L(UI.fixRole)}</p>
                  <div className="cx-posrow">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button key={n} type="button" aria-pressed={review.role.pos === n} onClick={() => { onSetPos(n); setRoleOpen(false); }}>{n}</button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <span className={`rv-wl ${review.won ? 'is-win' : 'is-loss'}`}>{L(review.won ? UI.win : UI.loss)}</span>
            <span className="rv-kda">{player.kda.join('/')}</span>
          </div>
          <p className="rv-meta">
            <span>#{m.id}</span>
            <span className={m.radiant_win ? 'is-radiant' : 'is-dire'}>{L(winner)} {L(UI.victory)}</span>
            <span className="cx-score"><b className="r">{m.score[0]}</b>–<b className="d">{m.score[1]}</b></span>
            <span>{clock(m.duration)}</span>
            {m.patch && <span>{m.patch}</span>}
            {!m.parsed && <span className="cx-pill warn">{L(UI.needsParse)}</span>}
            {m.source === 'stratz' && <span className="cx-pill">{L(UI.fromStratz)}</span>}
            {m.source === 'steam_gc' && <span className="cx-pill">{L(UI.fromSteamGc)}</span>}
          </p>
        </div>
        <div className="rv-actions">
          <button type="button" className="cx-ghost" onClick={copySelf}>{copied === 'self' ? L(UI.copied) : L(UI.share)}</button>
          <button type="button" className="cx-ghost" onClick={shareTeam}>{copied === 'team' ? L(UI.teamCopied) : L(UI.shareTeam)}</button>
          <button type="button" className="rv-ask-btn cx-ctx-ask" onClick={onAskClick}>{L(UI.askQuick)}</button>
        </div>
      </div>
      <nav className="rv-strip" aria-label={L(RV.seats)}>
        {[true, false].map((radiant) => (
          <div key={String(radiant)} className={`rv-side ${radiant ? 'is-radiant' : 'is-dire'}`}>
            {side(radiant).map((p) => (
              <button key={p.slot} type="button" className={`rv-seat ${p.slot === review.slot ? 'is-on' : ''}`}
                aria-pressed={p.slot === review.slot} aria-label={`${L(p.hero)} ${p.kda.join('/')}`} title={`${L(p.hero)} ${p.kda.join('/')}`}
                onClick={() => onPick(p.slot)}>
                {p.hero.icon ? <SafeImg src={p.hero.icon} alt="" /> : <span className="rv-seat-blank" />}
              </button>
            ))}
          </div>
        ))}
        <button type="button" className="rv-roster-btn" aria-expanded={rosterOpen} onClick={onToggleRoster}>
          {L(rosterOpen ? UI.rosterCompact : UI.rosterExpand)}
        </button>
      </nav>
    </header>
  );
};

const MatchHeader: React.FC<{ report: CoachReport; slot: number | null; pos: number | null }> = ({ report, slot, pos }) => {
  const { L } = useLang();
  const m = report.match;
  const { copied, copySelf, shareTeam } = useShareActions(m.id, slot, pos);
  const date = m.start_time ? new Date(m.start_time * 1000).toLocaleDateString() : null;
  const winner = m.radiant_win ? UI.radiant : UI.dire;
  return (
    <header className="cx-match">
      <div>
        <p className="cx-eyebrow">#{m.id}{date ? ` · ${date}` : ''}</p>
        <h1 className={`cx-result ${m.radiant_win ? 'is-radiant' : 'is-dire'}`}>
          {L(winner)} {L(UI.victory)}
        </h1>
        <p className="cx-meta">
          <span className="cx-score"><b className="r">{m.score[0]}</b>–<b className="d">{m.score[1]}</b></span>
          <span>{clock(m.duration)}</span>
          {m.patch && <span>{m.patch}</span>}
          <span>{L(m.mode)}{m.ranked ? ` · ${L(UI.ranked)}` : ''}</span>
          <span className={`cx-pill ${m.parsed ? 'ok' : 'warn'}`}>{m.parsed ? L(UI.parsed) : L(UI.needsParse)}</span>
          {m.source === 'stratz' && <span className="cx-pill">{L(UI.fromStratz)}</span>}
            {m.source === 'steam_gc' && <span className="cx-pill">{L(UI.fromSteamGc)}</span>}
        </p>
      </div>
      <div className="cx-share">
        <button type="button" className="cx-share-team" onClick={shareTeam}>{copied === 'team' ? L(UI.teamCopied) : L(UI.shareTeam)}</button>
        {slot != null && (
          <button type="button" className="cx-ghost" onClick={copySelf}>{copied === 'self' ? L(UI.copied) : L(UI.share)}</button>
        )}
      </div>
    </header>
  );
};

const HeroImg: React.FC<{ hero: Player['hero']; size?: 'icon' | 'card' }> = ({ hero, size = 'card' }) => {
  const { lang } = useLang();
  const src = size === 'icon' ? hero.icon : hero.img;
  return src
    ? <img className={`cx-hero-img cx-hero-img--${size}`} src={src} alt={hero[lang]} loading="lazy" />
    : <span className={`cx-hero-img cx-hero-img--${size} cx-hero-img--blank`} aria-hidden="true" />;
};

const Lineup: React.FC<{ report: CoachReport; selected: number | null; compact?: boolean; onPick: (slot: number) => void }> = ({
  report,
  selected,
  compact = false,
  onPick,
}) => {
  const { L } = useLang();
  const side = (radiant: boolean) => report.players.filter((p) => p.radiant === radiant);
  return (
    <section className={`cx-lineup ${compact ? 'is-compact' : ''}`} aria-label={L(UI.pick)}>
      {[true, false].map((radiant) => (
        <div key={String(radiant)} className={`cx-team ${radiant ? 'is-radiant' : 'is-dire'}`}>
          <h3>{L(radiant ? UI.radiant : UI.dire)}{(radiant === report.match.radiant_win) ? ' ✓' : ''}</h3>
          <div className="cx-team-row">
            {side(radiant).map((p) => (
              <button
                key={p.slot} type="button" className={`cx-seat ${selected === p.slot ? 'is-on' : ''}`}
                aria-pressed={selected === p.slot} onClick={() => onPick(p.slot)}
              >
                <HeroImg hero={p.hero} />
                <span className="cx-seat-name">{L(p.hero)}</span>
                <span className="cx-seat-kda">{p.kda.join('/')}</span>
                <span className="cx-seat-nw">{k(p.net_worth)}</span>
                {p.items.length > 0 && (
                  <span className="cx-seat-items" aria-label={L(UI.items)}>
                    {p.items.map((it, i) => (it.img
                      ? <SafeImg key={`${it.key}-${i}`} src={it.img} alt={L(it)} title={L(it)} />
                      : <span key={`${it.key}-${i}`} className="cx-img-missing" title={L(it)} />))}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
};

const ResultPill: React.FC<{ r: string }> = ({ r }) => {
  const { L } = useLang();
  return <span className={`cx-goal-result is-${r}`}>{L(UI.goalResult[r])}</span>;
};

/** On a later game's review: did this game meet the goal? */
const GoalBanner: React.FC<{ report: CoachReport; slot: number }> = ({ report, slot }) => {
  const { L } = useLang();
  const goal = useActiveGoal();
  const [check, setCheck] = useState<GoalCheck | null>(null);
  useEffect(() => { setCheck(goal ? checkGoal(goal, report, slot) : null); }, [goal, report, slot]);
  if (!goal) return null;
  const here = goal.fromMatch === report.match.id;
  if (!here && !check) return null;
  const tl = tally(goal.id);
  return (
    <section className="cx-goal" aria-label={L(UI.goalCheckTitle)}>
      <p className="cx-eyebrow">{L(UI.goalCheckTitle)} · {L(UI.goalFrom).replace('{id}', String(goal.fromMatch))}</p>
      <p className="cx-goal-label"><b>{L(goal.goal.label)}</b>{check && <ResultPill r={check.result} />}</p>
      {check ? <p className="cx-goal-ev">{L(check.evidence)}</p> : <p className="cx-goal-ev">{L(UI.goalHere)}</p>}
      {tl.n > 0 && <p className="cx-goal-tally">{L(UI.goalTally).replace('{n}', String(tl.n)).replace('{met}', String(tl.met))}</p>}
    </section>
  );
};

const EvidenceRow: React.FC<{ evidence: Evidence[]; report: CoachReport }> = ({ evidence, report }) => {
  const { L } = useLang();
  const heroById = useMemo(() => new Map(report.players.map((p) => [p.hero.id, p.hero])), [report]);
  const itemByKey = useMemo(() => new Map(report.players.flatMap((p) => p.items).map((i) => [i.key, i])), [report]);
  return (
    <dl className="cx-evidence">
      {evidence.map((e, i) => (
        <div key={i} className="cx-ev">
          <dt>{L(e.k)}</dt>
          <dd>
            {e.v && <b>{e.v}</b>}
            {e.items && (
              <span className="cx-icons">
                {e.items.length === 0 ? '—' : e.items.map((key) => {
                  const it = itemByKey.get(key);
                  if (it?.img) return <img key={key} src={it.img} alt={L(it)} title={L(it)} />;
                  // Not in anyone's inventory (e.g. a pro counter item): the official icon by key;
                  // the row's label already names it, so the icon is decorative — never the raw key.
                  return <SafeImg key={key} src={itemIcon(key)} alt="" />;
                })}
              </span>
            )}
            {e.heroes && (
              <span className="cx-icons">
                {e.heroes.map((id) => {
                  const h = heroById.get(id);
                  return h?.icon ? <img key={id} src={h.icon} alt={L(h)} title={L(h)} className="is-hero" /> : null;
                })}
              </span>
            )}
            {e.sub && <small>{L(e.sub)}</small>}
          </dd>
        </div>
      ))}
    </dl>
  );
};

/* ------------------------------------------------------------------ cards */

/** `dota-coach-ui/2` as typed here (lib/coach/cards.js is plain JS). */
type CardAction =
  | { action: 'inspect'; label: Bi; target: 'laning' | 'deaths' | 'items' | 'fights' | 'story'; row?: number }
  | { action: 'ask'; label: Bi; question: Bi }
  | { action: 'save_goal'; label: Bi; goal: object }
  | { action: 'parse'; label: Bi }
  | { action: 'compare'; label: Bi; hero: number; vs: number }
  | { action: 'open_cases'; label: Bi; theme: string };
interface Card {
  id: string; component: string; title: Bi; authority: 'fact' | 'inference' | 'statistic'; tone: 'good' | 'fix' | 'neutral';
  data: Record<string, unknown>; actions: CardAction[]; evidence: Evidence[];
}

const CARD_UI = {
  authority: {
    fact: { en: 'Match data', zh: '比赛数据' },
    inference: { en: 'Coach read', zh: '教练判断' },
    statistic: { en: 'Statistics', zh: '统计' },
  },
  compareTitle: { en: 'Matchup', zh: '对位' },
  casesTitle: { en: 'Pro games on the same problem', zh: '同问题的职业对局' },
  close: { en: 'Close', zh: '关闭' },
  loadFailed: { en: 'Could not load this. Try again.', zh: '加载失败，请重试。' },
};

const cardDom = (id: string) => `card-${id.replace(/[^a-z0-9_-]/gi, '-')}`;

/** One card's frame: eyebrow (what backs it), title, body, action bar. */
/** Hero vs hero lines for a compare action (pro + your bracket). */
const CompareCard: React.FC<{ hero: number; vs: number; rank: string | null; onClose: () => void }> = ({ hero, vs, rank, onClose }) => {
  const { lang, L } = useLang();
  const [lines, setLines] = useState<{ en: string[]; zh: string[] } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const ac = new AbortController();
    setLines(null); setFailed(false);
    fetchMatchup(hero, vs, rank, ac.signal).then((b) => setLines(b.lines)).catch((e) => { if ((e as Error).name !== 'AbortError') setFailed(true); });
    return () => ac.abort();
  }, [hero, vs, rank]);
  return (
    <section className="cxv-card is-neutral is-compare" aria-label={L(CARD_UI.compareTitle)}>
      <header className="cxv-card-head">
        <span className="cxv-auth is-statistic">{L(CARD_UI.authority.statistic)}</span>
        <h3>{L(CARD_UI.compareTitle)}</h3>
        <button type="button" className="cxv-x" onClick={onClose} aria-label={L(CARD_UI.close)}>×</button>
      </header>
      <div className="cxv-card-body">
        {failed ? <p className="cx-muted">{L(CARD_UI.loadFailed)}</p>
          : !lines ? <p className="cx-muted">…</p>
            : <ul className="cxv-lines">{lines[lang].map((x, i) => <li key={i}>{x}</li>)}</ul>}
      </div>
    </section>
  );
};

type SectionKey = 'story' | 'laning' | 'deaths' | 'items' | 'fights';
const SECTION_ORDER: SectionKey[] = ['story', 'laning', 'deaths', 'items', 'fights'];
const SECTION_COMPONENT: Record<SectionKey, string> = { story: 'Story', laning: 'Lane', deaths: 'Deaths', items: 'Items', fights: 'Fights' };

const RV = {
  next: { en: 'Next game, do just these', zh: '下一局只做这几件事' },
  nextFew: { en: 'What to change next game', zh: '下一局要改的' },
  detail: { en: 'The detail, area by area', zh: '分项细节' },
  findings: { en: 'Findings', zh: '发现' },
  more: { en: 'Other findings', zh: '其他发现' },
  seats: { en: 'Switch player', zh: '切换玩家' },
  gaps: { en: 'What this data cannot show', zh: '这份数据看不到的' },
  matchups: { en: 'Your hero vs theirs', zh: '你的英雄对上他们' },
  compare: { en: 'Compare', zh: '对比' },
};

/** A finding's "make it my next-game goal" (only fixes of this player's own, with a checkable goal). */
const GoalButton: React.FC<{ f: Finding; report: CoachReport; slot: number }> = ({ f, report, slot }) => {
  const { L } = useLang();
  const active = useActiveGoal();
  const candidate = f.goal && f.tone === 'fix' && !f.shared ? goalFromFinding(report, slot, f.id, f.goal, f.action) : null;
  if (!candidate) return null;
  return active?.id === candidate.id ? (
    <p className="cx-goal-set">
      <span>✓ {L(UI.goalSet)}：{L(candidate.goal.label)}</span>
      <button type="button" className="cx-linkbtn" onClick={() => setGoal(null)}>{L(UI.goalClear)}</button>
    </p>
  ) : (
    <button type="button" className="cx-goal-btn" onClick={() => setGoal(candidate)}>
      {L(UI.setGoal)}<span>{L(candidate.goal.label)}</span>
    </button>
  );
};

/** One finding inside its area: what happened, what to do, the numbers behind it. */
const FindingBlock: React.FC<{ card: Card; report: CoachReport; onAsk: () => void; onCases?: () => void }> = ({ card, report, onAsk, onCases }) => {
  const { L } = useLang();
  const f = card.data.finding as Finding;
  // The engine's own action labels (dota-coach-ui/2), not page copy.
  const label = (kind: CardAction['action'], fallback: Bi) => L(card.actions.find((x) => x.action === kind)?.label ?? fallback);
  return (
    <article className={`rv-finding tone-${f.tone}`} id={cardDom(card.id)}>
      <h4>{L(f.title)}</h4>
      {f.tone === 'fix' && <p className="rv-do"><b>{L(UI.doNext)}</b> {L(f.action ?? f.ask)}</p>}
      <p className="rv-body">{L(f.body)}</p>
      {f.evidence?.length > 0 && <EvidenceRow evidence={f.evidence} report={report} />}
      {f.caveat && <p className="cx-caveat">{L(f.caveat)}</p>}
      <div className="rv-row-actions">
        <button type="button" className="cx-linkbtn" onClick={onAsk}>{label('ask', UI.askQuick)}</button>
        {onCases && <button type="button" className="cx-linkbtn" onClick={onCases}>{label('open_cases', CARD_UI.casesTitle)}</button>}
      </div>
    </article>
  );
};

/**
 * The review, from the engine's card surface (dota-coach-ui/2), laid out for
 * reading: the verdict, the few things to do next game, then each area as a
 * one-line summary you open when you want the detail. Ask the coach sits
 * beside (wide screens) or below. Nothing is said twice on the first screen.
 */
const ReviewBody: React.FC<{
  report: CoachReport; review: Review; player: Player; pos: number | null; loading: boolean; askSeq: number;
  onParsed: () => Promise<void>;
}> = ({ report, review, player, pos, loading, askSeq, onParsed }) => {
  const { lang, L } = useLang();
  const askRef = useRef<AskHandle>(null);
  const railRef = useRef<HTMLElement>(null);
  const surface = useMemo(() => buildSurface(report, review.slot) as { cards: Card[] } | null, [report, review.slot]);
  const heroById = useMemo(() => new Map(report.players.map((p) => [p.hero.id, p.hero])), [report]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [jump, setJump] = useState<{ target: string; row: number | null; seq: number } | null>(null);
  const [compare, setCompare] = useState<{ hero: number; vs: number } | null>(null);
  const [cases, setCases] = useState<{ theme: string; seq: number } | null>(null);
  // Per-match/player state resets when either changes. The body stays mounted, so a pending
  // replay parse keeps polling (its panel is in the same place for every player).
  useEffect(() => { setJump(null); setCompare(null); setCases(null); setOpen(new Set()); }, [report.match.id, review.slot, pos]);
  useEffect(() => {
    if (!cases) return undefined;
    const timer = setTimeout(() => jumpToCases(cases.theme), 0);
    return () => clearTimeout(timer);
  }, [cases]);
  useEffect(() => { if (askSeq > 0) openAsk(); }, [askSeq]);
  // A jump to a row opens its area and reopens the row's data disclosure (the user may have collapsed it).
  useEffect(() => {
    if (!jump) return undefined;
    const timer = setTimeout(() => {
      if (jump.row != null && (jump.target === 'deaths' || jump.target === 'fights')) revealRow(`cx-${jump.target === 'deaths' ? 'death' : 'fight'}-row-${jump.row}`);
      else document.getElementById(`rv-sec-${jump.target}`)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    }, 0);
    return () => clearTimeout(timer);
  }, [jump]);

  if (!surface) return null;
  const cards = surface.cards;
  const card = (component: string) => cards.find((c) => c.component === component);
  const has = (component: string) => Boolean(card(component));
  const findings = cards.filter((c) => c.component === 'Finding');
  const targetOf = (c: Card) => (c.actions.find((a) => a.action === 'inspect') as Extract<CardAction, { action: 'inspect' }> | undefined)?.target;

  const openAsk = (then: () => void = () => askRef.current?.focus()) => {
    railRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    setTimeout(then, 0);
  };
  const ask = (q: Bi, from?: Card) => openAsk(() => askRef.current?.prefill(L(q), from ? L(from.title) : undefined));
  const askOf = (c: Card | undefined) => () => {
    const q = c?.actions.find((x) => x.action === 'ask') as Extract<CardAction, { action: 'ask' }> | undefined;
    if (q) ask(q.question, c); else openAsk();
  };
  const casesOf = (c: Card) => {
    const a = c.actions.find((x) => x.action === 'open_cases') as Extract<CardAction, { action: 'open_cases' }> | undefined;
    return a ? () => setCases({ theme: a.theme, seq: Date.now() }) : undefined;
  };
  const setSection = (key: string, isOpen: boolean) => setOpen((prev) => {
    if (prev.has(key) === isOpen) return prev;
    const next = new Set(prev);
    if (isOpen) next.add(key); else next.delete(key);
    return next;
  });
  const inspect = (target: SectionKey, row: number | null = null) => {
    setSection(target, true);
    setJump({ target, row, seq: Date.now() });
  };

  // The few things to do next game: the engine's plan; on an unparsed match (no plan) its fixes.
  const plan = (card('Plan')?.data.plan as { key: string; title: Bi; check: Bi }[] | undefined) ?? [];
  const fixes = findings.map((c) => c.data.finding as Finding).filter((f) => f.tone === 'fix');
  const things = plan.length ? plan.map((p) => ({ title: p.title, text: p.check }))
    : fixes.slice(0, 3).map((f) => ({ title: f.title, text: f.action ?? f.ask }));
  const goalFindings = fixes.filter((f) => f.goal && !f.shared);

  const sections = SECTION_ORDER.filter((key) => cards.some((c) => c.id === `chapter:${key}`));
  const orphans = findings.filter((c) => { const t = targetOf(c); return !t || !sections.includes(t as SectionKey); });
  const matchups = card('Matchups');
  const gaps = card('DataGaps');
  const parsed = report.match.parsed;

  const compareBar = matchups && (
    <div className="rv-compare">
      {!has('Lane') && <Matchups list={matchups.data.list as never} heroById={heroById} since={matchups.data.since as never} bracket={matchups.data.bracket as never} rankSource={(matchups.data.rank_source ?? undefined) as never} />}
      <div className="rv-row-actions">
        {matchups.actions.filter((a) => a.action === 'compare').map((a, i) => {
          const c = a as Extract<CardAction, { action: 'compare' }>;
          return (
            <button key={i} type="button" className="rv-compare-btn" aria-pressed={compare?.vs === c.vs} onClick={() => setCompare({ hero: c.hero, vs: c.vs })}>
              {L(a.label)} · {heroById.get(c.vs)?.[lang] ?? ''}
            </button>
          );
        })}
      </div>
      {compare && <CompareCard hero={compare.hero} vs={compare.vs} rank={review.bracket?.key ?? null} onClose={() => setCompare(null)} />}
    </div>
  );

  const chapterBody = (key: SectionKey, c: Card) => {
    const d = c.data as Record<string, any>;
    switch (key) {
      case 'story': return (
        <>
          {report.timeline && (
            <GoldTimeline report={report} review={review}
              onSelectDeath={sections.includes('deaths') ? (i) => inspect('deaths', i) : undefined}
              onSelectFight={sections.includes('fights') ? (i) => inspect('fights', i) : undefined} />
          )}
          <StoryChapter ch={d.chapter} onAsk={askOf(c)} withCases={parsed} onOpenCase={(theme) => setCases({ theme, seq: Date.now() })} />
        </>
      );
      case 'laning': return (
        <>
          <LaningChapter ch={d.chapter} heroById={heroById} slot={review.slot} onAsk={askOf(c)} defaultOpen
            matchups={review.matchups} since={report.baselines?.since ?? null} bracket={review.bracket} rankSource={report.baselines?.rank} />
          {compareBar}
        </>
      );
      case 'deaths': return <DeathsChapter ch={d.chapter} heroById={heroById} onAsk={askOf(c)} defaultOpen
        highlightIndex={jump?.target === 'deaths' ? jump.row : null} jumpSeq={jump?.target === 'deaths' ? jump.seq : undefined} />;
      case 'items': return <ItemsChapter ch={d.chapter} heroById={heroById} onAsk={askOf(c)} counterItems={review.counter_items} myHero={player.hero} since={report.baselines?.since ?? null} />;
      case 'fights': return <FightsChapter ch={d.chapter} onAsk={askOf(c)} defaultOpen
        highlightIndex={jump?.target === 'fights' ? jump.row : null} jumpSeq={jump?.target === 'fights' ? jump.seq : undefined} />;
      default: return null;
    }
  };

  const parsePanel = gaps && <ParsePanel key="parse" report={report} priority={!parsed} onParsed={onParsed} lang={lang} />;

  return (
    <div className={`rv ${loading ? 'is-loading' : ''}`}>
      <div className="rv-main">
        <section className="rv-verdict" aria-label={L(UI.verdictEyebrow)}>
          <h2 className="rv-headline">{L(review.headline)}</h2>
        </section>

        {/* Unparsed: getting the replay parsed is the next step, before anything else. */}
        {!parsed && parsePanel}

        {things.length > 0 && (
          <section className="rv-next" id="cx-ch-plan" aria-labelledby="rv-next-h">
            <h2 id="rv-next-h" className="rv-h2">{L(things.length > 1 ? RV.next : RV.nextFew)}</h2>
            <ol className="rv-things">
              {things.map((p, i) => (
                <li key={i}>
                  <span className="rv-num" aria-hidden="true">{i + 1}</span>
                  <div>
                    <h3>{L(p.title)}</h3>
                    <p><Emph text={L(p.text)} /></p>
                  </div>
                </li>
              ))}
            </ol>
            {goalFindings.length > 0 && (
              <div className="rv-goals">{goalFindings.map((f) => <GoalButton key={f.id} f={f} report={report} slot={review.slot} />)}</div>
            )}
          </section>
        )}

        {sections.length > 0 && (
          <section className="rv-sections" aria-labelledby="rv-sec-h">
            <h2 id="rv-sec-h" className="rv-h2">{L(RV.detail)}</h2>
            {sections.map((key) => {
              const c = cards.find((x) => x.id === `chapter:${key}`)!;
              const ch = (c.data as { chapter: { takeaway: Bi } }).chapter;
              const mine = findings.filter((x) => targetOf(x) === key);
              return (
                <details key={key} id={`rv-sec-${key}`} className={`rv-sec is-${SECTION_COMPONENT[key].toLowerCase()}`} open={open.has(key)}
                  onToggle={(e) => setSection(key, (e.currentTarget as HTMLDetailsElement).open)}>
                  <summary>
                    <span className="rv-sec-title">{L(c.title)}</span>
                    <span className="rv-sec-take"><Emph text={L(ch.takeaway)} /></span>
                    {mine.some((x) => x.tone === 'fix') && <span className="rv-flag">{L(RV.findings)} {mine.length}</span>}
                  </summary>
                  <div className="rv-sec-body">
                    {mine.map((x) => <FindingBlock key={x.id} card={x} report={report} onAsk={askOf(x)} onCases={casesOf(x)} />)}
                    {chapterBody(key, c)}
                  </div>
                </details>
              );
            })}
          </section>
        )}

        {/* No area for them (an unparsed match has none): listed on their own, open when they are all there is. */}
        {(orphans.length > 0 || (matchups && !sections.includes('laning'))) && (
          <details className="rv-sec is-more" open={sections.length === 0 || open.has('more')}
            onToggle={(e) => setSection('more', (e.currentTarget as HTMLDetailsElement).open)}>
            <summary>
              <span className="rv-sec-title">{L(sections.length ? RV.more : RV.findings)}</span>
              <span className="rv-sec-take">{orphans.map((x) => L(x.title)).join(' · ')}</span>
            </summary>
            <div className="rv-sec-body">
              {orphans.map((x) => <FindingBlock key={x.id} card={x} report={report} onAsk={askOf(x)} onCases={casesOf(x)} />)}
              {!sections.includes('laning') && compareBar}
            </div>
          </details>
        )}

        {cases && parsed && (
          <section className="rv-cases" aria-label={L(CARD_UI.casesTitle)}>
            <div className="rv-cases-head">
              <h2 className="rv-h2">{L(CARD_UI.casesTitle)}</h2>
              <button type="button" className="cxv-x" onClick={() => setCases(null)} aria-label={L(CARD_UI.close)}>×</button>
            </div>
            <Cases matchId={String(report.match.id)} slot={review.slot} pos={pos} onAsk={() => openAsk()} />
          </section>
        )}

        {parsed && gaps && (
          <details className="rv-sec is-gaps">
            <summary><span className="rv-sec-title">{L(RV.gaps)}</span><span className="rv-sec-take">{(report.data_gaps ?? []).length}</span></summary>
            <div className="rv-sec-body">{parsePanel}</div>
          </details>
        )}
      </div>

      <aside className="rv-rail" ref={railRef} aria-label={L(UI.askQuick)}>
        <AskPanel key={`${report.match.id}-${review.slot}-${pos ?? ''}`} ref={askRef} report={report} review={review} pos={pos} docked />
      </aside>
    </div>
  );
};

const ParsePanel: React.FC<{ report: CoachReport; onParsed: () => Promise<void>; lang: Lang; priority?: boolean }> = ({
  report,
  onParsed,
  lang,
  priority = false,
}) => {
  const { L } = useLang();
  const [state, setState] = useState<'idle' | 'pending' | 'throttled' | 'failed' | 'gaveup'>('idle');
  const timer = useRef<number | null>(null);
  // Always call the latest callback: the user may change seat or position
  // while a parse is pending, and completion must reload *that* view.
  const onParsedRef = useRef(onParsed);
  onParsedRef.current = onParsed;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) window.clearInterval(timer.current);
    };
  }, []);
  const start = async () => {
    setState('pending');
    let res;
    try {
      res = await requestParse(String(report.match.id), lang);
    } catch {
      setState('failed');  // network error: keep the button so the user can retry
      return;
    }
    if (res.status === 'parsed') { await onParsedRef.current(); return; }
    if (res.status === 'throttled') { setState('throttled'); return; }
    if (res.status === 'failed') { setState('failed'); return; }
    // The user may have left while the request was in flight.
    if (!mounted.current) return;
    const began = Date.now();
    timer.current = window.setInterval(async () => {
      if (Date.now() - began > 10 * 60_000) {
        if (timer.current) window.clearInterval(timer.current);
        setState('gaveup');
        return;
      }
      try {
        const r = await fetchCoachReport(String(report.match.id));
        if (r.match.parsed) {
          if (timer.current) window.clearInterval(timer.current);
          await onParsedRef.current();
        }
      } catch { /* keep polling */ }
    }, 20_000);
  };
  const msg = { pending: UI.parsePending, throttled: UI.parseThrottled, failed: UI.parseFailed, gaveup: UI.parseGaveUp }[state as 'pending'];
  return (
    <section className={`cx-gaps ${priority ? 'cx-gaps--priority' : ''}`}>
      <div className="cx-gaps-top">
        <div>
          <h3>{L(report.match.parsed ? UI.partialGaps : UI.cantSee)}</h3>
          {!report.match.parsed && <p className="cx-muted">{L(UI.cantSeeSub)}</p>}
        </div>
        {!report.match.parsed && report.match.replay_available && state !== 'pending' && (
          <button type="button" className="cx-primary" onClick={() => void start()}>{L(UI.parseBtn)}</button>
        )}
      </div>
      <ul>{report.data_gaps.map((g, i) => <li key={i}>{L(g)}</li>)}</ul>
      {msg && <p className="cx-notice" role="status">{L(msg)}</p>}
    </section>
  );
};
