export interface HeroNameCn {
  id: number;
  nameZh: string;
  aliases: string[];
}

export interface RoleMapping {
  en: string;
  zh: string;
  position?: number[];
}

export const ROLE_MAPPINGS: RoleMapping[] = [
  { en: 'Carry', zh: '核心', position: [1, 2] },
  { en: 'Support', zh: '辅助', position: [4, 5] },
  { en: 'Nuker', zh: '爆发', position: [] },
  { en: 'Disabler', zh: '控制', position: [] },
  { en: 'Durable', zh: '肉盾', position: [3] },
  { en: 'Escape', zh: '逃生', position: [] },
  { en: 'Pusher', zh: '推进', position: [] },
  { en: 'Initiator', zh: '先手', position: [3] },
];

export const POSITION_LABELS: Record<number, { en: string; zh: string }> = {
  1: { en: 'Pos 1', zh: '1号位' },
  2: { en: 'Pos 2', zh: '2号位' },
  3: { en: 'Pos 3', zh: '3号位' },
  4: { en: 'Pos 4', zh: '4号位' },
  5: { en: 'Pos 5', zh: '5号位' },
};

export const HERO_NAMES_CN: HeroNameCn[] = [
  { id: 1, nameZh: '敌法师', aliases: ['敌法', 'AM', '蓝猫克星', '法师克星'] },
  { id: 2, nameZh: '斧王', aliases: ['斧头', '斧子'] },
  { id: 3, nameZh: '祸乱之源', aliases: ['祸乱', 'Bane', '噩梦'] },
  { id: 4, nameZh: '血魔', aliases: ['血', 'BS', '嗜血狂魔'] },
  { id: 5, nameZh: '水晶室女', aliases: ['冰女', 'CM', '水晶'] },
  { id: 6, nameZh: '卓尔游侠', aliases: ['小黑', 'Drow', '黑弓'] },
  { id: 7, nameZh: '撼地者', aliases: ['小牛', 'ES', '撼地神牛', '地震'] },
  { id: 8, nameZh: '主宰', aliases: ['剑圣', 'Jugg', '剑神'] },
  { id: 9, nameZh: '米拉娜', aliases: ['白虎', 'Mirana', 'POTM'] },
  { id: 10, nameZh: '变体精灵', aliases: ['水人', 'Morphling', '变体'] },
  { id: 11, nameZh: '影魔', aliases: ['SF', '灵魂守卫', '影魔王'] },
  { id: 12, nameZh: '幻影长矛手', aliases: ['猴子', 'PL', '幻刺矛'] },
  { id: 13, nameZh: '帕克', aliases: ['精灵龙', 'Puck', '仙女龙'] },
  { id: 14, nameZh: '帕吉', aliases: ['屠夫', 'Pudge', '胖子'] },
  { id: 15, nameZh: '剃刀', aliases: ['电棍', 'Razor', '闪电幽魂'] },
  { id: 16, nameZh: '沙王', aliases: ['蝎子', 'SK', '沙漠之王'] },
  { id: 17, nameZh: '风暴之灵', aliases: ['蓝猫', 'Storm', '风暴'] },
  { id: 18, nameZh: '斯温', aliases: ['流浪剑客', 'Sven', '红剑'] },
  { id: 19, nameZh: '小小', aliases: ['山岭巨人', 'Tiny', '石头人'] },
  { id: 20, nameZh: '复仇之魂', aliases: ['VS', '复仇', '仇魂'] },
  { id: 21, nameZh: '风行者', aliases: ['风行', 'WR', '风女'] },
  { id: 22, nameZh: '宙斯', aliases: ['Zeus', '雷神', '电神'] },
  { id: 23, nameZh: '昆卡', aliases: ['船长', 'Kunkka', '海军上将'] },
  { id: 25, nameZh: '莉娜', aliases: ['Lina', '火女', '秀逗魔导士'] },
  { id: 26, nameZh: '莱恩', aliases: ['Lion', '狮子', '恶魔巫师'] },
  { id: 27, nameZh: '暗影萨满', aliases: ['萨满', 'SS', '小Y'] },
  { id: 28, nameZh: '斯拉达', aliases: ['大鱼', 'Slardar', '鱼人'] },
  { id: 29, nameZh: '潮汐猎人', aliases: ['潮汐', 'Tide', '大海怪'] },
  { id: 30, nameZh: '巫医', aliases: ['WD', '医生', '毒奶'] },
  { id: 31, nameZh: '巫妖', aliases: ['Lich', '冰巫妖', '小冰'] },
  { id: 32, nameZh: '力丸', aliases: ['隐刺', 'Riki', '隐形刺客'] },
  { id: 33, nameZh: '谜团', aliases: ['Enigma', '黑洞', '虚空'] },
  { id: 34, nameZh: '修补匠', aliases: ['TK', 'Tinker', '地精修补匠'] },
  { id: 35, nameZh: '狙击手', aliases: ['火枪', 'Sniper', '矮人'] },
  { id: 36, nameZh: '瘟疫法师', aliases: ['死灵法师', 'Necro', '绿皮'] },
  { id: 37, nameZh: '术士', aliases: ['Warlock', '老术士'] },
  { id: 38, nameZh: '兽王', aliases: ['BM', 'Beastmaster', '兽皇'] },
  { id: 39, nameZh: '痛苦女王', aliases: ['QOP', '女王', '痛苦'] },
  { id: 40, nameZh: '剧毒术士', aliases: ['毒狗', 'Veno', '剧毒'] },
  { id: 41, nameZh: '虚空假面', aliases: ['虚空', 'Void', 'FV'] },
  { id: 42, nameZh: '冥魂大帝', aliases: ['骷髅王', 'WK', '大帝'] },
  { id: 43, nameZh: '死亡先知', aliases: ['DP', '死灵女巫', '死女'] },
  { id: 44, nameZh: '幻影刺客', aliases: ['PA', '幻刺', '暗杀'] },
  { id: 45, nameZh: '帕格纳', aliases: ['骨法', 'Pugna', '骨灵'] },
  { id: 46, nameZh: '圣堂刺客', aliases: ['TA', '圣堂', '刺客'] },
  { id: 47, nameZh: '冥界亚龙', aliases: ['毒龙', 'Viper', '绿龙'] },
  { id: 48, nameZh: '露娜', aliases: ['Luna', '月骑', '月亮骑士'] },
  { id: 49, nameZh: '龙骑士', aliases: ['DK', 'Dragon Knight', '龙骑'] },
  { id: 50, nameZh: '戴泽', aliases: ['暗牧', 'Dazzle', '暗影牧师'] },
  { id: 51, nameZh: '发条技师', aliases: ['发条', 'Clock', '齿轮'] },
  { id: 52, nameZh: '拉席克', aliases: ['老鹿', 'Leshrac', '羊头'] },
  { id: 53, nameZh: '先知', aliases: ['NP', "Nature's Prophet", '大树'] },
  { id: 54, nameZh: '噬魂鬼', aliases: ['小狗', 'LS', 'Naix'] },
  { id: 55, nameZh: '黑暗贤者', aliases: ['黑贤', 'DS', '贤者'] },
  { id: 56, nameZh: '克林克兹', aliases: ['小骷髅', 'Clinkz', '骨弓'] },
  { id: 57, nameZh: '全能骑士', aliases: ['全能', 'Omni', '骑士'] },
  { id: 58, nameZh: '魅惑魔女', aliases: ['小鹿', 'Enchantress', '魅惑'] },
  { id: 59, nameZh: '哈斯卡', aliases: ['神灵武士', 'Huskar', '投矛'] },
  { id: 60, nameZh: '暗夜魔王', aliases: ['夜魔', 'NS', '黑夜'] },
  { id: 61, nameZh: '育母蜘蛛', aliases: ['蜘蛛', 'Brood', '大蜘蛛'] },
  { id: 62, nameZh: '赏金猎人', aliases: ['赏金', 'BH', '隐刺'] },
  { id: 63, nameZh: '编织者', aliases: ['蚂蚁', 'Weaver', '织布者'] },
  { id: 64, nameZh: '杰奇洛', aliases: ['双头龙', 'Jakiro', '冰火龙'] },
  { id: 65, nameZh: '蝙蝠骑士', aliases: ['蝙蝠', 'Bat', '火蝠'] },
  { id: 66, nameZh: '陈', aliases: ['Chen', '奶陈', '圣骑士'] },
  { id: 67, nameZh: '幽鬼', aliases: ['Spectre', '幽灵', '小幽'] },
  { id: 68, nameZh: '远古冰魄', aliases: ['冰魂', 'AA', '冰球'] },
  { id: 69, nameZh: '末日使者', aliases: ['末日', 'Doom', '大红'] },
  { id: 70, nameZh: '熊战士', aliases: ['大熊', 'Ursa', '拍拍熊'] },
  { id: 71, nameZh: '裂魂人', aliases: ['白牛', 'SB', '冲锋牛'] },
  { id: 72, nameZh: '矮人直升机', aliases: ['飞机', 'Gyro', '炮艇'] },
  { id: 73, nameZh: '炼金术士', aliases: ['炼金', 'Alch', '大绿'] },
  { id: 74, nameZh: '祈求者', aliases: ['卡尔', 'Invoker', '三C'] },
  { id: 75, nameZh: '沉默术士', aliases: ['沉默', 'Silencer', '静默'] },
  { id: 76, nameZh: '殁境神蚀者', aliases: ['OD', '黑鸟', '羊刀偷智力'] },
  { id: 77, nameZh: '狼人', aliases: ['Lycan', '狼王', '变狼'] },
  { id: 78, nameZh: '酒仙', aliases: ['熊猫', 'Brew', '熊猫酒仙'] },
  { id: 79, nameZh: '暗影恶魔', aliases: ['SD', '暗魔', '影魔2'] },
  { id: 80, nameZh: '德鲁伊', aliases: ['熊德', 'LD', '小德'] },
  { id: 81, nameZh: '混沌骑士', aliases: ['CK', '混沌', '黑马'] },
  { id: 82, nameZh: '米波', aliases: ['地卜师', 'Meepo', '狗头'] },
  { id: 83, nameZh: '树精卫士', aliases: ['大树', 'Treant', '树人'] },
  { id: 84, nameZh: '食人魔魔法师', aliases: ['蓝胖', 'Ogre', '双头'] },
  { id: 85, nameZh: '不朽尸王', aliases: ['尸王', 'Undying', '僵尸'] },
  { id: 86, nameZh: '拉比克', aliases: ['Rubick', '法师', '偷技能'] },
  { id: 87, nameZh: '干扰者', aliases: ['萨尔', 'Disruptor', '电牛'] },
  { id: 88, nameZh: '司夜刺客', aliases: ['小强', 'Nyx', '甲虫'] },
  { id: 89, nameZh: '娜迦海妖', aliases: ['小娜迦', 'Naga', '娜迦'] },
  { id: 90, nameZh: '光之守卫', aliases: ['KOTL', '光法', '白马'] },
  { id: 91, nameZh: '艾欧', aliases: ['小精灵', 'Io', '电球'] },
  { id: 92, nameZh: '维萨吉', aliases: ['死灵飞龙', 'Visage', '鸟德'] },
  { id: 93, nameZh: '斯拉克', aliases: ['小鱼人', 'Slark', '鱼人'] },
  { id: 94, nameZh: '美杜莎', aliases: ['大娜迦', 'Medusa', '蛇发女妖'] },
  { id: 95, nameZh: '巨魔战将', aliases: ['巨魔', 'Troll', 'TW'] },
  { id: 96, nameZh: '半人马战行者', aliases: ['人马', 'Centaur', '撞人马'] },
  { id: 97, nameZh: '马格纳斯', aliases: ['猛犸', 'Magnus', '马格'] },
  { id: 98, nameZh: '伐木机', aliases: ['伐木', 'Timber', '锯齿'] },
  { id: 99, nameZh: '钢背兽', aliases: ['刚背', 'BB', '刺猬'] },
  { id: 100, nameZh: '巨牙海民', aliases: ['海民', 'Tusk', '大牙'] },
  { id: 101, nameZh: '天怒法师', aliases: ['天怒', 'Sky', '蓝鸟'] },
  { id: 102, nameZh: '亚巴顿', aliases: ['死骑', 'Abaddon', '死亡骑士'] },
  { id: 103, nameZh: '上古巨神', aliases: ['大牛', 'ET', '远古'] },
  { id: 104, nameZh: '军团指挥官', aliases: ['军团', 'LC', '女王'] },
  { id: 105, nameZh: '工程师', aliases: ['炸弹人', 'Techies', '地雷'] },
  { id: 106, nameZh: '灰烬之灵', aliases: ['火猫', 'Ember', '余烬'] },
  { id: 107, nameZh: '大地之灵', aliases: ['土猫', 'Earth Spirit', '土灵'] },
  { id: 108, nameZh: '孽主', aliases: ['大根', 'Underlord', '深渊'] },
  { id: 109, nameZh: '恐怖利刃', aliases: ['TB', 'Terrorblade', '恐怖'] },
  { id: 110, nameZh: '凤凰', aliases: ['火鸟', 'Phoenix', '不死鸟'] },
  { id: 111, nameZh: '神谕者', aliases: ['先知', 'Oracle', '神谕'] },
  { id: 112, nameZh: '寒冬飞龙', aliases: ['冰龙', 'WW', '飞龙'] },
  { id: 113, nameZh: '天穹守望者', aliases: ['电狗', 'Arc', '守望者'] },
  { id: 114, nameZh: '齐天大圣', aliases: ['猴王', 'MK', '大圣'] },
  { id: 119, nameZh: '邪影芳灵', aliases: ['小仙女', 'Willow', '暗柳'] },
  { id: 120, nameZh: '石鳞剑士', aliases: ['穿山甲', 'Pangolier', '滚滚'] },
  { id: 121, nameZh: '天涯墨客', aliases: ['墨客', 'Grimstroke', '画师'] },
  { id: 123, nameZh: '森海飞霞', aliases: ['松鼠', 'Hoodwink', '森海'] },
  { id: 126, nameZh: '虚无之灵', aliases: ['紫猫', 'Void Spirit', '虚灵'] },
  { id: 128, nameZh: '电炎绝手', aliases: ['奶奶', 'Snapfire', '老奶奶'] },
  { id: 129, nameZh: '玛尔斯', aliases: ['战神', 'Mars', '马尔斯'] },
  { id: 131, nameZh: '马戏团团长', aliases: ['团长', 'Ringmaster', '马戏团'] },
  { id: 135, nameZh: '破晓辰星', aliases: ['破晓', 'Dawnbreaker', '晨星'] },
  { id: 136, nameZh: '玛西', aliases: ['Marci', '小丫头', '马尔西'] },
  { id: 137, nameZh: '獸', aliases: ['原始', 'Primal', '野兽'] },
  { id: 138, nameZh: '穆尔塔', aliases: ['女枪', 'Muerta', '亡灵'] },
  { id: 145, nameZh: '凯斯', aliases: ['Kez', '刺客', '忍者'] },
  { id: 155, nameZh: '拉戈', aliases: ['Largo', '大块头'] },
];

