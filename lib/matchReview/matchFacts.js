import { resolveLanes, LANE_CLUSTER_SOURCE, LANE_FALLBACK_SOURCE } from './laneResolver.js';
import { formatObjectiveLabel } from './objectiveLabels.js';
import { isMatchParsed } from './matchParse.js';
import { buildDeathTimeline, isSameTeamKill, normalizeHeroSlug } from './deathTimeline.js';
import { detectAdvantageSwing } from './advantageSwing.js';

const LANE_LABEL_ZH = {
  top: '上路',
  mid: '中路',
  bot: '下路',
  unknown: '未知',
};

const LANE_LABEL_EN = {
  top: 'Top',
  mid: 'Mid',
  bot: 'Bot',
  unknown: 'Unknown',
};

/** Shared cap for prompt + review cards; major objectives are always kept. */
export const MATCH_TIMELINE_DISPLAY_LIMIT = 15;

const MAJOR_OBJECTIVE_TYPES = new Set([
  'CHAT_MESSAGE_FIRSTBLOOD',
  'CHAT_MESSAGE_ROSHAN_KILL',
  'CHAT_MESSAGE_AEGIS',
]);

/** Max seconds after a Roshan kill to associate an Aegis pickup with that kill. */
const AEGIS_ROSHAN_ASSOC_WINDOW_SEC = 30;

/** 空字段原因文案（fieldReasons） */
const FIELD_REASON_MESSAGES = {
  not_parsed_yet: {
    zh: '该比赛录像尚未解析，OpenDota 解析完成后重试即可获得此数据',
    en: 'Replay not parsed yet — retry after OpenDota finishes parsing to get this data',
  },
  no_data: {
    zh: '录像已解析，但此字段本局没有数据',
    en: 'Replay parsed, but this field has no data for this match',
  },
  incomplete_hero_map: {
    zh: '英雄标识映射不完整，无法把击杀日志的受害者对应到玩家',
    en: 'Hero slug mapping incomplete — kills_log victims cannot be attributed to players',
  },
};

/**
 * 为空字段生成 { reason, message } 说明。explicitReason 是字段自身给出的
 * 失败原因（如死亡时间线的 'incomplete_hero_map'），优先于按 parsed 推断。
 * @param {string} field
 * @param {string} labelZh
 * @param {string} labelEn
 * @param {boolean} isEmpty
 * @param {boolean} parsed
 * @param {string} lang
 * @param {string | null} [explicitReason]
 */
function buildFieldReason(field, labelZh, labelEn, isEmpty, parsed, lang, explicitReason = null) {
  if (!isEmpty) return null;
  const reason = explicitReason && FIELD_REASON_MESSAGES[explicitReason]
    ? explicitReason
    : (parsed ? 'no_data' : 'not_parsed_yet');
  const base = FIELD_REASON_MESSAGES[reason][lang === 'zh' ? 'zh' : 'en'];
  const label = lang === 'zh' ? labelZh : labelEn;
  return { reason, message: `${label}${lang === 'zh' ? '：' : ': '}${base}` };
}

/**
 * @param {{ type: string, key?: string | null }} ev
 */
function isMajorTimelineEvent(ev) {
  if (MAJOR_OBJECTIVE_TYPES.has(ev.type)) return true;
  if (ev.type === 'building_kill' && ev.key) {
    return ev.key.includes('melee_rax')
      || ev.key.includes('range_rax')
      || ev.key.includes('fort');
  }
  return false;
}

/**
 * Select timeline events for display/LLM prompt: always keep major objectives
 * (first blood, Roshan, Aegis, barracks/ancient), then fill remaining slots
 * chronologically with other events.
 * @param {Array<{ time: number, type: string, key?: string | null }>} timeline
 * @param {number} [limit]
 */
export function selectTimelineForDisplay(timeline, limit = MATCH_TIMELINE_DISPLAY_LIMIT) {
  const majorCount = timeline.filter(isMajorTimelineEvent).length;
  const maxRegular = Math.max(0, limit - majorCount);

  const selected = [];
  let regularCount = 0;

  for (const ev of timeline) {
    if (isMajorTimelineEvent(ev)) {
      selected.push(ev);
    } else if (regularCount < maxRegular) {
      selected.push(ev);
      regularCount += 1;
    }
  }

  return selected;
}

