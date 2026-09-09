/**
 * OpenDota enrichment helpers for MatchFact / default review cards.
 * Dotabuff is link-only (no scrape) — IA inspiration only.
 */

const CONSUMABLE_OR_COMPONENT = new Set([
  'tango', 'flask', 'clarity', 'faerie_fire', 'enchanted_mango', 'blood_grenade',
  'ward_observer', 'ward_sentry', 'smoke_of_deceit', 'dust', 'tome_of_knowledge',
  'tpscroll', 'branches', 'circlet', 'gauntlets', 'mantle', 'slippers', 'belt_of_strength',
  'boots_of_elves', 'robe', 'gloves', 'blades_of_attack', 'chainmail', 'quarterstaff',
  'helm_of_iron_will', 'broadsword', 'claymore', 'javelin', 'mithril_hammer', 'ogre_axe',
  'blade_of_alacrity', 'staff_of_wizardry', 'ultimate_orb', 'demon_edge', 'eagle', 'reaver',
  'mystic_staff', 'vitality_booster', 'energy_booster', 'point_booster', 'platemail',
  'hyperstone', 'void_stone', 'ring_of_health', 'ring_of_regen', 'sobi_mask', 'ring_of_protection',
  'ring_of_basilius', 'headdress', 'buckler', 'urn_of_shadows', 'infused_raindrop',
  'magic_stick', 'magic_wand', 'wind_lace', 'shadow_amulet', 'blitz_knuckles', 'diadem',
  'fluffy_hat', 'crown', 'wizard_hat', 'tiara_of_selemene', 'great_famango', 'greater_famango',
  'famango', 'cheese', 'aegis', 'refresher_shard', 'aghanims_shard', 'recipe',
]);

/** Internal npc name → Dotabuff public slug (only where underscore→hyphen is wrong). */
const DOTABUFF_SLUG_BY_INTERNAL = {
  nevermore: 'shadow-fiend',
  centaur: 'centaur-warrunner',
  skeleton_king: 'wraith-king',
  furion: 'natures-prophet',
  obsidian_destroyer: 'outworld-destroyer',
  abyssal_underlord: 'underlord',
  shredder: 'timbersaw',
  wisp: 'io',
  antimage: 'anti-mage',
  rattletrap: 'clockwerk',
  zuus: 'zeus',
  magnataur: 'magnus',
  treant: 'treant-protector',
  doom_bringer: 'doom',
  queenofpain: 'queen-of-pain',
  life_stealer: 'lifestealer',
  windrunner: 'windranger',
  necrolyte: 'necrophos',
  witch_doctor: 'witch-doctor',
  shadow_shaman: 'shadow-shaman',
  vengefulspirit: 'vengeful-spirit',
  crystal_maiden: 'crystal-maiden',
  drow_ranger: 'drow-ranger',
  phantom_lancer: 'phantom-lancer',
  storm_spirit: 'storm-spirit',
  queenofpain: 'queen-of-pain',
  death_prophet: 'death-prophet',
  phantom_assassin: 'phantom-assassin',
  templar_assassin: 'templar-assassin',
  dragon_knight: 'dragon-knight',
  spirit_breaker: 'spirit-breaker',
  faceless_void: 'faceless-void',
  shadow_demon: 'shadow-demon',
  chaos_knight: 'chaos-knight',
  naga_siren: 'naga-siren',
  keeper_of_the_light: 'keeper-of-the-light',
  nyx_assassin: 'nyx-assassin',
  twin_headed_troll: 'troll-warlord',
  troll_warlord: 'troll-warlord',
  elder_titan: 'elder-titan',
  legion_commander: 'legion-commander',
  ember_spirit: 'ember-spirit',
  earth_spirit: 'earth-spirit',
  abaddon: 'abaddon',
  oracle: 'oracle',
  winter_wyvern: 'winter-wyvern',
  arc_warden: 'arc-warden',
  monkey_king: 'monkey-king',
  dark_willow: 'dark-willow',
  pangolier: 'pangolier',
  grimstroke: 'grimstroke',
  mars: 'mars',
  snapfire: 'snapfire',
  void_spirit: 'void-spirit',
  hoodwink: 'hoodwink',
  dawnbreaker: 'dawnbreaker',
  marci: 'marci',
  primal_beast: 'primal-beast',
  muerta: 'muerta',
  ringmaster: 'ringmaster',
  kez: 'kez',
};

