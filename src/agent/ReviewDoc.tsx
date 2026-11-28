import React, { useEffect, useState } from 'react';
import { fetchEvidence, type ChapterTopic, type DeepReview, type ReviewRunMeta } from './api';
import { EvidenceCard } from './EvidenceCard';
import { PLANS, planByKey } from '../../lib/agent/plans.js';
import { FindingFeedback } from './FindingFeedback';
import { formatUsageSummary } from './usageFormat';

/**
 * The review as a clear, non-templated coaching document:
 * 1. Direct verdict + whole-game attribution tag + patch
 * 2. Up-front Pros & Cons ("做得好的" + "做得不好的") right at the top
 * 3. Chronological Dota 2 walkthrough (draft → recommended game plan → laning → midgame → wards & macro → skills & items)
 * 4. Share bar, whole-game visuals & attribution/replan, blind spots, and token usage
 */

type Lang = 'en' | 'zh' | 'ru';

/** Canonical chronological progression for walkthrough chapters (ties preserve original order). */
const CHAPTER_ORDER: Record<ChapterTopic, number> = {
  draft: 0,
  game_plan: 1,
  laning: 2,
  midgame: 3,
  vision_and_macro: 4,
  skills_and_items: 5,
  other: 6,
};

const T = {
  highlightsTitle: { en: 'What went well', zh: '做得好的', ru: 'Что получилось хорошо' },
  improvementsTitle: { en: "What didn't", zh: '做得不好的', ru: 'Что не получилось' },
  chaptersTitle: { en: 'Match walkthrough', zh: '逐层复盘', ru: 'Разбор по этапам' },
  chapterNavLabel: { en: 'Review outline', zh: '复盘目录', ru: 'Содержание разбора' },
  chapterTopic: {
    draft: { en: 'Draft & matchups', zh: '阵容选择与克制', ru: 'Драфт и матчапы' },
    game_plan: { en: 'Recommended game plan', zh: '本局推荐运营思路', ru: 'Рекомендуемый план' },
    laning: { en: 'Lanes & laning', zh: '实际分路与对线', ru: 'Линии и лайнинг' },
    midgame: { en: 'Midgame fights & farm', zh: '中期打架与打钱', ru: 'Мидгейм: драки и фарм' },
    vision_and_macro: { en: 'Wards & macro', zh: '视野布置与运营', ru: 'Варды и макро' },
    skills_and_items: { en: 'Skills & items', zh: '技能与出装', ru: 'Навыки и предметы' },
    other: { en: 'Key details', zh: '其他细节', ru: 'Ключевые детали' },
  } as Record<ChapterTopic, Record<Lang, string>>,
  whole: { en: 'The whole game', zh: '整局数据', ru: 'Весь матч' },
  boardFold: { en: 'Line-ups and scoreboard', zh: '阵容与记分板', ru: 'Пики и таблица матча' },
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
  records: { en: 'Records', zh: '依据', ru: 'Записи' },
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
  fix: { en: 'Do instead', zh: '改法', ru: 'Как исправить' },
  blind: { en: 'What the replay could not show', zh: '录像看不到的', ru: 'Чего нет в реплее' },
  askFight: { en: 'the fight at', zh: '这波团战', ru: 'драка на' },
  plan: { en: 'Whole-game attribution & plan check', zh: '整局归因与思路核对', ru: 'Общая оценка и проверка плана' },
  planYours: { en: 'Against your plan', zh: '对照你的思路', ru: 'По вашему плану' },
  planReason: {
    your_play: { en: 'Mostly your own play', zh: '主要在你自己的打法', ru: 'В основном ваша игра' },
    team_play: { en: 'Mostly the team, not you', zh: '主要在队伍，不在你', ru: 'В основном команда, не вы' },
    enemy_play: { en: 'Mostly what the enemy did', zh: '主要是对面做对了', ru: 'В основном действия врага' },
    line_ups: { en: 'Mostly the line-ups', zh: '主要在阵容', ru: 'В основном драфты' },
    unclear: { en: 'The data does not settle it', zh: '数据定不了', ru: 'По данным однозначно не сказать' },
  } as Record<string, Record<Lang, string>>,
  replan: { en: 'You can also have the whole review rewritten against “{p}”{t}.', zh: '也可以按「{p}」重写整份复盘{t}。', ru: 'Можно также переписать весь разбор под план «{p}»{t}.' },
  replanTime: { en: ' (about two to three minutes)', zh: '（约 2–3 分钟）', ru: ' (около 2–3 минут)' },
  replanGo: { en: 'Rewrite it', zh: '重写', ru: 'Переписать' },
  intentBusy: { en: 'The coach is still answering your last question. Pick again when it is done.', zh: '教练还在回答上一个问题，等它答完再选。', ru: 'Тренер ещё отвечает на прошлый вопрос. Повторите чуть позже.' },
  intentAsk: { en: 'What were you going for this game? Tell the coach: it checks your plan against the replay.', zh: '这局你本来想怎么打？告诉教练，它会对照录像回答。', ru: 'Какой план был на эту игру? Скажите тренеру — он сверит его с реплеем.' },
  usageLabel: { en: 'Review token usage', zh: '本次复盘用量', ru: 'Расход токенов на разбор' },
  usageStages: { en: 'Stage breakdown', zh: '分阶段明细', ru: 'По этапам' },
} as const;

