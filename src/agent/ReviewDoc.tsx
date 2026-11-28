import React, { useEffect, useState } from 'react';
import { fetchEvidence, type ChapterAssessment, type ChapterTopic, type DeepReview, type ReviewRunMeta } from './api';
import { EvidenceCard } from './EvidenceCard';
import { PLANS, planByKey } from '../../lib/agent/plans.js';
import { FindingFeedback } from './FindingFeedback';
import { formatUsageSummary } from './usageFormat';

/**
 * The review as a coaching document.
 *
 * Modern reviews (with `opening_note`, `highlights`, `chapters`, or `encouragement`) lead with a balanced
 * coach overview, celebrate evidence-backed highlights, break down the game across adaptive full-dimension
 * chapters, present high-leverage player-controlled improvements, close with sincere encouragement, and keep
 * the whole-game view (fights, story, game plan, scoreboard) and blind spots right below.
 *
 * Legacy stored reviews (without the new coach fields) keep a clean backwards-compatible layout — with zero
 * mechanical KPI quotas or goal cards in either layout.
 */

type Lang = 'en' | 'zh' | 'ru';
const T = {
  coachEyebrow: { en: "Coach's review", zh: '教练总评', ru: 'Разбор тренера' },
  highlightsTitle: { en: 'What you did well', zh: '本局亮点与肯定', ru: 'Сильные стороны в этом матче' },
  chaptersTitle: { en: 'Match breakdown', zh: '全维度复盘', ru: 'Разбор по аспектам' },
  chapterTakeaway: { en: "Coach's tip", zh: '实战建议', ru: 'Совет тренера' },
  improvementsTitle: { en: 'Key improvements', zh: '最值得打磨的关键点', ru: 'Ключевые точки роста' },
  encouragementTitle: { en: "Coach's note", zh: '教练寄语', ru: 'Слово тренера' },
  chapterTopic: {
    draft_and_lanes: { en: 'Draft & lanes', zh: '阵容与分路', ru: 'Драфт и линии' },
    laning: { en: 'Laning', zh: '对线期', ru: 'Лайнинг' },
    skill_build: { en: 'Skill build', zh: '技能加点', ru: 'Раскачка' },
    items: { en: 'Item build', zh: '出装思路', ru: 'Сборка предметов' },
    teamfights: { en: 'Teamfights', zh: '团战表现', ru: 'Тимфайты' },
    macro: { en: 'Macro & tempo', zh: '运营思路', ru: 'Макро и темп' },
    other: { en: 'Key details', zh: '关键细节', ru: 'Ключевые детали' },
  } as Record<ChapterTopic, Record<Lang, string>>,
  chapterAssessment: {
    praise: { en: 'Standout', zh: '本局亮点', ru: 'Сильная сторона' },
    solid: { en: 'Solid', zh: '执行稳健', ru: 'Надёжно' },
    mixed: { en: 'Mixed', zh: '有得有失', ru: 'Смешанно' },
    key_gap: { en: 'Key focus', zh: '重点打磨', ru: 'Точка роста' },
  } as Record<ChapterAssessment, Record<Lang, string>>,
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
  // The story as a chain of causes (#437 P4): whose each link mostly was, and its records.
  whose: {
    me: { en: 'You', zh: '你', ru: 'Вы' }, team: { en: 'Team', zh: '队伍', ru: 'Команда' }, enemy: { en: 'Enemy', zh: '对手', ru: 'Враг' },
    draft: { en: 'Draft', zh: '阵容', ru: 'Драфт' }, unclear: { en: 'Unclear', zh: '不确定', ru: 'Неясно' },
  } as Record<string, { en: string; zh: string; ru: string }>,
  storyRecords: { en: 'Records', zh: '依据', ru: 'Записи' },
  storyBecause: { en: 'Because', zh: '原因', ru: 'Потому что' },
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
  rule: { en: 'Rule for next game', zh: '下一把的思路', ru: 'Ориентир на следующую игру' },
  well: { en: 'What you did well', zh: '做得好的', ru: 'Что получилось хорошо' },
  blind: { en: 'What the replay could not show', zh: '录像看不到的', ru: 'Чего нет в реплее' },
  askFight: { en: 'the fight at', zh: '这波团战', ru: 'драка на' },
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
  usageLabel: { en: 'Review token usage', zh: '本次复盘用量', ru: 'Расход токенов на разбор' },
  usageStages: { en: 'Stage breakdown', zh: '分阶段明细', ru: 'По этапам' },
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

export interface Fight { ref: string; from: number; to: number; clock: string; my_team_deaths: number; enemy_deaths: number; my_team_gold_lead_before?: number | null; my_team_gold_lead_2min_after?: number | null }

/**
 * `turn`: the ref of the fight the game turned on, as match_overview names it for a game the player's team lost
 * (the fight the review was pointed at) — the strip marks that one and does not work it out again.
 */
export const FightStrip: React.FC<{ fights: Fight[]; duration: number; turn: string | null; lang: Lang; onAsk: (label: string, refs: string[]) => void; onSelectFight?: (fight: Fight) => void; fightActionLabel?: string }> = ({ fights, duration, turn, lang, onAsk, onSelectFight, fightActionLabel }) => {
  const W = 720; const H = 120; const mid = H / 2; const pad = 8;
  const x = (t: number) => pad + (Math.max(0, t) / Math.max(1, duration)) * (W - pad * 2);
  const gold = fights.filter((f) => f.my_team_gold_lead_before != null);
  const maxGold = Math.max(2000, ...gold.map((f) => Math.abs(f.my_team_gold_lead_before!)));
  const y = (v: number) => mid - (v / maxGold) * (mid - pad);
  const labelPrefix = fightActionLabel ?? T.askFight[lang];
  const activate = (f: Fight) => { if (onSelectFight) onSelectFight(f); else onAsk(`${T.askFight[lang]} ${f.clock}`, [f.ref]); };
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
              role="button" tabIndex={0} aria-label={`${labelPrefix} ${f.clock}, ${f.my_team_deaths}:${f.enemy_deaths}`} onClick={() => activate(f)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(f); } }}>
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

