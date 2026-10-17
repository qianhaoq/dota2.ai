/**
 * 环境变量正整数解析（QA P2）：`Number.parseInt('1e9') === 1`——科学计数法等
 * 数字样式的字符串会被 parseInt 静默截断成 1（再被下限钳制成毫秒级超时）。
 * 统一用 Number()（先 trim）解析：接受 '40000' / '4e4' / '1e9'；要求
 * Number.isFinite 且 > 0，再 Math.floor；其余（'abc' / '' / '-5' /
 * 'Infinity' / NaN / 0）一律回退调用方给的默认值。超大有限值（如 1e9）由
 * 调用方的上限钳制处理（见 followUpTimeout.clampFollowUpAttemptMs）。
 */

/**
 * @param {unknown} raw 环境变量原值（string | number | 其他）
 * @param {number} fallback 非法/非正回退值
 * @returns {number}
 */
export function parsePositiveInt(raw, fallback) {
  const value = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  const floored = Number.isFinite(value) ? Math.floor(value) : 0;
  return floored >= 1 ? floored : fallback;
}