/**
 * @param {number} seconds
 */
export function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * 从 OpenDota 比赛对象构建 MatchFact（供 API 与 LLM 使用）。
 * @param {object} match - OpenDota /matches/:id 响应
 * @param {{ lang?: string, heroId?: number, heroNames?: Record<number, { nameZh?: string, nameEn?: string, internalSlug?: string | null }> }} opts
 */
export function buildMatchFact(match, opts = {}) {
  const lang = opts.lang || 'zh';
  const focusHeroId = opts.heroId ? Number(opts.heroId) : undefined;
  const heroNames = opts.heroNames || {};

  const laneResolution = resolveLanes(match.players || []);

  const radiantGoldAdv = match.radiant_gold_adv || [];
  const parsed = isMatchParsed(match);

  // 死亡时间线需要 heroId -> 英雄 slug 才能把 kills_log 的受害者映射回玩家；
  // heroNames 的 internalSlug 即该 slug（'faceless_void' 形式，模块内归一化）。
  const heroSlugById = {};
  for (const [heroId, info] of Object.entries(heroNames)) {
    if (typeof info?.internalSlug === 'string' && info.internalSlug) {
      heroSlugById[Number(heroId)] = info.internalSlug;
    }
  }

  // kills_log 的同队记录（反补、自杀类）不是敌方击杀，在构建玩家 killsLog 时
  // 统一剔除，让相位主线、关键节点等所有消费方拿到的都是已过滤数据。受害者
  // 按 key（npc_dota_hero_<slug>）映射回 roster 取 player_slot，只认权威英雄
  // 标识（上面的 heroSlugById 与 'npc_dota_hero_*' 形态的 hero_name），与
  // 死亡时间线同一套规则；映射不到的记录保留，交由消费方处理。
  const victimSlotBySlug = new Map();
  const registerVictimSlug = (rawSlug, slot) => {
    const slug = normalizeHeroSlug(rawSlug);
    if (slug && !victimSlotBySlug.has(slug)) victimSlotBySlug.set(slug, slot);
  };
  for (const p of match.players || []) {
    if (p?.hero_id == null) continue;
    const slugById = heroSlugById[p.hero_id];
    if (slugById) registerVictimSlug(slugById, p.player_slot);
    if (typeof p?.hero_name === 'string' && p.hero_name.startsWith('npc_dota_hero_')) {
      registerVictimSlug(p.hero_name, p.player_slot);
    }
  }

  const deathTimeline = buildDeathTimeline(match.players || [], radiantGoldAdv, heroSlugById, { parsed });
  const advantageSwing = detectAdvantageSwing(radiantGoldAdv, match.radiant_win);

  const players = (match.players || []).map((p) => {
    const resolved = laneResolution.players.find((r) => r.heroId === p.hero_id);
    const cn = heroNames[p.hero_id];
    const nameEn = cn?.nameEn || `Hero#${p.hero_id}`;
    const nameZh = cn?.nameZh || nameEn;

    return {
      heroId: p.hero_id,
      playerSlot: p.player_slot,
      isRadiant: p.player_slot < 128,
      nameZh,
      nameEn,
      internalSlug: cn?.internalSlug || null,
      displayName: lang === 'zh' ? nameZh : nameEn,
      personName: typeof p.personaname === 'string' && p.personaname.trim() ? p.personaname.trim() : null,
      kills: p.kills ?? 0,
      deaths: p.deaths ?? 0,
      assists: p.assists ?? 0,
      gpm: p.gold_per_min ?? 0,
      xpm: p.xp_per_min ?? 0,
      netWorth: p.net_worth ?? 0,
      heroDamage: p.hero_damage ?? 0,
      towerDamage: p.tower_damage ?? 0,
      lastHits: p.last_hits ?? null,
      level: p.level ?? null,
      lane: resolved?.laneLabel || 'unknown',
      laneLabelZh: LANE_LABEL_ZH[resolved?.laneLabel] || LANE_LABEL_ZH.unknown,
      laneLabelEn: LANE_LABEL_EN[resolved?.laneLabel] || LANE_LABEL_EN.unknown,
      allies: resolved?.allies || [],
      opponents: resolved?.opponents || [],
      nearby: resolved?.nearby || [],
      laneSource: resolved?.source || LANE_CLUSTER_SOURCE,
      laneConfidence: resolved?.confidence || 'low',
      laneConfidenceScore: resolved?.confidenceScore ?? 0.3,
      goldTimeline: p.gold_t || [],
      lhTimeline: p.lh_t || [],
      xpTimeline: p.xp_t || [],
      timeBuckets: p.times || [],
      killsLog: (p.kills_log || []).filter((k) => {
        // 同队（反补/自杀类）记录在这里统一丢弃（isSameTeamKill 与死亡时间线
        // 共用同一判定）；受害者映射不到 roster 时保留原记录。
        const victimSlot = victimSlotBySlug.get(normalizeHeroSlug(k?.key));
        return victimSlot == null || !isSameTeamKill(p.player_slot, victimSlot);
      }).map((k) => ({
        time: k.time,
        target: k.key?.replace('npc_dota_hero_', '') || k.key,
      })),
      deathEvents: deathTimeline.available
        ? (deathTimeline.deathsByHeroId[p.hero_id] || [])
        : [],
      deathsDerivedCount: deathTimeline.available
        ? (deathTimeline.coverage[p.hero_id]?.derivedCount ?? 0)
        : 0,
    };
  });

  const lanes = laneResolution.lanes.map((lane) => ({
    ...lane,
    laneLabelZh: LANE_LABEL_ZH[lane.laneLabel] || lane.laneLabel,
    laneLabelEn: LANE_LABEL_EN[lane.laneLabel] || lane.laneLabel,
    radiantNames: lane.radiantHeroIds.map((id) => {
      const pl = players.find((p) => p.heroId === id);
      return pl?.displayName || `Hero#${id}`;
    }),
    direNames: lane.direHeroIds.map((id) => {
      const pl = players.find((p) => p.heroId === id);
      return pl?.displayName || `Hero#${id}`;
    }),
  }));

  const objectives = buildTimelineObjectives(match.objectives || [], players);

  const economyCheckpoints = [10, 20, 30, 40].map((min) => {
    const idx = min;
    return {
      minute: min,
      radiantGoldLead: radiantGoldAdv[idx] ?? null,
    };
  }).filter((e) => e.radiantGoldLead !== null);

  const focusPlayer = focusHeroId
    ? players.find((p) => p.heroId === focusHeroId)
    : undefined;

  const focusResolved = focusHeroId
    ? laneResolution.players.find((p) => p.heroId === focusHeroId)
    : undefined;

  const focusLaneGrounded = !focusHeroId || Boolean(
    focusResolved
    && focusResolved.source === LANE_CLUSTER_SOURCE
    && focusResolved.clusterId >= 0
    && focusResolved.laneLabel !== 'unknown'
    && focusResolved.centroid
  );

  const summary = {
    matchId: match.match_id,
    duration: match.duration,
    durationFormatted: formatDuration(match.duration || 0),
    radiantWin: Boolean(match.radiant_win),
    winner: match.radiant_win ? 'radiant' : 'dire',
    winnerLabelZh: match.radiant_win ? '天辉胜利' : '夜魇胜利',
    winnerLabelEn: match.radiant_win ? 'Radiant Victory' : 'Dire Victory',
    gameMode: match.game_mode,
    startTime: match.start_time,
  };

  const focusLens = focusPlayer
    ? buildFocusLens(focusPlayer, players, objectives, lang, focusLaneGrounded)
    : null;

  const laneDataGrounded = laneResolution.lanes.length > 0
    && laneResolution.source === LANE_CLUSTER_SOURCE
    && laneResolution.players.some((p) => p.clusterId >= 0);

  const fieldReasons = {};
  const reasonEntries = [
    ['lanes', '分路', 'Lanes', laneResolution.lanes.length === 0, null],
    ['timeline', '时间线', 'Timeline', objectives.length === 0, null],
    ['economy', '经济节点', 'Economy checkpoints', economyCheckpoints.length === 0, null],
    ['focusLane', '英雄分路', 'Focus hero lane', Boolean(focusHeroId) && !focusLaneGrounded, null],
    // 死亡时间线不可用时带上它自己的失败原因（如 'incomplete_hero_map'）。
    ['deaths', '死亡时间线', 'Death timeline', !deathTimeline.available, deathTimeline.reason || null],
  ];
  for (const [field, labelZh, labelEn, isEmpty, explicitReason] of reasonEntries) {
    const reason = buildFieldReason(field, labelZh, labelEn, isEmpty, parsed, lang, explicitReason);
    if (reason) fieldReasons[field] = reason;
  }

  return {
    summary,
    players,
    lanes,
    laneInferenceLabelZh: '根据录像站位推断',
    laneInferenceLabelEn: 'Inferred from replay positioning',
    laneSource: laneResolution.source,
    laneDataAvailable: laneDataGrounded,
    economy: {
      radiantGoldAdv,
      checkpoints: economyCheckpoints,
    },
    timeline: objectives,
    deathTimelineAvailable: deathTimeline.available,
    advantageSwing,
    focusHeroId: focusHeroId || null,
    focusLens,
    focusLaneGrounded,
    grounded: laneDataGrounded && focusLaneGrounded,
    parsed,
    fieldReasons,
  };
}

