/**
 * 解析比赛 ID：纯数字，或 OpenDota / Dotabuff / STRATZ 的比赛页 URL
 * （带不带协议、www、尾随路径/查询参数均可；其他域名一律不认）。
 *
 * 域名校验基于 URL 主机名：受支持域名本身或其子域：
 * `evilstratz.com`、`opendota.com.evil.test` 这类 lookalike 不属于受支持域名，直接拒绝。
 */
const MATCH_URL_HOSTS = ['opendota.com', 'dotabuff.com', 'stratz.com'];

export function parseMatchId(input) {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  // 无协议的粘贴文本（opendota.com/...）与协议相对形式（//opendota.com/...）
  // 都补上 https 再交给 URL 解析；解析失败即拒绝。
  const withScheme = trimmed.includes('://')
    ? trimmed
    : (trimmed.startsWith('//') ? `https:${trimmed}` : `https://${trimmed}`);
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  // 只认受支持域名的真主机名（允许 www. 前缀），杜绝子串 lookalike。
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!MATCH_URL_HOSTS.some((d) => host === d || host.endsWith(`.${d}`))) return null;

  const match = url.pathname.match(/\/matches\/(\d+)/i);
  return match ? Number(match[1]) : null;
}
