import React, { useEffect, useState } from 'react';
import { fetchEvidence, type EvidenceItem, type EvidenceRecord } from './api';

/**
 * Evidence under a finding: the coach's sentence, and — one click away — the
 * replay record it cites, recomputed by the server from the trace. The reader
 * checks the claim against the record, not against the model.
 */

type Lang = 'en' | 'zh';
const T = {
  show: { en: 'Show the record', zh: '看原始记录' },
  hide: { en: 'Hide', zh: '收起' },
  ask: { en: 'Ask about this', zh: '就这一刻追问' },
  loading: { en: 'Loading the record…', zh: '正在取记录…' },
  failed: { en: 'Could not load this record.', zh: '这条记录没有取到。' },
  killer: { en: 'Killed by', zh: '击杀者' },
  before: { en: 'before death', zh: '阵亡前' },
  me: { en: 'You', zh: '你' },
  allies: { en: 'Allies within 2200', zh: '2200 码内队友' },
  enemies: { en: 'Enemies within 2200', zh: '2200 码内敌人' },
  nobody: { en: 'none', zh: '无' },
  readyUnused: { en: 'Ready, not used', zh: '就绪未用' },
  disables: { en: 'Disables that landed', zh: '吃到的控制' },
  damage: { en: 'Damage taken', zh: '承受伤害' },
  attack: { en: 'attacks', zh: '普攻' },
  target: { en: 'Target', zh: '目标' },
  immune: { en: 'spell immune', zh: '技能免疫中' },
  notImmune: { en: 'not spell immune', zh: '未免疫' },
  stunned: { en: 'stunned', zh: '被晕' },
  noStun: { en: 'no stun landed', zh: '没有晕住' },
  after: { en: 'Deaths in the next 12 s', zh: '之后 12 秒内阵亡' },
  near: { en: 'Near you', zh: '你身边' },
  window: { en: 'Spell immunity', zh: '技能免疫' },
  ult: { en: 'Your ultimate when it opened', zh: '开启时你的大招' },
  states: { ready: { en: 'ready', zh: '就绪' }, on_cooldown: { en: 'on cooldown', zh: '冷却中' }, dead: { en: 'you were dead', zh: '你已阵亡' }, not_learned: { en: 'not learned', zh: '未学' }, unknown: { en: 'unknown', zh: '未知' } } as Record<string, Record<Lang, string>>,
  lastCast: { en: 'last cast', zh: '上一次施放' },
  castDuring: { en: 'Cast on them during the window', zh: '窗口内对其施放' },
  yes: { en: 'yes', zh: '是' }, no: { en: 'no', zh: '否' },
  fight: { en: 'Fight', zh: '团战' },
  lost: { en: 'heroes lost', zh: '阵亡' },
  mine: { en: 'Your team', zh: '我方' }, theirs: { en: 'Enemy', zh: '敌方' },
  gold: { en: 'Your team\'s gold lead', zh: '我方经济领先' },
  goldAfter: { en: '2 min later', zh: '两分钟后' },
  firstDeath: { en: 'Positions at the first death', zh: '首个阵亡时的站位' },
  start: { en: 'Positions at the start', zh: '开始时的站位' },
  events: { en: 'What happened', zh: '经过' },
  dealt: { en: 'Damage to heroes', zh: '对英雄伤害' },
  firstHeld: { en: 'First held', zh: '首次持有' },
  watching: { en: 'watching', zh: '观察' },
  proShare: { en: 'of pro games', zh: '职业局' },
  never: { en: 'never held', zh: '从未持有' },
  pierces: { en: 'goes through spell immunity', zh: '无视技能免疫' },
  noPierce: { en: 'blocked by spell immunity', zh: '被技能免疫挡住' },
  ultimate: { en: 'ultimate', zh: '大招' },
  sec: { en: 's', zh: '秒' },
  lane: { top: { en: 'Top lane', zh: '上路' }, mid: { en: 'Mid lane', zh: '中路' }, bot: { en: 'Bottom lane', zh: '下路' } } as Record<string, Record<Lang, string>>,
  laneAt10: { en: 'at 10:00', zh: '10 分钟时' },
  laneResult: { 'won big': { en: 'won big', zh: '大优' }, won: { en: 'won', zh: '优势' }, even: { en: 'even', zh: '均势' }, lost: { en: 'lost', zh: '劣势' }, 'lost badly': { en: 'lost badly', zh: '大劣' } } as Record<string, Record<Lang, string>>,
  laneCols: { en: ['Hero', 'LH 5:00', 'LH 10:00', 'Denies', 'Gold', 'XP'], zh: ['英雄', '5 分补刀', '10 分补刀', '反补', '金钱', '经验'] },
  laneDeaths: { en: 'Deaths before 10:00', zh: '10 分钟前阵亡' },
  laneNoEconomy: { en: 'No per-minute gold or last hits for this game.', zh: '这局没有逐分钟的金钱和补刀数据。' },
  lanePro: { en: 'pro games, core vs core at 10:00', zh: '场职业局，双方核心 10 分钟经济差' },
  laneProMean: { en: 'usually', zh: '通常' }, laneThis: { en: 'this game', zh: '这局' }, laneAhead: { en: 'ahead in', zh: '领先的比例' },
  lanePub: { en: 'lanes in public games of this bracket (STRATZ)', zh: '条同分段路人局对线（STRATZ）' },
  lanePubWon: { en: 'won', zh: '赢' }, lanePubLost: { en: 'lost', zh: '输' },
  tempoCols: { en: ['Stretch', 'Buildings taken', 'Buildings lost', 'Team deaths', 'Enemy deaths'], zh: ['阶段', '拆掉建筑', '丢掉建筑', '己方阵亡', '对方阵亡'] },
  tempoWon: { en: 'Fights with fewer heroes lost', zh: '少死人的团战' },
  tempoLost: { en: 'Fights with more heroes lost', zh: '多死人的团战' },
  tempoThen: { en: 'a building within 2 min after', zh: '之后两分钟内拆到建筑' },
  tempoThere: { en: 'Fights this hero was at', zh: '该英雄在场的团战' },
  tempoHit: { en: 'Buildings taken that this hero damaged', zh: '拆掉的建筑里该英雄打过的' },
  tempoFirst: { en: 'First building', zh: '首个建筑' },
  tempoTeams: { team: { en: 'this side', zh: '己方' }, opponents: { en: 'other side', zh: '对方' } } as Record<string, Record<Lang, string>>,
  tempoShare: {
    on_own_side_of_the_map: { en: 'On own side of the map', zh: '在己方半场' }, around_the_river: { en: 'Around the river', zh: '在河道一带' }, on_the_opponents_side: { en: 'On the other side', zh: '在对方半场' },
    with_no_ally_within_2200: { en: 'No ally within 2200', zh: '2200 码内没有队友' }, with_one_ally_within_2200: { en: 'One ally near', zh: '身边一名队友' }, with_two_or_more_allies_within_2200: { en: 'Two or more allies near', zh: '身边两名以上队友' },
    with_three_or_more_opponents_within_2200: { en: 'Three or more enemies near', zh: '身边三名以上敌人' },
  } as Record<string, Record<Lang, string>>,
  tempoAlive: { en: 'of the time alive', zh: '占存活时间' },
  tempoMost: { en: 'Most time in', zh: '停留最多' },
  tempoDamage: { en: 'Damage to buildings', zh: '对建筑伤害' },
  tempoOfTeam: { en: 'of the team\'s heroes\'', zh: '队伍英雄合计' },
  tempoFights: { en: 'Fights', zh: '团战' },
  tempoAway: { en: 'not there', zh: '不在场' },
  tempoBuildings: { en: 'Buildings', zh: '建筑' },
  timingCols: { en: ['Hero', 'Under 35 min', '35–45 min', '45 min or more', 'Wins more in'], zh: ['英雄', '35 分钟内', '35–45 分钟', '45 分钟以上', '更常赢在'] },
  timingLean: { shorter_games: { en: 'shorter games', zh: '短局' }, longer_games: { en: 'longer games', zh: '长局' }, neither: { en: 'no clear lean', zh: '无明显倾向' } } as Record<string, Record<Lang, string>>,
  timingSides: { my_team: { en: 'Your team', zh: '我方' }, enemy: { en: 'Enemy', zh: '敌方' }, radiant: { en: 'Radiant', zh: '天辉' }, dire: { en: 'Dire', zh: '夜魇' } } as Record<string, Record<Lang, string>>,
  timingMean: { en: 'mean of the five', zh: '五人平均' },
  timingThis: { en: 'This game', zh: '这局' },
  timingPublic: { en: 'public games, win rate by game length', zh: '路人局，按比赛时长的胜率' },
  timingAlone: { en: 'Each hero on its own: not a line-up\'s win rate.', zh: '每个英雄单独统计，不代表整套阵容的胜率。' },
  building: {
    tower: { en: 'tier-{n} tower', zh: '{n} 塔' }, melee_rax: { en: 'melee barracks', zh: '近战兵营' }, range_rax: { en: 'ranged barracks', zh: '远程兵营' }, fort: { en: 'Ancient', zh: '遗迹' },
    top: { en: 'top', zh: '上路' }, mid: { en: 'mid', zh: '中路' }, bot: { en: 'bottom', zh: '下路' },
  } as Record<string, Record<Lang, string>>,
} as const;

