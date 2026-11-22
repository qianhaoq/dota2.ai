// MUST stay the first import: wraps console.* with secret redaction before any
// dependency (openai SDK, express, …) can log raw provider output to stdout.
import './lib/installConsoleRedaction.js';
import { createReplayIngest } from './lib/matchReview/replayIngest/index.js';
import { createReplayIngestHandler } from './lib/matchReview/replayIngest/endpoint.js';
import { createV1Router } from './routes/v1/index.js';
import { securityHeaders } from './routes/v1/support.js';

import { createPhrasingCompletion } from './lib/matchReview/phrasingCompletion.js';
import express from 'express';
import path from 'path';
import fs from 'fs';

import { fileURLToPath } from 'url';
import OpenAI from 'openai';

import { validateReviewPostRequest } from './lib/matchReview/reviewRequestGuard.js';

import {
  createParseRequestTracker,
  createParseRequestBudget,
} from './lib/matchReview/matchParse.js';
import { createMatchDetailCache } from './lib/matchReview/matchDetailCache.js';
import { isMatchParsed } from './lib/matchReview/matchParse.js';
import { createGcsBucket } from './lib/matchReview/replayIngest/gcs.js';
import { createMatchStore } from './lib/matchStore.js';
import { createReviewParseRequestHandler, rejectParseRequestGet } from './lib/matchReview/parseRequestEndpoint.js';
import { isRetryableHttpStatus, mapOpenDotaFetchError } from './lib/matchReview/openDotaErrors.js';

import { computeApiHealth } from './lib/serverHealth.js';
import { combineAbortSignals } from './lib/abortSignals.js';

import { streamFollowUpCompletion } from './lib/matchReview/followUpCompletion.js';
import { clampFollowUpAttemptMs } from './lib/matchReview/followUpTimeout.js';

import { redactSecrets } from './lib/llmErrors.js';
import { publicModelName, resolveDeepSeekConfig, loggableModelName } from './lib/llmConfig.js';
import { jsonBodyErrorHandler } from './lib/jsonBodyErrors.js';
import { matchPathRedirect, retiredPathRedirect } from './lib/matchPathRedirect.js';
import { staticNotFound } from './lib/staticNotFound.js';
import { parsePositiveInt } from './lib/positiveInt.js';

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
import { parseTrustedProxyHops, resolveClientIp as resolveClientIpFromParts } from './lib/clientIp.js';

import { validateAnalyticsEvent, createAnalyticsRateLimiter } from './lib/analyticsEvents.js';
import { createSlidingWindowLimiter } from './lib/rateLimiter.js';
import { createCoachRouter } from './lib/coach/router.js';
import { createCoachService } from './lib/coach/service.js';
import { createCaseService } from './lib/coach/caseSource.js';
import { createRecentService } from './lib/coach/recent.js';
import { createLlmRateLimit } from './lib/llmRateLimit.js';
import { rateLimitKey } from './lib/rateLimitKey.js';
import { createOpenDotaClient, OPENDOTA_BASE } from './lib/upstream/opendota.js';
import { createSharedCooldown } from './lib/upstream/sharedCooldown.js';
import { createStratzClient } from './lib/upstream/stratz.js';
import { loadConstantsSnapshot } from './lib/constantsSnapshot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

app.use(securityHeaders);
app.use('/api/v1', express.json(), (error, req, res, next) => {
  if ([400, 413].includes(error?.status)) return res.status(400).json({ code: 'INVALID_INPUT', retryable: false, message_key: 'err.invalid_input' });
  next(error);
});
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
const OPENDOTA_API = OPENDOTA_BASE;

 // 1 hour for matchup data
const CONSTANTS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;   

// OpenDota constants shipped with the build (scripts/refresh-data.mjs): no
// constants requests at runtime. Without a snapshot the getters fetch, as before.
const CONSTANTS = loadConstantsSnapshot();

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

// Every OpenDota request goes through one client: API key, token bucket,
// in-flight merging, Retry-After and a 429 cooldown (lib/upstream/opendota.js).
// One GCS bucket (MATCH_CACHE_BUCKET) backs both the durable match cache and
// the OpenDota cooldown that every instance shares. Unset: memory only.
const cacheBucket = (() => {
  const name = (process.env.MATCH_CACHE_BUCKET || '').trim();
  if (!name) return null;
  try { return createGcsBucket(name); } catch (err) {
    console.warn(`[match-store] disabled: ${err?.message || err}`);
    return null;
  }
})();
const opendotaCooldown = cacheBucket
  ? createSharedCooldown({ bucket: cacheBucket, log: (msg) => console.warn(`[opendota-cooldown] ${msg}`) })
  : undefined;
