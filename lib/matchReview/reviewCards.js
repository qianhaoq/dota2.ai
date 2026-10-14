import { jsonrepair } from 'jsonrepair';
import { formatObjectiveLabel } from './objectiveLabels.js';
import { formatDuration, selectTimelineForDisplay } from './matchFacts.js';

const MISTAKE_CATEGORIES = {
  fight_timing: { zh: '团战时机', en: 'Fight timing' },
  lane_outcome: { zh: '对线结果', en: 'Lane outcome' },
  economy_swing: { zh: '经济走势', en: 'Economy swing' },
  farm_route: { zh: '刷钱路线', en: 'Farm route' },
};

/**
 * primary_mistake 类别 → 必需证据（factKey 必须真实存在于证据目录，resolveEvidence 已丢弃未知 key）。
 * 同一张表同时驱动校验（evidenceSupportsCategory）与 prompt（buildPrimaryMistakeCategoryPromptTable）。
 * - fight_timing：≥1 个 timeline_*
 * - lane_outcome：≥1 个对线结果事实 cs_at_10 / gold_lead_10（lane_opponents 只说明对手是谁，可作补充但不能单独支撑）
 * - economy_swing：≥2 个不同的 gold_lead_*（走势至少需要两个检查点）
 * death_pattern 暂不开放：证据目录没有焦点玩家逐次死亡的时间/情境事实，聚合死亡数不足以支撑。
 * farm_route 无路线数据，始终不可用。
 */
const LANE_OUTCOME_KEYS = new Set(['cs_at_10', 'gold_lead_10']);
const isGoldLeadKey = (k) => typeof k === 'string' && /^gold_lead_\d+$/.test(k);
const PRIMARY_MISTAKE_EVIDENCE_RULES = {
  fight_timing: {
    test: (keys) => keys.some(isTimelineFactKey),
    zh: '至少 1 个 timeline_*',
    en: 'at least 1 timeline_*',
    available: (keys) => keys.some(isTimelineFactKey),
  },
  lane_outcome: {
    test: (keys) => keys.some((k) => LANE_OUTCOME_KEYS.has(k)),
    zh: '至少 1 个 cs_at_10 / gold_lead_10（可另附 lane_opponents）',
    en: 'at least 1 of cs_at_10 / gold_lead_10 (lane_opponents may be added)',
    available: (keys) => keys.some((k) => LANE_OUTCOME_KEYS.has(k)),
  },
  economy_swing: {
    test: (keys) => new Set(keys.filter(isGoldLeadKey)).size >= 2,
    zh: '至少 2 个不同的 gold_lead_*',
    en: 'at least 2 different gold_lead_*',
    available: (keys) => new Set(keys.filter(isGoldLeadKey)).size >= 2,
  },
};

const PHASE_LABELS = {
  lane: { zh: '对线 0–10', en: 'Lane 0–10' },
  mid: { zh: '中期 10–25', en: 'Mid 10–25' },
  late: { zh: '后期 25+', en: 'Late 25+' },
};

const LANE_PHASE_END = 10 * 60;
const MID_PHASE_END = 25 * 60;

const VALID_CATEGORIES = new Set(Object.keys(MISTAKE_CATEGORIES));
/** AI may only emit fight_timing until route/movement evidence exists. */
const AI_PRIMARY_MISTAKE_CATEGORIES = new Set(Object.keys(PRIMARY_MISTAKE_EVIDENCE_RULES));
const VALID_PHASES = new Set(['lane', 'mid', 'late']);

/**
 * @param {unknown} key
 */