function buildFocusLens(focusPlayer, allPlayers, objectives, lang, laneGrounded = true) {
  const unavailZh = '本场暂无该英雄录像站位，无法推断分路';
  const unavailEn = 'No replay positioning for this hero; lane could not be inferred';

  const opponentIds = laneGrounded ? focusPlayer.opponents.map((o) => o.heroId) : [];
  const opponents = allPlayers.filter((p) => opponentIds.includes(p.heroId));
  const nearby = laneGrounded
    ? allPlayers.filter((p) => focusPlayer.nearby.some((n) => n.heroId === p.heroId))
    : [];

  const myKills = focusPlayer.killsLog || [];

  const relevantEvents = selectTimelineForDisplay(
    objectives.filter((o) => o.time <= 20 * 60),
    MATCH_TIMELINE_DISPLAY_LIMIT
  );

  return {
    heroId: focusPlayer.heroId,
    displayName: focusPlayer.displayName,
    kda: `${focusPlayer.kills}/${focusPlayer.deaths}/${focusPlayer.assists}`,
    gpm: focusPlayer.gpm,
    netWorth: focusPlayer.netWorth,
    lane: laneGrounded ? focusPlayer.lane : 'unknown',
    laneLabel: laneGrounded
      ? (lang === 'zh' ? focusPlayer.laneLabelZh : focusPlayer.laneLabelEn)
      : (lang === 'zh' ? unavailZh : unavailEn),
    laneGrounded,
    opponents: opponents.map((o) => ({
      heroId: o.heroId,
      displayName: o.displayName,
      kda: `${o.kills}/${o.deaths}/${o.assists}`,
    })),
    nearby: nearby.map((o) => ({
      heroId: o.heroId,
      displayName: o.displayName,
    })),
    earlyKills: myKills.filter((k) => k.time < 15 * 60),
    deathEvents: focusPlayer.deathEvents,
    keyTimeline: relevantEvents,
    laneSource: laneGrounded ? focusPlayer.laneSource : LANE_FALLBACK_SOURCE,
    laneConfidence: laneGrounded ? focusPlayer.laneConfidence : 'low',
  };
}

