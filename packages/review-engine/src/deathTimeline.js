import { LEAD_FLIP_THRESHOLD } from './advantageSwing.js';

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
 *
 * 完整性门槛：任何一名玩家的英雄缺权威 slug 映射（slug 表缺项、缓存未热）
 * 时整体返回不可用（reason: 'incomplete_hero_map'）——否则针对该英雄的击
 * 杀会被静默丢弃，该玩家的死亡时间线凭空缺条。
 */

/**
 * 死亡相位边界（与 reviewCards.js 的对线/中期/后期切分一致）：
 * 对线 0–10 分钟、中期 10–25 分钟、后期 25 分钟起。
 */
export const LANE_PHASE_END_SEC = 10 * 60;
export const MID_PHASE_END_SEC = 25 * 60;

/**
 * @param {number} seconds
 * @returns {'lane' | 'mid' | 'late'}
 */
export function deathPhaseAtTime(seconds) {
  if (seconds < LANE_PHASE_END_SEC) return 'lane';
  if (seconds < MID_PHASE_END_SEC) return 'mid';
  return 'late';
}

/**
 * 从死亡时间线事件归纳「最主要的死亡模式」。只使用事件自身可用的字段
 * （时间、凶手、阵亡时刻己方经济差）——不存在队友站位/视野数据，就绝不
 * 输出「无队友保护的单独死亡」这类无法从数据证实的模式。
 *
 * 候选模式（每个都需要 ≥2 个事件支撑，取支撑事件最多者，并列时按列出顺序）：
 * - phase_repeat：阵亡集中在同一相位（对线/中期/后期）
 * - repeat_killer：被同一名敌方英雄多次击杀
 * - behind_deaths：多次在经济明显落后（teamGoldLeadAtT ≤ −LEAD_FLIP_THRESHOLD）时阵亡
 *
 * @param {Array<{ time: number, killerHeroId?: number | null, teamGoldLeadAtT?: number | null }>} events
 * @returns {{ pattern: 'phase_repeat' | 'repeat_killer' | 'behind_deaths', phase?: 'lane' | 'mid' | 'late', killerHeroId?: number, events: Array<object>, totalDeaths: number } | null}
 * 事件不足 2 个或没有任何模式达到支撑门槛时返回 null。
 */
export function derivePrimaryDeathPattern(events) {
  const list = (Array.isArray(events) ? events : [])
    .filter((e) => e && typeof e.time === 'number');
  if (list.length < 2) return null;

  let phaseRepeat = null;
  for (const phase of ['lane', 'mid', 'late']) {
    const bucket = list.filter((e) => deathPhaseAtTime(e.time) === phase);
    if (bucket.length >= 2 && bucket.length > (phaseRepeat?.events.length ?? 0)) {
      phaseRepeat = { pattern: /** @type {const} */ ('phase_repeat'), phase: /** @type {'lane' | 'mid' | 'late'} */ (phase), events: bucket };
    }
  }

  let repeatKiller = null;
  const byKiller = new Map();
  for (const e of list) {
    if (typeof e.killerHeroId !== 'number') continue;
    if (!byKiller.has(e.killerHeroId)) byKiller.set(e.killerHeroId, []);
    byKiller.get(e.killerHeroId).push(e);
  }
  for (const bucket of byKiller.values()) {
    if (bucket.length >= 2 && bucket.length > (repeatKiller?.events.length ?? 0)) {
      repeatKiller = { pattern: /** @type {const} */ ('repeat_killer'), killerHeroId: bucket[0].killerHeroId, events: bucket };
    }
  }

  const behind = list.filter((e) => typeof e.teamGoldLeadAtT === 'number'
    && e.teamGoldLeadAtT <= -LEAD_FLIP_THRESHOLD);
  const behindDeaths = behind.length >= 2 ? { pattern: /** @type {const} */ ('behind_deaths'), events: behind } : null;

  const priority = { phase_repeat: 0, repeat_killer: 1, behind_deaths: 2 };
  const candidates = [phaseRepeat, repeatKiller, behindDeaths]
    .filter(Boolean)
    .sort((a, b) => (b.events.length - a.events.length) || (priority[a.pattern] - priority[b.pattern]));

  if (candidates.length === 0) return null;
  return { ...candidates[0], totalDeaths: list.length };
}

