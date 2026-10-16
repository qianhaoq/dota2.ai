/**
 * 解析比赛 ID：纯数字，或 OpenDota / Dotabuff / STRATZ 的比赛页 URL
 * （带不带协议、www、尾随路径/查询参数均可；其他域名一律不认）。
 */
const MATCH_URL_HOSTS = ['opendota.com', 'dotabuff.com', 'stratz.com'];

export function parseMatchId(input) {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  for (const host of MATCH_URL_HOSTS) {
    const escaped = host.replace(/\./g, '\\.');
    const match = trimmed.match(new RegExp(`${escaped}/matches/(\\d+)`, 'i'));
    if (match) return Number(match[1]);
  }

  return null;
}
