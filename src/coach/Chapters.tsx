import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SafeImg, clock, k, signedK, useLang } from './ui';
import { AskPanel, type AskHandle } from './AskPanel';
import { Cases } from './Cases';
import type { Bi, Chapters as ChaptersT, CoachReport, DeathRow, FightRow, HeroRef, LaneHeat, Review, WhyCause } from './types';

/**
 * The deep review workspace: segmented chapter tabs + "All in one page" toggle
 * on the left, paired with a sticky contextual dock on the right (Ask Coach +
 * Player Profile) so asking a follow-up never yanks scroll away from the data.
 */

export type ChapterTab = 'overview' | 'laning' | 'deaths' | 'items' | 'fights' | 'cases';

export interface ChapterJumpSignal {
  tab: ChapterTab;
  rowIndex?: number;
  seq: number;
}

const T = {
  title: { en: 'The full review', zh: '深度复盘工作台' },
  sub: { en: 'Switch dimensions or open all at once — every sentence links back to match data.', zh: '按维度快速切换，或一键展开全览；每句话都有对应数据。' },
  how: { en: 'How this is computed', zh: '怎么算的' },
  story: { en: '1 · How the game went', zh: '1 · 比赛经过' },
  laning: { en: '2 · Laning', zh: '2 · 对线' },
  deaths: { en: '3 · Every death', zh: '3 · 逐次死亡' },
  items: { en: '4 · Build vs. what hurt you', zh: '4 · 出装与承伤' },
  fights: { en: '5 · Every team fight', zh: '5 · 逐波团战' },
  plan: { en: 'Next game: practise this', zh: '下一局：练这几件事' },
  tabOverview: { en: 'Overview & Why', zh: '核心归因' },
  tabLaning: { en: 'Laning', zh: '对线' },
  tabDeaths: { en: 'Deaths', zh: '死亡' },
  tabItems: { en: 'Items & Damage', zh: '出装承伤' },
  tabFights: { en: 'Fights', zh: '团战' },
  tabCases: { en: 'Pro cases', zh: '职业对照' },
  viewAll: { en: 'All in one page', zh: '长页全览' },
  viewTabs: { en: 'Tabbed view', zh: '分页模式' },
  dockAsk: { en: 'Ask coach', zh: '追问教练' },
  dockProfile: { en: 'Player profile', zh: '选手档案' },
  fabAsk: { en: 'Ask coach', zh: '追问教练' },
  phase: { en: 'Phase', zh: '阶段' },
  lead: { en: 'Your lead', zh: '我方经济差' },
  change: { en: 'Change', zh: '变化' },
  buildings: { en: 'Buildings won / lost', zh: '推塔 / 丢塔' },
  fightsWL: { en: 'Fights W–L', zh: '团战 胜–负' },
  yourKD: { en: 'Your K / D', zh: '你的 杀 / 死' },
  hero: { en: 'Hero', zh: '英雄' },
  lh5: { en: 'LH 5:00', zh: '5 分正补' },
  lhdn10: { en: 'LH / DN 10:00', zh: '10 分正 / 反补' },
  gold10: { en: 'Gold 10:00', zh: '10 分经济' },
  xp10: { en: 'XP 10:00', zh: '10 分经验' },
  laneResult: { en: 'Lane result', zh: '对线结果' },
  time: { en: 'Time', zh: '时间' },
  killer: { en: 'Killer', zh: '击杀者' },
  context: { en: 'Context', zh: '场景' },
  goldLost: { en: 'Gold lost', zh: '掉金' },
  dead: { en: 'Dead for', zh: '阵亡时长' },
  after: { en: 'Then', zh: '随后' },
  objective: { en: 'enemy objective', zh: '对方拿目标' },
  ctx: {
    lane: { en: 'Lane', zh: '对线期' }, caught: { en: 'Caught alone', zh: '团战外被抓' },
    fight_won: { en: 'Fight · won', zh: '团战 · 赢' }, fight_lost: { en: 'Fight · lost', zh: '团战 · 输' }, fight_even: { en: 'Fight · even', zh: '团战 · 均势' },
    fight: { en: 'Fight', zh: '团战' }, unknown: { en: 'Unknown', zh: '无法判断' },
  },
  filterAll: { en: 'All', zh: '全部' },
  filterCaught: { en: 'Caught alone', zh: '团战外被抓' },
  filterFight: { en: 'In fights', zh: '团战中' },
  filterConverted: { en: 'Lost objective', zh: '丢了目标' },
  filterFightLost: { en: 'Lost fights', zh: '输掉的团' },
  filterUltUnused: { en: 'Ult not cast', zh: '未放大招' },
  filterAbsent: { en: 'Absent', zh: '不在场' },
  filterEmpty: { en: 'No rows match this filter.', zh: '该筛选下没有记录。' },
  dmgBy: { en: 'Hero damage you took, by source', zh: '你承受的英雄伤害（按来源）' },
  dmgType: { en: 'All damage you took, by type', zh: '你承受的全部伤害（按类型）' },
  physical: { en: 'Physical', zh: '物理' }, magic: { en: 'Magical', zh: '魔法' }, pure: { en: 'Pure', zh: '纯粹' }, other: { en: 'Other', zh: '其他' },
  vsPhys: { en: 'vs physical', zh: '防物理' }, vsMagic: { en: 'vs magic', zh: '防魔法' },
  result: { en: 'Result', zh: '结果' },
  kills: { en: 'Kills us–them', zh: '击杀 我–敌' },
  you: { en: 'You', zh: '你' },
  damage: { en: 'Damage', zh: '伤害' },
  absent: { en: 'not there', zh: '不在场' },
  diedShort: { en: 'died', zh: '阵亡' },
  won: { en: 'Won', zh: '赢' }, lost: { en: 'Lost', zh: '输' }, even: { en: 'Even', zh: '均势' },
  ult: { used: { en: 'cast', zh: '已放' }, cooldown: { en: 'on cooldown', zh: '冷却中' }, unused: { en: 'not cast', zh: '未放' } },
  why: { en: 'Why', zh: '依据' },
  check: { en: 'Next game', zh: '下一局' },
  summary: { en: 'This game in five lines', zh: '一页看完这局' },
  data: { en: 'Show the data', zh: '查看数据' },
  ask: { en: 'Ask about this', zh: '追问这部分' },
  askPrefix: {
    story: { en: 'About how the game went: ', zh: '关于比赛经过：' }, laning: { en: 'About my lane: ', zh: '关于对线：' },
    deaths: { en: 'About my deaths: ', zh: '关于我的死亡：' }, items: { en: 'About my build: ', zh: '关于出装和承伤：' },
    fights: { en: 'About the team fights: ', zh: '关于团战：' }, plan: { en: 'About the practice plan: ', zh: '关于下一局的练习：' },
    cases: { en: 'About the pro games (positive / negative): ', zh: '关于职业对局的正例和反例：' },
  },
  ctxLabel: {
    story: { en: 'How the game went', zh: '1 · 比赛经过' }, laning: { en: 'Laning', zh: '2 · 对线' },
    deaths: { en: 'Every death', zh: '3 · 逐次死亡' }, items: { en: 'Build & damage', zh: '4 · 出装与承伤' },
    fights: { en: 'Team fights', zh: '5 · 逐波团战' }, plan: { en: 'Practice plan', zh: '下一局练习' },
    cases: { en: 'Pro cases', zh: '职业对局参考' },
  },
} satisfies Record<string, Bi | Record<string, Bi>>;

