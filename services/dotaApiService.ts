import { Hero, Attribute } from '../types';

const API_BASE_URL = 'https://api.opendota.com/api';
// Use Steam's Cloudflare CDN for better reliability
const CDN_BASE_URL = 'https://cdn.cloudflare.steamstatic.com';

interface OpenDotaHero {
  id: number;
  name: string; // e.g. "npc_dota_hero_antimage"
  localized_name: string;
  primary_attr: string;
  img: string; 
  icon: string;
}

export const fetchHeroes = async (): Promise<Hero[]> => {
  try {
    const response = await fetch(`${API_BASE_URL}/heroStats`);
    if (!response.ok) throw new Error('Failed to fetch hero stats');
    
    const data: OpenDotaHero[] = await response.json();
    
    return data.map(mapOpenDotaHero).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    console.error("Dota API Error:", error);
    return [];
  }
};

const mapOpenDotaHero = (apiHero: OpenDotaHero): Hero => {
  // Convert 'str' -> 'Strength', 'all' -> 'Universal', etc.
  let attr = Attribute.STRENGTH;
  switch (apiHero.primary_attr) {
    case 'agi': attr = Attribute.AGILITY; break;
    case 'int': attr = Attribute.INTELLIGENCE; break;
    case 'all': attr = Attribute.UNIVERSAL; break;
    case 'str': default: attr = Attribute.STRENGTH; break;
  }

  // Fix: Construct Vertical Image URL using the internal hero name
  // The API 'img' field is inconsistent. Using the internal name is reliable.
  // e.g. "npc_dota_hero_antimage" -> "antimage" -> "antimage_vert.jpg"
  const shortName = apiHero.name.replace('npc_dota_hero_', '');
  const fullImgUrl = `${CDN_BASE_URL}/apps/dota2/images/heroes/${shortName}_vert.jpg`;

  return {
    id: apiHero.id,
    name: apiHero.localized_name,
    attribute: attr,
    img: fullImgUrl
  };
};