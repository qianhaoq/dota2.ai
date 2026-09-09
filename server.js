import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import { buildMatchFact, matchFactToPrompt } from './lib/matchReview/matchFacts.js';
import { validateReviewPostRequest } from './lib/matchReview/reviewRequestGuard.js';
import { buildHeroNamesMap } from './lib/matchReview/heroNamesMap.js';
import { isTerminalStreamFinish, reviewAiUnavailableNotice } from './lib/matchReview/reviewStream.js';
import {
  buildDeterministicReviewCards,
  buildFallbackAiCards,
  buildReviewCardsPromptFacts,
  buildReviewKeyMomentsPromptRule,
  parseAiReviewCards,
  isReviewAiCardsComplete,
  minRequiredKeyMoments,
} from './lib/matchReview/reviewCards.js';
import {
  attachEnrichmentToMatchFact,
  buildHeroEnrichmentPayload,
} from './lib/matchReview/opendotaEnrichment.js';
import {
  REVIEW_HIGH_MMR_MIN_RANK_TIER,
  resolvePublicMatchSkill,
  selectReviewHighMmrPublicMatches,
} from './lib/matchReview/publicMatchRank.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

app.use(express.json());

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.warn("WARNING: DEEPSEEK_API_KEY is not set in the server environment.");
}

const steamApiKey = process.env.STEAM_WEB_API_KEY;
if (steamApiKey) {
  console.log("INFO: STEAM_WEB_API_KEY is configured, localized hero names will be available.");
} else {
  console.log("INFO: STEAM_WEB_API_KEY not set, using OpenDota constants only (graceful fallback).");
}

const openai = apiKey ? new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: apiKey,
}) : null;

const DEEPSEEK_MODEL = 'deepseek-chat';

// ============ External API URLs ============
const OPENDOTA_API = 'https://api.opendota.com/api';
const STEAM_API = 'https://api.steampowered.com';
const VALVE_CDN = 'https://cdn.cloudflare.steamstatic.com';

// Cache TTLs
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour for matchup data
const CONSTANTS_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours for constants (patch data changes rarely)
const MATCHES_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes for pro/public matches
const REVIEW_SUGGESTIONS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes for coach review suggestions
const REVIEW_SUGGESTIONS_DEFAULT_LIMIT = 6;
const REVIEW_SUGGESTIONS_MAX_LIMIT = 6;
const MATCH_DETAIL_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour for single match review
const MATCH_DETAIL_CACHE_MAX = 50;

// ============ Cache Storage ============
const cache = {
  heroStats: { data: null, timestamp: 0 },
  matchups: new Map(), // Map<heroId, { data, timestamp }>
  itemPopularity: new Map(), // Map<heroId, { data, timestamp }>
  benchmarks: new Map(), // Map<heroId, { data, timestamp }>
  // Foundation data constants
  heroes: { data: null, timestamp: 0 },
  items: { data: null, timestamp: 0 },
  abilities: { data: null, timestamp: 0 },
  // Steam localized data
  steamHeroesZh: { data: null, timestamp: 0 },
  steamHeroesEn: { data: null, timestamp: 0 },
  // Pro/Public matches
  proMatches: { data: null, timestamp: 0 },
  publicMatches: { data: null, timestamp: 0 },
  publicMatchesHighMmr: { data: null, timestamp: 0 },
  reviewSuggestions: { data: {} },
  // Single match detail for replay review
  matchDetails: new Map(), // Map<matchId, { data, timestamp }>
};

async function fetchWithRetry(url, retries = 2, delay = 500, options = {}) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (options.signal?.aborted) throw err;
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, delay * (i + 1)));
    }
  }
}

const MIN_GAMES_FOR_RELIABLE_WR = 20;
const MIN_MATCHUP_GAMES = 50;

// ============ Chinese Hero Names Mapping ============
const HERO_NAMES_CN = {
  1: { nameZh: '敌法师', aliases: ['敌法', 'AM', '蓝猫克星'] },
  2: { nameZh: '斧王', aliases: ['斧头', '斧子'] },
  3: { nameZh: '祸乱之源', aliases: ['祸乱', 'Bane'] },
  4: { nameZh: '血魔', aliases: ['血', 'BS'] },
  5: { nameZh: '水晶室女', aliases: ['冰女', 'CM', '水晶'] },
  6: { nameZh: '卓尔游侠', aliases: ['小黑', 'Drow'] },
  7: { nameZh: '撼地者', aliases: ['小牛', 'ES', '撼地神牛'] },
  8: { nameZh: '主宰', aliases: ['剑圣', 'Jugg'] },
  9: { nameZh: '米拉娜', aliases: ['白虎', 'Mirana', 'POTM'] },
  10: { nameZh: '变体精灵', aliases: ['水人', 'Morphling'] },
  11: { nameZh: '影魔', aliases: ['SF', '灵魂守卫'] },
  12: { nameZh: '幻影长矛手', aliases: ['猴子', 'PL'] },
  13: { nameZh: '帕克', aliases: ['精灵龙', 'Puck'] },
  14: { nameZh: '帕吉', aliases: ['屠夫', 'Pudge'] },
  15: { nameZh: '剃刀', aliases: ['电棍', 'Razor'] },
  16: { nameZh: '沙王', aliases: ['蝎子', 'SK'] },
  17: { nameZh: '风暴之灵', aliases: ['蓝猫', 'Storm'] },
  18: { nameZh: '斯温', aliases: ['流浪剑客', 'Sven'] },
  19: { nameZh: '小小', aliases: ['山岭巨人', 'Tiny'] },
  20: { nameZh: '复仇之魂', aliases: ['VS', '复仇'] },
  21: { nameZh: '风行者', aliases: ['风行', 'WR', '风女'] },
  22: { nameZh: '宙斯', aliases: ['Zeus', '雷神'] },
  23: { nameZh: '昆卡', aliases: ['船长', 'Kunkka'] },
  25: { nameZh: '莉娜', aliases: ['Lina', '火女'] },
  26: { nameZh: '莱恩', aliases: ['Lion', '狮子'] },
  27: { nameZh: '暗影萨满', aliases: ['萨满', 'SS', '小Y'] },
  28: { nameZh: '斯拉达', aliases: ['大鱼', 'Slardar'] },
  29: { nameZh: '潮汐猎人', aliases: ['潮汐', 'Tide'] },
  30: { nameZh: '巫医', aliases: ['WD', '医生'] },
  31: { nameZh: '巫妖', aliases: ['Lich', '冰巫妖'] },
  32: { nameZh: '力丸', aliases: ['隐刺', 'Riki'] },
  33: { nameZh: '谜团', aliases: ['Enigma', '黑洞'] },
  34: { nameZh: '修补匠', aliases: ['TK', 'Tinker'] },
  35: { nameZh: '狙击手', aliases: ['火枪', 'Sniper'] },
  36: { nameZh: '瘟疫法师', aliases: ['死灵法师', 'Necro'] },
  37: { nameZh: '术士', aliases: ['Warlock'] },
  38: { nameZh: '兽王', aliases: ['BM', 'Beastmaster'] },
  39: { nameZh: '痛苦女王', aliases: ['QOP', '女王'] },
  40: { nameZh: '剧毒术士', aliases: ['毒狗', 'Veno'] },
  41: { nameZh: '虚空假面', aliases: ['虚空', 'Void', 'FV'] },
  42: { nameZh: '冥魂大帝', aliases: ['骷髅王', 'WK'] },
  43: { nameZh: '死亡先知', aliases: ['DP', '死灵女巫'] },
  44: { nameZh: '幻影刺客', aliases: ['PA', '幻刺'] },
  45: { nameZh: '帕格纳', aliases: ['骨法', 'Pugna'] },
  46: { nameZh: '圣堂刺客', aliases: ['TA', '圣堂'] },
  47: { nameZh: '冥界亚龙', aliases: ['毒龙', 'Viper'] },
  48: { nameZh: '露娜', aliases: ['Luna', '月骑'] },
  49: { nameZh: '龙骑士', aliases: ['DK', 'Dragon Knight'] },
  50: { nameZh: '戴泽', aliases: ['暗牧', 'Dazzle'] },
  51: { nameZh: '发条技师', aliases: ['发条', 'Clock'] },
  52: { nameZh: '拉席克', aliases: ['老鹿', 'Leshrac'] },
  53: { nameZh: '先知', aliases: ['NP', "Nature's Prophet"] },
  54: { nameZh: '噬魂鬼', aliases: ['小狗', 'LS', 'Naix'] },
  55: { nameZh: '黑暗贤者', aliases: ['黑贤', 'DS'] },
  56: { nameZh: '克林克兹', aliases: ['小骷髅', 'Clinkz'] },
  57: { nameZh: '全能骑士', aliases: ['全能', 'Omni'] },
  58: { nameZh: '魅惑魔女', aliases: ['小鹿', 'Enchantress'] },
  59: { nameZh: '哈斯卡', aliases: ['神灵武士', 'Huskar'] },
  60: { nameZh: '暗夜魔王', aliases: ['夜魔', 'NS'] },
  61: { nameZh: '育母蜘蛛', aliases: ['蜘蛛', 'Brood'] },
  62: { nameZh: '赏金猎人', aliases: ['赏金', 'BH'] },
  63: { nameZh: '编织者', aliases: ['蚂蚁', 'Weaver'] },
  64: { nameZh: '杰奇洛', aliases: ['双头龙', 'Jakiro'] },
  65: { nameZh: '蝙蝠骑士', aliases: ['蝙蝠', 'Bat'] },
  66: { nameZh: '陈', aliases: ['Chen', '奶陈'] },
  67: { nameZh: '幽鬼', aliases: ['Spectre', '幽灵'] },
  68: { nameZh: '远古冰魄', aliases: ['冰魂', 'AA'] },
  69: { nameZh: '末日使者', aliases: ['末日', 'Doom'] },
  70: { nameZh: '熊战士', aliases: ['大熊', 'Ursa'] },
  71: { nameZh: '裂魂人', aliases: ['白牛', 'SB'] },
  72: { nameZh: '矮人直升机', aliases: ['飞机', 'Gyro'] },
  73: { nameZh: '炼金术士', aliases: ['炼金', 'Alch'] },
  74: { nameZh: '祈求者', aliases: ['卡尔', 'Invoker'] },
  75: { nameZh: '沉默术士', aliases: ['沉默', 'Silencer'] },
  76: { nameZh: '殁境神蚀者', aliases: ['OD', '黑鸟'] },
  77: { nameZh: '狼人', aliases: ['Lycan', '狼王'] },
  78: { nameZh: '酒仙', aliases: ['熊猫', 'Brew'] },
  79: { nameZh: '暗影恶魔', aliases: ['SD', '暗魔'] },
  80: { nameZh: '德鲁伊', aliases: ['熊德', 'LD'] },
  81: { nameZh: '混沌骑士', aliases: ['CK', '混沌'] },
  82: { nameZh: '米波', aliases: ['地卜师', 'Meepo'] },
  83: { nameZh: '树精卫士', aliases: ['大树', 'Treant'] },
  84: { nameZh: '食人魔魔法师', aliases: ['蓝胖', 'Ogre'] },
  85: { nameZh: '不朽尸王', aliases: ['尸王', 'Undying'] },
  86: { nameZh: '拉比克', aliases: ['Rubick', '法师'] },
  87: { nameZh: '干扰者', aliases: ['萨尔', 'Disruptor'] },
  88: { nameZh: '司夜刺客', aliases: ['小强', 'Nyx'] },
  89: { nameZh: '娜迦海妖', aliases: ['小娜迦', 'Naga'] },
  90: { nameZh: '光之守卫', aliases: ['KOTL', '光法'] },
  91: { nameZh: '艾欧', aliases: ['小精灵', 'Io'] },
  92: { nameZh: '维萨吉', aliases: ['死灵飞龙', 'Visage'] },
  93: { nameZh: '斯拉克', aliases: ['小鱼人', 'Slark'] },
  94: { nameZh: '美杜莎', aliases: ['大娜迦', 'Medusa'] },
  95: { nameZh: '巨魔战将', aliases: ['巨魔', 'Troll'] },
  96: { nameZh: '半人马战行者', aliases: ['人马', 'Centaur'] },
  97: { nameZh: '马格纳斯', aliases: ['猛犸', 'Magnus'] },
  98: { nameZh: '伐木机', aliases: ['伐木', 'Timber'] },
  99: { nameZh: '钢背兽', aliases: ['刚背', 'BB'] },
  100: { nameZh: '巨牙海民', aliases: ['海民', 'Tusk'] },
  101: { nameZh: '天怒法师', aliases: ['天怒', 'Sky'] },
  102: { nameZh: '亚巴顿', aliases: ['死骑', 'Abaddon'] },
  103: { nameZh: '上古巨神', aliases: ['大牛', 'ET'] },
  104: { nameZh: '军团指挥官', aliases: ['军团', 'LC'] },
  105: { nameZh: '工程师', aliases: ['炸弹人', 'Techies'] },
  106: { nameZh: '灰烬之灵', aliases: ['火猫', 'Ember'] },
  107: { nameZh: '大地之灵', aliases: ['土猫', 'Earth Spirit'] },
  108: { nameZh: '孽主', aliases: ['大根', 'Underlord'] },
  109: { nameZh: '恐怖利刃', aliases: ['TB', 'Terrorblade'] },
  110: { nameZh: '凤凰', aliases: ['火鸟', 'Phoenix'] },
  111: { nameZh: '神谕者', aliases: ['先知', 'Oracle'] },
  112: { nameZh: '寒冬飞龙', aliases: ['冰龙', 'WW'] },
  113: { nameZh: '天穹守望者', aliases: ['电狗', 'Arc'] },
  114: { nameZh: '齐天大圣', aliases: ['猴王', 'MK'] },
  119: { nameZh: '邪影芳灵', aliases: ['小仙女', 'Willow'] },
  120: { nameZh: '石鳞剑士', aliases: ['穿山甲', 'Pangolier'] },
  121: { nameZh: '天涯墨客', aliases: ['墨客', 'Grimstroke'] },
  123: { nameZh: '森海飞霞', aliases: ['松鼠', 'Hoodwink'] },
  126: { nameZh: '虚无之灵', aliases: ['紫猫', 'Void Spirit'] },
  128: { nameZh: '电炎绝手', aliases: ['奶奶', 'Snapfire'] },
  129: { nameZh: '玛尔斯', aliases: ['战神', 'Mars'] },
  131: { nameZh: '马戏团团长', aliases: ['团长', 'Ringmaster'] },
  135: { nameZh: '破晓辰星', aliases: ['破晓', 'Dawnbreaker'] },
  136: { nameZh: '玛西', aliases: ['Marci', '小丫头'] },
  137: { nameZh: '獸', aliases: ['原始', 'Primal'] },
  138: { nameZh: '穆尔塔', aliases: ['女枪', 'Muerta'] },
  145: { nameZh: '凯斯', aliases: ['Kez', '刺客'] },
  155: { nameZh: '拉戈', aliases: ['Largo'] },
};

