import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { parseMatchInput } from '../v2/parseMatchInput';
import { CoachApiError, fetchCoachReport, fetchMatchup, fetchRecentMatches, requestParse } from './api';
import { markReviewed, markSeen, parseAccountInput, rememberAccount, rememberedAccount, reviewedMatches, seenUntil } from './accountInput';
import type { Bi, CoachReport, Evidence, Finding, Player, RecentMatch, RecentMatches, Review } from './types';
import { SafeImg, clock, k, useLang, type Lang } from './ui';
import { Chapters, jumpToCases, revealRow, Deaths as DeathsChapter, Fights as FightsChapter, Items as ItemsChapter, Laning as LaningChapter, Matchups, Plan as PlanChapter, Story as StoryChapter, type ChapterJumpSignal } from './Chapters';
import { Cases } from './Cases';
import { buildSurface } from '../../lib/coach/cards.js';
import { GoldTimeline } from './GoldTimeline';
import { QuickJump, detectSmartInput } from './QuickJump';
import { AskPanel, type AskHandle } from './AskPanel';
import { CURRENT_PATCH, itemIcon } from './patch';
import { trackEvent, trackReviewViewed } from '../services/analytics';
import { activeGoal, checkGoal, goalChecks, goalFromFinding, setGoal, useActiveGoal, type GoalCheck } from './goalStore';
import './coach.css';
import './cards.css';

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
  rosterCompact: { en: 'Compact strip', zh: '收起为紧凑条' },
  askQuick: { en: 'Ask coach', zh: '追问教练' },
  verdictEyebrow: { en: 'Biggest lever', zh: '本局核心结论' },
  vitalLane: { en: 'Lane', zh: '对线' },
  vitalDeaths: { en: 'Deaths', zh: '死亡' },
  vitalDamage: { en: 'Damage taken', zh: '主承伤' },
  vitalFights: { en: 'Fights', zh: '团战' },
  vitalGpm: { en: 'GPM', zh: '每分钟经济' },
  vitalDmg: { en: 'Hero dmg', zh: '英雄伤害' },
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
  fromStratz: { en: 'Data from STRATZ (OpenDota unavailable)', zh: '数据来自 STRATZ（OpenDota 暂不可用）' },
  copied: { en: 'Copied', zh: '已复制' },
} satisfies Record<string, Bi | Record<string, Bi>>;

const AREA: Record<Finding['area'], Bi> = {
  items: { en: 'Items', zh: '出装' }, farm: { en: 'Farm', zh: '发育' }, deaths: { en: 'Deaths', zh: '死亡' },
  fights: { en: 'Fights', zh: '团战' }, objectives: { en: 'Objectives', zh: '目标' }, team: { en: 'Team', zh: '全队' },
  laning: { en: 'Laning', zh: '对线' }, vision: { en: 'Vision', zh: '视野' },
};

