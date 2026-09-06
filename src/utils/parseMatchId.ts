/** 解析比赛 ID：纯数字、OpenDota URL、Dotabuff URL */
export function parseMatchId(input: string | null | undefined): number | null {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  const opendota = trimmed.match(/opendota\.com\/matches\/(\d+)/i);
  if (opendota) return Number(opendota[1]);

  const dotabuff = trimmed.match(/dotabuff\.com\/matches\/(\d+)/i);
  if (dotabuff) return Number(dotabuff[1]);

  return null;
}
