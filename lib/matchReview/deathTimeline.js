/**
 * 死亡时间线（纯逻辑，无网络访问，便于单测）：
 * - buildDeathTimeline: 反转全部玩家的 kills_log，还原每位英雄的阵亡事件
 *   （时间、凶手、阵亡时刻己方经济差）。
 *
 * OpenDota 解析数据的 players[i].kills_log 只记录「该玩家自己完成的击杀」
 * （[{ time, key: 'npc_dota_hero_<slug>' }]）。把全体玩家的 kills_log 叠加
 * 反转即得到每个英雄的死亡时间线。凶手必须是英雄的死亡才会留下记录，因
 * 此还原出的死亡数可能少于面板 deaths（小兵/防御塔/反补致死不计），数据
 * 只做还原、绝不编造。
 */

/** 与 reviewCards.js 的 normalizeHeroSlug 语义一致：剥离前缀、忽略大小写与分隔符。 */
function normalizeHeroSlug(value) {
  return String(value || '')
    .replace(/^npc_dota_hero_/, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

/**
 * @param {number} playerSlot
 * @returns {boolean | null}
 */
function slotIsRadiant(playerSlot) {
  return typeof playerSlot === 'number' ? playerSlot < 128 : null;
}

/**
 * 反转 kills_log 构建每位英雄的死亡时间线。
 *
 * @param {Array<{ hero_id?: number, player_slot?: number, deaths?: number, kills_log?: Array<{ time: number, key: string }>, hero_name?: string, name?: string }>} rawPlayers
 * @param {number[]} [radiantGoldAdv] 每分钟天辉-夜魇经济差（缺失传 []）
 * @param {Record<number, string> | null} [heroSlugById] heroId -> 'npc_dota_hero_x' 或 'x'（slug 的权威来源）
 * @returns {{
 *   available: boolean,
 *   deathsByHeroId?: Record<number, Array<{ time: number, minute: number, killerHeroId: number | null, killerIsRadiant: boolean | null, teamGoldLeadAtT: number | null }>>,
 *   coverage?: Record<number, { derivedCount: number, reportedDeaths: number | null }>,
 * }}
 * 未解析（全体玩家都没有 kills_log）时返回 { available: false }。
 */
export function buildDeathTimeline(rawPlayers, radiantGoldAdv = [], heroSlugById = null) {
  const players = Array.isArray(rawPlayers) ? rawPlayers : [];
  const goldAdv = Array.isArray(radiantGoldAdv) ? radiantGoldAdv : [];

  // 未解析的录像没有任何 kills_log，无法还原死亡时间线。
  const hasKillsLog = players.some((p) => Array.isArray(p?.kills_log) && p.kills_log.length > 0);
  if (!hasKillsLog) return { available: false };

  // slug -> 受害者玩家。heroSlugById / hero_name 是英雄权威来源，先注册；
  // name（玩家昵称）最低优先级，最后兜底，避免昵称抢占英雄 slug。
  const playerBySlug = new Map();
  const register = (rawSlug, player) => {
    const slug = normalizeHeroSlug(rawSlug);
    if (slug && !playerBySlug.has(slug)) playerBySlug.set(slug, player);
  };
  for (const p of players) {
    if (p?.hero_id == null) continue;
    register(heroSlugById?.[p.hero_id], p);
    register(p.hero_name, p);
  }
  for (const p of players) {
    if (p?.hero_id == null) continue;
    register(p.name, p);
  }

  /** @type {Record<number, Array<{ time: number, minute: number, killerHeroId: number | null, killerIsRadiant: boolean | null, teamGoldLeadAtT: number | null }>>} */
  const deathsByHeroId = {};
  for (const killer of players) {
    const killsLog = Array.isArray(killer?.kills_log) ? killer.kills_log : [];
    if (killsLog.length === 0) continue;
    const killerHeroId = typeof killer?.hero_id === 'number' ? killer.hero_id : null;
    const killerIsRadiant = slotIsRadiant(killer?.player_slot);

    for (const entry of killsLog) {
      const time = entry?.time;
      if (typeof time !== 'number') continue;
      const victim = playerBySlug.get(normalizeHeroSlug(entry?.key));
      if (!victim || victim.hero_id == null) continue; // 受害者无法映射到英雄 -> 跳过

      const minute = Math.floor(time / 60);
      const victimIsRadiant = slotIsRadiant(victim.player_slot);
      const radiantLead = typeof goldAdv[minute] === 'number' ? goldAdv[minute] : null;
      const teamGoldLeadAtT = radiantLead != null && victimIsRadiant != null
        ? (victimIsRadiant ? radiantLead : -radiantLead)
        : null;

      (deathsByHeroId[victim.hero_id] || (deathsByHeroId[victim.hero_id] = [])).push({
        time,
        minute,
        killerHeroId,
        killerIsRadiant,
        teamGoldLeadAtT,
      });
    }
  }

  // 覆盖率：kills_log 反推的死亡数 vs 面板上报的 deaths（后者可能更高）。
  const coverage = {};
  for (const p of players) {
    if (p?.hero_id == null) continue;
    coverage[p.hero_id] = {
      derivedCount: (deathsByHeroId[p.hero_id] || []).length,
      reportedDeaths: typeof p.deaths === 'number' ? p.deaths : null,
    };
  }

  for (const events of Object.values(deathsByHeroId)) {
    events.sort((a, b) => a.time - b.time);
  }

  return { available: true, deathsByHeroId, coverage };
}