const pct = (v: number) => `${Math.round(v * 100)}%`;

type Key = 'story' | 'laning' | 'deaths' | 'items' | 'fights' | 'plan' | 'cases';
const ORDER: Exclude<Key, 'plan' | 'cases'>[] = ['story', 'laning', 'deaths', 'items', 'fights'];

/** Numbers, times and percentages in a sentence, emphasised for scanning. */
export function Emph({ text }: { text: string }) {
  const parts = text.split(/(\d{1,2}:\d{2}|[−+]?\d+(?:\.\d+)?k?%?)/g);
  return <>{parts.map((p, i) => (i % 2 ? <b key={i} className="cx-num-em">{p}</b> : <React.Fragment key={i}>{p}</React.Fragment>))}</>;
}

export interface ChaptersProps {
  review: Review;
  report: CoachReport;
  pos: number | null;
  findingsSlot?: React.ReactNode;
  profileSlot?: React.ReactNode;
  jumpSignal?: ChapterJumpSignal | null;
  askTriggerSeq?: number;
}

export const Chapters: React.FC<ChaptersProps> = ({
  review,
  report,
  pos,
  findingsSlot,
  profileSlot,
  jumpSignal,
  askTriggerSeq,
}) => {
  const { L } = useLang();
  const ch = review.chapters;
  const heroById = useMemo(() => new Map(report.players.map((p) => [p.hero.id, p.hero])), [report]);
  const ask = useRef<AskHandle>(null);

  const [activeTab, setActiveTab] = useState<ChapterTab>('overview');
  const [viewAll, setViewAll] = useState(false);
  const [dockTab, setDockTab] = useState<'ask' | 'profile'>('ask');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [highlightDeath, setHighlightDeath] = useState<number | null>(null);
  const [highlightFight, setHighlightFight] = useState<number | null>(null);
  const [pendingCaseTheme, setPendingCaseTheme] = useState<string | null>(null);

  // Reset per-player tab highlights when switching hero or position.
  useEffect(() => {
    setActiveTab('overview');
    setHighlightDeath(null);
    setHighlightFight(null);
    setSheetOpen(false);
  }, [report.match.id, review.slot, pos]);

  // Handle cross-linked jumps from GoldTimeline clicks.
  useEffect(() => {
    if (!jumpSignal) return;
    setActiveTab(jumpSignal.tab);
    if (jumpSignal.tab === 'deaths' && jumpSignal.rowIndex != null) {
      setHighlightDeath(jumpSignal.rowIndex);
      window.setTimeout(() => {
        revealRow(`cx-death-row-${jumpSignal.rowIndex}`);
      }, 60);
    } else if (jumpSignal.tab === 'fights' && jumpSignal.rowIndex != null) {
      setHighlightFight(jumpSignal.rowIndex);
      window.setTimeout(() => {
        revealRow(`cx-fight-row-${jumpSignal.rowIndex}`);
      }, 60);
    }
  }, [jumpSignal]);

  // Handle top context-bar "Ask coach" button trigger.
  useEffect(() => {
    if (!askTriggerSeq) return;
    setDockTab('ask');
    if (typeof window !== 'undefined' && window.innerWidth < 1080) {
      setSheetOpen(true);
    }
    ask.current?.focus();
  }, [askTriggerSeq]);

  // Scroll to a pro-case theme once the cases tab is visible.
  useEffect(() => {
    if (!pendingCaseTheme || activeTab !== 'cases') return;
    jumpToCases(pendingCaseTheme);
    setPendingCaseTheme(null);
  }, [pendingCaseTheme, activeTab]);

  // Close mobile bottom sheet on Escape.
  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSheetOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheetOpen]);

  if (!ch) return null;
  const hasAny = ORDER.some((key) => ch[key]);
  if (!hasAny && !ch.plan.length) return null;

  const isMobile = () => typeof window !== 'undefined' && window.innerWidth < 1080;

  const onAsk = (key: Key) => {
    setDockTab('ask');
    if (isMobile()) setSheetOpen(true);
    ask.current?.prefill(L(T.askPrefix[key]), L(T.ctxLabel[key]));
  };

  const openCaseTheme = (theme: string) => {
    if (viewAll || activeTab === 'cases') { jumpToCases(theme); return; }
    // The cases panel is display:none until the tab switch commits — scroll after it renders.
    setPendingCaseTheme(theme);
    setActiveTab('cases');
  };

  const show = (tab: ChapterTab) => viewAll || activeTab === tab;

  const tabs: { id: ChapterTab; label: string; count?: number }[] = [
    { id: 'overview', label: L(T.tabOverview) },
  ];
  if (ch.laning) tabs.push({ id: 'laning', label: L(T.tabLaning) });
  if (ch.deaths) tabs.push({ id: 'deaths', label: L(T.tabDeaths), count: ch.deaths.rows.length });
  if (ch.items) tabs.push({ id: 'items', label: L(T.tabItems) });
  if (ch.fights) tabs.push({ id: 'fights', label: L(T.tabFights), count: ch.fights.rows.length });
  if (report.match.parsed) tabs.push({ id: 'cases', label: L(T.tabCases) });

  const handleSummaryClick = (e: React.MouseEvent, key: Exclude<Key, 'plan' | 'cases'>) => {
    const targetTab: ChapterTab = key === 'story' ? 'overview' : key;
    if (!viewAll && targetTab !== activeTab) {
      e.preventDefault();
      setActiveTab(targetTab);
      window.setTimeout(() => {
        document.getElementById(`cx-ch-${key}`)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      }, 40);
    }
  };

  return (
    <section className="cx-chapters" aria-label={L(T.title)}>
      <header className="cx-chapters-head">
        <div>
          <h2>{L(T.title)}</h2>
          <p className="cx-muted">{L(T.sub)}</p>
        </div>
        <button
          type="button"
          className={`cx-view-toggle ${viewAll ? 'is-on' : ''}`}
          aria-pressed={viewAll}
          onClick={() => setViewAll((v) => !v)}
        >
          {L(viewAll ? T.viewTabs : T.viewAll)}
        </button>
      </header>

      {!viewAll && (
        <div className="cx-tabbar" role="tablist" aria-label={L(T.title)}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`cx-tab ${activeTab === tab.id ? 'is-on' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span>{tab.label}</span>
              {tab.count != null && <span className="cx-tab-count">{tab.count}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="cx-workspace">
        <div className="cx-workspace-main">
          {show('overview') && (
            <>
              <nav className="cx-summary" aria-label={L(T.summary)}>
                <h3>{L(T.summary)}</h3>
                <ol>
                  {ORDER.filter((key) => ch[key]).map((key) => (
                    <li key={key}>
                      <a href={`#cx-ch-${key}`} onClick={(e) => handleSummaryClick(e, key)}>
                        <span className="cx-summary-k">{L(T[key]).replace(/^\d+ · /, '')}</span>
                        <span className="cx-summary-t"><Emph text={L(ch[key]!.takeaway)} /></span>
                      </a>
                    </li>
                  ))}
                </ol>
                {ch.plan.length > 0 && (
                  <p className="cx-summary-plan"><b>{L(T.check)}</b>{ch.plan.map((p) => L(p.title)).join(' · ')}</p>
                )}
              </nav>
              {ch.story && (
                <Story
                  ch={ch.story}
                  onAsk={() => onAsk('story')}
                  withCases={report.match.parsed}
                  onOpenCase={openCaseTheme}
                />
              )}
              {ch.plan.length > 0 && <Plan plan={ch.plan} onAsk={() => onAsk('plan')} />}
              {findingsSlot && <div className="cx-findings-slot">{findingsSlot}</div>}
            </>
          )}

          {ch.laning && show('laning') && (
            <Laning ch={ch.laning} heroById={heroById} slot={review.slot} onAsk={() => onAsk('laning')} defaultOpen={!viewAll} />
          )}

          {ch.deaths && show('deaths') && (
            <Deaths
              ch={ch.deaths}
              heroById={heroById}
              onAsk={() => onAsk('deaths')}
              defaultOpen={!viewAll || highlightDeath != null}
              highlightIndex={highlightDeath}
              jumpSeq={jumpSignal?.tab === 'deaths' ? jumpSignal.seq : undefined}
            />
          )}

          {ch.items && show('items') && (
            <Items ch={ch.items} heroById={heroById} onAsk={() => onAsk('items')} />
          )}

          {ch.fights && show('fights') && (
            <Fights
              ch={ch.fights}
              onAsk={() => onAsk('fights')}
              defaultOpen={!viewAll || highlightFight != null}
              highlightIndex={highlightFight}
              jumpSeq={jumpSignal?.tab === 'fights' ? jumpSignal.seq : undefined}
            />
          )}

          {/* Keep Cases mounted for parsed matches so pro studies prefetch in background and jump links work immediately. */}
          {report.match.parsed && (
            <div className={show('cases') ? '' : 'is-tab-hidden'}>
              <Cases matchId={String(report.match.id)} slot={review.slot} pos={pos} onAsk={() => onAsk('cases')} />
            </div>
          )}
        </div>

        <aside className={`cx-dock ${sheetOpen ? 'is-sheet-open' : ''}`} aria-label={L(T.dockAsk)}>
          {sheetOpen && <div className="cx-sheet-backdrop" role="presentation" onClick={() => setSheetOpen(false)} />}
          <div className="cx-dock-inner">
            {profileSlot && (
              <div className="cx-dock-tabs" role="tablist" aria-label="Coach panel">
                <button
                  type="button"
                  role="tab"
                  aria-selected={dockTab === 'ask'}
                  className={dockTab === 'ask' ? 'is-on' : ''}
                  onClick={() => setDockTab('ask')}
                >
                  ✦ {L(T.dockAsk)}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={dockTab === 'profile'}
                  className={dockTab === 'profile' ? 'is-on' : ''}
                  onClick={() => setDockTab('profile')}
                >
                  {L(T.dockProfile)}
                </button>
              </div>
            )}

            <div className={dockTab === 'ask' || !profileSlot ? 'cx-dock-pane' : 'is-tab-hidden'}>
              {/* One conversation per match + player + position: switching player resets it. */}
              <AskPanel
                key={`${report.match.id}-${review.slot}-${pos ?? ''}`}
                ref={ask}
                report={report}
                review={review}
                pos={pos}
                docked
                onCloseSheet={sheetOpen ? () => setSheetOpen(false) : undefined}
              />
            </div>

            {profileSlot && (
              <div className={dockTab === 'profile' ? 'cx-dock-pane cx-dock-profile' : 'is-tab-hidden'}>
                {profileSlot}
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* Mobile floating quick-ask trigger: opens the dock as a bottom sheet without losing scroll position. */}
      <button
        type="button"
        className="cx-fab-ask"
        onClick={() => { setDockTab('ask'); setSheetOpen(true); ask.current?.focus(); }}
      >
        ✦ {L(T.fabAsk)}
      </button>
    </section>
  );
};

