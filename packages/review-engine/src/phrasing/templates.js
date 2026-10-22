import { renderSlots } from './slots.js';

export const refusal = lang => lang === 'zh'
  ? '该问题需要的数据不在本局记录中。'
  : "The data needed for this question is not in this match's record.";

export const gapTemplates = {
  gold_fed: { en: 'Kill bounty records are missing, so gold fed cannot be calculated.', zh: '缺少击杀赏金记录，无法计算死亡送出的金钱。' },
  time_dead: { en: 'Respawn timestamps are missing, so total time dead cannot be calculated.', zh: '缺少复活时间记录，无法计算死亡总时长。' },
  lh_at_10: { en: 'The last-hit sample at ten minutes is missing, so laning farm cannot be measured.', zh: '缺少十分钟补刀采样，无法衡量对线补刀。' },
  death_locations: { en: 'The OpenDota death log has no coordinates, so position and vision cannot be judged.', zh: 'OpenDota 死亡日志没有坐标，无法判断站位与视野。' },
  build_vs_lineup: { en: 'Purchase timing and matchup context are incomplete, so a build verdict is unavailable.', zh: '出装时机与对局背景不完整，无法判断出装优劣。' },
  deaths: { en: 'The death timeline is incomplete, so a full death review is unavailable.', zh: '死亡时间线不完整，无法逐条复查全部死亡。' },
  'deaths.behind_1k': { en: 'Team gold samples at deaths are missing, so deaths while behind cannot be counted.', zh: '缺少死亡时的团队经济采样，无法统计落后时的死亡。' },
  patch: { en: 'The match patch is unknown, so patch-specific advice is unavailable.', zh: '本局版本未知，无法给出针对版本的建议。' },
  player: { en: 'The selected player was not found, so personal coaching is unavailable.', zh: '未找到所选玩家，无法提供个人复盘。' },
  parsed_evidence: { en: 'Parsed match evidence is missing, so event-based coaching must wait for parsing.', zh: '缺少解析后的比赛证据，需等待解析后再复查事件。' },
  radiant_gold_adv: { en: 'The team gold curve is missing, so economic turning points cannot be identified.', zh: '缺少团队经济曲线，无法确定经济转折。' },
  laning_baseline: { en: 'No same-bracket laning baseline is available, so these numbers cannot be graded against peers.', zh: '缺少同段位对线基准，无法用这些数据评价同段位表现。' },
  laning_0_10: { en: 'Lane, farm or early death records are incomplete, so the opening lane summary is unavailable.', zh: '分路、发育或前期死亡记录不完整，无法汇总开局对线。' },
};
export const GAP_TOPICS = Object.keys(gapTemplates);

const insufficient = {
  turning_point: { en: 'The gold curve is incomplete. Review the available evidence before choosing a turning point.', zh: '经济曲线不完整。请先复查已有证据，再判断转折点。' },
  fix_this: { en: 'Death evidence is insufficient for a repeated pattern. Review individual deaths first.', zh: '死亡证据不足以确定重复模式。请先逐条复查死亡。' },
  next_game: { en: 'Early economy samples are missing. Review available farm evidence before setting a practice target.', zh: '缺少前期发育采样。请先复查已有发育证据，再设定练习目标。' },
};

