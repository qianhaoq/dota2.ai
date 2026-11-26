import { trackEvent, trackOnce } from '../services/analytics';
import React, { useEffect, useRef, useState } from 'react';
import { fetchEvidence, type DeepReview } from './api';
import { EvidenceCard } from './EvidenceCard';
import { PLANS, planByKey } from '../../lib/agent/plans.js';
import { FindingFeedback } from './FindingFeedback';
import { setGoal, useActiveGoal, type ActiveGoal, type GoalRule } from '../coach/goalStore';

/**
 * The review as a document. One lesson first: the first finding is the headline, its rule is what to practise
 * next game, and its evidence the moments that show it. The other findings fold under it; the game as a whole
 * (the verdict sentence, the fights with the turn marked, the story, the game plan, the scoreboard) comes after,
 * folded, for whoever wants it.
 */

type Lang = 'en' | 'zh';
const T = {
  verdict: { en: 'The game in one sentence', zh: '这局一句话' },
  lead: { en: 'The one thing to change', zh: '这局最该改的一件事' },
  lesson: { en: 'Practise this next game', zh: '下局只练这一件' },
  moments: { en: 'The moments that show it', zh: '这局的几个时刻' },
  more: { one: { en: 'One more thing', zh: '还有一件事' }, many: { en: 'Two more things', zh: '还有两件事' } },
  whole: { en: 'The whole game', zh: '整局' },
  boardFold: { en: 'Line-ups and scoreboard', zh: '阵容与记分板' },
  parts: { en: '{n} parts', zh: '{n} 段' },
  patchExact: { en: 'Prices, item effects and cooldowns in this review are those of patch {p}', zh: '本复盘中的价格、装备效果和技能冷却按 {p}' },
  patchFrom: { match_data: { en: 'from the match record', zh: '依据比赛记录' }, start_time: { en: 'from when the game was played', zh: '依据比赛开始时间' }, match_id: { en: 'from the match id', zh: '依据比赛编号' } } as Record<string, Record<Lang, string>>,
  patchPlain: { en: '{p}', zh: '{p} 版本' },
  patchHotfix: { en: '{p} after its hotfix of {d}', zh: '{p} 版本 {d} 热修复后的数值' },
  patchHotfixUnsure: { en: 'Prices, item effects and cooldowns in this review are those of patch {p}; a hotfix of that patch came out around when this game was played, so some numbers may be from just before or after it.', zh: '本复盘中的价格、装备效果和技能冷却按 {p} 版本；这局前后该版本正好有一次热修复，个别数值可能是热修复前或后的。' },
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
  next: { en: 'Check it next game', zh: '下一局怎么验证' },
  well: { en: 'What you did well', zh: '做得好的' },
  blind: { en: 'What the replay could not show', zh: '录像看不到的' },
  askFight: { en: 'the fight at', zh: '这波团战' },
  goalTitle: { en: 'Make it checkable', zh: '定一个能核验的目标' },
  goalSet: { en: 'Make this my next-game goal', zh: '设为下一局目标' },
  goalIs: { en: 'Your next-game goal', zh: '已设为下一局目标' },
  goalHow: { en: 'Play your next game, then open it here or on your games page: the coach checks it against the scoreboard.', zh: '打完下一局，在这里或「我的比赛」里打开它，教练会按记分板核验。' },
  goalNext: { en: 'Your next game shows up on the dota2.ai home page with this goal already checked — open it after you play.', zh: '打完下一局打开 dota2.ai 首页，那一局会出现在最上面，这个目标已经核验好。' },
  goalNextReplay: { en: 'Your next game shows up on the dota2.ai home page — open it from there. This goal is checked once that game’s replay has been read, not from the scoreboard.', zh: '打完下一局打开 dota2.ai 首页，那一局会出现在最上面，从那里点开它。这个目标要读完那一局的录像才能核验，光看记分板判断不了。' },
  goalHowReplay: { en: 'Play your next game, then open it here: the same things are counted in its replay and you see which rules held — about a minute, with or without a new review.', zh: '打完下一局，在这里打开它：会在那盘录像里数同样的事，逐条告诉你规则守住了没有——大约一分钟，要不要再写一份复盘都可以。' },
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

/**
 * `turn`: the ref of the fight the game turned on, as match_overview names it for a game the player's team lost
 * (the fight the review was pointed at) — the strip marks that one and does not work it out again.
 */
const FightStrip: React.FC<{ fights: Fight[]; duration: number; turn: string | null; lang: Lang; onAsk: (label: string, refs: string[]) => void }> = ({ fights, duration, turn, lang, onAsk }) => {
  const W = 720; const H = 120; const mid = H / 2; const pad = 8;
  const x = (t: number) => pad + (Math.max(0, t) / Math.max(1, duration)) * (W - pad * 2);
  const gold = fights.filter((f) => f.my_team_gold_lead_before != null);
  const maxGold = Math.max(2000, ...gold.map((f) => Math.abs(f.my_team_gold_lead_before!)));
  const y = (v: number) => mid - (v / maxGold) * (mid - pad);
  return (
    <figure className="ag-strip">
      <svg viewBox={`0 0 ${W} ${H}`} role="group" aria-label={T.fights[lang]}>
        <line x1={pad} y1={mid} x2={W - pad} y2={mid} className="ag-strip-axis" />
        {gold.length > 1 && <polyline className="ag-strip-gold" points={gold.map((f) => `${x(f.from)},${y(f.my_team_gold_lead_before!)}`).join(' ')} />}
        {fights.map((f) => {
          const diff = f.enemy_deaths - f.my_team_deaths;
          const h = Math.max(4, Math.abs(diff) * 9);
          return (
            <g key={f.ref} className={`ag-strip-fight ${diff > 0 ? 'is-won' : diff < 0 ? 'is-lost' : 'is-even'} ${turn === f.ref ? 'is-turn' : ''}`}
              role="button" tabIndex={0} aria-label={`${T.askFight[lang]} ${f.clock}, ${f.my_team_deaths}:${f.enemy_deaths}`} onClick={() => onAsk(`${T.askFight[lang]} ${f.clock}`, [f.ref])}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAsk(`${T.askFight[lang]} ${f.clock}`, [f.ref]); } }}>
              <rect x={x(f.from) - 5} y={diff >= 0 ? mid - h : mid} width="10" height={h} rx="2"><title>{`${f.clock} · ${f.my_team_deaths}:${f.enemy_deaths}`}</title></rect>
              {turn === f.ref && <text x={x(f.from)} y={H - 4} textAnchor="middle">▲ {f.clock.split('–')[0]} {T.turn[lang]}</text>}
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
  // Whether readers get to the card at all: once a review it is offered (rendered), once it has been on screen.
  // Nobody had set a goal in the first week (#364): this says whether the card is not reached, or not taken.
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    trackOnce(`goal_offered.${id}`, 'goal_offered', { matchId: String(matchId) });
    const el = card.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const seen = new IntersectionObserver((entries) => {
      // The threshold does not filter out an entry sent because the card started to intersect: ask for 60% here too.
      if (entries.some((e) => e.isIntersecting && e.intersectionRatio >= 0.6)) { trackOnce(`goal_seen.${id}`, 'goal_seen', { matchId: String(matchId) }); seen.disconnect(); }
    }, { threshold: 0.6 });
    seen.observe(el);
    return () => seen.disconnect();
  }, [id, matchId]);
  const make = (): ActiveGoal => ({ id, goal: spec, action: spec.label, findingId: `agent:${finding}`, fromMatch: Number(matchId), fromStart: ctx.fromStart, accountId: ctx.accountId, heroId: ctx.heroId, setAt: Date.now(), ...(more.length ? { rules: more } : {}) });
  return (
    <div ref={card} className={`ag-goal ${mine ? 'is-set' : ''}`}>
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
        : <button type="button" className="ag-btn is-primary" onClick={() => { setGoal(make()); trackEvent('goal_set', { matchId: String(matchId), kind: spec.kind, account: ctx.accountId != null, rules: more.length }); }}>{T.goalSet[lang]}</button>}
      {/* Where the check will be waiting: the home page finds the next game by this account (CoachHome). */}
      {/* A goal that needs the replay cannot be settled there from the scoreboard: do not promise it checked. */}
      {mine && ctx.accountId != null && <p className="ag-goal-how ag-goal-next">{(spec.kind === 'replay_habit' || more.length ? T.goalNextReplay : T.goalNext)[lang]}</p>}
    </div>
  );
};