const Chapter: React.FC<{
  id: Exclude<Key, 'plan' | 'cases'>; title: Bi; takeaway: Bi; points: Bi[]; note: Bi; onAsk: () => void;
  visual?: React.ReactNode; children?: React.ReactNode; aside?: React.ReactNode; defaultOpen?: boolean;
}> = ({ id, title, takeaway, points, note, onAsk, visual, children, aside, defaultOpen = false }) => {
  const { L } = useLang();
  return (
    <article className="cx-chapter" id={`cx-ch-${id}`} aria-labelledby={`cx-ch-${id}-h`}>
      <div className="cx-chapter-top">
        <h3 className="cx-chapter-title" id={`cx-ch-${id}-h`}>{L(title)}{aside}</h3>
        <button type="button" className="cx-askbtn" onClick={onAsk}>{L(T.ask)}</button>
      </div>
      <p className="cx-takeaway"><Emph text={L(takeaway)} /></p>
      <ul className="cx-points">
        {points.map((p, i) => <li key={i}><Emph text={L(p)} /></li>)}
      </ul>
      {visual}
      {children && (
        <details className="cx-data" open={defaultOpen || undefined}>
          <summary>{L(T.data)}</summary>
          {children}
        </details>
      )}
      <details className="cx-how">
        <summary>{L(T.how)}</summary>
        <p>{L(note)}</p>
      </details>
    </article>
  );
};

