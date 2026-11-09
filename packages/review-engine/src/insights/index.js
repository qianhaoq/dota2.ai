import { coachCopy } from '../phrasing/templates.js';
import { STATIC_HEROES } from '../staticHeroes.js';

/** Deterministic templates: claim.text combines match facts with a concrete coaching action. */
export function buildInsights({ facts, deaths, worst, comeback }, lang, state) {
  const zh = lang === 'zh';
  const make = (id, ids, slots, time, kind, extra = {}) => ({
    id, status: ids.length ? 'ok' : 'insufficient', time,
    claim: { text: slots.replace(/\{([^{}]+)\}/g, (_, key) => facts[key]?.display[lang] ?? `{${key}}`), slots, phrasing: 'template' },
    fact_ids: ids, metrics: ids.map(factId => ({ label_key: factId, fact_id: factId })),
    evidence: { kind, highlight: [time.from / 60, time.to / 60], markers: ids, moments: [] },
    baseline: null, target: null, citations: ids.length ? ['s1'] : [], data_gap: null, ...extra,
  });
  if (state !== 'parsed') {
    return ['turning_point', 'fix_this', 'next_game'].map(id => make(
      id, [], zh ? '解析数据不足。' : 'Insufficient parsed data.', { from: 0, to: 0 }, 'none',
      { reason: state === 'unparsed' ? 'not_parsed_yet' : 'missing_required_data' },
    ));
  }

  const windowPrefix = worst ? `gold.window.${worst.from}_${worst.to}` : null;
  const windowDeltaId = windowPrefix ? `${windowPrefix}.delta` : null;
  const recoveryIds = comeback
    ? [`comeback.${comeback.from}_${comeback.to}.gold`, `comeback.${comeback.from}_${comeback.to}.xp`].filter(id => facts[id])
    : [];
  const turningIds = [windowDeltaId, 'gold.low', ...recoveryIds].filter(id => id && facts[id]);
  const windowTime = windowPrefix && facts[windowPrefix]?.display?.t;
  const windowDelta = windowDeltaId ? facts[windowDeltaId]?.display[lang]?.replace('−', '▼') : null;
  const lowClause = facts['gold.low'] ? (zh ? '；全局低点 {gold.low}。' : '; global low {gold.low}.') : (zh ? '。' : '.');
  const turningSlots = windowTime
    ? (zh ? `优先回看 ${windowTime} 这段最差经济窗口${windowDelta ? `（${windowDelta}）` : ''}${lowClause}这只是回看候选，不能据此认定输因。` : `Prioritize reviewing the worst gold window at ${windowTime}${windowDelta ? ` (${windowDelta})` : ''}${lowClause} This is a review candidate, not an established cause of the loss.`)
    : (zh ? '缺少经济曲线。' : 'Gold series unavailable.');
  const turning = make(
    'turning_point', turningIds, turningSlots,
    { from: (worst?.from ?? 0) * 60, to: (worst?.to ?? 0) * 60 },
    'gold_xp_chart',
    { comeback: recoveryIds.length ? { fact_ids: recoveryIds } : null },
  );

  const behind = facts['deaths.behind_1k']?.value >= 2;
  const repeated = Object.entries(facts.killed_by?.value ?? {})
    .sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0]))
    .find(([, count]) => Number(count) >= 2);
  const phase = ['lane', 'mid', 'late']
    .map(p => `deaths.phase.${p}`)
    .sort((a, b) => (facts[b]?.value ?? 0) - (facts[a]?.value ?? 0))
    .find(id => facts[id]?.value >= 2);
  const fixIds = behind
    ? ['deaths.behind_1k', 'deaths.total', ...(repeated ? [`killed_by.${repeated[0]}`] : [])]
    : repeated
      ? [`killed_by.${repeated[0]}`]
      : phase
        ? [phase]
        : [];
  const killerHero = repeated
    ? Object.values(STATIC_HEROES).find(hero => hero.internalSlug === repeated[0])
    : null;
  const killerName = killerHero ? (zh ? killerHero.nameZh : killerHero.nameEn) : repeated?.[0];
  const phaseKey = phase?.split('.').at(-1);
  const phaseNameZh = { lane: '对线期', mid: '中期', late: '后期' }[phaseKey];
  const phaseNameEn = phaseKey;
  const fixSlots = behind
    ? (zh ? `落后千金时死亡 {deaths.behind_1k}/{deaths.total}${repeated ? `；重复击杀者含${killerName}` : ''}。这是死亡前一分钟的团队经济采样，不能判断交战是否值得。建议回看死亡前的视野、兵线和目标，再决定刷或打。` : `Deaths while behind: {deaths.behind_1k}/{deaths.total}${repeated ? `; repeated killer includes ${killerName}` : ''}. This uses the preceding minute of team gold, which cannot establish fight value. Review vision, waves and objectives before each death to assess fighting versus farming.`)
    : repeated
      ? (zh ? `优先复查${killerName}造成的 {killed_by.${repeated[0]}} 次死亡。` : `Prioritize reviewing {killed_by.${repeated[0]}} deaths to ${killerName}.`)
      : phase
        ? (zh ? `优先复查${phaseNameZh}集中的 {${phase}} 次死亡。` : `Prioritize reviewing {${phase}} deaths concentrated in the ${phaseNameEn} phase.`)
        : (zh ? '死亡证据不足。' : 'Insufficient death evidence.');
  const fix = make(
    'fix_this', fixIds, fixSlots,
    { from: deaths[0]?.t ?? 0, to: deaths.at(-1)?.t ?? 0 },
    'death_timeline',
    {
      data_gap: 'death_locations',
      pattern: behind ? 'behind_1k' : repeated ? 'repeat_killer' : phase ? 'phase_repeat' : null,
    },
  );

  const nextIds = ['gold.at.10', 'lh_at_10'].filter(id => facts[id]);
  const cs = facts.lh_at_10;
  const gold = facts['gold.at.10'];
  // This match is an observation, never a comparative baseline or passing target.
  let nextSlots = nextIds.length
    ? zh
      ? `观察：本局 10 分钟${[cs && '补刀 {lh_at_10}', gold && '团队经济 {gold.at.10}'].filter(Boolean).join('、')}。建议：下一局在决定参团前记录兵线、可见敌人和可争目标，赛后核查一次选择。缺少同角色基准与位置证据，不能据此设及格线或判定刷打优劣。`
      : `Observation: ${[cs && '{lh_at_10} CS', gold && '{gold.at.10} team gold'].filter(Boolean).join(' and ')} at 10:00 this game. Advice: next game, record waves, visible enemies and a contestable objective before joining a fight; review one decision afterward. Without role baselines or position evidence, these numbers cannot set passing targets or determine whether farming was better.`
    : (zh ? '缺少时间轴证据，无法判断刷打取舍。建议回看一次参团决定，记录兵线、视野和目标。' : 'Timeline evidence is missing, so fighting versus farming cannot be determined. Review one fight decision and record waves, vision and objectives.');
  // Early deaths describe survival only; they do not grade lane control or missed farm.
  if (cs && facts['deaths.phase.lane']) {
    nextIds.push('deaths.phase.lane');
    nextSlots += zh
      ? ' 前10分钟死亡 {deaths.phase.lane} 次；补刀和存活记录不能说明补刀机会、兵线控制或是否该离线。'
      : ' Deaths before 10:00: {deaths.phase.lane}. Last hits and survival do not establish missed farm opportunities, wave control or whether to leave lane.';
  }
  if (worst && windowPrefix && nextIds.length) {
    const itemIds = Object.keys(facts).filter(id => id.startsWith('item.first.'));
    for (const id of itemIds) {
      const relation = facts[id].t < worst.from * 60 ? 'itemBefore' : facts[id].t > worst.to * 60 ? 'itemAfter' : 'itemDuring';
      nextSlots += ` ${coachCopy[relation][lang].replace('VALUE', `{${id}}`)}`;
    }
    if (itemIds.length) {
      nextIds.push(...itemIds, windowPrefix);
      nextSlots += zh
        ? ' 这些是首次购买记录，不代表送达或使用时间；不能据此判断装备选择、购买时机优劣，或应该更早参团。'
        : ' These are first purchase records, not delivery or use times; they cannot establish build quality, optimal purchase timing or whether to fight earlier.';
      nextSlots += zh ? ` 最差经济窗口：${windowTime}。` : ` Worst gold window: ${windowTime}.`;
    }
  }
  return [turning, fix, make('next_game', nextIds, nextSlots, { from: 600, to: 600 }, 'economy', { data_gap: 'build_vs_lineup' })];
}
