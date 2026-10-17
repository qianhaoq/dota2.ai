/**
 * 三条结论（纯逻辑，无网络访问，便于单测）：
 * - buildThreeConclusions: 从 matchFacts.buildMatchFact 产出的 MatchFact 里
 *   提炼 turningPoint / topMistake / nextGameRule 三条结论与 2–3 条预设追问，
 *   并给出聚焦方胜负 outcome（'win' | 'loss' | null，供 UI 调整标题）。
 *
 * 只陈述 MatchFact 里真实存在的事实：转折点来自经济逆转检测 + 死亡时间线，
 * 最大问题来自死亡模式归纳，下一局规则只有在装备时间或对线对位事实齐备时
 * 才输出。任何缺失都以显式 insufficient 标记收场（zh「数据不足」/ en
 * 「Insufficient data」），绝不编造视野、站位或装备建议。
 */

import { formatDuration } from './matchFacts.js';
import { formatObjectiveLabel } from './objectiveLabels.js';
import { LEAD_FLIP_THRESHOLD } from './advantageSwing.js';
import { derivePrimaryDeathPattern } from './deathTimeline.js';

/** 每条结论最多携带的证据条数。 */
const DEATH_REASON_TEXT = {
  not_parsed_yet: { en: 'death timeline unavailable (replay not parsed yet)', zh: '死亡时间线不可用（录像尚未解析）' },
  incomplete_hero_map: { en: 'death timeline unavailable (replay parsed, but kill-log heroes could not be mapped to players)', zh: '死亡时间线不可用（录像已解析，但击杀日志的英雄无法对应到玩家）' },
  no_data: { en: 'death timeline unavailable (replay parsed, but no usable kill-log data)', zh: '死亡时间线不可用（录像已解析，但没有可用的击杀日志）' },
  unknown: { en: 'death timeline unavailable', zh: '死亡时间线不可用' },
};

export const MAX_EVIDENCE_ITEMS = 6;
/** 兜底「最大单分钟经济波动」所需的最短经济曲线（分钟数）。 */
export const TURNING_POINT_MIN_ADV_MINUTES = 6;
/** 死亡团灭判定的滚动窗口：同一队在该秒数内阵亡 ≥ WIPE_MIN_DEATHS 视为一次团灭。 */
export const WIPE_WINDOW_SEC = 30;
export const WIPE_MIN_DEATHS = 3;

const CONCLUSION_TITLES = {
  turningPoint: { zh: '转折点', en: 'Turning point' },
  topMistake: { zh: '最大问题', en: 'Top mistake' },
  nextGameRule: { zh: '下一局规则', en: 'Next-game rule' },
};

const SIDE_LABELS = {
  radiant: { zh: '天辉', en: 'Radiant' },
  dire: { zh: '夜魇', en: 'Dire' },
};

const DEATH_PHASE_LABELS = {
  lane: { zh: '对线期（0–10 分钟）', en: 'lane phase (0–10 min)' },
  mid: { zh: '中期（10–25 分钟）', en: 'mid game (10–25 min)' },
  late: { zh: '后期（25 分钟后）', en: 'late game (25+ min)' },
};

/** @param {number} value */
function signed(value) {
  return value >= 0 ? `+${value}` : String(value);
}

/**
 * @param {object | null | undefined} facts MatchFact（buildMatchFact 产物）
 * @returns {facts is Record<string, never>} false 当输入不是对象
 */
function isFactObject(facts) {
  return Boolean(facts) && typeof facts === 'object';
}

/**
 * @param {string} key
 * @param {string} lang
 */
function titleFor(key, lang) {
  return CONCLUSION_TITLES[key][lang === 'zh' ? 'zh' : 'en'];
}

/**
 * @param {string} reasonEn
 * @param {string} reasonZh
 * @param {string} lang
 */
function insufficientConclusion(key, reasonEn, reasonZh, lang) {
  const isZh = lang === 'zh';
  const marker = isZh ? '数据不足' : 'Insufficient data';
  return {
    status: 'insufficient',
    title: titleFor(key, lang),
    summary: isZh ? `${marker}——${reasonZh}` : `${marker} — ${reasonEn}`,
    evidence: [],
  };
}

