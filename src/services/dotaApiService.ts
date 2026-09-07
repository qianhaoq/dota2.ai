import { Hero, Attribute, Language } from '../types';
import type { MatchFact } from '../types/matchReview';

const OPENDOTA_API = 'https://api.opendota.com/api';
const VALVE_CDN = 'https://cdn.cloudflare.steamstatic.com';

interface OpenDotaHero {
  id: number;
  name: string;
  localized_name: string;
  primary_attr: string;
  img: string; 
  icon: string;
}

interface MetaHero {
  id: number;
  name: string;
  nameZh?: string;
  nameEn?: string;
  aliases?: string[];
  shortName: string;
  primaryAttr: string;
  roles?: string[];
  rolesZh?: string[];
  img: string;
  imgVert: string;
  icon: string;
  winRate?: string | null;
}

interface MetaHeroesResponse {
  heroes: MetaHero[];
  count: number;
  steamLocalized: boolean;
}

const mapPrimaryAttr = (attr: string): Attribute => {
  switch (attr) {
    case 'agi': return Attribute.AGILITY;
    case 'int': return Attribute.INTELLIGENCE;
    case 'all': return Attribute.UNIVERSAL;
    case 'str': 
    default: return Attribute.STRENGTH;
  }
};

export const fetchHeroes = async (lang: string = 'zh'): Promise<Hero[]> => {
  try {
    const response = await fetch(`/api/meta/heroes?lang=${lang}`);
    if (response.ok) {
      const data: MetaHeroesResponse = await response.json();
      return data.heroes.map(h => ({
        id: h.id,
        name: h.name,
        nameZh: h.nameZh,
        nameEn: h.nameEn,
        aliases: h.aliases || [],
        attribute: mapPrimaryAttr(h.primaryAttr),
        roles: h.roles || [],
        rolesZh: h.rolesZh || [],
        img: h.imgVert,
        imgFallback: `${VALVE_CDN}/apps/dota2/images/heroes/${h.shortName}_vert.jpg`,
        icon: h.icon
      })).sort((a, b) => a.name.localeCompare(b.name, lang === 'zh' ? 'zh-CN' : 'en'));
    }
    throw new Error('Server meta API unavailable');
  } catch {
    console.log('Falling back to OpenDota heroStats API');
    return fetchHeroesFromOpenDota();
  }
};

const fetchHeroesFromOpenDota = async (): Promise<Hero[]> => {
  try {
    const response = await fetch(`${OPENDOTA_API}/heroStats`);
    if (!response.ok) throw new Error('Failed to fetch hero stats');
    
    const data: OpenDotaHero[] = await response.json();
    return data.map(mapOpenDotaHero).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    console.error("OpenDota API Error:", error);
    return [];
  }
};

const mapOpenDotaHero = (apiHero: OpenDotaHero): Hero => {
  const attr = mapPrimaryAttr(apiHero.primary_attr);
  const shortName = apiHero.name.replace('npc_dota_hero_', '');
  const fullImgUrl = `${VALVE_CDN}/apps/dota2/images/heroes/${shortName}_vert.jpg`;

  return {
    id: apiHero.id,
    name: apiHero.localized_name,
    attribute: attr,
    img: fullImgUrl
  };
};

/** 仅拉取比赛事实（球员/英雄），不触发 DeepSeek 复盘流 */
export const fetchMatchFacts = async (matchId: number, lang: Language = 'zh'): Promise<MatchFact> => {
  const response = await fetch(`/api/review/${matchId}?lang=${encodeURIComponent(lang)}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  const data = await response.json().catch(() => ({} as { error?: string; matchFact?: MatchFact }));
  if (!response.ok) {
    throw new Error(data.error || (lang === 'zh' ? '拉取比赛失败' : 'Failed to load match'));
  }
  if (!data.matchFact) {
    throw new Error(lang === 'zh' ? '比赛数据为空' : 'Match data is empty');
  }
  return data.matchFact;
};