const Table: React.FC<{ head: string[]; children: React.ReactNode; label: string }> = ({ head, children, label }) => (
  <div className="cx-table-wrap" role="region" aria-label={label} tabIndex={0}>
    <table className="cx-table">
      <thead><tr>{head.map((h, i) => <th key={i} scope="col">{h}</th>)}</tr></thead>
      <tbody>{children}</tbody>
    </table>
  </div>
);

const HeroTag: React.FC<{ hero: HeroRef | undefined | null }> = ({ hero }) => {
  const { L } = useLang();
  if (!hero) return <span className="cx-nothero" title="—">—</span>;
  return (
    <span className="cx-herotag">
      {hero.icon ? <SafeImg src={hero.icon} alt="" /> : null}
      <span>{L(hero)}</span>
    </span>
  );
};

const Lead: React.FC<{ v: number }> = ({ v }) => <span className={v > 0 ? 'is-up' : v < 0 ? 'is-down' : ''}>{signedK(v)}</span>;

const WHY = {
  title: { en: 'Why it went this way', zh: '为什么会这样' },
  early: { en: 'Lanes, 0–10 min', zh: '对线期（0–10 分钟）' },
  mid: { en: 'Team fights', zh: '团战' },
  late: { en: 'Late game', zh: '后期' },
  you: { en: 'you', zh: '你' },
  todo: { en: 'What to do', zh: '怎么做' },
  pro: { en: 'Pro games on this: one that did it, one that did not ↓', zh: '看职业对局：同样的问题，一场做到了、一场没做到 ↓' },
};