function isTimelineFactKey(key) {
  return typeof key === 'string' && key.startsWith('timeline_');
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function nonEmptyString(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/**
 * @param {number} seconds
 */
export function formatTimestamp(seconds) {
  const negative = seconds < 0;
  const abs = Math.abs(seconds);
  const m = Math.floor(abs / 60);
  const s = abs % 60;
  const label = `${m}:${String(s).padStart(2, '0')}`;
  return negative ? `-${label}` : label;
}

/**
 * @param {import('../../src/types/matchReview').MatchFact | object} matchFact
 */
function getFocusPlayer(matchFact) {
  if (!matchFact.focusHeroId) return null;
  return (matchFact.players || []).find((p) => p.heroId === matchFact.focusHeroId) || null;
}

/**
 * @param {object} player
 * @param {number} [minute=10]
 */
function csAtMinute(player, minute = 10) {
  const buckets = player.timeBuckets || [];
  const lh = player.lhTimeline || [];
  if (!buckets.length || !lh.length) return null;
  const target = minute * 60;
  const idx = buckets.findIndex((b) => b === target);
  if (idx < 0) return null;
  return lh[idx] ?? null;
}

/**
 * Normalize hero slug for roster matching (spirit_breaker ↔ Spirit Breaker).
 * @param {string} value
 */
function normalizeHeroSlug(value) {
  return String(value || '')
    .replace(/^npc_dota_hero_/, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

/**
 * Map kills_log target slug to localized display name from match roster.
 * @param {string} targetSlug
 * @param {object} matchFact
 * @param {string} lang
 */
function localizeKillTarget(targetSlug, matchFact, lang) {
  const slug = normalizeHeroSlug(targetSlug);
  if (!slug) return targetSlug;

  for (const p of matchFact.players || []) {
    const aliases = [
      p.internalSlug,
      p.nameEn,
      p.nameZh,
    ].map((name) => normalizeHeroSlug(name)).filter(Boolean);
    if (aliases.includes(slug)) {
      return lang === 'zh' ? (p.nameZh || p.displayName) : (p.nameEn || p.displayName);
    }
  }
  return targetSlug;
}

/**
 * Orient radiant gold lead to the reviewed player's team perspective.
 * @param {number} radiantGoldLead
 * @param {boolean | undefined} isRadiantFocus
 */
function playerTeamGoldLead(radiantGoldLead, isRadiantFocus) {
  if (isRadiantFocus === undefined) return radiantGoldLead;
  return isRadiantFocus ? radiantGoldLead : -radiantGoldLead;
}

/**
 * @param {object} matchFact
 * @param {string} lang
 */
function buildEvidenceCatalog(matchFact, lang) {
  const isZh = lang === 'zh';
  const focus = getFocusPlayer(matchFact);
  const isRadiantFocus = focus?.isRadiant;
  const catalog = [];

  if (focus) {
    catalog.push({
      factKey: 'kda',
      label: isZh ? 'KDA' : 'KDA',
      value: `${focus.kills}/${focus.deaths}/${focus.assists}`,
    });
    catalog.push({
      factKey: 'gpm',
      label: isZh ? 'GPM' : 'GPM',
      value: String(focus.gpm),
    });
    catalog.push({
      factKey: 'deaths',
      label: isZh ? '死亡' : 'Deaths',
      value: String(focus.deaths),
    });
    const cs10 = csAtMinute(focus, 10);
    if (cs10 != null) {
      catalog.push({
        factKey: 'cs_at_10',
        label: isZh ? '10分补刀' : 'CS@10',
        value: String(cs10),
      });
    }
    if (matchFact.focusLens?.laneGrounded) {
      const opp = matchFact.focusLens.opponents.map((o) => o.displayName).join(isZh ? '、' : ', ');
      catalog.push({
        factKey: 'lane_opponents',
        label: isZh ? '对线对手' : 'Lane opponents',
        value: opp || (isZh ? '无' : 'none'),
      });
    }
  }

  for (const cp of matchFact.economy?.checkpoints || []) {
    const lead = playerTeamGoldLead(cp.radiantGoldLead, isRadiantFocus);
    const sign = lead >= 0 ? '+' : '';
    catalog.push({
      factKey: `gold_lead_${cp.minute}`,
      label: isRadiantFocus === undefined
        ? (isZh ? `${cp.minute}分经济差` : `Gold lead @${cp.minute}`)
        : (isZh ? `${cp.minute}分我方经济` : `Your team gold @${cp.minute}`),
      value: `${sign}${lead}`,
    });
  }

  const timeline = selectTimelineForDisplay(matchFact.timeline || [], 8);
  timeline.forEach((ev, idx) => {
    catalog.push({
      factKey: `timeline_${idx}`,
      label: formatTimestamp(ev.time),
      value: formatObjectiveLabel(ev, lang),
      timestamp: ev.time,
    });
  });

  return catalog;
}

/**
 * @param {Array<{ factKey: string, label?: string, value?: string }>} raw
 * @param {Array<{ factKey: string, label: string, value: string }>} catalog
 */
function resolveEvidence(raw, catalog) {
  if (!Array.isArray(raw)) return [];
  const byKey = new Map(catalog.map((e) => [e.factKey, e]));
  return raw
    .map((item) => {
      const key = item?.factKey;
      if (!key) return null;
      const known = byKey.get(key);
      if (!known) return null;
      return {
        factKey: key,
        label: known.label,
        value: known.value,
      };
    })
    .filter(Boolean);
}

/**
 * @param {Array<{ factKey?: unknown }>} evidence
 * @param {Array} catalog
 */
function bindKeyMomentTimestamp(evidence, catalog) {
  const timelineRef = (evidence || [])
    .map((e) => e?.factKey)
    .find((key) => isTimelineFactKey(key));

  if (!timelineRef) return null;
  const entry = catalog.find((c) => c.factKey === timelineRef);
  if (!entry || entry.timestamp == null) return null;
  return entry.timestamp;
}

/**
 * @param {Array<{ factKey?: string }>} evidence
 */
function hasTimelineEvidence(evidence) {
  return Array.isArray(evidence)
    && evidence.some((e) => isTimelineFactKey(e?.factKey));
}

/**
 * @param {string} category
 * @param {Array<{ factKey: string }>} evidence
 */
function evidenceSupportsCategory(category, evidence) {
  if (!evidence?.length) return false;
  const rule = PRIMARY_MISTAKE_EVIDENCE_RULES[category];
  if (!rule) return false;
  return rule.test(evidence.map((e) => e?.factKey));
}

/**
 * 本局证据目录下可满足的 primary_mistake 类别（与校验同源，驱动 prompt 表与 JSON 结构示例）。
 * @param {Array<{ factKey: string }> | null | undefined} catalog
 */
export function availablePrimaryMistakeCategories(catalog) {
  const keys = (catalog || []).map((e) => e.factKey);
  return Object.entries(PRIMARY_MISTAKE_EVIDENCE_RULES)
    .filter(([, rule]) => rule.available(keys))
    .map(([cat]) => cat);
}

/**
 * A concrete, valid primary_mistake example for the prompt's JSON shape:
 * the first satisfiable category plus the minimal evidence keys from this
 * catalog that satisfy it (so a model copying the example still validates).
 * @param {Array<{ factKey: string }> | null | undefined} catalog
 * @returns {{ category: string, evidenceKeys: string[] } | null}
 */
export function buildPrimaryMistakeExample(catalog) {
  const keys = (catalog || []).map((e) => e.factKey);
  const [category] = availablePrimaryMistakeCategories(catalog);
  if (!category) return null;
  if (category === 'fight_timing') return { category, evidenceKeys: [keys.find(isTimelineFactKey)] };
  if (category === 'lane_outcome') return { category, evidenceKeys: [keys.find((k) => LANE_OUTCOME_KEYS.has(k))] };
  return { category, evidenceKeys: [...new Set(keys.filter(isGoldLeadKey))].slice(0, 2) };
}

/**
 * @param {Array<{ factKey: string }> | null | undefined} catalog
 * @param {string} lang
 */
export function buildPrimaryMistakeCategoryPromptTable(catalog, lang = 'zh') {
  const isZh = lang === 'zh';
  const rows = availablePrimaryMistakeCategories(catalog)
    .map((cat) => [cat, PRIMARY_MISTAKE_EVIDENCE_RULES[cat]])
    .map(([cat, rule]) => `- ${cat}（${MISTAKE_CATEGORIES[cat][isZh ? 'zh' : 'en']}）: ${isZh ? rule.zh : rule.en}`);
  if (rows.length === 0) return '';
  return isZh
    ? `primary_mistake.category 只能从下表选择，evidence 必须满足该类别的必需 factKey（只能引用「可用证据字段」里列出的 key）：\n${rows.join('\n')}`
    : `primary_mistake.category must be one of the following; its evidence must satisfy that category's required factKeys (only keys listed under available evidence fields):\n${rows.join('\n')}`;
}

/**
 * 稳定的 primary_mistake 证据 key 列表（用于结构化日志，不含 PII）。
 * @param {object | null | undefined} reviewCards
 */
export function primaryMistakeLogFields(reviewCards) {
  const m = reviewCards?.primary_mistake;
  return {
    category: m?.category ?? null,
    evidenceKeys: Array.isArray(m?.evidence) ? m.evidence.map((e) => e?.factKey).filter(Boolean) : [],
  };
}

/**
 * @param {object} moment
 */
function boundTimelineFactKey(moment) {
  return (moment?.evidence || [])
    .map((e) => e?.factKey)
    .find((key) => isTimelineFactKey(key)) || null;
}

/**
 * @param {Array} moments
 * @param {number} [minCount=3]
 */
function hasDistinctKeyMoments(moments, minCount = 3) {
  if (!Array.isArray(moments) || moments.length < minCount) return false;
  const boundKeys = [];
  for (const m of moments) {
    const key = boundTimelineFactKey(m);
    if (!key) return false;
    boundKeys.push(key);
  }
  const uniqueKeys = new Set(boundKeys);
  return uniqueKeys.size === boundKeys.length && uniqueKeys.size >= minCount;
}

/**
 * @param {object | undefined} moment
 */
function isGroundedKeyMoment(moment) {
  return Boolean(
    moment
    && hasTimelineEvidence(moment.evidence)
    && typeof moment.headline === 'string'
    && moment.headline.trim()
    && typeof moment.why === 'string'
    && moment.why.trim(),
  );
}

/** Reject item/ability prescriptions not backed by MatchFact evidence. */
const DRILL_ITEM_PRESCRIPTION_RE = /羊刀|sheep\s*stick|butterfly|bkb|black\s*king\s*bar|aghanim|紫苑|orchid|manta|diffusal|绝刃|nullifier|飓风|cyclone|force\s*staff|闪烁|blink|chronosphere|rapier|divine|出.{0,6}(装|道具|item)|buy\s+[a-z]/i;

/** Reject minute-based timing rules unless anchored to a catalog timestamp label. */
const DRILL_TIMING_PRESCRIPTION_RE = /(?:\d+\s*分(?:钟|min)?前|before\s+\d+\s*(?:min|minute))/i;

/** Reject core-only lane farming prescriptions (role-neutral drills only). */
const DRILL_LANE_FARM_RE = /补刀|last\s*hit|lane\s*(?:cs|last)/i;

/** Reject ability/item action prescriptions without catalog evidence. */
const DRILL_ACTION_PRESCRIPTION_RE = /\b(cast|purchase|buy|use|activate|upgrade|stack|skill|spell|ability|ult|ultimate|itemize|farm|push|gank|roshan|ward|smoke|rush)\b|放|买|施放|购买|升级/i;

/** Exact safe mentor-note phrases per UI language (non-factual flavor only). */
const SAFE_MENTOR_NOTE_BY_LANG = {
  zh: new Set([
    '拉比克结语',
    '先看事实，再改习惯。',
  ]),
  en: new Set([
    'Rubick sign-off',
    'Facts first, habits second.',
  ]),
};

/**
 * Collect role-neutral drill steps from all buildFallbackDrill branches.
 * @param {string} lang
 */
function collectSafeDrillSteps(lang) {
  const profiles = [
    { deaths: 10, assists: 15, kills: 2, gpm: 300 },
    { deaths: 10, assists: 2, kills: 5, gpm: 400 },
    { deaths: 2, assists: 3, kills: 12, gpm: 600 },
    { deaths: 3, assists: 5, kills: 5, gpm: 450 },
  ];
  const heroNames = lang === 'zh' ? ['本局英雄', '噬魂鬼'] : ['your hero', 'Lifestealer'];
  const steps = new Set();
  for (const stats of profiles) {
    for (const heroName of heroNames) {
      const fact = {
        focusLens: { displayName: heroName },
        players: [{
          heroId: 1,
          kills: stats.kills,
          deaths: stats.deaths,
          assists: stats.assists,
          gpm: stats.gpm,
        }],
        focusHeroId: 1,
      };
      for (const step of buildFallbackDrill(fact, lang).steps) {
        steps.add(step);
      }
    }
  }
  return steps;
}

/**
 * @param {string} step
 * @param {string} lang
 */
function isSafeDrillTemplateStep(step, lang) {
  const text = typeof step === 'string' ? step.trim() : '';
  if (!text) return false;
  return collectSafeDrillSteps(lang).has(text);
}

/**
 * @param {string} step
 * @param {Array} catalog
 * @param {object} matchFact
 * @param {string} lang
 */
function isGroundedDrillStep(step, catalog, matchFact, lang) {
  const text = typeof step === 'string' ? step.trim() : '';
  if (!text) return false;
  if (DRILL_ITEM_PRESCRIPTION_RE.test(text)) return false;
  if (DRILL_LANE_FARM_RE.test(text)) return false;
  if (DRILL_ACTION_PRESCRIPTION_RE.test(text)) return false;
  if (DRILL_TIMING_PRESCRIPTION_RE.test(text)) {
    const hasCatalogTime = catalog.some((e) => e.label && text.includes(e.label));
    if (!hasCatalogTime) return false;
  }
  return isSafeDrillTemplateStep(text, lang);
}

/**
 * @param {string[]} steps
 * @param {Array} catalog
 * @param {object} matchFact
 * @param {string} lang
 */
function areGroundedDrillSteps(steps, catalog, matchFact, lang) {
  return Array.isArray(steps)
    && steps.length > 0
    && steps.every((s) => isGroundedDrillStep(s, catalog, matchFact, lang));
}

/**
 * 中性教练口吻的默认结语（不使用第一人称 Rubick 人设）。
 * @param {string} lang
 */
function defaultMentorNote(lang) {
  return lang === 'zh'
    ? '复盘基于比赛数据：先看事实，再改习惯。'
    : 'This review is grounded in match data — facts first, habits second.';
}

/**
 * 兜底卡片的结语：引用本局英雄与数据上下文，保持中性教练口吻。
 * 未解析的比赛只能说「基于基础比赛数据」，不得声称基于录像数据。
 * @param {object} matchFact
 * @param {string} lang
 */
export function buildFallbackMentorNote(matchFact, lang = 'zh') {
  const isZh = lang === 'zh';
  const lens = matchFact?.focusLens;
  const heroName = typeof lens?.displayName === 'string' ? lens.displayName.trim() : '';
  if (heroName && typeof lens?.kda === 'string') {
    const gpm = lens.gpm != null ? lens.gpm : '—';
    if (matchFact?.parsed === false) {
      return isZh
        ? `${heroName} 本场 KDA ${lens.kda}、GPM ${gpm}：复盘基于基础比赛数据（录像尚未解析），先看事实，再改习惯。`
        : `${heroName} this game: KDA ${lens.kda}, GPM ${gpm}. This review is based on basic match data (replay not parsed yet) — facts first, habits second.`;
    }
    return isZh
      ? `${heroName} 本场 KDA ${lens.kda}、GPM ${gpm}：复盘基于录像数据，先看事实，再改习惯。`
      : `${heroName} this game: KDA ${lens.kda}, GPM ${gpm}. This review is grounded in replay data — facts first, habits second.`;
  }
  return defaultMentorNote(lang);
}

/**
 * @param {string} note
 * @param {string} lang
 */
function isGroundedMentorNote(note, lang) {
  if (!note || typeof note !== 'string') return false;
  const text = note.trim();
  if (!text) return false;
  if (text === defaultMentorNote(lang)) return true;
  const safe = SAFE_MENTOR_NOTE_BY_LANG[lang === 'zh' ? 'zh' : 'en'];
  return safe?.has(text) ?? false;
}

/**
 * Collect allowlisted drill titles and durations from all buildFallbackDrill branches.
 * @param {string} lang
 */
function collectSafeDrillMetadata(lang) {
  const profiles = [
    { deaths: 10, assists: 15, kills: 2, gpm: 300 },
    { deaths: 10, assists: 2, kills: 5, gpm: 400 },
    { deaths: 2, assists: 3, kills: 12, gpm: 600 },
    { deaths: 3, assists: 5, kills: 5, gpm: 450 },
  ];
  const heroNames = lang === 'zh' ? ['本局英雄', '噬魂鬼'] : ['your hero', 'Lifestealer'];
  const titles = new Set();
  const durations = new Set();
  for (const stats of profiles) {
    for (const heroName of heroNames) {
      const fact = {
        focusLens: { displayName: heroName },
        players: [{
          heroId: 1,
          kills: stats.kills,
          deaths: stats.deaths,
          assists: stats.assists,
          gpm: stats.gpm,
        }],
        focusHeroId: 1,
      };
      const drill = buildFallbackDrill(fact, lang);
      titles.add(drill.title);
      durations.add(drill.duration);
    }
  }
  return { titles, durations };
}

/**
 * @param {string} text
 * @param {string} lang
 * @param {'title' | 'duration'} kind
 */
function isGroundedDrillMetadata(text, lang, kind) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) return false;
  const { titles, durations } = collectSafeDrillMetadata(lang);
  if (kind === 'title') return titles.has(value);
  if (kind === 'duration') return durations.has(value);
  return titles.has(value) || durations.has(value);
}

/**
 * @param {Array} catalog
 */
export function countTimelineFactsInCatalog(catalog) {
  return (catalog || []).filter((e) => e.factKey?.startsWith('timeline_')).length;
}

/**
 * @param {Array | number} catalogOrCount
 */
export function minRequiredKeyMoments(catalogOrCount) {
  const count = typeof catalogOrCount === 'number'
    ? catalogOrCount
    : countTimelineFactsInCatalog(catalogOrCount);
  if (count <= 0) return 0;
  return Math.min(3, count);
}

/**
 * AI 卡片校验（isReviewAiCardsComplete）在此证据目录下是否有可能通过：
 * 每条 key_moment 都必须引用 timeline_* 证据（primary_mistake 的类别证据见
 * PRIMARY_MISTAKE_EVIDENCE_RULES）。目录中没有 timeline_*（未解析或无 objective 的比赛）时
 * 校验不可满足——重试不可能成功，应直接使用确定性兜底。
 * @param {Array} catalog
 */
export function canReviewAiCardsValidate(catalog) {
  // Satisfiable iff some primary_mistake category has its required evidence;
  // key_moments then need min(3, timeline count) — 0 when there is no timeline.
  return availablePrimaryMistakeCategories(catalog).length > 0;
}

/**
 * Prompt line for how many distinct key_moments the model should emit.
 * @param {Array} catalog
 * @param {string} lang
 */
export function buildReviewKeyMomentsPromptRule(catalog, lang = 'zh') {
  const timelineCount = countTimelineFactsInCatalog(catalog);
  const minMoments = minRequiredKeyMoments(timelineCount);
  const maxMoments = Math.min(5, timelineCount);
  if (timelineCount === 0) {
    return lang === 'zh' ? '无 timeline 证据时可省略 key_moments' : 'omit key_moments when no timeline facts exist';
  }
  if (minMoments === maxMoments) {
    return lang === 'zh'
      ? `${minMoments} 个互不重复的关键时刻（每条引用不同 timeline_* factKey）`
      : `${minMoments} distinct key_moments (each a different timeline_* factKey)`;
  }
  return lang === 'zh'
    ? `${minMoments}–${maxMoments} 个互不重复的关键时刻（每条引用不同 timeline_* factKey）`
    : `${minMoments}–${maxMoments} distinct key_moments (each a different timeline_* factKey)`;
}

/**
 * @param {object | undefined} drill
 */
export function isValidReviewDrill(drill) {
  return Boolean(
    drill
    && typeof drill.duration === 'string'
    && drill.duration.trim()
    && typeof drill.title === 'string'
    && drill.title.trim()
    && Array.isArray(drill.steps)
    && drill.steps.length > 0,
  );
}

/**
 * @param {object} reviewCards
 * @param {{ minKeyMoments?: number }} [opts]
 */
export function isReviewAiCardsComplete(reviewCards, opts = {}) {
  const mistake = reviewCards?.primary_mistake;
  const mistakeGrounded = Boolean(
    mistake
    && Array.isArray(mistake.evidence)
    && mistake.evidence.length >= 1
    && typeof mistake.headline === 'string'
    && mistake.headline.trim()
    && typeof mistake.explanation === 'string'
    && mistake.explanation.trim()
    && evidenceSupportsCategory(mistake.category, mistake.evidence),
  );
  const minMoments = opts.minKeyMoments ?? 3;
  const moments = reviewCards?.key_moments || [];
  const momentsGrounded = minMoments === 0
    ? true
    : (moments.length >= minMoments
      && moments.every(isGroundedKeyMoment)
      && hasDistinctKeyMoments(moments, minMoments));
  return Boolean(
    mistakeGrounded
    && momentsGrounded
    && isValidReviewDrill(reviewCards.drill),
  );
}

/**
 * 校验失败原因的稳定代码（用于日志：matchId + reason，不含 PII/密钥）。
 * @param {object | null | undefined} reviewCards
 * @param {{ minKeyMoments?: number }} [opts]
 * @returns {'ok' | 'primary_mistake_not_grounded' | 'key_moments_not_grounded' | 'drill_invalid'}
 */
export function describeReviewCardsInvalidReason(reviewCards, opts = {}) {
  const mistake = reviewCards?.primary_mistake;
  const mistakeGrounded = Boolean(
    mistake
    && Array.isArray(mistake.evidence)
    && mistake.evidence.length >= 1
    && nonEmptyString(mistake.headline)
    && nonEmptyString(mistake.explanation)
    && evidenceSupportsCategory(mistake.category, mistake.evidence),
  );
  if (!mistakeGrounded) return 'primary_mistake_not_grounded';

  const minMoments = opts.minKeyMoments ?? 3;
  const moments = reviewCards?.key_moments || [];
  const momentsGrounded = minMoments === 0
    ? true
    : (moments.length >= minMoments
      && moments.every(isGroundedKeyMoment)
      && hasDistinctKeyMoments(moments, minMoments));
  if (!momentsGrounded) return 'key_moments_not_grounded';

  if (!isValidReviewDrill(reviewCards.drill)) return 'drill_invalid';
  return 'ok';
}

/**
 * @param {object} matchFact
 * @param {string} lang
 */
export function buildDeterministicReviewCards(matchFact, lang = 'zh') {
  const isZh = lang === 'zh';
  const focus = getFocusPlayer(matchFact);
  const lens = matchFact.focusLens;
  const isRadiant = focus?.isRadiant;
  const won = focus
    ? (isRadiant ? matchFact.summary.radiantWin : !matchFact.summary.radiantWin)
    : undefined;

  const match_summary = {
    matchId: matchFact.summary.matchId,
    heroId: matchFact.focusHeroId ?? undefined,
    durationFormatted: matchFact.summary.durationFormatted,
    heroName: lens?.displayName || (isZh ? (focus ? '本局英雄' : '全场复盘') : (focus ? 'Your hero' : 'Match review')),
    ...(focus ? {
      kda: lens?.kda || `${focus.kills}/${focus.deaths}/${focus.assists}`,
      gpm: lens?.gpm ?? focus.gpm,
    } : {}),
    result: won === undefined ? 'neutral' : (won ? 'win' : 'loss'),
    resultLabel: won === undefined
      ? (isZh ? matchFact.summary.winnerLabelZh : matchFact.summary.winnerLabelEn)
      : (won
        ? (isZh ? '胜利' : 'Victory')
        : (isZh ? '失败' : 'Defeat')),
    laneLabel: lens?.laneLabel,
    laneGrounded: lens?.laneGrounded,
  };

  const catalog = buildEvidenceCatalog(matchFact, lang);
  const phases = buildPhaseSpine(matchFact, lang, catalog);

  return { match_summary, phases, _catalog: catalog };
}

/**
 * @param {object} matchFact
 * @param {string} lang
 * @param {Array} catalog
 */
function buildPhaseSpine(matchFact, lang, catalog) {
  const isZh = lang === 'zh';
  const focus = getFocusPlayer(matchFact);
  const lens = matchFact.focusLens;
  const duration = matchFact.summary?.duration ?? 0;
  const phases = [];

  const laneEvidence = [];
  const cs10 = focus ? csAtMinute(focus, 10) : null;
  if (cs10 != null) {
    const ev = catalog.find((e) => e.factKey === 'cs_at_10');
    if (ev) laneEvidence.push(ev);
  }
  if (lens?.laneGrounded) {
    const ev = catalog.find((e) => e.factKey === 'lane_opponents');
    if (ev) laneEvidence.push(ev);
  }
  const gold10 = catalog.find((e) => e.factKey === 'gold_lead_10');
  if (gold10) laneEvidence.push(gold10);

  let laneInsight = isZh ? '对线期数据有限。' : 'Limited laning data.';
  if (lens?.laneGrounded && cs10 != null) {
    laneInsight = isZh
      ? `${lens.displayName} 在 ${lens.laneLabel}，10 分 ${cs10} 刀${lens.opponents.length ? `，对线 ${lens.opponents.map((o) => o.displayName).join('、')}` : ''}。`
      : `${lens.displayName} on ${lens.laneLabel}, ${cs10} CS@10${lens.opponents.length ? `, vs ${lens.opponents.map((o) => o.displayName).join(', ')}` : ''}.`;
  }

  phases.push({
    phase: 'lane',
    label: PHASE_LABELS.lane[isZh ? 'zh' : 'en'],
    insight: laneInsight,
    evidence: laneEvidence,
  });

  const midEvidence = [];
  const gold20 = catalog.find((e) => e.factKey === 'gold_lead_20');
  if (gold20) midEvidence.push(gold20);

  const midKills = (focus?.killsLog || [])
    .filter((k) => k.time >= LANE_PHASE_END && k.time < MID_PHASE_END)
    .slice(0, 2);
  midKills.forEach((k, i) => {
    midEvidence.push({
      factKey: `mid_kill_${i}`,
      label: formatTimestamp(k.time),
      value: localizeKillTarget(k.target, matchFact, lang),
    });
  });

  if (duration >= LANE_PHASE_END) {
    const midInsight = isZh
      ? (gold20
        ? (focus
          ? `10–25 分我方经济 ${gold20.value}，关注中期节奏与地图控制。`
          : `10–25 分经济差 ${gold20.value}（天辉视角），关注中期节奏与地图控制。`)
        : '中期关注抱团节奏与视野。')
      : (gold20
        ? (focus
          ? `Mid game your-team gold ${gold20.value} — watch tempo and map control.`
          : `Mid game gold lead ${gold20.value} (Radiant perspective) — watch tempo and map control.`)
        : 'Mid game: focus on tempo and vision.');

    phases.push({
      phase: 'mid',
      label: PHASE_LABELS.mid[isZh ? 'zh' : 'en'],
      insight: midInsight,
      evidence: midEvidence,
    });
  } else {
    phases.push({
      phase: 'mid',
      label: PHASE_LABELS.mid[isZh ? 'zh' : 'en'],
      insight: isZh
        ? `比赛在 ${matchFact.summary.durationFormatted} 结束，未进入典型中期阶段（10–25 分）。`
        : `Match ended at ${matchFact.summary.durationFormatted} before a typical mid game (10–25 min).`,
      evidence: [],
    });
  }

  if (duration >= MID_PHASE_END) {
    const lateEvidence = [];
    const gold30 = catalog.find((e) => e.factKey === 'gold_lead_30');
    if (gold30) lateEvidence.push(gold30);

    const lateInsight = gold30
      ? (isZh
        ? `比赛进入后期（25 分+），以下为后期经济数据。`
        : `Late game (25+ min): see economy evidence below.`)
      : (isZh
        ? `比赛进入后期（25 分+），本局无 30 分钟经济检查点数据。`
        : `Late game (25+ min): no 30-minute economy checkpoint in MatchFact.`);

    phases.push({
      phase: 'late',
      label: PHASE_LABELS.late[isZh ? 'zh' : 'en'],
      insight: lateInsight,
      evidence: lateEvidence,
    });
  } else {
    phases.push({
      phase: 'late',
      label: PHASE_LABELS.late[isZh ? 'zh' : 'en'],
      insight: isZh
        ? `比赛在 ${matchFact.summary.durationFormatted} 结束，未进入典型后期阶段。`
        : `Match ended at ${matchFact.summary.durationFormatted} before a typical late game.`,
      evidence: [],
    });
  }

  return phases;
}

/**
 * @param {string} text
 */
export function extractJsonFromLlmOutput(text) {
  if (!text?.trim()) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : text.trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const slice = candidate.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch {
      // Observed on 9035042364 replays: the model closes the root object
      // early (followups nested/closed wrong, then a stray `}`), or prints a
      // corrected copy after a note. Prefer a balanced top-level object that
      // carries review fields; then fall back to syntax-only repair. Either
      // way the result still goes through strict evidence validation.
      const objects = balancedTopLevelObjects(candidate)
        .map((src) => { try { return JSON.parse(src); } catch { return null; } })
        .filter((o) => o && typeof o === 'object' && !Array.isArray(o));
      const withFields = objects.filter((o) => o.primary_mistake || o.key_moments);
      if (withFields.length) {
        // Ties go to the later object (a corrected copy printed after a note).
        return withFields.reduce((best, o) => (Object.keys(o).length >= Object.keys(best).length ? o : best));
      }
      try {
        const repaired = JSON.parse(jsonrepair(slice));
        return repaired && typeof repaired === 'object' && !Array.isArray(repaired) ? repaired : null;
      } catch {
        return null;
      }
    }
  }
}

/**
 * Top-level `{...}` spans with balanced braces (string/escape aware).
 * @param {string} text
 * @returns {string[]}
 */
function balancedTopLevelObjects(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { if (depth > 0) inString = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth += 1; } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) { out.push(text.slice(start, i + 1)); start = -1; }
    }
  }
  return out;
}

