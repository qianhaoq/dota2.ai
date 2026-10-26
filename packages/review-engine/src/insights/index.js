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
  const windowDelta = facts[windowDeltaId]?.display[lang]?.replace('−', '▼');
  const lowClause = facts['gold.low'] ? (zh ? '；全局低点 {gold.low}。' : '; global low {gold.low}.') : (zh ? '。' : '.');
  const turningSlots = windowTime
    ? (zh ? `优先回看 ${windowTime} 这段最差经济窗口${windowDelta ? `（${windowDelta}）` : ''}${lowClause}` : `Prioritize reviewing the worst gold window at ${windowTime}${windowDelta ? ` (${windowDelta})` : ''}${lowClause}`)
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
    ? (zh ? `落后千金时死亡 {deaths.behind_1k}/{deaths.total}${repeated ? `；重复击杀者含${killerName}` : ''}。落后时优先减少无收益的交战。` : `Deaths while behind: {deaths.behind_1k}/{deaths.total}${repeated ? `; repeated killer includes ${killerName}` : ''}. Prioritize avoiding low-value fights while behind.`)
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
  const goldAbs = gold?.display[lang].replace(/^[−+-]/, '');
  const goldTarget = gold && (zh
    ? gold.value < 0 ? `经济落后控制在 ${goldAbs} 金以内` : gold.value > 0 ? `保持至少 ${goldAbs} 金的经济领先` : '经济不要落后'
    : gold.value < 0 ? `keep the deficit under ${goldAbs} gold` : gold.value > 0 ? `keep a lead of at least ${goldAbs} gold` : 'avoid falling behind in team gold');
  const nextSlots = nextIds.length
    ? zh
      ? `本局 10 分钟${[cs && '补刀 {lh_at_10}', gold && '团队经济 {gold.at.10}'].filter(Boolean).join('、')}。下一局 10 分钟${[cs && '补刀至少 {lh_at_10}', goldTarget].filter(Boolean).join('，')}；未达标先安全发育。`
      : `This game: ${[cs && '{lh_at_10} CS', gold && '{gold.at.10} team gold'].filter(Boolean).join(' and ')} at 10:00. Next game ${[cs && 'aim for at least {lh_at_10} CS at 10:00', goldTarget].filter(Boolean).join(' and ')}; if you miss ${cs && gold ? 'either' : 'the target'}, farm safely before forcing plays.`
    : (zh ? '优先练习稳定补刀与安全获取资源。' : 'Practice consistent last hits and safe resource collection.');
  return [turning, fix, make('next_game', nextIds, nextSlots, { from: 600, to: 600 }, 'economy', { data_gap: 'build_vs_lineup' })];
}