/**
 * Normalize item keys from purchase_log or itemPopularity to a shared internal name.
 * @param {string | number | null | undefined} keyOrId
 * @param {Record<string, { id?: number, dname?: string }> | Map | null} [itemConstants]
 * @returns {string}
 */
export function normalizeItemKey(keyOrId, itemConstants = null) {
  if (keyOrId == null) return '';
  let raw = String(keyOrId).trim().toLowerCase().replace(/^item_/, '');
  if (!raw) return '';
  if (/^\d+$/.test(raw) && itemConstants) {
    const id = Number(raw);
    const entries = itemConstants instanceof Map
      ? [...itemConstants.entries()]
      : Object.entries(itemConstants);
    const found = entries.find(([, item]) => item && item.id === id);
    if (found?.[0]) raw = String(found[0]).toLowerCase().replace(/^item_/, '');
  }
  return raw;
}

/**
 * @param {string | null | undefined} internalSlug
 * @returns {string | null}
 */
export function dotabuffHeroGuidesUrl(internalSlug) {
  if (!internalSlug || typeof internalSlug !== 'string') return null;
  const internal = internalSlug.trim().replace(/^npc_dota_hero_/, '').toLowerCase();
  if (!internal) return null;
  const slug = DOTABUFF_SLUG_BY_INTERNAL[internal]
    || internal.replace(/_/g, '-');
  return `https://www.dotabuff.com/heroes/${slug}/guides`;
}

/**
 * @param {Array<{ percentile?: number, value?: number }> | undefined} rows
 * @param {number} actual
 * @returns {number | null}
 */
export function percentileForValue(rows, actual) {
  if (!Array.isArray(rows) || rows.length === 0 || actual == null || Number.isNaN(Number(actual))) {
    return null;
  }
  const sorted = rows
    .filter((r) => r && typeof r.value === 'number' && typeof r.percentile === 'number')
    .slice()
    .sort((a, b) => a.value - b.value);
  if (!sorted.length) return null;

  const v = Number(actual);
  if (v <= sorted[0].value) return sorted[0].percentile * 100;
  if (v >= sorted[sorted.length - 1].value) return sorted[sorted.length - 1].percentile * 100;

  for (let i = 1; i < sorted.length; i += 1) {
    const lo = sorted[i - 1];
    const hi = sorted[i];
    if (v >= lo.value && v <= hi.value) {
      const span = hi.value - lo.value || 1;
      const t = (v - lo.value) / span;
      const p = lo.percentile + t * (hi.percentile - lo.percentile);
      return Math.round(p * 1000) / 10;
    }
  }
  return null;
}

/**
 * @param {{ actual: { gpm?: number, xpm?: number, lastHitsPerMin?: number }, benchmarks?: object }} input
 */
export function buildBenchmarkComparison({ actual, benchmarks }) {
  const result = benchmarks?.result || benchmarks || {};
  const out = {};
  if (actual?.gpm != null) {
    const percentile = percentileForValue(result.gold_per_min, actual.gpm);
    if (percentile != null) out.gpm = { actual: actual.gpm, percentile };
  }
  if (actual?.xpm != null) {
    const percentile = percentileForValue(result.xp_per_min, actual.xpm);
    if (percentile != null) out.xpm = { actual: actual.xpm, percentile };
  }
  if (actual?.lastHitsPerMin != null) {
    const rows = result.last_hits_per_min;
    const percentile = percentileForValue(rows, actual.lastHitsPerMin);
    if (percentile != null) {
      out.lastHits = {
        actual: Math.round(actual.lastHitsPerMin * 100) / 100,
        percentile,
        unit: 'per_min',
      };
    }
  }
  return out;
}

/**
 * @param {number} seconds
 */
function formatItemTime(seconds) {
  const negative = seconds < 0;
  const abs = Math.abs(Math.floor(seconds));
  const m = Math.floor(abs / 60);
  const s = abs % 60;
  const label = `${m}:${String(s).padStart(2, '0')}`;
  return negative ? `-${label}` : label;
}

/**
 * @param {string} key
 */
function isMajorPurchase(key) {
  const k = normalizeItemKey(key);
  if (!k) return false;
  if (k.startsWith('recipe_')) return false;
  if (CONSUMABLE_OR_COMPONENT.has(k)) return false;
  return true;
}

