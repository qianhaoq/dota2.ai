import express from 'express';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import { buildMatchFact, matchFactToPrompt } from './lib/matchReview/matchFacts.js';
import { buildThreeConclusions } from './lib/matchReview/threeConclusions.js';
import { validateReviewPostRequest, validateReviewFollowUp } from './lib/matchReview/reviewRequestGuard.js';
import { buildHeroNamesMap } from './lib/matchReview/heroNamesMap.js';
import { reviewAiUnavailableNotice } from './lib/matchReview/reviewStream.js';
import {
  buildDeterministicReviewCards,
  buildFallbackAiCards,
  buildReviewCardsPromptFacts,
  buildReviewKeyMomentsPromptRule,
  buildPrimaryMistakeCategoryPromptTable,
  buildPrimaryMistakeExample,
  minRequiredKeyMoments,
  canReviewAiCardsValidate,
} from './lib/matchReview/reviewCards.js';
import { resolveReviewCardsWithRetry } from './lib/matchReview/reviewAiRetry.js';
import {
  createParseRequestTracker,
  createParseRequestBudget,
} from './lib/matchReview/matchParse.js';
import { createMatchDetailCache } from './lib/matchReview/matchDetailCache.js';
import {
  createReadOnlyParseStatusResolver,
  createReviewParseRequestHandler,
  rejectParseRequestGet,
} from './lib/matchReview/parseRequestEndpoint.js';
import {
  isRetryableHttpStatus,
  mapOpenDotaFetchError,
  isOpenDotaFetchError,
} from './lib/matchReview/openDotaErrors.js';
import {
  wantsReviewStream,
  sendReviewSse,
  endReviewSse,
  createReviewResponder,
} from './lib/matchReview/reviewResponder.js';
import { computeApiHealth } from './lib/serverHealth.js';
import { combineAbortSignals } from './lib/abortSignals.js';
import { requestCardCompletion } from './lib/matchReview/cardCompletion.js';
import { streamFollowUpCompletion } from './lib/matchReview/followUpCompletion.js';
import { clampFollowUpAttemptMs } from './lib/matchReview/followUpTimeout.js';
import { withCompletionDeadline } from './lib/completionDeadline.js';
import {
  isLlmSdkError,
  logLlmError,
  redactSecrets,
  sanitizeLlmErrorForClient,
  internalErrorForClient,
} from './lib/llmErrors.js';
import { publicModelName, resolveDeepSeekConfig, loggableModelName } from './lib/llmConfig.js';
import { jsonBodyErrorHandler } from './lib/jsonBodyErrors.js';
import { parsePositiveInt } from './lib/positiveInt.js';
import {
  buildFollowUpFallbackText,
  decideFollowUpOutcome,
  reviewFollowUpFallbackNotice,
} from './lib/matchReview/followUpFallback.js';

// Per-attempt card completion deadline; two attempts + fetch stay under
// Cloud Run's 300s request timeout.
const REVIEW_CARD_COMPLETION_DEADLINE_MS = 40000;
// Request-wide budget for the whole card review (OpenDota fetch + all
// completion attempts). Must stay below the browser's review timeout
// (REVIEW_CLIENT_TIMEOUT_MS = 180s in src/services/geminiService.ts) and
// Cloud Run's 300s limit, with headroom to send the fallback response.
const REVIEW_REQUEST_BUDGET_MS = 170000;
const REVIEW_MIN_ATTEMPT_MS = 5000;
// Fetch-phase cap (OpenDota match + hero stats + constants). Leaves 80s of
// the request budget for DeepSeek 40s + Gemini 40s.
const REVIEW_FETCH_BUDGET_MS = 90000;
// Per-attempt deadline for the review follow-up stream (DeepSeek first, then
// the Gemini fallback with its own deadline). Env-tunable, but clamped so
// fetch budget + two follow-up attempts always fit REVIEW_REQUEST_BUDGET_MS
// (and stay below the client's fixed 180s review timeout); each attempt is
// capped again by the request's remaining budget at call time.
const REVIEW_FOLLOW_UP_ATTEMPT_TIMEOUT_MS = clampFollowUpAttemptMs(
  process.env.REVIEW_FOLLOW_UP_ATTEMPT_TIMEOUT_MS,
  {
    fetchBudgetMs: REVIEW_FETCH_BUDGET_MS,
    requestBudgetMs: REVIEW_REQUEST_BUDGET_MS,
    maxAttempts: 2,
    minAttemptMs: REVIEW_MIN_ATTEMPT_MS,
  },
);
import {
  createParseRequestSubmitter,
  PARSE_REQUEST_TIMEOUT_MS,
} from './lib/matchReview/parseRequestSubmit.js';
import {
  parseForwardedFor,
  parseTrustedProxyHops,
  resolveClientIp as resolveClientIpFromParts,
} from './lib/clientIp.js';
import {
  REVIEW_HIGH_MMR_MIN_RANK_TIER,
  resolvePublicMatchSkill,
  selectReviewHighMmrPublicMatches,
} from './lib/matchReview/publicMatchRank.js';
import {
  normalizeUiLang,
  getDraftSystemInstruction,
  getPlaybookSystemPrompt,
  getReviewSystemPrompt,
  getLoreSystemInstruction,
} from './lib/aiLanguage.js';
import { validateAnalyticsEvent, createAnalyticsRateLimiter } from './lib/analyticsEvents.js';
import { createSlidingWindowLimiter } from './lib/rateLimiter.js';
import { createLlmRateLimit } from './lib/llmRateLimit.js';
import { rateLimitKey } from './lib/rateLimitKey.js';
import { validateChatRequest, chatRequestErrorMessage } from './lib/chatRequest.js';
import { normalizeFeedbackSubmission } from './lib/feedbackStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

app.use(express.json());
// Malformed/oversized JSON bodies get a JSON error here (Express's default is
// an HTML "Bad Request" page). Registered as an error handler right after the
// body parser; anything else passes through to the default handling untouched.
app.use(jsonBodyErrorHandler);


// www → apex: works when www.dota2.ai points at this Cloud Run service.
// Use 308 (not 301) so POST/SSE keep their method when Fetch follows the redirect.
// If DNS/CDN still serves a different origin for www, configure redirect there as follow-up.
app.use((req, res, next) => {
  const host = (req.hostname || '').toLowerCase();
  if (host === 'www.dota2.ai') {
    return res.redirect(308, `https://dota2.ai${req.originalUrl || '/'}`);
  }
  next();
});

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

// DeepSeek model + thinking mode (lib/llmConfig.js): env-tunable, defaults to
// deepseek-flash with thinking disabled — review cards and follow-ups answer
// inside a 40s deadline and thinking mode would blow through it.
const deepseekConfig = resolveDeepSeekConfig(process.env);
const DEEPSEEK_MODEL = deepseekConfig.model;
// Merged into every DeepSeek chat.completions.create body (thinking toggle);
// NEVER merged into the Gemini request (see cardProviders). Retired legacy
// names (deepseek-chat / deepseek-reasoner) are mapped to the default model.
const deepseekExtraBody = deepseekConfig.extraBody;
// Never log the raw model value: a key/secret pasted into DEEPSEEK_MODEL must
// not reach the logs — loggableModelName whitelists/masks it.
console.log(`INFO: DeepSeek model=${loggableModelName(deepseekConfig.model)} thinking=${deepseekConfig.thinking}`);
if (deepseekConfig.legacyMappedFrom) {
  console.warn(`WARNING: DEEPSEEK_MODEL=${loggableModelName(deepseekConfig.legacyMappedFrom)} is a retired DeepSeek model name; using ${loggableModelName(deepseekConfig.model)} instead.`);
}
if (deepseekConfig.credentialMappedFrom) {
  // Value withheld on purpose: it looks like an API key/credential.
  console.warn('WARNING: DEEPSEEK_MODEL looks like an API key/credential; ignoring it and using the default model instead.');
}

