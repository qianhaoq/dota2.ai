import { formatObjectiveLabel } from './objectiveLabels.js';
import { formatDuration, selectTimelineForDisplay } from './matchFacts.js';

const MISTAKE_CATEGORIES = {
  fight_timing: { zh: '团战时机', en: 'Fight timing' },
  itemisation: { zh: '出装思路', en: 'Itemisation' },
  vision: { zh: '视野控制', en: 'Vision' },
  positioning: { zh: '站位走位', en: 'Positioning' },
  farm_route: { zh: '刷钱路线', en: 'Farm route' },
};

const PHASE_LABELS = {
  lane: { zh: '对线 0–10', en: 'Lane 0–10' },
  mid: { zh: '中期 10–25', en: 'Mid 10–25' },
  late: { zh: '后期 25+', en: 'Late 25+' },
};

const VALID_CATEGORIES = new Set(Object.keys(MISTAKE_CATEGORIES));
const VALID_PHASES = new Set(['lane', 'mid', 'late']);

/**
 * @param {number} seconds
 */
export function formatTimestamp(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * @param {import('../../src/types/matchReview').MatchFact | object} matchFact
 * @param {string} lang
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
  let bestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < buckets.length; i++) {
    const diff = Math.abs(buckets[i] - minute * 60);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  if (bestDiff > 90) return null;
  return lh[bestIdx] ?? null;
}

/**
 * @param {object} matchFact
 * @param {string} lang
 */