// Role mappings for Chinese
const ROLE_MAPPINGS = {
  'Carry': '核心',
  'Support': '辅助',
  'Nuker': '爆发',
  'Disabler': '控制',
  'Durable': '肉盾',
  'Escape': '逃生',
  'Pusher': '推进',
  'Initiator': '先手',
};

function translateRole(role, lang) {
  if (lang === 'en') return role;
  return ROLE_MAPPINGS[role] || role;
}

function translateRoles(roles, lang) {
  if (lang === 'en' || !roles) return roles;
  return roles.map(r => ROLE_MAPPINGS[r] || r);
}

function getHeroName(heroId, useZh = false, heroStats = null) {
  const cnData = HERO_NAMES_CN[heroId];
  const stats = heroStats?.[heroId];
  
  if (useZh && cnData?.nameZh) {
    return cnData.nameZh;
  }
  
  if (stats?.name) {
    return stats.name;
  }
  
  if (cnData?.nameZh) {
    return cnData.nameZh;
  }
  
  return `Hero#${heroId}`;
}

// ============ OpenDota Constants Fetchers ============

async function getHeroConstants() {
  const now = Date.now();
  if (cache.heroes.data && (now - cache.heroes.timestamp) < CONSTANTS_CACHE_TTL_MS) {
    return cache.heroes.data;
  }
  try {
    const data = await fetchWithRetry(`${OPENDOTA_API}/constants/heroes`);
    cache.heroes = { data, timestamp: now };
    console.log(`Loaded ${Object.keys(data).length} heroes from OpenDota constants`);
    return data;
  } catch (err) {
    console.error('Failed to fetch hero constants:', err.message);
    return cache.heroes.data || {};
  }
}

async function getItemConstants() {
  const now = Date.now();
  if (cache.items.data && (now - cache.items.timestamp) < CONSTANTS_CACHE_TTL_MS) {
    return cache.items.data;
  }
  try {
    const data = await fetchWithRetry(`${OPENDOTA_API}/constants/items`);
    cache.items = { data, timestamp: now };
    console.log(`Loaded ${Object.keys(data).length} items from OpenDota constants`);
    return data;
  } catch (err) {
    console.error('Failed to fetch item constants:', err.message);
    return cache.items.data || {};
  }
}

async function getAbilityConstants() {
  const now = Date.now();
  if (cache.abilities.data && (now - cache.abilities.timestamp) < CONSTANTS_CACHE_TTL_MS) {
    return cache.abilities.data;
  }
  try {
    const data = await fetchWithRetry(`${OPENDOTA_API}/constants/abilities`);
    cache.abilities = { data, timestamp: now };
    console.log(`Loaded ${Object.keys(data).length} abilities from OpenDota constants`);
    return data;
  } catch (err) {
    console.error('Failed to fetch ability constants:', err.message);
    return cache.abilities.data || {};
  }
}

// ============ Pro/Public Matches Fetchers ============

function normalizeReviewLang(lang) {
  return lang === 'en' ? 'en' : 'zh';
}

async function getProMatches(limit = 20, options = {}) {
  const { forceRefresh = false } = options;
  const now = Date.now();
  if (
    !forceRefresh
    && cache.proMatches.data
    && (now - cache.proMatches.timestamp) < MATCHES_CACHE_TTL_MS
  ) {
    return cache.proMatches.data.slice(0, limit);
  }
  try {
    const data = await fetchWithRetry(`${OPENDOTA_API}/proMatches`);
    const matches = Array.isArray(data) ? data : [];
    cache.proMatches = { data: matches, timestamp: now };
    console.log(`Loaded ${matches.length} pro matches from OpenDota`);
    return matches.slice(0, limit);
  } catch (err) {
    console.error('Failed to fetch pro matches:', err.message);
    return cache.proMatches.data?.slice(0, limit) || [];
  }
}

async function getPublicMatches(limit = 50, options = {}) {
  const { highMmr = false, forceRefresh = false } = options;
  const cacheKey = highMmr ? 'publicMatchesHighMmr' : 'publicMatches';
  const now = Date.now();

  const readCached = () => cache[cacheKey].data?.slice(0, limit) || [];

  if (
    !forceRefresh
    && cache[cacheKey].data
    && (now - cache[cacheKey].timestamp) < MATCHES_CACHE_TTL_MS
  ) {
    return readCached();
  }
  try {
    const url = highMmr
      ? `${OPENDOTA_API}/publicMatches?mmr_descending=1&min_rank=${REVIEW_HIGH_MMR_MIN_RANK_TIER}`
      : `${OPENDOTA_API}/publicMatches`;
    const data = await fetchWithRetry(url);
    const matches = Array.isArray(data) ? data : [];
    cache[cacheKey] = { data: matches, timestamp: now };
    console.log(`Loaded ${matches.length} public matches from OpenDota${highMmr ? ' (high MMR)' : ''}`);
    return matches.slice(0, limit);
  } catch (err) {
    console.error('Failed to fetch public matches:', err.message);
    return readCached();
  }
}

function parseTeamHeroIds(teamData) {
  if (!teamData) return [];
  if (Array.isArray(teamData)) {
    return teamData.map((id) => parseInt(id, 10)).filter((id) => !Number.isNaN(id) && id > 0);
  }
  if (typeof teamData === 'string') {
    return teamData.split(',').map((id) => parseInt(id.trim(), 10)).filter((id) => !Number.isNaN(id) && id > 0);
  }
  return [];
}

function filterPublicMatchesWithHeroes(matches) {
  return matches.filter((match) => {
    const radiantIds = parseTeamHeroIds(match.radiant_team);
    const direIds = parseTeamHeroIds(match.dire_team);
    return radiantIds.length > 0 || direIds.length > 0;
  });
}

async function getReviewMatchSuggestions(lang = 'zh', limit = REVIEW_SUGGESTIONS_DEFAULT_LIMIT) {
  const normalizedLang = normalizeReviewLang(lang);
  const cappedLimit = Math.min(Math.max(limit, 1), REVIEW_SUGGESTIONS_MAX_LIMIT);
  const cacheKey = `${normalizedLang}:${cappedLimit}`;
  const now = Date.now();

  const cached = cache.reviewSuggestions.data[cacheKey];
  if (cached && (now - cached.timestamp) < REVIEW_SUGGESTIONS_CACHE_TTL_MS) {
    return {
      ...cached.payload,
      cacheAge: Math.round((now - cached.timestamp) / 1000),
    };
  }

  const [proMatches, publicMatches, heroConstants] = await Promise.all([
    getProMatches(100, { forceRefresh: true }),
    getPublicMatches(100, { highMmr: true, forceRefresh: true }),
    getHeroConstants(),
  ]);

  const recent = (proMatches || [])
    .filter((match) => match.match_id && (match.duration || 0) > 0)
    .slice(0, cappedLimit)
    .map((match) => ({
      ...formatProMatch(match, heroConstants, normalizedLang),
      kind: 'recent',
    }));

  const highMmr = selectReviewHighMmrPublicMatches(publicMatches || [], cappedLimit)
    .map((match) => ({
      ...formatPublicMatch(match, heroConstants, normalizedLang),
      kind: 'highMmr',
    }));

  const payload = {
    recent,
    highMmr,
    count: recent.length + highMmr.length,
    source: 'opendota',
    cacheAge: 0,
  };

  cache.reviewSuggestions.data[cacheKey] = { payload, timestamp: now };

  return payload;
}

function formatProMatch(match, heroConstants, lang = 'zh') {
  const isZh = lang === 'zh';
  const radiantHeroes = [];
  const direHeroes = [];
  
  if (match.radiant_team && match.dire_team) {
    return {
      matchId: match.match_id,
      startTime: match.start_time,
      duration: match.duration,
      radiantWin: match.radiant_win,
      radiantTeam: match.radiant_name || (isZh ? '天辉' : 'Radiant'),
      direTeam: match.dire_name || (isZh ? '夜魇' : 'Dire'),
      leagueName: match.league_name || (isZh ? '职业比赛' : 'Pro Match'),
      radiantScore: match.radiant_score,
      direScore: match.dire_score,
      opendotaUrl: `https://www.opendota.com/matches/${match.match_id}`
    };
  }
  
  return {
    matchId: match.match_id,
    startTime: match.start_time,
    duration: match.duration,
    radiantWin: match.radiant_win,
    radiantTeam: match.radiant_name || (isZh ? '天辉' : 'Radiant'),
    direTeam: match.dire_name || (isZh ? '夜魇' : 'Dire'),
    leagueName: match.league_name || (isZh ? '职业比赛' : 'Pro Match'),
    opendotaUrl: `https://www.opendota.com/matches/${match.match_id}`
  };
}

function formatPublicMatch(match, heroConstants, lang = 'zh') {
  const isZh = lang === 'zh';
  
  const parseHeroIds = (heroData) => {
    if (!heroData) return [];
    if (Array.isArray(heroData)) {
      return heroData.map(id => parseInt(id)).filter(id => !isNaN(id) && id > 0);
    }
    if (typeof heroData === 'string') {
      return heroData.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id) && id > 0);
    }
    return [];
  };
  
  const radiantHeroIds = parseHeroIds(match.radiant_team);
  const direHeroIds = parseHeroIds(match.dire_team);
  
  const getHeroNames = (heroIds) => {
    return heroIds.map(id => {
      const cnData = HERO_NAMES_CN[id];
      const constant = Object.values(heroConstants).find(h => h.id === id);
      if (isZh && cnData?.nameZh) return cnData.nameZh;
      return constant?.localized_name || `Hero#${id}`;
    });
  };
  
  const getHeroInfos = (heroIds) => {
    return heroIds.map(id => {
      const cnData = HERO_NAMES_CN[id];
      const constant = Object.values(heroConstants).find(h => h.id === id);
      const shortName = constant?.name?.replace('npc_dota_hero_', '') || '';
      return {
        id,
        name: isZh && cnData?.nameZh ? cnData.nameZh : (constant?.localized_name || `Hero#${id}`),
        nameZh: cnData?.nameZh || constant?.localized_name || `Hero#${id}`,
        nameEn: constant?.localized_name || `Hero#${id}`,
        icon: shortName ? `${VALVE_CDN}/apps/dota2/images/dota_react/heroes/icons/${shortName}.png` : null
      };
    });
  };
  
  const { avgMmr, mmrLabel } = resolvePublicMatchSkill(match, lang);
  
  return {
    matchId: match.match_id,
    startTime: match.start_time,
    duration: match.duration,
    radiantWin: match.radiant_win,
    avgMmr,
    mmrLabel,
    radiantHeroes: getHeroInfos(radiantHeroIds),
    direHeroes: getHeroInfos(direHeroIds),
    radiantHeroNames: getHeroNames(radiantHeroIds),
    direHeroNames: getHeroNames(direHeroIds),
    opendotaUrl: `https://www.opendota.com/matches/${match.match_id}`
  };
}