/** Steam 选手名进入 LLM 提示前的最大长度（按码点计）。 */
const PLAYER_NAME_PROMPT_MAX_CHARS = 24;

/**
 * 清洗不可信的 Steam personaname 再拼进 LLM 提示：去掉控制字符（换行/制表
 * 等，防止伪造新行）、markdown/提示元字符（反引号、#、|、<>）与引号（引号
 * 去掉后下方的 name:"..." 包裹才不可能被提前闭合），折叠空白并截断长度。
 * 清洗后没有可读字符时返回 null（调用方退回纯英雄名）。
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
export function sanitizePlayerNameForPrompt(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[`#|<>"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return Array.from(cleaned).slice(0, PLAYER_NAME_PROMPT_MAX_CHARS).join('');
}

/**
 * 单个玩家的紧凑数据行（追问/复盘提示共用）：阵营、英雄、
 * K/D/A、GPM、XPM、经济，以及可选的正补/等级/英雄伤害。选手名是不可信的
 * Steam 输入，故意不写入提示。
 * @param {object} p MatchFact.players 条目
 * @param {boolean} isZh
 */
function formatPlayerFactLine(p, isZh) {
  const side = isZh ? (p.isRadiant ? '天辉' : '夜魇') : (p.isRadiant ? 'Radiant' : 'Dire');
  // Steam personaname 是不可信输入（可含提示注入），不进入 LLM 提示；只用阵营+英雄标识。
  const who = p.displayName;
  const parts = [
    `K/D/A ${p.kills}/${p.deaths}/${p.assists}`,
    `GPM ${p.gpm}`,
    `XPM ${p.xpm}`,
    isZh ? `经济 ${p.netWorth}` : `net worth ${p.netWorth}`,
    isZh ? `英雄伤害 ${p.heroDamage}` : `hero damage ${p.heroDamage}`,
  ];
  if (p.lastHits != null) parts.push(isZh ? `正补 ${p.lastHits}` : `last hits ${p.lastHits}`);
  if (p.level != null) parts.push(isZh ? `等级 ${p.level}` : `level ${p.level}`);
  return isZh ? `- ${side} ${who}：${parts.join('，')}` : `- ${side} ${who}: ${parts.join(', ')}`;
}

