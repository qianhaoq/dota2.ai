/**
 * 经济优势逆转检测（纯逻辑，无网络访问，便于单测）：
 * - detectAdvantageSwing: 从 radiant_gold_adv 中找「最终败方的最大经济领先」、
 *   峰值分钟，以及峰值之后优势第一次翻向胜方的分钟，判断是否构成翻盘局。
 */

/** 败方峰值领先达到该值才计为翻盘（comeback）。 */
export const COMEBACK_LEAD_THRESHOLD = 5000;

/**
 * 优势易手计为一次领先翻转（crossover）所需的最小双方领先：翻转前的峰
 * 值领先与翻转后的接管领先都必须达到该值。分钟级的微小领先（如开局
 * +184）只是噪声，不算翻转/逆转。
 */
export const LEAD_FLIP_THRESHOLD = 1000;

/**
 * @param {number[] | null | undefined} radiantGoldAdv 每分钟天辉-夜魇经济差
 * @param {boolean} radiantWin 天辉是否获胜
 * @returns {{
 *   loserSide: 'radiant' | 'dire',
 *   loserPeakLead: number,
 *   loserPeakMinute: number,
 *   crossoverMinute: number | null,
 *   comeback: boolean,
 * } | null} 数组长度不足 5 时返回 null（样本太短，不构成趋势）。
 */
export function detectAdvantageSwing(radiantGoldAdv, radiantWin) {
  const adv = Array.isArray(radiantGoldAdv) ? radiantGoldAdv : [];
  if (adv.length < 5) return null;

  const winnerIsRadiant = Boolean(radiantWin);
  const loserSide = winnerIsRadiant ? 'dire' : 'radiant';
  // 从败方视角看的经济差（正数 = 败方领先）。
  const loserLead = (i) => (winnerIsRadiant ? -adv[i] : adv[i]);

  let loserPeakMinute = 0;
  let loserPeakLead = loserLead(0);
  for (let i = 1; i < adv.length; i += 1) {
    const lead = loserLead(i);
    if (lead > loserPeakLead) {
      loserPeakLead = lead;
      loserPeakMinute = i;
    }
  }

  // 峰值之后胜方领先第一次也达到 LEAD_FLIP_THRESHOLD 的分钟；不存在则为
  // null。两侧都要有真实领先：败方峰值不足阈值（从未真正领先，OpenDota
  // 的 radiant_gold_adv[0] 恒为 0，碾压局的峰值就是 0）或胜方接管后领先
  // 未达阈值（刚刚擦正的微小领先）都不构成一次可报告的翻转。
  let crossoverMinute = null;
  if (loserPeakLead >= LEAD_FLIP_THRESHOLD) {
    for (let i = loserPeakMinute + 1; i < adv.length; i += 1) {
      if (loserLead(i) <= -LEAD_FLIP_THRESHOLD) {
        crossoverMinute = i;
        break;
      }
    }
  }

  return {
    loserSide,
    loserPeakLead,
    loserPeakMinute,
    crossoverMinute,
    comeback: loserPeakLead >= COMEBACK_LEAD_THRESHOLD,
  };
}