/** The pro-case theme that shows the same problem, by cause. */
export const CASE_THEME_FOR: Record<string, string> = {
  'lane.1': 'laning', 'lane.2': 'laning', 'lane.3': 'laning',
  'fights.outnumbered': 'fights', 'fights.behind': 'fights', 'fights.my_ult': 'fights',
  'position.deep': 'fights', 'vision.blind': 'fights',
  'fights.carrier': 'items',
};

/** Open the row's data disclosure (the user may have collapsed it) and scroll to the row. */
function revealRow(id: string) {
  const row = document.getElementById(id);
  const details = row?.closest('details');
  if (details && !details.open) details.open = true;
  row?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
}

/** Jump to that theme once the cases have loaded; the cases chapter otherwise. */
function jumpToCases(theme: string) {
  const el = document.getElementById(`cx-case-${theme}`) ?? document.getElementById('cx-ch-cases');
  el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
}

const HEAT = {
  title: { en: 'Where you stood, pregame to 10:00 (replay positions)', zh: '开局前到 10 分钟站位（录像位置采样）' },
  yours: { en: 'your half', zh: '你们半场' },
  theirs: { en: 'their half', zh: '对方半场' },
};

/**
 * Two players' first-10-minute positions on the map, cropped to the lane.
 * Cells are OpenDota's 128-unit grid with y pointing up (Dire top-right);
 * the river runs along x + y = 256.
 */
const LaneHeatMap: React.FC<{ heat: LaneHeat }> = ({ heat }) => {
  const { L, lang } = useLang();
  const all = [...heat.me.cells, ...heat.opp.cells];
  if (!all.length) return null;
  const xs = all.map((c) => c[0]); const ys = all.map((c) => 256 - c[1]);
  const pad = 6;
  let x0 = Math.min(...xs) - pad; let x1 = Math.max(...xs) + pad;
  let y0 = Math.min(...ys) - pad; let y1 = Math.max(...ys) + pad;
  const side = Math.max(x1 - x0, y1 - y0, 40);
  const cx = (x0 + x1) / 2; const cy = (y0 + y1) / 2;
  x0 = cx - side / 2; x1 = cx + side / 2; y0 = cy - side / 2; y1 = cy + side / 2;
  const max = Math.max(...all.map((c) => c[2]));
  const dots = (cells: [number, number, number][], cls: string) => cells.map(([x, y, n], i) => (
    <circle key={`${cls}${i}`} className={cls} cx={x} cy={256 - y} r={0.8 + 1.8 * Math.sqrt(n / max)} />
  ));
  // Own half: below the river line for Radiant (x + y < 256 → screen y > x).
  const ownBelow = heat.radiant;
  const label = (pos: 'own' | 'theirs') => {
    const below = pos === 'own' ? ownBelow : !ownBelow;
    return { x: below ? x0 + side * 0.03 : x1 - side * 0.03, y: below ? y1 - side * 0.03 : y0 + side * 0.08, anchor: below ? 'start' : 'end' } as const;
  };
  const own = label('own'); const theirs = label('theirs');
  const name = (h: HeroRef) => (lang === 'zh' ? h.zh : h.en);
  return (
    <figure className="cx-heat">
      <svg viewBox={`${x0} ${y0} ${side} ${side}`} role="img"
        aria-label={`${L(HEAT.title)}: ${name(heat.me.hero)} / ${name(heat.opp.hero)}`}>
        <rect x={x0} y={y0} width={side} height={side} className="cx-heat-bg" />
        <line x1={x0} y1={x0} x2={x1} y2={x1} strokeWidth={side * 0.05} className="cx-heat-river" />
        <text x={own.x} y={own.y} textAnchor={own.anchor} fontSize={side * 0.055} className="cx-heat-label">{L(HEAT.yours)}</text>
        <text x={theirs.x} y={theirs.y} textAnchor={theirs.anchor} fontSize={side * 0.055} className="cx-heat-label">{L(HEAT.theirs)}</text>
        {dots(heat.opp.cells, 'cx-heat-opp')}
        {dots(heat.me.cells, 'cx-heat-me')}
      </svg>
      <figcaption>
        <span className="cx-heat-cap">{L(HEAT.title)}</span>
        <span><span className="cx-heat-key is-me" />{name(heat.me.hero)}</span>
        <span><span className="cx-heat-key is-opp" />{name(heat.opp.hero)}</span>
      </figcaption>
    </figure>
  );
};

