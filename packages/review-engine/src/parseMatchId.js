/**
 * 解析比赛 ID：纯数字（可选前导 #），或 dota2.ai / OpenDota / Dotabuff / STRATZ
 * 的比赛页 URL（带不带协议、www、尾随路径/查询参数均可；其他域名一律不认）。
 *
 * 域名校验基于 URL 主机名：受支持域名本身或其子域：
 * `evilstratz.com`、`opendota.com.evil.test` 这类 lookalike 不属于受支持域名，直接拒绝。
 */
const MATCH_URL_HOSTS = ['opendota.com', 'dotabuff.com', 'stratz.com'];
const DOTA2AI_HOSTS = ['dota2.ai'];
const BARE_MATCH_ID = /^[1-9]\d{0,12}$/;
const MAX_MATCH_ID = 2 ** 40;

const hostMatches = (host, list) => list.some((d) => host === d || host.endsWith(`.${d}`));

/**
 * Parse a Dota 2 match ID into a canonical digit string (`^[1-9]\d{0,12}$`, <= 2^40),
 * accepting trimmed digits, `#digits`, or a trusted dota2.ai / OpenDota / Dotabuff / STRATZ match URL.
 * Returns null for anything invalid or from an untrusted host.
 */
export function normalizeMatchId(input) {
  if (input == null || input === '') return null;
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  const trimmed = String(input).trim();
  if (!trimmed) return null;
  const bare = trimmed.startsWith('#') ? trimmed.slice(1).trim() : trimmed;
  if (BARE_MATCH_ID.test(bare)) {
    const n = Number(bare);
    return Number.isSafeInteger(n) && n > 0 && n <= MAX_MATCH_ID ? bare : null;
  }
  // Reject explicit non-http(s) schemes (e.g. javascript:, data:, file:, ftp:) before falling back to https://.
  let withScheme;
  if (trimmed.includes('://')) {
    withScheme = trimmed;
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return null;
  } else if (trimmed.startsWith('//')) {
    withScheme = `https:${trimmed}`;
  } else {
    withScheme = `https://${trimmed}`;
  }
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  let match = null;
  if (hostMatches(host, MATCH_URL_HOSTS)) {
    match = url.pathname.match(/^\/matches\/([1-9]\d{0,12})(?=\/|$)/i);
  } else if (hostMatches(host, DOTA2AI_HOSTS)) {
    match = url.pathname.match(/^\/(?:r|match)\/([1-9]\d{0,12})(?=\/|$)/i);
  } else {
    return null;
  }
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) && n > 0 && n <= MAX_MATCH_ID ? match[1] : null;
}

export function parseMatchId(input) {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  // 无协议的粘贴文本（opendota.com/...）与协议相对形式（//opendota.com/...）
  // 都补上 https 再交给 URL 解析；解析失败即拒绝。
  let withScheme;
  if (trimmed.includes('://')) {
    withScheme = trimmed;
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return null;
  } else if (trimmed.startsWith('//')) {
    withScheme = `https:${trimmed}`;
  } else {
    withScheme = `https://${trimmed}`;
  }
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  // 只认受支持域名的真主机名（允许 www. 前缀），杜绝子串 lookalike。
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (hostMatches(host, MATCH_URL_HOSTS)) {
    const match = url.pathname.match(/\/matches\/(\d+)(?=\/|$)/i);
    return match ? Number(match[1]) : null;
  }
  if (hostMatches(host, DOTA2AI_HOSTS)) {
    const match = url.pathname.match(/^\/(?:r|match)\/(\d+)(?=\/|$)/i);
    return match ? Number(match[1]) : null;
  }
  return null;
}
