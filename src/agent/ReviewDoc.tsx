import React, { useEffect, useState } from 'react';
import { fetchEvidence, type DeepReview } from './api';
import { EvidenceCard } from './EvidenceCard';
import { PLANS, planByKey } from '../../lib/agent/plans.js';
import { setGoal, useActiveGoal, type ActiveGoal, type GoalRule } from '../coach/goalStore';

/** The review as a document: verdict, the game's fights with the turn marked, the findings with their evidence, what to change. */

type Lang = 'en' | 'zh';
const T = {
  verdict: { en: 'The verdict', zh: '结论' },
  patchExact: { en: 'Prices, item effects and cooldowns in this review are those of patch {p}', zh: '本复盘中的价格、装备效果和技能冷却按 {p} 版本' },
  patchFrom: { match_data: { en: 'from the match record', zh: '依据比赛记录' }, start_time: { en: 'from when the game was played', zh: '依据比赛开始时间' }, match_id: { en: 'from the match id', zh: '依据比赛编号' } } as Record<string, Record<Lang, string>>,
  patchUnknown: { en: 'The patch of this game could not be told: prices, item effects and cooldowns are those of the current patch {p} and may differ from what they were then.', zh: '这局的版本无法确定：价格、装备效果和技能冷却按当前 {p} 版本，可能与当时不同。' },
  story: { en: 'How the game went', zh: '对局主线' },
  fights: { en: 'Fights: bars above the line are fights your team lost fewer heroes in; the line is your team\'s gold lead.', zh: '团战：横线上方是我方少死人的团，下方是多死人的团；折线是我方经济领先。' },
  turn: { en: 'the turn', zh: '转折' },
  findings: { en: 'What decided it', zh: '核心问题' },
  fix: { en: 'Do instead', zh: '改法' },
  ruleWhen: { en: 'When', zh: '当' },
  ruleDo: { en: 'Do', zh: '就' },
  ruleSeen: { en: 'This game', zh: '本局' },
  rule: { en: 'Rule for next game', zh: '下一把的规则' },
  next: { en: 'Next game, change these', zh: '下一把只改这几件事' },
  well: { en: 'What you did well', zh: '做得好的' },
  blind: { en: 'What the replay could not show', zh: '录像看不到的' },
  askFight: { en: 'the fight at', zh: '这波团战' },
  goalTitle: { en: 'Make it checkable', zh: '定一个能核验的目标' },
  goalSet: { en: 'Make this my next-game goal', zh: '设为下一局目标' },
  goalIs: { en: 'Your next-game goal', zh: '已设为下一局目标' },
  goalHow: { en: 'Play your next game, then open it here or on your games page: the coach checks it against the scoreboard.', zh: '打完下一局，在这里或「我的比赛」里打开它，教练会按记分板核验。' },
  goalHowReplay: { en: 'Play your next game, then open its replay review here: the coach counts the same things in that replay and tells you which rules held.', zh: '打完下一局，在这里打开它的录像复盘：教练会在那盘录像里数同样的事，逐条告诉你规则守住了没有。' },
  goalRules: { en: 'Counted in your next replay', zh: '下一盘录像里会数的' },
  ruleCheck: { en: 'Next game', zh: '下一盘' },
  goalUndo: { en: 'Remove', zh: '取消' },
  goalFrom: { en: 'From finding', zh: '对应问题' },
  plan: { en: 'The game plan', zh: '运营思路' },
  planSub: { en: 'The game as a whole: what the teams did with the map, and where you were.', zh: '整局来看：双方怎么用地图和团战，你当时在哪里。' },
  planLineUps: { en: 'The line-ups', zh: '阵容' },
  planStrengths: { en: 'What you were up against', zh: '对位与强势期' },
  planWindow: { en: 'Your chance', zh: '窗口期' },
  planYours: { en: 'Against your plan', zh: '对照你的思路' },
  planCourse: { en: 'How it went', zh: '走势' },
  planYou: { en: 'Your part', zh: '你的部分' },
  planReason: {
    your_play: { en: 'Mostly your own play', zh: '主要在你自己的打法' }, team_play: { en: 'Mostly the team, not you', zh: '主要在队伍，不在你' },
    enemy_play: { en: 'Mostly what the enemy did', zh: '主要是对面做对了' }, line_ups: { en: 'Mostly the line-ups', zh: '主要在阵容' }, unclear: { en: 'The data does not settle it', zh: '数据定不了' },
  } as Record<string, Record<Lang, string>>,
  replan: { en: 'You can also have the whole review rewritten against “{p}”{t}.', zh: '也可以按「{p}」重写整份复盘{t}。' },
  // The default model's time. Another model's is said where the rewrite is started (the page), so not here.
  replanTime: { en: ' (about two to three minutes)', zh: '（约 2–3 分钟）' },
  replanGo: { en: 'Rewrite it', zh: '重写' },
  intentBusy: { en: 'The coach is still answering your last question. Pick again when it is done.', zh: '教练还在回答上一个问题，等它答完再选。' },
  intentAsk: { en: 'What were you going for this game? Tell the coach: it checks your plan against the replay.', zh: '这局你本来想怎么打？告诉教练，它会对照录像回答。' },
} as const;