const Why: React.FC<{ causes: WhyCause[]; withCases: boolean; onOpenCase: (theme: string) => void }> = ({ causes, withCases, onOpenCase }) => {
  const { L } = useLang();
  const phases = (['early', 'mid', 'late'] as const).filter((p) => causes.some((c) => c.phase === p));
  return (
    <section className="cx-why" aria-label={L(WHY.title)}>
      <h4 className="cx-why-title">{L(WHY.title)}</h4>
      {phases.map((ph) => (
        <div key={ph} className="cx-why-phase">
          <p className="cx-eyebrow">{L(WHY[ph])}</p>
          <ol className="cx-why-list">
            {causes.filter((c) => c.phase === ph).map((c) => (
              <li key={c.id} className={c.mine ? 'is-mine' : ''}>
                <p className="cx-why-cause">{L(c.title)}{c.mine && <span className="cx-tag cx-tag--new">{L(WHY.you)}</span>}</p>
                <ul className="cx-why-ev">{c.evidence.map((e, i) => <li key={i}>{L(e)}</li>)}</ul>
                {c.heat && <LaneHeatMap heat={c.heat} />}
                {c.fix && <p className="cx-do"><span>{L(WHY.todo)}</span>{L(c.fix)}</p>}
                {withCases && c.mine && CASE_THEME_FOR[c.id] && (
                  <a className="cx-why-pro" href={`#cx-case-${CASE_THEME_FOR[c.id]}`}
                    onClick={(e) => { e.preventDefault(); onOpenCase(CASE_THEME_FOR[c.id]); }}>{L(WHY.pro)}</a>
                )}
              </li>
            ))}
          </ol>
        </div>
      ))}
    </section>
  );
};

const Story: React.FC<{
  ch: NonNullable<ChaptersT['story']>;
  onAsk: () => void;
  withCases: boolean;
  onOpenCase: (theme: string) => void;
}> = ({ ch, onAsk, withCases, onOpenCase }) => {
  const { L } = useLang();
  return (
    <Chapter id="story" title={T.story} takeaway={ch.takeaway} points={ch.points} note={ch.note} onAsk={onAsk}
      visual={ch.why?.length ? <Why causes={ch.why} withCases={withCases} onOpenCase={onOpenCase} /> : undefined}>
      <Table label={L(T.story)} head={[L(T.phase), L(T.lead), L(T.change), L(T.buildings), L(T.fightsWL), L(T.yourKD)]}>
        {ch.phases.map((p) => (
          <tr key={p.key}>
            <th scope="row">{L(p.label)}</th>
            <td><Lead v={p.lead_end} /></td>
            <td><Lead v={p.swing} /></td>
            <td>{p.buildings[0]} / {p.buildings[1]}{p.roshan ? <small> · {L({ en: `Roshan ×${p.roshan}`, zh: `肉山 ×${p.roshan}` })}</small> : null}</td>
            <td>{p.fights ? `${p.fights[0]}–${p.fights[1]}` : '—'}</td>
            <td>{p.my_kd[0] ?? '—'} / {p.my_kd[1] ?? '—'}</td>
          </tr>
        ))}
      </Table>
    </Chapter>
  );
};

