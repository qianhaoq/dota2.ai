import staticHeroesData from '../data/static-heroes.json' with { type: 'json' };

/** @typedef {{ id: number, nameEn: string, nameZh: string, internalSlug: string, internalName: string }} StaticHero */

/** @type {Record<string, StaticHero>} */
export const STATIC_HEROES = staticHeroesData.heroes;
export const STATIC_HEROES_PATCH = staticHeroesData.patch;

/** @param {number | string} heroId */
export function getStaticHero(heroId) {
  return Object.hasOwn(STATIC_HEROES, heroId) ? STATIC_HEROES[heroId] : undefined;
}

const squash = (s) => String(s ?? '').toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[^a-z0-9]/g, '');
const squashInput = (s) => String(s ?? '').trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s_'’\-·.]+/g, '');
const BY_SLUG = new Map(Object.values(STATIC_HEROES).map((hero) => [hero.internalSlug, hero]));
// A replay names a hero by its entity class ("queen_of_pain", "anti_mage", "vengeful_spirit"), which is the
// internal name with the words split: the same letters. Matched with the underscores left out, then by the
// English name ("zeus" for zuus). No two heroes share a squashed key.
const BY_SQUASHED = new Map();
for (const hero of Object.values(STATIC_HEROES)) for (const key of [hero.nameEn, hero.internalSlug]) if (key) BY_SQUASHED.set(squash(key), hero);

/**
 * Unambiguous alternate official names (reconciling Valve schinese `names.json` vs `static-heroes.json`)
 * and widely used CN/EN Dota 2 hero nicknames, keyed by numeric hero id.
 * Every alias maps to at most one hero; ambiguous words (e.g. "queen", "es", "ss") are intentionally omitted.
 */
export const HERO_INPUT_ALIASES = Object.freeze({
  1: ['敌法', 'am'],
  2: ['斧头', '斧子'],
  3: ['祸乱', '痛苦之源'],
  4: ['bs'],
  5: ['冰女', 'cm'],
  6: ['小黑', '黑弓', 'drow', 'dr'],
  7: ['小牛', '撼地神牛', '牛头'],
  8: ['剑圣', 'jugg'],
  9: ['白虎', 'potm', 'pom'],
  10: ['水人', 'morph'],
  11: ['sf'],
  12: ['猴子', 'pl'],
  13: ['精灵龙'],
  14: ['屠夫'],
  15: ['雷泽', '剃刀', '电棍', '电魂'],
  16: ['蝎子', 'sk'],
  17: ['蓝猫', 'storm'],
  18: ['流浪剑客', '流浪'],
  19: ['山岭巨人'],
  20: ['复仇', 'vs'],
  21: ['风行', '风女', 'wr'],
  22: ['雷神'],
  23: ['船长'],
  25: ['火女', '秀逗魔导士'],
  26: ['恶魔巫师'],
  27: ['小y', '萨满'],
  28: ['大鱼', '大鱼人'],
  29: ['潮汐', 'tide'],
  30: ['wd'],
  32: ['隐刺', '隐形刺客', 'sa'],
  34: ['tk'],
  35: ['火枪', '矮人狙击手'],
  36: ['死灵法师', '死灵法', 'nec', 'necro'],
  39: ['女王', 'qop'],
  40: ['剧毒', 'veno'],
  41: ['虚空', 'fv'],
  42: ['骷髅王', 'wk', 'snk'],
  43: ['dp'],
  44: ['幻刺', 'pa'],
  45: ['骨法'],
  46: ['圣堂', 'ta'],
  47: ['毒龙'],
  48: ['月骑'],
  49: ['龙骑', 'dk'],
  50: ['暗牧'],
  51: ['发条', 'clock'],
  52: ['老鹿', '受折磨的灵魂', 'ts'],
  53: ['先知', '自然先知', 'np'],
  54: ['小狗', 'naix', 'ls'],
  55: ['黑贤', '兔子', 'ds'],
  56: ['小骷髅', '骨弓'],
  57: ['全能', 'omni'],
  58: ['小鹿', 'ench'],
  59: ['神灵武士', '神灵'],
  60: ['夜魔', 'ns'],
  61: ['蜘蛛', 'brood'],
  62: ['赏金', 'bh'],
  63: ['蚂蚁'],
  64: ['双头龙', 'thd'],
  65: ['蝙蝠', 'bat'],
  66: ['圣骑士'],
  67: ['spec', 'spe'],
  68: ['冰魂', 'aa'],
  69: ['末日'],
  70: ['拍拍熊', '拍拍', '大熊'],
  71: ['白牛', 'sb'],
  72: ['飞机', 'gyro'],
  73: ['炼金', 'alch', 'ga'],
  74: ['卡尔', '召唤师'],
  75: ['沉默'],
  76: ['黑鸟', 'Outworld Destroyer', 'Outworld Devourer', 'od'],
  78: ['熊猫', '熊猫酒仙', 'brew'],
  79: ['毒狗', 'sd'],
  80: ['熊德', '德鲁伊', '独行德鲁伊', 'ld'],
  81: ['混沌', 'ck'],
  82: ['地卜师', '狗头'],
  83: ['大树', '树精', 'treant'],
  84: ['蓝胖', 'ogre'],
  85: ['尸王'],
  86: ['大魔导师'],
  87: ['萨尔'],
  88: ['小强', 'nyx'],
  89: ['小娜迦', 'naga'],
  90: ['光法', 'kotl'],
  91: ['小精灵'],
  92: ['死灵飞龙', '死灵龙'],
  93: ['小鱼人', '小鱼'],
  94: ['大娜迦', '一姐', 'dusa', 'med'],
  95: ['巨魔', 'troll'],
  96: ['人马', '半人马', 'cent'],
  97: ['猛犸'],
  98: ['伐木', 'timber'],
  99: ['刚背', '刚背兽', 'bb'],
  100: ['海民'],
  101: ['天怒', 'sky'],
  102: ['死骑', '地狱领主', 'loa'],
  103: ['大牛', 'et'],
  104: ['军团', 'lc'],
  105: ['炸弹人', '炸弹'],
  106: ['火猫', 'ember'],
  107: ['土猫'],
  108: ['大屁股', '深渊领主', 'pitlord'],
  109: ['魂守', '灵魂守卫', 'tb'],
  110: ['火鸟'],
  111: ['神谕'],
  112: ['冰龙', 'ww'],
  113: ['电狗', 'arc', 'aw'],
  114: ['大圣', '猴王', 'mk'],
  119: ['小仙女', '花仙子', 'willow', 'dw'],
  120: ['滚滚', '穿山甲', 'pango'],
  121: ['墨客', 'grim'],
  123: ['松鼠', '小松鼠'],
  126: ['紫猫'],
  128: ['老奶奶', '奶奶', '电炎'],
  129: ['战神'],
  131: ['百戏大王', '马戏团团长', '团长', '百戏'],
  135: ['大锤', '破晓', 'dawn', 'db'],
  137: ['兽', '獸', '大兽', 'pb'],
  138: ['女枪', '奶绿', '琼英碧灵', '穆尔塔'],
  145: ['凯', '凯斯'],
  155: ['朗戈', '拉戈'],
});

