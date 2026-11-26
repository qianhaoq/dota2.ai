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

type Lang = 'en' | 'zh' | 'ru';
const T = {
  verdict: { en: 'The game in one sentence', zh: '这局一句话', ru: 'Матч в одном предложении' },
  lead: { en: 'The one thing to change', zh: '这局最该改的一件事', ru: 'Главное, что стоит изменить' },
  lesson: { en: 'Practise this next game', zh: '下局只练这一件', ru: 'Отработайте это в следующей игре' },
  moments: { en: 'The moments that show it', zh: '这局的几个时刻', ru: 'Ключевые моменты из реплея' },
  more: {
    one: { en: 'One more thing', zh: '还有一件事', ru: 'Ещё один момент' },
    many: { en: 'Two more things', zh: '还有两件事', ru: 'Ещё два момента' },
  },
  whole: { en: 'The whole game', zh: '整局', ru: 'Весь матч' },
  boardFold: { en: 'Line-ups and scoreboard', zh: '阵容与记分板', ru: 'Пики и таблица матча' },
  parts: { en: '{n} parts', zh: '{n} 段', ru: '{n} этапов' },
  patchExact: { en: 'Prices, item effects and cooldowns in this review are those of patch {p}', zh: '本复盘中的价格、装备效果和技能冷却按 {p}', ru: 'Цены, эффекты предметов и перезарядки в разборе соответствуют патчу {p}' },
  patchFrom: {
    match_data: { en: 'from the match record', zh: '依据比赛记录', ru: 'по данным матча' },
    start_time: { en: 'from when the game was played', zh: '依据比赛开始时间', ru: 'по времени начала матча' },
    match_id: { en: 'from the match id', zh: '依据比赛编号', ru: 'по ID матча' },
  } as Record<string, Record<Lang, string>>,
  patchPlain: { en: '{p}', zh: '{p} 版本', ru: '{p}' },
  patchHotfix: { en: '{p} after its hotfix of {d}', zh: '{p} 版本 {d} 热修复后的数值', ru: '{p} после хотфикса от {d}' },
  patchHotfixUnsure: {
    en: 'Prices, item effects and cooldowns in this review are those of patch {p}; a hotfix of that patch came out around when this game was played, so some numbers may be from just before or after it.',
    zh: '本复盘中的价格、装备效果和技能冷却按 {p} 版本；这局前后该版本正好有一次热修复，个别数值可能是热修复前或后的。',
    ru: 'Цены, эффекты предметов и перезарядки указаны для патча {p}; примерно в это время вышел хотфикс, поэтому отдельные значения могли слегка отличаться.',
  },
  patchUnknown: {
    en: 'The patch of this game could not be told: prices, item effects and cooldowns are those of the current patch {p} and may differ from what they were then.',
    zh: '这局的版本无法确定：价格、装备效果和技能冷却按当前 {p} 版本，可能与当时不同。',
    ru: 'Патч этого матча определить не удалось: цены, эффекты и перезарядки приведены для текущего патча {p} и могут отличаться.',
  },
  story: { en: 'How the game went', zh: '对局主线', ru: 'Ход игры' },
  fights: { en: 'Fights: bars above the line are fights your team lost fewer heroes in; the line is your team\'s gold lead.', zh: '团战：横线上方是我方少死人的团，下方是多死人的团；折线是我方经济领先。', ru: 'Драки: столбцы выше линии — драки, где ваша команда потеряла меньше героев; кривая — перевес по золоту.' },
  turn: { en: 'the turn', zh: '转折', ru: 'перелом' },
  presenceTitle: { en: 'Where you were when your team lost ground in fights', zh: '己方掉势团战里，你当时在哪', ru: 'Где вы были в проигранных драках' },
  presenceNote: {
    en: 'Share of your team’s fight win-chance drops by your state — where you stood, not whose fault a fight was.',
    zh: '按己方掉势团战统计你当时的状态占比——只陈述在不在场，不等同于谁的责任。',
    ru: 'Доля потерь шанса на победу в драках по вашему состоянию — факт позиции, а не оценка вины.',
  },
  presenceCoverage: {
    en: 'Covers the {r} of {total} fights with readable gold-lead minutes ({u} fight(s) lacked gold-lead minutes and are not in these shares).',
    zh: '仅覆盖可算出胜率变化的 {r}/{total} 波团战（另有 {u} 波团缺少对应分钟经济差，未计入占比）。',
    ru: 'Учтены {r} из {total} драк с данными по перевесу золота (ещё {u} без данных за минуту не входят в доли).',
  },
  presenceUnknown: {
    en: 'Not known — {u} fight(s) could not be read for win-chance change (missing gold-lead minutes).',
    zh: '不确定——有 {u} 波团战缺少对应分钟经济差，读不出胜率变化。',
    ru: 'Неизвестно — для {u} драк нельзя прочитать изменение шанса (нет данных по золоту за минуту).',
  },
  presencePart: {
    in_it: { en: 'In the fight', zh: '在团里', ru: 'В драке' },
    elsewhere: { en: 'Elsewhere', zh: '在别处', ru: 'В другом месте' },
    dead: { en: 'Already dead', zh: '已阵亡', ru: 'В таверне' },
    not_known: { en: 'Not sampled', zh: '缺少采样', ru: 'Нет данных' },
  } as Record<'in_it' | 'elsewhere' | 'dead' | 'not_known', Record<Lang, string>>,
  findings: { en: 'What decided it', zh: '核心问题', ru: 'Что решило игру' },
  fix: { en: 'Do instead', zh: '改法', ru: 'Как исправить' },
  ruleWhen: { en: 'When', zh: '当', ru: 'Когда' },
  ruleDo: { en: 'Do', zh: '就', ru: 'Делай' },
  ruleSeen: { en: 'This game', zh: '本局', ru: 'В этой игре' },
  rule: { en: 'Rule for next game', zh: '下一把的规则', ru: 'Правило на следующую игру' },
  next: { en: 'Check it next game', zh: '下一局怎么验证', ru: 'Проверка в следующей игре' },
  well: { en: 'What you did well', zh: '做得好的', ru: 'Что получилось хорошо' },
  blind: { en: 'What the replay could not show', zh: '录像看不到的', ru: 'Чего нет в реплее' },
  askFight: { en: 'the fight at', zh: '这波团战', ru: 'драка на' },
  goalTitle: { en: 'Make it checkable', zh: '定一个能核验的目标', ru: 'Сделайте цель проверяемой' },
  goalSet: { en: 'Make this my next-game goal', zh: '设为下一局目标', ru: 'Сделать целью на следующую игру' },
  goalIs: { en: 'Your next-game goal', zh: '已设为下一局目标', ru: 'Ваша цель на следующую игру' },
  goalHow: { en: 'Play your next game, then open it here or on your games page: the coach checks it against the scoreboard.', zh: '打完下一局，在这里或「我的比赛」里打开它，教练会按记分板核验。', ru: 'Сыграйте следующий матч и откройте его здесь или в списке игр — тренер проверит цель по таблице.' },
  goalNext: { en: 'Your next game shows up on the dota2.ai home page with this goal already checked — open it after you play.', zh: '打完下一局打开 dota2.ai 首页，那一局会出现在最上面，这个目标已经核验好。', ru: 'Ваш следующий матч появится на главной dota2.ai уже с проверкой этой цели.' },
  goalNextReplay: { en: 'Your next game shows up on the dota2.ai home page — open it from there. This goal is checked once that game’s replay has been read, not from the scoreboard.', zh: '打完下一局打开 dota2.ai 首页，那一局会出现在最上面，从那里点开它。这个目标要读完那一局的录像才能核验，光看记分板判断不了。', ru: 'Ваш следующий матч появится на главной dota2.ai. Эта цель проверяется по реплею, а не по итоговой таблице.' },
  goalHowReplay: { en: 'Play your next game, then open it here: the same things are counted in its replay and you see which rules held — about a minute, with or without a new review.', zh: '打完下一局，在这里打开它：会在那盘录像里数同样的事，逐条告诉你规则守住了没有——大约一分钟，要不要再写一份复盘都可以。', ru: 'Сыграйте следующий матч и откройте его здесь: мы посчитаем те же показатели по реплею за минуту, даже без нового разбора.' },
  goalRules: { en: 'Counted in your next replay', zh: '下一盘录像里会数的', ru: 'Проверим в следующем реплее' },
  ruleCheck: { en: 'Next game', zh: '下一盘', ru: 'След. игра' },
  goalUndo: { en: 'Remove', zh: '取消', ru: 'Удалить' },
  goalFrom: { en: 'From finding', zh: '对应问题', ru: 'Из вывода' },
  plan: { en: 'The game plan', zh: '运营思路', ru: 'План на игру' },
  planSub: { en: 'The game as a whole: what the teams did with the map, and where you were.', zh: '整局来看：双方怎么用地图和团战，你当时在哪里。', ru: 'Картина матча целиком: как команды использовали карту и где были вы.' },
  planLineUps: { en: 'The line-ups', zh: '阵容', ru: 'Драфты' },
  planStrengths: { en: 'What you were up against', zh: '对位与强势期', ru: 'Против чего вы играли' },
  planWindow: { en: 'Your chance', zh: '窗口期', ru: 'Ваше окно' },
  planYours: { en: 'Against your plan', zh: '对照你的思路', ru: 'По вашему плану' },
  planCourse: { en: 'How it went', zh: '走势', ru: 'Ход матча' },
  planYou: { en: 'Your part', zh: '你的部分', ru: 'Ваш вклад' },
  planReason: {
    your_play: { en: 'Mostly your own play', zh: '主要在你自己的打法', ru: 'В основном ваша игра' },
    team_play: { en: 'Mostly the team, not you', zh: '主要在队伍，不在你', ru: 'В основном команда, не вы' },
    enemy_play: { en: 'Mostly what the enemy did', zh: '主要是对面做对了', ru: 'В основном действия врага' },
    line_ups: { en: 'Mostly the line-ups', zh: '主要在阵容', ru: 'В основном драфты' },
    unclear: { en: 'The data does not settle it', zh: '数据定不了', ru: 'По данным однозначно не сказать' },
  } as Record<string, Record<Lang, string>>,
  replan: { en: 'You can also have the whole review rewritten against “{p}”{t}.', zh: '也可以按「{p}」重写整份复盘{t}。', ru: 'Можно также переписать весь разбор под план «{p}»{t}.' },
  // The default model's time. Another model's is said where the rewrite is started (the page), so not here.
  replanTime: { en: ' (about two to three minutes)', zh: '（约 2–3 分钟）', ru: ' (около 2–3 минут)' },
  replanGo: { en: 'Rewrite it', zh: '重写', ru: 'Переписать' },
  intentBusy: { en: 'The coach is still answering your last question. Pick again when it is done.', zh: '教练还在回答上一个问题，等它答完再选。', ru: 'Тренер ещё отвечает на прошлый вопрос. Повторите чуть позже.' },
  intentAsk: { en: 'What were you going for this game? Tell the coach: it checks your plan against the replay.', zh: '这局你本来想怎么打？告诉教练，它会对照录像回答。', ru: 'Какой план был на эту игру? Скажите тренеру — он сверит его с реплеем.' },
} as const;