const BENCH: { key: string; label: Bi; invert?: boolean }[] = [
  { key: 'gold_per_min', label: { en: 'Gold / min', zh: '每分钟经济' } },
  { key: 'xp_per_min', label: { en: 'XP / min', zh: '每分钟经验' } },
  { key: 'last_hits_per_min', label: { en: 'Last hits / min', zh: '每分钟正补' } },
  { key: 'hero_damage_per_min', label: { en: 'Hero damage / min', zh: '每分钟英雄伤害' } },
  { key: 'deaths_per_min', label: { en: 'Staying alive', zh: '存活' }, invert: true },
  { key: 'tower_damage', label: { en: 'Tower damage', zh: '建筑伤害' } },
];

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
            <span className="cx-recent-kda">{latest.kda.join('/')}</span>
            {reviewed && <span className="cx-tag">{L(UI.reviewedTag)}</span>}
          </span>
          <Link to={`/r/${latest.match_id}?p=${latest.slot}&lang=${lang}`} className="cx-patch-cta cx-latest-cta">{L(UI.latestCta)}</Link>
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
      .then((r) => setCheck(checkGoal(goal, r, latest.slot)))
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

  const checkByMatch = useMemo(() => {
    // Goal results belong to the goal's player: never show them on another account's games.
    if (!goal || (goal.accountId != null && String(goal.accountId) !== accountId)) return new Map<number, GoalCheck>();
    return new Map(goalChecks(goal.id).map((c) => [c.matchId, c]));
  }, [goal, accountId]);

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

        {goal && (
          <div className="cx-goal cx-recent-goal">
            <div className="cx-recent-goal-top">
              <div>
                <p className="cx-eyebrow">{L(UI.goalCheckTitle)} · {L(UI.goalFrom).replace('{id}', String(goal.fromMatch))}</p>
                <p className="cx-goal-label"><b>{L(goal.goal.label)}</b></p>
                {tl && tl.n > 0 && <p className="cx-goal-tally">{L(UI.goalTally).replace('{n}', String(tl.n)).replace('{met}', String(tl.met))}</p>}
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
                      <Link to={`/r/${m.match_id}?p=${m.slot}&lang=${lang}`} className="cx-recent-row">
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
                        <span className="cx-recent-kda">{m.kda.join('/')}</span>
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

const PatchNews: React.FC<{ onCta: () => void }> = ({ onCta }) => {
  const { lang, L } = useLang();
  const p = CURRENT_PATCH;
  const v = (b: Bi) => L(b).replace('{v}', p.version);
  return (
    <section className="cx-patch" aria-labelledby="cx-patch-title">
      <div className="cx-patch-top">
        <div className="cx-patch-head">
          <p className="cx-eyebrow">{L(UI.patchEyebrow)} · <time dateTime={p.date}>{p.date}</time></p>
          <h2 id="cx-patch-title">{v(UI.patchTitle)}</h2>
        </div>
        <div className="cx-patch-actions">
          <button type="button" className="cx-patch-cta" onClick={onCta}>{v(UI.patchCta)}</button>
          <a href={p.notesUrl} target="_blank" rel="noreferrer">{L(UI.patchNotes)} ↗</a>
        </div>
      </div>
      <div className="cx-patch-items">
        <span className="cx-patch-label">{L(UI.patchNewItems)}</span>
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
      <details className="cx-patch-details">
        <summary>{L(UI.patchMore)}</summary>
        <ul className="cx-patch-list">
          {p.highlights.map((h, i) => <li key={i}>{L(h)}</li>)}
        </ul>
        <p className="cx-patch-coach"><strong>{L(UI.patchForCoach)}</strong> {L(p.forCoach)}</p>
      </details>
    </section>
  );
};

const AgentSnippets: React.FC<{ matchId: string }> = ({ matchId }) => {
  const { L } = useLang();
  const [tab, setTab] = useState<'cli' | 'http' | 'mcp'>('cli');
  const code = {
    cli: `node packages/cli/bin/dota2ai.js coach ${matchId} --hero tidehunter --section why\nnode packages/cli/bin/dota2ai.js coach ${matchId} --hero spectre --lang zh`,
    http: `curl https://dota2.ai/api/coach/${matchId}\ncurl https://dota2.ai/llms.txt`,
    mcp: `node packages/mcp/bin/dota2ai-mcp.js\n# Tools: coach_recent, coach_report, coach_cases, coach_ask, coach_goal_check`,
  }[tab];
  return (
    <details className="cx-api cx-api-drawer">
      <summary>{L(UI.api)}</summary>
      <div className="cx-api-tabs" role="tablist" aria-label={L(UI.api)}>
        {(['cli', 'http', 'mcp'] as const).map((kTab) => (
          <button key={kTab} type="button" role="tab" aria-selected={tab === kTab} className={tab === kTab ? 'is-on' : ''} onClick={() => setTab(kTab)}>
            {kTab.toUpperCase()}
          </button>
        ))}
      </div>
      <pre><code>{code}</code></pre>
    </details>
  );
};

/** The example match's three seats, with facts from that match (the fixture behind every sample link). */
const SAMPLE_CARDS: { slot: number; slug: string; hero: Bi; role: Bi; kda: string; lane: Bi }[] = [
  { slot: 0, slug: 'tidehunter', hero: { en: 'Tidehunter', zh: '潮汐猎人' }, role: { en: 'Pos 3 · offlane', zh: '3 号位 · 劣势路' }, kda: '6/12/15', lane: { en: 'Lost the lane to Ursa', zh: '对线输给熊战士' } },
  { slot: 2, slug: 'warlock', hero: { en: 'Warlock', zh: '术士' }, role: { en: 'Pos 5 · support', zh: '5 号位 · 辅助' }, kda: '4/14/19', lane: { en: 'Against Dawnbreaker', zh: '对线破晓辰星' } },
  { slot: 4, slug: 'spectre', hero: { en: 'Spectre', zh: '幽鬼' }, role: { en: 'Pos 1 · carry', zh: '1 号位 · 优势路' }, kda: '12/15/9', lane: { en: 'Farm fell behind', zh: '经济落后' } },
];
const HERO_ART = (slug: string) => `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/${slug}.png`;

const HOME = {
  title: { en: 'Paste a match.', zh: '贴一场比赛。' },
  sub: { en: 'Match ID, a match link or your friend code. See where the game was lost — and what to practise next.', zh: '比赛 ID、对局链接或好友码。看清这局输在哪，下一局练什么。' },
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

  // The river lights up once the box holds something we can open (the page's one memorable moment).
  const state = detected.kind === 'match' || detected.kind === 'account' ? detected.kind : 'idle';

  return (
    <Shell isHome>
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

      <section className="hm-samples" aria-labelledby="hm-samples-title">
        <div className="hm-samples-head">
          <h2 id="hm-samples-title">{L(HOME.samplesTitle)}</h2>
          <span>{L(HOME.samplesSub).replace('{id}', EXAMPLE_MATCH)}</span>
        </div>
        <ul>
          {SAMPLE_CARDS.map((c) => (
            <li key={c.slot}>
              <Link to={`/r/${EXAMPLE_MATCH}?p=${c.slot}&lang=${lang}`} className="hm-sample">
                <SafeImg src={HERO_ART(c.slug)} alt="" className="hm-sample-art" />
                <span className="hm-sample-text">
                  <b>{L(c.hero)}</b>
                  <small>{L(c.role)} · {c.kda}</small>
                  <span>{L(c.lane)}</span>
                </span>
                <span className="hm-sample-go" aria-hidden="true">→</span>
                <span className="cx-sr">{L(HOME.open)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <PatchNews onCta={() => { inputRef.current?.focus(); inputRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); }} />

      <section className="cx-principles hm-how">
        {[['p1t', 'p1'], ['p2t', 'p2'], ['p3t', 'p3']].map(([tk, bk], i) => (
          <div key={tk} className="hm-how-item">
            <span className="cx-num">0{i + 1}</span>
            <h2>{L(UI[tk as 'p1t'])}</h2>
            <p>{L(UI[bk as 'p1'])}</p>
          </div>
        ))}
      </section>
      <AgentSnippets matchId={EXAMPLE_MATCH} />
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
        <StickyContextBar
          report={report}
          review={review}
          player={player}
          pos={posOverride}
          onSetPos={(pos) => setParam({ pos: String(pos) })}
          rosterExpanded={rosterExpanded}
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

      <Lineup
        report={report}
        selected={selected}
        compact={selected != null && !rosterExpanded}
        onPick={(s) => setParam({ p: String(s), pos: null })}
      />

      {review && <GoalBanner report={report} slot={review.slot} />}

      {review && player ? (
        <CardFeed
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
      ) : (
        <>
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
const StickyContextBar: React.FC<{
  report: CoachReport;
  review: Review;
  player: Player;
  pos: number | null;
  onSetPos: (pos: number) => void;
  rosterExpanded: boolean;
  onToggleRoster: () => void;
  onAskClick: () => void;
}> = ({ report, review, player, pos, onSetPos, rosterExpanded, onToggleRoster, onAskClick }) => {
  const { L } = useLang();
  const m = report.match;
  const [roleOpen, setRoleOpen] = useState(false);
  const { copied, copySelf, shareTeam } = useShareActions(m.id, review.slot, pos);
  const winner = m.radiant_win ? UI.radiant : UI.dire;
  const roleNote = review.role.source === 'user' ? UI.roleUser : review.role.source === 'lanes' ? UI.roleLanes : UI.roleInferred;

  return (
    <header className="cx-ctxbar">
      <div className="cx-ctxbar-hero">
        {player.hero.icon ? <SafeImg src={player.hero.icon} alt="" className="cx-ctxbar-icon" /> : <span className="cx-ctxbar-icon" />}
        <div className="cx-ctxbar-id">
          <div className="cx-ctxbar-name-row">
            <h1 className="cx-ctxbar-name">{L(player.hero)}</h1>
            <div className="cx-role-inline">
              <button
                type="button"
                className="cx-role-trigger"
                aria-expanded={roleOpen}
                onClick={() => setRoleOpen((v) => !v)}
              >
                {L(review.role.label)} ▾
              </button>
              {roleOpen && (
                <div className="cx-popover cx-role-pop" role="dialog" aria-label={L(UI.role)}>
                  <p className="cx-muted">{L(roleNote)}</p>
                  <p className="cx-muted cx-fix-label">{L(UI.fixRole)}</p>
                  <div className="cx-posrow">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button
                        key={n}
                        type="button"
                        aria-pressed={review.role.pos === n}
                        onClick={() => { onSetPos(n); setRoleOpen(false); }}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <span className={`cx-ctxbar-wl ${review.won ? 'is-win' : 'is-loss'}`}>{L(review.won ? UI.win : UI.loss)}</span>
            <span className="cx-ctxbar-kda">{player.kda.join('/')}</span>
          </div>
          <p className="cx-meta cx-ctxbar-meta">
            <span>#{m.id}</span>
            <span className={m.radiant_win ? 'is-radiant' : 'is-dire'}>{L(winner)} {L(UI.victory)}</span>
            <span className="cx-score"><b className="r">{m.score[0]}</b>–<b className="d">{m.score[1]}</b></span>
            <span>{clock(m.duration)}</span>
            {m.patch && <span>{m.patch}</span>}
            <span className={`cx-pill ${m.parsed ? 'ok' : 'warn'}`}>{m.parsed ? L(UI.parsed) : L(UI.needsParse)}</span>
            {m.source === 'stratz' && <span className="cx-pill">{L(UI.fromStratz)}</span>}
          </p>
        </div>
      </div>

      <div className="cx-share">
        <button type="button" className="cx-ghost" aria-expanded={rosterExpanded} onClick={onToggleRoster}>
          {L(rosterExpanded ? UI.rosterCompact : UI.rosterExpand)}
        </button>
        <button type="button" className="cx-ghost" onClick={copySelf}>{copied === 'self' ? L(UI.copied) : L(UI.share)}</button>
        <button type="button" className="cx-share-team" onClick={shareTeam}>{copied === 'team' ? L(UI.teamCopied) : L(UI.shareTeam)}</button>
        <button type="button" className="cx-ghost cx-ctx-ask" onClick={onAskClick}>✦ {L(UI.askQuick)}</button>
      </div>
    </header>
  );
};

/** Above-the-fold verdict summary: surfaces the headline + 4 key vitals right at the top. */
const VerdictHero: React.FC<{ review: Review; player: Player; loading: boolean }> = ({ review, player, loading }) => {
  const { L } = useLang();
  const ch = review.chapters;
  const vitals: { label: Bi; value: string; tone?: 'good' | 'bad' | 'warn' }[] = [];

  if (ch?.laning) {
    const tone = ch.laning.outcome === 'won' || ch.laning.outcome === 'stomp' ? 'good' : ch.laning.outcome === 'draw' ? undefined : 'bad';
    vitals.push({ label: UI.vitalLane, value: L(ch.laning.outcome_label), tone });
  }
  if (ch?.deaths) {
    const share = ch.deaths.summary.share_dead != null ? ` (${Math.round(ch.deaths.summary.share_dead * 100)}%)` : '';
    vitals.push({ label: UI.vitalDeaths, value: `${ch.deaths.summary.deaths}${share}`, tone: ch.deaths.summary.deaths >= 8 ? 'bad' : undefined });
  } else {
    vitals.push({ label: UI.vitalDeaths, value: String(player.kda[1]), tone: player.kda[1] >= 10 ? 'bad' : undefined });
  }
  if (ch?.items?.damage?.types) {
    const t = ch.items.damage.types;
    const dominant = t.physical >= t.magic ? { pct: t.physical, zh: '物理', en: 'Physical' } : { pct: t.magic, zh: '魔法', en: 'Magical' };
    vitals.push({ label: UI.vitalDamage, value: `${Math.round(dominant.pct * 100)}% ${L({ en: dominant.en, zh: dominant.zh })}` });
  } else {
    vitals.push({ label: UI.vitalGpm, value: String(Math.round(player.gpm)) });
  }
  if (ch?.fights) {
    const f = ch.fights.summary;
    vitals.push({ label: UI.vitalFights, value: `${f.won}W–${f.lost}L`, tone: f.lost > f.won ? 'bad' : f.won > f.lost ? 'good' : undefined });
  } else {
    vitals.push({ label: UI.vitalDmg, value: k(player.hero_damage) });
  }

  return (
    <section className={`cx-verdict ${loading ? 'is-loading' : ''}`} aria-label={L(UI.verdictEyebrow)}>
      <p className="cx-eyebrow">{L(UI.verdictEyebrow)}</p>
      <h2 className="cx-verdict-headline">{L(review.headline)}</h2>
      <dl className="cx-vitals">
        {vitals.map((v, i) => (
          <div key={i} className={`cx-vital ${v.tone ? `is-${v.tone}` : ''}`}>
            <dt>{L(v.label)}</dt>
            <dd>{v.value}</dd>
          </div>
        ))}
      </dl>
    </section>
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

const ReadColumn: React.FC<{ review: Review; report: CoachReport; compactHead?: boolean }> = ({ review, report, compactHead = false }) => {
  const { L } = useLang();
  const mine = review.findings.filter((f) => f.tone === 'fix' && !f.shared);
  const team = review.findings.filter((f) => f.tone === 'fix' && f.shared);
  const good = review.findings.filter((f) => f.tone === 'good');
  return (
    <div className="cx-read-block">
      {!compactHead && (
        <>
          <div className="cx-read-head">
            <p className="cx-eyebrow">{L(UI.coachRead)}</p>
          </div>
          <h2 className="cx-headline">{L(review.headline)}</h2>
        </>
      )}
      {mine.length > 0 && <Group title={L(UI.forYou)} findings={mine} report={report} slot={review.slot} />}
      {team.length > 0 && <Group title={L(UI.forTeam)} findings={team} report={report} slot={review.slot} />}
      {good.length > 0 && <Group title={L(UI.wentWell)} findings={good} report={report} slot={review.slot} />}
      {review.findings.length === 0 && <p className="cx-muted">{L(UI.noFindings)}</p>}
    </div>
  );
};

const Group: React.FC<{ title: string; findings: Finding[]; report: CoachReport; slot: number }> = ({ title, findings, report, slot }) => (
  <div className="cx-group">
    <h3 className="cx-group-title">{title}</h3>
    <ol className="cx-findings">
      {findings.map((f) => <FindingCard key={f.id} f={f} report={report} slot={slot} />)}
    </ol>
  </div>
);

const FindingCard: React.FC<{ f: Finding; report: CoachReport; slot: number }> = ({ f, report, slot }) => {
  const { L } = useLang();
  const active = useActiveGoal();
  const candidate = f.goal && f.tone === 'fix' && !f.shared ? goalFromFinding(report, slot, f.id, f.goal, f.action) : null;
  const isActive = candidate != null && active?.id === candidate.id;
  return (
    <li className={`cx-card tone-${f.tone} sev-${f.severity}`}>
      <div className="cx-card-meta">
        <span className="cx-area">{L(AREA[f.area])}</span>
        <span className="cx-conf">{L(UI.confidence[f.confidence])}</span>
      </div>
      <h4>{L(f.title)}</h4>
      {f.tone === 'fix' && (
        <p className="cx-do"><span>{L(UI.doNext)}</span>{L(f.action ?? f.ask)}</p>
      )}
      <p className="cx-body">{L(f.body)}</p>
      <EvidenceRow evidence={f.evidence} report={report} />
      {f.caveat && <p className="cx-caveat">{L(f.caveat)}</p>}
      {candidate && (isActive ? (
        <p className="cx-goal-set">
          <span>✓ {L(UI.goalSet)}：{L(candidate.goal.label)}</span>
          <button type="button" className="cx-linkbtn" onClick={() => setGoal(null)}>{L(UI.goalClear)}</button>
        </p>
      ) : (
        <button type="button" className="cx-goal-btn" onClick={() => setGoal(candidate)}>
          {L(UI.setGoal)}<span>{L(candidate.goal.label)}</span>
        </button>
      ))}
    </li>
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
                  return it?.img ? <img key={key} src={it.img} alt={L(it)} title={L(it)} /> : <span key={key} className="cx-chip">{it ? L(it) : key}</span>;
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

const RoleCard: React.FC<{ review: Review; onSet: (pos: number) => void }> = ({ review, onSet }) => {
  const { L } = useLang();
  const r = review.role;
  const note = r.source === 'user' ? UI.roleUser : r.source === 'lanes' ? UI.roleLanes : UI.roleInferred;
  return (
    <div className="cx-box">
      <h3>{L(UI.role)}</h3>
      <p className="cx-role">{L(r.label)}</p>
      <p className="cx-muted">{L(note)}</p>
      <p className="cx-muted cx-fix-label">{L(UI.fixRole)}</p>
      <div className="cx-posrow">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" aria-pressed={r.pos === n} onClick={() => onSet(n)}>{n}</button>
        ))}
      </div>
    </div>
  );
};

const BenchCard: React.FC<{ player: Player }> = ({ player }) => {
  const { L } = useLang();
  if (!player.benchmarks) return null;
  return (
    <div className="cx-box">
      <h3>{L(UI.vsHero)}</h3>
      <ul className="cx-bench">
        {BENCH.map(({ key, label }) => {
          const b = player.benchmarks?.[key];
          if (!b) return null;
          const p = Math.round(b.pct * 100);
          return (
            <li key={key}>
              <span className="cx-bench-label">{L(label)}</span>
              <span className="cx-bar" aria-hidden="true"><i style={{ width: `${Math.max(2, p)}%` }} className={p < 30 ? 'lo' : p >= 70 ? 'hi' : ''} /></span>
              <span className="cx-bench-val">{p}<small>%</small></span>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

const ItemsCard: React.FC<{ player: Player; review: Review }> = ({ player }) => {
  const { L } = useLang();
  return (
    <div className="cx-box">
      <h3>{L(UI.items)}</h3>
      <div className="cx-items">
        {player.items.length === 0 && <span className="cx-muted">—</span>}
        {player.items.map((it, idx) => (
          <figure key={`${it.key}-${idx}`} title={L(it)}>
            {it.img ? <SafeImg src={it.img} alt={L(it)} /> : <span className="cx-img-missing" />}
            <figcaption>{L(it)}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
};

const ThreatCard: React.FC<{ review: Review; report: CoachReport }> = ({ review, report }) => {
  const { L } = useLang();
  if (!review.threats.length) return null;
  const hero = (id: number) => report.players.find((p) => p.hero.id === id)?.hero;
  return (
    <div className="cx-box">
      <h3>{L(UI.threats)}</h3>
      <ul className="cx-threats">
        {review.threats.map((x) => (
          <li key={x.tag}>
            <span>{L(x.label)}</span>
            <span className="cx-icons">
              {x.heroes.map((id) => { const h = hero(id); return h?.icon ? <img key={id} src={h.icon} alt={L(h)} title={L(h)} className="is-hero" /> : null; })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
};

/** Matchups need no replay: shown here when there is no laning chapter to carry them (unparsed matches). */
const MatchupsCard: React.FC<{ review: Review; report: CoachReport }> = ({ review, report }) => {
  const { L } = useLang();
  const list = review.matchups ?? [];
  if (!list.some((m) => m.n != null || m.rank)) return null;
  const heroById = new Map(report.players.map((p) => [p.hero.id, p.hero]));
  return (
    <div className="cx-box">
      <h3>{L(UI.matchups)}</h3>
      <Matchups list={list} heroById={heroById} since={report.baselines?.since ?? null} bracket={review.bracket} rankSource={report.baselines?.rank} />
    </div>
  );
};

const TimelineCard: React.FC<{ review: Review }> = ({ review }) => {
  const { L } = useLang();
  return (
    <div className="cx-box">
      <h3>{L(UI.timeline)}</h3>
      <ol className="cx-tl">
        {review.item_timeline!.slice(0, 10).map((x, idx) => (
          <li key={`${x.item.key}-${idx}`}>
            <time>{clock(x.time)}</time>
            {x.item.img && <SafeImg src={x.item.img} alt="" />}
            <span>{L(x.item)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
};

const DeathsCard: React.FC<{ review: Review; report: CoachReport }> = ({ review, report }) => {
  const { L } = useLang();
  const hero = (id: number | null) => (id == null ? null : report.players.find((p) => p.hero.id === id)?.hero ?? null);
  return (
    <div className="cx-box">
      <h3>{L(UI.deaths)} · {review.deaths!.length}{report.players[review.slot].kda[1] !== review.deaths!.length ? ` / ${report.players[review.slot].kda[1]}` : ''}</h3>
      <ol className="cx-deaths">
        {review.deaths!.map((d, i) => {
          const h = hero(d.killer);
          return (
            <li key={i} className={d.in_fight === false ? 'is-caught' : ''}>
              <time>{clock(d.time)}</time>
              {h?.icon ? <SafeImg src={h.icon} alt={L(h)} title={L(h)} /> : d.killer == null ? <span className="cx-nothero" title={L(UI.notHeroTitle)} aria-label={L(UI.notHeroTitle)} role="img">—</span> : <span className="cx-blank" />}
              <span>{d.in_fight == null ? '' : d.in_fight ? L(UI.fight) : L(UI.caught)}</span>
              {d.converted && <em>{L(UI.converted)}</em>}
            </li>
          );
        })}
      </ol>
    </div>
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
const CardShell: React.FC<{
  card: Card; children: React.ReactNode; onAction: (a: CardAction) => void; hideTitle?: boolean; skip?: CardAction['action'][];
  labelFor?: (a: CardAction) => string;
}> = ({ card, children, onAction, hideTitle, skip = [], labelFor }) => {
  const { L } = useLang();
  const actions = card.actions.filter((a) => !skip.includes(a.action));
  return (
    <section id={cardDom(card.id)} className={`cxv-card is-${card.tone} is-${card.component.toLowerCase()}`} aria-label={L(card.title)}>
      <header className="cxv-card-head">
        <span className={`cxv-auth is-${card.authority}`}>{L(CARD_UI.authority[card.authority])}</span>
        {!hideTitle && <h3>{L(card.title)}</h3>}
      </header>
      <div className="cxv-card-body">{children}</div>
      {actions.length > 0 && (
        <div className="cxv-actions">
          {actions.map((a, i) => (
            <button key={i} type="button" className={`cxv-act is-${a.action}`} onClick={() => onAction(a)}>{labelFor ? labelFor(a) : L(a.label)}</button>
          ))}
        </div>
      )}
    </section>
  );
};

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

/**
 * The review as the engine's card surface: each card's component picks its
 * renderer, and only the card's own whitelisted actions are offered.
 */
const CardFeed: React.FC<{
  report: CoachReport; review: Review; player: Player; pos: number | null; loading: boolean; askSeq: number;
  onParsed: () => Promise<void>;
}> = ({ report, review, player, pos, loading, askSeq, onParsed }) => {
  const { lang, L } = useLang();
  const askRef = useRef<AskHandle>(null);
  const surface = useMemo(() => buildSurface(report, review.slot) as { cards: Card[] } | null, [report, review.slot]);
  const heroById = useMemo(() => new Map(report.players.map((p) => [p.hero.id, p.hero])), [report]);
  const [jump, setJump] = useState<{ target: string; row: number | null; seq: number } | null>(null);
  const [compare, setCompare] = useState<{ hero: number; vs: number } | null>(null);
  const [cases, setCases] = useState<{ theme: string; seq: number } | null>(null);
  // Per-match/player state resets when either changes; the feed itself stays mounted
  // so a pending replay parse keeps polling (its card has the same id for every player).
  useEffect(() => { setJump(null); setCompare(null); setCases(null); }, [report.match.id, review.slot, pos]);
  // Opening pro cases goes to the requested theme (or the loading panel) once it is on the page.
  useEffect(() => {
    if (!cases) return undefined;
    const timer = setTimeout(() => jumpToCases(cases.theme), 0);
    return () => clearTimeout(timer);
  }, [cases]);
  useEffect(() => { if (askSeq > 0) askRef.current?.focus(); }, [askSeq]);
  // A jump to a row reopens its data disclosure (the user may have collapsed it) once the chapter has re-rendered.
  useEffect(() => {
    if (!jump || jump.row == null || (jump.target !== 'deaths' && jump.target !== 'fights')) return undefined;
    const id = `cx-${jump.target === 'deaths' ? 'death' : 'fight'}-row-${jump.row}`;
    const timer = setTimeout(() => revealRow(id), 0);
    return () => clearTimeout(timer);
  }, [jump]);

  if (!surface) return null;
  const has = (component: string) => surface.cards.some((c) => c.component === component);
  // A question asked from a card carries that card as its context ("当前围绕：…").
  const ask = (q: Bi, from?: Card) => askRef.current?.prefill(L(q), from ? L(from.title) : undefined);
  const scrollTo = (id: string) => document.getElementById(cardDom(id))?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });

  const run = (a: CardAction) => {
    switch (a.action) {
      case 'inspect':
        setJump({ target: a.target, row: a.row ?? null, seq: Date.now() });
        scrollTo(`chapter:${a.target}`);
        break;
      case 'ask': ask(a.question, surface.cards.find((c) => c.actions.includes(a))); break;
      case 'save_goal': {
        const card = surface.cards.find((c) => c.actions.includes(a));
        const f = card?.data.finding as Finding | undefined;
        if (f?.goal) setGoal(goalFromFinding(report, review.slot, f.id, f.goal, f.action));
        break;
      }
      case 'parse': scrollTo('gaps'); break;
      case 'compare': setCompare({ hero: a.hero, vs: a.vs }); break;
      case 'open_cases': setCases({ theme: a.theme, seq: Date.now() }); break;
      default: break;
    }
  };

  const onAskChapter = (key: string) => () => {
    const c = surface.cards.find((x) => x.id === `chapter:${key}`);
    const q = c?.actions.find((x) => x.action === 'ask') as Extract<CardAction, { action: 'ask' }> | undefined;
    if (q) ask(q.question, c); else askRef.current?.focus();
  };

  const body = (c: Card): React.ReactNode => {
    const d = c.data as Record<string, any>;
    switch (c.component) {
      case 'MatchHeader': return null; // the page header and lineup already show it
      case 'Headline': return <VerdictHero review={review} player={player} loading={loading} />;
      case 'GoldGraph':
        return report.timeline ? (
          <GoldTimeline report={report} review={review}
            onSelectDeath={has('Deaths') ? (i) => run({ action: 'inspect', label: c.title, target: 'deaths', row: i }) : undefined}
            onSelectFight={has('Fights') ? (i) => run({ action: 'inspect', label: c.title, target: 'fights', row: i }) : undefined} />
        ) : null;
      case 'Finding': return <ul className="cx-cards"><FindingCard f={d.finding as Finding} report={report} slot={review.slot} /></ul>;
      case 'Matchups':
        // The laning chapter already shows the strip: keep only this card's compare actions.
        if (has('Lane')) return null;
        return <Matchups list={d.list} heroById={heroById} since={d.since} bracket={d.bracket} rankSource={d.rank_source ?? undefined} />;
      case 'Story': return <StoryChapter ch={d.chapter} onAsk={onAskChapter('story')} withCases={report.match.parsed} onOpenCase={(theme) => setCases({ theme, seq: Date.now() })} />;
      case 'Lane':
        return <LaningChapter ch={d.chapter} heroById={heroById} slot={review.slot} onAsk={onAskChapter('laning')} defaultOpen
          matchups={review.matchups} since={report.baselines?.since ?? null} bracket={review.bracket} rankSource={report.baselines?.rank} />;
      case 'Deaths':
        return <DeathsChapter ch={d.chapter} heroById={heroById} onAsk={onAskChapter('deaths')} defaultOpen
          highlightIndex={jump?.target === 'deaths' ? jump.row : null} jumpSeq={jump?.target === 'deaths' ? jump.seq : undefined} />;
      case 'Items':
        return <ItemsChapter ch={d.chapter} heroById={heroById} onAsk={onAskChapter('items')} counterItems={review.counter_items} myHero={player.hero} since={report.baselines?.since ?? null} />;
      case 'Fights':
        return <FightsChapter ch={d.chapter} onAsk={onAskChapter('fights')} defaultOpen
          highlightIndex={jump?.target === 'fights' ? jump.row : null} jumpSeq={jump?.target === 'fights' ? jump.seq : undefined} />;
      case 'Plan': return <PlanChapter plan={d.plan} onAsk={() => askRef.current?.focus()} />;
      case 'DataGaps': return <ParsePanel report={report} priority={!report.match.parsed} onParsed={onParsed} lang={lang} />;
      default: return null;
    }
  };

  // Presentation only: the parse action goes right under the headline when it is the next step.
  const cards = [...surface.cards];
  const gaps = cards.findIndex((c) => c.component === 'DataGaps' && c.actions.some((a) => a.action === 'parse'));
  if (gaps > 2) cards.splice(2, 0, ...cards.splice(gaps, 1));
  // (Matchups stays: with a laning chapter its body is empty but its compare actions remain.)
  const shown = cards.filter((c) => c.component !== 'MatchHeader');
  const rail = shown.filter((c) => c.component === 'Matchups');
  const main = shown.filter((c) => c.component !== 'Matchups');
  // Chapter components render their own heading and ask button.
  const selfTitled = ['Headline', 'GoldGraph', 'Story', 'Lane', 'Deaths', 'Items', 'Fights', 'Plan', 'DataGaps'];
  const card = (c: Card) => (
    <CardShell key={c.id} card={c} onAction={run} hideTitle={selfTitled.includes(c.component) || c.component === 'Finding'}
      // Findings and the parse panel render their own goal / parse buttons.
      skip={c.component === 'Finding' ? ['save_goal'] : c.component === 'DataGaps' ? ['ask', 'parse'] : selfTitled.includes(c.component) ? ['ask'] : []}
      labelFor={(a) => (a.action === 'compare' ? `${L(a.label)} · ${heroById.get(a.vs)?.[lang] ?? ''}` : L(a.label))}>
      {body(c)}
    </CardShell>
  );
  return (
    <div className={`cxv-feed ${loading ? 'is-loading' : ''}`}>
      <div className="cxv-main">
        {main.map(card)}
        {cases && report.match.parsed && (
          <section className="cxv-card is-neutral is-cases" aria-label={L(CARD_UI.casesTitle)}>
            <header className="cxv-card-head">
              <span className="cxv-auth is-statistic">{L(CARD_UI.authority.statistic)}</span>
              <h3>{L(CARD_UI.casesTitle)}</h3>
              <button type="button" className="cxv-x" onClick={() => setCases(null)} aria-label={L(CARD_UI.close)}>×</button>
            </header>
            <div className="cxv-card-body"><Cases matchId={String(report.match.id)} slot={review.slot} pos={pos} onAsk={() => askRef.current?.focus()} /></div>
          </section>
        )}
      </div>
      <aside className="cxv-rail">
        {compare && <CompareCard hero={compare.hero} vs={compare.vs} rank={review.bracket?.key ?? null} onClose={() => setCompare(null)} />}
        {rail.map(card)}
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
