import React, { useMemo } from 'react';
import { SafeImg, clock, k, signedK, useLang } from './ui';
import type { Bi, Chapters as ChaptersT, CoachReport, DeathRow, FightRow, HeroRef, Review } from './types';

/**
 * The deep review: the game phase by phase, the lane, every death, the build
 * against what hurt you, every fight, then what to practise. Each chapter
 * shows the coach's read, the table it rests on, and how it was computed.
 */

const T = {
  title: { en: 'The full review', zh: '完整复盘' },
  sub: { en: 'Phase by phase, with the numbers behind every sentence.', zh: '按比赛阶段逐项拆解，每句话都有对应的数据。' },
  how: { en: 'How this is computed', zh: '怎么算的' },
  story: { en: '1 · How the game went', zh: '1 · 比赛经过' },
  laning: { en: '2 · Laning', zh: '2 · 对线' },
  deaths: { en: '3 · Every death', zh: '3 · 逐次死亡' },
  items: { en: '4 · Build vs. what hurt you', zh: '4 · 出装与承伤' },
  fights: { en: '5 · Every team fight', zh: '5 · 逐波团战' },
  plan: { en: 'Next game: practise this', zh: '下一局：练这几件事' },
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
} satisfies Record<string, Bi | Record<string, Bi>>;

const pct = (v: number) => `${Math.round(v * 100)}%`;

export const Chapters: React.FC<{ review: Review; report: CoachReport }> = ({ review, report }) => {
  const { L } = useLang();
  const ch = review.chapters;
  const heroById = useMemo(() => new Map(report.players.map((p) => [p.hero.id, p.hero])), [report]);
  if (!ch) return null;
  const hasAny = ch.story || ch.laning || ch.deaths || ch.items || ch.fights;
  if (!hasAny && !ch.plan.length) return null;
  return (
    <section className="cx-chapters" aria-label={L(T.title)}>
      <header className="cx-chapters-head">
        <h2>{L(T.title)}</h2>
        <p className="cx-muted">{L(T.sub)}</p>
      </header>
      {ch.story && <Story ch={ch.story} />}
      {ch.laning && <Laning ch={ch.laning} heroById={heroById} slot={review.slot} />}
      {ch.deaths && <Deaths ch={ch.deaths} heroById={heroById} />}
      {ch.items && <Items ch={ch.items} heroById={heroById} />}
      {ch.fights && <Fights ch={ch.fights} />}
      {ch.plan.length > 0 && <Plan plan={ch.plan} />}
    </section>
  );
};