async function getRecentProMatchEvidence(heroIds = [], limit = 5) {
  const proMatches = await getProMatches(50);
  const heroConstants = await getHeroConstants();
  
  if (!proMatches || proMatches.length === 0) {
    return { matches: [], summary: '' };
  }
  
  const recentMatches = proMatches.slice(0, limit).map(m => formatProMatch(m, heroConstants, 'zh'));
  
  let summary = `最近${recentMatches.length}场职业比赛：\n`;
  for (const match of recentMatches) {
    const winner = match.radiantWin ? match.radiantTeam : match.direTeam;
    const durationMin = Math.floor((match.duration || 0) / 60);
    summary += `- ${match.radiantTeam} vs ${match.direTeam} (${match.leagueName}) - ${winner}胜 (${durationMin}分钟)\n`;
  }
  
  return { matches: recentMatches, summary };
}

async function getRecentPublicMatchEvidence(heroIds = [], limit = 5) {
  try {
    const publicMatches = await getPublicMatches(50);
    const heroConstants = await getHeroConstants();
    
    if (!publicMatches || publicMatches.length === 0) {
      return { matches: [], summary: '' };
    }
    
    const parseTeamIds = (teamData) => {
      if (Array.isArray(teamData)) {
        return teamData.map(id => parseInt(id)).filter(id => !isNaN(id) && id > 0);
      }
      if (typeof teamData === 'string') {
        return teamData.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id) && id > 0);
      }
      return [];
    };
    
    let relevantMatches = publicMatches.filter(match => {
      const radiantIds = parseTeamIds(match.radiant_team);
      const direIds = parseTeamIds(match.dire_team);
      return radiantIds.length > 0 || direIds.length > 0;
    });
    
    if (heroIds.length > 0) {
      relevantMatches = relevantMatches.filter(match => {
        const radiantIds = parseTeamIds(match.radiant_team);
        const direIds = parseTeamIds(match.dire_team);
        const allIds = [...radiantIds, ...direIds];
        return heroIds.some(hid => allIds.includes(hid));
      });
    }
    
    const matchesToUse = [];
    for (const m of relevantMatches.slice(0, limit)) {
      try {
        matchesToUse.push(formatPublicMatch(m, heroConstants, 'zh'));
      } catch (formatErr) {
        console.error('Error formatting match for evidence:', formatErr.message);
      }
    }
    
    if (matchesToUse.length === 0) {
      return { matches: [], summary: '' };
    }
    
    let summary = `最近${matchesToUse.length}场高分对局样本：\n`;
    for (const match of matchesToUse) {
      const winner = match.radiantWin ? '天辉' : '夜魇';
      const durationMin = Math.floor((match.duration || 0) / 60);
      const radiantStr = match.radiantHeroNames.slice(0, 3).join(', ');
      const direStr = match.direHeroNames.slice(0, 3).join(', ');
      summary += `- [${match.mmrLabel || 'N/A'}] ${radiantStr}... vs ${direStr}... - ${winner}胜 (${durationMin}分钟)\n`;
    }
    
    return { matches: matchesToUse, summary };
  } catch (err) {
    console.error('getRecentPublicMatchEvidence error:', err.message);
    return { matches: [], summary: '' };
  }
}

// ============ Steam Web API Integration (Optional) ============

async function getSteamHeroes(language = 'schinese') {
  if (!steamApiKey) return null;
  
  const cacheKey = language === 'schinese' ? 'steamHeroesZh' : 'steamHeroesEn';
  const now = Date.now();
  
  if (cache[cacheKey].data && (now - cache[cacheKey].timestamp) < CONSTANTS_CACHE_TTL_MS) {
    return cache[cacheKey].data;
  }
  
  try {
    const url = `${STEAM_API}/IEconDOTA2_570/GetHeroes/v1/?key=${steamApiKey}&language=${language}`;
    const data = await fetchWithRetry(url, 2, 1000);
    
    if (data?.result?.heroes) {
      const heroMap = {};
      for (const hero of data.result.heroes) {
        heroMap[hero.id] = {
          id: hero.id,
          name: hero.name,
          localizedName: hero.localized_name
        };
      }
      cache[cacheKey] = { data: heroMap, timestamp: now };
      console.log(`Loaded ${Object.keys(heroMap).length} heroes from Steam API (${language})`);
      return heroMap;
    }
    return null;
  } catch (err) {
    console.error(`Failed to fetch Steam heroes (${language}):`, err.message);
    return cache[cacheKey].data || null;
  }
}

// Merge OpenDota hero data with curated Chinese names
async function getMergedHeroMeta(lang = 'zh') {
  const [heroConstants, heroStats] = await Promise.all([
    getHeroConstants(),
    getHeroStats(),
  ]);
  
  const mergedHeroes = {};
  
  for (const [heroId, hero] of Object.entries(heroConstants)) {
    const id = parseInt(heroId);
    const stats = heroStats[id];
    const cnData = HERO_NAMES_CN[id];
    const shortName = hero.name?.replace('npc_dota_hero_', '') || '';
    const nameEn = hero.localized_name || hero.name;
    const nameZh = cnData?.nameZh || nameEn;
    
    mergedHeroes[id] = {
      id,
      name: nameEn,
      nameZh,
      nameEn,
      aliases: cnData?.aliases || [],
      internalName: hero.name,
      shortName,
      primaryAttr: hero.primary_attr,
      attackType: hero.attack_type,
      roles: hero.roles || [],
      rolesZh: translateRoles(hero.roles, 'zh'),
      img: `${VALVE_CDN}/apps/dota2/images/dota_react/heroes/${shortName}.png`,
      imgVert: `${VALVE_CDN}/apps/dota2/images/heroes/${shortName}_vert.jpg`,
      icon: `${VALVE_CDN}/apps/dota2/images/dota_react/heroes/icons/${shortName}.png`,
      winRate: stats?.winRate || null,
      pickRate: stats?.pickRate || null
    };
  }
  
  return mergedHeroes;
}

// Get lean hero list for frontend
async function getLeanHeroMeta(lang = 'zh') {
  const heroes = await getMergedHeroMeta(lang);
  return Object.values(heroes).map(h => ({
    id: h.id,
    name: lang === 'zh' ? h.nameZh : h.nameEn,
    nameZh: h.nameZh,
    nameEn: h.nameEn,
    aliases: h.aliases || [],
    shortName: h.shortName,
    primaryAttr: h.primaryAttr,
    roles: h.roles,
    rolesZh: h.rolesZh || [],
    img: h.img,
    imgVert: h.imgVert,
    icon: h.icon,
    winRate: h.winRate
  })).sort((a, b) => a.name.localeCompare(b.name, lang === 'zh' ? 'zh-CN' : 'en'));
}

// Get lean item list for frontend
async function getLeanItemMeta() {
  const items = await getItemConstants();
  return Object.entries(items)
    .filter(([key, item]) => !item.recipe && item.cost > 0)
    .map(([key, item]) => ({
      id: item.id,
      key,
      name: item.dname || key,
      cost: item.cost,
      img: `${VALVE_CDN}/apps/dota2/images/dota_react/items/${key}.png`,
      components: item.components || [],
      isNeutral: item.tier !== undefined
    }))
    .sort((a, b) => (a.cost || 0) - (b.cost || 0));
}

async function getHeroStats(fetchOptions = {}) {
  const now = Date.now();
  if (cache.heroStats.data && (now - cache.heroStats.timestamp) < CACHE_TTL_MS) {
    return cache.heroStats.data;
  }
  try {
    const data = await fetchWithRetry(`${OPENDOTA_API}/heroStats`, 2, 500, fetchOptions);
    const statsMap = {};
    for (const hero of data) {
      const proPick = hero.pro_pick || 0;
      const proWin = hero.pro_win || 0;
      const pubPick = hero['1_pick'] || 0;
      const pubWin = hero['1_win'] || 0;
      
      let winRate = null;
      let gamesPlayed = 0;
      if (proPick >= MIN_GAMES_FOR_RELIABLE_WR) {
        winRate = ((proWin / proPick) * 100).toFixed(1);
        gamesPlayed = proPick;
      } else if (pubPick >= MIN_GAMES_FOR_RELIABLE_WR) {
        winRate = ((pubWin / pubPick) * 100).toFixed(1);
        gamesPlayed = pubPick;
      }
      
      statsMap[hero.id] = {
        id: hero.id,
        name: hero.localized_name,
        internalName: hero.name,
        winRate,
        gamesPlayed,
        pickRate: proPick || pubPick,
        roles: hero.roles || []
      };
    }
    cache.heroStats = { data: statsMap, timestamp: now };
    return statsMap;
  } catch (err) {
    console.error('Failed to fetch heroStats:', err.message);
    return cache.heroStats.data || {};
  }
}

async function getHeroMatchups(heroId) {
  const now = Date.now();
  const cached = cache.matchups.get(heroId);
  if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
    return cached.data;
  }
  try {
    const data = await fetchWithRetry(`${OPENDOTA_API}/heroes/${heroId}/matchups`);
    const matchupMap = {};
    for (const m of data) {
      if (m.games_played > 0) {
        matchupMap[m.hero_id] = {
          heroId: m.hero_id,
          gamesPlayed: m.games_played,
          wins: m.wins,
          winRate: ((m.wins / m.games_played) * 100).toFixed(1),
          advantage: (((m.wins / m.games_played) - 0.5) * 100).toFixed(1)
        };
      }
    }
    cache.matchups.set(heroId, { data: matchupMap, timestamp: now });
    return matchupMap;
  } catch (err) {
    console.error(`Failed to fetch matchups for hero ${heroId}:`, err.message);
    return cached?.data || {};
  }
}

async function getHeroItemPopularity(heroId) {
  const now = Date.now();
  const cached = cache.itemPopularity.get(heroId);
  if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
    return cached.data;
  }
  try {
    const data = await fetchWithRetry(`${OPENDOTA_API}/heroes/${heroId}/itemPopularity`);
    const itemConstants = await getItemConstants();
    
    const formatItems = (itemCounts) => {
      if (!itemCounts) return [];
      return Object.entries(itemCounts)
        .map(([itemIdStr, count]) => {
          const itemId = parseInt(itemIdStr);
          const itemEntry = Object.entries(itemConstants).find(([_, item]) => item.id === itemId);
          const itemKey = itemEntry?.[0] || itemIdStr;
          const item = itemEntry?.[1];
          return {
            id: itemId,
            key: itemKey,
            name: item?.dname || itemKey,
            count: count,
            cost: item?.cost || 0,
            img: `${VALVE_CDN}/apps/dota2/images/dota_react/items/${itemKey}.png`
          };
        })
        .filter(i => i.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
    };
    
    const popularity = {
      startGame: formatItems(data.start_game_items),
      earlyGame: formatItems(data.early_game_items),
      midGame: formatItems(data.mid_game_items),
      lateGame: formatItems(data.late_game_items)
    };
    
    cache.itemPopularity.set(heroId, { data: popularity, timestamp: now });
    return popularity;
  } catch (err) {
    console.error(`Failed to fetch item popularity for hero ${heroId}:`, err.message);
    return cached?.data || { startGame: [], earlyGame: [], midGame: [], lateGame: [] };
  }
}


