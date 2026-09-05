import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

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

// ============ Cache Storage ============
const cache = {
  heroStats: { data: null, timestamp: 0 },
  matchups: new Map(), // Map<heroId, { data, timestamp }>
  // Foundation data constants
  heroes: { data: null, timestamp: 0 },
  items: { data: null, timestamp: 0 },
  abilities: { data: null, timestamp: 0 },
  // Steam localized data
  steamHeroesZh: { data: null, timestamp: 0 },
  steamHeroesEn: { data: null, timestamp: 0 }
};

async function fetchWithRetry(url, retries = 2, delay = 500) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
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

async function getHeroStats() {
  const now = Date.now();
  if (cache.heroStats.data && (now - cache.heroStats.timestamp) < CACHE_TTL_MS) {
    return cache.heroStats.data;
  }
  try {
    const data = await fetchWithRetry(`${OPENDOTA_API}/heroStats`);
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

function buildGroundedPrompt(radiant, dire, heroStats, matchupAnalysis, lang, userContext, isGrounded, heroConstants = {}) {
  const isZh = lang === 'zh';
  
  const t = {
    radiant: isZh ? '天辉' : 'Radiant',
    dire: isZh ? '夜魇' : 'Dire',
    none: isZh ? '无' : 'None',
    winRate: isZh ? '胜率' : 'WR',
    games: isZh ? '场比赛' : 'games',
    advantage: isZh ? '优势' : 'advantage',
    vs: isZh ? '对' : 'vs',
    statsTitle: isZh ? '来自 OpenDota 的数据统计' : 'OpenDota Statistics',
    radiantHeroes: isZh ? '天辉英雄数据' : 'Radiant Heroes',
    direHeroes: isZh ? '夜魇英雄数据' : 'Dire Heroes',
    radiantAdvantages: isZh ? '天辉优势对位 (基于OpenDota历史数据)' : 'Radiant Favorable Matchups (OpenDota data)',
    direAdvantages: isZh ? '夜魇优势对位 (基于OpenDota历史数据)' : 'Dire Favorable Matchups (OpenDota data)',
    dataUnavailable: isZh ? '[注意: OpenDota 数据暂时不可用，以下分析未经数据验证]' : '[Note: OpenDota data unavailable, analysis unverified]',
    userContext: isZh ? '用户补充的战术背景' : 'User-provided tactical context',
    analysisPrompt: isZh 
      ? '请基于以上OpenDota真实数据进行分析' 
      : 'Analyze based on the OpenDota data above',
    instructions: isZh ? [
      '预测胜率时必须引用上述具体数据',
      '分析关键对位优劣势时引用具体的胜率数据',
      '给出天辉的取胜条件',
      '推荐针对性装备'
    ] : [
      'Cite specific data when predicting win probability',
      'Reference specific win rates when analyzing key matchups',
      'Identify Radiant win conditions',
      'Recommend counter items'
    ],
    incompleteNote: isZh ? '如果阵容不完整，请针对已选英雄给出建议。' : 'If draft is incomplete, provide suggestions for the selected heroes.',
    langInstruction: isZh ? '请使用中文(简体)进行回答。' : 'Please respond in English.',
    roles: isZh ? '定位' : 'Roles',
    attr: isZh ? '属性' : 'Attr'
  };

  const attrNames = {
    str: isZh ? '力量' : 'STR',
    agi: isZh ? '敏捷' : 'AGI',
    int: isZh ? '智力' : 'INT',
    all: isZh ? '全能' : 'UNI'
  };

  const radiantNames = radiant.map(h => h.name).join(', ');
  const direNames = dire.map(h => h.name).join(', ');
  
  // Helper to format hero info with role/attribute
  const formatHeroWithMeta = (h) => {
    const s = heroStats[h.id];
    const c = Object.values(heroConstants).find(hc => hc.id === h.id);
    let info = s ? `${s.name} (${t.winRate}: ${s.winRate || 'N/A'}%)` : h.name;
    
    if (c) {
      const roles = (c.roles || s?.roles || []).slice(0, 2).join('/');
      const attr = attrNames[c.primary_attr] || '';
      if (roles || attr) {
        info += ` [${attr}${roles ? ', ' + roles : ''}]`;
      }
    } else if (s?.roles?.length) {
      info += ` [${s.roles.slice(0, 2).join('/')}]`;
    }
    return info;
  };
  
  let statsSection = '';
  if (isGrounded) {
    const radiantStats = radiant.map(formatHeroWithMeta).join('\n- ');
    const direStats = dire.map(formatHeroWithMeta).join('\n- ');
    
    statsSection = `
## ${t.statsTitle}:

### ${t.radiantHeroes}:
- ${radiantStats || t.none}

### ${t.direHeroes}:
- ${direStats || t.none}
`;

    if (matchupAnalysis.radiantAdvantages.length > 0) {
      statsSection += `
### ${t.radiantAdvantages}:
${matchupAnalysis.radiantAdvantages.slice(0, 5).map(a => 
  `- ${a.hero} ${t.vs} ${a.vsHero}: +${a.advantage}% ${t.advantage} (${a.winRate}% ${t.winRate}, ${a.games} ${t.games})`
).join('\n')}
`;
    }
    
    if (matchupAnalysis.direAdvantages.length > 0) {
      statsSection += `
### ${t.direAdvantages}:
${matchupAnalysis.direAdvantages.slice(0, 5).map(a => 
  `- ${a.hero} ${t.vs} ${a.vsHero}: +${a.advantage}% ${t.advantage} (${a.winRate}% ${t.winRate}, ${a.games} ${t.games})`
).join('\n')}
`;
    }
  } else {
    statsSection = `\n${t.dataUnavailable}\n`;
  }

  return `
${isZh ? '分析这场 DOTA 2 对局' : 'Analyze this DOTA 2 match'}:

**${t.radiant}:** ${radiantNames || t.none}
**${t.dire}:** ${direNames || t.none}

${statsSection}

**${t.userContext}:** ${userContext || t.none}

${t.analysisPrompt}:
${t.instructions.map((instr, i) => `${i + 1}. ${instr}`).join('\n')}

${t.incompleteNote}
${t.langInstruction}
`;
}

function getDraftSystemInstruction(lang) {
  const isZh = lang === 'zh';
  
  const headers = isZh 
    ? `## 胜率预测
## 关键对位分析
## 天辉取胜条件
## 推荐装备`
    : `## Win Probability
## Key Matchup Analysis
## Radiant Win Conditions
## Recommended Items`;

  const langNote = isZh 
    ? '请使用中文(简体)回答。' 
    : 'Please respond in English.';

  return `You are a professional DOTA 2 analyst and coach (like Ceb or Notail).
Your task is to analyze two team compositions (Radiant vs Dire) using the OpenDota statistics provided.

IMPORTANT: You must cite the specific statistics from OpenDota data when making claims about win rates, matchups, and advantages. Do not invent statistics.

Format your analysis with clear Markdown headers:
${headers}

Keep it concise, strategic, and use DOTA 2 terminology (e.g., "BKB", "power spike", "roshan control").
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
    
    try {
      [heroStats, heroConstants] = await Promise.all([
        getHeroStats(),
        getHeroConstants()
      ]);
      if (Object.keys(heroStats).length > 0 && (radiantIds.length > 0 || direIds.length > 0)) {
        matchupAnalysis = await aggregateMatchupData(radiantIds, direIds, heroStats);
        isGrounded = true;
      }
    } catch (err) {
      console.error('OpenDota fetch error:', err.message);
    }
    
    const prompt = buildGroundedPrompt(radiant, dire, heroStats, matchupAnalysis, lang, userContext, isGrounded, heroConstants);

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

app.use(express.static(path.join(__dirname, 'dist')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
  console.log(`Health check available at http://${HOST}:${PORT}/health`);
});