/**
 * @param {object} raw
 * @param {string} lang
 * @param {Array} catalog
 * @param {number} matchDuration
 * @param {object} matchFact
 */
function normalizeAiCards(raw, lang, catalog, matchDuration, matchFact) {
  const isZh = lang === 'zh';
  if (!raw || typeof raw !== 'object') return {};

  const rawCategory = raw.primary_mistake?.category;
  const primary_mistake = raw.primary_mistake && AI_PRIMARY_MISTAKE_CATEGORIES.has(rawCategory)
    ? (() => {
      const headline = nonEmptyString(raw.primary_mistake.headline);
      const explanation = nonEmptyString(raw.primary_mistake.explanation);
      const evidence = resolveEvidence(raw.primary_mistake.evidence, catalog);
      if (!headline || !explanation || evidence.length === 0) return undefined;
      if (!evidenceSupportsCategory(rawCategory, evidence)) return undefined;
      return {
        category: rawCategory,
        categoryLabel: MISTAKE_CATEGORIES[rawCategory][isZh ? 'zh' : 'en'],
        headline,
        explanation,
        evidence,
      };
    })()
    : undefined;

  const key_moments = Array.isArray(raw.key_moments)
    ? (() => {
      const seenTimelineKeys = new Set();
      return raw.key_moments
        .map((m) => {
          if (!m) return null;
          const evidence = resolveEvidence(m.evidence, catalog);
          if (evidence.length === 0 || !hasTimelineEvidence(evidence)) return null;
          const timestamp = bindKeyMomentTimestamp(evidence, catalog);
          if (timestamp == null) return null;
          const boundKey = boundTimelineFactKey({ evidence });
          if (!boundKey || seenTimelineKeys.has(boundKey)) return null;
          seenTimelineKeys.add(boundKey);
          const catalogEntry = boundKey ? catalog.find((c) => c.factKey === boundKey) : null;
          const headline = catalogEntry?.value;
          if (!headline) return null;
          const why = isZh
            ? '该节点改变了地图压力或经济节奏。'
            : 'This swing shifted map pressure or economy.';
          const phase = VALID_PHASES.has(m.phase) ? m.phase : (
            timestamp < LANE_PHASE_END ? 'lane' : timestamp < MID_PHASE_END ? 'mid' : 'late'
          );
          return {
            timestamp,
            timestampLabel: catalogEntry.label,
            phase,
            headline,
            why,
            evidence,
          };
        })
        .filter(Boolean)
        .slice(0, 5);
    })()
    : undefined;

  const drill = raw.drill ? (() => {
    const duration = nonEmptyString(raw.drill.duration) || (isZh ? '15 分钟' : '15 min');
    const title = nonEmptyString(raw.drill.title);
    const steps = Array.isArray(raw.drill.steps)
      ? raw.drill.steps
        .filter((s) => typeof s === 'string' && s.trim())
        .map((s) => s.trim())
        .slice(0, 4)
      : [];
    if (!title || steps.length === 0) return undefined;
    const fallbackDrill = buildFallbackDrill(matchFact, lang);
    if (!areGroundedDrillSteps(steps, catalog, matchFact, lang)) {
      return fallbackDrill;
    }
    if (!isGroundedDrillMetadata(title, lang, 'title') || !isGroundedDrillMetadata(duration, lang, 'duration')) {
      return {
        duration: fallbackDrill.duration,
        title: fallbackDrill.title,
        steps,
      };
    }
    return { duration, title, steps };
  })() : undefined;

  const followups = normalizeFollowups(raw.followups, lang, key_moments, catalog);

  const rawNote = typeof raw.mentor_note === 'string' ? raw.mentor_note.trim() : '';
  const mentor_note = rawNote
    ? (isGroundedMentorNote(rawNote, lang) ? rawNote : defaultMentorNote(lang))
    : undefined;

  return { primary_mistake, key_moments, drill, followups, mentor_note };
}