const opendota = createOpenDotaClient({
  apiKey: process.env.OPENDOTA_API_KEY || '',
  rpm: parsePositiveInt(process.env.OPENDOTA_RPM, 0, { max: 100000 }) || undefined,
  cooldown: opendotaCooldown,
  log: (msg) => console.warn(`[opendota] ${msg}`),
});

async function fetchWithRetry(url, retries = 2, delay = 500, options = {}) {
  const { timeoutMs, signal: callerSignal, priority, ...fetchOptions } = options;
  if (opendota.isOpenDota(url)) {
    return opendota.getJson(url, { retries, delay, timeoutMs, signal: callerSignal, priority });
  }
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
        `[fetchWithRetry] ${safeUrl} attempt=${i + 1}/${retries + 1} status=${enriched.status ?? 'network'} latencyMs=${latencyMs} error=${redactSecrets(enriched.message)}`
      );
      if (i === retries || enriched.retryable === false) throw enriched;
      await new Promise((r) => setTimeout(r, delay * (i + 1)));
    }
  }
}

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

// ============ OpenDota Constants Fetchers ============

async function getHeroConstants(fetchOptions = {}) {
  if (CONSTANTS.heroes) {
    if (!cache.heroes.data) cache.heroes = { data: CONSTANTS.heroes, timestamp: Date.now() };
    return CONSTANTS.heroes;
  }
  const now = Date.now();
  if (cache.heroes.data && (now - cache.heroes.timestamp) < CONSTANTS_CACHE_TTL_MS) {
    return cache.heroes.data;
  }
  try {
    const data = await fetchWithRetry(`${OPENDOTA_API}/constants/heroes`, 2, 500, fetchOptions);
    cache.heroes = { data, timestamp: now };
    console.log(`Loaded ${Object.keys(data).length} heroes from OpenDota constants`);
    return data;
  } catch (err) {
    console.error('Failed to fetch hero constants:', redactSecrets(err.message));
    return cache.heroes.data || {};
  }
}

async function getItemConstants(fetchOptions = {}) {
  if (CONSTANTS.items) {
    if (!cache.items.data) cache.items = { data: CONSTANTS.items, timestamp: Date.now() };
    return CONSTANTS.items;
  }
  const now = Date.now();
  if (cache.items.data && (now - cache.items.timestamp) < CONSTANTS_CACHE_TTL_MS) {
    return cache.items.data;
  }
  try {
    const data = await fetchWithRetry(`${OPENDOTA_API}/constants/items`, 2, 500, fetchOptions);
    cache.items = { data, timestamp: now };
    console.log(`Loaded ${Object.keys(data).length} items from OpenDota constants`);
    return data;
  } catch (err) {
    console.error('Failed to fetch item constants:', redactSecrets(err.message));
    return cache.items.data || {};
  }
}

async function getAbilityConstants(fetchOptions = {}) {
  if (CONSTANTS.abilities) {
    if (!cache.abilities.data) cache.abilities = { data: CONSTANTS.abilities, timestamp: Date.now() };
    return CONSTANTS.abilities;
  }
  const now = Date.now();
  if (cache.abilities.data && (now - cache.abilities.timestamp) < CONSTANTS_CACHE_TTL_MS) {
    return cache.abilities.data;
  }
  try {
    const data = await fetchWithRetry(`${OPENDOTA_API}/constants/abilities`, 2, 500, fetchOptions);
    cache.abilities = { data, timestamp: now };
    console.log(`Loaded ${Object.keys(data).length} abilities from OpenDota constants`);
    return data;
  } catch (err) {
    console.error('Failed to fetch ability constants:', redactSecrets(err.message));
    return cache.abilities.data || {};
  }
}

app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0'
  });
});

// OpenDota usage on this instance: calls and errors per endpoint, 429s,
// merged requests, queue state, and the remaining quota OpenDota reports.
// Counts only — no keys, no URLs with query strings.
app.get('/api/health/upstream', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    opendota: opendota.snapshot(),
    cooldown: opendotaCooldown ? opendotaCooldown.snapshot() : { shared: false },
    matchStore: matchStore ? matchStore.snapshot() : { configured: false },
    stratz: stratz ? stratz.snapshot() : { configured: false },
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
        console.warn(`[constants] warm-load failed after ${attempt} attempts (${redactSecrets(err?.message) || 'unknown'}); /api/health reports degraded until first use`);
        return;
      }
      console.warn(`[constants] warm-load attempt ${attempt} failed (${redactSecrets(err?.message) || 'unknown'}); retrying in ${WARM_CONSTANTS_RETRY_DELAY_MS / 1000}s`);
      setTimeout(() => warmLoadOpenDotaConstants(attempt + 1), WARM_CONSTANTS_RETRY_DELAY_MS);
    });
}

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

const reviewLlmLimit = createLlmRateLimit({
  limiter: createLlmGroupLimiter('LLM_RATE_REVIEW_PER_IP', 'LLM_GLOBAL_GUARD_REVIEW', 30),
  resolveClientIp,
  name: 'review',
});