/**
 * 定位转折点：优先经济逆转检测的翻转分钟；否则退回最大的单分钟经济波动
 * （幅度须达到 LEAD_FLIP_THRESHOLD，微小波动只是噪声）。无翻转时，波动
 * 必须对参照方不利：参照方是聚焦英雄所在阵营（未选聚焦时退回最终败方），
 * 败方末期的追分回升解释不了「这局为什么输」，绝不能当首要转折呈现；
 * 只有当整场没有任何达标的不利波动时，才退回达标波动中的绝对值最大者。
 * @param {object} facts
 * @param {object | null} focus 聚焦玩家（决定不利参照方）
 * @returns {{ kind: 'flip' | 'swing', minute: number, fromMinute: number, fromLeadRadiant: number, toLeadRadiant: number, loserSide: 'radiant' | 'dire', adverseTo: 'radiant' | 'dire' | null } | null}
 */
function findTurningSwing(facts, focus) {
  const adv = Array.isArray(facts?.economy?.radiantGoldAdv) ? facts.economy.radiantGoldAdv : [];
  const swing = facts?.advantageSwing;

  if (swing
    && typeof swing.crossoverMinute === 'number'
    && typeof swing.loserPeakMinute === 'number'
    && typeof swing.loserPeakLead === 'number'
    && (swing.loserSide === 'radiant' || swing.loserSide === 'dire')
    && typeof adv[swing.crossoverMinute] === 'number') {
    return {
      kind: 'flip',
      minute: swing.crossoverMinute,
      fromMinute: swing.loserPeakMinute,
      // 峰值领先是败方视角，转回天辉视角统一表述。
      fromLeadRadiant: swing.loserSide === 'radiant' ? swing.loserPeakLead : -swing.loserPeakLead,
      toLeadRadiant: adv[swing.crossoverMinute],
      loserSide: swing.loserSide,
      adverseTo: null,
    };
  }

  if (adv.length >= TURNING_POINT_MIN_ADV_MINUTES) {
    // 不利参照方：聚焦英雄所在阵营；未选聚焦时退回最终败方；两者都缺时
    // 只按绝对值选（无法判断对谁不利）。
    let refSide = null;
    const radiantWin = facts?.summary?.radiantWin;
    if (focus && typeof focus.isRadiant === 'boolean') {
      const focusSide = focus.isRadiant ? 'radiant' : 'dire';
      const enemySide = focus.isRadiant ? 'dire' : 'radiant';
      // 方向跟随聚焦方胜负：输了找对己方不利的波动，赢了找对敌方不利
      // （即对己方有利）的波动；胜负未知时按聚焦方不利处理。
      const focusWon = typeof radiantWin === 'boolean' ? focus.isRadiant === radiantWin : false;
      refSide = focusWon ? enemySide : focusSide;
    }
    else if (facts?.summary?.winner === 'radiant') refSide = 'dire';
    else if (facts?.summary?.winner === 'dire') refSide = 'radiant';

    const magnitudeAt = (minute) => Math.abs(adv[minute] - adv[minute - 1]);
    let bestAdverse = null;
    let bestOther = null;
    for (let minute = 3; minute < adv.length; minute += 1) {
      const delta = adv[minute] - adv[minute - 1];
      if (!Number.isFinite(delta) || Math.abs(delta) < LEAD_FLIP_THRESHOLD) continue;
      // 对参照方不利 = 参照方领先被压缩（天辉参照看负 delta，夜魇参照看正 delta）。
      const adverse = refSide == null || (refSide === 'radiant' ? delta < 0 : delta > 0);
      if (adverse) {
        if (!bestAdverse || magnitudeAt(minute) > magnitudeAt(bestAdverse)) bestAdverse = minute;
      } else if (!bestOther || magnitudeAt(minute) > magnitudeAt(bestOther)) bestOther = minute;
    }
    // 已知参照方时只认对其不利的波动；找不到就返回 null（数据不足），
    // 绝不拿对方的波动顶替。仅当参照方未知时才退回绝对值最大者。
    const best = refSide ? bestAdverse : (bestAdverse ?? bestOther);
    if (best != null) {
      return {
        kind: 'swing',
        minute: best,
        fromMinute: best - 1,
        fromLeadRadiant: adv[best - 1],
        toLeadRadiant: adv[best],
        // 天辉领先扩大 ⇒ 走弱的是夜魇，反之亦然。
        loserSide: adv[best] - adv[best - 1] > 0 ? 'dire' : 'radiant',
        adverseTo: bestAdverse != null ? refSide : null,
      };
    }
  }

  return null;
}

/**
 * 滚动窗口内同一队的最大阵亡数（团灭判定）。
 * @param {number[]} times 升序秒数
 * @param {number} windowSec
 */
