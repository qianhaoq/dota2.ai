import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { parseMatchInput } from '../v2/parseMatchInput';
import { CoachApiError, fetchCoachReport, fetchRecentMatches, requestParse } from './api';
import { markReviewed, markSeen, parseAccountInput, rememberAccount, rememberedAccount, reviewedMatches, seenUntil } from './accountInput';
import type { Bi, CoachReport, Evidence, Finding, Player, RecentMatch, RecentMatches, Review } from './types';
import { SafeImg, clock, k, useLang, type Lang } from './ui';
import { Chapters } from './Chapters';
import { CURRENT_PATCH, itemIcon } from './patch';
import { trackEvent, trackReviewViewed } from '../services/analytics';
import { activeGoal, checkGoal, goalChecks, goalFromFinding, setGoal, useActiveGoal, type GoalCheck } from './goalStore';
import './coach.css';

const EXAMPLE_MATCH = '9091400302';

export { SafeImg };

const UI = {
  tagline: { en: 'A post-match coach that shows its evidence.', zh: '一位拿证据说话的赛后教练。' },
  heroTitle: { en: 'Paste a match.\nGet a coach’s read.', zh: '贴一场比赛，\n得到一份教练复盘。' },
  placeholder: { en: 'Match ID or OpenDota / Dotabuff / STRATZ link', zh: '比赛 ID，或 OpenDota / Dotabuff / STRATZ 链接' },
  review: { en: 'Review', zh: '开始复盘' },
  invalid: { en: 'That does not look like a match ID.', zh: '这看起来不是一个比赛 ID。' },
  tryExample: { en: 'Try an example', zh: '试试示例' },
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
  recentTitle: { en: 'Your recent games', zh: '你最近的比赛' },
  recentSub: { en: 'Pick a game — the review opens on your hero.', zh: '选一场，复盘会直接打开你的英雄。' },
  recentEmpty: {
    en: 'No public games for this account. If it is yours, turn on “Expose Public Match Data” in Dota 2’s settings, play a game, then come back.',
    zh: '这个账号没有公开的比赛。如果是你的账号，请在 Dota 2 设置里打开「公开比赛数据」（Expose Public Match Data），打完一局再回来。',
  },
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
  loading: { en: 'Reading the match…', zh: '正在读取比赛…' },
  radiant: { en: 'Radiant', zh: '天辉' },
  dire: { en: 'Dire', zh: '夜魇' },
  victory: { en: 'victory', zh: '胜利' },
  pick: { en: 'Which hero were you?', zh: '你玩的是哪个英雄？' },
  pickSub: { en: 'Pick one to get a review written for that seat.', zh: '选一个英雄，复盘会针对这个位置来写。' },
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
  threats: { en: 'What the enemy brought', zh: '对方阵容的威胁' },
  timeline: { en: 'Key item timings', zh: '关键装备时间' },
  deaths: { en: 'Deaths', zh: '死亡记录' },
  caught: { en: 'caught', zh: '被抓' },
  fight: { en: 'in a fight', zh: '团战中' },
  notHeroTitle: { en: 'No hero got the kill: tower, creeps or neutrals', zh: '击杀者不是英雄：防御塔、小兵或野怪' },
  converted: { en: '→ objective lost', zh: '→ 丢了目标' },
  gold: { en: 'Gold lead', zh: '经济差' },
  yourDeaths: { en: 'your deaths', zh: '你的死亡' },
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
  classic: { en: 'Classic tools', zh: '旧版工具' },
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


/* ---------------------------------------------------------------- shell */

const Shell: React.FC<{ children: React.ReactNode; wide?: boolean }> = ({ children, wide }) => {
  const { lang, setLang, L } = useLang();
  return (
    <div className="cx">
      <header className="cx-top">
        <Link to={`/?lang=${lang}`} className="cx-brand" aria-label="dota2.ai home">
          <span className="cx-mark" aria-hidden>◆</span> dota2<span className="cx-dot">.ai</span>
          <span className="cx-brand-sub">coach</span>
        </Link>
        <div className="cx-lang" role="group" aria-label="Language">
          <button type="button" aria-pressed={lang === 'en'} onClick={() => setLang('en')}>EN</button>
          <button type="button" aria-pressed={lang === 'zh'} onClick={() => setLang('zh')}>中文</button>
        </div>
      </header>
      <main className={wide ? 'cx-main cx-main--wide' : 'cx-main'}>{children}</main>
      <footer className="cx-foot">
        <span>{L(UI.footer)}</span>
        <a href="/legacy">{L(UI.classic)}</a>
      </footer>
    </div>
  );
};

/* ----------------------------------------------------------------- home */

/** Coming back after a game: the newest one, one tap from its review. */
const LatestGame: React.FC<{ accountId: string }> = ({ accountId }) => {
  const { lang, L } = useLang();
  const [latest, setLatest] = useState<RecentMatch | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    fetchRecentMatches(accountId, ac.signal).then((r) => setLatest(r.matches[0] ?? null)).catch(() => {});
    return () => ac.abort();
  }, [accountId]);
  const all = <Link to={`/p/${accountId}?lang=${lang}`} className="cx-account-known">{latest ? L(UI.allRecent) : L(UI.myGames)} →</Link>;
  if (!latest) return <p className="cx-example">{all}</p>;
  const reviewed = reviewedMatches().has(String(latest.match_id));
  const goal = activeGoal();
  return (
    <div className="cx-latest">
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
      {goal && <LatestGoal goal={goal} latest={latest} />}
      <p className="cx-example">{all}</p>
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
  return (
    <p className="cx-latest-goal">
      <span>{L(UI.goalCheckTitle)}：{L(goal.goal.label)}</span>
      {check ? <ResultPill r={check.result} /> : !counts ? <span className="cx-muted"> · {L(UI.goalHere)}</span> : null}
    </p>
  );
};