/**
 * @param {string} lang
 * @param {Array<{ factKey: string; label?: string; value?: string }>} [catalog]
 */
function factBoundEconomyFollowup(lang, catalog = []) {
  const gold20 = catalog.find((e) => e.factKey === 'gold_lead_20');
  if (gold20) {
    return lang === 'zh'
      ? `${gold20.label}（${gold20.value}）对本局节奏意味着什么？`
      : `What did ${gold20.label} (${gold20.value}) mean for this game's tempo?`;
  }
  const anyGold = catalog.find((e) => e.factKey?.startsWith('gold_lead_'));
  if (anyGold) {
    return lang === 'zh'
      ? `${anyGold.label}（${anyGold.value}）对本局节奏意味着什么？`
      : `What did ${anyGold.label} (${anyGold.value}) mean for this game's tempo?`;
  }
  const gpm = catalog.find((e) => e.factKey === 'gpm');
  if (gpm) {
    return lang === 'zh'
      ? `GPM ${gpm.value} 是否匹配本局走势？`
      : `Did GPM ${gpm.value} match how this game played out?`;
  }
  return null;
}

/**
 * @param {string} lang
 * @param {Array<{ factKey: string; label?: string; value?: string }>} [catalog]
 */
function factBoundKdaFollowup(lang, catalog = []) {
  const kda = catalog.find((e) => e.factKey === 'kda');
  if (!kda) return null;
  return lang === 'zh'
    ? `KDA ${kda.value} 反映了什么局面选择？`
    : `What did KDA ${kda.value} say about decision-making?`;
}