function maxDeathsInWindow(times, windowSec = WIPE_WINDOW_SEC) {
  let best = 0;
  let start = 0;
  for (let end = 0; end < times.length; end += 1) {
    while (times[end] - times[start] > windowSec) start += 1;
    if (end - start + 1 > best) best = end - start + 1;
  }
  return best;
}

/**
 * 摆动当分钟（(minute-1, minute] 的 60 秒）内走弱一方的团灭规模：死亡时间
 * 线在该分钟内还原出 ≥ WIPE_MIN_DEATHS 人短窗阵亡才算「发生过团」。
 * 经济摆动本身只证明钱动了（补发育/推塔/买活都可能），证明不了打过团。
 * @param {Array<{ isRadiant?: boolean, deathEvents?: Array<{ time?: number }> }>} players
 * @param {{ minute: number, loserSide: 'radiant' | 'dire' }} swing
 */
function swingMinuteWipeCount(players, swing) {
  const loserIsRadiant = swing.loserSide === 'radiant';
  const start = (swing.minute - 1) * 60;
  const end = swing.minute * 60;
  const times = [];
  for (const p of players) {
    if (typeof p?.isRadiant !== 'boolean' || p.isRadiant !== loserIsRadiant) continue;
    for (const d of p.deathEvents || []) {
      if (typeof d?.time === 'number' && d.time > start && d.time <= end) times.push(d.time);
    }
  }
  times.sort((a, b) => a - b);
  return maxDeathsInWindow(times);
}

/**
 * @param {{ heroId: number, displayName?: string }[]} players
 */
function playerNameById(players) {
  const byId = new Map();
  for (const p of players) {
    if (typeof p?.heroId === 'number' && !byId.has(p.heroId)) {
      byId.set(p.heroId, p.displayName || `Hero#${p.heroId}`);
    }
  }
  return byId;
}

/**
 * 转折点结论：翻转/最大波动的时间 + 事件 + 经济摆动，窗口内的死亡时间线
 * 与时间线事件作为证据。只描述事实里有的内容（视野等不在 MatchFact 中，
 * 绝不提及）。
 */
