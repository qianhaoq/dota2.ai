import { resolveLanes, LANE_CLUSTER_SOURCE } from './laneResolver.js';

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

  const objectives = (match.objectives || [])
    .filter((o) => o.type === 'building_kill' || o.type === 'CHAT_MESSAGE_FIRSTBLOOD' || o.type === 'CHAT_MESSAGE_ROSHAN_KILL')
    .map((o) => ({
      time: o.time,
      type: o.type,
      key: o.key || null,
      team: o.team ?? null,
    }))
    .sort((a, b) => a.time - b.time);

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
    ? buildFocusLens(focusPlayer, players, objectives, lang)
    : null;

  return {
    summary,
    players,
    lanes,
    laneInferenceLabelZh: '根据录像站位推断',
    laneInferenceLabelEn: 'Inferred from replay positioning',
    laneSource: LANE_CLUSTER_SOURCE,
    economy: {
      radiantGoldAdv,
      checkpoints: economyCheckpoints,
    },
    timeline: objectives,
    focusHeroId: focusHeroId || null,
    focusLens,
    grounded: true,
  };
}

function buildFocusLens(focusPlayer, allPlayers, objectives, lang) {
  const opponentIds = focusPlayer.opponents.map((o) => o.heroId);
  const opponents = allPlayers.filter((p) => opponentIds.includes(p.heroId));
  const nearby = allPlayers.filter((p) =>
    focusPlayer.nearby.some((n) => n.heroId === p.heroId)
  );

  const myKills = focusPlayer.killsLog || [];
  const deathsAgainst = objectives.filter(() => false);

  const relevantEvents = objectives.filter((o) => {
    if (o.time > 20 * 60) return false;
    return true;
  }).slice(0, 12);

  return {
    heroId: focusPlayer.heroId,
    displayName: focusPlayer.displayName,
    kda: `${focusPlayer.kills}/${focusPlayer.deaths}/${focusPlayer.assists}`,
    gpm: focusPlayer.gpm,
    netWorth: focusPlayer.netWorth,
    lane: focusPlayer.lane,
    laneLabel: lang === 'zh' ? focusPlayer.laneLabelZh : focusPlayer.laneLabelEn,
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
    laneSource: focusPlayer.laneSource,
    laneConfidence: focusPlayer.laneConfidence,
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
    const rad = isZh ? lane.radiantNames.join(' + ') : lane.radiantNames.join(' + ');
    const dire = isZh ? lane.direNames.join(' + ') : lane.direNames.join(' + ');
    lines.push(`- ${label}: 天辉 ${rad} vs 夜魇 ${dire}`);
  }

  if (matchFact.focusLens) {
    const f = matchFact.focusLens;
    lines.push(isZh ? `\n## 你的英雄：${f.displayName}` : `\n## Your hero: ${f.displayName}`);
    lines.push(`KDA ${f.kda}, GPM ${f.gpm}, 经济 ${f.netWorth}`);
    lines.push(isZh
      ? `分路：${f.laneLabel}，对线：${f.opponents.map((o) => o.displayName).join('、') || '无'}`
      : `Lane: ${f.laneLabel}, vs ${f.opponents.map((o) => o.displayName).join(', ') || 'none'}`);
    if (f.nearby.length > 0) {
      lines.push(isZh
        ? `附近英雄：${f.nearby.map((o) => o.displayName).join('、')}`
        : `Nearby: ${f.nearby.map((o) => o.displayName).join(', ')}`);
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
  for (const ev of matchFact.timeline.slice(0, 15)) {
    const min = Math.floor(ev.time / 60);
    const sec = ev.time % 60;
    lines.push(`- ${min}:${String(sec).padStart(2, '0')} ${ev.type}${ev.key ? ` ${ev.key}` : ''}`);
  }

  return lines.join('\n');
}

/**
 * 解析比赛 ID：支持纯数字、OpenDota URL、Dotabuff URL。
 */
export function parseMatchId(input) {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  const opendota = trimmed.match(/opendota\.com\/matches\/(\d+)/i);
  if (opendota) return Number(opendota[1]);

  const dotabuff = trimmed.match(/dotabuff\.com\/matches\/(\d+)/i);
  if (dotabuff) return Number(dotabuff[1]);

  return null;
}