async function getHeroBenchmarks(heroId, options = {}) {
  const now = Date.now();
  const cached = cache.benchmarks.get(heroId);
  if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
    return cached.data;
  }
  try {
    const data = await fetchWithRetry(
      `${OPENDOTA_API}/benchmarks?hero_id=${heroId}`,
      2,
      500,
      options,
    );
    cache.benchmarks.set(heroId, { data, timestamp: now });
    return data;
  } catch (err) {
    console.error(`Failed to fetch benchmarks for hero ${heroId}:`, err.message);
    return cached?.data || null;
  }
}

async function enrichMatchFactWithOpenDota(matchFact, lang, fetchOpts = {}) {
  const focusId = matchFact?.focusHeroId;
  if (!focusId) return matchFact;
  try {
    const [benchmarks, itemPopularity, matchupsMap] = await Promise.all([
      getHeroBenchmarks(focusId, fetchOpts),
      getHeroItemPopularity(focusId),
      getHeroMatchups(focusId),
    ]);
    const enrichment = buildHeroEnrichmentPayload({
      matchFact,
      benchmarks,
      itemPopularity,
      matchupsMap,
      lang,
    });
    if (!enrichment) return matchFact;
    return attachEnrichmentToMatchFact(matchFact, enrichment);
  } catch (err) {
    console.error('OpenDota enrichment failed (continuing without):', err.message);
    return matchFact;
  }
}

async function aggregateMatchupData(radiantIds, direIds, heroStats) {
  const allMatchups = {};
  const heroIdsToFetch = [...radiantIds, ...direIds];
  
  await Promise.all(heroIdsToFetch.map(async (id) => {
    allMatchups[id] = await getHeroMatchups(id);
  }));
  
  const analysis = {
    radiantAdvantages: [],
    direAdvantages: [],
    radiantCounters: [],
    direCounters: [],
    radiantSynergies: [],
    direSynergies: []
  };
  
  for (const radId of radiantIds) {
    const radName = heroStats[radId]?.name || `Hero#${radId}`;
    const radMatchups = allMatchups[radId] || {};
    
    for (const direId of direIds) {
      const direName = heroStats[direId]?.name || `Hero#${direId}`;
      const matchup = radMatchups[direId];
      
      if (matchup && matchup.gamesPlayed >= 50) {
        const adv = parseFloat(matchup.advantage);
        if (adv > 2) {
          analysis.radiantAdvantages.push({
            hero: radName,
            vsHero: direName,
            advantage: adv,
            winRate: matchup.winRate,
            games: matchup.gamesPlayed
          });
        } else if (adv < -2) {
          analysis.direAdvantages.push({
            hero: direName,
            vsHero: radName,
            advantage: -adv,
            winRate: (100 - parseFloat(matchup.winRate)).toFixed(1),
            games: matchup.gamesPlayed
          });
        }
      }
    }
  }
  
  analysis.radiantAdvantages.sort((a, b) => b.advantage - a.advantage);
  analysis.direAdvantages.sort((a, b) => b.advantage - a.advantage);
  
  return analysis;
}

function buildGroundedPrompt(radiant, dire, heroStats, matchupAnalysis, lang, userContext, isGrounded, heroConstants = {}, proMatchEvidence = null) {
  const isZh = lang === 'zh';
  
  const t = {
    radiant: isZh ? '天辉' : 'Radiant',
    dire: isZh ? '夜魇' : 'Dire',
    none: isZh ? '无' : 'None',
    winRate: isZh ? '胜率' : 'WR',
    games: isZh ? '场' : 'games',
    advantage: isZh ? '优势' : 'advantage',
    vs: isZh ? '对' : 'vs',
    statsTitle: isZh ? 'OpenDota 真实数据' : 'OpenDota Real Data',
    radiantHeroes: isZh ? '天辉英雄' : 'Radiant Heroes',
    direHeroes: isZh ? '夜魇英雄' : 'Dire Heroes',
    radiantAdvantages: isZh ? '天辉优势对位' : 'Radiant Favorable Matchups',
    direAdvantages: isZh ? '夜魇优势对位' : 'Dire Favorable Matchups',
    dataUnavailable: isZh ? '⚠️ OpenDota 数据暂时不可用，以下分析未经数据验证，请谨慎参考' : '⚠️ OpenDota data unavailable, analysis unverified - use with caution',
    userContext: isZh ? '用户补充信息' : 'User Context',
    incompleteNote: isZh ? '如果阵容不完整，请针对已选英雄给出建议。' : 'If draft is incomplete, provide suggestions for selected heroes.',
    lowSample: isZh ? '样本较少' : 'low sample',
    attr: isZh ? '属性' : 'Attr',
    roles: isZh ? '定位' : 'Roles',
    globalWR: isZh ? '全局胜率' : 'Global WR',
    sampleSize: isZh ? '样本' : 'sample',
    proMatchEvidence: isZh ? '近期职业比赛参考' : 'Recent Pro Match Reference'
  };

  const attrNames = {
    str: isZh ? '力量' : 'STR',
    agi: isZh ? '敏捷' : 'AGI',
    int: isZh ? '智力' : 'INT',
    all: isZh ? '全能' : 'UNI'
  };

  const radiantNames = radiant.map(h => {
    const cnData = HERO_NAMES_CN[h.id];
    return isZh && cnData?.nameZh ? cnData.nameZh : h.name;
  }).join(', ');
  
  const direNames = dire.map(h => {
    const cnData = HERO_NAMES_CN[h.id];
    return isZh && cnData?.nameZh ? cnData.nameZh : h.name;
  }).join(', ');
  
  const formatHeroDetailed = (h) => {
    const s = heroStats[h.id];
    const c = Object.values(heroConstants).find(hc => hc.id === h.id);
    const cnData = HERO_NAMES_CN[h.id];
    
    const heroName = isZh && cnData?.nameZh ? cnData.nameZh : (s?.name || h.name);
    const attr = c?.primary_attr ? attrNames[c.primary_attr] : '';
    const roles = (c?.roles || s?.roles || []).slice(0, 3);
    const rolesStr = isZh ? translateRoles(roles, 'zh').join('/') : roles.join('/');
    const wrStr = s?.winRate ? `${s.winRate}%` : 'N/A';
    const gamesStr = s?.gamesPlayed ? `${s.gamesPlayed}${t.games}` : '';
    
    let info = `**${heroName}**`;
    if (attr || rolesStr) {
      info += ` [${attr}${attr && rolesStr ? ' ' : ''}${rolesStr}]`;
    }
    info += ` — ${t.globalWR}: ${wrStr}`;
    if (gamesStr) {
      info += ` (${t.sampleSize}: ${gamesStr})`;
    }
    
    return info;
  };
  
  let statsSection = '';
  if (isGrounded) {
    const radiantStats = radiant.length > 0 
      ? radiant.map(formatHeroDetailed).join('\n- ') 
      : t.none;
    const direStats = dire.length > 0 
      ? dire.map(formatHeroDetailed).join('\n- ') 
      : t.none;
    
    statsSection = `
## 📊 ${t.statsTitle}

### ${t.radiantHeroes}:
- ${radiantStats}

### ${t.direHeroes}:
- ${direStats}
`;

    if (matchupAnalysis.radiantAdvantages.length > 0) {
      statsSection += `
### ✅ ${t.radiantAdvantages}:
${matchupAnalysis.radiantAdvantages.slice(0, 5).map(a => {
  const sampleNote = a.games < 100 ? ` ⚠️${t.lowSample}` : '';
  return `- ${a.hero} ${t.vs} ${a.vsHero}: **+${a.advantage}%** ${t.advantage} (${a.winRate}% ${t.winRate}, ${a.games}${t.games}${sampleNote})`;
}).join('\n')}
`;
    }
    
    if (matchupAnalysis.direAdvantages.length > 0) {
      statsSection += `
### ❌ ${t.direAdvantages}:
${matchupAnalysis.direAdvantages.slice(0, 5).map(a => {
  const sampleNote = a.games < 100 ? ` ⚠️${t.lowSample}` : '';
  return `- ${a.hero} ${t.vs} ${a.vsHero}: **+${a.advantage}%** ${t.advantage} (${a.winRate}% ${t.winRate}, ${a.games}${t.games}${sampleNote})`;
}).join('\n')}
`;
    }
    
    if (matchupAnalysis.radiantAdvantages.length === 0 && matchupAnalysis.direAdvantages.length === 0) {
      statsSection += `
### ${isZh ? '对位数据' : 'Matchup Data'}:
${isZh ? '暂无显著对位优劣势数据（可能是样本不足或对位较为均衡）' : 'No significant matchup advantages found (may be insufficient samples or balanced matchups)'}
`;
    }
  } else {
    statsSection = `\n${t.dataUnavailable}\n`;
  }

  const contextSection = userContext 
    ? `\n**${t.userContext}:** ${userContext}\n`
    : '';

  let proMatchSection = '';
  if (proMatchEvidence && proMatchEvidence.summary) {
    proMatchSection = `
## 🏆 ${t.proMatchEvidence}
${proMatchEvidence.summary}
`;
  }

  return `${isZh ? '分析这场 DOTA 2 对局' : 'Analyze this DOTA 2 match'}:

**${t.radiant}:** ${radiantNames || t.none}
**${t.dire}:** ${direNames || t.none}
${statsSection}${proMatchSection}${contextSection}
${t.incompleteNote}`;
}

function getDraftSystemInstruction(lang) {
  const isZh = lang === 'zh';
  
  const langNote = isZh 
    ? '请使用中文(简体)回答。' 
    : 'Please respond in English.';

  if (isZh) {
    return `你是一位职业DOTA2分析师和教练（如Ceb、Notail级别）。
你的任务是基于OpenDota统计数据分析天辉vs夜魇的阵容对抗。

【核心规则】
1. 必须引用OpenDota提供的具体数据（对位胜率、样本数）作为分析依据
2. 禁止编造任何统计数据——如果数据不可用，明确说明"数据不足"
3. 分析英雄时考虑其定位（核心/辅助）、属性（力量/敏捷/智力）、关键能力
4. 样本数少于50场的对位数据，需标注"样本较少，参考价值有限"

【输出格式】
## 🧠 分析思路
（逐步推理：阵容特点、对位关系、节奏曲线、关键时机）

## 📊 数据依据
（引用具体OpenDota数据：胜率X%，样本N场）

## ⚔️ 关键对位
（哪些英雄克制/被克制，引用具体数据）

## 🎯 结论：胜率预测与取胜条件
（明确给出预测胜率范围和取胜关键点）

## 💡 推荐装备
（基于敌方阵容的针对性装备建议）

使用DOTA2术语（BKB、power spike、肉山控制等）。保持简洁专业。`;
  }
  
  return `You are a professional DOTA 2 analyst and coach (like Ceb or Notail).
Your task is to analyze Radiant vs Dire compositions using OpenDota statistics.

【CORE RULES】
1. MUST cite specific OpenDota data (matchup win rates, sample sizes) as basis for analysis
2. NEVER invent statistics — if data unavailable, explicitly state "insufficient data"
3. Consider hero roles (Carry/Support), attributes (STR/AGI/INT), and key abilities
4. Mark matchups with <50 games sample as "low sample, limited reliability"

【OUTPUT FORMAT】
## 🧠 Analysis Reasoning
(Step-by-step: lineup traits, matchups, power curves, key timings)

## 📊 Data Evidence
(Cite specific OpenDota data: X% win rate, N games sample)

## ⚔️ Key Matchups
(Which heroes counter/get countered, with specific data)

## 🎯 Conclusion: Win Probability & Conditions
(Clear prediction range and winning conditions)

## 💡 Recommended Items
(Counter-picks based on enemy lineup)

Use DOTA 2 terminology (BKB, power spike, Roshan control). Be concise and professional.
${langNote}`;
}

const LORE_SYSTEM_INSTRUCTION = `
You are the Shopkeeper from the Secret Shop in DOTA 2. 
You are mysterious, ancient, and knowledgeable about the lore of the Ancients.
Answer questions about hero backstories, item lore, and the history of the world.
Speak in a slightly archaic, mystical tone.
`;

app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0'
  });
});