function buildTurningPoint(facts, players, focus, lang) {
  const isZh = lang === 'zh';
  const swing = isFactObject(facts) ? findTurningSwing(facts, focus) : null;
  if (!swing) {
    return insufficientConclusion(
      'turningPoint',
      'no single minute moved the gold lead enough to mark a turning point',
      '没有哪一分钟的经济变化足以标记转折点',
      lang,
    );
  }

  const side = SIDE_LABELS[swing.loserSide][isZh ? 'zh' : 'en'];
  const names = playerNameById(players);
  const windowStart = swing.fromMinute * 60;
  // 证据窗口止于翻转/波动当秒：经济差是在当秒测得的，之后一分钟里的阵亡
  // 与事件属于下一格采样，算作它的成因即是张冠李戴。
  const windowEnd = swing.minute * 60;

  // 走弱一方的阵亡（死亡时间线还原，可能少于面板 deaths，只报已还原的）。
  const loserIsRadiant = swing.loserSide === 'radiant';
  const windowDeaths = [];
  for (const p of players) {
    if (typeof p?.isRadiant !== 'boolean' || p.isRadiant !== loserIsRadiant) continue;
    for (const d of p.deathEvents || []) {
      if (typeof d?.time === 'number' && d.time >= windowStart && d.time <= windowEnd) {
        windowDeaths.push({ time: d.time, hero: names.get(p.heroId) || `Hero#${p.heroId}`, killerHeroId: d.killerHeroId });
      }
    }
  }
  windowDeaths.sort((a, b) => a.time - b.time);

  const windowEvents = (facts.timeline || [])
    .filter((ev) => typeof ev?.time === 'number' && ev.time >= windowStart && ev.time <= windowEnd)
    .slice(0, 3);

  /** @type {Array<{ sec: number, time: string, text: string, source: string }>} */
  const leadSource = swing.kind === 'flip' ? 'advantageSwing' : 'economy';
  // 两个经济锚点必留（摆动的起止），其余证据按时间补位。
  const anchors = [
    {
      sec: windowStart,
      time: formatDuration(windowStart),
      text: isZh
        ? `天辉经济差 ${signed(swing.fromLeadRadiant)}（${swing.fromMinute} 分钟）`
        : `Radiant gold lead ${signed(swing.fromLeadRadiant)} (min ${swing.fromMinute})`,
      source: leadSource,
    },
    {
      sec: swing.minute * 60,
      time: formatDuration(swing.minute * 60),
      text: isZh
        ? `天辉经济差 ${signed(swing.toLeadRadiant)}（${swing.minute} 分钟）`
        : `Radiant gold lead ${signed(swing.toLeadRadiant)} (min ${swing.minute})`,
      source: leadSource,
    },
  ];

  /** @type {Array<{ sec: number, time: string, text: string, source: string }>} */
  const context = [];
  for (const ev of windowEvents) {
    context.push({
      sec: ev.time,
      time: formatDuration(ev.time),
      text: formatObjectiveLabel(ev, isZh ? 'zh' : 'en'),
      source: 'timeline',
    });
  }
  for (const d of windowDeaths.slice(0, 3)) {
    const killer = typeof d.killerHeroId === 'number' ? names.get(d.killerHeroId) : null;
    context.push({
      sec: d.time,
      time: formatDuration(d.time),
      text: killer
        ? (isZh ? `${d.hero} 阵亡（${killer} 击杀）` : `${d.hero} died (killed by ${killer})`)
        : (isZh ? `${d.hero} 阵亡` : `${d.hero} died`),
      source: 'deathTimeline',
    });
  }
  context.sort((a, b) => a.sec - b.sec);
  const evidence = [...anchors, ...context].slice(0, MAX_EVIDENCE_ITEMS);

  const parts = [];
  if (swing.kind === 'flip') {
    parts.push(isZh
      ? `${formatDuration(swing.minute * 60)} 经济优势易手：天辉从 ${swing.fromMinute} 分钟的 ${signed(swing.fromLeadRadiant)} 变为 ${swing.minute} 分钟的 ${signed(swing.toLeadRadiant)}。`
      : `${formatDuration(swing.minute * 60)} — the gold lead flipped: Radiant went from ${signed(swing.fromLeadRadiant)} at min ${swing.fromMinute} to ${signed(swing.toLeadRadiant)} at min ${swing.minute}.`);
  } else if (swing.adverseTo) {
    // 不利筛选生效时选中者未必是全场绝对值最大的波动，措辞按参照方表述。
    const refSide = SIDE_LABELS[swing.adverseTo][isZh ? 'zh' : 'en'];
    parts.push(isZh
      ? `${formatDuration(swing.minute * 60)} 对${refSide}最不利的一次单分钟经济波动：天辉从 ${signed(swing.fromLeadRadiant)} 变为 ${signed(swing.toLeadRadiant)}。`
      : `${formatDuration(swing.minute * 60)} — the biggest one-minute gold swing against ${refSide}: Radiant went from ${signed(swing.fromLeadRadiant)} to ${signed(swing.toLeadRadiant)}.`);
  } else {
    parts.push(isZh
      ? `${formatDuration(swing.minute * 60)} 全场最大单分钟经济波动：天辉从 ${signed(swing.fromLeadRadiant)} 变为 ${signed(swing.toLeadRadiant)}。`
      : `${formatDuration(swing.minute * 60)} — the biggest one-minute gold swing of the game: Radiant went from ${signed(swing.fromLeadRadiant)} to ${signed(swing.toLeadRadiant)}.`);
  }
  if (windowDeaths.length > 0) {
    const wipe = maxDeathsInWindow(windowDeaths.map((d) => d.time));
    const wipeClause = wipe >= WIPE_MIN_DEATHS
      ? (isZh ? `（其中 ${wipe} 次在 ${WIPE_WINDOW_SEC} 秒内）` : ` (${wipe} within ${WIPE_WINDOW_SEC}s)`)
      : '';
    parts.push(isZh
      ? `${swing.fromMinute}–${swing.minute} 分钟窗口内记录到${side} ${windowDeaths.length} 次阵亡${wipeClause}。`
      : `${windowDeaths.length} ${side} deaths were recorded in the min ${swing.fromMinute}-${swing.minute} window${wipeClause}.`);
  }
  if (focus && typeof focus.isRadiant === 'boolean') {
    const focusIsLoser = (focus.isRadiant ? 'radiant' : 'dire') === swing.loserSide;
    parts.push(isZh
      ? (focusIsLoser ? '这次摆动对你方不利。' : '这次摆动对你方有利。')
      : (focusIsLoser ? 'That swing went against your team.' : 'That swing went your team\'s way.'));
  }

  return {
    status: 'ok',
    title: titleFor('turningPoint', lang),
    summary: parts.join(isZh ? '' : ' '),
    evidence: evidence.slice(0, MAX_EVIDENCE_ITEMS).map(({ time, text, source }) => ({ time, text, source })),
  };
}