/**
 * Compare actual purchases to OpenDota popularity buckets.
 * Does NOT invent expected completion times — only observed presence/absence vs popular sets.
 * @param {{ purchaseLog?: Array<{time:number,key:string}> | null, itemPopularity?: object, itemConstants?: object }} input
 */
export function compareItemBuild({ purchaseLog = [], itemPopularity = {}, itemConstants = null }) {
  // Missing purchase history OR unavailable popularity (failed fetch) → skip comparison.
  if (!Array.isArray(purchaseLog) || itemPopularity == null || itemPopularity.unavailable === true) {
    return {
      unavailable: true,
      actualCore: [],
      popularMid: [],
      popularLate: [],
      offMeta: [],
      missingPopular: [],
    };
  }

  const normalizePop = (list) => (list || []).map((i) => {
    const key = normalizeItemKey(i.key ?? i.id, itemConstants);
    return {
      ...i,
      key,
      name: i.name || key.replace(/_/g, ' '),
    };
  }).filter((i) => i.key);

  const popularMid = normalizePop(itemPopularity.midGame).slice(0, 6);
  const popularLate = normalizePop(itemPopularity.lateGame).slice(0, 6);
  const popularEarly = normalizePop(itemPopularity.earlyGame);
  const popularKeys = new Set(
    [...popularMid, ...popularLate, ...popularEarly].map((i) => i.key),
  );

  const actualCore = purchaseLog
    .filter((p) => isMajorPurchase(p.key))
    .map((p) => {
      const key = normalizeItemKey(p.key, itemConstants);
      return {
        key,
        name: key.replace(/_/g, ' '),
        time: p.time,
        timeLabel: formatItemTime(p.time),
      };
    });

  const actualKeys = new Set(actualCore.map((i) => i.key));

  const offMeta = actualCore
    .filter((a) => a.time > 8 * 60 && !popularKeys.has(a.key))
    .slice(0, 5)
    .map((a) => ({ key: a.key, name: a.name, timeLabel: a.timeLabel }));

  const missingPopular = [...popularMid, ...popularLate]
    .filter((p) => p.key && !actualKeys.has(p.key))
    .slice(0, 4)
    .map((p) => ({ key: p.key, name: p.name || p.key }));

  return {
    unavailable: false,
    actualCore: actualCore.slice(0, 10),
    popularMid,
    popularLate,
    offMeta,
    missingPopular,
  };
}

/**
 * Derive hero baseline win rate from the same /matchups population used for advantage.
 * Avoids mixing pro-skewed heroStats WR with unfiltered matchup rows.
 * @param {Record<string|number, { gamesPlayed?: number, wins?: number, winRate?: string|number }> | null | undefined} matchupsMap
 * @param {{ minGames?: number }} [opts]
 * @returns {number | null} percent 0-100, 1 decimal
 */
export function baselineWinRateFromMatchups(matchupsMap, opts = {}) {
  const minGames = opts.minGames ?? 50;
  if (!matchupsMap || typeof matchupsMap !== 'object') return null;
  let games = 0;
  let wins = 0;
  for (const m of Object.values(matchupsMap)) {
    if (!m) continue;
    const g = Number(m.gamesPlayed) || 0;
    if (g <= 0) continue;
    games += g;
    if (m.wins != null && Number.isFinite(Number(m.wins))) {
      wins += Number(m.wins);
    } else if (m.winRate != null && m.winRate !== '') {
      const wr = parseFloat(m.winRate);
      if (Number.isFinite(wr)) wins += (wr / 100) * g;
    }
  }
  if (games < minGames) return null;
  return Math.round((wins / games) * 1000) / 10;
}

/**
 * @param {{ focusHeroId: number, enemyHeroIds: number[], matchupsMap: object, heroNames?: object, lang?: string, minGames?: number, baselineWinRate?: number | null }} input
 */