const Laning: React.FC<{
  ch: NonNullable<ChaptersT['laning']>;
  heroById: Map<number, HeroRef>;
  slot: number;
  onAsk: () => void;
  defaultOpen?: boolean;
}> = ({ ch, heroById, slot, onAsk, defaultOpen }) => {
  const { L } = useLang();
  const tone = ch.outcome === 'won' || ch.outcome === 'stomp' ? 'good' : ch.outcome === 'draw' ? 'even' : 'bad';
  return (
    <Chapter id="laning" title={T.laning} takeaway={ch.takeaway} points={ch.points} note={ch.note} onAsk={onAsk} defaultOpen={defaultOpen}
      aside={<span className={`cx-pill cx-pill--${tone}`}>{L(T.laneResult)} · {L(ch.outcome_label)}</span>}>
      <Table label={L(T.laning)} head={[L(T.hero), L(T.lh5), L(T.lhdn10), L(T.gold10), L(T.xp10)]}>
        {ch.rows.map((r) => (
          <tr key={r.slot} className={`${r.ally ? 'is-ally' : 'is-enemy'} ${r.slot === slot ? 'is-me' : ''}`}>
            <th scope="row"><HeroTag hero={heroById.get(r.hero)} /></th>
            <td>{r.lh5 ?? '—'}</td>
            <td>{r.lh10 ?? '—'} / {r.dn10 ?? '—'}</td>
            <td>{r.gold10 != null ? k(r.gold10) : '—'}</td>
            <td>{r.xp10 != null ? k(r.xp10) : '—'}</td>
          </tr>
        ))}
      </Table>
    </Chapter>
  );
};

type DeathFilter = 'all' | 'caught' | 'fight' | 'converted';