/**
 * 最大问题结论：聚焦玩家最主要的死亡模式（derivePrimaryDeathPattern），
 * 每条支撑阵亡都带时间戳证据。无聚焦英雄或死亡时间线不可用时 insufficient。
 */
function buildTopMistake(facts, focus, players, lang) {
  const isZh = lang === 'zh';
  if (!focus) {
    return insufficientConclusion(
      'topMistake',
      'no focus hero selected, so no player-specific mistake can be derived',
      '未选择聚焦英雄，无法定位属于你的最大问题',
      lang,
    );
  }

  const deaths = Array.isArray(focus.deathEvents) ? focus.deathEvents : [];
  if (!facts.deathTimelineAvailable) {
    // 用 matchFacts 保留下来的真实失败原因，不把「已解析但映射失败」说成未解析。
    const code = facts?.fieldReasons?.deaths?.reason;
    const why = DEATH_REASON_TEXT[code] || DEATH_REASON_TEXT.unknown;
    return insufficientConclusion('topMistake', why.en, why.zh, lang);
  }
  if (deaths.length < 2) {
    return insufficientConclusion(
      'topMistake',
      'fewer than two recorded deaths, so no death pattern can be derived',
      '可还原的阵亡不足两次，无法归纳死亡模式',
      lang,
    );
  }

  const pattern = derivePrimaryDeathPattern(deaths);
  if (!pattern) {
    return insufficientConclusion(
      'topMistake',
      'no repeatable pattern in the recorded deaths',
      '记录到的阵亡没有可归纳的重复模式',
      lang,
    );
  }

  const names = playerNameById(players);
  const hero = focus.displayName || `Hero#${focus.heroId}`;
  let headline;
  if (pattern.pattern === 'phase_repeat') {
    const phaseLabel = DEATH_PHASE_LABELS[pattern.phase][isZh ? 'zh' : 'en'];
    headline = isZh
      ? `${hero}的死亡模式：记录到的 ${pattern.totalDeaths} 次阵亡中有 ${pattern.events.length} 次集中在${phaseLabel}——优先回看这些时间点`
      : `${hero}'s death pattern: ${pattern.events.length} of ${pattern.totalDeaths} recorded deaths came in the ${phaseLabel} — review those timestamps first`;
  } else if (pattern.pattern === 'repeat_killer') {
    const killer = names.get(pattern.killerHeroId) || `Hero#${pattern.killerHeroId}`;
    headline = isZh
      ? `${hero}的死亡模式：${killer} 累计击杀你 ${pattern.events.length} 次（共记录 ${pattern.totalDeaths} 次阵亡）`
      : `${hero}'s death pattern: ${killer} killed you ${pattern.events.length} times of ${pattern.totalDeaths} recorded deaths`;
  } else {
    headline = isZh
      ? `${hero}的死亡模式：记录到的 ${pattern.totalDeaths} 次阵亡中有 ${pattern.events.length} 次发生在己方经济落后超过 ${LEAD_FLIP_THRESHOLD} 时`
      : `${hero}'s death pattern: ${pattern.events.length} of ${pattern.totalDeaths} recorded deaths came while your team was more than ${LEAD_FLIP_THRESHOLD} gold behind`;
  }

  /** @type {Array<{ time: string, text: string, source: string }>} */
  const evidence = pattern.events.slice(0, MAX_EVIDENCE_ITEMS).map((e) => {
    const killer = typeof e.killerHeroId === 'number' ? names.get(e.killerHeroId) : null;
    const gold = typeof e.teamGoldLeadAtT === 'number'
      ? (isZh ? `，己方经济差 ${signed(e.teamGoldLeadAtT)}` : `, team gold lead ${signed(e.teamGoldLeadAtT)}`)
      : '';
    return {
      time: formatDuration(e.time),
      text: killer
        ? (isZh ? `${hero} 阵亡（${killer} 击杀${gold}）` : `${hero} died (killed by ${killer}${gold})`)
        : (isZh ? `${hero} 阵亡${gold}` : `${hero} died${gold}`),
      source: 'deathTimeline',
    };
  });

  return {
    status: 'ok',
    title: titleFor('topMistake', lang),
    summary: isZh ? `${headline}。` : `${headline}.`,
    evidence,
  };
}