/** What a player may have been going for (lib/agent/plans.js). The label is the button; `said` is how it reads inside the question. */
export const PLAN_INTENTS: readonly { key: string; label: Record<Lang, string>; said: Record<Lang, string> }[] = PLANS;
/** The question a chosen plan sends to the coach: the three things a plan is checked on. */
export const planQuestion = (key: string, lang: Lang): string | null => {
  const said = PLAN_INTENTS.find((p) => p.key === key)?.said[lang];
  if (!said) return null;
  return lang === 'zh'
    ? `我这局的思路是「${said}」。我的打法和这个思路一致吗？面对对面的阵容，这个思路站得住吗？没打成的话，是我没做好、思路不对，还是被对面针对了？`
    : `My plan this game was to ${said}. Did my play fit it? Was it sound against their line-up? And where it failed, was that my play, the plan, or what the enemy did?`;
};

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

/** The rules of a review that the next game's replay can be counted on. */
export const checkedRules = (review: DeepReview): GoalRule[] =>
  review.findings.flatMap((f, i) => (f.rule?.check ? [{ finding: i + 1, when: f.rule.when, do: f.rule.do, check: f.rule.check }] : []));

/**
 * What the next game is checked on: the review's scoreboard goal if it has
 * one, and every rule that names a count the next replay can be counted on.
 * Set it, and later games are judged against it (goalStore).
 */
const GoalCard: React.FC<{ matchId: string; review: DeepReview; lang: Lang; ctx: GoalContext }> = ({ matchId, review, lang, ctx }) => {
  const active = useActiveGoal();
  const rules = checkedRules(review);
  // Without a scoreboard goal the first counted rule is the goal; the rest are checked beside it.
  const { finding, ...spec } = review.goal ?? { ...rules[0].check, finding: rules[0].finding };
  const more = review.goal ? rules : rules.slice(1);
  // The goal itself is part of its identity: the same game reviewed in another language can propose a
  // different one, and that card must not claim to be the goal already set.
  const sig = (g: GoalRule['check']) => (g.kind === 'hold_item' ? g.items.join('+') : g.kind === 'deaths_per10_max' ? g.max : g.kind === 'replay_habit' ? `${g.habit}${g.ability ?? ''}${g.max}` : '');
  const id = `${matchId}:${review.hero}:agent:${spec.kind}:${sig(spec)}${more.length ? `:r${more.map((r) => sig(r.check)).join('+')}` : ''}`;
  const mine = active?.id === id;
  const make = (): ActiveGoal => ({ id, goal: spec, action: spec.label, findingId: `agent:${finding}`, fromMatch: Number(matchId), fromStart: ctx.fromStart, accountId: ctx.accountId, heroId: ctx.heroId, setAt: Date.now(), ...(more.length ? { rules: more } : {}) });
  return (
    <div className={`ag-goal ${mine ? 'is-set' : ''}`}>
      <p className="ag-goal-eyebrow">{mine ? `✓ ${T.goalIs[lang]}` : T.goalTitle[lang]} · {T.goalFrom[lang]} {finding}</p>
      <p className="ag-goal-label">{spec.label[lang]}</p>
      {more.length > 0 && (
        <>
          <p className="ag-goal-eyebrow">{T.goalRules[lang]}</p>
          <ul className="ag-goal-rules">{more.map((r) => <li key={r.finding}><span className="ag-num">{r.finding}</span>{r.check.label[lang]}</li>)}</ul>
        </>
      )}
      <p className="ag-goal-how">{spec.kind === 'replay_habit' || more.length ? T.goalHowReplay[lang] : T.goalHow[lang]}</p>
      {mine
        ? <button type="button" className="ag-link" onClick={() => setGoal(null)}>{T.goalUndo[lang]}</button>
        : <button type="button" className="ag-btn is-primary" onClick={() => setGoal(make())}>{T.goalSet[lang]}</button>}
    </div>
  );
};