export const heroNameCnMap: Map<number, HeroNameCn> = new Map(
  HERO_NAMES_CN.map(h => [h.id, h])
);

export function getHeroNameZh(id: number): string | undefined {
  return heroNameCnMap.get(id)?.nameZh;
}

export function getHeroAliases(id: number): string[] {
  return heroNameCnMap.get(id)?.aliases || [];
}

export function matchHeroBySearch(
  hero: { id: number; name: string; nameZh?: string; nameEn?: string },
  query: string
): boolean {
  const q = query.toLowerCase().trim();
  if (!q) return true;
  
  if (hero.name?.toLowerCase().includes(q)) return true;
  if (hero.nameZh?.toLowerCase().includes(q)) return true;
  if (hero.nameEn?.toLowerCase().includes(q)) return true;
  
  const cnData = heroNameCnMap.get(hero.id);
  if (cnData) {
    if (cnData.nameZh.toLowerCase().includes(q)) return true;
    if (cnData.aliases.some(alias => alias.toLowerCase().includes(q))) return true;
  }
  
  return false;
}

export function translateRole(roleEn: string, lang: 'zh' | 'en'): string {
  if (lang === 'en') return roleEn;
  const mapping = ROLE_MAPPINGS.find(r => r.en === roleEn);
  return mapping?.zh || roleEn;
}

export function getRoleTags(roles: string[], lang: 'zh' | 'en', limit: number = 2): string[] {
  return roles.slice(0, limit).map(r => translateRole(r, lang));
}
