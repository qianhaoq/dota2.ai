import { resolveLanes, LANE_CLUSTER_SOURCE, LANE_FALLBACK_SOURCE } from './laneResolver.js';
import { formatObjectiveLabel } from './objectiveLabels.js';

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
 * @param {{ lang?: string, heroId?: number, heroNames?: Record<number, { nameZh?: string, nameEn?: string }> }} opts
 */
export function buildMatchFact(match, opts = {}) {
  const lang = opts.lang || 'zh';
  const focusHeroId = opts.heroId ? Number(opts.heroId) : undefined;
  const heroNames = opts.heroNames || {};

  const laneResolution = resolveLanes(match.players || []);

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
      kills: p.kills ?? 0,
      deaths: p.deaths ?? 0,
      assists: p.assists ?? 0,
      gpm: p.gold_per_min ?? 0,
      xpm: p.xp_per_min ?? 0,
      netWorth: p.net_worth ?? 0,
      heroDamage: p.hero_damage ?? 0,
      towerDamage: p.tower_damage ?? 0,
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
      killsLog: (p.kills_log || []).map((k) => ({
        time: k.time,
        target: k.key?.replace('npc_dota_hero_', '') || k.key,
      })),
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

  const radiantGoldAdv = match.radiant_gold_adv || [];
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
    focusHeroId: focusHeroId || null,
    focusLens,
    focusLaneGrounded,
    grounded: laneDataGrounded && focusLaneGrounded,
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
    keyTimeline: relevantEvents,
    laneSource: laneGrounded ? focusPlayer.laneSource : LANE_FALLBACK_SOURCE,
    laneConfidence: laneGrounded ? focusPlayer.laneConfidence : 'low',
  };
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
 * @param {Array<{ type: string, time: number, key?: string, team?: number, player_slot?: number }>} rawObjectives
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
    const team = o.team ?? (playerSlot != null ? (playerSlot < 128 ? 2 : 3) : null);

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