/**
 * @param {string} lang
 * @param {Array<{ timestampLabel?: string; timestamp?: number; headline?: string }>} [keyMoments]
 * @param {Array<{ factKey: string; label?: string; value?: string }>} [catalog]
 */
function secondDefaultFollowup(lang, keyMoments = [], catalog = []) {
  const second = Array.isArray(keyMoments) && keyMoments.length > 1 ? keyMoments[1] : null;
  if (second) {
    const ts = second.timestampLabel
      || (second.timestamp != null ? formatTimestamp(second.timestamp) : null);
    const headline = second.headline?.trim();
    if (ts && headline) {
      return lang === 'zh'
        ? `展开 ${ts} 节点：${headline}`
        : `Break down ${ts}: ${headline}`;
    }
  }
  return factBoundEconomyFollowup(lang, catalog) || factBoundKdaFollowup(lang, catalog);
}

/**
 * @param {string} lang
 * @param {Array<{ timestampLabel?: string; timestamp?: number; headline?: string }>} [keyMoments]
 * @param {Array<{ factKey: string; label?: string; value?: string }>} [catalog]
 */
function defaultFollowups(lang, keyMoments = [], catalog = []) {
  const first = Array.isArray(keyMoments) && keyMoments.length > 0 ? keyMoments[0] : null;
  const ts = first?.timestampLabel
    || (first?.timestamp != null ? formatTimestamp(first.timestamp) : null);
  const headline = first?.headline?.trim() || '';
  const hasTimelineMoment = Boolean(ts && headline);
  const practiceChip = lang === 'zh' ? '下一局只练一件事' : 'One thing to practice next';

  if (!hasTimelineMoment) {
    const chips = [];
    const economyChip = factBoundEconomyFollowup(lang, catalog);
    if (economyChip) chips.push(economyChip);
    const kdaChip = factBoundKdaFollowup(lang, catalog);
    if (kdaChip && !chips.includes(kdaChip)) chips.push(kdaChip);
    if (chips.length === 0) return [practiceChip];
    chips.push(practiceChip);
    return chips;
  }

  const fightChip = lang === 'zh'
    ? `展开 ${ts} 节点：${headline}`
    : `Break down ${ts}: ${headline}`;
  const chips = [fightChip];
  const economyChip = secondDefaultFollowup(lang, keyMoments, catalog);
  if (economyChip) chips.push(economyChip);
  chips.push(practiceChip);
  return chips;
}