/** What a player may have been going for (lib/agent/plans.js). The label is the button; `said` is how it reads inside the question. */
export const PLAN_INTENTS: readonly { key: string; label: Record<Lang, string>; said: Record<Lang, string> }[] = PLANS;
/** The question a chosen plan sends to the coach: the three things a plan is checked on. */
export const planQuestion = (key: string, lang: Lang): string | null => {
  const said = PLAN_INTENTS.find((p) => p.key === key)?.said[lang];
  if (!said) return null;
  if (lang === 'zh') {
    return `我这局的思路是「${said}」。我的打法和这个思路一致吗？面对对面的阵容，这个思路站得住吗？没打成的话，是我没做好、思路不对，还是被对面针对了？`;
  }
  if (lang === 'ru') {
    return `Мой план на эту игру был: ${said}. Соответствовала ли моя игра этому плану? Подходил ли он против их драфта? И где он сломался — из-за моей игры, плана или действий соперника?`;
  }
  return `My plan this game was to ${said}. Did my play fit it? Was it sound against their line-up? And where it failed, was that my play, the plan, or what the enemy did?`;
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
      <p className="ag-goal-label">{spec.label[lang] ?? spec.label.en}</p>
      {more.length > 0 && (
        <>
          <p className="ag-goal-eyebrow">{T.goalRules[lang]}</p>
          <ul className="ag-goal-rules">{more.map((r) => <li key={r.finding}><span className="ag-num">{r.finding}</span>{r.check.label[lang] ?? r.check.label.en}</li>)}</ul>
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

interface FallsByMyPart {
  in_it: number | null;
  elsewhere: number | null;
  dead: number | null;
  not_known: number | null;
}

const PRESENCE_KEYS = ['in_it', 'elsewhere', 'dead', 'not_known'] as const;

const FightPresenceStrip: React.FC<{ falls: FallsByMyPart; fightsRead: number; fightsNotRead: number; lang: Lang }> = ({ falls, fightsRead, fightsNotRead, lang }) => {
  const parts = PRESENCE_KEYS
    .map((key) => ({ key, share: falls[key] }))
    .filter((p): p is { key: typeof PRESENCE_KEYS[number]; share: number } => typeof p.share === 'number' && p.share > 0);
  if (parts.length === 0 && fightsNotRead <= 0) return null;
  const total = fightsRead + fightsNotRead;
  return (
    <figure className="ag-presence" aria-label={T.presenceTitle[lang]}>
      <p className="ag-presence-head">{T.presenceTitle[lang]}</p>
      {parts.length > 0 ? (
        <>
          <div className="ag-presence-bar" role="img" aria-label={parts.map((p) => `${T.presencePart[p.key][lang]} ${Math.round(p.share * 100)}%`).join(', ')}>
            {parts.map((p) => (
              <span key={p.key} className={`ag-presence-seg is-${p.key}`} style={{ flexGrow: p.share, flexBasis: `${Math.round(p.share * 100)}%` }} />
            ))}
          </div>
          <ul className="ag-presence-legend">
            {parts.map((p) => (
              <li key={p.key} className={`is-${p.key}`}>
                <i aria-hidden="true" />
                <span>{T.presencePart[p.key][lang]}</span>
                <b>{Math.round(p.share * 100)}%</b>
              </li>
            ))}
          </ul>
          {fightsNotRead > 0 && (
            <p className="ag-presence-unread">
              {T.presenceCoverage[lang].replace('{r}', String(fightsRead)).replace('{total}', String(total)).replace('{u}', String(fightsNotRead))}
            </p>
          )}
        </>
      ) : (
        <p className="ag-presence-unread">{T.presenceUnknown[lang].replace('{u}', String(fightsNotRead))}</p>
      )}
      <figcaption>{T.presenceNote[lang]}</figcaption>
    </figure>
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
  const [moments, setMoments] = useState<{ read?: boolean; falls_by_my_part?: FallsByMyPart | null; fights_read?: number; fights_not_read?: number } | null>(null);
  useEffect(() => {
    let alive = true;
    setOverview(null);
    setMoments(null);
    fetchEvidence(matchId, review.hero, lang, 'overview').then((r) => { if (alive) setOverview(r.record); }).catch(() => {});
    fetchEvidence(matchId, review.hero, lang, `moments:${review.hero}`).then((r) => { if (alive) setMoments(r.record); }).catch(() => {});
    return () => { alive = false; };
  }, [matchId, review.hero, lang]);
  const [first, ...rest] = review.findings;
  type Finding = DeepReview['findings'][number];
  const ruleOf = (f: Finding) => f.rule && (
    <dl className="ag-rule" aria-label={t(T.rule)}>
      <div><dt>{t(T.ruleWhen)}</dt><dd>{f.rule.when}</dd></div>
      <div><dt>{t(T.ruleDo)}</dt><dd>{f.rule.do}</dd></div>
      {f.rule.this_game && <div className="ag-rule-seen"><dt>{t(T.ruleSeen)}</dt><dd>{f.rule.this_game}</dd></div>}
      {f.rule.check && <div className="ag-rule-check"><dt>{t(T.ruleCheck)}</dt><dd>{f.rule.check.label[lang] ?? f.rule.check.label.en}</dd></div>}
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
        {overview && Array.isArray(overview.fights) && overview.fights.length > 0 && overview.duration && <FightStrip fights={overview.fights} duration={overview.duration.t} turn={overview.turning_fight && 'ref' in overview.turning_fight ? overview.turning_fight.ref : null} lang={lang} onAsk={onAsk} />}
        {moments?.read && moments.falls_by_my_part && <FightPresenceStrip falls={moments.falls_by_my_part} fightsRead={moments.fights_read ?? 0} fightsNotRead={moments.fights_not_read ?? 0} lang={lang} />}
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