/** A building's engine key ("badguys_tower1_mid") in words: which kind, which lane. The side is told by the column it stands in. */
export function buildingLabel(key: string, lang: Lang): string {
  const m = key.match(/_(tower(\d)|melee_rax|range_rax|fort)(?:_(top|mid|bot))?$/);
  if (!m) return pretty(key);
  const kind = m[2] ? T.building.tower[lang].replace('{n}', m[2]) : T.building[m[1]][lang];
  const lane = m[3] ? T.building[m[3]][lang] : '';
  // Chinese sets a digit off from the words around it ("中路 1 塔"); a barracks has none ("下路远程兵营").
  return lang === 'zh' ? `${lane}${lane && m[2] ? ' ' : ''}${kind}` : [lane, kind].filter(Boolean).join(' ');
}

/** What a tool's totals are called. A key not listed here is shown as it is, with spaces. */
const TOTALS: Record<string, Record<Lang, string>> = {
  learned_at: { en: 'Learned at', zh: '学会于' },
  casts_total: { en: 'Casts', zh: '施放次数' },
  by_target: { en: 'On', zh: '目标' },
  casts_on_spell_immune_target: { en: 'Cast on a spell-immune target', zh: '施放在技能免疫目标上' },
  of_those_target_was_stunned: { en: 'of those, the target was stunned', zh: '其中目标仍被眩晕' },
  seconds_alive_since_learned: { en: 'Seconds alive since learned', zh: '学会后存活秒数' },
  seconds_alive_and_ready: { en: 'Seconds alive with it ready', zh: '存活且技能就绪秒数' },
  deaths_with_it_ready_and_not_cast_total: { en: 'Deaths with it ready and not cast', zh: '技能就绪未放就阵亡' },
  window: { en: 'Seconds before each death', zh: '每次阵亡前秒数' },
  deaths_total: { en: 'Deaths', zh: '阵亡次数' },
  killed_by: { en: 'Killed by', zh: '击杀者' },
  windows_total: { en: 'Spell-immunity windows', zh: '技能免疫次数' },
  watched_state_when_window_opened: { en: 'When it opened, the watched ability was', zh: '开启时所观察技能' },
  windows_with_a_cast_on_the_immune_hero: { en: 'Windows with a cast on the immune hero', zh: '期间对免疫目标施放' },
  on_cooldown: { en: 'on cooldown', zh: '冷却中' }, ready: { en: 'ready', zh: '就绪' }, dead: { en: 'caster dead', zh: '施法者已阵亡' },
  not_learned: { en: 'not learned', zh: '未学' }, no_mana: { en: 'no mana', zh: '没蓝' },
  damage_in_death_windows_total: { en: 'Damage taken before the deaths', zh: '各次阵亡前承受的伤害' },
  damage_share_in_death_windows: { en: 'Share of it', zh: '其中' },
  attacks: { en: 'attacks', zh: '普通攻击' }, 'abilities and items': { en: 'abilities and items', zh: '技能和物品' },
  health_below_half_at_window_start: { en: 'Deaths that began below half health', zh: '起步不到半血的阵亡' },
  no_ally_within_2200_throughout: { en: 'Deaths with no ally within 2200 throughout', zh: '全程 2200 码内没有队友的阵亡' },
  no_ally_within_2200_at_death: { en: 'Deaths with no ally within 2200 at the end', zh: '阵亡时 2200 码内没有队友' },
  three_or_more_enemy_heroes_dealing_damage: { en: 'Deaths to three or more enemy heroes', zh: '被三个以上敌方英雄打死' },
  target_spell_immune_and_not_stunned: { en: 'Casts on a spell-immune target, no stun', zh: '放给魔免目标且没晕住' },
  enemy_hero_target_alive_12s_later: { en: 'Casts whose target was alive 12 s later', zh: '放出 12 秒后目标仍存活' },
  no_hero_target_and_at_most_one_enemy_hero_damaged: { en: 'Casts that damaged at most one enemy hero', zh: '至多只伤到一名敌方英雄' },
  nothing_cast_and_no_item_used: { en: 'Deaths with nothing cast or used', zh: '什么都没按就阵亡' },
};

