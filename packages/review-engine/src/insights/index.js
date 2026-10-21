/** Deterministic templates: every metric is a Fact Store reference. */
export function buildInsights({ facts, deaths, worst, comeback }, lang, state) {
  const zh = lang === 'zh';
  const make = (id, ids, slots, time, kind, extra = {}) => ({
    id, status: ids.length ? 'ok' : 'insufficient', time,
    claim: { text: slots.replace(/\{([^{}]+)\}/g, (_, key) => facts[key]?.display[lang] ?? `{${key}}`), slots, phrasing: 'template' },
    fact_ids: ids, metrics: ids.map(id => ({ label_key: id, fact_id: id })),
    evidence: { kind, highlight: [time.from / 60, time.to / 60], markers: ids, moments: [] },
    baseline: null, target: null, citations: ids.length ? ['s1'] : [], data_gap: null, ...extra,
  });
  if (state !== 'parsed') return ['turning_point', 'fix_this', 'next_game'].map(id => make(id, [], zh ? '解析数据不足。' : 'Insufficient parsed data.', { from: 0, to: 0 }, 'none', { reason: state === 'unparsed' ? 'not_parsed_yet' : 'missing_required_data' }));
  const windowId = worst ? `gold.window.${worst.from}_${worst.to}.delta` : null;
  const recoveryIds = comeback ? [`comeback.${comeback.from}_${comeback.to}.gold`, `comeback.${comeback.from}_${comeback.to}.xp`].filter(id => facts[id]) : [];
  const turningIds = [windowId, 'gold.low', ...recoveryIds].filter(id => id && facts[id]);
  const turningSlots = windowId ? (zh ? `最差五分钟经济变化 {${windowId}}；全局低点 {gold.low}。` : `Worst five-minute gold change: {${windowId}}; global low: {gold.low}.`) + recoveryIds.map(id => zh ? ` 回升段：{${id}}。` : ` Recovery: {${id}}.`).join('') : (zh ? '缺少经济曲线。' : 'Gold series unavailable.');
  const turning = make('turning_point', turningIds, turningSlots, { from: (worst?.from ?? 0) * 60, to: (worst?.to ?? 0) * 60 }, 'gold_xp_chart', { comeback: recoveryIds.length ? { fact_ids: recoveryIds } : null });
  const behind = facts['deaths.behind_1k']?.value >= 2;
  const repeated = Object.entries(facts.killed_by?.value ?? {}).sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0])).find(([, count]) => Number(count) >= 2);
  const phase = ['lane', 'mid', 'late'].map(p => `deaths.phase.${p}`).sort((a, b) => (facts[b]?.value ?? 0) - (facts[a]?.value ?? 0)).find(id => facts[id]?.value >= 2);
  const fixIds = behind ? ['deaths.behind_1k', 'deaths.total'] : repeated ? [`killed_by.${repeated[0]}`] : phase ? [phase] : [];
  const fixSlots = behind ? (zh ? '经济落后超过一千时死亡 {deaths.behind_1k} 次；共 {deaths.total} 次。落后时优先减少无收益的交战。' : 'Deaths while over a thousand gold behind: {deaths.behind_1k} of {deaths.total}. Prioritize avoiding low-value fights while behind.') : repeated ? (zh ? `重复击杀者：${repeated[0]}（{killed_by.${repeated[0]}} 次）。优先复查这些死亡。` : `Repeated killer: ${repeated[0]} ({killed_by.${repeated[0]}} deaths). Review these deaths first.`) : phase ? (zh ? `${{ lane: '对线期', mid: '中期', late: '后期' }[phase.split('.').at(-1)]}集中死亡：{${phase}}。` : `Deaths concentrated in ${phase.split('.').at(-1)} phase: {${phase}}.`) : (zh ? '死亡证据不足。' : 'Insufficient death evidence.');
  const fix = make('fix_this', fixIds, fixSlots, { from: deaths[0]?.t ?? 0, to: deaths.at(-1)?.t ?? 0 }, 'death_timeline', { data_gap: 'death_locations', pattern: behind ? 'behind_1k' : repeated ? 'repeat_killer' : phase ? 'phase_repeat' : null });
  const nextIds = ['gold.at.10', 'lh_at_10'].filter(id => facts[id]);
  const nextSlots = (zh ? '下局复查十分钟发育：' : 'Next game, review your ten-minute economy: ') + nextIds.map(id => `{${id}}`).join(' / ') + (zh ? '。优先练习稳定补刀与安全获取资源。' : '. Practice consistent last hits and safe resource collection.');
  return [turning, fix, make('next_game', nextIds, nextSlots, { from: 600, to: 600 }, 'economy', { data_gap: 'build_vs_lineup' })];
}