function buildEvidenceCatalog(matchFact, lang) {
  const isZh = lang === 'zh';
  const focus = getFocusPlayer(matchFact);
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
    const sign = cp.radiantGoldLead >= 0 ? '+' : '';
    catalog.push({
      factKey: `gold_lead_${cp.minute}`,
      label: isZh ? `${cp.minute}分经济差` : `Gold lead @${cp.minute}`,
      value: `${sign}${cp.radiantGoldLead}`,
    });
  }

  const timeline = selectTimelineForDisplay(matchFact.timeline || [], 8);
  timeline.forEach((ev, idx) => {
    catalog.push({
      factKey: `timeline_${idx}`,
      label: formatTimestamp(ev.time),
      value: formatObjectiveLabel(ev, lang),
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
      if (known) {
        return {
          factKey: key,
          label: item.label || known.label,
          value: item.value || known.value,
        };
      }
      if (item.label && item.value) {
        return { factKey: key, label: item.label, value: item.value };
      }
      return null;
    })
    .filter(Boolean);
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
  const earlyKills = (lens?.earlyKills || []).slice(0, 2);
  earlyKills.forEach((k, i) => {
    midEvidence.push({
      factKey: `early_kill_${i}`,
      label: formatTimestamp(k.time),
      value: k.target,
    });
  });

  const midEvents = (matchFact.timeline || []).filter((e) => e.time >= 10 * 60 && e.time < 25 * 60);
  const midInsight = isZh
    ? (gold20
      ? `10–25 分团队经济差 ${gold20.value}，关注中期节奏与地图控制。`
      : '中期关注抱团节奏与视野。')
    : (gold20
      ? `Mid game gold lead ${gold20.value} — watch tempo and map control.`
      : 'Mid game: focus on tempo and vision.');

  phases.push({
    phase: 'mid',
    label: PHASE_LABELS.mid[isZh ? 'zh' : 'en'],
    insight: midInsight,
    evidence: midEvidence,
  });

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
    ? `比赛时长 ${matchFact.summary.durationFormatted}，后期决策决定胜负。`
    : `Match lasted ${matchFact.summary.durationFormatted}; late-game calls decided the outcome.`;

  phases.push({
    phase: 'late',
    label: PHASE_LABELS.late[isZh ? 'zh' : 'en'],
    insight: lateInsight,
    evidence: lateEvidence,
  });

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
 */
function normalizeAiCards(raw, lang, catalog) {
  const isZh = lang === 'zh';
  if (!raw || typeof raw !== 'object') return {};

  const category = VALID_CATEGORIES.has(raw.primary_mistake?.category)
    ? raw.primary_mistake.category
    : 'fight_timing';

  const primary_mistake = raw.primary_mistake ? {
    category,
    categoryLabel: MISTAKE_CATEGORIES[category][isZh ? 'zh' : 'en'],
    headline: String(raw.primary_mistake.headline || (isZh ? '本场主要失误' : 'Primary mistake')),
    explanation: String(raw.primary_mistake.explanation || ''),
    evidence: resolveEvidence(raw.primary_mistake.evidence, catalog),
  } : undefined;

  const key_moments = Array.isArray(raw.key_moments)
    ? raw.key_moments
      .filter((m) => m && typeof m.timestamp === 'number')
      .slice(0, 5)
      .map((m) => {
        const phase = VALID_PHASES.has(m.phase) ? m.phase : (
          m.timestamp < 600 ? 'lane' : m.timestamp < 1500 ? 'mid' : 'late'
        );
        return {
          timestamp: m.timestamp,
          timestampLabel: formatTimestamp(m.timestamp),
          phase,
          headline: String(m.headline || ''),
          why: String(m.why || ''),
          evidence: resolveEvidence(m.evidence, catalog),
        };
      })
    : undefined;

  const drill = raw.drill ? {
    duration: String(raw.drill.duration || (isZh ? '15 分钟' : '15 min')),
    title: String(raw.drill.title || (isZh ? '下一局练习' : 'Next-game drill')),
    steps: Array.isArray(raw.drill.steps)
      ? raw.drill.steps.map((s) => String(s)).filter(Boolean).slice(0, 4)
      : [],
  } : undefined;

  const followups = Array.isArray(raw.followups)
    ? raw.followups.map((f) => String(f)).filter(Boolean).slice(0, 3)
    : defaultFollowups(lang);

  const mentor_note = typeof raw.mentor_note === 'string' ? raw.mentor_note.trim() : undefined;

  return { primary_mistake, key_moments, drill, followups, mentor_note };
}

/**
 * @param {string} lang
 */
function defaultFollowups(lang) {
  return lang === 'zh'
    ? ['展开这场团', '为什么不该出羊刀', '下一局只练一件事']
    : ['Break down that fight', 'Why not Scythe?', 'One thing to practice next'];
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
  const ai = normalizeAiCards(raw, lang, catalog);
  return mergeReviewCards(deterministic, ai);
}

/**
 * @param {object} matchFact
 * @param {string} lang
 */
export function buildFallbackAiCards(matchFact, lang = 'zh') {
  const isZh = lang === 'zh';
  const deterministic = buildDeterministicReviewCards(matchFact, lang);
  const catalog = deterministic._catalog || [];
  const lens = matchFact.focusLens;
  const focus = getFocusPlayer(matchFact);

  const timeline = selectTimelineForDisplay(matchFact.timeline || [], 5);
  const key_moments = timeline.slice(0, 4).map((ev, idx) => {
    const phase = ev.time < 600 ? 'lane' : ev.time < 1500 ? 'mid' : 'late';
    const evItem = catalog.find((e) => e.factKey === `timeline_${idx}`);
    return {
      timestamp: ev.time,
      timestampLabel: formatTimestamp(ev.time),
      phase,
      headline: formatObjectiveLabel(ev, lang),
      why: isZh ? '该节点改变了地图压力或经济节奏。' : 'This swing shifted map pressure or economy.',
      evidence: evItem ? [evItem] : [],
    };
  });

  const deaths = focus?.deaths ?? 0;
  const category = deaths >= 8 ? 'positioning' : 'fight_timing';

  const ai = {
    primary_mistake: {
      category,
      categoryLabel: MISTAKE_CATEGORIES[category][isZh ? 'zh' : 'en'],
      headline: isZh
        ? (deaths >= 8 ? '死亡次数偏高，站位与进场时机需收紧' : '团战节奏与技能释放时机可优化')
        : (deaths >= 8 ? 'Too many deaths — tighten positioning and engage timing' : 'Fight tempo and spell timing can improve'),
      explanation: isZh
        ? `基于 MatchFact：${lens?.displayName || '英雄'} KDA ${lens?.kda || '—'}，死亡 ${deaths} 次。复盘关键节点见下方时间戳。`
        : `From MatchFact: ${lens?.displayName || 'hero'} KDA ${lens?.kda || '—'}, ${deaths} deaths. See key moments below.`,
      evidence: resolveEvidence(
        [{ factKey: 'kda' }, { factKey: 'deaths' }],
        catalog,
      ),
    },
    key_moments,
    drill: {
      duration: isZh ? '15 分钟' : '15 min',
      title: isZh ? '下一局只练一件事' : 'One drill for next game',
      steps: isZh
        ? [
          '开局 3 分钟内只关注对线补刀与仇恨管理',
          '10 分前不主动参团，除非队友明确呼叫',
          '每次死亡后回想：是视野、站位还是贪心补刀',
        ]
        : [
          'First 3 min: focus CS and aggro only',
          'Before 10 min: no fights unless team calls',
          'After each death: was it vision, position, or greed?',
        ],
    },
    followups: defaultFollowups(lang),
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

export { MISTAKE_CATEGORIES, PHASE_LABELS };
