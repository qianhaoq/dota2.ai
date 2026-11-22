import React, { useEffect, useState } from 'react';
import { fetchEvidence, type DeepReview } from './api';
import { EvidenceCard } from './EvidenceCard';
import { setGoal, useActiveGoal, type ActiveGoal } from '../coach/goalStore';

/** The review as a document: verdict, the game's fights with the turn marked, the findings with their evidence, what to change. */

type Lang = 'en' | 'zh';
const T = {
  verdict: { en: 'The verdict', zh: '结论' },
  story: { en: 'How the game went', zh: '对局主线' },
  fights: { en: 'Fights: bars above the line are fights your team lost fewer heroes in; the line is your team\'s gold lead.', zh: '团战：横线上方是我方少死人的团，下方是多死人的团；折线是我方经济领先。' },
  turn: { en: 'the turn', zh: '转折' },
  findings: { en: 'What decided it', zh: '核心问题' },
  fix: { en: 'Do instead', zh: '改法' },
  next: { en: 'Next game, change these', zh: '下一把只改这几件事' },
  well: { en: 'What you did well', zh: '做得好的' },
  blind: { en: 'What the replay could not show', zh: '录像看不到的' },
  askFight: { en: 'the fight at', zh: '这波团战' },
  goalTitle: { en: 'Make it checkable', zh: '定一个能核验的目标' },
  goalSet: { en: 'Make this my next-game goal', zh: '设为下一局目标' },
  goalIs: { en: 'Your next-game goal', zh: '已设为下一局目标' },
  goalHow: { en: 'Play your next game, then open it here or on your games page: the coach checks it against the scoreboard.', zh: '打完下一局，在这里或「我的比赛」里打开它，教练会按记分板核验。' },
  goalUndo: { en: 'Remove', zh: '取消' },
  goalFrom: { en: 'From finding', zh: '对应问题' },
} as const;

interface Fight { ref: string; from: number; to: number; clock: string; my_team_deaths: number; enemy_deaths: number; my_team_gold_lead_before?: number | null; my_team_gold_lead_2min_after?: number | null }

/** A team this far behind is already losing: fights after that widen the gap, they do not turn the game. */
const STILL_IN_IT = -2000;

/**
 * The fight that turned the game against the team: the largest fall of the
 * gold lead among fights entered while still in it (needs the gold curve).
 * Null when no fight cost 1.5k or more — a game can be lost without one.
 */
export function turningFight(fights: Fight[]): Fight | null {
  let best: Fight | null = null; let drop = 1500;
  for (const f of fights) {
    if (f.my_team_gold_lead_before == null || f.my_team_gold_lead_2min_after == null || f.my_team_gold_lead_before < STILL_IN_IT) continue;
    const d = f.my_team_gold_lead_before - f.my_team_gold_lead_2min_after;
    if (d > drop) { drop = d; best = f; }
  }
  return best;
}

const FightStrip: React.FC<{ fights: Fight[]; duration: number; lang: Lang; onAsk: (label: string, refs: string[]) => void }> = ({ fights, duration, lang, onAsk }) => {
  const W = 720; const H = 120; const mid = H / 2; const pad = 8;
  const x = (t: number) => pad + (Math.max(0, t) / Math.max(1, duration)) * (W - pad * 2);
  const gold = fights.filter((f) => f.my_team_gold_lead_before != null);
  const maxGold = Math.max(2000, ...gold.map((f) => Math.abs(f.my_team_gold_lead_before!)));
  const y = (v: number) => mid - (v / maxGold) * (mid - pad);
  const turn = turningFight(fights);
  return (
    <figure className="ag-strip">
      <svg viewBox={`0 0 ${W} ${H}`} role="group" aria-label={T.fights[lang]}>
        <line x1={pad} y1={mid} x2={W - pad} y2={mid} className="ag-strip-axis" />
        {gold.length > 1 && <polyline className="ag-strip-gold" points={gold.map((f) => `${x(f.from)},${y(f.my_team_gold_lead_before!)}`).join(' ')} />}
        {fights.map((f) => {
          const diff = f.enemy_deaths - f.my_team_deaths;
          const h = Math.max(4, Math.abs(diff) * 9);
          return (
            <g key={f.ref} className={`ag-strip-fight ${diff > 0 ? 'is-won' : diff < 0 ? 'is-lost' : 'is-even'} ${turn?.ref === f.ref ? 'is-turn' : ''}`}
              role="button" tabIndex={0} aria-label={`${T.askFight[lang]} ${f.clock}, ${f.my_team_deaths}:${f.enemy_deaths}`} onClick={() => onAsk(`${T.askFight[lang]} ${f.clock}`, [f.ref])}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAsk(`${T.askFight[lang]} ${f.clock}`, [f.ref]); } }}>
              <rect x={x(f.from) - 5} y={diff >= 0 ? mid - h : mid} width="10" height={h} rx="2"><title>{`${f.clock} · ${f.my_team_deaths}:${f.enemy_deaths}`}</title></rect>
              {turn?.ref === f.ref && <text x={x(f.from)} y={H - 4} textAnchor="middle">▲ {f.clock.split('–')[0]} {T.turn[lang]}</text>}
            </g>
          );
        })}
      </svg>
      <figcaption>{T.fights[lang]}</figcaption>
    </figure>
  );
};