export const ReviewDoc: React.FC<{ matchId: string; review: DeepReview; lang: Lang; onAsk: (label: string, refs: string[]) => void; /** Send a plan question to the coach; false when it could not be sent (the coach is still answering). */ onPlan?: (question: string) => boolean; /** Have the whole review made again for this plan (the page opens its start, with the plan picked). */ onReplan?: (plan: string) => void; goalContext?: GoalContext | null; /** The match record (line-ups, items, gold), shown under the verdict. */ board?: React.ReactNode; /** Sharing the review, shown once the reader has something to share: after the findings. */ share?: React.ReactNode; /** The review is the default model's, whose rewrite takes the usual two to three minutes; false for another model's. */ quick?: boolean; /** Ask under each finding whether it was right: the plan this review was asked with, the id of the model that wrote it and the prompt version it was written under (they name the stored review the word is about). Absent: not asked. */ feedback?: { plan?: string | null; model?: string | null; version: number } | null }> = ({ matchId, review, lang, onAsk, onPlan, onReplan, goalContext = null, board = null, feedback = null, share = null, quick = true }) => {
  const t = (b: Record<Lang, string>) => b[lang];
  // The release, and the hotfix within it when the game was played after one ("7.41f（2026-10-07 热修复后）").
  const patchName = (dp: { name: string; hotfix?: string }) => t(dp.hotfix ? T.patchHotfix : T.patchPlain).replace('{p}', dp.name).replace('{d}', (dp.hotfix ?? '').slice(0, 10));
  // A plan picked while the coach is still answering is not sent: say so instead of doing nothing.
  const [planHeld, setPlanHeld] = useState(false);
  // The plan last asked about: the reader may want the whole review made for it, not only an answer.
  const [asked, setAsked] = useState<string | null>(null);
  const [overview, setOverview] = useState<{ fights: Fight[]; duration: { t: number } | null; turning_fight?: { ref: string } | { none: true } | null } | null>(null);
  useEffect(() => {
    let alive = true;
    fetchEvidence(matchId, review.hero, lang, 'overview').then((r) => { if (alive) setOverview(r.record); }).catch(() => {});
    return () => { alive = false; };
  }, [matchId, review.hero, lang]);
  const [first, ...rest] = review.findings;
  type Finding = DeepReview['findings'][number];
  const ruleOf = (f: Finding) => f.rule && (
    <dl className="ag-rule" aria-label={t(T.rule)}>
      <div><dt>{t(T.ruleWhen)}</dt><dd>{f.rule.when}</dd></div>
      <div><dt>{t(T.ruleDo)}</dt><dd>{f.rule.do}</dd></div>
      {f.rule.this_game && <div className="ag-rule-seen"><dt>{t(T.ruleSeen)}</dt><dd>{f.rule.this_game}</dd></div>}
      {f.rule.check && <div className="ag-rule-check"><dt>{t(T.ruleCheck)}</dt><dd>{f.rule.check.label[lang]}</dd></div>}
    </dl>
  );
  // Keyed by the finding it is about: another review of the same game starts unanswered.
  const feedbackOf = (f: Finding, i: number) => feedback && <FindingFeedback key={`${i}:${f.title}`} matchId={matchId} hero={review.hero} lang={lang} plan={feedback.plan} model={feedback.model} version={feedback.version} index={i} title={f.title} />;
  const evidenceOf = (f: Finding) => <ul className="ag-evidence">{f.evidence.map((e, j) => <EvidenceCard key={j} matchId={matchId} hero={review.hero} lang={lang} item={e} onAsk={onAsk} />)}</ul>;
  const patch = review.data_patch && (review.data_patch.exact
    ? <p className="ag-patch">{t(T.patchExact).replace('{p}', patchName(review.data_patch))}{review.data_patch.known_from && T.patchFrom[review.data_patch.known_from] ? (lang === 'zh' ? `（${t(T.patchFrom[review.data_patch.known_from])}）` : ` (${t(T.patchFrom[review.data_patch.known_from])})`) : ''}</p>
    // The release is known and only the hotfix within it is not: say that, not that the patch is unknown.
    : /hotfix/.test(review.data_patch.reason ?? '')
      ? <p className="ag-patch is-unknown" role="note">{t(T.patchHotfixUnsure).replace('{p}', review.data_patch.name)}</p>
      : <p className="ag-patch is-unknown" role="note">{t(T.patchUnknown).replace('{p}', review.data_patch.name)}</p>);
  return (
    <article className="ag-doc">
      <section className="ag-lead">
        <p className="cx-eyebrow">{t(first ? T.lead : T.verdict)}</p>
        <h1>{first ? first.title : review.verdict}</h1>
        {first && <p className="ag-lead-claim">{first.claim}</p>}
        {patch}
        {first && !(first.rule || first.fix) && first.evidence.length === 0 && feedbackOf(first, 0)}
      </section>

      {first && (first.rule || first.fix) && (
        <section className="ag-lesson">
          <h2>{t(T.lesson)}</h2>
          {ruleOf(first)}
          {first.fix && <p className="ag-fix"><span>{t(T.fix)}</span>{first.fix}</p>}
          {first.evidence.length === 0 && feedbackOf(first, 0)}
        </section>
      )}

      {first && first.evidence.length > 0 && (
        <section className="ag-moments">
          <h2>{t(T.moments)}</h2>
          {evidenceOf(first)}
          {/* The first finding ends here: its claim, what to practise, the moments. Asked once the reader has seen all three. */}
          {feedbackOf(first, 0)}
        </section>
      )}

      {rest.length > 0 && (
        <section className="ag-more">
          <h2>{t(rest.length === 1 ? T.more.one : T.more.many)}</h2>
          {rest.map((f, i) => (
            <details key={i} className="ag-finding">
              <summary><h3><span className="ag-num">{i + 2}</span>{f.title}</h3></summary>
              <p className="ag-claim">{f.claim}</p>
              {evidenceOf(f)}
              {ruleOf(f)}
              {f.fix && <p className="ag-fix"><span>{t(T.fix)}</span>{f.fix}</p>}
              {feedbackOf(f, i + 1)}
            </details>
          ))}
        </section>
      )}

      {(review.goal || checkedRules(review).length > 0) && goalContext && (
        <section className="ag-next">
          <h2>{t(T.next)}</h2>
          <GoalCard matchId={matchId} review={review} lang={lang} ctx={goalContext} />
        </section>
      )}

      {review.did_well.length > 0 && <section><h2>{t(T.well)}</h2><ul className="ag-plain">{review.did_well.map((line, i) => <li key={i}>{line}</li>)}</ul></section>}

      {share}

      <section className="ag-whole">
        <h2>{t(T.whole)}</h2>
        {first && <p className="ag-verdict"><span>{t(T.verdict)}</span>{review.verdict}</p>}
        {overview && overview.fights.length > 0 && overview.duration && <FightStrip fights={overview.fights} duration={overview.duration.t} turn={overview.turning_fight && 'ref' in overview.turning_fight ? overview.turning_fight.ref : null} lang={lang} onAsk={onAsk} />}
        {review.mainline.length > 0 && (
          <details className="ag-fold">
            <summary><h3>{t(T.story)}</h3><span>{t(T.parts).replace('{n}', String(review.mainline.length))}</span></summary>
            <ol className="ag-mainline">{review.mainline.map((line, i) => <li key={i}>{line}</li>)}</ol>
          </details>
        )}
        {(review.game_plan || onPlan) && (
          <details className="ag-fold ag-plan">
            <summary><h3>{t(T.plan)}</h3>{review.game_plan?.main_reason && review.game_plan.why && T.planReason[review.game_plan.main_reason] && <span>{t(T.planReason[review.game_plan.main_reason])}</span>}</summary>
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
          </details>
        )}
        {board && (
          <details className="ag-fold">
            <summary><h3>{t(T.boardFold)}</h3></summary>
            {board}
          </details>
        )}
      </section>

      {review.blind_spots.length > 0 && <section className="ag-blind"><h2>{t(T.blind)}</h2><ul className="ag-plain">{review.blind_spots.map((line, i) => <li key={i}>{line}</li>)}</ul></section>}
    </article>
  );
};
