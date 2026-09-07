import { formatObjectiveLabel } from './objectiveLabels.js';
import { formatDuration, selectTimelineForDisplay } from './matchFacts.js';

const MISTAKE_CATEGORIES = {
  fight_timing: { zh: '团战时机', en: 'Fight timing' },
  farm_route: { zh: '刷钱路线', en: 'Farm route' },
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
const AI_PRIMARY_MISTAKE_CATEGORIES = new Set(['fight_timing']);
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
      label: isZh ? `${cp.minute}分我方经济` : `Your team gold @${cp.minute}`,
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
  const keys = evidence.map((e) => e.factKey);
  const has = (pred) => keys.some(pred);

  switch (category) {
    case 'fight_timing':
      return has((k) => k.startsWith('timeline_') || k.startsWith('gold_lead_') || k === 'kda' || k === 'deaths');
    case 'farm_route':
      return false;
    default:
      return false;
  }
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
  const boundKeys = new Set();
  for (const m of moments) {
    const key = boundTimelineFactKey(m);
    if (key) boundKeys.add(key);
  }
  return boundKeys.size >= minCount;
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
 */
export function isReviewAiCardsComplete(reviewCards) {
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
  const moments = reviewCards?.key_moments || [];
  const momentsGrounded = moments.length >= 3
    && moments.every(isGroundedKeyMoment)
    && hasDistinctKeyMoments(moments, 3);
  return Boolean(
    mistakeGrounded
    && momentsGrounded
    && isValidReviewDrill(reviewCards.drill),
  );
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
    : matchFact.summary.radiantWin;

  const match_summary = {
    matchId: matchFact.summary.matchId,
    heroId: matchFact.focusHeroId ?? undefined,
    durationFormatted: matchFact.summary.durationFormatted,
    heroName: lens?.displayName || (isZh ? '本局英雄' : 'Your hero'),
    kda: lens?.kda || (focus ? `${focus.kills}/${focus.deaths}/${focus.assists}` : '—'),
    gpm: lens?.gpm ?? focus?.gpm ?? 0,
    result: won ? 'win' : 'loss',
    resultLabel: won
      ? (isZh ? '胜利' : 'Victory')
      : (isZh ? '失败' : 'Defeat'),
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
        ? `10–25 分我方经济 ${gold20.value}，关注中期节奏与地图控制。`
        : '中期关注抱团节奏与视野。')
      : (gold20
        ? `Mid game your-team gold ${gold20.value} — watch tempo and map control.`
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
    if (focus) {
      lateEvidence.push({
        factKey: 'deaths',
        label: isZh ? '总死亡' : 'Total deaths',
        value: String(focus.deaths),
      });
    }

    const lateInsight = isZh
      ? `比赛进入后期（25 分+），以下为后期经济与阵亡数据。`
      : `Late game (25+ min): see economy and death evidence below.`;

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
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * @param {object} raw
 * @param {string} lang
 * @param {Array} catalog
 * @param {number} matchDuration
 */
function normalizeAiCards(raw, lang, catalog, matchDuration) {
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
    ? raw.key_moments
      .map((m) => {
        if (!m) return null;
        const evidence = resolveEvidence(m.evidence, catalog);
        if (evidence.length === 0 || !hasTimelineEvidence(evidence)) return null;
        const timestamp = bindKeyMomentTimestamp(evidence, catalog);
        if (timestamp == null) return null;
        const boundKey = boundTimelineFactKey({ evidence });
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
      .slice(0, 5)
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
    return { duration, title, steps };
  })() : undefined;

  const followups = normalizeFollowups(raw.followups, lang, key_moments, catalog);

  const mentor_note = typeof raw.mentor_note === 'string' ? raw.mentor_note.trim() : undefined;

  return { primary_mistake, key_moments, drill, followups, mentor_note };
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
  const gold20 = catalog.find((e) => e.factKey === 'gold_lead_20');
  if (gold20) {
    return lang === 'zh'
      ? `${gold20.label}（${gold20.value}）对本局节奏意味着什么？`
      : `What did ${gold20.label} (${gold20.value}) mean for this game's tempo?`;
  }
  const gpm = catalog.find((e) => e.factKey === 'gpm');
  if (gpm) {
    return lang === 'zh'
      ? `GPM ${gpm.value} 是否匹配本局走势？`
      : `Did GPM ${gpm.value} match how this game played out?`;
  }
  return lang === 'zh' ? '经济节点如何影响本局？' : 'How did economy checkpoints shape this game?';
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
  const fightChip = lang === 'zh'
    ? (ts && headline ? `展开 ${ts} 节点：${headline}` : '展开关键团战节点')
    : (ts && headline ? `Break down ${ts}: ${headline}` : 'Break down the key fight');
  const economyChip = secondDefaultFollowup(lang, keyMoments, catalog);
  return lang === 'zh'
    ? [fightChip, economyChip, '下一局只练一件事']
    : [fightChip, economyChip, 'One thing to practice next'];
}

/**
 * @param {unknown} rawFollowups
 * @param {string} lang
 * @param {Array<{ timestampLabel?: string; timestamp?: number; headline?: string }> | undefined} keyMoments
 * @param {Array<{ factKey: string; label?: string; value?: string }>} catalog
 */
function normalizeFollowups(rawFollowups, lang, keyMoments, catalog = []) {
  const defaults = defaultFollowups(lang, keyMoments, catalog);
  if (!Array.isArray(rawFollowups) || rawFollowups.length === 0) {
    return defaults;
  }
  const mapped = rawFollowups
    .map((f) => (typeof f === 'string' ? f.trim() : ''))
    .filter(Boolean)
    .slice(0, 3);
  for (let i = 0; i < 3; i++) {
    if (mapped[i] !== defaults[i]) {
      mapped[i] = defaults[i];
    }
  }
  while (mapped.length < 3) mapped.push(defaults[mapped.length]);
  return mapped.slice(0, 3);
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
  const ai = normalizeAiCards(raw, lang, catalog, matchDuration);
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

  const key_moments = buildKeyMomentsFromTimeline(catalog, lang, 4);

  const deaths = focus?.deaths ?? 0;
  const gpm = focus?.gpm ?? lens?.gpm ?? '—';
  const category = 'fight_timing';
  const timelineKey = key_moments[0]?.evidence?.[0]?.factKey
    || catalog.find((e) => e.factKey.startsWith('timeline_'))?.factKey;
  const evidenceRefs = [{ factKey: 'kda' }];
  if (timelineKey) evidenceRefs.push({ factKey: timelineKey });

  const ai = {
    primary_mistake: {
      category,
      categoryLabel: MISTAKE_CATEGORIES[category][isZh ? 'zh' : 'en'],
      headline: isZh
        ? '按关键节点复盘团战与经济节奏'
        : 'Review fight tempo and economy at key moments',
      explanation: isZh
        ? `仅陈述 MatchFact：${lens?.displayName || '英雄'} KDA ${lens?.kda || '—'}，死亡 ${deaths} 次，GPM ${gpm}。具体转折点见下方时间戳，不做未证实的因果推断。`
        : `MatchFact only: ${lens?.displayName || 'hero'} KDA ${lens?.kda || '—'}, ${deaths} deaths, GPM ${gpm}. Turning points are listed below; no unsupported causal claims.`,
      evidence: resolveEvidence(evidenceRefs, catalog),
    },
    key_moments,
    drill: buildFallbackDrill(matchFact, lang),
    followups: includeFollowups ? defaultFollowups(lang, key_moments, catalog) : [],
    mentor_note: isZh
      ? '我是拉比克——数据不会骗人，但解读需要练习。先看事实，再改习惯。'
      : 'Rubick here — numbers don\'t lie, but reading them takes reps. Facts first, habits second.',
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

export { MISTAKE_CATEGORIES, PHASE_LABELS, localizeKillTarget, resolveEvidence, buildKeyMomentsFromTimeline, hasDistinctKeyMoments, isGroundedKeyMoment, evidenceSupportsCategory, boundTimelineFactKey };