/**
 * 剥离前缀、忽略大小写与分隔符（与 reviewCards.js 的同名实现语义一致）。
 * matchFacts 构建 killsLog 时复用它做 kills_log 受害者映射（同队记录剔除）。
 */
export function normalizeHeroSlug(value) {
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
 * 击杀者与受害者同队（反补、自杀类记录）不是敌方造成的击杀/死亡。判定依据
 * 是双方 player_slot 的阵营（<128 为天辉）；任一方阵营未知时不判为同队
 * （记录保留，交由调用方处理）。死亡时间线与复盘卡片的击杀节点共用此判定。
 * @param {number | null | undefined} killerPlayerSlot
 * @param {number | null | undefined} victimPlayerSlot
 * @returns {boolean}
 */
export function isSameTeamKill(killerPlayerSlot, victimPlayerSlot) {
  const killerIsRadiant = slotIsRadiant(killerPlayerSlot);
  const victimIsRadiant = slotIsRadiant(victimPlayerSlot);
  return killerIsRadiant != null && victimIsRadiant != null && killerIsRadiant === victimIsRadiant;
}

/**
 * 反转 kills_log 构建每位英雄的死亡时间线。
 *
 * @param {Array<{ hero_id?: number, player_slot?: number, kills?: number, deaths?: number, kills_log?: Array<{ time: number, key: string }>, hero_name?: string }>} rawPlayers
 * @param {number[]} [radiantGoldAdv] 每分钟天辉-夜魇经济差（缺失传 []）
 * @param {Record<number, string> | null} [heroSlugById] heroId -> 'npc_dota_hero_x' 或 'x'（slug 的权威来源）
 * @param {{ parsed?: boolean }} [opts] parsed=true 且面板全场 0 击杀时，按「可用的空时间线」处理（每人 0 死亡）而不是不可用；面板有击杀却没有 kills_log 视为解析数据缺失，仍返回不可用
 * @returns {{
 *   available: boolean,
 *   reason?: string,
 *   deathsByHeroId?: Record<number, Array<{ time: number, minute: number, killerHeroId: number | null, killerIsRadiant: boolean | null, teamGoldLeadAtT: number | null }>>,
 *   coverage?: Record<number, { derivedCount: number, reportedDeaths: number | null }>,
 * }}
 * 未解析（全体玩家都没有 kills_log）或没有任何受害者能映射回英雄时返回
 * { available: false }；已解析但全场 0 英雄击杀时返回 available:true 的空
 * 时间线（0 死亡，status ok/empty）；任一玩家的英雄缺权威 slug（heroSlugById
 * 缺项且 hero_name 不是 npc_dota_hero_* 形态）时返回
 * { available: false, reason: 'incomplete_hero_map' }。
 */
export function buildDeathTimeline(rawPlayers, radiantGoldAdv = [], heroSlugById = null, opts = {}) {
  const players = Array.isArray(rawPlayers) ? rawPlayers : [];
  const goldAdv = Array.isArray(radiantGoldAdv) ? radiantGoldAdv : [];

  // 没有任何 kills_log：未解析的录像缺数据；已解析且面板全场 0 击杀才是
  // 真实的空结果 —— 按可用（每人 0 死亡）返回，而不是报 no_data。面板上
  // 有击杀却没有任何 kills_log 说明解析数据缺失（不完整），必须保持不可用。
  const hasKillsLog = players.some((p) => Array.isArray(p?.kills_log) && p.kills_log.length > 0);
  // 仅当记分板击杀与死亡都为 0 时才视为"确实无人死亡"；中立/肉山击杀或自杀会让 deaths>0 而 kills_log 为空。
  // Dota 2 对局固定 10 名玩家；名单不完整时无法确认无人死亡。
  const FULL_ROSTER_SIZE = 10;
  // 只有在名单完整、且每位玩家都明确报告 kills===0 与 deaths===0 时才算"确实无人死亡"；
  // 缺失/非数字的计数视为数据不完整（保持 unavailable）。
  const scoreboardConfirmsNoDeaths = players.length === FULL_ROSTER_SIZE && players.every(
    (p) => p?.kills === 0 && p?.deaths === 0,
  );
  const hasScoreboardKills = !scoreboardConfirmsNoDeaths;
  if (!hasKillsLog) {
    if (!opts.parsed || hasScoreboardKills) return { available: false };
    /** @type {Record<number, { derivedCount: number, reportedDeaths: number | null }>} */
    const emptyCoverage = {};
    for (const p of players) {
      if (p?.hero_id == null) continue;
      emptyCoverage[p.hero_id] = {
        derivedCount: 0,
        reportedDeaths: typeof p.deaths === 'number' ? p.deaths : null,
      };
    }
    return { available: true, deathsByHeroId: {}, coverage: emptyCoverage };
  }

  // slug -> 受害者玩家。只有权威英雄标识可注册：heroSlugById，以及形如
  // 'npc_dota_hero_*' 的 hero_name。玩家昵称（name）与英雄无关（有人就叫
  // "Axe"），绝不能作为受害者映射的依据。
  const playerBySlug = new Map();
  const register = (rawSlug, player) => {
    const slug = normalizeHeroSlug(rawSlug);
    if (slug && !playerBySlug.has(slug)) playerBySlug.set(slug, player);
  };
  let allHeroesMapped = true;
  for (const p of players) {
    if (p?.hero_id == null) continue;
    const hasSlugById = Boolean(normalizeHeroSlug(heroSlugById?.[p.hero_id]));
    const hasHeroName = isHeroNameIdentifier(p?.hero_name);
    register(heroSlugById?.[p.hero_id], p);
    if (hasHeroName) register(p.hero_name, p);
    if (!hasSlugById && !hasHeroName) allHeroesMapped = false;
  }

  // 完整性门槛：有英雄映射不上来（slug 表缺项、缓存未热）就整体不可用。
  // 否则针对该英雄的击杀在下面被静默跳过，该玩家的死亡时间线会凭空缺条，
  // 输出一份看似可用实则错误的数据。
  if (!allHeroesMapped) return { available: false, reason: 'incomplete_hero_map' };

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
      // 映射不到就跳过——上方完整性门槛保证了本场每个英雄都已注册，因此
      // 映射不到的 key 必非本场英雄（illusions、npc_dota_hero_base 之类），
      // 跳过不会丢掉任何真实死亡。
      if (!victim || victim.hero_id == null) continue;

      const minute = Math.floor(time / 60);
      const victimIsRadiant = slotIsRadiant(victim.player_slot);
      // 击杀者与受害者同队（反补、自杀类记录）不是敌方击杀导致的死亡，
      // 不能算进受害者的死亡时间线，直接丢弃（与复盘卡片共用 isSameTeamKill）。
      if (isSameTeamKill(killer?.player_slot, victim.player_slot)) {
        continue;
      }
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
  /** @type {Record<number, { derivedCount: number, reportedDeaths: number | null }>} */
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

  // 有 kills_log 却一个受害者都映射不出来（如全部 key 都是非本场英雄的
  // 实体）：时间线无法还原，如实报告不可用，而不是交出一份全空的「可用」
  // 数据。
  if (Object.keys(deathsByHeroId).length === 0) return { available: false };

  return { available: true, deathsByHeroId, coverage };
}