/**
 * @param {unknown} rawFollowups
 * @param {string} lang
 * @param {Array<{ timestampLabel?: string; timestamp?: number; headline?: string }> | undefined} keyMoments
 * @param {Array<{ factKey: string; label?: string; value?: string }>} catalog
 */
function normalizeFollowups(rawFollowups, lang, keyMoments, catalog = []) {
  const defaults = defaultFollowups(lang, keyMoments, catalog);
  const slotCount = Math.min(3, defaults.length);
  if (!Array.isArray(rawFollowups) || rawFollowups.length === 0) {
    return defaults;
  }
  const mapped = rawFollowups
    .map((f) => (typeof f === 'string' ? f.trim() : ''))
    .filter(Boolean)
    .slice(0, slotCount);
  for (let i = 0; i < slotCount; i++) {
    if (mapped[i] !== defaults[i]) {
      mapped[i] = defaults[i];
    }
  }
  while (mapped.length < slotCount) mapped.push(defaults[mapped.length]);
  return mapped.slice(0, slotCount);
}

/**
 * @param {object} deterministic
 * @param {object} ai
 */
export function mergeReviewCards(deterministic, ai) {
  const { _catalog, ...base } = deterministic;
  return {
    ...base,
    ...ai,
    match_summary: base.match_summary,
    phases: base.phases,
  };
}