/**
 * 复刻 reviewCards.csAtMinute 的补刀查表（该函数未导出；逻辑保持一致）。
 * @param {object} player
 * @param {number} minute
 */
function csAtMinute(player, minute) {
  const buckets = player.timeBuckets || [];
  const lh = player.lhTimeline || [];
  if (!buckets.length || !lh.length) return null;
  const idx = buckets.findIndex((b) => b === minute * 60);
  if (idx < 0) return null;
  return lh[idx] ?? null;
}

/**
 * 下一局规则：只有事实能支撑时才输出。
 * - 装备规则：需要敌方阵容 + 焦点玩家的装备时间（MatchFact 目前不产出
 *   itemTimings，该分支留给未来事实；没有数据绝不建议具体出装）。
 * - 对线规则：需要基于录像的对线对位（focusLens.opponents）+ 10 分钟补刀
 *   与经济检查点。
 */
function buildNextGameRule(facts, focus, players, lang) {
  const isZh = lang === 'zh';
  if (!focus) {
    return insufficientConclusion(
      'nextGameRule',
      'no focus hero selected, so no player-specific rule can be derived',
      '未选择聚焦英雄，无法给出针对你的下一局规则',
      lang,
    );
  }

  const enemies = players.filter((p) => typeof p?.isRadiant === 'boolean' && p.isRadiant !== focus.isRadiant);
  if (enemies.length === 0) {
    return insufficientConclusion(
      'nextGameRule',
      'enemy lineup is unknown',
      '缺少敌方阵容数据',
      lang,
    );
  }

  // 装备规则：装备时间存在才有事实可依（当前 MatchFact 不含该字段）。
  const itemTimings = (Array.isArray(focus.itemTimings) ? focus.itemTimings : [])
    .filter((it) => it && typeof it.time === 'number' && typeof it.key === 'string' && it.key)
    .sort((a, b) => a.time - b.time);
  if (itemTimings.length > 0) {
    const first = itemTimings[0];
    const enemyNames = enemies.map((p) => p.displayName || `Hero#${p.heroId}`);
    const rule = isZh
      ? `面对敌方阵容（${enemyNames.join('、')}）的出装节奏：本局你最早的记录装备 ${first.key} 出现在 ${formatDuration(first.time)}。下一局面对相近阵容时，把这个时间当作该装备的到位基准——晚于它就先补状态再参团`
      : `Itemization vs this enemy lineup (${enemyNames.join(', ')}): your first tracked item (${first.key}) arrived at ${formatDuration(first.time)}. Next game against a similar lineup, treat that timing as the benchmark for when the item should be up — if you are late, delay fights until it is`;
    const evidence = itemTimings.slice(0, MAX_EVIDENCE_ITEMS - 1).map((it) => ({
      time: formatDuration(it.time),
      text: isZh ? `装备：${it.key}` : `Item: ${it.key}`,
      source: 'players',
    }));
    evidence.push({
      time: null,
      text: isZh ? `敌方阵容：${enemyNames.join('、')}` : `Enemy lineup: ${enemyNames.join(', ')}`,
      source: 'players',
    });
    return {
      status: 'ok',
      title: titleFor('nextGameRule', lang),
      summary: isZh ? `${rule}。` : `${rule}.`,
      evidence,
    };
  }

  // 对线规则：对线对位 + 10 分钟补刀/经济检查点。
  const lens = facts.focusLens;
  const opponents = Array.isArray(lens?.opponents) ? lens.opponents : [];
  const cs10 = csAtMinute(focus, 10);
  const cp10 = (facts.economy?.checkpoints || []).find((c) => c?.minute === 10);
  if (lens?.laneGrounded && opponents.length > 0 && cs10 != null && typeof cp10?.radiantGoldLead === 'number') {
    const teamGold10 = focus.isRadiant ? cp10.radiantGoldLead : -cp10.radiantGoldLead;
    const oppNames = opponents.map((o) => o.displayName || `Hero#${o.heroId}`);
    // 10 分钟经济差按领先/落后表述（负数绝不是 "lead"）；en 绝对值带千分位，
    // zh 用裸数字。数值全部来自 teamGold10 本身。
    const goldAbs = Math.abs(teamGold10);
    const goldPhrase = isZh
      ? (teamGold10 < 0 ? `我方落后 ${goldAbs} 金` : teamGold10 > 0 ? `我方领先 ${goldAbs} 金` : '双方经济持平')
      : teamGold10 < 0
        ? `your team was ${goldAbs.toLocaleString('en-US')} gold behind`
        : teamGold10 > 0
          ? `your team was ${teamGold10.toLocaleString('en-US')} gold ahead`
          : 'team gold was even';
    // 证据行与 summary 同口径：负数绝不是 "lead"，en 绝对值带千分位，zh 用裸数字。
    const goldEvidence = isZh
      ? (teamGold10 < 0 ? `10 分钟我方经济：落后 ${goldAbs}` : teamGold10 > 0 ? `10 分钟我方经济：领先 ${goldAbs}` : '10 分钟我方经济：持平')
      : teamGold10 < 0
        ? `Team gold @10 min: ${goldAbs.toLocaleString('en-US')} behind`
        : teamGold10 > 0
          ? `Team gold @10 min: ${goldAbs.toLocaleString('en-US')} ahead`
          : 'Team gold @10 min: even';
    // 下一局目标：CS 与经济是两个独立的检查点，且经济按领先/落后定向——
    // 落后是「把差距控制在 |Δ| 以内」（差距越小越好），领先是「至少领先
    // Δ」，持平是「不落后」。数字仍全部来自 cs10 / teamGold10（en 千分位，
    // zh 裸数字），绝不出现「两个数字都要高于」这类对落后方向的反向建议。
    const goldTarget = isZh
      ? (teamGold10 < 0 ? `经济落后控制在 ${goldAbs} 金以内` : teamGold10 > 0 ? `经济至少领先 ${teamGold10} 金` : '经济不落后')
      : teamGold10 < 0
        ? `keep the deficit under ${goldAbs.toLocaleString('en-US')} gold`
        : teamGold10 > 0
          ? `keep your team at least ${teamGold10.toLocaleString('en-US')} gold ahead`
          : `don't fall behind in gold`;
    const rule = isZh
      ? `对线规则——面对 ${oppNames.join('、')}：本局 10 分钟时你的补刀为 ${cs10}、${goldPhrase}。下一局面对相近的对线组合，10 分钟时补刀至少 ${cs10}，${goldTarget}；任一项没达到，就先安全补发育，不强行开打`
      : `Laning rule vs ${oppNames.join(', ')}: this game you had ${cs10} CS and ${goldPhrase} at 10 min. Next game against a similar lane, aim for at least ${cs10} CS at 10 min and ${goldTarget} — if you miss either, farm safely before forcing plays`;
    return {
      status: 'ok',
      title: titleFor('nextGameRule', lang),
      summary: isZh ? `${rule}。` : `${rule}.`,
      evidence: [
        {
          time: '10:00',
          text: isZh ? `10 分钟补刀：${cs10}` : `CS @10 min: ${cs10}`,
          source: 'players',
        },
        {
          time: '10:00',
          text: goldEvidence,
          source: 'economy',
        },
        {
          time: null,
          text: isZh ? `对线对手：${oppNames.join('、')}` : `Lane opponents: ${oppNames.join(', ')}`,
          source: 'focusLens',
        },
      ],
    };
  }

  return insufficientConclusion(
    'nextGameRule',
    'no item timings and no grounded lane-vs-enemy facts to derive a next-game rule',
    '没有装备时间数据，也没有基于录像的对线对位事实，无法给出下一局规则',
    lang,
  );
}

