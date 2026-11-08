/** Basic scoreboard facts remain usable without a parsed replay. No timeline is inferred. */
export function availableSummary(raw, player, facts, lang) {
  const zh = lang === 'zh', index = raw.players.indexOf(player);
  const fields = [['kills', 'Kills', '击杀'], ['deaths', 'Deaths', '死亡'], ['assists', 'Assists', '助攻'],
    ['last_hits', 'Final last hits', '终局补刀'], ['gold_per_min', 'GPM', '每分钟金钱'],
    ['xp_per_min', 'XPM', '每分钟经验'], ['net_worth', 'Final net worth', '终局净资产']];
  const ids = [];
  for (const [field, en, cn] of fields) {
    if (!Number.isFinite(player[field]) || player[field] < 0) continue;
    const id = `scoreboard.${field}`, value = player[field];
    facts[id] = { id, kind: 'scalar', value, display: { en: `${en}: ${value}`, zh: `${cn}：${value}` },
      citation: 's1', source_path: `players[${index}].${field}` };
    ids.push(id);
  }
  const observation = ids.map(id => `{${id}}`).join(zh ? '；' : '; ');
  const slots = (observation ? (zh ? `可核对的终局摘要：${observation}。` : `Available final scoreboard: ${observation}. `) : '') + (zh
    ? '缺少补刀/经济时间轴、死亡位置和购买记录，无法定位刷钱瓶颈、判断何时弃线或刷打取舍。建议选一段对线或一次参团，记录兵线、视野与替代资源供回看；这不是本局最优打法结论。'
    : 'Last-hit/gold timelines, death positions and purchase records are missing. Farming bottlenecks, lane abandonment and fighting versus farming remain unanswered. For a replay review, choose one lane segment or fight and record waves, vision and alternative resources; this is a review method, not a conclusion about the best play.');
  return [{ id: 'fix_this', status: ids.length ? 'ok' : 'insufficient', time: { from: 0, to: 0 },
    claim: { text: slots.replace(/\{([^{}]+)\}/g, (_, id) => facts[id].display[lang]), slots, phrasing: 'template' },
    fact_ids: ids, metrics: ids.map(id => ({ label_key: id, fact_id: id })),
    evidence: { kind: 'none', highlight: [0, 0], markers: ids, moments: [] }, baseline: null, target: null,
    citations: ids.length ? ['s1'] : [], data_gap: 'parsed_evidence', reason: 'not_parsed_yet' }];
}