// ============ Match Replay Review ============
// Unparsed entries live under a short TTL and never overwrite parsed data
// (see lib/matchReview/matchDetailCache.js).
// Parsed matches never change: with MATCH_CACHE_BUCKET set they are kept in
// GCS, shared by every instance and every deploy (lib/matchStore.js). Reads
// are bounded and any store failure is a miss, so OpenDota stays the source.
// STRATZ as a fallback source when OpenDota fails (STRATZ_API_TOKEN; off
// without it). Its copies are basic and unparsed: see lib/upstream/stratz.js.
const stratz = process.env.STRATZ_API_TOKEN
  ? createStratzClient({ token: process.env.STRATZ_API_TOKEN, log: (msg) => console.warn(`[stratz] ${msg}`) })
  : null;

const matchStore = cacheBucket
  ? createMatchStore({ bucket: cacheBucket, isParsed: isMatchParsed, log: (msg) => console.warn(`[match-store] ${msg}`) })
  : null;

const matchDetailCache = createMatchDetailCache({
  fetchMatch: async (matchId, options = {}) => {
    const stored = matchStore ? await matchStore.getMatch(matchId) : null;
    if (stored) return stored;
    let raw;
    try {
      raw = await fetchWithRetry(`${OPENDOTA_API}/matches/${matchId}`, 4, 1000, {
        ...options, timeoutMs: options.timeoutMs ?? 25000,
      });
    } catch (err) {
      // OpenDota down or rate-limited (not "no such match", not a caller
      // abort): a basic, unparsed copy from STRATZ beats an error page.
      if (!stratz || err?.status === 404 || options.signal?.aborted) throw err;
      try {
        return await stratz.fetchMatch(matchId, { signal: options.signal });
      } catch (fallbackErr) {
        console.warn(`[stratz] fallback for ${matchId} failed: ${fallbackErr?.message || fallbackErr}`);
        throw err;
      }
    }
    const data = { ...raw, opendota_fetched_at: new Date().toISOString() };
    matchStore?.putMatch(matchId, data); // only if parsed; fire-and-forget
    return data;
  },
  log: (msg) => console.warn(`[match-detail-cache] ${msg}`),
});

const replayIngest = createReplayIngest();
async function getMatchDetail(matchId, fetchOptions = {}) {
  return replayIngest.overlay(await matchDetailCache.get(matchId, fetchOptions));
}

// OpenDota POST /request/{match_id} dedup/rate-limit state (per match),
// plus global/per-client submission budgets (env-tunable) so a single client
// or an OpenDota outage cannot amplify into a stream of parse submissions.
function envPositiveInt(name, fallback, max) {
  // Number-based parsing (parsePositiveInt): parseInt('1e9') === 1 would
  // silently turn scientific-notation env values into 1; non-decimal literals
  // ('0x1F40' / '0o17' / '0b101') fall back, and `max` clamps the ceiling.
  return parsePositiveInt(process.env[name], fallback, max != null ? { max } : undefined);
}