/**
 * 2–3 条预设追问（按可用事实裁剪：能定位到具体时间/装备/分路时插入细节，
 * 定位不到就整条省略，绝不发指代不明的空问题）。
 */
function buildFollowUps(facts, focus, players, lang) {
  const isZh = lang === 'zh';
  const swing = isFactObject(facts) ? findTurningSwing(facts, focus) : null;

  const presets = [];

  // 装备追问：有真实装备时间才问「为什么出它」；MatchFact 没有装备事实时
  // 整条省略（「为什么出这件？」指代不明，追问提示里也没有装备数据可答）。
  const itemTimings = focus && Array.isArray(focus.itemTimings)
    ? focus.itemTimings
      .filter((it) => it && typeof it.time === 'number' && typeof it.key === 'string' && it.key)
      .sort((a, b) => a.time - b.time)
    : [];
  const firstItem = itemTimings[0] || null;
  if (firstItem) {
    presets.push(isZh
      ? `${formatDuration(firstItem.time)} 为什么出 ${firstItem.key}？`
      : `Why build ${firstItem.key} at ${formatDuration(firstItem.time)}?`);
  }

  // 团战/经济追问：只有死亡时间线在摆动当分钟内还原出团灭时才称之为
  // 「那波团」；否则退回中性的经济波动问题（补发育/推塔同样会造成波动），
  // 没有摆动时退回不预设任何事件的关键节点问题。
  if (swing) {
    const label = formatDuration(swing.minute * 60);
    const focusSide = focus && typeof focus.isRadiant === 'boolean'
      ? (focus.isRadiant ? 'radiant' : 'dire')
      : null;
    if (swingMinuteWipeCount(players, swing) >= WIPE_MIN_DEATHS) {
      if (focusSide) {
        const focusIsLoser = focusSide === swing.loserSide;
        presets.push(isZh
          ? `${label} 那波团为什么${focusIsLoser ? '输' : '赢'}？`
          : `Why did we ${focusIsLoser ? 'lose' : 'win'} the fight at ${label}?`);
      } else {
        presets.push(isZh
          ? `${label} 那波团发生了什么？`
          : `What happened in the fight at ${label}?`);
      }
    } else {
      presets.push(isZh
        ? `${label} 这波经济波动是怎么来的？`
        : `What caused the gold swing at ${label}?`);
    }
  } else {
    presets.push(isZh
      ? '这局的关键节点在哪里？'
      : 'What was the decisive moment of this game?');
  }

  const lens = facts?.focusLens;
  const laneZh = focus?.laneLabelZh;
  const laneEn = focus?.laneLabelEn;
  const supportQuestion = isZh
    ? (lens?.laneGrounded && laneZh && laneZh !== '未知'
      ? `辅助${laneZh}这段该怎么站？`
      : '辅助这段该怎么站？')
    : (lens?.laneGrounded && laneEn && laneEn !== 'Unknown'
      ? `Where should support stand in the ${laneEn} lane here?`
      : 'Where should support stand here?');
  presets.push(supportQuestion);

  return presets;
}