/**
 * 序列化 MatchFact 为 LLM 提示文本（不含 OpenDota lane/lane_role 原始字段）。
 */
export function matchFactToPrompt(matchFact, lang = 'zh') {
  const isZh = lang === 'zh';
  const lines = [];

  const s = matchFact.summary;
  lines.push(isZh
    ? `比赛 ${s.matchId}，时长 ${s.durationFormatted}，${s.winnerLabelZh}`
    : `Match ${s.matchId}, ${s.durationFormatted}, ${s.winnerLabelEn}`);

  if (Array.isArray(matchFact.players) && matchFact.players.length > 0) {
    lines.push(isZh ? '\n## 玩家数据' : '\n## Players');
    for (const p of matchFact.players) {
      lines.push(formatPlayerFactLine(p, isZh));
    }
  }

  lines.push(isZh ? '\n## 真实分路（根据录像站位推断）' : '\n## Lanes (inferred from positioning)');
  for (const lane of matchFact.lanes) {
    const label = isZh ? lane.laneLabelZh : lane.laneLabelEn;
    const rad = lane.radiantNames.join(' + ');
    const dire = lane.direNames.join(' + ');
    lines.push(isZh
      ? `- ${label}: 天辉 ${rad} vs 夜魇 ${dire}`
      : `- ${label}: Radiant ${rad} vs Dire ${dire}`);
  }

  if (matchFact.focusLens) {
    const f = matchFact.focusLens;
    lines.push(isZh ? `\n## 你的英雄：${f.displayName}` : `\n## Your hero: ${f.displayName}`);
    lines.push(isZh
      ? `KDA ${f.kda}, GPM ${f.gpm}, 经济 ${f.netWorth}`
      : `KDA ${f.kda}, GPM ${f.gpm}, net worth ${f.netWorth}`);
    if (f.laneGrounded) {
      lines.push(isZh
        ? `分路：${f.laneLabel}，对线：${f.opponents.map((o) => o.displayName).join('、') || '无'}`
        : `Lane: ${f.laneLabel}, vs ${f.opponents.map((o) => o.displayName).join(', ') || 'none'}`);
      if (f.nearby.length > 0) {
        lines.push(isZh
          ? `附近英雄：${f.nearby.map((o) => o.displayName).join('、')}`
          : `Nearby: ${f.nearby.map((o) => o.displayName).join(', ')}`);
      }
    } else {
      lines.push(isZh ? `分路：${f.laneLabel}` : `Lane: ${f.laneLabel}`);
    }
  }

  lines.push(isZh ? '\n## 经济节点' : '\n## Economy checkpoints');
  for (const cp of matchFact.economy.checkpoints) {
    const lead = cp.radiantGoldLead;
    const sign = lead >= 0 ? '+' : '';
    lines.push(isZh
      ? `- ${cp.minute} 分钟：天辉经济 ${sign}${lead}`
      : `- ${cp.minute} min: Radiant gold ${sign}${lead}`);
  }

  lines.push(isZh ? '\n## 关键时间线' : '\n## Key timeline');
  for (const ev of selectTimelineForDisplay(matchFact.timeline)) {
    const min = Math.floor(ev.time / 60);
    const sec = ev.time % 60;
    const label = formatObjectiveLabel(ev, lang);
    lines.push(`- ${min}:${String(sec).padStart(2, '0')} ${label}`);
  }

  return lines.join('\n');
}