export function buildMatchupContext({
  focusHeroId,
  enemyHeroIds = [],
  matchupsMap = {},
  heroNames = {},
  lang = 'zh',
  minGames = 50,
  baselineWinRate = null,
}) {
  const isZh = lang === 'zh';
  const rows = [];
  const baseline = baselineWinRate != null && Number.isFinite(Number(baselineWinRate))
    ? Number(baselineWinRate)
    : null;

  for (const enemyId of enemyHeroIds) {
    const m = matchupsMap[enemyId];
    if (!m || (m.gamesPlayed ?? 0) < minGames) continue;
    const names = heroNames[enemyId] || {};
    const heroName = isZh
      ? (names.nameZh || names.nameEn || names.displayName || `Hero#${enemyId}`)
      : (names.nameEn || names.nameZh || names.displayName || `Hero#${enemyId}`);
    const matchupWr = m.winRate != null
      ? parseFloat(m.winRate)
      : (m.gamesPlayed > 0 ? (m.wins / m.gamesPlayed) * 100 : NaN);
    const winRate = Number.isFinite(matchupWr) ? matchupWr.toFixed(1) : null;

    // Advantage vs hero baseline WR when available; otherwise label as matchup WR only.
    let advantage = null;
    let advantageLabel = '—';
    if (Number.isFinite(matchupWr) && baseline != null) {
      advantage = Math.round((matchupWr - baseline) * 10) / 10;
      advantageLabel = `${advantage >= 0 ? '+' : ''}${advantage.toFixed(1)}%`;
    } else if (Number.isFinite(matchupWr)) {
      advantage = 0;
      advantageLabel = isZh ? `对位 ${winRate}%` : `WR ${winRate}%`;
    }

    rows.push({
      heroId: enemyId,
      heroName,
      advantage: advantage ?? 0,
      advantageLabel,
      winRate,
      gamesPlayed: m.gamesPlayed,
      detail: isZh
        ? (baseline != null
          ? `对位胜率 ${winRate ?? '—'}% vs 英雄基准 ${baseline.toFixed(1)}%（${m.gamesPlayed} 场）`
          : `对位胜率 ${winRate ?? '—'}%（${m.gamesPlayed} 场样本）`)
        : (baseline != null
          ? `Matchup WR ${winRate ?? '—'}% vs hero baseline ${baseline.toFixed(1)}% (${m.gamesPlayed} games)`
          : `Matchup WR ${winRate ?? '—'}% (${m.gamesPlayed} games)`),
    });
  }
  rows.sort((a, b) => a.advantage - b.advantage);
  return rows;
}

/**
 * @param {object} matchFact
 * @param {object} enrichment
 */
export function attachEnrichmentToMatchFact(matchFact, enrichment) {
  if (!matchFact || !enrichment) return matchFact;
  return {
    ...matchFact,
    enrichment: {
      ...(matchFact.enrichment || {}),
      ...enrichment,
    },
  };
}

/**
 * Build OpenDota enrichment object from fetched payloads.
 * @param {{
 *   matchFact: object,
 *   benchmarks?: object | null,
 *   itemPopularity?: object | null,
 *   matchupsMap?: object,
 *   lang?: string,
 *   baselineWinRate?: number | null,
 *   itemConstants?: object | null,
 * }} input
 */
export function buildHeroEnrichmentPayload({
  matchFact,
  benchmarks,
  itemPopularity,
  matchupsMap,
  lang = 'zh',
  baselineWinRate = null,
  itemConstants = null,
}) {
  const focusId = matchFact?.focusHeroId;
  if (!focusId) return null;
  const focus = (matchFact.players || []).find((p) => p.heroId === focusId);
  if (!focus) return null;

  const lastHits = focus.lastHits
    ?? (Array.isArray(focus.lhTimeline) && focus.lhTimeline.length
      ? focus.lhTimeline[focus.lhTimeline.length - 1]
      : undefined);
  const durationSec = matchFact.summary?.duration || 0;
  const durationMin = durationSec > 0 ? durationSec / 60 : 0;
  const lastHitsPerMin = lastHits != null && durationMin > 0
    ? lastHits / durationMin
    : undefined;

  const benchmarkComparison = buildBenchmarkComparison({
    actual: { gpm: focus.gpm, xpm: focus.xpm, lastHitsPerMin },
    benchmarks,
  });

  // Preserve missing purchase history; null popularity (failed fetch) → unavailable compare.
  const itemCompare = focus.purchaseLog == null
    ? null
    : compareItemBuild({
      purchaseLog: focus.purchaseLog,
      itemPopularity: itemPopularity == null ? null : itemPopularity,
      itemConstants,
    });

  const enemies = (matchFact.players || [])
    .filter((p) => p.isRadiant !== focus.isRadiant)
    .map((p) => p.heroId);

  const heroNames = {};
  for (const p of matchFact.players || []) {
    heroNames[p.heroId] = {
      nameZh: p.nameZh,
      nameEn: p.nameEn,
      displayName: p.displayName,
    };
  }

  const matchups = buildMatchupContext({
    focusHeroId: focusId,
    enemyHeroIds: enemies,
    matchupsMap: matchupsMap || {},
    heroNames,
    lang,
    baselineWinRate,
  });

  const slug = focus.internalSlug || null;
  const guidesUrl = dotabuffHeroGuidesUrl(slug);

  return {
    benchmarks: benchmarkComparison,
    itemCompare,
    matchups,
    guidesUrl,
    source: 'opendota',
  };
}

