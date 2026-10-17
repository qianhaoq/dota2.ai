/**
 * 环境变量正整数解析（QA P2）：`Number.parseInt('1e9') === 1`——科学计数法等
 * 数字样式的字符串会被 parseInt 静默截断成 1（再被下限钳制成毫秒级超时）。
 * 但 Number() 又太宽：它还接受十六进制/八进制/二进制字面量（'0x1F40'、
 * '0o17'、'0b101'），env 里这类值几乎必是配置错误。因此字符串必须匹配
 * 十进制语法 /^\d+(\.\d+)?(e\+?\d+)?$/i（trim 后：纯数字，可选小数部分，
 * 可选指数）；Number 输入（不可能是进制字面量）保持原语义。要求
 * Number.isFinite 且 > 0 再 Math.floor；其余一律回退调用方给的默认值。
 * 可选 { max } 上限：超上限的值钳制到 max（调用方给 env 设的护栏）。
 */

/** Decimal-only numeric syntax: digits [. digits] [(e|E) [+]? digits]. */
const DECIMAL_NUMBER = /^\d+(\.\d+)?(e\+?\d+)?$/i;

/**
 * @param {unknown} raw 环境变量原值（string | number | 其他）
 * @param {number} fallback 非法/非正回退值
 * @param {{ max?: number }} [options] max：合法值的上限（超过则钳制到 max）
 * @returns {number}
 */
export function parsePositiveInt(raw, fallback, { max } = {}) {
  let value;
  if (typeof raw === 'number') {
    value = raw;
  } else {
    const text = String(raw ?? '').trim();
    if (!DECIMAL_NUMBER.test(text)) return fallback;
    value = Number(text);
  }
  const floored = Number.isFinite(value) ? Math.floor(value) : 0;
  if (floored < 1) return fallback;
  return max != null ? Math.min(floored, max) : floored;
}
