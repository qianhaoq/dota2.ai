import { Hero, Attribute, Language } from '../types';
import type { MatchFact, ReviewParseStatus, ThreeConclusions } from '../types/matchReview';
import { parseReviewParseStatus } from '../utils/parseStatus';
import { serverErrorMessage } from '../utils/serverErrorMessage';

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

export const fetchHeroes = async (lang: string = 'en'): Promise<Hero[]> => {
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

export class MatchFactsError extends Error {
  upstream?: string;
  upstreamStatus?: number;
  retryable?: boolean;

  constructor(
    message: string,
    opts?: { upstream?: string; upstreamStatus?: number; retryable?: boolean },
  ) {
    super(message);
    this.name = 'MatchFactsError';
    this.upstream = opts?.upstream;
    this.upstreamStatus = opts?.upstreamStatus;
    this.retryable = opts?.retryable;
  }
}

export interface MatchFactsResult {
  matchFact: MatchFact;
  /** OpenDota replay parse status; null when the server did not include one. */
  parse: ReviewParseStatus | null;
  /** Fact-derived three conclusions; null on older payloads. */
  threeConclusions: ThreeConclusions | null;
}

/** 仅拉取比赛事实（球员/英雄），不触发 DeepSeek 复盘流 */
export const fetchMatchFacts = async (matchId: number, lang: Language = 'en', signal?: AbortSignal, heroId?: number): Promise<MatchFactsResult> => {
  const heroParam = heroId != null ? `&heroId=${encodeURIComponent(heroId)}` : '';
  const response = await fetch(`/api/review/${matchId}?lang=${encodeURIComponent(lang)}${heroParam}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  const data = await response.json().catch(
    () => ({} as {
      error?: string;
      matchFact?: MatchFact;
      parse?: unknown;
      threeConclusions?: ThreeConclusions | null;
      upstream?: string;
      upstreamStatus?: number;
      retryable?: boolean;
    }),
  );
  if (!response.ok) {
    throw new MatchFactsError(
      serverErrorMessage(data, lang === 'zh' ? '拉取比赛失败' : 'Failed to load match'),
      {
        upstream: data.upstream,
        upstreamStatus: data.upstreamStatus,
        retryable: data.retryable,
      },
    );
  }
  if (!data.matchFact) {
    throw new MatchFactsError(lang === 'zh' ? '比赛数据为空' : 'Match data is empty');
  }
  return {
    matchFact: data.matchFact,
    parse: parseReviewParseStatus(data.parse),
    threeConclusions: data.threeConclusions && typeof data.threeConclusions === 'object'
      ? data.threeConclusions
      : null,
  };
};

/**
 * Explicitly request an OpenDota replay parse for a match. The facts load
 * (fetchMatchFacts) is read-only and never submits — this endpoint is the
 * only submission path, so parse quota is only spent on user intent.
 * Returns the same parse-status payload shape (requested / pending /
 * parsed / throttled / failed), or throws with the server's error text.
 */
export const requestMatchParse = async (
  matchId: number,
  lang: Language = 'en',
  signal?: AbortSignal,
): Promise<ReviewParseStatus> => {
  const response = await fetch(
    `/api/review/${matchId}/parse-request?lang=${encodeURIComponent(lang)}`,
    {
      method: 'POST',
      // JSON content-type + custom header: both mark this as a non-simple
      // request the endpoint requires (CSRF / drive-by protection).
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({ lang }),
      signal,
    },
  );
  const data = await response.json().catch(
    () => ({} as { status?: unknown; jobId?: unknown; retryAfterSec?: unknown; message?: unknown; error?: string }),
  );
  const parse = parseReviewParseStatus(data);
  if (parse) return parse;
  throw new MatchFactsError(
    serverErrorMessage(data, lang === 'zh' ? '解析请求失败' : 'Failed to request parse'),
  );
};

export interface ReviewSuggestionBase {
  matchId: number;
  kind: 'recent' | 'highMmr';
  startTime: number;
  duration: number;
  radiantWin: boolean;
  opendotaUrl: string;
}

export interface ReviewProSuggestion extends ReviewSuggestionBase {
  kind: 'recent';
  radiantTeam: string;
  direTeam: string;
  leagueName: string;
  radiantScore?: number;
  direScore?: number;
}

export interface ReviewPublicSuggestion extends ReviewSuggestionBase {
  kind: 'highMmr';
  avgMmr: number | null;
  mmrLabel: string;
  radiantHeroNames: string[];
  direHeroNames: string[];
}

export type ReviewSuggestion = ReviewProSuggestion | ReviewPublicSuggestion;

export interface ReviewSuggestionsResponse {
  recent: ReviewProSuggestion[];
  highMmr: ReviewPublicSuggestion[];
  count: number;
  source: string;
  cacheAge: number | null;
  error?: string;
}

/** 复盘页推荐比赛（近期职业 + 高分路人），仅 OpenDota，不调用 DeepSeek */
export const fetchReviewSuggestions = async (
  lang: Language = 'en',
  limit: number = 6,
): Promise<ReviewSuggestionsResponse> => {
  try {
    const params = new URLSearchParams({ lang, limit: String(limit) });
    const response = await fetch(`/api/review/suggestions?${params}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(serverErrorMessage(data, lang === 'zh' ? '加载推荐失败' : 'Failed to load suggestions'));
    }
    return {
      recent: Array.isArray(data.recent) ? data.recent : [],
      highMmr: Array.isArray(data.highMmr) ? data.highMmr : [],
      count: data.count ?? 0,
      source: data.source || 'opendota',
      cacheAge: data.cacheAge ?? null,
      error: data.error,
    };
  } catch (error) {
    console.error('Review suggestions fetch error:', error);
    const message = error instanceof Error ? error.message : undefined;
    return {
      recent: [],
      highMmr: [],
      count: 0,
      source: 'error',
      cacheAge: null,
      error: message || (lang === 'zh' ? '暂时无法加载推荐比赛' : 'Failed to load match suggestions'),
    };
  }
};