const BY_INPUT = new Map();
for (const hero of Object.values(STATIC_HEROES)) {
  for (const candidate of [hero.internalSlug, hero.internalName, hero.nameEn, hero.nameZh, ...(HERO_INPUT_ALIASES[hero.id] ?? [])]) {
    const k = squashInput(candidate);
    if (k && !BY_INPUT.has(k)) BY_INPUT.set(k, hero);
  }
}

/**
 * The hero a key means: the internal slug ("queenofpain"), the key a replay trace uses for it
 * ("queen_of_pain"), the internal name ("npc_dota_hero_queenofpain") or the English name. Null when it is none.
 * @param {string | null | undefined} key
 */
export function heroByKey(key) {
  if (typeof key !== 'string' || !key) return null;
  return BY_SLUG.get(key) ?? BY_SQUASHED.get(squash(key)) ?? null;
}

/**
 * Resolve any user/agent hero identifier into a `StaticHero`: numeric/string hero id, internal slug,
 * replay entity key ("queen_of_pain"), `npc_dota_hero_*`, English display name (incl. both Outworld
 * Devourer / Destroyer), Chinese official name (both `static-heroes.json` and Valve schinese `names.json`),
 * or curated unambiguous CN/EN nickname ("小鹿", "骷髅王", "蓝猫", "PA", "QOP"). Null when unknown.
 * @param {string | number | null | undefined} input
 */
export function heroByInput(input) {
  if (input == null || input === '') return null;
  if (typeof input === 'number') return Number.isInteger(input) ? getStaticHero(input) ?? null : null;
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;
  if (/^\d{1,4}$/.test(raw)) return getStaticHero(Number(raw)) ?? null;
  return BY_SLUG.get(raw) ?? BY_INPUT.get(squashInput(raw)) ?? null;
}
/** A Map-like view of heroByKey, for code written against a map of slugs. */
export const HEROES_BY_KEY = Object.freeze({ get: (key) => heroByKey(key) ?? undefined, has: (key) => heroByKey(key) != null, keys: () => BY_SLUG.keys() });

export function staticHeroNamesCnMap() {
  return Object.fromEntries(Object.values(STATIC_HEROES).map(hero => [hero.id, { nameZh: hero.nameZh }]));
}

export function staticHeroConstantsMap() {
  return Object.fromEntries(Object.values(STATIC_HEROES).map(hero => [
    hero.internalName,
    { id: hero.id, name: hero.internalName, localized_name: hero.nameEn },
  ]));
}