const pretty = (key: string) => key.replace(/^modifier_/, '').replace(/^item_/, '').replace(/_/g, ' ');
const SIDE_CLASS: Record<string, string> = { me: 'is-me', ally: 'is-ally', enemy: 'is-enemy' };

/** World units → a 0..1 square with Radiant bottom-left. */
const WORLD = 8600;
const mapX = (x: number) => (x + WORLD) / (2 * WORLD);
const mapY = (y: number) => 1 - (y + WORLD) / (2 * WORLD);

export const MiniMap: React.FC<{ heroes: { hero: string; side?: string; alive?: boolean | null; x?: number; y?: number }[]; N: (k: string) => string; label: string }> = ({ heroes, N, label }) => {
  const S = 220;
  return (
    <figure className="ag-map">
      <svg viewBox={`0 0 ${S} ${S}`} role="img" aria-label={label}>
        <rect x="0" y="0" width={S} height={S} rx="6" className="ag-map-bg" />
        <line x1="0" y1="0" x2={S} y2={S} className="ag-map-river" />
        <rect x="4" y={S - 34} width="30" height="30" rx="4" className="ag-map-base is-radiant" />
        <rect x={S - 34} y="4" width="30" height="30" rx="4" className="ag-map-base is-dire" />
        {heroes.filter((h) => typeof h.x === 'number' && typeof h.y === 'number').map((h) => (
          <g key={h.hero} className={`ag-map-dot ${SIDE_CLASS[h.side ?? ''] ?? ''} ${h.alive === false ? 'is-dead' : ''}`}>
            <circle cx={mapX(h.x!) * S} cy={mapY(h.y!) * S} r={h.side === 'me' ? 6 : 4.5}><title>{N(h.hero)}</title></circle>
          </g>
        ))}
      </svg>
      <figcaption>{label}</figcaption>
    </figure>
  );
};