export const ReviewDoc: React.FC<{ matchId: string; review: DeepReview; lang: Lang; onAsk: (label: string, refs: string[]) => void; /** Send a plan question to the coach; false when it could not be sent (the coach is still answering). */ onPlan?: (question: string) => boolean; /** Have the whole review made again for this plan (the page opens its start, with the plan picked). */ onReplan?: (plan: string) => void; /** The match record (line-ups, items, gold), shown under the whole-game section. */ board?: React.ReactNode; /** Sharing the review. */ share?: React.ReactNode; /** The review is the default model's, whose rewrite takes the usual two to three minutes; false for another model's. */ quick?: boolean; /** Actual token usage, steps, tool calls, repair rounds, and model from this run (no fabricated pricing). */ runMeta?: ReviewRunMeta | null; /** Ask under each finding whether it was right: the plan this review was asked with, the id of the model that wrote it and the prompt version it was written under (they name the stored review the word is about). Absent: not asked. */ feedback?: { plan?: string | null; model?: string | null; version: number } | null }> = ({ matchId, review, lang, onAsk, onPlan, onReplan, board = null, feedback = null, share = null, quick = true, runMeta = null }) => {
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

  const findings = Array.isArray(review.findings) ? review.findings.filter((f) => f && typeof f === 'object') : [];
  const [first, ...rest] = findings;
  type Finding = DeepReview['findings'][number];
  const ruleOf = (f: Finding) => f.rule && (
    <dl className="ag-rule" aria-label={t(T.rule)}>
      <div><dt>{t(T.ruleWhen)}</dt><dd>{f.rule.when}</dd></div>
      <div><dt>{t(T.ruleDo)}</dt><dd>{f.rule.do}</dd></div>
      {f.rule.this_game && <div className="ag-rule-seen"><dt>{t(T.ruleSeen)}</dt><dd>{f.rule.this_game}</dd></div>}
    </dl>
  );
  // Keyed by the finding it is about: another review of the same game starts unanswered.
  const feedbackOf = (f: Finding, i: number) => feedback && <FindingFeedback key={`${i}:${f.title}`} matchId={matchId} hero={review.hero} lang={lang} plan={feedback.plan} model={feedback.model} version={feedback.version} index={i} title={f.title} />;
  const evidenceList = (items: DeepReview['findings'][number]['evidence']) => {
    const safe = Array.isArray(items) ? items.filter((e) => e && typeof e === 'object') : [];
    return safe.length > 0 ? <ul className="ag-evidence">{safe.map((e, j) => <EvidenceCard key={j} matchId={matchId} hero={review.hero} lang={lang} item={e} onAsk={onAsk} />)}</ul> : null;
  };
  const patch = review.data_patch && (review.data_patch.exact
    ? <p className="ag-patch">{t(T.patchExact).replace('{p}', patchName(review.data_patch))}{review.data_patch.known_from && T.patchFrom[review.data_patch.known_from] ? (lang === 'zh' ? `（${t(T.patchFrom[review.data_patch.known_from])}）` : ` (${t(T.patchFrom[review.data_patch.known_from])})`) : ''}</p>
    // The release is known and only the hotfix within it is not: say that, not that the patch is unknown.
    : /hotfix/.test(review.data_patch.reason ?? '')
      ? <p className="ag-patch is-unknown" role="note">{t(T.patchHotfixUnsure).replace('{p}', review.data_patch.name)}</p>
      : <p className="ag-patch is-unknown" role="note">{t(T.patchUnknown).replace('{p}', review.data_patch.name)}</p>);

  const highlights = Array.isArray(review.highlights) ? review.highlights.filter((h) => h && typeof h === 'object') : [];
  const chapters = Array.isArray(review.chapters) ? review.chapters.filter((c) => c && typeof c === 'object') : [];
  const didWell = Array.isArray(review.did_well) ? review.did_well.filter((line): line is string => typeof line === 'string') : [];
  const mainline = Array.isArray(review.mainline) ? review.mainline.filter((line): line is string => typeof line === 'string') : [];
  const blindSpots = Array.isArray(review.blind_spots) ? review.blind_spots.filter((line): line is string => typeof line === 'string') : [];
  const story = Array.isArray(review.story) ? review.story.filter((l) => l && typeof l === 'object') : [];
  const openingNote = typeof review.opening_note === 'string' && review.opening_note.trim() ? review.opening_note : null;
  const encouragement = typeof review.encouragement === 'string' && review.encouragement.trim() ? review.encouragement : null;
  const hasHighlights = highlights.length > 0;
  const hasChapters = chapters.length > 0;
  const isCoachLayout = Boolean(openingNote || hasHighlights || hasChapters || encouragement);
  const formattedUsage = formatUsageSummary(runMeta, lang);
  const usageFooter = formattedUsage && (
    <footer className="ag-usage" aria-label={t(T.usageLabel)}>
      <p className="ag-usage-line">
        <span className="ag-usage-label">{t(T.usageLabel)}</span>
        <span className="ag-usage-stats">{formattedUsage.summary}</span>
      </p>
      <p className="ag-usage-source">{formattedUsage.sourceLabel}</p>
      {formattedUsage.stages.length > 1 && (
        <details className="ag-usage-stages">
          <summary>{t(T.usageStages)}</summary>
          <ul>
            {formattedUsage.stages.map((st) => (
              <li key={st.key}>
                <b>{st.label}</b>
                <span>{st.text}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </footer>
  );

  const wholeGame = (showVerdict: boolean) => (
    <section className="ag-whole">
      <h2>{t(T.whole)}</h2>
      {showVerdict && <p className="ag-verdict"><span>{t(T.verdict)}</span>{review.verdict}</p>}
      {overview && Array.isArray(overview.fights) && overview.fights.length > 0 && overview.duration && <FightStrip fights={overview.fights} duration={overview.duration.t} turn={overview.turning_fight && 'ref' in overview.turning_fight ? overview.turning_fight.ref : null} lang={lang} onAsk={onAsk} />}
      {moments?.read && moments.falls_by_my_part && <FightPresenceStrip falls={moments.falls_by_my_part} fightsRead={moments.fights_read ?? 0} fightsNotRead={moments.fights_not_read ?? 0} lang={lang} />}
      {story.length > 0 ? (
        <div className="ag-story">
          <h3>{t(T.story)}</h3>
          <ol>
            {story.map((l, i) => {
              const ev = Array.isArray(l.evidence) ? l.evidence : [];
              return (
              <li key={i} className={`is-${l.whose}`}>
                <p className="ag-story-head"><b>{l.phase}</b>{T.whose[l.whose] && <span className={`ag-story-whose is-${l.whose}`}>{t(T.whose[l.whose])}</span>}</p>
                <p className="ag-story-what">{l.what_changed}</p>
                <p className="ag-story-why"><span>{t(T.storyBecause)}</span>{l.because}</p>
                {ev.length > 0 && (
                  <details className="ag-story-records">
                    <summary>{t(T.storyRecords)} · {ev.length}</summary>
                    {evidenceList(ev)}
                  </details>
                )}
              </li>
              );
            })}
          </ol>
        </div>
      ) : mainline.length > 0 && (
        <details className="ag-fold">
          <summary><h3>{t(T.story)}</h3><span>{t(T.parts).replace('{n}', String(mainline.length))}</span></summary>
          <ol className="ag-mainline">{mainline.map((line, i) => <li key={i}>{line}</li>)}</ol>
        </details>
      )}
      {(review.game_plan || onPlan) && (
        <details className="ag-fold ag-plan">
          <summary><h3>{t(T.plan)}</h3>{review.game_plan?.main_reason && review.game_plan.why && T.planReason[review.game_plan.main_reason] && <span>{t(T.planReason[review.game_plan.main_reason])}</span>}</summary>
          {review.game_plan && (
            <>
              <p className="ag-plan-sub">{t(T.planSub)}</p>
              {(review.game_plan.against_your_plan || review.game_plan.window || review.game_plan.strengths || review.game_plan.course || review.game_plan.your_part || review.game_plan.line_ups) && (
                <dl className="ag-plan-parts">
                  {review.game_plan.against_your_plan && <div className="ag-plan-yours"><dt>{t(T.planYours)}{planByKey(review.plan ?? '') ? <span>{planByKey(review.plan ?? '')!.label[lang]}</span> : null}</dt><dd>{review.game_plan.against_your_plan}</dd></div>}
                  {review.game_plan.window && <div><dt>{t(T.planWindow)}</dt><dd>{review.game_plan.window}</dd></div>}
                  {review.game_plan.strengths && <div><dt>{t(T.planStrengths)}</dt><dd>{review.game_plan.strengths}</dd></div>}
                  {review.game_plan.course && <div><dt>{t(T.planCourse)}</dt><dd>{review.game_plan.course}</dd></div>}
                  {review.game_plan.your_part && <div><dt>{t(T.planYou)}</dt><dd>{review.game_plan.your_part}</dd></div>}
                  {review.game_plan.line_ups && <div><dt>{t(T.planLineUps)}</dt><dd>{review.game_plan.line_ups}</dd></div>}
                </dl>
              )}
              {review.game_plan.main_reason && review.game_plan.why && T.planReason[review.game_plan.main_reason] && (
                <p className="ag-plan-why"><span className={`ag-plan-tag is-${review.game_plan.main_reason}`}>{t(T.planReason[review.game_plan.main_reason])}</span>{review.game_plan.why}</p>
              )}
              {Array.isArray(review.game_plan.evidence) && review.game_plan.evidence.length > 0 && evidenceList(review.game_plan.evidence)}
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
  );

  if (isCoachLayout) {
    return (
      <article className="ag-doc is-coach">
        <section className="ag-lead">
          <div className="ag-lead-meta">
            <p className="cx-eyebrow">{t(T.coachEyebrow)}</p>
            {review.game_plan?.main_reason && review.game_plan.why && T.planReason[review.game_plan.main_reason] && (
              <span className={`ag-lead-reason is-${review.game_plan.main_reason}`}>{t(T.planReason[review.game_plan.main_reason])}</span>
            )}
          </div>
          <h1>{review.verdict}</h1>
          {openingNote && <p className="ag-opening">{openingNote}</p>}
          {patch}
        </section>

        {(hasHighlights || didWell.length > 0) && (
          <section className="ag-highlights">
            <h2>{t(T.highlightsTitle)}</h2>
            {hasHighlights ? (
              <div className="ag-highlight-list">
                {highlights.map((h, i) => (
                  <article key={i} className="ag-highlight">
                    <h3>{h.title}</h3>
                    <p className="ag-highlight-detail">{h.detail}</p>
                    {Array.isArray(h.evidence) && h.evidence.length > 0 && evidenceList(h.evidence)}
                  </article>
                ))}
              </div>
            ) : (
              <ul className="ag-plain">{didWell.map((line, i) => <li key={i}>{line}</li>)}</ul>
            )}
          </section>
        )}

        {hasChapters && (
          <section className="ag-chapters">
            <h2>{t(T.chaptersTitle)}</h2>
            <div className="ag-chapter-list">
              {chapters.map((c, i) => (
                <article key={i} className={`ag-chapter is-${c.assessment}`}>
                  <div className="ag-chapter-meta">
                    <span className="ag-chapter-topic">{t(T.chapterTopic[c.topic] ?? T.chapterTopic.other)}</span>
                    <span className={`ag-chapter-badge is-${c.assessment}`}>{t(T.chapterAssessment[c.assessment] ?? T.chapterAssessment.mixed)}</span>
                  </div>
                  <h3>{c.title}</h3>
                  <p className="ag-chapter-analysis">{c.analysis}</p>
                  {typeof c.takeaway === 'string' && c.takeaway.trim() && <p className="ag-chapter-takeaway"><span>{t(T.chapterTakeaway)}</span>{c.takeaway}</p>}
                  {Array.isArray(c.evidence) && c.evidence.length > 0 && (
                    <details className="ag-chapter-records">
                      <summary>{t(T.storyRecords)} · {c.evidence.length}</summary>
                      {evidenceList(c.evidence)}
                    </details>
                  )}
                </article>
              ))}
            </div>
          </section>
        )}

        {findings.length > 0 && (
          <section className="ag-improvements">
            <h2>{t(T.improvementsTitle)}</h2>
            {first && (
              <article className="ag-finding is-lead">
                <h3><span className="ag-num">1</span>{first.title}</h3>
                <p className="ag-claim">{first.claim}</p>
                {Array.isArray(first.evidence) && first.evidence.length > 0 && evidenceList(first.evidence)}
                {ruleOf(first)}
                {first.fix && <p className="ag-fix"><span>{t(T.fix)}</span>{first.fix}</p>}
                {feedbackOf(first, 0)}
              </article>
            )}
            {rest.map((f, i) => (
              <details key={i} className="ag-finding">
                <summary><h3><span className="ag-num">{i + 2}</span>{f.title}</h3></summary>
                <p className="ag-claim">{f.claim}</p>
                {Array.isArray(f.evidence) && f.evidence.length > 0 && evidenceList(f.evidence)}
                {ruleOf(f)}
                {f.fix && <p className="ag-fix"><span>{t(T.fix)}</span>{f.fix}</p>}
                {feedbackOf(f, i + 1)}
              </details>
            ))}
          </section>
        )}

        {encouragement && (
          <section className="ag-encouragement">
            <h2>{t(T.encouragementTitle)}</h2>
            <p>{encouragement}</p>
          </section>
        )}

        {share}

        {wholeGame(false)}

        {blindSpots.length > 0 && <section className="ag-blind"><h2>{t(T.blind)}</h2><ul className="ag-plain">{blindSpots.map((line, i) => <li key={i}>{line}</li>)}</ul></section>}
        {usageFooter}
      </article>
    );
  }

  return (
    <article className="ag-doc">
      <section className="ag-lead">
        <p className="cx-eyebrow">{t(first ? T.lead : T.verdict)}</p>
        <h1>{first ? first.title : review.verdict}</h1>
        {first && <p className="ag-lead-claim">{first.claim}</p>}
        {patch}
        {first && !(first.rule || first.fix) && (!Array.isArray(first.evidence) || first.evidence.length === 0) && feedbackOf(first, 0)}
      </section>

      {first && (first.rule || first.fix) && (
        <section className="ag-lesson">
          <h2>{t(T.lesson)}</h2>
          {ruleOf(first)}
          {first.fix && <p className="ag-fix"><span>{t(T.fix)}</span>{first.fix}</p>}
          {(!Array.isArray(first.evidence) || first.evidence.length === 0) && feedbackOf(first, 0)}
        </section>
      )}

      {first && Array.isArray(first.evidence) && first.evidence.length > 0 && (
        <section className="ag-moments">
          <h2>{t(T.moments)}</h2>
          {evidenceList(first.evidence)}
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
              {evidenceList(f.evidence)}
              {ruleOf(f)}
              {f.fix && <p className="ag-fix"><span>{t(T.fix)}</span>{f.fix}</p>}
              {feedbackOf(f, i + 1)}
            </details>
          ))}
        </section>
      )}

      {didWell.length > 0 && <section><h2>{t(T.well)}</h2><ul className="ag-plain">{didWell.map((line, i) => <li key={i}>{line}</li>)}</ul></section>}

      {share}

      {wholeGame(Boolean(first))}

      {blindSpots.length > 0 && <section className="ag-blind"><h2>{t(T.blind)}</h2><ul className="ag-plain">{blindSpots.map((line, i) => <li key={i}>{line}</li>)}</ul></section>}
      {usageFooter}
    </article>
  );
};