const parseRequestTracker = createParseRequestTracker();
const parseRequestBudget = createParseRequestBudget({
  globalMax: envPositiveInt('PARSE_BUDGET_GLOBAL_MAX', 10, 100),
  perClientMax: envPositiveInt('PARSE_BUDGET_PER_CLIENT_MAX', 3, 20),
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

// Explicit parse-request endpoint — the ONLY path that calls submitParseRequest.
const handleMatchReviewParseRequest = createReviewParseRequestHandler({
  submitParseRequest,
  getMatchDetail,
  resolveClientIp,
  log: (msg) => console.log(`[review:parse-request] ${msg}`),
});


// Coach report (deterministic, no LLM): GET /api/coach/:matchId
// Case studies: pro games via OpenDota Explorer, profiled once and cached.
// Raw pro matches bypass matchDetailCache so they never evict viewers' games.
let builtIndexHtml;
function readBuiltIndexHtml() {
  if (builtIndexHtml === undefined) {
    try { builtIndexHtml = fs.readFileSync(path.join(__dirname, 'dist', 'index.html'), 'utf8'); } catch { builtIndexHtml = null; }
  }
  return builtIndexHtml;
}
// Pro cases are background work: they queue behind pages a user is waiting on.
// Pro games and their candidate lists are shared through the match store too:
// a cold instance does not re-run the explorer query or re-fetch every case game.
const CASE_POOL_STORE_MS = 12 * 60 * 60 * 1000;
const coachCases = createCaseService({
  explorer: async (sql) => {
    const stored = matchStore ? await matchStore.getResult(`explorer:${sql}`, CASE_POOL_STORE_MS) : null;
    if (stored) return stored;
    const out = await fetchWithRetry(`${OPENDOTA_API}/explorer?sql=${encodeURIComponent(sql)}`, 1, 1000, { timeoutMs: 20000, priority: 'low' });
    if (Array.isArray(out?.rows)) matchStore?.putResult(`explorer:${sql}`, { rows: out.rows });
    return out;
  },
  fetchMatch: async (id) => {
    const stored = matchStore ? await matchStore.getMatch(id) : null;
    if (stored) return stored;
    const raw = await fetchWithRetry(`${OPENDOTA_API}/matches/${id}`, 1, 1000, { timeoutMs: 20000, priority: 'low' });
    matchStore?.putMatch(id, raw);
    return raw;
  },
  log: (msg) => console.warn(`[coach-cases] ${msg}`),
});

// "Your recent games" from a Steam friend code (OpenDota recentMatches).
const coachRecent = createRecentService({
  fetchRecent: (id) => fetchWithRetry(`${OPENDOTA_API}/players/${id}/recentMatches`, 1, 1000, { timeoutMs: 10000 }),
});
// Follow-ups share the review LLM budget and the DeepSeek → Gemini chain.
const coachAskDeps = {
  llm: reviewLlmLimit,
  providers: (messages) => [
    ...(openai ? [{ name: 'deepseek', create: (signal) => openai.chat.completions.create({ model: DEEPSEEK_MODEL, messages, stream: true, ...deepseekExtraBody }, { signal }) }] : []),
    ...(gemini ? [{ name: 'gemini', create: (signal) => gemini.chat.completions.create({ model: GEMINI_REVIEW_MODEL, messages, stream: true }, { signal, maxRetries: 0 }) }] : []),
  ],
  stream: streamFollowUpCompletion,
  attemptMs: REVIEW_FOLLOW_UP_ATTEMPT_TIMEOUT_MS,
};
// One coach service for the web routes and the remote MCP coach tools: one
// budget per caller (IPv6 /64), whichever surface they use (lib/coach/service.js).
const coachService = createCoachService({
  getMatchDetail,
  resolveClientIp,
  mapError: mapOpenDotaFetchError,
  cases: coachCases,
  recent: coachRecent,
  ask: coachAskDeps,
  log: (msg) => console.warn(`[coach] ${msg}`),
});

app.use(createCoachRouter({
  getMatchDetail,
  resolveClientIp,
  mapError: mapOpenDotaFetchError,
  log: (msg) => console.warn(`[coach] ${msg}`),
  limiter: coachService.limiter,
  cases: coachCases,
  // Link previews for /r/:matchId (built app only; dev serves via Vite).
  page: { html: readBuiltIndexHtml },
  recent: coachRecent,
  ask: {
    // Same-origin guard for the browser route only; MCP callers are agents.
    guard: (req) => {
      const g = validateReviewPostRequest(req);
      return g.ok ? g : { ok: false, status: g.status, error: g.errorEn };
    },
    ...coachAskDeps,
  },
}));

// Review v1 API, OpenAPI/llms docs and the remote MCP endpoint (/mcp), whose
// coach tools run in process through coachService.
app.use(createV1Router({
  fetchMatch: getMatchDetail,
  replayIngest,
  phrasingCompletion: openai ? createPhrasingCompletion({ client: openai }) : undefined,
  coachForRequest: coachService.forRequest,
}));

// Explicit OpenDota parse submission — the ONLY path that calls submitParseRequest
// (facts load and review stream report parse status read-only). GET gets a JSON
// 405 so it never falls through to the SPA index.html fallback.
app.post('/api/review/:matchId/replay-ingest', createReplayIngestHandler({ingest:replayIngest,getMatchDetail,resolveClientIp}));
app.get('/api/review/:matchId/replay-ingest', rejectParseRequestGet);
app.post('/api/review/:matchId/parse-request', handleMatchReviewParseRequest);
app.get('/api/review/:matchId/parse-request', rejectParseRequestGet);

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

// URLs that are not pages any more (lib/matchPathRedirect.js), before
// static/SPA: /match/:id → /r/:id; /new, /m, /legacy → / (keeping ?lang).
// Unknown or removed API paths are a JSON 404, never the SPA's index.html.
app.use('/api', (req, res) => res.status(404).json({ code: 'not_found', error: 'No such API endpoint' }));

app.use(retiredPathRedirect);
app.get('/match/:id', matchPathRedirect);

app.use(express.static(path.join(__dirname, 'dist')));
// A missing build file 404s instead of becoming index.html (lib/staticNotFound.js).
app.use(staticNotFound());

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
  console.log(`Health check available at http://${HOST}:${PORT}/health`);
});

// Warm-load OpenDota constants at startup so /api/health does not report
// degraded until first request (non-blocking, retried on failure).
warmLoadOpenDotaConstants();