// Gemini (OpenAI-compatible endpoint) is the card-review fallback when
// DeepSeek fails or times out. Same prompt and validation/repair pipeline.
const geminiApiKey = process.env.GEMINI_API_KEY;
const gemini = geminiApiKey ? new OpenAI({
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  apiKey: geminiApiKey,
}) : null;
const GEMINI_REVIEW_MODEL = process.env.GEMINI_REVIEW_MODEL || 'gemini-3.5-flash-lite';

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

// ============ Cache Storage ============
const cache = {
  heroStats: { data: null, timestamp: 0 },
  matchups: new Map(), // Map<heroId, { data, timestamp }>
  itemPopularity: new Map(), // Map<heroId, { data, timestamp }>
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
};

function redactFetchUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(url).split('?')[0];
  }
}

function enrichUpstreamError(err, url, status) {
  const message = status != null ? `HTTP ${status}` : (err?.message || 'Fetch failed');
  const error = (err instanceof Error && status == null) ? err : new Error(message);
  if (status != null) error.status = status;
  else if (err?.status != null) error.status = err.status;

  const resolvedStatus = error.status;
  if (resolvedStatus != null) {
    error.retryable = isRetryableHttpStatus(resolvedStatus);
  } else {
    // network / timeout — retryable unless caller aborted
    error.retryable = err?.name !== 'AbortError';
  }

  if (typeof url === 'string' && url.includes('api.opendota.com')) {
    error.upstream = 'opendota';
  } else if (err?.upstream) {
    error.upstream = err.upstream;
  }
  return error;
}

