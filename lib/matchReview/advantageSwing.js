/**
 * 经济优势逆转检测（纯逻辑，无网络访问，便于单测）：
 * - detectAdvantageSwing: 从 radiant_gold_adv 中找「最终败方的最大经济领先」、
 *   峰值分钟，以及峰值之后优势第一次翻向胜方的分钟，判断是否构成翻盘局。
 */

/** 败方峰值领先达到该值才计为翻盘（comeback）。 */
export const COMEBACK_LEAD_THRESHOLD = 5000;

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

  // 峰值之后败方领先第一次翻负（胜方接管比赛）的分钟；不存在则为 null
  // （例如败方直到结束仍领先经济却输掉比赛）。峰值本身为负说明败方从头
  // 到尾没有领先过（碾压局），不存在「翻盘」可言，直接判无交叉。
  let crossoverMinute = null;
  if (loserPeakLead >= 0) {
    for (let i = loserPeakMinute + 1; i < adv.length; i += 1) {
      if (loserLead(i) < 0) {
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