app.get('/api/health', async (req, res) => {
  const heroConstantsLoaded = cache.heroes.data !== null;
  const itemConstantsLoaded = cache.items.data !== null;
  const abilityConstantsLoaded = cache.abilities.data !== null;
  
  res.status(200).json({ 
    status: 'healthy',
    apiKeyConfigured: !!apiKey,
    model: DEEPSEEK_MODEL,
    provider: 'deepseek',
    opendotaConstants: {
      heroes: heroConstantsLoaded,
      items: itemConstantsLoaded,
      abilities: abilityConstantsLoaded,
      herosCacheAge: heroConstantsLoaded ? Math.round((Date.now() - cache.heroes.timestamp) / 1000) : null,
      itemsCacheAge: itemConstantsLoaded ? Math.round((Date.now() - cache.items.timestamp) / 1000) : null
    },
    chineseNameMapping: {
      heroCount: Object.keys(HERO_NAMES_CN).length,
      source: 'curated'
    }
  });
});

// ============ Meta API Endpoints ============

app.get('/api/meta/heroes', async (req, res) => {
  try {
    const lang = req.query.lang || 'zh';
    const heroes = await getLeanHeroMeta(lang);
    res.json({ 
      heroes,
      count: heroes.length,
      chineseNamesAvailable: Object.keys(HERO_NAMES_CN).length > 0,
      cacheAge: cache.heroes.timestamp ? Math.round((Date.now() - cache.heroes.timestamp) / 1000) : null
    });
  } catch (err) {
    console.error('Meta heroes error:', err);
    res.status(500).json({ error: 'Failed to fetch hero meta', heroes: [] });
  }
});

app.get('/api/meta/items', async (req, res) => {
  try {
    const items = await getLeanItemMeta();
    res.json({ 
      items,
      count: items.length,
      cacheAge: cache.items.timestamp ? Math.round((Date.now() - cache.items.timestamp) / 1000) : null
    });
  } catch (err) {
    console.error('Meta items error:', err);
    res.status(500).json({ error: 'Failed to fetch item meta', items: [] });
  }
});

app.get('/api/meta/abilities', async (req, res) => {
  try {
    const abilities = await getAbilityConstants();
    const leanAbilities = Object.entries(abilities)
      .filter(([key, ability]) => ability.dname && !key.startsWith('special_'))
      .map(([key, ability]) => ({
        key,
        name: ability.dname,
        description: ability.desc,
        img: ability.img ? `${VALVE_CDN}${ability.img}` : null,
        behavior: ability.behavior,
        dmgType: ability.dmg_type,
        cooldown: ability.cd,
        manaCost: ability.mc
      }))
      .slice(0, 500);
    
    res.json({ 
      abilities: leanAbilities,
      count: leanAbilities.length,
      cacheAge: cache.abilities.timestamp ? Math.round((Date.now() - cache.abilities.timestamp) / 1000) : null
    });
  } catch (err) {
    console.error('Meta abilities error:', err);
    res.status(500).json({ error: 'Failed to fetch ability meta', abilities: [] });
  }
});

// ============ Hero Detail API ============
app.get('/api/meta/heroes/:heroId', async (req, res) => {
  try {
    const heroId = parseInt(req.params.heroId);
    const lang = req.query.lang || 'zh';
    
    if (isNaN(heroId)) {
      return res.status(400).json({ error: 'Invalid hero ID' });
    }
    
    const [heroConstants, heroStats, abilities] = await Promise.all([
      getHeroConstants(),
      getHeroStats(),
      getAbilityConstants(),
    ]);
    
    const heroConstant = Object.values(heroConstants).find(h => h.id === heroId);
    if (!heroConstant) {
      return res.status(404).json({ error: 'Hero not found' });
    }
    
    const stats = heroStats[heroId];
    const cnData = HERO_NAMES_CN[heroId];
    const shortName = heroConstant.name?.replace('npc_dota_hero_', '') || '';
    const nameEn = heroConstant.localized_name || heroConstant.name;
    const nameZh = cnData?.nameZh || nameEn;
    
    const heroAbilityKeys = Object.keys(abilities).filter(key => {
      return key.startsWith(shortName + '_') && 
             !key.includes('special_') && 
             !key.endsWith('_empty') &&
             abilities[key].dname;
    });
    
    const heroAbilities = heroAbilityKeys.map(key => {
      const ability = abilities[key];
      return {
        key,
        name: ability.dname,
        description: ability.desc || '',
        lore: ability.lore || '',
        img: ability.img ? `${VALVE_CDN}${ability.img}` : null,
        behavior: ability.behavior,
        dmgType: ability.dmg_type,
        bkbPierce: ability.bkbpierce,
        dispellable: ability.dispellable,
        cooldown: ability.cd,
        manaCost: ability.mc,
        isUltimate: key.includes('ultimate') || 
                    (ability.behavior && ability.behavior.includes('DOTA_ABILITY_BEHAVIOR_ULTIMATE'))
      };
    }).sort((a, b) => (a.isUltimate ? 1 : 0) - (b.isUltimate ? 1 : 0));
    
    const bioFromConstant = heroConstant.bio || heroConstant.hype || '';
    
    const heroDetail = {
      id: heroId,
      name: lang === 'zh' ? nameZh : nameEn,
      nameZh,
      nameEn,
      aliases: cnData?.aliases || [],
      internalName: heroConstant.name,
      shortName,
      primaryAttr: heroConstant.primary_attr,
      attackType: heroConstant.attack_type,
      roles: heroConstant.roles || [],
      rolesZh: translateRoles(heroConstant.roles, 'zh'),
      img: `${VALVE_CDN}/apps/dota2/images/dota_react/heroes/${shortName}.png`,
      imgFull: `${VALVE_CDN}/apps/dota2/images/dota_react/heroes/crops/${shortName}.png`,
      imgVert: `${VALVE_CDN}/apps/dota2/images/heroes/${shortName}_vert.jpg`,
      icon: `${VALVE_CDN}/apps/dota2/images/dota_react/heroes/icons/${shortName}.png`,
      winRate: stats?.winRate || null,
      pickRate: stats?.pickRate || null,
      gamesPlayed: stats?.gamesPlayed || null,
      abilities: heroAbilities,
      bio: bioFromConstant || (lang === 'zh' ? '暂无官方背景' : 'No official lore available'),
      baseStats: {
        baseHealth: heroConstant.base_health,
        baseMana: heroConstant.base_mana,
        baseArmor: heroConstant.base_armor,
        baseMr: heroConstant.base_mr,
        baseAttackMin: heroConstant.base_attack_min,
        baseAttackMax: heroConstant.base_attack_max,
        baseStr: heroConstant.base_str,
        baseAgi: heroConstant.base_agi,
        baseInt: heroConstant.base_int,
        strGain: heroConstant.str_gain,
        agiGain: heroConstant.agi_gain,
        intGain: heroConstant.int_gain,
        attackRange: heroConstant.attack_range,
        moveSpeed: heroConstant.move_speed,
      },
      complexity: heroConstant.complexity || null,
    };
    
    res.json({
      hero: heroDetail,
      source: 'opendota',
      cacheAge: cache.heroes.timestamp ? Math.round((Date.now() - cache.heroes.timestamp) / 1000) : null
    });
  } catch (err) {
    console.error('Hero detail error:', err);
    res.status(500).json({ error: 'Failed to fetch hero detail' });
  }
});

// ============ Pro Matches API ============
app.get('/api/meta/pro-matches', async (req, res) => {
  try {
    const lang = req.query.lang || 'zh';
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    
    const [proMatches, heroConstants] = await Promise.all([
      getProMatches(limit),
      getHeroConstants()
    ]);
    
    if (!proMatches || proMatches.length === 0) {
      return res.json({ 
        matches: [], 
        count: 0, 
        source: 'opendota',
        error: lang === 'zh' ? '暂无职业比赛数据' : 'No pro match data available'
      });
    }
    
    const formattedMatches = proMatches.map(m => formatProMatch(m, heroConstants, lang));
    
    res.json({
      matches: formattedMatches,
      count: formattedMatches.length,
      source: 'opendota',
      cacheAge: cache.proMatches.timestamp ? Math.round((Date.now() - cache.proMatches.timestamp) / 1000) : null
    });
  } catch (err) {
    console.error('Pro matches error:', err);
    res.status(500).json({ error: 'Failed to fetch pro matches', matches: [] });
  }
});

// ============ Public Matches API (High MMR) ============
app.get('/api/meta/public-matches', async (req, res) => {
  try {
    const lang = req.query.lang || 'zh';
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const heroId = req.query.heroId ? parseInt(req.query.heroId) : null;
    
    const [publicMatches, heroConstants] = await Promise.all([
      getPublicMatches(100),
      getHeroConstants()
    ]);
    
    if (!publicMatches || publicMatches.length === 0) {
      return res.json({ 
        matches: [], 
        count: 0, 
        source: 'opendota',
        error: lang === 'zh' ? '暂无高分对局数据' : 'No public match data available'
      });
    }
    
    const parseTeamIds = (teamData) => {
      if (Array.isArray(teamData)) {
        return teamData.map(id => parseInt(id)).filter(id => !isNaN(id) && id > 0);
      }
      if (typeof teamData === 'string') {
        return teamData.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id) && id > 0);
      }
      return [];
    };
    
    let filteredMatches = publicMatches.filter(match => {
      const radiantIds = parseTeamIds(match.radiant_team);
      const direIds = parseTeamIds(match.dire_team);
      return radiantIds.length > 0 || direIds.length > 0;
    });
    
    if (heroId) {
      filteredMatches = filteredMatches.filter(match => {
        const radiantIds = parseTeamIds(match.radiant_team);
        const direIds = parseTeamIds(match.dire_team);
        return radiantIds.includes(heroId) || direIds.includes(heroId);
      });
    }
    
    const formattedMatches = [];
    for (const m of filteredMatches.slice(0, limit)) {
      try {
        formattedMatches.push(formatPublicMatch(m, heroConstants, lang));
      } catch (formatErr) {
        console.error('Error formatting public match:', formatErr.message, 'match_id:', m.match_id);
      }
    }
    
    res.json({
      matches: formattedMatches,
      count: formattedMatches.length,
      source: 'opendota',
      cacheAge: cache.publicMatches.timestamp ? Math.round((Date.now() - cache.publicMatches.timestamp) / 1000) : null
    });
  } catch (err) {
    console.error('Public matches error:', err);
    res.json({ matches: [], count: 0, source: 'opendota', error: 'Failed to fetch public matches' });
  }
});

// ============ Meta Tier API - 大盘数据 ============
app.get('/api/meta/tier', async (req, res) => {
  try {
    const lang = req.query.lang || 'zh';
    const role = req.query.role;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const sortBy = req.query.sortBy || 'winRate';
    
    const [heroStats, heroConstants] = await Promise.all([
      getHeroStats(),
      getHeroConstants(),
    ]);
    
    if (!heroStats || Object.keys(heroStats).length === 0) {
      return res.json({ heroes: [], error: 'OpenDota data unavailable', source: 'opendota' });
    }
    
    let heroes = Object.values(heroStats)
      .filter(h => h.winRate && h.gamesPlayed >= MIN_GAMES_FOR_RELIABLE_WR)
      .map(h => {
        const heroId = h.id;
        const constant = Object.values(heroConstants).find(c => c.id === heroId);
        const cnData = HERO_NAMES_CN[heroId];
        const shortName = constant?.name?.replace('npc_dota_hero_', '') || h.internalName?.replace('npc_dota_hero_', '') || '';
        const nameEn = constant?.localized_name || h.name;
        const nameZh = cnData?.nameZh || nameEn;
        
        return {
          id: heroId,
          name: lang === 'zh' ? nameZh : nameEn,
          nameZh,
          nameEn,
          shortName,
          winRate: parseFloat(h.winRate),
          pickRate: h.pickRate,
          gamesPlayed: h.gamesPlayed,
          roles: h.roles || constant?.roles || [],
          rolesZh: translateRoles(h.roles || constant?.roles || [], 'zh'),
          img: `${VALVE_CDN}/apps/dota2/images/dota_react/heroes/${shortName}.png`,
          icon: `${VALVE_CDN}/apps/dota2/images/dota_react/heroes/icons/${shortName}.png`
        };
      });
    
    if (role) {
      heroes = heroes.filter(h => h.roles.includes(role));
    }
    
    if (sortBy === 'pickRate') {
      heroes.sort((a, b) => b.pickRate - a.pickRate);
    } else {
      heroes.sort((a, b) => b.winRate - a.winRate);
    }
    
    const tierList = heroes.slice(0, limit).map((h, idx) => ({
      ...h,
      rank: idx + 1,
      tier: idx < 5 ? 'S' : idx < 12 ? 'A' : idx < 20 ? 'B' : 'C'
    }));
    
    res.json({
      heroes: tierList,
      count: tierList.length,
      totalHeroes: Object.keys(heroStats).length,
      source: 'opendota',
      dataType: 'pro/pub',
      cacheAge: cache.heroStats.timestamp ? Math.round((Date.now() - cache.heroStats.timestamp) / 1000) : null
    });
  } catch (err) {
    console.error('Meta tier error:', err);
    res.status(500).json({ error: 'Failed to fetch tier data', heroes: [] });
  }
});

