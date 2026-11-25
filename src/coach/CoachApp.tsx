import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CoachApiError, fetchCoachReport, fetchPatchNews, fetchRecentMatches } from './api';
import { markSeen, parseAccountInput, rememberAccount, rememberedAccount, reviewedMatches, seenUntil } from './accountInput';
import type { Bi, Evidence, Finding, RecentMatch, RecentMatches, Review } from './types';
import { SafeImg, clock, useLang, type Lang } from './ui';
import { AccessModes, HowItWorks } from './HomeBlocks';
import { accessSnippets } from './accessSnippets';
import { QuickJump, detectSmartInput } from './QuickJump';
import { CURRENT_PATCH, SHIPPED_NEWS, itemIcon, readPatchNews, type PatchNews as PatchNewsData } from './patch';
import { PatchAdvisor } from '../patch/PatchAdvisor';
import { activeGoal, checkGoal, goalChecks, setGoal, useActiveGoal, type GoalCheck } from './goalStore';
import './coach.css';
import './cards.css';
import './review.css';

const EXAMPLE_MATCH = '9091400302';

export { SafeImg };

const UI = {
  tagline: { en: 'A Dota 2 coach that watches the replay.', zh: '看录像复盘的 Dota 2 教练。' },
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
  recentLimited: { en: 'OpenDota is unavailable right now, so this list comes from Steam: results, K/D/A and game length are not shown. Open a game to review it.', zh: 'OpenDota 暂时不可用，这份列表来自 Steam：暂不显示胜负、KDA 和比赛时长。点开任意一场即可复盘。' },
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
  patchUpdate: { en: 'Update {v}', zh: '{v} 更新' },
  patchUpdateChanges: { en: '{h} heroes, {i} items changed', zh: '{h} 位英雄、{i} 件物品调整' },
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
  parseFailedSelf: { en: 'The parse did not go through. Try again in a minute.', zh: '解析没有成功，请一分钟后再试。' },
  parseGone: { en: 'Valve no longer has this replay (replays are kept about two weeks), so this match cannot be parsed.', zh: 'Valve 已不再保存这场比赛的录像（录像大约保留两周），无法解析这场比赛。' },
  parseGaveUp: { en: 'Still not parsed after 10 minutes. Come back later; the link keeps working.', zh: '10 分钟后仍未解析完成。稍后再来，链接一直有效。' },
  notFound: { en: 'OpenDota does not know this match. Check the ID — private or very new matches may not be visible yet.', zh: 'OpenDota 找不到这场比赛。请检查 ID——私密比赛或刚结束的比赛可能暂时不可见。' },
  upstream: { en: 'OpenDota did not answer in time. Try again in a moment.', zh: 'OpenDota 暂时没有响应，请稍后重试。' },
  rateLimited: { en: 'Slow down a little — too many requests from your network.', zh: '请求太频繁了，请稍等。' },
  insufficient: { en: 'This match’s player data is not available yet. That is usual for a game that ended a few minutes ago: try again shortly.', zh: '这场比赛的玩家数据还没准备好。比赛刚结束的几分钟内常会这样，请稍后重试。' },
  internalError: { en: 'We could not build this review. The fault is on our side, not in your match ID. Try again in a moment.', zh: '复盘生成失败。这是我们这边的问题，不是你的比赛 ID 有误。请稍后重试。' },
  network: { en: 'Could not reach dota2.ai. Check your connection and try again.', zh: '连不上 dota2.ai，请检查网络后重试。' },
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
  footer: { en: 'Not affiliated with Valve. Reviews are read from the game\'s replay; scoreboards from OpenDota.', zh: '粉丝项目，与 Valve 无关。复盘读的是对局录像；记分板来自 OpenDota。' },
  parsed: { en: 'Parsed', zh: '已解析' },
  fromSteamGc: { en: 'Scoreboard from Valve’s game coordinator (OpenDota unavailable): no timeline yet', zh: '数据来自 Valve 游戏协调器（OpenDota 暂不可用）：只有终局计分板，暂无时间线' },
  fromSteamGcParsed: { en: 'Parsed by dota2.ai from Valve’s replay (OpenDota unavailable): no percentile comparison', zh: '由 dota2.ai 解析 Valve 录像（OpenDota 暂不可用）：暂无百分位对比' },
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

export const Shell: React.FC<{ children: React.ReactNode; wide?: boolean; isHome?: boolean; hideMyGames?: boolean }> = ({
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
      setError(e instanceof CoachApiError ? e : new CoachApiError('network', String(e), 0));
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
    const text = error.status === 429 ? L(UI.rateLimited) : error.code === 'network' ? L(UI.network) : L(UI.upstream);
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
            {data.source === 'steam_web_api' && <p className="cx-notice" role="status">{L(UI.recentLimited)}</p>}
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
                          {/* Only what the source gave: no stray separators around a missing part. */}
                          {[
                            m.mode ? L(m.mode) : null,
                            m.ranked ? L(UI.ranked) : null,
                            m.duration != null ? clock(m.duration) : null,
                            m.start_time ? new Date(m.start_time * 1000).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US') : null,
                          ].filter(Boolean).join(' · ')}
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

/**
 * The patch news from the server (live from Valve), starting from the one this build shipped with.
 * While the server is still choosing the highlights it is asked again every 20 s, past the browser
 * cache, up to PATCH_NEWS_RETRIES times.
 */
export const PATCH_NEWS_RETRIES = 6;
function useLivePatchNews(): PatchNewsData {
  const [news, setNews] = useState<PatchNewsData>(SHIPPED_NEWS);
  useEffect(() => {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (attempt: number) => {
      const got = await fetchPatchNews(ctl.signal, attempt > 0);
      const read = got && readPatchNews(got.body);
      if (ctl.signal.aborted) return;
      if (read) setNews(read);
      if (got?.picking && attempt < PATCH_NEWS_RETRIES) timer = setTimeout(() => void load(attempt + 1), 20_000);
    };
    void load(0);
    return () => { ctl.abort(); if (timer) clearTimeout(timer); };
  }, []);
  return news;
}

/** The patch as one line; new items and what changed for reviews are one click away. */
const PatchNews: React.FC<{ onCta: () => void }> = ({ onCta }) => {
  const { lang, L } = useLang();
  const p = useLivePatchNews();
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
        {p.forCoach && <p className="cx-patch-coach"><strong>{L(UI.patchForCoach)}</strong> {L(p.forCoach)}</p>}
      </details>
      <div className="cx-patch-actions">
        <button type="button" className="cx-patch-cta" onClick={onCta}>{v(UI.patchCta)}</button>
        <a href={p.url} target="_blank" rel="noreferrer">{L(UI.patchNotes)} ↗</a>
      </div>
      {p.update && (
        <p className="hm-patch-update">
          <time dateTime={p.update.date}>{p.update.date}</time>
          <a href={p.update.url} target="_blank" rel="noreferrer">{L(UI.patchUpdate).replace('{v}', p.update.version)} ↗</a>
          <span>{L(UI.patchUpdateChanges).replace('{h}', String(p.update.changes.heroes)).replace('{i}', String(p.update.changes.items))}</span>
        </p>
      )}
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
  sub: { en: 'A coach that watches your replay. It finds what decided the game, shows the moments that prove it, and tells you what to change next time.', zh: '一位会看你录像的教练。找出这局输赢的关键，把证明它的时刻摆给你看，再告诉你下一把改什么。' },
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
  // Whose latest game to show: the remembered friend code, or else the player a next-game goal was set
  // for (a goal set from a review knows its account even when the games page was never opened).
  const goalNow = useActiveGoal();
  const latestFor = known ?? (goalNow?.accountId != null && goalNow.accountId > 0 && goalNow.accountId < 2 ** 32 - 1 ? String(goalNow.accountId) : null);

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

      {latestFor && <div className="hm-latest"><LatestGame accountId={latestFor} /></div>}
      </div>
      <HowItWorks />
      </div>

      <PatchAdvisor lang={lang} version={CURRENT_PATCH.version} notesUrl={CURRENT_PATCH.notesUrl} />

      <AccessModes matchId={EXAMPLE_MATCH} onWeb={focusInput} />

      <PatchNews onCta={focusInput} />
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

const ResultPill: React.FC<{ r: string }> = ({ r }) => {
  const { L } = useLang();
  return <span className={`cx-goal-result is-${r}`}>{L(UI.goalResult[r])}</span>;
};