/** What a goal needs to know about the game it came from (from the scoreboard). */
export interface GoalContext { fromStart: number; accountId: number | null; heroId: number }

/** The review's one checkable goal: set it, and later games are judged against it (goalStore). */
const GoalCard: React.FC<{ matchId: string; review: DeepReview; lang: Lang; ctx: GoalContext }> = ({ matchId, review, lang, ctx }) => {
  const active = useActiveGoal();
  const goal = review.goal!;
  const { finding, ...spec } = goal;
  // The goal itself is part of its identity: the same game reviewed in another language can propose a
  // different one, and that card must not claim to be the goal already set.
  const id = `${matchId}:${review.hero}:agent:${spec.kind}:${spec.kind === 'hold_item' ? spec.items.join('+') : spec.kind === 'deaths_per10_max' ? spec.max : ''}`;
  const mine = active?.id === id;
  const make = (): ActiveGoal => ({ id, goal: spec, action: spec.label, findingId: `agent:${finding}`, fromMatch: Number(matchId), fromStart: ctx.fromStart, accountId: ctx.accountId, heroId: ctx.heroId, setAt: Date.now() });
  return (
    <div className={`ag-goal ${mine ? 'is-set' : ''}`}>
      <p className="ag-goal-eyebrow">{mine ? `✓ ${T.goalIs[lang]}` : T.goalTitle[lang]} · {T.goalFrom[lang]} {finding}</p>
      <p className="ag-goal-label">{spec.label[lang]}</p>
      <p className="ag-goal-how">{T.goalHow[lang]}</p>
      {mine
        ? <button type="button" className="ag-link" onClick={() => setGoal(null)}>{T.goalUndo[lang]}</button>
        : <button type="button" className="ag-btn is-primary" onClick={() => setGoal(make())}>{T.goalSet[lang]}</button>}
    </div>
  );
};

export const ReviewDoc: React.FC<{ matchId: string; review: DeepReview; lang: Lang; onAsk: (label: string, refs: string[]) => void; goalContext?: GoalContext | null }> = ({ matchId, review, lang, onAsk, goalContext = null }) => {
  const t = (b: Record<Lang, string>) => b[lang];
  const [overview, setOverview] = useState<{ fights: Fight[]; duration: { t: number } | null } | null>(null);
  useEffect(() => {
    let alive = true;
    fetchEvidence(matchId, review.hero, lang, 'overview').then((r) => { if (alive) setOverview(r.record); }).catch(() => {});
    return () => { alive = false; };
  }, [matchId, review.hero, lang]);
  return (
    <article className="ag-doc">
      <section className="ag-verdict">
        <p className="cx-eyebrow">{t(T.verdict)}</p>
        <h1>{review.verdict}</h1>
      </section>

      <section>
        <h2>{t(T.story)}</h2>
        {overview && overview.fights.length > 0 && overview.duration && <FightStrip fights={overview.fights} duration={overview.duration.t} lang={lang} onAsk={onAsk} />}
        {review.mainline.length > 0 && <ol className="ag-mainline">{review.mainline.map((line, i) => <li key={i}>{line}</li>)}</ol>}
      </section>

      <section>
        <h2>{t(T.findings)}</h2>
        {review.findings.map((f, i) => (
          <div key={i} className="ag-finding">
            <h3><span className="ag-num">{i + 1}</span>{f.title}</h3>
            <p className="ag-claim">{f.claim}</p>
            <ul className="ag-evidence">{f.evidence.map((e, j) => <EvidenceCard key={j} matchId={matchId} hero={review.hero} lang={lang} item={e} onAsk={onAsk} />)}</ul>
            <p className="ag-fix"><span>{t(T.fix)}</span>{f.fix}</p>
          </div>
        ))}
      </section>

      <section className="ag-next">
        <h2>{t(T.next)}</h2>
        <ol>{review.next_game.map((line, i) => <li key={i}>{line}</li>)}</ol>
        {review.goal && goalContext && <GoalCard matchId={matchId} review={review} lang={lang} ctx={goalContext} />}
      </section>

      {review.did_well.length > 0 && <section><h2>{t(T.well)}</h2><ul className="ag-plain">{review.did_well.map((line, i) => <li key={i}>{line}</li>)}</ul></section>}
      {review.blind_spots.length > 0 && <section className="ag-blind"><h2>{t(T.blind)}</h2><ul className="ag-plain">{review.blind_spots.map((line, i) => <li key={i}>{line}</li>)}</ul></section>}
    </article>
  );
};
