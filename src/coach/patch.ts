import type { Bi } from './types';

/**
 * The current Dota 2 patch, shown on the home page.
 * Every line is quoted from Valve's own patch notes
 * (https://www.dota2.com/datafeed/patchnotes?version=7.42, en + schinese) —
 * never paraphrased into new numbers. Item names come from lib/coach/data/names.json.
 */
export const CURRENT_PATCH = {
  version: '7.42',
  date: '2026-11-18',
  notesUrl: 'https://www.dota2.com/patches/7.42',
  highlights: [
    {
      en: 'Base hero health 120 → 200; health per point of Strength 22 → 20.',
      zh: '英雄基础生命值 120 → 200；每点力量提供的生命值 22 → 20。',
    },
    {
      en: 'Passive gold per minute no longer scales over game time. Every hero gets 50 XP per minute after the horn.',
      zh: '被动每分钟金钱不再随游戏时间提升；号角吹响后所有英雄每分钟获得 50 经验。',
    },
    {
      en: 'Building bounties decreased (e.g. tier 1 tower gold per player 90 → 75); Roshan gold per player 135 → 125.',
      zh: '建筑赏金下调（如一塔每名玩家金钱 90 → 75）；肉山每名玩家金钱 135 → 125。',
    },
    {
      en: 'Tormentor first spawns at 15:00 (was 20:00) and always drops a Greater Horn of Battle. Roshan respawns 1 minute faster after each kill, down to 5 minutes.',
      zh: '痛苦魔方首次刷新从 20:00 提前到 15:00，必定掉落大战斗号角；肉山每次阵亡后基础复活时间减少 1 分钟，最低 5 分钟。',
    },
    {
      en: 'Most magic and pure damage spells deal less damage; items add less spell amplification, area and cast range.',
      zh: '大多数魔法和纯粹伤害技能伤害降低；物品对技能增强、作用范围和施法距离的加成减少。',
    },
  ] as Bi[],
  newItems: [
    { key: 'bloodslinger', en: 'Bloodslinger', zh: '血腥投带' },
    { key: 'caduceus', en: 'Caduceus', zh: '双蛇杖' },
    { key: 'ristuls_devotion', en: "Ristul's Devotion", zh: '瑞斯图尔的奉献' },
    { key: 'berserkers_sabatons', en: 'Sabatons of Mordiggian', zh: '莫尔迪基安的护足' },
    { key: 'skypiercer', en: 'Skypiercer', zh: '破天之矛' },
    { key: 'starforge', en: 'Starforge', zh: '锻星炉' },
  ],
  /** What the patch means for the review itself — honest about lagging comparisons. */
  forCoach: {
    en: 'The coach knows the new items. For the first weeks most same-hero benchmarks and pro games are still from 7.41, and gold now comes in slower late — read item-timing comparisons as a rough guide.',
    zh: '教练已认识新装备。新版本前几周，同英雄对比和职业案例大多还来自 7.41，后期经济也变慢了——装备时间类对比请当作粗略参考。',
  } as Bi,
};

export const itemIcon = (key: string) => `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/${key}.png`;

/** The home page's patch block. Live from GET /api/patch/news (lib/patch/news.js); CURRENT_PATCH until it answers. */
export interface PatchNews {
  version: string;
  date: string;
  url: string;
  newItems: { key: string; en: string; zh: string }[];
  highlights: Bi[];
  forCoach: Bi | null;
  update: { version: string; date: string; url: string; changes: { heroes: number; items: number } } | null;
}

export const SHIPPED_NEWS: PatchNews = {
  version: CURRENT_PATCH.version,
  date: CURRENT_PATCH.date,
  url: CURRENT_PATCH.notesUrl,
  newItems: CURRENT_PATCH.newItems,
  highlights: CURRENT_PATCH.highlights,
  forCoach: CURRENT_PATCH.forCoach,
  update: null,
};

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const VALVE = /^https:\/\/www\.dota2\.com\/patches\/[\w.]+$/;

/**
 * The server's answer as the page shows it, or null when it is not one (the page then keeps what it has).
 * Valve's Chinese line is missing until Valve translates it: the English one stands in.
 * Highlights still being chosen for the patch this build shipped with: the shipped ones stand in.
 */
export function readPatchNews(body: unknown): PatchNews | null {
  const b = body as Record<string, any> | null;
  if (!b || !str(b.version) || !DATE.test(b.date) || !VALVE.test(b.url) || !Array.isArray(b.newItems) || !Array.isArray(b.highlights)) return null;
  const bi = (x: any): Bi | null => (x && str(x.en) ? { en: x.en, zh: str(x.zh) ? x.zh : x.en } : null);
  const highlights = b.highlights.map(bi).filter((h: Bi | null): h is Bi => h !== null);
  const u = b.update;
  return {
    version: b.version,
    date: b.date,
    url: b.url,
    newItems: b.newItems.filter((it: any) => it && /^[a-z0-9_]+$/.test(it.key) && str(it.en)).map((it: any) => ({ key: it.key, en: it.en, zh: str(it.zh) ? it.zh : it.en })),
    highlights: highlights.length ? highlights : b.version === SHIPPED_NEWS.version ? SHIPPED_NEWS.highlights : [],
    forCoach: bi(b.forCoach),
    update: u && str(u.version) && DATE.test(u.date) && VALVE.test(u.url) && Number.isInteger(u.changes?.heroes) && Number.isInteger(u.changes?.items)
      ? { version: u.version, date: u.date, url: u.url, changes: { heroes: u.changes.heroes, items: u.changes.items } }
      : null,
  };
}