/** What a player may have been going for (lib/agent/plans.js). */
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

export const ReviewDoc: React.FC<{
  matchId: string;
  review: DeepReview;
  lang: Lang;
  onAsk: (label: string, refs: string[]) => void;
  onPlan?: (question: string) => boolean;
  onReplan?: (plan: string) => void;
  board?: React.ReactNode;
  share?: React.ReactNode;
  quick?: boolean;
  runMeta?: ReviewRunMeta | null;
  feedback?: { plan?: string | null; model?: string | null; version: number } | null;
}> = ({ matchId, review, lang, onAsk, onPlan, onReplan, board = null, feedback = null, share = null, quick = true, runMeta = null }) => {
  const t = (b: Record<Lang, string>) => b[lang];
  const patchName = (dp: { name: string; hotfix?: string }) => t(dp.hotfix ? T.patchHotfix : T.patchPlain).replace('{p}', dp.name).replace('{d}', (dp.hotfix ?? '').slice(0, 10));
  const [planHeld, setPlanHeld] = useState(false);
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
  const feedbackOf = (f: Finding, i: number) => feedback && <FindingFeedback key={`${i}:${f.title}`} matchId={matchId} hero={review.hero} lang={lang} plan={feedback.plan} model={feedback.model} version={feedback.version} index={i} title={f.title} />;
  const evidenceList = (items: DeepReview['findings'][number]['evidence']) => {
    const safe = Array.isArray(items) ? items.filter((e) => e && typeof e === 'object') : [];
    return safe.length > 0 ? <ul className="ag-evidence">{safe.map((e, j) => <EvidenceCard key={j} matchId={matchId} hero={review.hero} lang={lang} item={e} onAsk={onAsk} />)}</ul> : null;
  };
  const patch = review.data_patch && (review.data_patch.exact
    ? <p className="ag-patch">{t(T.patchExact).replace('{p}', patchName(review.data_patch))}{review.data_patch.known_from && T.patchFrom[review.data_patch.known_from] ? (lang === 'zh' ? `（${t(T.patchFrom[review.data_patch.known_from])}）` : ` (${t(T.patchFrom[review.data_patch.known_from])})`) : ''}</p>
    : /hotfix/.test(review.data_patch.reason ?? '')
      ? <p className="ag-patch is-unknown" role="note">{t(T.patchHotfixUnsure).replace('{p}', review.data_patch.name)}</p>
      : <p className="ag-patch is-unknown" role="note">{t(T.patchUnknown).replace('{p}', review.data_patch.name)}</p>);

  const highlights = Array.isArray(review.highlights) ? review.highlights.filter((h) => h && typeof h === 'object') : [];
  const chapters = Array.isArray(review.chapters) ? review.chapters.filter((c) => c && typeof c === 'object') : [];
  const orderedChapters = chapters
    .map((chapter, originalIndex) => ({ chapter, originalIndex }))
    .sort((a, b) => {
      const oa = CHAPTER_ORDER[a.chapter.topic] ?? CHAPTER_ORDER.other;
      const ob = CHAPTER_ORDER[b.chapter.topic] ?? CHAPTER_ORDER.other;
      return oa !== ob ? oa - ob : a.originalIndex - b.originalIndex;
    });
  const blindSpots = Array.isArray(review.blind_spots) ? review.blind_spots.filter((line): line is string => typeof line === 'string') : [];
  const hasPros = highlights.length > 0;
  const hasCons = findings.length > 0;
  const hasChapters = orderedChapters.length > 0;
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

  const reasonBadge = review.game_plan?.main_reason && review.game_plan.why && T.planReason[review.game_plan.main_reason]
    ? <span className={`ag-lead-reason is-${review.game_plan.main_reason}`}>{t(T.planReason[review.game_plan.main_reason])}</span>
    : null;

  return (
    <article className="ag-doc">
      <section className="ag-lead">
        {reasonBadge && <div className="ag-lead-meta">{reasonBadge}</div>}
        <h1>{review.verdict}</h1>
        {patch}
      </section>

      {(hasPros || hasCons) && (
        <div className={`ag-summary ${hasPros && hasCons ? 'has-both' : ''}`}>
          {hasPros && (
            <section className="ag-highlights">
              <h2><span className="ag-sec-dot is-good" aria-hidden="true" />{t(T.highlightsTitle)}</h2>
              <div className="ag-highlight-list">
                {highlights.map((h, i) => (
                  <article key={i} className="ag-highlight">
                    <h3>{h.title}</h3>
                    <p className="ag-highlight-detail">{h.detail}</p>
                    {Array.isArray(h.evidence) && h.evidence.length > 0 && evidenceList(h.evidence)}
                  </article>
                ))}
              </div>
            </section>
          )}

          {hasCons && (
            <section className="ag-improvements">
              <h2><span className="ag-sec-dot is-warn" aria-hidden="true" />{t(T.improvementsTitle)}</h2>
              {first && (
                <article className="ag-finding is-lead">
                  <h3><span className="ag-num" aria-hidden="true">1</span>{first.title}</h3>
                  <p className="ag-claim">{first.claim}</p>
                  {Array.isArray(first.evidence) && first.evidence.length > 0 && evidenceList(first.evidence)}
                  {first.fix && <p className="ag-fix"><span>{t(T.fix)}</span>{first.fix}</p>}
                  {feedbackOf(first, 0)}
                </article>
              )}
              {rest.map((f, i) => (
                <details key={i} className="ag-finding">
                  <summary><h3><span className="ag-num" aria-hidden="true">{i + 2}</span>{f.title}</h3></summary>
                  <p className="ag-claim">{f.claim}</p>
                  {Array.isArray(f.evidence) && f.evidence.length > 0 && evidenceList(f.evidence)}
                  {f.fix && <p className="ag-fix"><span>{t(T.fix)}</span>{f.fix}</p>}
                  {feedbackOf(f, i + 1)}
                </details>
              ))}
            </section>
          )}
        </div>
      )}

      {hasChapters && (
        <section className="ag-chapters">
          <h2>{t(T.chaptersTitle)}</h2>
          <nav className="ag-chapter-nav" aria-label={t(T.chapterNavLabel)}>
            <ol>
              {orderedChapters.map(({ chapter: c }, i) => {
                const num = String(i + 1).padStart(2, '0');
                const topicLabel = t(T.chapterTopic[c.topic] ?? T.chapterTopic.other);
                return (
                  <li key={i}>
                    <a href={`#chapter-${i}`} className="ag-chapter-nav-link">
                      <span className="ag-chapter-num">{num}</span>
                      <span>{topicLabel}</span>
                    </a>
                  </li>
                );
              })}
            </ol>
          </nav>
          <div className="ag-chapter-list">
            {orderedChapters.map(({ chapter: c }, i) => {
              const num = String(i + 1).padStart(2, '0');
              return (
                <article id={`chapter-${i}`} key={i} className="ag-chapter">
                  <div className="ag-chapter-meta">
                    <span className="ag-chapter-step">{num}</span>
                    <span className="ag-chapter-topic">{t(T.chapterTopic[c.topic] ?? T.chapterTopic.other)}</span>
                  </div>
                  <h3>{c.title}</h3>
                  <p className="ag-chapter-analysis">{c.analysis}</p>
                  {Array.isArray(c.evidence) && c.evidence.length > 0 && (
                    <details className="ag-chapter-records">
                      <summary>{t(T.records)} · {c.evidence.length}</summary>
                      {evidenceList(c.evidence)}
                    </details>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {share}

      <section className="ag-whole">
        <h2>{t(T.whole)}</h2>
        {overview && Array.isArray(overview.fights) && overview.fights.length > 0 && overview.duration && <FightStrip fights={overview.fights} duration={overview.duration.t} turn={overview.turning_fight && 'ref' in overview.turning_fight ? overview.turning_fight.ref : null} lang={lang} onAsk={onAsk} />}
        {moments?.read && moments.falls_by_my_part && <FightPresenceStrip falls={moments.falls_by_my_part} fightsRead={moments.fights_read ?? 0} fightsNotRead={moments.fights_not_read ?? 0} lang={lang} />}
        {(review.game_plan || onPlan) && (
          <details className="ag-fold ag-plan" open={Boolean(review.game_plan?.against_your_plan)}>
            <summary><h3>{t(T.plan)}</h3>{review.game_plan?.main_reason && review.game_plan.why && T.planReason[review.game_plan.main_reason] && <span>{t(T.planReason[review.game_plan.main_reason])}</span>}</summary>
            {review.game_plan && (
              <>
                {review.game_plan.against_your_plan && (
                  <dl className="ag-plan-parts">
                    <div className="ag-plan-yours">
                      <dt>{t(T.planYours)}{planByKey(review.plan ?? '') ? <span>{planByKey(review.plan ?? '')!.label[lang]}</span> : null}</dt>
                      <dd>{review.game_plan.against_your_plan}</dd>
                    </div>
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

      {blindSpots.length > 0 && <section className="ag-blind"><h2>{t(T.blind)}</h2><ul className="ag-plain">{blindSpots.map((line, i) => <li key={i}>{line}</li>)}</ul></section>}
      {usageFooter}
    </article>
  );
};
