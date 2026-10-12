/**
 * 客户端 IP 解析（纯逻辑，无 IO，便于单测）。
 * 供 feedback 限流与录像解析的 per-client 预算共用。
 *
 * 生产拓扑（已核实，不是猜测）：dota2.ai 走 Cloud Run 域名映射 —— A 记录
 * 指向 Google Front End（216.239.32/34/36/38.21），www 是
 * ghs.googlehosted.com CNAME，前面没有外部 HTTPS 负载均衡器。GFE 恰好向
 * X-Forwarded-For 追加一个条目 —— 真实客户端，即 XFF[len-1]（hops=1）。
 *
 * TRUSTED_PROXY_HOPS 是精确的拓扑计数，不是可调参数：必须等于受信代理
 * 向 XFF 追加的条目数。1 = Cloud Run 直连/域名映射（默认）；2 = 前面还有
 * 一层外部 HTTPS LB（LB 追加 "<client-ip>,<lb-ip>" 两个条目）。计数偏大
 * 会把选择窗口推进调用方可伪造的左侧条目 —— 客户端即可伪造 IP 绕过
 * per-client 预算；偏小则所有用户挤进同一个（共享）桶。
 *
 * 防伪造：仅当 TCP peer 是内网/环回（Cloud Run/GFE 转发）时才参考 XFF，
 * 且从右侧按 hops 取 —— 调用方在左侧伪造任意多条目都选不中；
 * 直连公网 peer 则完全忽略 XFF，直接用 peer。
 */

/** 默认信任跳数：Cloud Run 直连/域名映射，GFE 只追加客户端一个条目。 */
export const DEFAULT_TRUSTED_PROXY_HOPS = 1;
/** 跳数上限（保持很小：多计一跳就多暴露一截可伪造的左侧区）。 */
export const MAX_TRUSTED_PROXY_HOPS = 5;

/**
 * 解析 TRUSTED_PROXY_HOPS 配置：空/非法/负数 → 默认值；上限截断。
 * @param {string | number | null | undefined} raw
 * @returns {number}
 */
export function parseTrustedProxyHops(raw) {
  if (raw == null || raw === '') return DEFAULT_TRUSTED_PROXY_HOPS;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 0) return DEFAULT_TRUSTED_PROXY_HOPS;
  return Math.min(n, MAX_TRUSTED_PROXY_HOPS);
}

/**
 * TCP peer 是否内网/环回（可信转发面）。
 * RFC 1918 / loopback / link-local / unique-local + GCP Cloud Run CGNAT 100.64/10。
 * @param {string} ip
 * @returns {boolean}
 */
export function isPrivateOrLoopbackIp(ip) {
  const v = String(ip || '').replace(/^::ffff:/, '');
  if (!v || v === 'unknown') return false;
  if (v === '127.0.0.1' || v === '::1') return true;
  if (v.startsWith('10.') || v.startsWith('192.168.') || v.startsWith('fd') || v.startsWith('fe80:')) return true;
  // RFC 1918 172.16/12 + GCP / Cloud Run CGNAT 100.64/10
  if (v.startsWith('172.')) {
    const second = Number(v.split('.')[1]);
    if (second >= 16 && second <= 31) return true;
  }
  if (v.startsWith('100.')) {
    const second = Number(v.split('.')[1]);
    if (second >= 64 && second <= 127) return true;
  }
  return false;
}

/**
 * 拆分 X-Forwarded-For（去空白、去空项）。前置条目可能是调用方注入的任意
 * 字符串，调用方不得原样信任（Google 文档亦不保证其格式）。
 * @param {unknown} forwardedFor
 * @returns {string[]}
 */
export function parseForwardedFor(forwardedFor) {
  if (typeof forwardedFor !== 'string') return [];
  return forwardedFor.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * 从 XFF 选取客户端条目：XFF[len - hops]。右侧 hops 个条目由受信代理追加，
 * 再往左一个即真实客户端 —— 无论调用方左侧伪造多少条，选择都落在受信区。
 * 条目数不足 hops（链路与配置不符）时返回 undefined，由调用方回退 peer
 * （宁可共享限流桶，也不选中可伪造的左侧条目）。
 * @param {string[]} parts
 * @param {number} hops
 * @returns {string | undefined}
 */
export function clientIpFromForwardedFor(parts, hops) {
  if (!Array.isArray(parts) || parts.length === 0 || hops <= 0) return undefined;
  const idx = parts.length - hops;
  if (idx < 0 || idx >= parts.length) return undefined;
  return parts[idx].slice(0, 64);
}

/**
 * 解析请求来源客户端 IP（限流 / 预算的身份键）。
 * - peer 为公网直连：直接用 peer（XFF 不可信，防伪造）。
 * - peer 为内网/环回（Cloud Run/GFE 转发）：取 XFF[len - trustedProxyHops]；
 *   XFF 缺失或条目数不足时回退 peer。
 * @param {{ peerAddress?: string | null, forwardedFor?: string | null, trustedProxyHops?: number | string }} req
 * @returns {string}
 */
export function resolveClientIp({ peerAddress, forwardedFor, trustedProxyHops } = {}) {
  const peer = String(peerAddress || 'unknown').slice(0, 64);
  if (!isPrivateOrLoopbackIp(peer)) return peer;
  const hops = parseTrustedProxyHops(trustedProxyHops ?? DEFAULT_TRUSTED_PROXY_HOPS);
  if (hops <= 0) return peer;
  const parts = parseForwardedFor(forwardedFor);
  return clientIpFromForwardedFor(parts, hops) || peer;
}
