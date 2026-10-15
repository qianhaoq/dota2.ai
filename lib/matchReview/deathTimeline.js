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

/** hero_name 只有形如 'npc_dota_hero_*' 才是英雄标识；玩家昵称绝不可当 slug 用。 */
function isHeroNameIdentifier(value) {
  return typeof value === 'string' && value.startsWith(HERO_NAME_PREFIX);
}

const HERO_NAME_PREFIX = 'npc_dota_hero_';

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
 * @param {Array<{ hero_id?: number, player_slot?: number, deaths?: number, kills_log?: Array<{ time: number, key: string }>, hero_name?: string }>} rawPlayers
 * @param {number[]} [radiantGoldAdv] 每分钟天辉-夜魇经济差（缺失传 []）
 * @param {Record<number, string> | null} [heroSlugById] heroId -> 'npc_dota_hero_x' 或 'x'（slug 的权威来源）
 * @returns {{
 *   available: boolean,
 *   deathsByHeroId?: Record<number, Array<{ time: number, minute: number, killerHeroId: number | null, killerIsRadiant: boolean | null, teamGoldLeadAtT: number | null }>>,
 *   coverage?: Record<number, { derivedCount: number, reportedDeaths: number | null }>,
 * }}
 * 未解析（全体玩家都没有 kills_log），或有 kills_log 但没有任何受害者能映射回
 * 英雄（如英雄 slug 表为空）时，均返回 { available: false }。
 */
export function buildDeathTimeline(rawPlayers, radiantGoldAdv = [], heroSlugById = null) {
  const players = Array.isArray(rawPlayers) ? rawPlayers : [];
  const goldAdv = Array.isArray(radiantGoldAdv) ? radiantGoldAdv : [];

  // 未解析的录像没有任何 kills_log，无法还原死亡时间线。
  const hasKillsLog = players.some((p) => Array.isArray(p?.kills_log) && p.kills_log.length > 0);
  if (!hasKillsLog) return { available: false };

  // slug -> 受害者玩家。只有权威英雄标识可注册：heroSlugById，以及形如
  // 'npc_dota_hero_*' 的 hero_name。玩家昵称（name）与英雄无关（有人就叫
  // "Axe"），绝不能作为受害者映射的依据。
  const playerBySlug = new Map();
  const register = (rawSlug, player) => {
    const slug = normalizeHeroSlug(rawSlug);
    if (slug && !playerBySlug.has(slug)) playerBySlug.set(slug, player);
  };
  for (const p of players) {
    if (p?.hero_id == null) continue;
    register(heroSlugById?.[p.hero_id], p);
    if (isHeroNameIdentifier(p?.hero_name)) register(p.hero_name, p);
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

  // 有 kills_log 却一个受害者都映射不出来（如英雄 slug 表为空、缓存未热）：
  // 时间线无法还原，如实报告不可用，而不是交出一份全空的「可用」数据。
  if (Object.keys(deathsByHeroId).length === 0) return { available: false };

  return { available: true, deathsByHeroId, coverage };
}
