/**
 * 追问回退（纯逻辑，无网络访问）：DeepSeek 未配置、失败、超时或流不完整时，
 * 复盘追问不再向客户端返回 error，而是用 MatchFact 与三条结论里已有的事实
 * 拼出一段确定性 markdown。绝不编造任何数字——文中出现的数值只能来自
 * threeConclusions 的 title/summary 或 matchFact 本身（focusLens 的 KDA/GPM）。
 */

const LEAD_LINE = {
  en: 'AI follow-up is temporarily unavailable — here is what the match data shows:',
  zh: 'AI 追问暂时不可用——以下是比赛数据能确认的内容：',
};

const INSUFFICIENT_LINE = {
  en: 'Insufficient data',
  zh: '数据不足',
};

const CONCLUSION_KEYS = ['turningPoint', 'topMistake', 'nextGameRule'];

/**
 * 追问回退的说明行（也用于已发部分正文后中断时的追加帧）。
 * @param {string} lang
 */
export function followUpFallbackLeadLine(lang) {
  return LEAD_LINE[lang === 'zh' ? 'zh' : 'en'];
}

/**
 * 追问回退时的简短非破坏性提示（reviewNotice 帧）。
 * @param {string} lang
 */
export function reviewFollowUpFallbackNotice(lang) {
  return lang === 'zh'
    ? 'AI 追问暂不可用，以下内容仅基于比赛数据。'
    : 'AI follow-up unavailable; the answer below is built from match data only.';
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object';
}

/**
 * 用已有事实拼出确定性的追问回退文本。
 * - 开头一行说明；
 * - 逐条列出三条结论的 title + summary（insufficient 的照原文列出）；
 * - focusLens 存在时最后给出聚焦英雄的 KDA/GPM。
 * matchFact 或 threeConclusions 缺失时只返回说明行 + 「数据不足」。
 * @param {object | null | undefined} matchFact matchFacts.buildMatchFact 的产物
 * @param {object | null | undefined} threeConclusions threeConclusions.buildThreeConclusions 的产物
 * @param {string} lang 'en' | 'zh'
 * @returns {string}
 */
export function buildFollowUpFallbackText(matchFact, threeConclusions, lang = 'en') {
  const isZh = lang === 'zh';
  const lead = LEAD_LINE[isZh ? 'zh' : 'en'];
  if (!isObject(matchFact) || !isObject(threeConclusions)) {
    return `${lead}\n\n${INSUFFICIENT_LINE[isZh ? 'zh' : 'en']}`;
  }

  const lines = [lead];
  for (const key of CONCLUSION_KEYS) {
    const conclusion = threeConclusions[key];
    if (!isObject(conclusion) || typeof conclusion.summary !== 'string' || !conclusion.summary) continue;
    const title = typeof conclusion.title === 'string' && conclusion.title
      ? conclusion.title
      : key;
    lines.push(isZh ? `- **${title}**——${conclusion.summary}` : `- **${title}** — ${conclusion.summary}`);
  }

  // 聚焦英雄的 KDA/GPM：只在 focusLens 存在时给出（数值来自 matchFact 本身）。
  const lens = isObject(matchFact.focusLens) ? matchFact.focusLens : null;
  if (lens) {
    const stats = [];
    if (typeof lens.kda === 'string' && lens.kda) stats.push(`KDA ${lens.kda}`);
    if (typeof lens.gpm === 'number' && Number.isFinite(lens.gpm)) stats.push(`GPM ${lens.gpm}`);
    if (stats.length > 0) {
      const name = typeof lens.displayName === 'string' && lens.displayName ? lens.displayName : '';
      lines.push(isZh ? `- **${name}**：${stats.join(' · ')}` : `- **${name}**: ${stats.join(' · ')}`);
    }
  }

  return lines.join('\n');
}

/**
 * 追问流收尾决策（纯函数）：streamFollowUpCompletion 的 outcome → 正常结束 /
 * 模板回退二选一。追问永远有答案——任何非正常结束都落到确定性模板，绝不出 error。
 * - failed：所有 provider 都在出文本前失败/超时/预算耗尽（或一个都没配置进链）→
 *   整段模板替换（append=false，客户端还没收到任何正文）；
 * - incomplete：已转发部分正文后中断（重试会重复推送）→ 追加完整模板
 *   （append=true，已出的正文保留）；
 * - done：正常结束——包括「已出正文、流 EOF 但没有终止 finish_reason」的情况
 *   （上游代理常在 [DONE] 前截断 finish_reason；迭代器正常 return 即视为结束，
 *   不能当错误等 40s 超时，也不追加模板）；stopped：调用方已停止（客户端断开），
 *   同样不再写任何帧。
 * @param {{ status?: 'done' | 'incomplete' | 'failed' | 'stopped', finishReason?: string | null } | undefined} outcome
 * @returns {{ action: 'end' } | { action: 'fallback', reason: 'all_failed' | 'incomplete', append: boolean }}
 */
export function decideFollowUpOutcome({ status = 'failed', finishReason = null } = {}) {
  if (status === 'done' || status === 'stopped') {
    return { action: 'end' };
  }
  if (status === 'incomplete') {
    return { action: 'fallback', reason: 'incomplete', append: true };
  }
  return { action: 'fallback', reason: 'all_failed', append: false };
}