const Chapter: React.FC<{ title: Bi; read: Bi; note: Bi; children?: React.ReactNode; aside?: React.ReactNode }> = ({ title, read, note, children, aside }) => {
  const { L } = useLang();
  return (
    <article className="cx-chapter">
      <h3 className="cx-chapter-title">{L(title)}{aside}</h3>
      <p className="cx-chapter-read">{L(read)}</p>
      {children}
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

const Story: React.FC<{ ch: NonNullable<ChaptersT['story']> }> = ({ ch }) => {
  const { L } = useLang();
  return (
    <Chapter title={T.story} read={ch.read} note={ch.note}>
      <Table label={L(T.story)} head={[L(T.phase), L(T.lead), L(T.change), L(T.buildings), L(T.fightsWL), L(T.yourKD)]}>
        {ch.phases.map((p) => (
          <tr key={p.key}>
            <th scope="row">{L(p.label)}</th>
            <td><Lead v={p.lead_end} /></td>
            <td><Lead v={p.swing} /></td>
            <td>{p.buildings[0]} / {p.buildings[1]}{p.roshan ? <small> · {L({ en: `Roshan ×${p.roshan}`, zh: `肉山 ×${p.roshan}` })}</small> : null}</td>
            <td>{p.fights ? `${p.fights[0]}–${p.fights[1]}` : '—'}</td>
            <td>{p.my_kd[0]} / {p.my_kd[1]}</td>
          </tr>
        ))}
      </Table>
    </Chapter>
  );
};

const Laning: React.FC<{ ch: NonNullable<ChaptersT['laning']>; heroById: Map<number, HeroRef>; slot: number }> = ({ ch, heroById, slot }) => {
  const { L } = useLang();
  const tone = ch.outcome === 'won' || ch.outcome === 'stomp' ? 'good' : ch.outcome === 'draw' ? 'even' : 'bad';
  return (
    <Chapter title={T.laning} read={ch.read} note={ch.note} aside={<span className={`cx-pill cx-pill--${tone}`}>{L(T.laneResult)} · {L(ch.outcome_label)}</span>}>
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

const Deaths: React.FC<{ ch: NonNullable<ChaptersT['deaths']>; heroById: Map<number, HeroRef> }> = ({ ch, heroById }) => {
  const { L } = useLang();
  return (
    <Chapter title={T.deaths} read={ch.read} note={ch.note}>
      <Table label={L(T.deaths)} head={[L(T.time), L(T.killer), L(T.context), L(T.goldLost), L(T.dead), L(T.after)]}>
        {ch.rows.map((d: DeathRow, i) => (
          <tr key={i} className={`ctx-${d.context}`}>
            <th scope="row">{clock(d.time)}</th>
            <td><HeroTag hero={d.killer != null ? heroById.get(d.killer) : null} /></td>
            <td><span className="cx-ctx">{L(T.ctx[d.context])}</span></td>
            <td>{d.gold_lost != null ? d.gold_lost : '—'}</td>
            <td>{d.time_dead != null ? `${d.time_dead}s` : '—'}</td>
            <td>{d.converted ? L(T.objective) : ''}</td>
          </tr>
        ))}
      </Table>
    </Chapter>
  );
};

const Items: React.FC<{ ch: NonNullable<ChaptersT['items']>; heroById: Map<number, HeroRef> }> = ({ ch, heroById }) => {
  const { L } = useLang();
  const dmg = ch.damage;
  const max = dmg?.by_hero[0]?.share ?? 1;
  return (
    <Chapter title={T.items} read={ch.read} note={ch.note}>
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
    </Chapter>
  );
};

const Fights: React.FC<{ ch: NonNullable<ChaptersT['fights']> }> = ({ ch }) => {
  const { L } = useLang();
  const head = [L(T.time), L(T.result), L(T.kills), L(T.you), L(T.damage)];
  if (ch.ultimate) head.push(L(ch.ultimate));
  return (
    <Chapter title={T.fights} read={ch.read} note={ch.note}>
      <Table label={L(T.fights)} head={head}>
        {ch.rows.map((f: FightRow, i) => (
          <tr key={i} className={`res-${f.result} ${f.present ? '' : 'is-absent'}`}>
            <th scope="row">{clock(f.start)}</th>
            <td><span className={`cx-res cx-res--${f.result}`}>{L(T[f.result])}</span></td>
            <td>{f.kills[0]}–{f.kills[1]}</td>
            <td>{f.present ? (f.died ? L(T.diedShort) : '✓') : L(T.absent)}</td>
            <td>{f.present ? k(f.damage) : '—'}</td>
            {ch.ultimate && <td>{f.ult_state ? L(T.ult[f.ult_state]) : f.ult_used ? L(T.ult.used) : '—'}</td>}
          </tr>
        ))}
      </Table>
    </Chapter>
  );
};

const Plan: React.FC<{ plan: ChaptersT['plan'] }> = ({ plan }) => {
  const { L } = useLang();
  return (
    <article className="cx-chapter cx-plan">
      <h3 className="cx-chapter-title">{L(T.plan)}</h3>
      <ol>
        {plan.map((p) => (
          <li key={p.key}>
            <h4>{L(p.title)}</h4>
            <p><b>{L(T.why)}</b>{L(p.why)}</p>
            <p><b>{L(T.check)}</b>{L(p.check)}</p>
          </li>
        ))}
      </ol>
    </article>
  );
};