// ============ Item Popularity API ============
app.get('/api/heroes/:heroId/items', async (req, res) => {
  try {
    const heroId = parseInt(req.params.heroId);
    if (isNaN(heroId)) {
      return res.status(400).json({ error: 'Invalid hero ID' });
    }
    
    const popularity = await getHeroItemPopularity(heroId);
    const heroStats = await getHeroStats();
    const heroName = heroStats[heroId]?.name || `Hero#${heroId}`;
    
    res.json({
      heroId,
      heroName,
      items: popularity,
      source: 'opendota',
      cacheAge: cache.itemPopularity.get(heroId)?.timestamp 
        ? Math.round((Date.now() - cache.itemPopularity.get(heroId).timestamp) / 1000) 
        : null
    });
  } catch (err) {
    console.error('Item popularity error:', err);
    res.status(500).json({ error: 'Failed to fetch item popularity' });
  }
});

// ============ Playbook API - 本局打法 ============
app.post('/api/playbook', async (req, res) => {
  const acceptHeader = req.headers.accept || '';
  const wantsStream = acceptHeader.includes('text/event-stream');
  
  try {
    const { allies = [], enemies = [], focusHeroId, side = 'radiant', lang = 'zh' } = req.body;
    
    if (allies.length === 0) {
      const errorMsg = lang === 'zh' ? '请先选择己方英雄' : 'Please select your heroes first';
      if (wantsStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.write(`data: ${JSON.stringify({ error: errorMsg })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      return res.status(400).json({ error: errorMsg });
    }
    
    const [heroStats, heroConstants] = await Promise.all([
      getHeroStats(),
      getHeroConstants(),
    ]);
    
    const alliedIds = allies.map(h => h.id);
    const enemyIds = enemies.map(h => h.id).filter(Boolean);
    
    const [itemPopularityResults, matchupsResults, publicMatchEvidence] = await Promise.all([
      Promise.all(alliedIds.map(id => getHeroItemPopularity(id).then(items => ({ id, items })))),
      Promise.all(alliedIds.map(id => getHeroMatchups(id).then(matchups => ({ id, matchups })))),
      getRecentPublicMatchEvidence(alliedIds, 3)
    ]);
    
    const itemPopularityMap = {};
    for (const { id, items } of itemPopularityResults) {
      itemPopularityMap[id] = items;
    }
    
    const matchupsMap = {};
    for (const { id, matchups } of matchupsResults) {
      matchupsMap[id] = matchups;
    }
    
    const playbookData = alliedIds.map(heroId => {
      const cnData = HERO_NAMES_CN[heroId];
      const nameEn = heroStats[heroId]?.name || `Hero#${heroId}`;
      const nameZh = cnData?.nameZh || nameEn;
      const heroName = lang === 'zh' ? nameZh : nameEn;
      const items = itemPopularityMap[heroId] || {};
      const matchups = matchupsMap[heroId] || {};
      
      const vsEnemies = enemyIds.map(enemyId => {
        const m = matchups[enemyId];
        if (m && m.gamesPlayed >= MIN_MATCHUP_GAMES) {
          const enemyCnData = HERO_NAMES_CN[enemyId];
          const enemyNameEn = heroStats[enemyId]?.name || `Hero#${enemyId}`;
          const enemyNameZh = enemyCnData?.nameZh || enemyNameEn;
          return {
            enemy: lang === 'zh' ? enemyNameZh : enemyNameEn,
            enemyId,
            enemyNameZh,
            enemyNameEn,
            winRate: m.winRate,
            advantage: m.advantage,
            gamesPlayed: m.gamesPlayed
          };
        }
        return null;
      }).filter(Boolean);
      
      return {
        heroId,
        heroName,
        nameZh,
        nameEn,
        winRate: heroStats[heroId]?.winRate,
        roles: heroStats[heroId]?.roles || [],
        rolesZh: translateRoles(heroStats[heroId]?.roles || [], 'zh'),
        items: {
          startGame: items.startGame?.slice(0, 5) || [],
          earlyGame: items.earlyGame?.slice(0, 5) || [],
          midGame: items.midGame?.slice(0, 5) || [],
          lateGame: items.lateGame?.slice(0, 5) || []
        },
        vsEnemies
      };
    });
    
    const focusHero = focusHeroId 
      ? playbookData.find(h => h.heroId === focusHeroId) 
      : playbookData[0];
    
    if (!apiKey || !openai) {
      if (wantsStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.write(`data: ${JSON.stringify({ playbookData, focusHero })}\n\n`);
        res.write(`data: ${JSON.stringify({ error: "DeepSeek API Key not configured - only data returned" })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      return res.json({ playbookData, focusHero, error: "DeepSeek API Key not configured" });
    }
    
    const isZh = lang === 'zh';
    const t = {
      yourTeam: isZh ? '己方阵容' : 'Your Team',
      enemies: isZh ? '敌方阵容' : 'Enemy Team',
      none: isZh ? '无' : 'None',
      focusHero: isZh ? '聚焦英雄' : 'Focus Hero',
      itemBuild: isZh ? '出装参考 (OpenDota职业/高分数据)' : 'Item Build (OpenDota Pro/High MMR)',
      startItems: isZh ? '出门装' : 'Starting',
      earlyItems: isZh ? '前期' : 'Early',
      midItems: isZh ? '中期' : 'Mid',
      lateItems: isZh ? '后期' : 'Late',
      matchupData: isZh ? '对位数据 (OpenDota)' : 'Matchup Data (OpenDota)',
      winRate: isZh ? '胜率' : 'WR',
      games: isZh ? '场' : 'games'
    };
    
    const lowSampleNote = isZh ? '⚠️样本较少' : '⚠️low sample';
    
    let statsSection = `## 📊 ${t.yourTeam}\n`;
    for (const hero of playbookData) {
      const heroRolesStr = hero.rolesZh && isZh 
        ? hero.rolesZh.slice(0, 2).join('/') 
        : (hero.roles || []).slice(0, 2).join('/');
      const heroConstant = Object.values(heroConstants).find(c => c.id === hero.heroId);
      const attrStr = heroConstant?.primary_attr 
        ? (isZh ? { str: '力量', agi: '敏捷', int: '智力', all: '全能' }[heroConstant.primary_attr] : heroConstant.primary_attr.toUpperCase())
        : '';
      
      statsSection += `\n### ${hero.heroName}`;
      if (attrStr || heroRolesStr) {
        statsSection += ` [${attrStr}${attrStr && heroRolesStr ? ' ' : ''}${heroRolesStr}]`;
      }
      statsSection += ` — ${t.winRate}: ${hero.winRate || 'N/A'}%\n`;
      
      statsSection += `**${t.itemBuild}** (${isZh ? 'OpenDota职业/高分段数据' : 'OpenDota Pro/High MMR data'}):\n`;
      if (hero.items.startGame.length > 0) {
        statsSection += `- ${t.startItems}: ${hero.items.startGame.map(i => i.name).join(', ')}\n`;
      }
      if (hero.items.earlyGame.length > 0) {
        statsSection += `- ${t.earlyItems}: ${hero.items.earlyGame.map(i => i.name).join(', ')}\n`;
      }
      if (hero.items.midGame.length > 0) {
        statsSection += `- ${t.midItems}: ${hero.items.midGame.map(i => i.name).join(', ')}\n`;
      }
      if (hero.items.lateGame.length > 0) {
        statsSection += `- ${t.lateItems}: ${hero.items.lateGame.map(i => i.name).join(', ')}\n`;
      }
      
      if (hero.vsEnemies.length > 0) {
        statsSection += `**${t.matchupData}**:\n`;
        for (const vs of hero.vsEnemies) {
          const advSign = parseFloat(vs.advantage) >= 0 ? '+' : '';
          const sampleNote = vs.gamesPlayed < 100 ? ` ${lowSampleNote}` : '';
          statsSection += `- vs ${vs.enemy}: ${vs.winRate}% ${t.winRate} (${advSign}${vs.advantage}%, ${vs.gamesPlayed}${t.games}${sampleNote})\n`;
        }
      } else {
        statsSection += `**${t.matchupData}**: ${isZh ? '暂无数据（敌方英雄未选或样本不足）' : 'No data (enemies not picked or insufficient samples)'}\n`;
      }
    }
    
    if (enemies.length > 0) {
      statsSection += `\n## 🎯 ${t.enemies}\n`;
      const enemyDetails = enemies.map(h => {
        const cnData = HERO_NAMES_CN[h.id];
        const stats = heroStats[h.id];
        const heroConstant = Object.values(heroConstants).find(c => c.id === h.id);
        const name = isZh && cnData?.nameZh ? cnData.nameZh : (stats?.name || h.name || `Hero#${h.id}`);
        const roles = (heroConstant?.roles || stats?.roles || []).slice(0, 2);
        const rolesStr = isZh ? translateRoles(roles, 'zh').join('/') : roles.join('/');
        return `${name}${rolesStr ? ` [${rolesStr}]` : ''}`;
      });
      statsSection += enemyDetails.join(', ');
    }
    
    if (publicMatchEvidence && publicMatchEvidence.summary) {
      statsSection += `\n\n## 🏆 ${isZh ? '高分对局参考' : 'High MMR Match Evidence'}\n`;
      statsSection += publicMatchEvidence.summary;
    }
    
    const systemPrompt = isZh 
      ? `你是一位职业DOTA2教练，专门为玩家提供实战指导。基于OpenDota的真实数据分析"本局怎么打才能赢"。

【核心规则】
1. 必须引用给出的OpenDota数据（出装流行度、对位胜率、样本数）作为建议依据
2. 禁止编造数据——如果某数据不可用，明确说明
3. 针对敌方阵容给出具体的装备选择和时机建议
4. 分析关键对位：哪些英雄要打哪些英雄，何时发力
5. 考虑英雄定位（核心/辅助）和强势期（前期/中期/后期）

【输出格式】
## 🧠 分析思路
（逐步推理本局的关键问题和取胜路径）

## 🎯 核心策略
（一句话概括本局核心打法）

## 🛠️ 出装路线
（引用OpenDota数据，说明为什么选这些装备）
- 聚焦英雄：[具体出装建议]
- 针对敌方：[反制装备]

## ⚔️ 对位要点
（引用对位胜率数据，说明谁打谁）

## 📋 结论：节奏与执行
- 前期(0-15min)：[具体任务]
- 中期(15-30min)：[团战/推进策略]
- 后期(30min+)：[取胜条件]

使用DOTA2术语，保持简洁实用。`
      : `You are a professional DOTA 2 coach providing game-specific strategy. Analyze "how to win THIS game" based on OpenDota real data.

【CORE RULES】
1. MUST cite provided OpenDota data (item popularity, matchup winrates, sample sizes) as basis
2. NEVER invent data — if unavailable, explicitly state so
3. Give specific item choices and timing based on enemy lineup
4. Analyze key matchups: who should fight whom and power spikes
5. Consider hero roles (Carry/Support) and timing (early/mid/late game)

【OUTPUT FORMAT】
## 🧠 Analysis Reasoning
(Step-by-step reasoning for key issues and win conditions)

## 🎯 Core Strategy
(One sentence summary of how to win this game)

## 🛠️ Item Path
(Cite OpenDota data, explain item choices)
- Focus Hero: [specific build]
- Counter Items: [against enemy lineup]

## ⚔️ Matchup Notes
(Cite matchup win rates, who fights whom)

## 📋 Conclusion: Tempo & Execution
- Early (0-15min): [specific tasks]
- Mid (15-30min): [teamfight/push strategy]
- Late (30min+): [win conditions]

Use DOTA 2 terminology, be concise and practical.`;

    const userPrompt = isZh 
      ? `请基于以下OpenDota真实数据，分析本局怎么打才能赢：

${statsSection}

**聚焦英雄**: ${focusHero?.heroName || '全队'}

【要求】
1. 分析时必须引用上述具体数据（胜率、样本数、出装流行度）
2. 如果某数据不可用或样本不足，请明确指出
3. 按照输出格式给出完整的分析思路和结论
4. 针对敌方阵容给出具体的装备和打法建议`
      : `Based on the following OpenDota real data, analyze how to win this game:

${statsSection}

**Focus Hero**: ${focusHero?.heroName || 'Team'}

【Requirements】
1. MUST cite specific data above (win rates, sample sizes, item popularity)
2. If data unavailable or low sample, explicitly state so
3. Follow the output format with complete reasoning and conclusion
4. Give specific item and strategy advice against enemy lineup`;

    if (wantsStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      
      res.write(`data: ${JSON.stringify({ playbookData, focusHero })}\n\n`);
      
      const stream = await openai.chat.completions.create({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        stream: true,
      });
      
      req.on('close', () => {
        stream.controller?.abort();
      });
      
      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content;
        if (content) {
          res.write(`data: ${JSON.stringify({ text: content })}\n\n`);
        }
      }
      
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      const response = await openai.chat.completions.create({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
      });
      
      res.json({
        playbookData,
        focusHero,
        analysis: response.choices[0].message.content,
        source: 'opendota'
      });
    }
  } catch (error) {
    console.error("Playbook Error:", error);
    const wantsStream = (req.headers.accept || '').includes('text/event-stream');
    if (wantsStream) {
      res.write(`data: ${JSON.stringify({ error: error.message || "Internal Server Error" })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.status(500).json({ error: error.message || "Internal Server Error" });
    }
  }
});

app.post('/api/analyze', async (req, res) => {
  const acceptHeader = req.headers.accept || '';
  const wantsStream = acceptHeader.includes('text/event-stream');
  
  try {
    const { radiant = [], dire = [], lang = 'zh', userContext } = req.body;
    
    if (!apiKey || !openai) {
      if (wantsStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.write(`data: ${JSON.stringify({ error: "Server API Key not configured" })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      return res.status(500).json({ error: "Server API Key not configured" });
    }

    const radiantIds = radiant.map(h => h.id).filter(Boolean);
    const direIds = dire.map(h => h.id).filter(Boolean);
    
    let heroStats = {};
    let heroConstants = {};
    let matchupAnalysis = { radiantAdvantages: [], direAdvantages: [] };
    let isGrounded = false;
    let proMatchEvidence = null;
    
    try {
      [heroStats, heroConstants] = await Promise.all([
        getHeroStats(),
        getHeroConstants()
      ]);
      if (Object.keys(heroStats).length > 0 && (radiantIds.length > 0 || direIds.length > 0)) {
        matchupAnalysis = await aggregateMatchupData(radiantIds, direIds, heroStats);
        isGrounded = true;
      }
      
      proMatchEvidence = await getRecentProMatchEvidence([], 3);
    } catch (err) {
      console.error('OpenDota fetch error:', err.message);
    }
    
    const prompt = buildGroundedPrompt(radiant, dire, heroStats, matchupAnalysis, lang, userContext, isGrounded, heroConstants, proMatchEvidence);

    const systemInstruction = getDraftSystemInstruction(lang);

    if (wantsStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const matchupSummary = {
        radiantAdvantages: matchupAnalysis.radiantAdvantages.slice(0, 5),
        direAdvantages: matchupAnalysis.direAdvantages.slice(0, 5),
        grounded: isGrounded
      };
      res.write(`data: ${JSON.stringify({ matchupData: matchupSummary, grounded: isGrounded })}\n\n`);

      const stream = await openai.chat.completions.create({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: prompt }
        ],
        stream: true,
      });

      req.on('close', () => {
        stream.controller?.abort();
      });

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content;
        if (content) {
          res.write(`data: ${JSON.stringify({ text: content, grounded: isGrounded })}\n\n`);
        }
      }
      
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      const response = await openai.chat.completions.create({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: prompt }
        ],
      });

      res.json({ 
        text: response.choices[0].message.content,
        grounded: isGrounded,
        matchupData: {
          radiantAdvantages: matchupAnalysis.radiantAdvantages.slice(0, 5),
          direAdvantages: matchupAnalysis.direAdvantages.slice(0, 5)
        }
      });
    }
  } catch (error) {
    console.error("DeepSeek Analysis Error:", error);
    if (wantsStream) {
      res.write(`data: ${JSON.stringify({ error: error.message || "Internal Server Error" })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.status(500).json({ error: error.message || "Internal Server Error" });
    }
  }
});

// Next hero suggestions based on OpenDota matchup data
app.post('/api/suggestions', async (req, res) => {
  try {
    const { allies = [], enemies = [], side = 'radiant', limit = 8, role } = req.body;
    
    const heroStats = await getHeroStats();
    if (!heroStats || Object.keys(heroStats).length === 0) {
      return res.json({ suggestions: [], error: 'OpenDota data unavailable' });
    }
    
    const alliedIds = new Set(allies.map(h => h.id));
    const enemyIds = enemies.map(h => h.id).filter(Boolean);
    const pickedIds = new Set([...allies.map(h => h.id), ...enemies.map(h => h.id)]);
    
    const enemyMatchups = {};
    await Promise.all(enemyIds.map(async (enemyId) => {
      enemyMatchups[enemyId] = await getHeroMatchups(enemyId);
    }));
    
    const heroScores = [];
    
    for (const heroId of Object.keys(heroStats)) {
      const hid = parseInt(heroId);
      if (pickedIds.has(hid)) continue;
      
      const hero = heroStats[hid];
      
      if (role && hero.roles && !hero.roles.includes(role)) {
        continue;
      }
      
      let score = 0;
      let reasons = [];
      let totalGames = 0;
      let matchupCount = 0;
      
      for (const enemyId of enemyIds) {
        const enemyMatchup = enemyMatchups[enemyId];
        if (enemyMatchup && enemyMatchup[hid]) {
          const m = enemyMatchup[hid];
          if (m.gamesPlayed >= MIN_MATCHUP_GAMES) {
            const counterAdvantage = 50 - parseFloat(m.winRate);
            const ourWinRate = (100 - parseFloat(m.winRate)).toFixed(1);
            score += counterAdvantage * Math.log10(m.gamesPlayed + 1);
            totalGames += m.gamesPlayed;
            matchupCount++;
            
            reasons.push({
              type: 'counter',
              enemy: heroStats[enemyId]?.name || `Hero#${enemyId}`,
              enemyId: parseInt(enemyId),
              advantage: counterAdvantage.toFixed(1),
              winRate: ourWinRate,
              gamesPlayed: m.gamesPlayed
            });
          }
        }
      }
      
      if (hero.winRate && hero.gamesPlayed >= MIN_GAMES_FOR_RELIABLE_WR) {
        score += (parseFloat(hero.winRate) - 50) * 0.5;
      }
      
      reasons.sort((a, b) => parseFloat(b.advantage) - parseFloat(a.advantage));
      
      const bestAdvantage = reasons.length > 0 ? parseFloat(reasons[0].advantage) : 0;
      if (enemyIds.length > 0 && matchupCount === 0) {
        continue;
      }
      
      heroScores.push({
        id: hid,
        name: hero.name,
        score: score,
        winRate: hero.winRate,
        roles: hero.roles,
        reasons: reasons.slice(0, 3),
        totalGames: totalGames,
        matchupCount: matchupCount,
        bestAdvantage: bestAdvantage
      });
    }
    
    heroScores.sort((a, b) => {
      if (b.bestAdvantage !== a.bestAdvantage) {
        return b.bestAdvantage - a.bestAdvantage;
      }
      return b.score - a.score;
    });
    
    const topHeroes = heroScores.filter(h => h.score > 0 || h.reasons.length > 0);
    const lang = req.body.lang || 'zh';
    const suggestions = topHeroes.slice(0, limit).map(h => {
      const cnData = HERO_NAMES_CN[h.id];
      return {
        id: h.id,
        name: lang === 'zh' && cnData?.nameZh ? cnData.nameZh : h.name,
        nameEn: h.name,
        nameZh: cnData?.nameZh || h.name,
        score: h.score.toFixed(1),
        winRate: h.winRate,
        roles: h.roles,
        rolesZh: translateRoles(h.roles, 'zh'),
        reasons: h.reasons.map(r => ({
          ...r,
          enemyZh: HERO_NAMES_CN[r.enemyId]?.nameZh || r.enemy
        })),
        totalGames: h.totalGames,
        bestAdvantage: h.bestAdvantage.toFixed(1)
      };
    });
    
    res.json({ suggestions });
  } catch (error) {
    console.error("Suggestions Error:", error);
    res.json({ suggestions: [], error: error.message });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { history, message, lang } = req.body;

    if (!apiKey || !openai) {
      return res.status(500).json({ error: "Server API Key not configured" });
    }

    const langInstruction = lang === 'zh' 
      ? '请使用中文(简体)回答所有问题。' 
      : 'Please answer in English.';

    const systemContent = `${LORE_SYSTEM_INSTRUCTION}\n${langInstruction}`;

    const messages = [
      { role: 'system', content: systemContent },
      ...history.map(h => ({
        role: h.role,
        content: h.parts.map(p => p.text).join('')
      })),
      { role: 'user', content: message }
    ];

    const response = await openai.chat.completions.create({
      model: DEEPSEEK_MODEL,
      messages: messages,
    });

    res.json({ text: response.choices[0].message.content });
  } catch (error) {
    console.error("DeepSeek Chat Error:", error);
    res.status(500).json({ error: error.message || "Internal Server Error" });
  }
});