async function fetchWithRetry(url, retries = 2, delay = 500, options = {}) {
  const { timeoutMs, signal: callerSignal, ...fetchOptions } = options;
  const safeUrl = redactFetchUrl(url);

  for (let i = 0; i <= retries; i++) {
    const started = Date.now();
    try {
      const timeoutSignal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
      const signal = combineAbortSignals([callerSignal, timeoutSignal]);
      const res = await fetch(url, { ...fetchOptions, ...(signal ? { signal } : {}) });
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        console.warn(
          `[fetchWithRetry] ${safeUrl} attempt=${i + 1}/${retries + 1} status=${res.status} latencyMs=${latencyMs}`
        );
        const httpErr = enrichUpstreamError(new Error(`HTTP ${res.status}`), url, res.status);
        if (!isRetryableHttpStatus(res.status) || i === retries) throw httpErr;
        await new Promise((r) => setTimeout(r, delay * (i + 1)));
        continue;
      }
      if (i > 0) {
        console.warn(
          `[fetchWithRetry] ${safeUrl} attempt=${i + 1}/${retries + 1} status=${res.status} latencyMs=${latencyMs} ok`
        );
      }
      return await res.json();
    } catch (err) {
      const latencyMs = Date.now() - started;
      if (callerSignal?.aborted) throw err;
      const enriched = enrichUpstreamError(err, url, err?.status);
      console.warn(
        `[fetchWithRetry] ${safeUrl} attempt=${i + 1}/${retries + 1} status=${enriched.status ?? 'network'} latencyMs=${latencyMs} error=${enriched.message}`
      );
      if (i === retries || enriched.retryable === false) throw enriched;
      await new Promise((r) => setTimeout(r, delay * (i + 1)));
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
  return normalizeUiLang(lang);
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

async function getReviewMatchSuggestions(lang = 'en', limit = REVIEW_SUGGESTIONS_DEFAULT_LIMIT) {
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

function formatProMatch(match, heroConstants, lang = 'en') {
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

function formatPublicMatch(match, heroConstants, lang = 'en') {
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
async function getMergedHeroMeta(lang = 'en') {
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
async function getLeanHeroMeta(lang = 'en') {
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

app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0'
  });
});

app.get('/api/health', async (req, res) => {
  const health = computeApiHealth({
    heroesLoaded: cache.heroes.data !== null,
    itemsLoaded: cache.items.data !== null,
    abilitiesLoaded: cache.abilities.data !== null,
  });

  res.status(200).json({
    status: health.status,
    apiKeyConfigured: !!apiKey,
    // Whitelisted name only: a custom DEEPSEEK_MODEL (internal alias / gateway
    // name) must not leak to anonymous callers; provider stays 'deepseek'.
    model: publicModelName(DEEPSEEK_MODEL),
    provider: 'deepseek',
    opendotaConstants: {
      ...health.opendotaConstants,
      herosCacheAge: cache.heroes.data !== null ? Math.round((Date.now() - cache.heroes.timestamp) / 1000) : null,
      itemsCacheAge: cache.items.data !== null ? Math.round((Date.now() - cache.items.timestamp) / 1000) : null
    },
    chineseNameMapping: {
      heroCount: Object.keys(HERO_NAMES_CN).length,
      source: 'curated'
    }
  });
});

// ============ Constants warm-load (non-blocking, with retry) ============
const WARM_CONSTANTS_MAX_ATTEMPTS = 5;
const WARM_CONSTANTS_RETRY_DELAY_MS = 30 * 1000;

function warmLoadOpenDotaConstants(attempt = 1) {
  const allLoaded = () => cache.heroes.data !== null
    && cache.items.data !== null
    && cache.abilities.data !== null;
  Promise.all([getHeroConstants(), getItemConstants(), getAbilityConstants()])
    .then(() => {
      if (allLoaded()) {
        console.log('[constants] warm-load complete (heroes/items/abilities)');
        return;
      }
      if (attempt >= WARM_CONSTANTS_MAX_ATTEMPTS) {
        console.warn(`[constants] warm-load incomplete after ${attempt} attempts; /api/health reports degraded until first use`);
        return;
      }
      console.warn(`[constants] warm-load attempt ${attempt} incomplete; retrying in ${WARM_CONSTANTS_RETRY_DELAY_MS / 1000}s`);
      setTimeout(() => warmLoadOpenDotaConstants(attempt + 1), WARM_CONSTANTS_RETRY_DELAY_MS);
    })
    .catch((err) => {
      if (attempt >= WARM_CONSTANTS_MAX_ATTEMPTS) {
        console.warn(`[constants] warm-load failed after ${attempt} attempts (${err?.message || 'unknown'}); /api/health reports degraded until first use`);
        return;
      }
      console.warn(`[constants] warm-load attempt ${attempt} failed (${err?.message || 'unknown'}); retrying in ${WARM_CONSTANTS_RETRY_DELAY_MS / 1000}s`);
      setTimeout(() => warmLoadOpenDotaConstants(attempt + 1), WARM_CONSTANTS_RETRY_DELAY_MS);
    });
}

// ============ Meta API Endpoints ============

app.get('/api/meta/heroes', async (req, res) => {
  try {
    const lang = req.query.lang || 'en';
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
    const lang = req.query.lang || 'en';
    
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
    const lang = req.query.lang || 'en';
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
    const lang = req.query.lang || 'en';
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
    const lang = req.query.lang || 'en';
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

// ============ LLM endpoint per-IP rate limits + global cost guard ============
// Sliding-window per-IP limits for every route that can trigger a DeepSeek /
// Gemini completion: /api/chat, /api/analyze, /api/playbook, POST
// /api/suggestions and POST /api/review/:matchId (the GET facts route stays
// unlimited). One limiter per endpoint group so a chatty chat user cannot
// starve review requests. Budget is consumed by an explicit acquire() INSIDE
// each handler, after validation and after every no-LLM short-circuit — so
// invalid (400/413) requests, cache hits and deterministic answers never
// consume quota, and junk traffic cannot exhaust the budget real users depend
// on (QA P1). IPv6 clients are keyed by their /64 prefix
// (lib/rateLimitKey.js): rotating addresses inside one block cannot multiply
// an attacker's budget. Over-limit clients get a 429 with Retry-After.
// The global per-group cap no longer answers 429. In its place a generous
// global COST GUARD (LLM_GLOBAL_GUARD_<GROUP>, default 600/min) trips only
// under sustained aggregate abuse; a tripped request skips the LLM call and
// serves the route's existing deterministic fallback instead of failing, and
// does not consume that client's per-IP quota (it never reached the LLM).
// Env-tunable (see .env.example), parsed with parsePositiveInt and clamped to
// sane ceilings so a typo cannot disable or explode a limit. In-memory like
// the feedback limiter: per-instance, reset on redeploy.
const LLM_RATE_MAX_WINDOW_MS = 60 * 60 * 1000;
const LLM_RATE_MAX_PER_IP = 1000;
const LLM_GLOBAL_GUARD_MAX = 100000;
const LLM_GLOBAL_GUARD_DEFAULT = 600;
const LLM_RATE_WINDOW_MS = Math.min(
  parsePositiveInt(process.env.LLM_RATE_WINDOW_MS, 60000), LLM_RATE_MAX_WINDOW_MS,
);

function createLlmGroupLimiter(perIpEnvName, guardEnvName, perIpDefault) {
  return createSlidingWindowLimiter({
    limit: Math.min(parsePositiveInt(process.env[perIpEnvName], perIpDefault), LLM_RATE_MAX_PER_IP),
    // No guard env → no global bucket at all (deterministic, LLM-free routes).
    globalLimit: guardEnvName
      ? Math.min(parsePositiveInt(process.env[guardEnvName], LLM_GLOBAL_GUARD_DEFAULT), LLM_GLOBAL_GUARD_MAX)
      : undefined,
    windowMs: LLM_RATE_WINDOW_MS,
  });
}

const chatLlmLimit = createLlmRateLimit({
  limiter: createLlmGroupLimiter('LLM_RATE_CHAT_PER_IP', 'LLM_GLOBAL_GUARD_CHAT', 10),
  resolveClientIp,
  name: 'chat',
});
// analyze + playbook share one limiter (same coach screen, same budget).
const analyzeLlmLimit = createLlmRateLimit({
  limiter: createLlmGroupLimiter('LLM_RATE_ANALYZE_PER_IP', 'LLM_GLOBAL_GUARD_ANALYZE', 6),
  resolveClientIp,
  name: 'analyze+playbook',
});
const suggestionsLlmLimit = createLlmRateLimit({
  limiter: createLlmGroupLimiter('LLM_RATE_SUGGESTIONS_PER_IP', null, 20),
  resolveClientIp,
  name: 'suggestions',
});
const reviewLlmLimit = createLlmRateLimit({
  limiter: createLlmGroupLimiter('LLM_RATE_REVIEW_PER_IP', 'LLM_GLOBAL_GUARD_REVIEW', 30),
  resolveClientIp,
  name: 'review',
});

// ============ Playbook API - 本局打法 ============
app.post('/api/playbook', async (req, res) => {
  const acceptHeader = req.headers.accept || '';
  const wantsStream = acceptHeader.includes('text/event-stream');
  
  try {
    let { allies = [], enemies = [], focusHeroId, side = 'radiant', lang = 'en' } = req.body;
    lang = normalizeUiLang(lang);
    
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
    
    // Data-only answer whenever no AI text can be produced (unconfigured key,
    // or a tripped global cost guard): the OpenDota data the route already
    // gathered plus an error note — never a 429 for the cost guard.
    const servePlaybookDataOnly = (errorText) => {
      if (wantsStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.write(`data: ${JSON.stringify({ playbookData, focusHero })}\n\n`);
        res.write(`data: ${JSON.stringify({ error: errorText })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      return res.json({ playbookData, focusHero, error: errorText });
    };

    if (!apiKey || !openai) {
      return servePlaybookDataOnly(
        wantsStream ? "DeepSeek API Key not configured - only data returned" : "DeepSeek API Key not configured",
      );
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
    
    const systemPrompt = getPlaybookSystemPrompt(lang);

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

    // Count only now: allies were validated and the OpenDota data is fetched,
    // so this request is LLM-bound. Still before any SSE header, so a 429 goes
    // out as plain JSON. A tripped global cost guard degrades to the same
    // data-only response as an unconfigured key.
    const llmGate = analyzeLlmLimit.acquire(req);
    if (!llmGate.ok) {
      if (llmGate.reason === 'cost_guard') {
        return servePlaybookDataOnly(
          isZh ? 'AI 分析暂时不可用（成本保护已触发），仅返回数据部分' : 'AI analysis temporarily unavailable (cost guard); data-only response',
        );
      }
      return analyzeLlmLimit.respondRateLimited(req, res, llmGate.retryAfterSec);
    }

    if (wantsStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      
      res.write(`data: ${JSON.stringify({ playbookData, focusHero })}\n\n`);
      
      const stream = await openai.chat.completions.create({
        model: DEEPSEEK_MODEL,
        ...deepseekExtraBody,
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
        ...deepseekExtraBody,
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
    // LLM/provider failures never cross to the client raw (they can embed
    // auth details or key tails): generic localized payload + structured log.
    const lang = normalizeUiLang(req.body?.lang || 'en');
    if (isLlmSdkError(error)) {
      logLlmError(console.error, { event: 'playbook_llm_error', provider: 'deepseek', error, lang });
      const payload = sanitizeLlmErrorForClient(lang);
      if (wantsStream) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      return res.status(502).json(payload);
    }
    // Unclassified errors may still be provider-derived (e.g. SDK SyntaxError
    // with a body excerpt): redacted structured log, generic payload only.
    logLlmError(console.error, { event: 'playbook_error', error, lang });
    const internal = internalErrorForClient(lang);
    if (wantsStream) {
      res.write(`data: ${JSON.stringify(internal)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.status(500).json(internal);
    }
  }
});

app.post('/api/analyze', async (req, res) => {
  const acceptHeader = req.headers.accept || '';
  const wantsStream = acceptHeader.includes('text/event-stream');
  
  try {
    let { radiant = [], dire = [], lang = 'en', userContext } = req.body;
    lang = normalizeUiLang(lang);
    
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
      // err.message can embed the full request URL (incl. ?api_key=…) — redacted.
      console.error('OpenDota fetch error:', redactSecrets(err?.message ?? err));
    }
    
    const prompt = buildGroundedPrompt(radiant, dire, heroStats, matchupAnalysis, lang, userContext, isGrounded, heroConstants, proMatchEvidence);

    const systemInstruction = getDraftSystemInstruction(lang);

    // Count only now: the key check and the OpenDota grounding phase are past
    // and the completion is the next call. Still before any SSE header, so a
    // 429 goes out as plain JSON. A tripped global cost guard answers the
    // generic ai_unavailable payload (same as a provider failure) — never 429.
    const llmGate = analyzeLlmLimit.acquire(req);
    if (!llmGate.ok) {
      if (llmGate.reason === 'cost_guard') {
        return res.status(502).json(sanitizeLlmErrorForClient(lang));
      }
      return analyzeLlmLimit.respondRateLimited(req, res, llmGate.retryAfterSec);
    }

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
        ...deepseekExtraBody,
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
        ...deepseekExtraBody,
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
    // Same hygiene as /api/playbook: provider errors → generic payload only.
    const lang = normalizeUiLang(req.body?.lang || 'en');
    if (isLlmSdkError(error)) {
      logLlmError(console.error, { event: 'analyze_llm_error', provider: 'deepseek', error, lang });
      const payload = sanitizeLlmErrorForClient(lang);
      if (wantsStream) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      return res.status(502).json(payload);
    }
    logLlmError(console.error, { event: 'analyze_error', error, lang });
    const internal = internalErrorForClient(lang);
    if (wantsStream) {
      res.write(`data: ${JSON.stringify(internal)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.status(500).json(internal);
    }
  }
});

// SPA GET fallback guard — clients must POST (avoids index.html HTML responses).
app.get('/api/suggestions', (_req, res) => {
  res.status(405).json({ error: 'Use POST', suggestions: [] });
});

// Next hero suggestions based on OpenDota matchup data
app.post('/api/suggestions', async (req, res) => {
  try {
    const { allies = [], enemies = [], side = 'radiant', limit = 8, role } = req.body;

    const heroStats = await getHeroStats();
    if (!heroStats || Object.keys(heroStats).length === 0) {
      return res.json({ suggestions: [], error: 'OpenDota data unavailable' });
    }

    // Count only now: the data-availability short-circuit above answers for
    // free, everything below does the OpenDota-driven compute. This route
    // never calls an LLM, so it has no global cost guard at all (no global
    // bucket that could mask a full per-IP bucket); only the per-IP limit
    // applies and answers 429.
    const llmGate = suggestionsLlmLimit.acquire(req);
    if (!llmGate.ok) {
      return suggestionsLlmLimit.respondRateLimited(req, res, llmGate.retryAfterSec);
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
    const lang = normalizeUiLang(req.body.lang || 'en');
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
    // Redacted structured log: upstream/fetch errors can embed query-string
    // credentials in URLs even though no LLM call runs here.
    logLlmError(console.error, { event: 'suggestions_error', error });
    // No LLM call here, but never echo raw upstream text either (redaction
    // guards against future leaks if a provider call is ever added).
    res.json({ suggestions: [], error: 'Failed to compute suggestions' });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    // Validation in lib/chatRequest.js: message shape/size caps, Gemini-format
    // history sanitized to OpenAI roles ('model' → 'assistant', 'system' and
    // unknown roles dropped, item/char budgets enforced).
    const validated = validateChatRequest(req.body);
    if (!validated.ok) {
      const lang = normalizeUiLang(req.body?.lang);
      return res.status(validated.status).json({
        error: validated.error,
        message: chatRequestErrorMessage(validated.error, lang),
      });
    }
    const { message, history, lang } = validated;

    if (!apiKey || !openai) {
      return res.status(500).json({ error: "Server API Key not configured" });
    }

    // Count only now: the body has been validated (invalid bodies answered 400
    // above, consuming nothing) and the completion is the next call. A tripped
    // global cost guard answers the generic ai_unavailable payload (same as a
    // provider failure) — never a 429.
    const llmGate = chatLlmLimit.acquire(req);
    if (!llmGate.ok) {
      if (llmGate.reason === 'cost_guard') {
        return res.status(502).json(sanitizeLlmErrorForClient(lang));
      }
      return chatLlmLimit.respondRateLimited(req, res, llmGate.retryAfterSec);
    }

    const systemContent = getLoreSystemInstruction(lang);

    const messages = [
      { role: 'system', content: systemContent },
      ...history,
      { role: 'user', content: message }
    ];

    const response = await openai.chat.completions.create({
      model: DEEPSEEK_MODEL,
      ...deepseekExtraBody,
      messages: messages,
    });

    res.json({ text: response.choices[0].message.content });
  } catch (error) {
    const lang = normalizeUiLang(req.body?.lang);
    if (isLlmSdkError(error)) {
      logLlmError(console.error, { event: 'chat_llm_error', provider: 'deepseek', error, lang });
      return res.status(502).json(sanitizeLlmErrorForClient(lang));
    }
    logLlmError(console.error, { event: 'chat_error', error, lang });
    res.status(500).json(internalErrorForClient(lang));
  }
});

// ============ Match Replay Review ============
// Unparsed entries live under a short TTL and never overwrite parsed data
// (see lib/matchReview/matchDetailCache.js).
const matchDetailCache = createMatchDetailCache({
  fetchMatch: (matchId, options = {}) => fetchWithRetry(`${OPENDOTA_API}/matches/${matchId}`, 4, 1000, {
    ...options,
    timeoutMs: options.timeoutMs ?? 25000,
  }),
  log: (msg) => console.warn(`[match-detail-cache] ${msg}`),
});

function getMatchDetail(matchId, fetchOptions = {}) {
  return matchDetailCache.get(matchId, fetchOptions);
}

// OpenDota POST /request/{match_id} dedup/rate-limit state (per match),
// plus global/per-client submission budgets (env-tunable) so a single client
// or an OpenDota outage cannot amplify into a stream of parse submissions.
function envPositiveInt(name, fallback) {
  // Number-based parsing (parsePositiveInt): parseInt('1e9') === 1 would
  // silently turn scientific-notation env values into 1.
  return parsePositiveInt(process.env[name], fallback);
}

const parseRequestTracker = createParseRequestTracker();
const parseRequestBudget = createParseRequestBudget({
  globalMax: envPositiveInt('PARSE_BUDGET_GLOBAL_MAX', 10),
  perClientMax: envPositiveInt('PARSE_BUDGET_PER_CLIENT_MAX', 3),
});
const opendotaApiKey = process.env.OPENDOTA_API_KEY || '';

// Submission flow lives in lib (fully injected, unit-tested). Client-disconnect
// aborts are rethrown as-is and never recorded as failures — a disconnected
// client must not leave a bogus 'failed' marker that later visitors see for the
// failure-cooldown window. The abort only downgrades the in-flight pending
// entry to a short abort-retry window (the aborted POST may never have reached
// OpenDota, so it must not hold the full success cooldown either); only real
// timeouts/upstream failures are recorded as failures.
const submitParseRequest = createParseRequestSubmitter({
  tracker: parseRequestTracker,
  budget: parseRequestBudget,
  baseUrl: OPENDOTA_API,
  apiKey: opendotaApiKey,
  timeoutMs: PARSE_REQUEST_TIMEOUT_MS,
  log: (msg) => console.log(`[review:parse-request] ${msg}`),
  warn: (msg) => console.warn(`[review:parse-request] ${msg}`),
});

/**
 * Resolve the parse status for a match — READ-ONLY. Never submits a parse:
 * automatic submission on facts load let autoscaled instances collectively
 * exhaust the OpenDota parse quota (per-instance budgets don't aggregate).
 * Unparsed matches report 'unparsed' and the user can request a parse via
 * POST /api/review/:matchId/parse-request (the only submission path).
 */
const resolveReviewParseStatus = createReadOnlyParseStatusResolver({
  tracker: parseRequestTracker,
});

// Explicit parse-request endpoint — the ONLY path that calls submitParseRequest.
const handleMatchReviewParseRequest = createReviewParseRequestHandler({
  submitParseRequest,
  getMatchDetail,
  resolveClientIp,
  log: (msg) => console.log(`[review:parse-request] ${msg}`),
});

function respondReviewError(res, wantsStream, errorMsg, status = 400, extra = {}) {
  const payload = { error: errorMsg, ...extra };
  if (wantsStream) {
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
    }
    endReviewSse(res, payload);
    return;
  }
  return res.status(status).json(payload);
}

app.get('/api/review/suggestions', async (req, res) => {
  try {
    const lang = normalizeReviewLang(req.query.lang || 'en');
    const limit = Math.min(
      parseInt(req.query.limit, 10) || REVIEW_SUGGESTIONS_DEFAULT_LIMIT,
      REVIEW_SUGGESTIONS_MAX_LIMIT,
    );
    const suggestions = await getReviewMatchSuggestions(lang, limit);
    res.json(suggestions);
  } catch (err) {
    // Redacted structured log: fetch errors can embed ?api_key=… URLs.
    logLlmError(console.error, { event: 'review_suggestions_error', error: err });
    const lang = normalizeReviewLang(req.query.lang || 'en');
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
// Explicit OpenDota parse submission — the ONLY path that calls submitParseRequest
// (facts load and review stream report parse status read-only). GET gets a JSON
// 405 so it never falls through to the SPA index.html fallback.
app.post('/api/review/:matchId/parse-request', handleMatchReviewParseRequest);
app.get('/api/review/:matchId/parse-request', rejectParseRequestGet);

/** GET：只拉 OpenDota MatchFact，不调用 DeepSeek */
async function handleMatchReviewFacts(req, res) {
  const lang = normalizeUiLang(req.query.lang ?? 'en');
  // Focus hero stamped on the review message at request time. Without it the
  // refreshed fact loses focusHeroId/focusLens and every retry looks "changed",
  // wiping the insight cards and re-running the review for no reason.
  const heroIdRaw = req.query.heroId;
  const heroId = heroIdRaw != null && heroIdRaw !== '' ? Number(heroIdRaw) : undefined;
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
    if (heroId !== undefined) {
      const inMatch = (matchData.players || []).some((p) => p.hero_id === heroId);
      if (!inMatch) {
        return res.status(400).json({
          error: isZh ? '该英雄未参与此场比赛' : 'Hero did not play in this match',
        });
      }
    }
    const heroNames = buildHeroNamesMap(
      heroStats,
      matchData.players || [],
      heroConstants,
      HERO_NAMES_CN
    );
    const matchFact = buildMatchFact(matchData, { lang, heroId, heroNames });
    const parse = resolveReviewParseStatus(matchId, matchData, lang);
    // 三条结论为新增字段（additive）：老客户端忽略即可。
    return res.json({
      matchFact,
      grounded: Boolean(matchFact.grounded),
      parse,
      threeConclusions: buildThreeConclusions(matchFact, { lang }),
    });
  } catch (error) {
    // Redacted structured log: fetch errors can embed ?api_key=… URLs.
    logLlmError(console.error, { event: 'match_facts_error', error });
    const mapped = mapOpenDotaFetchError(error, isZh);
    return res.status(mapped.status).json(mapped.body);
  }
}

async function handleMatchReview(req, res) {
  const acceptHeader = req.headers.accept || '';
  const wantsStream = wantsReviewStream(acceptHeader);
  const lang = normalizeUiLang(req.body?.lang ?? req.query.lang ?? 'en');
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

  // Follow-up questions share /api/chat's per-message cap. Rejected before any
  // budget is consumed (the limiter below only counts LLM-bound requests).
  const followUpGuard = validateReviewFollowUp(followUp);
  if (!followUpGuard.ok) {
    // Real HTTP 400 JSON even for SSE clients: nothing is streamed yet, and
    // response.ok must reflect the rejection (the client already parses JSON
    // error bodies, e.g. 429).
    return res.status(followUpGuard.status || 400).json({
      error: followUpGuard.error,
      message: chatRequestErrorMessage(followUpGuard.error, lang),
    });
  }

  // Non-SSE Accept gets the same review as a single JSON result (not a bare 406).
  const responder = createReviewResponder(res, wantsStream);

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
  const reviewStartedAt = Date.now();
  const abortController = new AbortController();
  const abortUpstream = () => {
    if (res.writableEnded) return;
    clientGone = true;
    // Aborts every in-flight upstream call: the fetch phase and each provider
    // attempt (cards and follow-up streams) all consume this shared signal.
    abortController.abort();
  };
  const detachAbortListeners = () => {
    res.removeListener('close', abortUpstream);
    req.removeListener('aborted', abortUpstream);
  };

  // Disconnect cleanup applies to BOTH response modes: SSE stops streaming
  // early, and JSON-mode upstream work (OpenDota + DeepSeek) is aborted via
  // the shared signal instead of running to completion for a gone client.
  res.on('close', abortUpstream);
  req.on('aborted', abortUpstream);

  try {
    if (clientGone) return;

    // App-owned deadline over the whole fetch phase so a stalled OpenDota or
    // constants refresh cannot outlive the browser's review timeout. The race
    // also bounds getHeroConstants(), which takes no signal (its shared cache
    // refresh may finish in the background). Expiry is a CompletionDeadlineError
    // (distinct from client disconnect) and is answered with a 504 below.
    const [matchData, heroStats, heroConstants] = await withCompletionDeadline(
      (signal) => Promise.all([
        getMatchDetail(matchId, { signal }),
        getHeroStats({ signal }),
        getHeroConstants(),
      ]),
      { ms: REVIEW_FETCH_BUDGET_MS, signal: abortController.signal },
    );

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
    const matchFact = buildMatchFact(matchData, { lang, heroId, heroNames });
    const isGrounded = Boolean(matchFact.grounded);
    const parse = resolveReviewParseStatus(matchId, matchData, lang);
    const threeConclusions = buildThreeConclusions(matchFact, { lang });

    // Cards and follow-ups share the DeepSeek → Gemini provider chain, so
    // either provider alone serves both. Only a deployment with nothing
    // configured answers fallback cards here / rejects the follow-up.
    if (!openai && !gemini) {
      responder.begin();
      if (!followUp) {
        responder.send({ matchFact, grounded: isGrounded, parse, threeConclusions });
      }
      if (followUp) {
        // Unconfigured DeepSeek still answers the follow-up: deterministic
        // template text from match facts instead of an error frame — same
        // contract as provider failures below.
        console.warn(JSON.stringify({ severity: 'WARNING', event: 'review_followup_fallback', matchId, reason: 'unconfigured' }));
        responder.send({ text: buildFollowUpFallbackText(matchFact, threeConclusions, lang), grounded: isGrounded, fallback: true });
        responder.send({ reviewNotice: reviewFollowUpFallbackNotice(lang) });
        responder.end();
        return;
      }
      const fallbackCards = buildFallbackAiCards(matchFact, lang);
      responder.send({ reviewCards: fallbackCards, grounded: isGrounded });
      responder.send({ reviewNotice: reviewAiUnavailableNotice(lang, 'unconfigured') });
      responder.end();
      return;
    }

    const groundedContext = matchFactToPrompt(matchFact, lang);
    const evidenceFacts = buildReviewCardsPromptFacts(matchFact, lang);
    const focusName = matchFact.focusLens?.displayName
      || (heroId ? `Hero#${heroId}` : (isZh ? '本局' : 'this match'));

    const deterministicCards = buildDeterministicReviewCards(matchFact, lang);
    const { _catalog, ...initialReviewCards } = deterministicCards;
    const keyMomentsRule = buildReviewKeyMomentsPromptRule(_catalog || [], lang);

    const categoryTable = buildPrimaryMistakeCategoryPromptTable(_catalog || [], lang);
    const mistakeExample = buildPrimaryMistakeExample(_catalog || []);

    const systemPrompt = getReviewSystemPrompt(lang, {
      followUp: Boolean(followUp),
      keyMomentsRule,
      categoryTable,
      mistakeExample,
    });

    const userPrompt = followUp
      ? (isZh
        ? `基于以下比赛数据回答追问（聚焦 ${focusName}）：${followUp}\n\n${groundedContext}\n\n${evidenceFacts}`
        : `Answer this follow-up about ${focusName}: ${followUp}\n\n${groundedContext}\n\n${evidenceFacts}`)
      : (isZh
        ? `请复盘以下比赛，聚焦英雄：${focusName}\n\n${groundedContext}\n\n${evidenceFacts}`
        : `Review this match, focus hero: ${focusName}\n\n${groundedContext}\n\n${evidenceFacts}`);

    // Budget gate — consume only now. Everything above (validation, match
    // fetch, unconfigured fallback, no-evidence card short-circuit) answers
    // without the LLM and must not count. The responder has not opened the SSE
    // stream yet, so a 429 still goes out as plain JSON. A tripped global cost
    // guard serves the deterministic fallback (cards → fallback cards,
    // follow-up → template text) instead of 429, and consumes no per-IP quota.
    const aiCardsSkipped = !followUp && !canReviewAiCardsValidate(_catalog || []);
    if (!aiCardsSkipped) {
      const llmGate = reviewLlmLimit.acquire(req);
      if (!llmGate.ok) {
        if (llmGate.reason === 'cost_guard') {
          responder.begin();
          if (!followUp) {
            responder.send({ matchFact, grounded: isGrounded, parse, threeConclusions });
            responder.send({ reviewCards: buildFallbackAiCards(matchFact, lang), grounded: isGrounded });
            responder.send({ reviewNotice: reviewAiUnavailableNotice(lang, 'cost_guard') });
          } else {
            // Same contract as the unconfigured/provider fallbacks: the
            // deterministic template answers, flagged fallback:true.
            console.warn(JSON.stringify({ severity: 'WARNING', event: 'review_followup_fallback', matchId, reason: 'cost_guard' }));
            responder.send({ text: buildFollowUpFallbackText(matchFact, threeConclusions, lang), grounded: isGrounded, fallback: true });
            responder.send({ reviewNotice: reviewFollowUpFallbackNotice(lang) });
          }
          responder.end();
          return;
        }
        return reviewLlmLimit.respondRateLimited(req, res, llmGate.retryAfterSec);
      }
    }

    responder.begin();

    if (!followUp) {
      responder.send({ matchFact, grounded: isGrounded, parse, threeConclusions });
      responder.send({ reviewCards: initialReviewCards, grounded: isGrounded });
    }

    const completionBody = {
      model: DEEPSEEK_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      stream: Boolean(followUp),
      // No response_format: DeepSeek json_object mode hung every card review
      // in prod (rev 00065: 100% 504 at 300s). Malformed JSON is recovered by
      // extractJsonFromLlmOutput instead.
    };
    // DeepSeek gets the resolved thinking param; Gemini keeps the exact body
    // it serves today — deepseekExtraBody is never merged into the Gemini
    // request (a `thinking` field would change its wire format).
    const deepseekCompletionBody = { ...completionBody, ...deepseekExtraBody };
    // Follow-ups stream through their own provider chain (DeepSeek with the
    // SDK's default retries, then Gemini with none), each attempt bounded by
    // REVIEW_FOLLOW_UP_ATTEMPT_TIMEOUT_MS (and the remaining request budget).
    // Card requests go through the card
    // provider chain (DeepSeek, then Gemini), each attempt under an app-owned
    // deadline capped by the request budget, no SDK retries (the validation
    // retry already makes a second attempt).
    const followUpProviders = [
      ...(openai ? [{ name: 'deepseek', create: (signal) => openai.chat.completions.create(deepseekCompletionBody, { signal }) }] : []),
      ...(gemini ? [{ name: 'gemini', create: (signal) => gemini.chat.completions.create({ ...completionBody, model: GEMINI_REVIEW_MODEL }, { signal, maxRetries: 0 }) }] : []),
    ];
    const cardProviders = [
      ...(openai ? [{ name: 'deepseek', create: (signal) => openai.chat.completions.create({ ...deepseekCompletionBody, stream: false }, { signal, maxRetries: 0 }) }] : []),
      ...(gemini ? [{ name: 'gemini', create: (signal) => gemini.chat.completions.create({ ...completionBody, model: GEMINI_REVIEW_MODEL, stream: false }, { signal, maxRetries: 0 }) }] : []),
    ];
    const failedCardProviders = new Set();
    const cardCompletion = () => requestCardCompletion({
      providers: cardProviders,
      failed: failedCardProviders,
      startedAt: reviewStartedAt,
      budgetMs: REVIEW_REQUEST_BUDGET_MS,
      perAttemptMs: REVIEW_CARD_COMPLETION_DEADLINE_MS,
      minAttemptMs: REVIEW_MIN_ATTEMPT_MS,
      signal: abortController.signal,
      onProviderError: ({ provider, error, raw }) => logLlmError(console.warn, {
        event: 'review_ai_provider_error',
        matchId,
        provider,
        error: raw,
        failure: error,
      }),
    });

    // When no primary_mistake category has its required evidence in this
    // match's catalog (typically unparsed matches: no timeline, no gold or CS
    // checkpoints), AI cards can never validate and a retry cannot help. Skip
    // the DeepSeek calls and serve the deterministic fallback (this request
    // consumed no budget — see aiCardsSkipped above). Follow-ups are
    // unaffected (no card validation).
    if (aiCardsSkipped) {
      console.warn(`[review:ai-validation] match=${matchId} ai_skipped reason=no_grounded_category`);
      const reviewCards = buildFallbackAiCards(matchFact, lang);
      responder.send({ reviewCards, grounded: isGrounded });
      responder.send({ reviewNotice: reviewAiUnavailableNotice(lang, matchFact.parsed ? 'no_timeline' : 'no_evidence') });
      responder.end();
      return;
    }

    // Follow-up fallback state: `forwarded` records whether any body chunk
    // already reached the client — that decides whether the deterministic
    // template replaces the whole answer or is appended as a closing note.
    let followUpForwarded = false;
    const sendFollowUpFallback = (decision) => {
      // Structured reason only (matchId + reason): never log the raw upstream
      // error, which can echo request details.
      console.warn(JSON.stringify({ severity: 'WARNING', event: 'review_followup_fallback', matchId, reason: decision.reason }));
      if (decision.append) {
        // Partial answer already streamed: append the full deterministic
        // template (its lead line + match facts) after a blank line so the
        // user gets the promised facts, not a dangling introduction.
        responder.send({ text: `\n\n${buildFollowUpFallbackText(matchFact, threeConclusions, lang)}`, grounded: isGrounded, fallback: true });
        responder.send({ reviewNotice: reviewFollowUpFallbackNotice(lang) });
      } else {
        responder.send({ text: buildFollowUpFallbackText(matchFact, threeConclusions, lang), grounded: isGrounded, fallback: true });
        responder.send({ reviewNotice: reviewFollowUpFallbackNotice(lang) });
      }
      responder.end();
    };

    try {
      if (followUp) {
        // Provider chain (DeepSeek → Gemini), each attempt under its own
        // deadline. Every non-happy ending — total failure before any text
        // was forwarded, or an interruption after partial text — degrades to
        // the deterministic template below; the raw provider error never
        // reaches the client.
        const outcome = await streamFollowUpCompletion({
          providers: followUpProviders,
          attemptMs: REVIEW_FOLLOW_UP_ATTEMPT_TIMEOUT_MS,
          // Each attempt is further capped by the request's remaining budget;
          // with less than REVIEW_MIN_ATTEMPT_MS left, remaining providers are
          // skipped and the deterministic template is served instead.
          startedAt: reviewStartedAt,
          budgetMs: REVIEW_REQUEST_BUDGET_MS,
          minAttemptMs: REVIEW_MIN_ATTEMPT_MS,
          signal: abortController.signal,
          onText: (text) => {
            responder.send({ text, grounded: isGrounded });
            followUpForwarded = true;
          },
          shouldStop: () => clientGone || res.writableEnded,
          onProviderError: ({ provider, error, raw }) => logLlmError(console.warn, {
            event: 'review_followup_provider_error',
            matchId,
            provider,
            error: raw,
            failure: error,
            lang,
          }),
        });
        // writableEnded stays false on an aborted close, so gate on
        // clientGone too: a gone client must not get a final write/end.
        if (clientGone || res.writableEnded) return;
        const decision = decideFollowUpOutcome(outcome);
        if (decision.action === 'end') {
          responder.end();
        } else {
          sendFollowUpFallback(decision);
        }
      } else {
        const first = await cardCompletion();
        if (clientGone) return;
        const fullText = first.text;
        const det = buildDeterministicReviewCards(matchFact, lang);
        const minKeyMoments = minRequiredKeyMoments(det._catalog || []);
        // Upstream cancellation on disconnect flows through the shared
        // abortController signal combined into each attempt's deadline.
        const requestCompletionText = () => cardCompletion();
        // Client-disconnect aborts during the retry rethrow (see
        // reviewAiRetry.js) and land in the outer catch, which returns
        // without writing to a response that already closed.
        const { reviewCards: resolvedCards, usedFallback } = await resolveReviewCardsWithRetry({
          firstText: fullText,
          firstProvider: first.provider,
          matchFact,
          lang,
          minKeyMoments,
          matchId,
          requestCompletionText,
          signal: abortController.signal,
          warn: (msg) => console.warn(msg),
          metric: (line) => console.log(line),
        });
        const cards = usedFallback
          ? buildFallbackAiCards(matchFact, lang)
          : resolvedCards;
        // Follow-up suggestions are never cleared: even with every provider
        // down (or none configured) a follow-up still gets a deterministic
        // template answer from match facts, so the UI must keep the follow-up
        // actions enabled (it reads empty followups as "follow-ups
        // unavailable"). followUpProvidersAvailable stays a pure lib helper.
        const reviewCards = cards;
        // writableEnded stays false on an aborted close, so gate on
        // clientGone too: a gone client must not get a final write/end.
        if (!clientGone && !res.writableEnded) {
          responder.send({ reviewCards, grounded: isGrounded });
          if (usedFallback) {
            responder.send({ reviewNotice: reviewAiUnavailableNotice(lang, 'invalid') });
          }
          responder.end();
        }
      }
    } catch (streamErr) {
      if (clientGone || (streamErr.name === 'AbortError' && abortController.signal.aborted)) return;
      if (streamErr.name === 'CompletionDeadlineError') console.warn(`[review:ai-validation] match=${matchId} completion_deadline_exceeded`);
      if (isLlmSdkError(streamErr)) {
        // Structured log with redacted detail; client gets the generic code
        // (cards) or the deterministic template (follow-ups — they always
        // answer, never ai_unavailable).
        logLlmError(console.error, { event: 'review_stream_llm_error', matchId, error: streamErr, lang });
        if (!res.writableEnded) {
          if (followUp) {
            sendFollowUpFallback({ reason: 'error', append: followUpForwarded });
          } else {
            const reviewCards = buildFallbackAiCards(matchFact, lang);
            responder.send({ reviewCards, grounded: isGrounded });
            responder.send({ reviewNotice: reviewAiUnavailableNotice(lang, 'provider') });
            responder.end();
          }
        }
        return;
      }
      // Unclassified stream errors can still be provider-derived (SDK
      // SyntaxError on a malformed provider body): redacted log, generic payload.
      logLlmError(console.error, { event: 'review_stream_error', matchId, error: streamErr, lang });
      if (!res.writableEnded) {
        if (followUp) {
          // Provider failure/timeout degrades to the deterministic follow-up
          // template. The raw upstream message never reaches the client —
          // error objects can echo request details (incl. auth material).
          sendFollowUpFallback({ reason: 'error', append: followUpForwarded });
        } else {
          const reviewCards = buildFallbackAiCards(matchFact, lang);
          responder.send({ reviewCards, grounded: isGrounded });
          responder.send({ reviewNotice: reviewAiUnavailableNotice(lang, 'provider') });
          responder.end();
        }
      }
    }
  } catch (error) {
    if (clientGone || (error.name === 'AbortError' && abortController.signal.aborted)) return;
    if (error.name === 'CompletionDeadlineError') {
      console.warn(JSON.stringify({ severity: 'WARNING', event: 'review_fetch_deadline_exceeded', matchId, budgetMs: REVIEW_FETCH_BUDGET_MS }));
      return respondReviewError(
        res,
        wantsStream,
        isZh ? '获取比赛数据超时，请稍后重试' : 'Timed out fetching match data; please retry',
        504,
        { retryable: true },
      );
    }
    if (isLlmSdkError(error)) {
      const sanitized = sanitizeLlmErrorForClient(lang);
      logLlmError(console.error, { event: 'review_llm_error', matchId, error, lang });
      return respondReviewError(res, wantsStream, sanitized.error, 502, { message: sanitized.message });
    }
    logLlmError(console.error, { event: 'review_error', matchId, error, lang });
    if (isOpenDotaFetchError(error)) {
      const mapped = mapOpenDotaFetchError(error, isZh);
      return respondReviewError(
        res,
        wantsStream,
        mapped.body.error,
        mapped.status,
        {
          upstream: mapped.body.upstream,
          upstreamStatus: mapped.body.upstreamStatus,
          retryable: mapped.body.retryable,
        }
      );
    }
    const internal = internalErrorForClient(lang);
    return respondReviewError(res, wantsStream, internal.error, 500, { message: internal.message });
  } finally {
    // Every exit path (SSE and JSON, success and error) detaches the
    // disconnect listeners — they are registered for both response modes.
    detachAbortListeners();
  }
}


// ============ In-app feedback (站内留言 / 假门兴趣) ============
// Best-effort local JSONL + durable stdout record for Cloud Logging.
// No auth / no admin UI. Cloud Run disk is ephemeral — treat
// `[feedback:record]` console lines as the durable copy.
// Submission validation (message/kind/contact caps) lives in
// lib/feedbackStore.js; kinds like 'fakedoor_steam_autoreview' record
// interest with an optional contact and no message.
const FEEDBACK_DIR = path.join(__dirname, 'data');
const FEEDBACK_FILE = path.join(FEEDBACK_DIR, 'feedback.jsonl');
const FEEDBACK_RATE_LIMIT = 20;
const FEEDBACK_RATE_WINDOW_MS = 60 * 60 * 1000;
const FEEDBACK_RATE_MAP_MAX = 2000;
/** @type {Map<string, number[]>} */
const feedbackHitsByIp = new Map();
/** @type {number[]} */
let feedbackGlobalHits = [];
const FEEDBACK_GLOBAL_LIMIT = 200;

// Client identity for the feedback rate limit and the parse-request budget.
// TRUSTED_PROXY_HOPS is an exact topology count (not a tunable): it must equal
// the number of trusted proxies appending to X-Forwarded-For. Production is a
// Cloud Run domain mapping (dota2.ai → Google Front End, no external LB): GFE
// appends exactly one entry — the client — so the default is 1.
//   1 (default) = Cloud Run direct/domain-mapped traffic
//   2           = an external HTTPS load balancer in front (appends
//                 "<client-ip>,<lb-ip>")
//   +1 per extra fronting proxy (IAP / API Gateway / CDN). Over-counting lets
//   clients spoof their IP; under-counting collapses users into one bucket.
//   XFF is only consulted when the TCP peer is private/loopback
//   (see lib/clientIp.js).
const trustedProxyHops = parseTrustedProxyHops(process.env.TRUSTED_PROXY_HOPS);

function resolveClientIp(req) {
  return resolveClientIpFromParts({
    peerAddress: req.socket?.remoteAddress || req.connection?.remoteAddress,
    forwardedFor: req.headers['x-forwarded-for'],
    trustedProxyHops,
  });
}

// Raw diagnostic for feedback records: the right-most XFF entry, i.e. what
// the nearest trusted proxy appended (with an external LB in front that is
// the LB's IP, not the client — the resolved client IP is in `ip`).
function feedbackXffClient(req) {
  const parts = parseForwardedFor(req.headers['x-forwarded-for']);
  return parts.length > 0 ? parts[parts.length - 1].slice(0, 64) : undefined;
}

function feedbackRateLimited(ip) {
  const now = Date.now();
  const prev = feedbackHitsByIp.get(ip) || [];
  const recent = prev.filter((t) => now - t < FEEDBACK_RATE_WINDOW_MS);
  if (recent.length >= FEEDBACK_RATE_LIMIT) {
    feedbackHitsByIp.set(ip, recent);
    return true;
  }
  recent.push(now);
  feedbackHitsByIp.set(ip, recent);

  if (feedbackHitsByIp.size > FEEDBACK_RATE_MAP_MAX) {
    // Evict expired entries first, then drop arbitrary oldest keys until under cap.
    for (const [k, times] of feedbackHitsByIp) {
      const kept = times.filter((t) => now - t < FEEDBACK_RATE_WINDOW_MS);
      if (kept.length === 0) feedbackHitsByIp.delete(k);
      else feedbackHitsByIp.set(k, kept);
    }
    while (feedbackHitsByIp.size > FEEDBACK_RATE_MAP_MAX) {
      const oldest = feedbackHitsByIp.keys().next().value;
      if (oldest === undefined) break;
      feedbackHitsByIp.delete(oldest);
    }
  }
  return false;
}

app.get('/api/feedback', (_req, res) => {
  res.status(405).json({ ok: false, error: 'Use POST' });
});

app.post('/api/feedback', (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const submission = normalizeFeedbackSubmission(body);
    if (!submission.ok) {
      return res.status(400).json({ ok: false, error: submission.error });
    }
    const { kind, message, name, contact } = submission;

    const ip = resolveClientIp(req);
    const now = Date.now();
    feedbackGlobalHits = feedbackGlobalHits.filter((t) => now - t < FEEDBACK_RATE_WINDOW_MS);
    // Limit key groups IPv6 by /64 (address rotation cannot multiply a
    // budget); the stored record keeps the resolved IP as before.
    if (feedbackGlobalHits.length >= FEEDBACK_GLOBAL_LIMIT || feedbackRateLimited(rateLimitKey(ip))) {
      return res.status(429).json({ ok: false, error: 'rate limited' });
    }
    feedbackGlobalHits.push(now);

    const lang = normalizeUiLang(body.lang || 'en');
    const ua = String(req.headers['user-agent'] || '').slice(0, 300);

    const record = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      kind: kind || undefined,
      name: name || undefined,
      contact: contact || undefined,
      message: message || undefined,
      lang,
      ip,
      xff: feedbackXffClient(req),
      ua: ua || undefined,
    };

    // Durable path for Cloud Run: full record on stdout → Cloud Logging.
    console.log('[feedback:record]', JSON.stringify(record));
    // Compact meta line for grepping (no PII beyond flags).
    console.log('[feedback]', JSON.stringify({
      id: record.id,
      ts: record.ts,
      kind: kind || null,
      name: Boolean(name),
      contact: Boolean(contact),
      len: message.length,
      lang,
    }));

    try {
      fs.mkdirSync(FEEDBACK_DIR, { recursive: true });
      fs.appendFileSync(FEEDBACK_FILE, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (diskErr) {
      // Disk is best-effort; Cloud Logging already has the record.
      console.warn('[feedback] jsonl append failed (continuing)', diskErr?.message || diskErr);
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error('[feedback] store failed', error);
    return res.status(500).json({ ok: false, error: 'store failed' });
  }
});

// ============ Analytics events (轻量埋点) ============
// POST /api/events { event, props, anonId }: 白名单事件、props 标量清洗
// （无自由文本）、anonId 短标识。只输出一条结构化 JSON 日志（type:
// 'analytics'）；IP 仅用于限流，绝不写入日志。校验在 lib/analyticsEvents.js。
const analyticsRateLimiter = createAnalyticsRateLimiter();

app.get('/api/events', (_req, res) => {
  res.status(405).json({ ok: false, error: 'Use POST' });
});

app.post('/api/events', (req, res) => {
  const validated = validateAnalyticsEvent(req.body);
  if (!validated.ok) {
    return res.status(400).json({ ok: false, error: validated.error });
  }

  // 客户端 IP 只作限流键（IPv6 按 /64 聚合），不进入任何持久化输出（无 IP、无 UA、无自由文本）。
  if (!analyticsRateLimiter.tryConsume(rateLimitKey(resolveClientIp(req)))) {
    return res.status(429).json({ ok: false, error: 'rate limited' });
  }

  console.log(JSON.stringify({
    type: 'analytics',
    event: validated.event,
    props: validated.props,
    anonId: validated.anonId,
    ts: new Date().toISOString(),
  }));
  return res.status(202).json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'dist')));

app.get('*', (req, res) => {
  // The /new v2 experience is gated/unlisted — keep it out of search indexes.
  if (req.path === '/new' || req.path.startsWith('/new/')) {
    res.set('X-Robots-Tag', 'noindex');
  }
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
  console.log(`Health check available at http://${HOST}:${PORT}/health`);
});

// Warm-load OpenDota constants at startup so /api/health does not report
// degraded until first request (non-blocking, retried on failure).
warmLoadOpenDotaConstants();