/**
 * building_kill 的 unit（击杀实体）自带阵营前缀：creep_goodguys_* / badguys_*
 * 覆盖小兵/攻城车拆塔（无 player_slot）的情况，用于推导摧毁方。
 * @param {string | null | undefined} unit
 */
function killerTeamFromObjectiveUnit(unit) {
  if (typeof unit !== 'string' || !unit) return null;
  if (unit.includes('goodguys')) return 2;
  if (unit.includes('badguys')) return 3;
  return null;
}

/**
 * @param {Array<{ type: string, time: number, key?: string, team?: number, player_slot?: number, unit?: string }>} rawObjectives
 * @param {Array<{ playerSlot: number, heroId: number, displayName: string }>} players
 */
function buildTimelineObjectives(rawObjectives, players) {
  const included = new Set([
    'building_kill',
    'CHAT_MESSAGE_FIRSTBLOOD',
    'CHAT_MESSAGE_ROSHAN_KILL',
    'CHAT_MESSAGE_AEGIS',
  ]);

  const filtered = rawObjectives.filter((o) => included.has(o.type));

  return filtered.map((o) => {
    const playerSlot = o.player_slot ?? null;
    const player = playerSlot != null
      ? players.find((p) => p.playerSlot === playerSlot)
      : null;
    const team = o.team
      ?? (playerSlot != null ? (playerSlot < 128 ? 2 : 3) : null)
      ?? killerTeamFromObjectiveUnit(o.unit);

    let aegisStolen = false;
    if (o.type === 'CHAT_MESSAGE_AEGIS') {
      const roshanKill = findRoshanKillForAegis(rawObjectives, o.time);
      const roshanTeam = roshanKill?.team ?? null;
      aegisStolen = roshanTeam != null && team != null && roshanTeam !== team;
    }

    return {
      time: o.time,
      type: o.type,
      key: o.key || null,
      team,
      playerSlot,
      heroId: player?.heroId ?? null,
      carrierName: player?.displayName ?? null,
      aegisStolen,
    };
  }).sort((a, b) => a.time - b.time);
}

/**
 * @param {Array<{ type: string, time: number, team?: number }>} rawObjectives
 * @param {number} aegisTime
 */
function findRoshanKillForAegis(rawObjectives, aegisTime) {
  let best = null;
  for (const r of rawObjectives) {
    if (r.type !== 'CHAT_MESSAGE_ROSHAN_KILL') continue;
    if (r.time > aegisTime) continue;
    if (aegisTime - r.time > AEGIS_ROSHAN_ASSOC_WINDOW_SEC) continue;
    if (!best || r.time > best.time) best = r;
  }
  return best;
}

export { parseMatchId } from './parseMatchId.js';