const Bar: React.FC<{ label: string; value: number; max: number }> = ({ label, value, max }) => (
  <li className="ag-bar">
    <span className="ag-bar-label">{label}</span>
    <span className="ag-bar-track"><span style={{ width: `${Math.max(3, Math.round((value / Math.max(1, max)) * 100))}%` }} /></span>
    <span className="ag-bar-value">{value}</span>
  </li>
);

function Record({ data, lang }: { data: EvidenceRecord; lang: Lang }) {
  const t = (b: Record<Lang, string>) => b[lang];
  const N = (key: string | null | undefined) => (key ? data.names[key] ?? data.names[key.replace(/^item_/, '')] ?? pretty(key) : '—');
  const r = data.record;
  const chips = (list: { hero: string; dist?: number }[]) => (list.length ? list.map((h) => <span key={h.hero} className="ag-chip">{N(h.hero)}{h.dist != null && <em>{h.dist}</em>}</span>) : <span className="ag-none">{t(T.nobody)}</span>);

  if (data.kind === 'death') {
    const max = Math.max(...r.damage_taken.map((d: any) => d.value), 1);
    return (
      <div className="ag-rec">
        <p className="ag-rec-head"><b>{r.clock}</b> · {t(T.killer)} {N(r.killer)}</p>
        <table className="ag-snap">
          <thead><tr><th /><th>{t(T.me)}</th><th>{t(T.allies)}</th><th>{t(T.enemies)}</th></tr></thead>
          <tbody>
            {r.snapshots.map((s: any) => (
              <tr key={s.dt}>
                <th>{-s.dt}{t(T.sec)} {t(T.before)}</th>
                <td>{s.me ? `${s.me.hp}/${s.me.max_hp}` : '—'}</td>
                <td>{chips(s.allies)}</td>
                <td>{chips(s.enemies)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {r.ready_not_cast.length > 0 && <p className="ag-rec-line"><span>{t(T.readyUnused)}</span>{r.ready_not_cast.map((a: string) => <span key={a} className="ag-chip is-warn">{N(a)}</span>)}</p>}
        {r.controls_on_me.length > 0 && <p className="ag-rec-line"><span>{t(T.disables)}</span>{r.controls_on_me.map((c: any, i: number) => <span key={i} className="ag-chip">{N(c.modifier)} · {N(c.from)}{c.duration ? ` · ${c.duration}${t(T.sec)}` : ''}</span>)}</p>}
        <p className="ag-rec-sub">{t(T.damage)}</p>
        <ul className="ag-bars">{r.damage_taken.slice(0, 5).map((d: any, i: number) => <Bar key={i} label={`${N(d.from)} · ${d.by === 'attack' ? t(T.attack) : N(d.by)}`} value={d.value} max={max} />)}</ul>
      </div>
    );
  }
  if (data.kind === 'cast') {
    return (
      <div className="ag-rec">
        <p className="ag-rec-head"><b>{r.clock}</b> · {t(T.target)} {N(r.target)}{r.target_hp && <em> {r.target_hp.hp}/{r.target_hp.max_hp}</em>}</p>
        <p className="ag-rec-line">
          {r.target_spell_immune != null && <span className={`ag-chip ${r.target_spell_immune ? 'is-warn' : ''}`}>{t(r.target_spell_immune ? T.immune : T.notImmune)}</span>}
          {r.target_stunned_seconds != null && <span className={`ag-chip ${r.target_stunned_seconds > 0 ? 'is-good' : 'is-warn'}`}>{r.target_stunned_seconds > 0 ? `${t(T.stunned)} ${r.target_stunned_seconds}${t(T.sec)}` : t(T.noStun)}</span>}
        </p>
        <p className="ag-rec-line"><span>{t(T.near)}</span>{[...r.allies_within_1300.map((h: string) => ({ hero: h, c: 'is-ally' })), ...r.enemies_within_1300.map((h: string) => ({ hero: h, c: 'is-enemy' }))].map((h) => <span key={h.hero} className={`ag-chip ${h.c}`}>{N(h.hero)}</span>)}</p>
        <p className="ag-rec-line"><span>{t(T.after)}</span>{r.deaths_within_12s.length ? r.deaths_within_12s.map((d: any, i: number) => <span key={i} className={`ag-chip ${SIDE_CLASS[d.side] ?? ''}`}>{N(d.hero)} <em>+{d.dt}{t(T.sec)}</em></span>) : <span className="ag-none">{t(T.nobody)}</span>}</p>
      </div>
    );
  }
  if (data.kind === 'immune') {
    const w = r.watched;
    return (
      <div className="ag-rec">
        <p className="ag-rec-head"><b>{r.clock}</b> · {N(r.hero)} · {t(T.window)}{r.seconds != null && ` ${r.seconds}${t(T.sec)}`}</p>
        {w && (
          <>
            <p className="ag-rec-line"><span>{t(T.ult)}</span><span className={`ag-chip ${w.state === 'ready' ? 'is-good' : 'is-warn'}`}>{t(T.states[w.state] ?? T.states.unknown)}{w.cooldown_left ? ` · ${w.cooldown_left}${t(T.sec)}` : ''}</span></p>
            {w.last_cast && <p className="ag-rec-line"><span>{t(T.lastCast)}</span><span className="ag-chip">{w.last_cast.clock} → {N(w.last_cast.target)} <em>−{w.last_cast.seconds_before}{t(T.sec)}</em></span></p>}
            <p className="ag-rec-line"><span>{t(T.castDuring)}</span><span className={`ag-chip ${w.cast_on_this_hero_during.length ? 'is-good' : ''}`}>{w.cast_on_this_hero_during.length ? `${t(T.yes)} · ${w.cast_on_this_hero_during.map((c: any) => c.clock).join(', ')}` : t(T.no)}</span></p>
          </>
        )}
      </div>
    );
  }
  if (data.kind === 'fight') {
    return (
      <div className="ag-rec">
        <p className="ag-rec-head"><b>{r.clock}</b> · {t(T.fight)}</p>
        <p className="ag-rec-line"><span>{t(T.lost)}</span><span className="ag-chip is-ally">{t(T.mine)} {r.my_team_deaths}</span><span className="ag-chip is-enemy">{t(T.theirs)} {r.enemy_deaths}</span></p>
        {r.my_team_gold_lead_before != null && <p className="ag-rec-line"><span>{t(T.gold)}</span><span className="ag-chip">{r.my_team_gold_lead_before}</span><span className="ag-chip">{t(T.goldAfter)} {r.my_team_gold_lead_2min_after ?? '—'}</span></p>}
        <p className="ag-rec-line">{r.victims.map((v: any, i: number) => <span key={i} className={`ag-chip ${SIDE_CLASS[v.side] ?? ''}`}>{N(v.hero)}</span>)}</p>
      </div>
    );
  }
  if (data.kind === 'timeline') {
    const pos = r.positions_at_first_death?.heroes ?? r.positions_at_start;
    // Deaths, immunity and buildings always show; casts on a hero and key items fill what room is left, in order.
    const key = (e: any) => e.kind === 'death' || e.kind === 'spell_immune' || e.kind === 'building';
    const room = Math.max(0, 48 - r.events.filter(key).length);
    let extra = 0;
    const rows = r.events.filter((e: any) => key(e) || ((e.kind !== 'cast' || e.target) && (extra += 1) <= room));
    const max = Math.max(...r.damage_to_heroes_by_unit.map((d: any) => d.value), 1);
    return (
      <div className="ag-rec ag-rec--split">
        <MiniMap heroes={pos} N={N as (k: string) => string} label={r.positions_at_first_death ? `${t(T.firstDeath)} · ${r.positions_at_first_death.clock}` : t(T.start)} />
        <div>
          <p className="ag-rec-sub">{t(T.events)} · {r.clock}</p>
          <ol className="ag-events">
            {rows.map((e: any, i: number) => (
              <li key={i} className={`is-${e.kind} ${SIDE_CLASS[e.side] ?? ''}`}>
                <time>{e.clock}</time>
                {e.kind === 'death' && <span><b className="ag-x" aria-hidden="true">✕</b> {N(e.hero)} ← {N(e.killer)}</span>}
                {e.kind === 'spell_immune' && <span>{N(e.hero)} · {t(T.window)}</span>}
                {e.kind === 'item' && <span>{N(e.hero)} · {N(e.item)}</span>}
                {e.kind === 'cast' && <span>{N(e.hero)} · {N(e.ability)} → {N(e.target)}</span>}
                {e.kind === 'building' && <span>{pretty(e.building)}</span>}
              </li>
            ))}
          </ol>
          <p className="ag-rec-sub">{t(T.dealt)}</p>
          <ul className="ag-bars">{r.damage_to_heroes_by_unit.slice(0, 4).map((d: any) => <Bar key={d.unit} label={N(d.unit)} value={d.value} max={max} />)}</ul>
        </div>
      </div>
    );
  }
  if (data.kind === 'item') return <div className="ag-rec"><p className="ag-rec-head"><b>{r.first_held.clock}</b> · {N(r.item)} · {t(T.firstHeld)}</p></div>;
  if (data.kind === 'lane') {
    const pc = (v: number) => `${Math.round(v * 100)}%`;
    const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}`;
    const pro = r.same_cores_in_pro_games; const pub = r.same_lane_in_public_games_of_this_bracket;
    return (
      <div className="ag-rec">
        {r.lane
          ? <p className="ag-rec-head">{T.lane[r.lane] ? t(T.lane[r.lane]) : r.lane} · {t(T.laneAt10)} {r.lane_gold_at_10_00.my_team} : {r.lane_gold_at_10_00.enemy}{r.lane_result && T.laneResult[r.lane_result] ? <> · <b>{t(T.laneResult[r.lane_result])}</b></> : null}</p>
          : <p className="ag-rec-note">{t(T.laneNoEconomy)}</p>}
        {r.lane && (
          <div className="ag-lane-scroll">
            <table className="ag-lane">
              <thead><tr>{T.laneCols[lang].map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
              <tbody>
                {Object.entries(r.heroes_in_lane as Record<string, string>).map(([h, side]) => (
                  <tr key={h} className={SIDE_CLASS[side] ?? ''}>
                    <th scope="row">{N(h)}</th>
                    {['last_hits_at_5_00', 'last_hits_at_10_00', 'denies_at_10_00', 'gold_at_10_00', 'xp_at_10_00'].map((m) => <td key={m}>{r[m]?.[h] ?? '–'}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {r.my_deaths_before_10_00.length > 0 && <p className="ag-rec-line"><span>{t(T.laneDeaths)}</span>{r.my_deaths_before_10_00.map((d: any) => <span key={d.clock} className="ag-chip">{d.clock}{d.killer ? ` ← ${N(d.killer)}` : ''}</span>)}</p>}
        {pro && <p className="ag-rec-line"><span>{N(pro.my_side_core)} : {N(pro.enemy_core)} · {pro.pro_games} {t(T.lanePro)}</span><span className="ag-chip">{t(T.laneProMean)} <em>{signed(pro.core_gold_difference_at_10_00.mean)}</em></span><span className="ag-chip">{t(T.laneThis)} <em>{signed(pro.core_gold_difference_at_10_00.this_game)}</em></span><span className="ag-chip">{N(pro.my_side_core)} {t(T.laneAhead)} <em>{pc(pro.share_of_pro_games_my_side_core_was_ahead)}</em></span></p>}
        {pub && <p className="ag-rec-line"><span>{N(pub.hero)} : {N(pub.against)} · {pub.lanes} {t(T.lanePub)}</span><span className="ag-chip">{t(T.lanePubWon)} <em>{pc(pub.share_won)}</em></span><span className="ag-chip">{t(T.lanePubLost)} <em>{pc(pub.share_lost)}</em></span></p>}
      </div>
    );
  }
  if (data.kind === 'tempo') {
    const w = r.fights_where; const hit = r.buildings_team_took_where;
    return (
      <div className="ag-rec">
        <p className="ag-rec-head">{N(r.hero)} · {r.duration.clock}</p>
        <div className="ag-lane-scroll">
          <table className="ag-lane">
            <thead><tr>{T.tempoCols[lang].map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
            <tbody>
              {Object.keys(r.buildings_team_took_by_phase as Record<string, number>).map((p) => (
                <tr key={p}>
                  <th scope="row">{p}</th>
                  {['buildings_team_took_by_phase', 'buildings_opponents_took_by_phase', 'team_hero_deaths_by_phase', 'opponents_hero_deaths_by_phase'].map((m) => <td key={m}>{r[m]?.[p] ?? '–'}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="ag-rec-line"><span>{t(T.tempoFirst)}</span>{(['by_team', 'by_opponents'] as const).map((k) => <span key={k} className="ag-chip">{t(T.tempoTeams[k.slice(3)])} <em>{r.first_building_taken[k] ?? '–'}</em></span>)}</p>
        <p className="ag-rec-line"><span>{t(T.tempoWon)}</span><span className="ag-chip">{w.team_lost_fewer_heroes.length}</span><span className="ag-chip">{t(T.tempoThen)} <em>{w.team_lost_fewer_heroes_and_took_a_building_within_120s.length}</em></span></p>
        <p className="ag-rec-line"><span>{t(T.tempoLost)}</span><span className="ag-chip">{w.opponents_lost_fewer_heroes.length}</span><span className="ag-chip">{t(T.tempoThen)} <em>{w.opponents_lost_fewer_heroes_and_took_a_building_within_120s.length}</em></span></p>
        <p className="ag-rec-line"><span>{t(T.tempoThere)}</span><span className="ag-chip">{w.hero_was_there.length} / {r.fights_total}</span></p>
        <p className="ag-rec-line"><span>{t(T.tempoHit)}</span><span className="ag-chip">{hit.hero_damaged_it.length} / {r.buildings_total.team_took}</span></p>
      </div>
    );
  }
  if (data.kind === 'phase') {
    const pc = (v: number | null) => (v == null ? '–' : `${Math.round(v * 100)}%`);
    return (
      <div className="ag-rec">
        <p className="ag-rec-head"><b>{r.clock}</b></p>
        {r.buildings.length > 0 && <p className="ag-rec-line"><span>{t(T.tempoBuildings)}</span>{r.buildings.map((b: any, i: number) => <span key={i} className={`ag-chip ${b.taken_by === 'team' ? 'is-ally' : 'is-enemy'}`}>{b.clock} · {t(T.tempoTeams[b.taken_by === 'team' ? 'opponents' : 'team'])} {buildingLabel(b.building, lang)}</span>)}</p>}
        {r.fights.length > 0 && <p className="ag-rec-line"><span>{t(T.tempoFights)}</span>{r.fights.map((f: any) => <span key={f.overview_fight} className="ag-chip">{f.clock} · {f.team_deaths} : {f.opponents_deaths}{f.hero_was_there === false ? <em>{t(T.tempoAway)}</em> : null}</span>)}</p>}
        <p className="ag-rec-sub">{t(T.tempoAlive)} · {r.hero_alive_seconds} {t(T.sec)}</p>
        <p className="ag-rec-line">{Object.entries(r.hero_share_of_alive_time as Record<string, number | null>).map(([k, v]) => <span key={k} className="ag-chip">{T.tempoShare[k] ? t(T.tempoShare[k]) : pretty(k)} <em>{pc(v)}</em></span>)}</p>
        {r.hero_most_time_in && r.hero_most_time_in.length > 0 && <p className="ag-rec-line"><span>{t(T.tempoMost)}</span>{r.hero_most_time_in.map((x: any) => <span key={x.place} className="ag-chip">{N(x.place)} <em>{pc(x.share_of_alive_time)}</em></span>)}</p>}
        <p className="ag-rec-line"><span>{t(T.tempoDamage)}</span><span className="ag-chip">{r.hero_damage_to_buildings}</span><span className="ag-chip">{t(T.tempoOfTeam)} <em>{r.team_heroes_damage_to_buildings}</em></span></p>
      </div>
    );
  }
  if (data.kind === 'lineup_timing') {
    const pc = (v: number | null | undefined) => (v == null ? '–' : `${(v * 100).toFixed(1)}%`);
    const groups = ['under_35_min', 'from_35_to_45_min', 'over_45_min'];
    const sides = ['my_team', 'enemy', 'radiant', 'dire'].filter((k) => r[k]);
    return (
      <div className="ag-rec">
        <p className="ag-rec-head">{r.bracket_name} · {t(T.timingPublic)}{r.this_game ? <> · {t(T.timingThis)} <b>{r.this_game.length}</b></> : null}</p>
        <p className="ag-rec-sub">{r.source} · {r.patch} · {r.weeks.from} – {r.weeks.to}</p>
        <div className="ag-lane-scroll">
          <table className="ag-lane">
            <thead><tr>{T.timingCols[lang].map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
            {sides.map((k) => (
              <tbody key={k}>
                {r[k].heroes.map((h: any) => (
                  <tr key={h.hero} className={SIDE_CLASS[k === 'my_team' ? 'ally' : k === 'enemy' ? 'enemy' : ''] ?? ''}>
                    <th scope="row">{N(h.hero)}</th>
                    {groups.map((g) => <td key={g} className={r.this_game?.group === g ? 'is-now' : ''}>{pc(h[`win_rate_${g}`])}</td>)}
                    <td>{h.wins_more_in && T.timingLean[h.wins_more_in] ? t(T.timingLean[h.wins_more_in]) : '–'}</td>
                  </tr>
                ))}
                <tr className="ag-lane-sum">
                  <th scope="row">{t(T.timingSides[k])} · {t(T.timingMean)}</th>
                  {groups.map((g) => <td key={g}>{pc(r[k].mean_win_rate_of_its_heroes[g])}</td>)}
                  <td />
                </tr>
              </tbody>
            ))}
          </table>
        </div>
        <p className="ag-rec-note">{t(T.timingAlone)}</p>
      </div>
    );
  }
  if (data.kind === 'pro_items') {
    return (
      <div className="ag-rec">
        {r.mid_game_items && <p className="ag-rec-sub">{r.mid_game_items.pro_games} {t(T.proShare)} · {r.mid_game_items.window}</p>}
        <ul className="ag-bars">{(r.mid_game_items?.items ?? []).map((i: any) => <Bar key={i.item} label={`${i.name} · ${i.player_first_held ?? t(T.never)}`} value={Math.round(i.share_of_pro_games * 100)} max={100} />)}</ul>
        {r.built_more_against_these_enemies.length > 0 && <p className="ag-rec-line">{r.built_more_against_these_enemies.map((x: any, i: number) => <span key={i} className="ag-chip">{N(x.enemy)}: {x.name} {Math.round(x.share_of_pro_games_against_this_enemy * 100)}% <em>({Math.round(x.share_usually * 100)}%)</em> · {x.player_first_held ?? t(T.never)}</span>)}</p>}
        <p className="ag-rec-note">{r.note}</p>
      </div>
    );
  }
  if (data.kind === 'abilities') {
    return (
      <div className="ag-rec">
        <p className="ag-rec-sub">{r.source} · {r.patch}</p>
        <p className="ag-rec-line">{r.abilities.map((a: any) => <span key={a.ability} className="ag-chip">{a.name}{a.ultimate ? ` · ${t(T.ultimate)}` : ''}{typeof a.goes_through_spell_immunity === 'boolean' ? ` · ${t(a.goes_through_spell_immunity ? T.pierces : T.noPierce)}` : ''}</span>)}</p>
      </div>
    );
  }
  // A tool's totals (audit:…, deaths:…, immunity:…): the counts themselves.
  const flat: [string, string][] = [];
  const late: [string, unknown][] = [];
  for (const [k, v] of Object.entries(r)) {
    if (k === 'ref' || k === 'ref_scope' || k === 'hero' || k === 'team' || k === 'ability') continue;
    const label = (key: string) => (TOTALS[key] ? t(TOTALS[key]) : null);
    // The amounts behind the shares would say the same thing twice.
    if (k === 'damage_in_death_windows' || k === 'deaths_not_known') continue;
    if (k === 'damage_share_in_death_windows' || k === 'deaths_where' || k === 'casts_where') { late.push([k, v]); continue; }
    if (typeof v === 'number') flat.push([label(k) ?? pretty(k), String(v)]);
    // A moment (learned_at) reads as its clock, not as its raw seconds.
    else if (v && typeof v === 'object' && typeof (v as any).clock === 'string') flat.push([label(k) ?? pretty(k), (v as any).clock]);
    else if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) if (typeof v2 === 'number') flat.push([`${label(k) ?? pretty(k)} · ${label(k2) ?? N(k2)}`, String(v2)]);
  }
  // What the deaths have in common, then where the damage came from: a count of deaths, a share as a percentage.
  const tl = (key: string) => (TOTALS[key] ? t(TOTALS[key]) : pretty(key));
  for (const [k, v] of late) {
    if (!v || typeof v !== 'object') continue;
    for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
      if ((k === 'deaths_where' || k === 'casts_where') && Array.isArray(v2)) { if (v2.length) flat.push([tl(k2), String(v2.length)]); }
      else if (k === 'damage_share_in_death_windows' && typeof v2 === 'number') { const cut = k2.indexOf(': '); flat.push([`${tl(k)} · ${cut > 0 ? `${N(k2.slice(0, cut))} ${tl(k2.slice(cut + 2))}` : N(k2)}`, `${Math.round(v2 * 100)}%`]); }
    }
  }
  return (
    <div className="ag-rec">
      <p className="ag-rec-head">{r.clock ?? [r.hero, r.ability].filter(Boolean).map((x: string) => N(x)).join(' · ')}{r.watching ? `${r.hero ? ' · ' : ''}${t(T.watching)} ${N(r.watching.hero)} · ${N(r.watching.ability)}` : ''}</p>
      {flat.length > 0 && <p className="ag-rec-line">{flat.slice(0, 18).map(([k, v]) => <span key={k} className="ag-chip">{k} <em>{v}</em></span>)}</p>}
    </div>
  );
}

export const EvidenceCard: React.FC<{ matchId: string; hero: string; lang: Lang; item: EvidenceItem; onAsk: (label: string, refs: string[]) => void }> = ({ matchId, hero, lang, item, onAsk }) => {
  const [open, setOpen] = useState(false);
  const [records, setRecords] = useState<(EvidenceRecord | null)[] | null>(null);
  useEffect(() => {
    if (!open || records) return;
    let alive = true;
    Promise.all(item.refs.map((ref) => fetchEvidence(matchId, hero, lang, ref).catch(() => null))).then((rs) => { if (alive) setRecords(rs); });
    return () => { alive = false; };
  }, [open, records, item.refs, matchId, hero, lang]);
  const t = (b: Record<Lang, string>) => b[lang];
  return (
    <li className={`ag-ev ${open ? 'is-open' : ''}`}>
      <div className="ag-ev-row">
        {item.clock && <time className="ag-ev-clock">{item.clock}</time>}
        <p className="ag-ev-fact">{item.fact}</p>
      </div>
      <div className="ag-ev-actions">
        <button type="button" className="ag-link" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{t(open ? T.hide : T.show)}</button>
        <button type="button" className="ag-link" onClick={() => onAsk(item.clock ?? item.refs[0], item.refs)}>{t(T.ask)}</button>
      </div>
      {open && (
        <div className="ag-ev-records">
          {!records && <p className="ag-none">{t(T.loading)}</p>}
          {records?.map((rec, i) => (rec ? <Record key={item.refs[i]} data={rec} lang={lang} /> : <p key={item.refs[i]} className="ag-none">{t(T.failed)}</p>))}
        </div>
      )}
    </li>
  );
};
