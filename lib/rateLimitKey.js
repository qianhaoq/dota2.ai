/**
 * 限流键规范化（纯逻辑，无 IO，便于单测）。
 *
 * 背景（QA P1）：按 IPv6 单地址计键时，一个 /64 内轮换地址即可把每 IP
 * 预算放大数百倍，再叠加上全局上限就会把所有用户挤进 429。因此：
 * - IPv6 按其 /64 前缀计键（展开 ::、小写、去 zone id 后取前 4 组）：
 *   同一运营商/家庭块内的地址共享一个桶；轮换地址不再放大预算。
 * - IPv4-mapped IPv6（::ffff:1.2.3.4 与 ::ffff:0102:0304 两种写法）归一化
 *   为普通 IPv4 "1.2.3.4"（Node 的 socket.remoteAddress 常给出 mapped 形式，
 *   不能和裸 IPv4 分成两个桶）。
 * - IPv4 仍按单地址计键。
 * - 解析不了的字符串（伪造的 XFF 残留等）回退为有长度上限的原始字符串
 *   桶（与旧 createSlidingWindowLimiter 的 slice(0,64) 行为一致）。
 */

/** 回退键的最大长度（防内存放大，与 rateLimiter.js 的键上限一致）。 */
export const RATE_LIMIT_KEY_MAX_CHARS = 64;

/** 严格点分 IPv4：四段、每段 0-255（不认 zone/端口/前缀）。 */
function parseIpv4(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return null;
  const octets = m.slice(1).map((s) => Number(s));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return octets;
}

/**
 * 解析 '::' 一侧的十六进制组。地址末段可能是内嵌 IPv4（::ffff:1.2.3.4），
 * 仅当 allowEmbeddedIpv4 且确为最后一段时接受。返回组数组或 null。
 * @param {string} side
 * @param {boolean} allowEmbeddedIpv4
 * @returns {number[] | null}
 */
function parseGroups(side, allowEmbeddedIpv4) {
  if (side === '') return [];
  const segments = side.split(':');
  const groups = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (allowEmbeddedIpv4 && i === segments.length - 1 && segment.includes('.')) {
      const octets = parseIpv4(segment);
      if (!octets) return null;
      groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(segment)) return null;
    groups.push(parseInt(segment, 16));
  }
  return groups;
}

/**
 * 解析 IPv6 文本为 8 个 16 位组；IPv4-mapped 形式直接返回对应 IPv4。
 * @param {string} text
 * @returns {{ kind: 'ipv4', address: string } | { kind: 'ipv6', groups: number[] } | null}
 */
function parseIpv6(text) {
  // zone id（%eth0 …）先去掉再小写；字符集不含 %/g-z，提前排除垃圾串。
  const cleaned = String(text).split('%')[0].toLowerCase();
  if (cleaned === '' || !/^[0-9a-f:.]+$/.test(cleaned)) return null;

  const doubleColon = cleaned.indexOf('::');
  let head = cleaned;
  let tail = '';
  if (doubleColon !== -1) {
    if (cleaned.indexOf('::', doubleColon + 1) !== -1) return null;
    head = cleaned.slice(0, doubleColon);
    tail = cleaned.slice(doubleColon + 2);
  }
  // 内嵌 IPv4 只能出现在整个地址的最后一段（有 '::' 时只可能在 tail）。
  const headGroups = parseGroups(head, doubleColon === -1);
  const tailGroups = parseGroups(tail, true);
  if (headGroups === null || tailGroups === null) return null;

  /** @type {number[]} */
  let groups;
  if (doubleColon === -1) {
    if (headGroups.length !== 8) return null;
    groups = headGroups;
  } else {
    // '::' 至少代表一个 0 组。
    if (headGroups.length + tailGroups.length > 7) return null;
    groups = [
      ...headGroups,
      ...Array.from({ length: 8 - headGroups.length - tailGroups.length }, () => 0),
      ...tailGroups,
    ];
  }

  // IPv4-mapped（::ffff:0:0/96）：两种写法（点分尾段 / 纯十六进制）都归一化
  // 为普通 IPv4，与裸 IPv4 共桶。
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0
    && groups[4] === 0 && groups[5] === 0xffff) {
    return {
      kind: 'ipv4',
      address: [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.'),
    };
  }
  return { kind: 'ipv6', groups };
}

/**
 * 把已解析的客户端 IP 规范化为限流键。
 * @param {unknown} ip resolveClientIp 的结果（字符串；可能为 'unknown'）
 * @returns {string}
 */
export function rateLimitKey(ip) {
  const raw = ip == null ? '' : String(ip);
  const octets = parseIpv4(raw);
  if (octets) return octets.join('.');
  const parsed = parseIpv6(raw);
  if (parsed?.kind === 'ipv4') return parsed.address;
  if (parsed?.kind === 'ipv6') {
    return `${parsed.groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
  }
  return (raw || 'unknown').slice(0, RATE_LIMIT_KEY_MAX_CHARS);
}