// Fixed prose is also the validator's auditable coaching vocabulary.
export const coachCopy = {
  window: { en: 'Review the gold change at TIME: VALUE. Prioritize this turning point.', zh: '复查 TIME 的经济变化：VALUE。优先回看这个转折点。' },
  low: { en: 'Team gold reached its global low at TIME: VALUE.', zh: '团队经济在 TIME 达到全局低点：VALUE。' },
  gold: { en: 'Recovery gold: VALUE.', zh: '回升段经济：VALUE。' },
  xp: { en: 'Recovery experience: VALUE.', zh: '回升段经验：VALUE。' },
  behind: { en: 'Deaths while behind: VALUE of TOTAL. Prioritize avoiding low-value fights while behind.', zh: '落后时死亡 VALUE 次，共 TOTAL 次。落后时优先减少低收益交战。' },
  repeat: { en: 'Repeated killer deaths: VALUE. Review these deaths first.', zh: '重复击杀者的击杀次数：VALUE。优先复查这些死亡。' },
  phase: { en: 'PHASE phase deaths: VALUE. Review these deaths first.', zh: 'PHASE死亡：VALUE 次。优先复查这些死亡。' },
  next: { en: 'Next game, practice consistent last hits and safe resource collection.', zh: '下局练习稳定补刀与安全获取资源。' },
  farm: { en: 'At TIME, last hits: VALUE.', zh: 'TIME 时补刀：VALUE。' },
  economy: { en: 'At TIME, team gold difference: VALUE.', zh: 'TIME 时团队经济差：VALUE。' },
  lane: { en: 'Lane: VALUE.', zh: '分路：VALUE。' },
  laneDeaths: { en: 'Laning deaths: VALUE.', zh: '对线期死亡：VALUE 次。' },
  total: { en: 'Total deaths: VALUE.', zh: '总死亡：VALUE 次。' },
  death: { en: 'At TIME: VALUE.', zh: 'TIME：VALUE。' },
};
export const trustedCopy = [...Object.values(coachCopy), ...Object.values(insufficient)];

export function renderTemplate(insight, facts, lang) {
  const ids = (insight.fact_ids ?? []).filter(id => facts[id]?.display?.[lang]);
  const copy = (key, id, extra = {}) => {
    const time = Number.isInteger(facts[id]?.t) ? `{t:${facts[id].t}}` : '';
    return coachCopy[key][lang].replace(/TIME|VALUE|TOTAL|PHASE/g, word => ({
      TIME: time, VALUE: `{${id}}`, ...extra,
    })[word] ?? '');
  };
  let slots;
  if (insight.answerable === false || insight.topic) {
    slots = gapTemplates[insight.gap ?? insight.topic ?? insight.id]?.[lang] ?? refusal(lang);
  } else if (insight.status === 'insufficient' || !ids.length || ids.length !== insight.fact_ids?.length) {
    slots = insufficient[insight.id]?.[lang] ?? refusal(lang);
  } else {
    const sentences = [];
    for (const id of ids) {
      if (/^gold.window.*\.delta$/.test(id)) sentences.push(copy('window', id));
      else if (id === 'gold.low') sentences.push(copy('low', id));
      else if (/^comeback\..*\.(gold|xp)$/.test(id)) sentences.push(copy(id.endsWith('.xp') ? 'xp' : 'gold', id));
      else if (id === 'deaths.behind_1k' && ids.includes('deaths.total')) sentences.push(copy('behind', id, { TOTAL: '{deaths.total}' }));
      else if (id === 'deaths.total' && !ids.includes('deaths.behind_1k')) sentences.push(copy('total', id));
      else if (id.startsWith('killed_by.')) sentences.push(copy('repeat', id));
      else if (id === 'gold.at.10') sentences.push(copy('economy', id));
      else if (id === 'lh_at_10') sentences.push(copy('farm', id));
      else if (id === 'lane') sentences.push(copy('lane', id));
      else if (/^death\.\d+$/.test(id)) sentences.push(copy('death', id));
      else if (id.startsWith('deaths.phase.')) {
        const phase = id.split('.').at(-1);
        const name = lang === 'zh' ? { lane: '对线期', mid: '中期', late: '后期' }[phase] : phase;
        sentences.push(copy('phase', id, { PHASE: name }));
      }
    }
    if (insight.id === 'next_game' && sentences.length) sentences.push(coachCopy.next[lang]);
    slots = sentences.join(insight.id === 'death_list' ? '\n' : ' ') || refusal(lang);
  }
  return { text: renderSlots(slots, facts, lang), slots, phrasing: 'template' };
}