const Deaths: React.FC<{
  ch: NonNullable<ChaptersT['deaths']>;
  heroById: Map<number, HeroRef>;
  onAsk: () => void;
  defaultOpen?: boolean;
  highlightIndex?: number | null;
  /** Changes on every timeline jump into this chapter, including repeat jumps to the same row. */
  jumpSeq?: number;
}> = ({ ch, heroById, onAsk, defaultOpen, highlightIndex, jumpSeq }) => {
  const { L } = useLang();
  const [filter, setFilter] = useState<DeathFilter>('all');

  useEffect(() => {
    if (highlightIndex != null) setFilter('all');
  }, [highlightIndex, jumpSeq]);

  const rows = ch.rows.map((row, idx) => ({ row, idx })).filter(({ row }) => {
    if (filter === 'caught') return row.context === 'caught';
    if (filter === 'fight') return row.context.startsWith('fight');
    if (filter === 'converted') return Boolean(row.converted);
    return true;
  });

  const filters: { id: DeathFilter; label: Bi }[] = [
    { id: 'all', label: T.filterAll },
    { id: 'caught', label: T.filterCaught },
    { id: 'fight', label: T.filterFight },
    { id: 'converted', label: T.filterConverted },
  ];

  return (
    <Chapter id="deaths" title={T.deaths} takeaway={ch.takeaway} points={ch.points} note={ch.note} onAsk={onAsk} defaultOpen={defaultOpen || filter !== 'all'}>
      <div className="cx-filter-bar" role="group" aria-label={L(T.deaths)}>
        {filters.map((f) => (
          <button key={f.id} type="button" className={`cx-filter-pill ${filter === f.id ? 'is-on' : ''}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {L(f.label)}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="cx-muted">{L(T.filterEmpty)}</p>
      ) : (
        <Table label={L(T.deaths)} head={[L(T.time), L(T.killer), L(T.context), L(T.goldLost), L(T.dead), L(T.after)]}>
          {rows.map(({ row: d, idx }) => (
            <tr key={idx} id={`cx-death-row-${idx}`} className={`ctx-${d.context} ${highlightIndex === idx ? 'is-highlighted' : ''}`}>
              <th scope="row">{clock(d.time)}</th>
              <td><HeroTag hero={d.killer != null ? heroById.get(d.killer) : null} /></td>
              <td><span className="cx-ctx">{L(T.ctx[d.context])}</span></td>
              <td>{d.gold_lost != null ? d.gold_lost : '—'}</td>
              <td>{d.time_dead != null ? `${d.time_dead}s` : '—'}</td>
              <td>{d.converted ? L(T.objective) : ''}</td>
            </tr>
          ))}
        </Table>
      )}
    </Chapter>
  );
};

const Items: React.FC<{ ch: NonNullable<ChaptersT['items']>; heroById: Map<number, HeroRef>; onAsk: () => void }> = ({ ch, heroById, onAsk }) => {
  const { L } = useLang();
  const dmg = ch.damage;
  const max = dmg?.by_hero[0]?.share ?? 1;
  return (
    <Chapter id="items" title={T.items} takeaway={ch.takeaway} points={ch.points} note={ch.note} onAsk={onAsk} visual={<>
      {dmg && dmg.by_hero.length > 0 && (
        <div className="cx-dmg">
          <p className="cx-dmg-label">{L(T.dmgBy)}</p>
          <ul className="cx-dmg-bars">
            {dmg.by_hero.map((x) => (
              <li key={x.hero}>
                <HeroTag hero={heroById.get(x.hero)} />
                <span className="cx-bar" aria-hidden><i style={{ width: `${Math.max(2, (x.share / max) * 100)}%` }} /></span>
                <span className="cx-dmg-val">{k(x.amount)} <small>{pct(x.share)}</small></span>
              </li>
            ))}
          </ul>
          {dmg.types && (
            <>
              <p className="cx-dmg-label">{L(T.dmgType)}</p>
              <div className="cx-split" role="img" aria-label={(['physical', 'magic', 'pure', 'other'] as const).map((key) => `${L(T[key])} ${pct(dmg.types![key])}`).join(', ')}>
                {(['physical', 'magic', 'pure', 'other'] as const).filter((key) => dmg.types![key] >= 0.01).map((key) => (
                  <span key={key} className={`cx-split-${key}`} style={{ flexGrow: dmg.types![key] }}>
                    {dmg.types![key] >= 0.12 ? `${L(T[key])} ${pct(dmg.types![key])}` : ''}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      )}
      {ch.rows.length > 0 && (
        <ol className="cx-buildline">
          {ch.rows.map((r) => (
            <li key={`${r.item.key}-${r.time}`}>
              <time>{clock(r.time)}</time>
              {r.item.img ? <SafeImg src={r.item.img} alt="" /> : <span className="cx-img-missing" />}
              <span>{L(r.item)}</span>
              {r.vs.map((v) => <em key={v} className={`cx-vs cx-vs--${v}`}>{L(v === 'physical' ? T.vsPhys : T.vsMagic)}</em>)}
            </li>
          ))}
        </ol>
      )}
    </>} />
  );
};

type FightFilter = 'all' | 'lost' | 'ult_unused' | 'absent';

const Fights: React.FC<{
  ch: NonNullable<ChaptersT['fights']>;
  onAsk: () => void;
  defaultOpen?: boolean;
  highlightIndex?: number | null;
  /** Changes on every timeline jump into this chapter, including repeat jumps to the same row. */
  jumpSeq?: number;
}> = ({ ch, onAsk, defaultOpen, highlightIndex, jumpSeq }) => {
  const { L } = useLang();
  const [filter, setFilter] = useState<FightFilter>('all');

  useEffect(() => {
    if (highlightIndex != null) setFilter('all');
  }, [highlightIndex, jumpSeq]);

  const head = [L(T.time), L(T.result), L(T.kills), L(T.you), L(T.damage)];
  if (ch.ultimate) head.push(L(ch.ultimate));

  const rows = ch.rows.map((row, idx) => ({ row, idx })).filter(({ row }) => {
    if (filter === 'lost') return row.result === 'lost';
    if (filter === 'ult_unused') return row.ult_state === 'unused';
    if (filter === 'absent') return !row.present;
    return true;
  });

  const filters: { id: FightFilter; label: Bi }[] = [
    { id: 'all', label: T.filterAll },
    { id: 'lost', label: T.filterFightLost },
    ...(ch.ultimate ? [{ id: 'ult_unused' as const, label: T.filterUltUnused }] : []),
    { id: 'absent', label: T.filterAbsent },
  ];

  return (
    <Chapter id="fights" title={T.fights} takeaway={ch.takeaway} points={ch.points} note={ch.note} onAsk={onAsk} defaultOpen={defaultOpen || filter !== 'all'}>
      <div className="cx-filter-bar" role="group" aria-label={L(T.fights)}>
        {filters.map((f) => (
          <button key={f.id} type="button" className={`cx-filter-pill ${filter === f.id ? 'is-on' : ''}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {L(f.label)}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="cx-muted">{L(T.filterEmpty)}</p>
      ) : (
        <Table label={L(T.fights)} head={head}>
          {rows.map(({ row: f, idx }) => (
            <tr key={idx} id={`cx-fight-row-${idx}`} className={`res-${f.result} ${f.present ? '' : 'is-absent'} ${highlightIndex === idx ? 'is-highlighted' : ''}`}>
              <th scope="row">{clock(f.start)}</th>
              <td><span className={`cx-res cx-res--${f.result}`}>{L(T[f.result])}</span></td>
              <td>{f.kills[0]}–{f.kills[1]}</td>
              <td>{f.present ? (f.died ? L(T.diedShort) : '✓') : L(T.absent)}</td>
              <td>{f.present ? k(f.damage) : '—'}</td>
              {ch.ultimate && <td>{f.ult_state ? L(T.ult[f.ult_state]) : f.ult_used ? L(T.ult.used) : '—'}</td>}
            </tr>
          ))}
        </Table>
      )}
    </Chapter>
  );
};

const Plan: React.FC<{ plan: ChaptersT['plan']; onAsk: () => void }> = ({ plan, onAsk }) => {
  const { L } = useLang();
  return (
    <article className="cx-chapter cx-plan" id="cx-ch-plan">
      <div className="cx-chapter-top">
        <h3 className="cx-chapter-title">{L(T.plan)}</h3>
        <button type="button" className="cx-askbtn" onClick={onAsk}>{L(T.ask)}</button>
      </div>
      <ol>
        {plan.map((p) => (
          <li key={p.key}>
            <h4>{L(p.title)}</h4>
            <p><span className="cx-plan-k">{L(T.why)}</span><Emph text={L(p.why)} /></p>
            <p><span className="cx-plan-k">{L(T.check)}</span><Emph text={L(p.check)} /></p>
          </li>
        ))}
      </ol>
    </article>
  );
};