/**
 * 聚焦英雄的胜负（事实推导）：聚焦阵营与 summary.radiantWin 对得上为
 * 'win'，反之为 'loss'；无聚焦英雄或事实里没有胜负时为 null（UI 据此
 * 决定标题按「输在哪」还是「赢在哪」呈现，绝不凭空判定）。
 * @param {object} facts
 * @param {object | null} focus
 * @returns {'win' | 'loss' | null}
 */
function focusOutcome(facts, focus) {
  const radiantWin = facts?.summary?.radiantWin;
  if (!focus || typeof focus.isRadiant !== 'boolean' || typeof radiantWin !== 'boolean') return null;
  return focus.isRadiant === radiantWin ? 'win' : 'loss';
}

/**
 * 从 MatchFact 构建三条结论 + 预设追问。
 * @param {object} facts matchFacts.buildMatchFact 的产物
 * @param {{ lang?: 'en' | 'zh' }} [opts] 默认英文
 * @returns {{
 *   outcome: 'win' | 'loss' | null,
 *   turningPoint: { status: 'ok' | 'insufficient', title: string, summary: string, evidence: Array<{ time: string | null, text: string, source: string }> },
 *   topMistake: { status: 'ok' | 'insufficient', title: string, summary: string, evidence: Array<{ time: string | null, text: string, source: string }> },
 *   nextGameRule: { status: 'ok' | 'insufficient', title: string, summary: string, evidence: Array<{ time: string | null, text: string, source: string }> },
 *   followUps: string[],
 * }}
 */
export function buildThreeConclusions(facts, opts = {}) {
  const lang = opts.lang === 'zh' ? 'zh' : 'en';
  const players = isFactObject(facts) && Array.isArray(facts.players) ? facts.players : [];
  const focus = isFactObject(facts) && facts.focusHeroId != null
    ? players.find((p) => p?.heroId === facts.focusHeroId) || null
    : null;

  return {
    outcome: focusOutcome(facts, focus),
    turningPoint: buildTurningPoint(facts, players, focus, lang),
    topMistake: isFactObject(facts)
      ? buildTopMistake(facts, focus, players, lang)
      : insufficientConclusion('topMistake', 'match facts are missing', '缺少比赛事实数据', lang),
    nextGameRule: isFactObject(facts)
      ? buildNextGameRule(facts, focus, players, lang)
      : insufficientConclusion('nextGameRule', 'match facts are missing', '缺少比赛事实数据', lang),
    followUps: buildFollowUps(isFactObject(facts) ? facts : {}, focus, players, lang),
  };
}