const AccountForm: React.FC = () => {
  const { lang, L } = useLang();
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const [error, setError] = useState<'invalid' | 'vanity' | null>(null);
  // Collapsed by default: the match box stays the page's one primary input.
  const [open, setOpen] = useState(false);
  const known = rememberedAccount();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const r = parseAccountInput(value);
    if (!r.ok) { setError(r.reason); return; }
    navigate(`/p/${r.accountId}?lang=${lang}`);
  };
  return (
    <div className="cx-account">
      {known ? (
        <LatestGame accountId={known} />
      ) : !open ? (
        <p className="cx-example"><button type="button" aria-expanded="false" onClick={() => setOpen(true)}>{L(UI.useAccount)}</button></p>
      ) : (
        <form className="cx-account-form" onSubmit={submit}>
          <label htmlFor="cx-account-input">{L(UI.orAccount)}</label>
          <div>
            <input
              id="cx-account-input" autoFocus value={value} placeholder={L(UI.accountPlaceholder)} inputMode="text"
              onChange={(e) => { setValue(e.target.value); setError(null); }}
            />
            <button type="submit">{L(UI.showRecent)}</button>
          </div>
          {error && <p className="cx-err" role="alert">{L(error === 'vanity' ? UI.accountVanity : UI.accountInvalid)}</p>}
        </form>
      )}
    </div>
  );
};

/* --------------------------------------------------------- recent games */

export const CoachPlayerPage: React.FC = () => {
  const { accountId = '' } = useParams();
  const { lang, L } = useLang();
  const navigate = useNavigate();
  const [data, setData] = useState<RecentMatches | null>(null);
  const [error, setError] = useState<CoachApiError | null>(null);
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

  if (!valid) return <Shell><ErrorBlock text={L(UI.accountInvalid)} /></Shell>;
  if (error) {
    const text = error.status === 429 ? L(UI.rateLimited) : L(UI.upstream);
    return <Shell><ErrorBlock text={text} onRetry={() => void load()} /></Shell>;
  }
  if (!data) return <Shell><Skeleton label={L(UI.loading)} /></Shell>;
  return (
    <Shell>
      <section className="cx-recent">
        <p className="cx-eyebrow">{L(UI.recentTitle)}</p>
        <h1 className="cx-h2">{L(UI.recentSub)}</h1>
        {data.matches.length === 0 ? (
          <p className="cx-recent-empty">{L(UI.recentEmpty)}</p>
        ) : (
          <ul className="cx-recent-list">
            {data.matches.map((m) => (
              <li key={m.match_id}>
                <Link to={`/r/${m.match_id}?p=${m.slot}&lang=${lang}`} className="cx-recent-row">
                  {m.hero.icon ? <SafeImg src={m.hero.icon} alt="" className="cx-recent-icon" /> : <span className="cx-recent-icon" />}
                  <span className="cx-recent-hero">
                    {m.hero[lang]}
                    {seen != null && (m.start_time ?? 0) > seen && <span className="cx-tag cx-tag--new">{L(UI.newTag)}</span>}
                    {reviewed.has(String(m.match_id)) && <span className="cx-tag">{L(UI.reviewedTag)}</span>}
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
            ))}
          </ul>
        )}
        <p className="cx-example">
          <button type="button" onClick={() => { rememberAccount(null); navigate(`/?lang=${lang}`); }}>{L(UI.notMe)}</button>
        </p>
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
      <div className="cx-patch-head">
        <p className="cx-eyebrow">{L(UI.patchEyebrow)} · <time dateTime={p.date}>{p.date}</time></p>
        <h2 id="cx-patch-title">{v(UI.patchTitle)}</h2>
      </div>
      <ul className="cx-patch-list">
        {p.highlights.map((h, i) => <li key={i}>{L(h)}</li>)}
      </ul>
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
      <p className="cx-patch-coach"><strong>{L(UI.patchForCoach)}</strong> {L(p.forCoach)}</p>
      <div className="cx-patch-actions">
        <button type="button" className="cx-patch-cta" onClick={onCta}>{v(UI.patchCta)}</button>
        <a href={p.notesUrl} target="_blank" rel="noreferrer">{L(UI.patchNotes)} ↗</a>
      </div>
    </section>
  );
};