/**
 * @param {string} text
 * @param {object} matchFact
 * @param {string} lang
 */
export function parseAiReviewCards(text, matchFact, lang = 'zh') {
  const deterministic = buildDeterministicReviewCards(matchFact, lang);
  const catalog = deterministic._catalog || buildEvidenceCatalog(matchFact, lang);
  const raw = extractJsonFromLlmOutput(text);
  const matchDuration = matchFact.summary?.duration ?? 0;
  const ai = normalizeAiCards(raw, lang, catalog, matchDuration, matchFact);
  return mergeReviewCards(deterministic, ai);
}

/**
 * Build key moments from catalog timeline entries so factKey/headline/evidence align.
 * @param {Array} catalog
 * @param {string} lang
 * @param {number} [maxMoments=4]
 */
function buildKeyMomentsFromTimeline(catalog, lang, maxMoments = 4) {
  const isZh = lang === 'zh';
  return catalog
    .filter((e) => e.factKey.startsWith('timeline_') && e.timestamp != null)
    .slice(0, maxMoments)
    .map((entry) => {
      const timestamp = entry.timestamp;
      const phase = timestamp < LANE_PHASE_END ? 'lane' : timestamp < MID_PHASE_END ? 'mid' : 'late';
      return {
        timestamp,
        timestampLabel: entry.label,
        phase,
        headline: entry.value,
        why: isZh ? '该节点改变了地图压力或经济节奏。' : 'This swing shifted map pressure or economy.',
        evidence: [{ factKey: entry.factKey, label: entry.label, value: entry.value }],
      };
    });
}

/**
 * 在花名册中按 kills_log 目标 slug 找到受害者。
 * @param {string} targetSlug
 * @param {object} matchFact
 */
function findVictimByKillTarget(targetSlug, matchFact) {
  const slug = normalizeHeroSlug(targetSlug);
  if (!slug) return null;
  for (const p of matchFact.players || []) {
    const aliases = [p.internalSlug, p.nameEn, p.nameZh]
      .map((name) => normalizeHeroSlug(name))
      .filter(Boolean);
    if (aliases.includes(slug)) return p;
  }
  return null;
}

/**
 * 聚焦英雄的击杀/阵亡节点（来自解析后的 kills_log）。
 * @param {object} matchFact
 * @param {string} lang
 */