// ============ Match Replay Review ============
function evictMatchDetailCache() {
  const now = Date.now();
  for (const [id, entry] of cache.matchDetails) {
    if (now - entry.timestamp > MATCH_DETAIL_CACHE_TTL_MS) {
      cache.matchDetails.delete(id);
    }
  }
  while (cache.matchDetails.size >= MATCH_DETAIL_CACHE_MAX) {
    let oldestId = null;
    let oldestTs = Infinity;
    for (const [id, entry] of cache.matchDetails) {
      if (entry.timestamp < oldestTs) {
        oldestTs = entry.timestamp;
        oldestId = id;
      }
    }
    if (oldestId === null) break;
    cache.matchDetails.delete(oldestId);
  }
}

async function getMatchDetail(matchId, fetchOptions = {}) {
  evictMatchDetailCache();
  const cached = cache.matchDetails.get(matchId);
  if (cached && Date.now() - cached.timestamp < MATCH_DETAIL_CACHE_TTL_MS) {
    return cached.data;
  }

  const data = await fetchWithRetry(`${OPENDOTA_API}/matches/${matchId}`, 2, 500, fetchOptions);
  evictMatchDetailCache();
  cache.matchDetails.set(matchId, { data, timestamp: Date.now() });
  return data;
}

function sendReviewSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function endReviewSse(res, payload) {
  if (payload) sendReviewSse(res, payload);
  res.write('data: [DONE]\n\n');
  res.end();
}

function respondReviewError(res, wantsStream, errorMsg, status = 400) {
  if (wantsStream) {
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
    }
    endReviewSse(res, { error: errorMsg });
    return;
  }
  return res.status(status).json({ error: errorMsg });
}

app.get('/api/review/suggestions', async (req, res) => {
  try {
    const lang = normalizeReviewLang(req.query.lang || 'zh');
    const limit = Math.min(
      parseInt(req.query.limit, 10) || REVIEW_SUGGESTIONS_DEFAULT_LIMIT,
      REVIEW_SUGGESTIONS_MAX_LIMIT,
    );
    const suggestions = await getReviewMatchSuggestions(lang, limit);
    res.json(suggestions);
  } catch (err) {
    console.error('Review suggestions error:', err);
    const lang = normalizeReviewLang(req.query.lang || 'zh');
    res.json({
      recent: [],
      highMmr: [],
      count: 0,
      source: 'opendota',
      cacheAge: null,
      error: lang === 'zh' ? '暂时无法加载推荐比赛' : 'Failed to load match suggestions',
    });
  }
});

app.get('/api/review/:matchId', handleMatchReviewFacts);
app.post('/api/review/:matchId', handleMatchReview);