/**
 * @param {object} matchFact
 * @param {string} lang
 */
export function buildEnrichmentSectionCards(matchFact, lang = 'zh') {
  const isZh = lang === 'zh';
  const enr = matchFact?.enrichment;
  if (!enr) return {};

  const cards = {};

  if (enr.itemCompare && !enr.itemCompare.unavailable) {
    const ic = enr.itemCompare;
    const rows = [];
    for (const a of (ic.actualCore || []).slice(0, 6)) {
      rows.push({
        label: isZh ? `出装 ${a.timeLabel}` : `Item ${a.timeLabel}`,
        value: a.name,
      });
    }
    for (const m of (ic.missingPopular || []).slice(0, 2)) {
      rows.push({
        label: isZh ? '常见未出' : 'Common missing',
        value: m.name,
      });
    }
    for (const o of (ic.offMeta || []).slice(0, 2)) {
      rows.push({
        label: isZh ? '非常见' : 'Uncommon',
        value: isZh ? `${o.name}（${o.timeLabel}）` : `${o.name} (${o.timeLabel})`,
      });
    }
    if (rows.length) {
      cards.item_compare = {
        title: isZh ? '出装对比' : 'Item build compare',
        insight: isZh
          ? '对照 OpenDota 该英雄常见中后期装的出现差异（非时间表，非绝对最优解）。'
          : 'Presence vs OpenDota popular mid/late items — not a timing table; not absolute truth.',
        rows,
        guidesUrl: enr.guidesUrl || undefined,
      };
    }
  }

  if (enr.benchmarks && Object.keys(enr.benchmarks).length) {
    const b = enr.benchmarks;
    const rows = [];
    if (b.gpm) {
      rows.push({
        label: 'GPM',
        value: String(b.gpm.actual),
        percentile: b.gpm.percentile,
      });
    }
    if (b.xpm) {
      rows.push({
        label: 'XPM',
        value: String(b.xpm.actual),
        percentile: b.xpm.percentile,
      });
    }
    if (b.lastHits) {
      rows.push({
        label: isZh ? '补刀/分' : 'LH/min',
        value: String(b.lastHits.actual),
        percentile: b.lastHits.percentile,
      });
    }
    if (rows.length) {
      const low = rows.some((r) => (r.percentile ?? 100) <= 30);
      cards.farm_benchmarks = {
        title: isZh ? '对线/经济对标' : 'Farm benchmarks',
        insight: low
          ? (isZh
            ? '相对同英雄基准，本场经济/经验/补刀百分位偏低（描述性对标，非路线因果）。'
            : 'Vs hero benchmarks, farm metrics sit in a low percentile (descriptive, not route causation).')
          : (isZh
            ? '相对同英雄 OpenDota 基准的百分位（描述性对标）。'
            : 'Percentiles vs OpenDota hero benchmarks (descriptive).'),
        rows,
      };
    }
  }

  if (Array.isArray(enr.matchups) && enr.matchups.length) {
    cards.matchup_context = {
      title: isZh ? '克制关系' : 'Matchups',
      insight: isZh
        ? '对位胜率相对该英雄整体基准的差（样本≥50）；无基准时仅展示对位胜率。'
        : 'Matchup WR relative to this hero baseline (≥50 games); WR-only when baseline unavailable.',
      rows: enr.matchups.slice(0, 5).map((m) => ({
        heroName: m.heroName,
        advantageLabel: m.advantageLabel,
        detail: m.detail,
      })),
    };
  }

  return cards;
}

export { isMajorPurchase, formatItemTime, CONSUMABLE_OR_COMPONENT, DOTABUFF_SLUG_BY_INTERNAL };