export const ReviewDoc: React.FC<{ matchId: string; review: DeepReview; lang: Lang; onAsk: (label: string, refs: string[]) => void; /** Send a plan question to the coach; false when it could not be sent (the coach is still answering). */ onPlan?: (question: string) => boolean; /** Have the whole review made again for this plan (the page opens its start, with the plan picked). */ onReplan?: (plan: string) => void; goalContext?: GoalContext | null; /** The match record (line-ups, items, gold), shown under the verdict. */ board?: React.ReactNode; /** The review is the default model's, whose rewrite takes the usual two to three minutes; false for another model's. */ quick?: boolean }> = ({ matchId, review, lang, onAsk, onPlan, onReplan, goalContext = null, board = null, quick = true }) => {
  const t = (b: Record<Lang, string>) => b[lang];
  // A plan picked while the coach is still answering is not sent: say so instead of doing nothing.
  const [planHeld, setPlanHeld] = useState(false);
  // The plan last asked about: the reader may want the whole review made for it, not only an answer.
  const [asked, setAsked] = useState<string | null>(null);
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
        {review.data_patch && (review.data_patch.exact
          ? <p className="ag-patch">{t(T.patchExact).replace('{p}', review.data_patch.name)}{review.data_patch.known_from && T.patchFrom[review.data_patch.known_from] ? (lang === 'zh' ? `（${t(T.patchFrom[review.data_patch.known_from])}）` : ` (${t(T.patchFrom[review.data_patch.known_from])})`) : ''}</p>
          : <p className="ag-patch is-unknown" role="note">{t(T.patchUnknown).replace('{p}', review.data_patch.name)}</p>)}
      </section>

      {board}

      <section>
        <h2>{t(T.story)}</h2>
        {overview && overview.fights.length > 0 && overview.duration && <FightStrip fights={overview.fights} duration={overview.duration.t} lang={lang} onAsk={onAsk} />}
        {review.mainline.length > 0 && <ol className="ag-mainline">{review.mainline.map((line, i) => <li key={i}>{line}</li>)}</ol>}
      </section>

      {(review.game_plan || onPlan) && (
        <section className="ag-plan">
          <h2>{t(T.plan)}</h2>
          {review.game_plan && (
            <>
              <p className="ag-plan-sub">{t(T.planSub)}</p>
              <dl className="ag-plan-parts">
                {review.game_plan.against_your_plan && <div className="ag-plan-yours"><dt>{t(T.planYours)}{planByKey(review.plan ?? '') ? <span>{planByKey(review.plan ?? '')!.label[lang]}</span> : null}</dt><dd>{review.game_plan.against_your_plan}</dd></div>}
                {review.game_plan.window && <div><dt>{t(T.planWindow)}</dt><dd>{review.game_plan.window}</dd></div>}
                {review.game_plan.strengths && <div><dt>{t(T.planStrengths)}</dt><dd>{review.game_plan.strengths}</dd></div>}
                {review.game_plan.course && <div><dt>{t(T.planCourse)}</dt><dd>{review.game_plan.course}</dd></div>}
                {review.game_plan.your_part && <div><dt>{t(T.planYou)}</dt><dd>{review.game_plan.your_part}</dd></div>}
                {review.game_plan.line_ups && <div><dt>{t(T.planLineUps)}</dt><dd>{review.game_plan.line_ups}</dd></div>}
              </dl>
              {review.game_plan.main_reason && review.game_plan.why && T.planReason[review.game_plan.main_reason] && (
                <p className="ag-plan-why"><span className={`ag-plan-tag is-${review.game_plan.main_reason}`}>{t(T.planReason[review.game_plan.main_reason])}</span>{review.game_plan.why}</p>
              )}
              <ul className="ag-evidence">{review.game_plan.evidence.map((e, j) => <EvidenceCard key={j} matchId={matchId} hero={review.hero} lang={lang} item={e} onAsk={onAsk} />)}</ul>
            </>
          )}
          {onPlan && (
            <div className="ag-intent">
              <p>{t(T.intentAsk)}</p>
              <div className="ag-intent-row">{PLAN_INTENTS.map((p) => <button key={p.key} type="button" className="ag-btn" onClick={() => { const sent = onPlan(planQuestion(p.key, lang)!); setPlanHeld(!sent); if (sent) setAsked(p.key); }}>{p.label[lang]}</button>)}</div>
              {planHeld && <p className="ag-intent-note" role="status">{t(T.intentBusy)}</p>}
              {asked && onReplan && asked !== review.plan && planByKey(asked) && (
                <p className="ag-intent-note">{t(T.replan).replace('{p}', planByKey(asked)!.label[lang]).replace('{t}', quick ? t(T.replanTime) : '')} <button type="button" className="ag-link" onClick={() => onReplan(asked)}>{t(T.replanGo)}</button></p>
              )}
            </div>
          )}
        </section>
      )}

      <section>
        <h2>{t(T.findings)}</h2>
        {review.findings.map((f, i) => (
          <div key={i} className="ag-finding">
            <h3><span className="ag-num">{i + 1}</span>{f.title}</h3>
            <p className="ag-claim">{f.claim}</p>
            <ul className="ag-evidence">{f.evidence.map((e, j) => <EvidenceCard key={j} matchId={matchId} hero={review.hero} lang={lang} item={e} onAsk={onAsk} />)}</ul>
            {f.rule && (
              <dl className="ag-rule" aria-label={t(T.rule)}>
                <div><dt>{t(T.ruleWhen)}</dt><dd>{f.rule.when}</dd></div>
                <div><dt>{t(T.ruleDo)}</dt><dd>{f.rule.do}</dd></div>
                {f.rule.this_game && <div className="ag-rule-seen"><dt>{t(T.ruleSeen)}</dt><dd>{f.rule.this_game}</dd></div>}
                {f.rule.check && <div className="ag-rule-check"><dt>{t(T.ruleCheck)}</dt><dd>{f.rule.check.label[lang]}</dd></div>}
              </dl>
            )}
            {f.fix && <p className="ag-fix"><span>{t(T.fix)}</span>{f.fix}</p>}
          </div>
        ))}
      </section>

      <section className="ag-next">
        <h2>{t(T.next)}</h2>
        {review.next_game.length > 0 && <ol>{review.next_game.map((line, i) => <li key={i}>{line}</li>)}</ol>}
        {(review.goal || checkedRules(review).length > 0) && goalContext && <GoalCard matchId={matchId} review={review} lang={lang} ctx={goalContext} />}
      </section>

      {review.did_well.length > 0 && <section><h2>{t(T.well)}</h2><ul className="ag-plain">{review.did_well.map((line, i) => <li key={i}>{line}</li>)}</ul></section>}
      {review.blind_spots.length > 0 && <section className="ag-blind"><h2>{t(T.blind)}</h2><ul className="ag-plain">{review.blind_spots.map((line, i) => <li key={i}>{line}</li>)}</ul></section>}
    </article>
  );
};