function buildFocusHeroEvents(matchFact, lang) {
  const focus = getFocusPlayer(matchFact);
  if (!focus) return [];
  const isZh = lang === 'zh';
  const events = [];

  for (const k of focus.killsLog || []) {
    if (k.time == null) continue;
    const target = localizeKillTarget(k.target, matchFact, lang);
    events.push({
      time: k.time,
      kind: 'hero_kill',
      headline: isZh ? `击杀 ${target}` : `Killed ${target}`,
      why: isZh
        ? '本英雄的击杀节点：回看进场时机与目标选择。'
        : 'A kill by your hero: review engage timing and target selection.',
    });
  }

  for (const p of matchFact.players || []) {
    if (p.heroId === focus.heroId) continue;
    for (const k of p.killsLog || []) {
      if (k.time == null) continue;
      const victim = findVictimByKillTarget(k.target, matchFact);
      if (!victim || victim.heroId !== focus.heroId) continue;
      events.push({
        time: k.time,
        kind: 'hero_death',
        headline: isZh ? `阵亡（被 ${p.displayName} 击杀）` : `Died (killed by ${p.displayName})`,
        why: isZh
          ? '本英雄的阵亡节点：回看当时的视野、人数与站位信息。'
          : 'A death of your hero: check vision, numbers, and positioning at this time.',
      });
    }
  }

  // 同一时间同类事件去重（多来源 kills_log 可能重复记录）。
  const seen = new Set();
  return events
    .sort((a, b) => a.time - b.time)
    .filter((ev) => {
      const key = `${ev.kind}@${ev.time}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * 从 radiant_gold_adv 每分钟差分中找最大的经济波动节点。
 * @param {object} matchFact
 * @param {string} lang
 * @param {number} [maxSwings=2]
 */
function buildGoldSwingEvents(matchFact, lang, maxSwings = 2) {
  const adv = matchFact.economy?.radiantGoldAdv || [];
  if (!Array.isArray(adv) || adv.length < 2) return [];
  const isZh = lang === 'zh';
  const focus = getFocusPlayer(matchFact);
  const isRadiant = focus?.isRadiant;

  const deltas = [];
  for (let minute = 3; minute < adv.length; minute++) {
    const delta = adv[minute] - adv[minute - 1];
    if (Number.isFinite(delta)) deltas.push({ minute, delta });
  }
  deltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return deltas
    .slice(0, maxSwings)
    .map(({ minute, delta }) => {
      const oriented = isRadiant === undefined ? delta : (isRadiant ? delta : -delta);
      const sign = oriented >= 0 ? '+' : '';
      return {
        time: minute * 60,
        kind: 'gold_swing',
        headline: isZh
          ? `第 ${minute} 分钟经济波动 ${sign}${oriented}`
          : `Gold swing ${sign}${oriented} at ${minute} min`,
        why: isZh
          ? '这一分钟出现了明显的经济走势变化。'
          : 'A notable gold-lead swing happened this minute.',
      };
    })
    .sort((a, b) => a.time - b.time);
}

/**
 * 兜底关键时刻：优先使用 catalog 中的 objective 时间线；
 * 不足时用聚焦英雄的击杀/阵亡节点与经济波动补齐（确定性，无 AI）。
 * @param {object} matchFact
 * @param {Array} catalog
 * @param {string} lang
 * @param {number} [maxMoments=4]
 */
export function buildFallbackKeyMoments(matchFact, catalog, lang = 'zh', maxMoments = 4) {
  const moments = buildKeyMomentsFromTimeline(catalog, lang, maxMoments);
  if (moments.length >= maxMoments) return moments;

  const filler = [
    ...buildFocusHeroEvents(matchFact, lang),
    ...buildGoldSwingEvents(matchFact, lang),
  ].sort((a, b) => a.time - b.time);

  const fillerCounters = {};
  for (const ev of filler) {
    if (moments.length >= maxMoments) break;
    fillerCounters[ev.kind] = (fillerCounters[ev.kind] || 0) + 1;
    const label = formatTimestamp(ev.time);
    moments.push({
      timestamp: ev.time,
      timestampLabel: label,
      phase: ev.time < LANE_PHASE_END ? 'lane' : ev.time < MID_PHASE_END ? 'mid' : 'late',
      headline: ev.headline,
      why: ev.why,
      evidence: [{ factKey: `${ev.kind}_${fillerCounters[ev.kind] - 1}`, label, value: ev.headline }],
    });
  }
  return moments;
}

/**
 * Role-neutral or hero-context drill steps (no core-only lane CS prescriptions).
 * @param {object} matchFact
 * @param {string} lang
 */
function buildFallbackDrill(matchFact, lang) {
  const isZh = lang === 'zh';
  const focus = getFocusPlayer(matchFact);
  const deaths = focus?.deaths ?? 0;
  const assists = focus?.assists ?? 0;
  const kills = focus?.kills ?? 0;
  const gpm = focus?.gpm ?? 0;
  const heroName = matchFact.focusLens?.displayName || (isZh ? '本局英雄' : 'your hero');

  const supportLean = assists >= 10 && assists >= kills;
  const highDeaths = deaths >= 6;
  const farmLean = gpm >= 520 && kills >= assists;

  if (highDeaths) {
    return {
      duration: isZh ? '15 分钟' : '15 min',
      title: isZh ? '下一局：减少无谓死亡' : 'Next game: cut avoidable deaths',
      steps: isZh
        ? [
          `用 ${heroName} 打一局，每次死亡后回想：视野、人数或站位哪一项缺失？`,
          '团战前先确认撤退路线，不追第二个目标',
          '只练一件事：能不打就不打，信息不足时撤退',
        ]
        : [
          `Play one game as ${heroName}; after each death ask: vision, numbers, or position?`,
          'Before fights, confirm an exit — do not chase a second target',
          'One focus: disengage when information is incomplete',
        ],
    };
  }

  if (supportLean) {
    return {
      duration: isZh ? '15 分钟' : '15 min',
      title: isZh ? '下一局：地图信息与团队节奏' : 'Next game: map info and team tempo',
      steps: isZh
        ? [
          '关键路口放一次安全眼或扫一次关键区域（有数据支撑再做）',
          '参团前先确认队友位置，不单人先手',
          '助攻后立刻标记下一目标：推线、占视野或撤退',
        ]
        : [
          'Place one safe ward or sweep a critical area when justified',
          'Confirm teammates before engaging — no solo initiations',
          'After an assist, call the next objective: push, vision, or reset',
        ],
    };
  }

  if (farmLean) {
    return {
      duration: isZh ? '15 分钟' : '15 min',
      title: isZh ? '下一局：刷打节奏切换' : 'Next game: farm-fight tempo',
      steps: isZh
        ? [
          '经济领先时只打有视野的团，落后时先收安全线',
          '每次参团前问自己：这波打赢能拿什么建筑或肉山？',
          '死亡后检查：是贪线、贪野还是错误接团',
        ]
        : [
          'When ahead, fight only with vision; when behind, take safe farm',
          'Before each fight: what building or Roshan does winning secure?',
          'After deaths, check: greedy lane, jungle, or bad fight call',
        ],
    };
  }

  return {
    duration: isZh ? '15 分钟' : '15 min',
    title: isZh ? '下一局只练一件事' : 'One drill for next game',
    steps: isZh
      ? [
        '每局只选一个改进点：进场、撤退或技能目标',
        '死亡后 10 秒内默念：当时信息够吗？（视野、人数、技能）',
        '关键团战前问：这波输赢取决于什么？',
      ]
      : [
        'Pick one improvement: engage timing, disengage, or spell target',
        'Within 10s of dying, ask: did I have enough info (vision, numbers, spells)?',
        'Before key fights: what single factor decides win or loss?',
      ],
  };
}

/**
 * @param {object} matchFact
 * @param {string} lang
 * @param {{ includeFollowups?: boolean }} [opts]
 */
export function buildFallbackAiCards(matchFact, lang = 'zh', opts = {}) {
  const isZh = lang === 'zh';
  const includeFollowups = opts.includeFollowups !== false;
  const deterministic = buildDeterministicReviewCards(matchFact, lang);
  const catalog = deterministic._catalog || [];
  const lens = matchFact.focusLens;
  const focus = getFocusPlayer(matchFact);

  const key_moments = buildFallbackKeyMoments(matchFact, catalog, lang, 4);

  const deaths = focus?.deaths ?? 0;
  const gpm = focus?.gpm ?? lens?.gpm ?? '—';
  const category = 'fight_timing';
  const timelineKey = key_moments[0]?.evidence?.[0]?.factKey
    || catalog.find((e) => e.factKey.startsWith('timeline_'))?.factKey;
  const mistakeEvidence = timelineKey
    ? resolveEvidence([{ factKey: timelineKey }], catalog)
    : [];
  const canPrimaryMistake = timelineKey
    && evidenceSupportsCategory('fight_timing', mistakeEvidence);

  const ai = {
    ...(canPrimaryMistake ? {
      primary_mistake: {
        category,
        categoryLabel: MISTAKE_CATEGORIES[category][isZh ? 'zh' : 'en'],
        headline: isZh
          ? '按关键节点复盘团战与经济节奏'
          : 'Review fight tempo and economy at key moments',
        explanation: isZh
          ? (focus
            ? `仅陈述 MatchFact：${lens?.displayName || '英雄'} KDA ${lens?.kda || '—'}，死亡 ${deaths} 次，GPM ${gpm}。具体转折点见下方时间戳，不做未证实的因果推断。`
            : '按下方时间戳节点复盘团战与经济节奏，不做未证实的因果推断。')
          : (focus
            ? `MatchFact only: ${lens?.displayName || 'hero'} KDA ${lens?.kda || '—'}, ${deaths} deaths, GPM ${gpm}. Turning points are listed below; no unsupported causal claims.`
            : 'Review fight tempo at the timeline nodes below; no unsupported causal claims.'),
        evidence: mistakeEvidence,
      },
    } : {}),
    key_moments,
    drill: buildFallbackDrill(matchFact, lang),
    followups: includeFollowups ? defaultFollowups(lang, key_moments, catalog) : [],
    mentor_note: buildFallbackMentorNote(matchFact, isZh ? 'zh' : 'en'),
  };

  return mergeReviewCards(deterministic, ai);
}

/**
 * @param {object} matchFact
 * @param {string} lang
 */
export function buildReviewCardsPromptFacts(matchFact, lang = 'zh') {
  const catalog = buildEvidenceCatalog(matchFact, lang);
  const isZh = lang === 'zh';
  const keys = catalog.map((e) => `- ${e.factKey}: ${e.label} = ${e.value}`).join('\n');
  return isZh
    ? `可用证据字段（evidence 必须引用 factKey）：\n${keys}`
    : `Available evidence fields (evidence must use factKey):\n${keys}`;
}

export { MISTAKE_CATEGORIES, PRIMARY_MISTAKE_EVIDENCE_RULES, PHASE_LABELS, localizeKillTarget, resolveEvidence, buildKeyMomentsFromTimeline, hasDistinctKeyMoments, isGroundedKeyMoment, isGroundedDrillStep, areGroundedDrillSteps, isSafeDrillTemplateStep, isGroundedDrillMetadata, isGroundedMentorNote, defaultMentorNote, buildFallbackDrill, evidenceSupportsCategory, boundTimelineFactKey };