export const CoachHome: React.FC = () => {
  const { lang, L } = useLang();
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const go = (raw: string) => {
    const id = parseMatchInput(raw);
    if (!id) { setError(true); return; }
    navigate(`/r/${id}?lang=${lang}`);
  };
  return (
    <Shell>
      <section className="cx-hero">
        <p className="cx-eyebrow">{L(UI.tagline)}</p>
        <h1 className="cx-h1">{L(UI.heroTitle).split('\n').map((line, i) => <span key={i}>{line}</span>)}</h1>
        <form className="cx-search" onSubmit={(e) => { e.preventDefault(); go(value); }}>
          <input
            ref={inputRef} aria-label={L(UI.placeholder)} placeholder={L(UI.placeholder)} value={value} inputMode="text" autoFocus
            onChange={(e) => { setValue(e.target.value); setError(false); }}
          />
          <button type="submit">{L(UI.review)}</button>
        </form>
        {error && <p className="cx-err" role="alert">{L(UI.invalid)}</p>}
        <p className="cx-example">
          {L(UI.tryExample)}: <button type="button" onClick={() => go(EXAMPLE_MATCH)}>{EXAMPLE_MATCH}</button>
        </p>
        <AccountForm />
      </section>
      <PatchNews onCta={() => { inputRef.current?.focus(); inputRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }} />
      <section className="cx-principles">
        {[['p1t', 'p1'], ['p2t', 'p2'], ['p3t', 'p3']].map(([tk, bk], i) => (
          <div key={tk} className="cx-principle">
            <span className="cx-num">0{i + 1}</span>
            <h2>{L(UI[tk as 'p1t'])}</h2>
            <p>{L(UI[bk as 'p1'])}</p>
          </div>
        ))}
      </section>
      <section className="cx-api">
        <h2>{L(UI.api)}</h2>
        <pre><code>{`curl https://dota2.ai/api/coach/${EXAMPLE_MATCH}\nnode packages/cli/bin/dota2ai.js coach ${EXAMPLE_MATCH} --hero spectre --lang zh`}</code></pre>
      </section>
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
      <MatchHeader report={report} slot={selected} pos={posOverride} />
      {notice && <p className="cx-notice" role="status">{notice}</p>}
      {error && (
        <p className="cx-notice cx-notice--error" role="alert">
          {error.status === 429 ? L(UI.rateLimited) : L(UI.refreshFailed)}{' '}
          <button type="button" className="cx-inline-btn" onClick={() => void load()}>{L(UI.retry)}</button>
        </p>
      )}
      <Lineup report={report} selected={selected} onPick={(s) => setParam({ p: String(s), pos: null })} />
      {review && <GoalBanner report={report} slot={review.slot} />}
      {report.timeline && <GoldGraph report={report} review={review} />}
      {review && <Chapters review={review} report={report} pos={posOverride} />}
      {review && player ? (
        <div className={`cx-grid ${loading ? 'is-loading' : ''}`}>
          <section className="cx-read" aria-label={L(UI.coachRead)}>
            <ReadColumn review={review} report={report} />
          </section>
          <aside className="cx-side">
            <RoleCard review={review} onSet={(pos) => setParam({ pos: String(pos) })} />
            <BenchCard player={player} />
            <ItemsCard player={player} review={review} />
            <ThreatCard review={review} report={report} />
            {!review.chapters?.items && review.item_timeline && review.item_timeline.length > 0 && <TimelineCard review={review} />}
            {!review.chapters?.deaths && review.deaths && review.deaths.length > 0 && <DeathsCard review={review} report={report} />}
          </aside>
        </div>
      ) : (
        <div className="cx-pick">
          <h2>{L(UI.pick)}</h2>
          <p>{L(UI.pickSub)}</p>
        </div>
      )}
      {report.data_gaps.length > 0 && (
        <ParsePanel
          report={report}
          onParsed={async () => {
            const r = await load();
            if (r?.match.parsed) setNotice(L(UI.parsedReady));
          }}
          lang={lang}
        />
      )}
      <section className="cx-api cx-api--inline">
        <h2>{L(UI.api)}</h2>
        <pre><code>{`curl https://dota2.ai/api/coach/${m.id}`}</code></pre>
      </section>
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

const MatchHeader: React.FC<{ report: CoachReport; slot: number | null; pos: number | null }> = ({ report, slot, pos }) => {
  const { lang, L } = useLang();
  const m = report.match;
  const [copied, setCopied] = useState<'self' | 'team' | null>(null);
  const links = shareLinks(window.location.origin, m.id, slot, lang, pos);
  const flash = (which: 'self' | 'team') => { setCopied(which); setTimeout(() => setCopied(null), 1800); };
  const copy = (text: string, which: 'self' | 'team') => {
    void navigator.clipboard?.writeText(text).then(() => {
      flash(which);
      trackEvent('report_shared', { target: which, method: 'copy', matchId: String(m.id) });
    }).catch(() => {});
  };
  const shareTeam = () => {
    const text = L(UI.shareTeamText).replace('{id}', String(m.id));
    if (typeof navigator.share === 'function' && window.matchMedia?.('(pointer: coarse)').matches) {
      navigator.share({ text, url: links.team })
        .then(() => trackEvent('report_shared', { target: 'team', method: 'native', matchId: String(m.id) }))
        .catch(() => {});
      return;
    }
    copy(`${text} ${links.team}`, 'team');
  };
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
          <button type="button" className="cx-ghost" onClick={() => copy(links.self, 'self')}>{copied === 'self' ? L(UI.copied) : L(UI.share)}</button>
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
    : <span className={`cx-hero-img cx-hero-img--${size} cx-hero-img--blank`} aria-hidden />;
};

const Lineup: React.FC<{ report: CoachReport; selected: number | null; onPick: (slot: number) => void }> = ({ report, selected, onPick }) => {
  const { L } = useLang();
  const side = (radiant: boolean) => report.players.filter((p) => p.radiant === radiant);
  return (
    <section className="cx-lineup" aria-label={L(UI.pick)}>
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

const tally = (goalId: string) => {
  const counted = goalChecks(goalId).filter((c) => c.result === 'met' || c.result === 'missed');
  return { n: counted.length, met: counted.filter((c) => c.result === 'met').length };
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

const ReadColumn: React.FC<{ review: Review; report: CoachReport }> = ({ review, report }) => {
  const { L } = useLang();
  const mine = review.findings.filter((f) => f.tone === 'fix' && !f.shared);
  const team = review.findings.filter((f) => f.tone === 'fix' && f.shared);
  const good = review.findings.filter((f) => f.tone === 'good');
  return (
    <>
      <div className="cx-read-head">
        <p className="cx-eyebrow">{L(UI.coachRead)}</p>
      </div>
      <h2 className="cx-headline">{L(review.headline)}</h2>
      {mine.length > 0 && <Group title={L(UI.forYou)} findings={mine} report={report} slot={review.slot} />}
      {team.length > 0 && <Group title={L(UI.forTeam)} findings={team} report={report} slot={review.slot} />}
      {good.length > 0 && <Group title={L(UI.wentWell)} findings={good} report={report} slot={review.slot} />}
      {review.findings.length === 0 && <p className="cx-muted">{L(UI.noFindings)}</p>}
    </>
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
              <span className="cx-bar" aria-hidden><i style={{ width: `${Math.max(2, p)}%` }} className={p < 30 ? 'lo' : p >= 70 ? 'hi' : ''} /></span>
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
        {player.items.map((it) => (
          <figure key={it.key} title={L(it)}>
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

const TimelineCard: React.FC<{ review: Review }> = ({ review }) => {
  const { L } = useLang();
  return (
    <div className="cx-box">
      <h3>{L(UI.timeline)}</h3>
      <ol className="cx-tl">
        {review.item_timeline!.slice(0, 10).map((x) => (
          <li key={x.item.key}>
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

const GoldGraph: React.FC<{ report: CoachReport; review: Review | null }> = ({ report, review }) => {
  const { L } = useLang();
  const adv = report.timeline!.radiant_gold_adv;
  const W = 760; const H = 140; const pad = 6;
  const max = Math.max(2000, ...adv.map((v) => Math.abs(v)));
  const x = (i: number) => pad + (i / Math.max(1, adv.length - 1)) * (W - pad * 2);
  const y = (v: number) => H / 2 - (v / max) * (H / 2 - pad);
  const line = adv.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(adv.length - 1)},${H / 2} L${x(0)},${H / 2} Z`;
  const tp = review?.findings.find((f) => f.window)?.window;
  const ticks = Array.from({ length: Math.floor((adv.length - 1) / 10) + 1 }, (_, i) => i * 10);
  return (
    <section className="cx-graph" aria-label={L(UI.gold)}>
      <h3>{L(UI.gold)} <small><span className="r">{L(UI.radiant)} ▲</span> <span className="d">{L(UI.dire)} ▼</span></small></h3>
      <div className="cx-graph-plot">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={L(UI.gold)}>
        <defs>
          <clipPath id="cx-top"><rect x="0" y="0" width={W} height={H / 2} /></clipPath>
          <clipPath id="cx-bot"><rect x="0" y={H / 2} width={W} height={H / 2} /></clipPath>
        </defs>
        {tp && <rect className="cx-tp" x={x(tp[0] / 60)} width={x(tp[1] / 60) - x(tp[0] / 60)} y="0" height={H} />}
        {ticks.slice(1).map((m) => <line key={m} x1={x(m)} x2={x(m)} y1="0" y2={H} className="cx-grid-v" />)}
        <line x1="0" x2={W} y1={H / 2} y2={H / 2} className="cx-axis" />
        <path d={area} className="cx-area-r" clipPath="url(#cx-top)" />
        <path d={area} className="cx-area-d" clipPath="url(#cx-bot)" />
        <path d={line} className="cx-line" />
      </svg>
      {/* Labels are HTML over the stretched SVG so text never distorts. */}
      {review?.deaths && review.deaths.length > 0 && (
        <div className="cx-graph-deaths" aria-hidden="true">
          {review.deaths.map((d, i) => <i key={i} style={{ left: `${(x(d.time / 60) / W) * 100}%` }} />)}
        </div>
      )}
      <div className="cx-graph-y" aria-hidden="true">
        <span style={{ top: `${(y(max) / H) * 100}%` }}>+{k(max)}</span>
        <span style={{ top: '50%' }}>0</span>
        <span style={{ top: `${(y(-max) / H) * 100}%` }}>−{k(max)}</span>
      </div>
      </div>
      <div className="cx-graph-axis" aria-hidden="true">
        {ticks.map((m) => <span key={m} style={{ left: `${(x(m) / W) * 100}%` }}>{m}′</span>)}
      </div>
      {review?.deaths && review.deaths.length > 0 && <p className="cx-graph-legend"><i className="cx-death-key" /> {L(UI.yourDeaths)}</p>}
    </section>
  );
};

const ParsePanel: React.FC<{ report: CoachReport; onParsed: () => Promise<void>; lang: Lang }> = ({ report, onParsed, lang }) => {
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
    <section className="cx-gaps">
      <h3>{L(report.match.parsed ? UI.partialGaps : UI.cantSee)}</h3>
      <ul>{report.data_gaps.map((g, i) => <li key={i}>{L(g)}</li>)}</ul>
      {!report.match.parsed && <p className="cx-muted">{L(UI.cantSeeSub)}</p>}
      {!report.match.parsed && report.match.replay_available && state !== 'pending' && (
        <button type="button" className="cx-primary" onClick={() => void start()}>{L(UI.parseBtn)}</button>
      )}
      {msg && <p className="cx-notice" role="status">{L(msg)}</p>}
    </section>
  );
};