/** GET：只拉 OpenDota MatchFact，不调用 DeepSeek */
async function handleMatchReviewFacts(req, res) {
  const lang = req.query.lang ?? 'zh';
  const matchId = Number(req.params.matchId);
  const isZh = lang === 'zh';

  if (!Number.isFinite(matchId) || matchId <= 0) {
    return res.status(400).json({ error: isZh ? '无效的比赛 ID' : 'Invalid match ID' });
  }

  try {
    const [matchData, heroStats, heroConstants] = await Promise.all([
      getMatchDetail(matchId),
      getHeroStats(),
      getHeroConstants(),
    ]);
    const heroNames = buildHeroNamesMap(
      heroStats,
      matchData.players || [],
      heroConstants,
      HERO_NAMES_CN
    );
    let matchFact = buildMatchFact(matchData, { lang, heroNames });
    matchFact = await enrichMatchFactWithOpenDota(matchFact, lang);
    return res.json({ matchFact, grounded: Boolean(matchFact.grounded) });
  } catch (error) {
    console.error('Match facts error:', error);
    const errorMsg = error.message || (isZh ? '拉取比赛失败' : 'Failed to load match');
    const status = /HTTP 404/.test(errorMsg) ? 404 : 500;
    return res.status(status).json({
      error: status === 404
        ? (isZh ? '找不到这场比赛' : 'Match not found')
        : errorMsg,
    });
  }
}

async function handleMatchReview(req, res) {
  const acceptHeader = req.headers.accept || '';
  const wantsStream = acceptHeader.includes('text/event-stream');
  const lang = req.body?.lang ?? req.query.lang ?? 'zh';
  const heroIdRaw = req.body?.heroId ?? req.query.heroId;
  const heroId = heroIdRaw != null && heroIdRaw !== '' ? Number(heroIdRaw) : undefined;
  const followUp = typeof req.body?.followUp === 'string'
    ? req.body.followUp.trim()
    : (typeof req.query.followUp === 'string' ? req.query.followUp.trim() : '');
  const matchId = Number(req.params.matchId);
  const isZh = lang === 'zh';

  if (!Number.isFinite(matchId) || matchId <= 0) {
    return respondReviewError(res, wantsStream, isZh ? '无效的比赛 ID' : 'Invalid match ID');
  }

  if (!wantsStream) {
    return res.status(406).json({
      error: isZh
        ? '复盘生成需要 Accept: text/event-stream'
        : 'Match review generation requires Accept: text/event-stream',
    });
  }

  const postGuard = validateReviewPostRequest(req);
  if (!postGuard.ok) {
    return respondReviewError(
      res,
      wantsStream,
      isZh ? postGuard.errorZh : postGuard.errorEn,
      postGuard.status
    );
  }

  let clientGone = false;
  let stream = null;
  const abortController = new AbortController();
  const abortUpstream = () => {
    if (res.writableEnded) return;
    clientGone = true;
    abortController.abort();
    stream?.controller?.abort();
  };
  const detachAbortListeners = () => {
    res.removeListener('close', abortUpstream);
    req.removeListener('aborted', abortUpstream);
  };

  if (wantsStream) {
    res.on('close', abortUpstream);
    req.on('aborted', abortUpstream);
  }

  try {
    if (clientGone) return;

    const fetchOpts = wantsStream ? { signal: abortController.signal } : {};
    const [matchData, heroStats, heroConstants] = await Promise.all([
      getMatchDetail(matchId, fetchOpts),
      getHeroStats(fetchOpts),
      getHeroConstants(),
    ]);

    if (clientGone) return;

    if (heroId !== undefined) {
      const inMatch = (matchData.players || []).some((p) => p.hero_id === heroId);
      if (!inMatch) {
        return respondReviewError(
          res,
          wantsStream,
          isZh ? '该英雄未参与此场比赛' : 'Hero did not play in this match'
        );
      }
    }

    const heroNames = buildHeroNamesMap(
      heroStats,
      matchData.players || [],
      heroConstants,
      HERO_NAMES_CN
    );
    let matchFact = buildMatchFact(matchData, { lang, heroId, heroNames });
    matchFact = await enrichMatchFactWithOpenDota(matchFact, lang, fetchOpts);
    const isGrounded = Boolean(matchFact.grounded);

    const apiKeyError = isZh ? 'DeepSeek API Key 未配置' : 'DeepSeek API Key not configured';

    if (!apiKey || !openai) {
      if (wantsStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();
        if (!followUp) {
          sendReviewSse(res, { matchFact, grounded: isGrounded });
        }
        if (followUp) {
          endReviewSse(res, {
            error: isZh
              ? '追问需要 AI 服务，当前未配置 API Key'
              : 'Follow-up requires AI service; API key not configured',
          });
          return;
        }
        const fallbackCards = buildFallbackAiCards(matchFact, lang, { includeFollowups: false });
        sendReviewSse(res, { reviewCards: fallbackCards, grounded: isGrounded });
        sendReviewSse(res, { reviewNotice: reviewAiUnavailableNotice(lang, 'unconfigured') });
        endReviewSse(res);
        return;
      }
      return res.json({ matchFact, grounded: isGrounded, error: apiKeyError });
    }

    const groundedContext = matchFactToPrompt(matchFact, lang);
    const evidenceFacts = buildReviewCardsPromptFacts(matchFact, lang);
    const focusName = matchFact.focusLens?.displayName
      || (heroId ? `Hero#${heroId}` : (isZh ? '本局' : 'this match'));

    const deterministicCards = buildDeterministicReviewCards(matchFact, lang);
    const { _catalog, ...initialReviewCards } = deterministicCards;
    const keyMomentsRule = buildReviewKeyMomentsPromptRule(_catalog || [], lang);

    const systemPrompt = followUp
      ? (isZh
        ? `你是大魔导师拉比克，以职业教练口吻帮玩家复盘 DOTA2 比赛。

【硬性规则】
1. 只能使用 MatchFact 数据，禁止引用 OpenDota 原始 lane/lane_role
2. 分路以录像站位聚类为准
3. 禁止编造数据
4. 中文回答，简洁有力

【输出格式 — 使用 ## 标题】
## 回答
## 建议`
        : `You are Rubick, a pro Dota 2 coach.

Rules:
1. Use ONLY MatchFact data — never OpenDota raw lane/lane_role
2. Lanes from replay positioning clusters
3. Do not invent data

Format with ## headings:
## Answer
## Tip`)
      : (isZh
        ? `你是大魔导师拉比克，帮玩家做赛后复盘。只输出一个 JSON 对象，不要 markdown 代码块外的文字。

【硬性规则】
1. 只能使用 MatchFact 与证据字段，禁止编造
2. 分路以录像站位聚类为准，禁止引用 OpenDota lane/lane_role
3. 只指出一个主要失误（category 仅 fight_timing；无路线数据时禁止 farm_route）
4. ${keyMomentsRule}，必须带 timestamp（秒）
5. 一个具体、可执行的下一局 drill（限时，仅限角色中立的固定教练句式）
6. mentor_note 仅限拉比克口吻短结语，禁止任何数值/技能/平衡/出装说法（否则省略）
7. followups 必须引用可用证据（具体时间戳节点或经济/KDA 等 factKey），禁止无依据的出装/羊刀类追问

【JSON 结构】
{
  "primary_mistake": {
    "category": "fight_timing",
    "headline": "一句话标题",
    "explanation": "2–4 句解释",
    "evidence": [{"factKey": "timeline_0"}, {"factKey": "kda"}]
  },
  "key_moments": [
    {"timestamp": 563, "phase": "lane|mid|late", "headline": "...", "why": "...", "evidence": [{"factKey": "timeline_0"}]}
  ],
  "drill": {"duration": "15 分钟", "title": "...", "steps": ["...", "..."]},
  "followups": ["展开 21:50 节点：推中二塔", "20分钟经济差（-1200）对本局节奏意味着什么？", "下一局只练一件事"],
  "mentor_note": "拉比克口吻结语"
}`
        : `You are Rubick reviewing a Dota 2 match. Output ONLY one JSON object, no prose outside JSON.

Rules:
1. Use ONLY MatchFact and evidence factKeys — no invented data
2. Lanes from replay positioning clusters
3. One primary mistake (category: fight_timing only — no farm_route without route data)
4. ${keyMomentsRule}, each with timestamp (seconds)
5. One time-boxed drill (role-neutral fixed coaching phrases only)
6. mentor_note: short Rubick sign-off only — no stats, abilities, balance, or item claims
7. Followups must cite available evidence (specific key_moment or economy/KDA factKeys); no unsupported item-build questions

JSON shape:
{
  "primary_mistake": {"category": "fight_timing", "headline": "...", "explanation": "...", "evidence": [{"factKey": "timeline_0"}, {"factKey": "kda"}]},
  "key_moments": [{"timestamp": 563, "phase": "lane|mid|late", "headline": "...", "why": "...", "evidence": [{"factKey": "timeline_0"}]}],
  "drill": {"duration": "15 min", "title": "...", "steps": ["..."]},
  "followups": ["Break down 21:50: took mid tier 2", "What did gold lead at 20 min (-1200) mean for tempo?", "One thing to practice next"],
  "mentor_note": "..."
}`);

    const userPrompt = followUp
      ? (isZh
        ? `基于以下比赛数据回答追问（聚焦 ${focusName}）：${followUp}\n\n${groundedContext}\n\n${evidenceFacts}`
        : `Answer this follow-up about ${focusName}: ${followUp}\n\n${groundedContext}\n\n${evidenceFacts}`)
      : (isZh
        ? `请复盘以下比赛，聚焦英雄：${focusName}\n\n${groundedContext}\n\n${evidenceFacts}`
        : `Review this match, focus hero: ${focusName}\n\n${groundedContext}\n\n${evidenceFacts}`);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    if (!followUp) {
      sendReviewSse(res, { matchFact, grounded: isGrounded });
      sendReviewSse(res, { reviewCards: initialReviewCards, grounded: isGrounded });
    }

    try {
      stream = await openai.chat.completions.create({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        stream: Boolean(followUp),
      }, {
        signal: abortController.signal,
      });

      if (clientGone) {
        stream.controller?.abort();
        return;
      }

      if (followUp) {
        let finishReason = null;
        for await (const chunk of stream) {
          if (clientGone || res.writableEnded) break;
          const choice = chunk.choices[0];
          const content = choice?.delta?.content;
          if (content) {
            sendReviewSse(res, { text: content, grounded: isGrounded });
          }
          if (choice?.finish_reason) {
            finishReason = choice.finish_reason;
          }
        }
        if (!res.writableEnded) {
          if (isTerminalStreamFinish(finishReason)) {
            endReviewSse(res);
          } else {
            endReviewSse(res, {
              error: isZh ? '复盘流未完成' : 'Review stream ended incomplete',
            });
          }
        }
      } else {
        const choice = stream.choices?.[0];
        const fullText = choice?.message?.content || '';
        let reviewCards = parseAiReviewCards(fullText, matchFact, lang);
        const det = buildDeterministicReviewCards(matchFact, lang);
        const minKeyMoments = minRequiredKeyMoments(det._catalog || []);
        const usedFallback = !isReviewAiCardsComplete(reviewCards, { minKeyMoments });
        if (usedFallback) {
          reviewCards = buildFallbackAiCards(matchFact, lang);
        }
        if (!res.writableEnded) {
          sendReviewSse(res, { reviewCards, grounded: isGrounded });
          if (usedFallback) {
            sendReviewSse(res, { reviewNotice: reviewAiUnavailableNotice(lang, 'invalid') });
          }
          endReviewSse(res);
        }
      }
    } catch (streamErr) {
      if (clientGone || streamErr.name === 'AbortError') return;
      console.error('Match review stream error:', streamErr);
      if (!res.writableEnded) {
        if (followUp) {
          endReviewSse(res, {
            error: streamErr.message || (isZh ? '流式复盘失败' : 'Streaming review failed'),
          });
        } else {
          const reviewCards = buildFallbackAiCards(matchFact, lang, { includeFollowups: false });
          sendReviewSse(res, { reviewCards, grounded: isGrounded });
          sendReviewSse(res, { reviewNotice: reviewAiUnavailableNotice(lang, 'provider') });
          endReviewSse(res);
        }
      }
    } finally {
      detachAbortListeners();
    }
  } catch (error) {
    if (wantsStream) detachAbortListeners();
    if (clientGone || error.name === 'AbortError') return;
    console.error('Match review error:', error);
    const errorMsg = error.message || (isZh ? '复盘失败' : 'Review failed');
    return respondReviewError(res, wantsStream, errorMsg, 500);
  }
}

app.use(express.static(path.join(__dirname, 'dist')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
  console.log(`Health check available at http://${HOST}:${PORT}/health`);
});
