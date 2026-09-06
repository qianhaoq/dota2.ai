import { Hero, Language } from '../types';
import type { MatchFact } from '../types/matchReview';

export interface MatchupAdvantage {
  hero: string;
  vsHero: string;
  advantage: number;
  winRate: string;
  games: number;
}

export interface MatchupData {
  radiantAdvantages: MatchupAdvantage[];
  direAdvantages: MatchupAdvantage[];
  grounded: boolean;
}

// ============ Meta Tier Types ============
export interface TierHero {
  id: number;
  name: string;
  nameZh: string;
  nameEn: string;
  shortName: string;
  winRate: number;
  pickRate: number;
  gamesPlayed: number;
  roles: string[];
  rolesZh?: string[];
  img: string;
  icon: string;
  rank: number;
  tier: 'S' | 'A' | 'B' | 'C';
}

export interface TierResponse {
  heroes: TierHero[];
  count: number;
  totalHeroes: number;
  source: string;
  cacheAge: number | null;
  error?: string;
}

// ============ Playbook Types ============
export interface PlaybookItem {
  id?: number;
  key: string;
  name: string;
  count: number;
  cost: number;
  img: string;
}

export interface PlaybookMatchup {
  enemy: string;
  enemyId: number;
  enemyNameZh?: string;
  enemyNameEn?: string;
  winRate: string;
  advantage: string;
  gamesPlayed: number;
}

export interface PlaybookHero {
  heroId: number;
  heroName: string;
  nameZh?: string;
  nameEn?: string;
  winRate: string | null;
  roles: string[];
  rolesZh?: string[];
  items: {
    startGame: PlaybookItem[];
    earlyGame: PlaybookItem[];
    midGame: PlaybookItem[];
    lateGame: PlaybookItem[];
  };
  vsEnemies: PlaybookMatchup[];
}

export interface PlaybookStreamCallbacks {
  onData: (data: PlaybookHero[], focusHero: PlaybookHero | null) => void;
  onChunk: (text: string) => void;
  onComplete: () => void;
  onError: (error: string) => void;
}

// ============ Pro/Public Match Types ============
export interface ProMatch {
  matchId: number;
  startTime: number;
  duration: number;
  radiantWin: boolean;
  radiantTeam: string;
  direTeam: string;
  leagueName: string;
  radiantScore?: number;
  direScore?: number;
  opendotaUrl: string;
}

export interface PublicMatchHero {
  id: number;
  name: string;
  nameZh?: string;
  nameEn?: string;
  icon: string | null;
}

export interface PublicMatch {
  matchId: number;
  startTime: number;
  duration: number;
  radiantWin: boolean;
  avgMmr: number | null;
  mmrLabel: string;
  radiantHeroes: PublicMatchHero[];
  direHeroes: PublicMatchHero[];
  radiantHeroNames: string[];
  direHeroNames: string[];
  opendotaUrl: string;
}

export interface ProMatchesResponse {
  matches: ProMatch[];
  count: number;
  source: string;
  cacheAge: number | null;
  error?: string;
}

export interface PublicMatchesResponse {
  matches: PublicMatch[];
  count: number;
  source: string;
  cacheAge: number | null;
  error?: string;
}

export interface AnalyzeStreamCallbacks {
  onChunk: (text: string) => void;
  onComplete: (grounded: boolean) => void;
  onError: (error: string) => void;
  onMatchupData?: (data: MatchupData) => void;
}

export const analyzeDraftStream = (
  radiant: Hero[], 
  dire: Hero[], 
  lang: Language, 
  userContext: string | undefined,
  callbacks: AnalyzeStreamCallbacks
): AbortController => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000); // 120s timeout for streaming

  (async () => {
    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify({ radiant, dire, lang, userContext }),
        signal: controller.signal
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to analyze draft');
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let isGrounded = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              clearTimeout(timeoutId);
              callbacks.onComplete(isGrounded);
              return;
            }
            try {
              const parsed = JSON.parse(data);
              if (parsed.error) {
                callbacks.onError(parsed.error);
                return;
              }
              if (parsed.matchupData && callbacks.onMatchupData) {
                callbacks.onMatchupData(parsed.matchupData);
              }
              if (parsed.text) {
                callbacks.onChunk(parsed.text);
              }
              if (parsed.grounded !== undefined) {
                isGrounded = parsed.grounded;
              }
            } catch {
              // Skip malformed JSON
            }
          }
        }
      }

      clearTimeout(timeoutId);
      callbacks.onComplete(isGrounded);
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        callbacks.onError('请求已取消');
      } else {
        callbacks.onError(error.message || 'Unknown error');
      }
    }
  })();

  return controller;
};

export const analyzeDraft = async (radiant: Hero[], dire: Hero[], lang: Language, userContext?: string): Promise<string> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ radiant, dire, lang, userContext }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to analyze draft');
    }

    return data.text || "Failed to generate analysis.";
  } catch (error: any) {
    clearTimeout(timeoutId);
    console.error("Analysis Request Error:", error);
    if (error.name === 'AbortError') {
      return "The Ancient is under attack! (Request Timed Out - The oracle is taking too long)";
    }
    return `The Ancient is under attack! (Server Error: ${error.message})`;
  }
};

export interface HeroSuggestion {
  id: number;
  name: string;
  nameZh?: string;
  nameEn?: string;
  score: string;
  winRate: string | null;
  roles?: string[];
  rolesZh?: string[];
  bestAdvantage?: string;
  totalGames?: number;
  reasons: Array<{
    type: string;
    enemy: string;
    enemyZh?: string;
    enemyId?: number;
    advantage: string;
    winRate: string;
    gamesPlayed?: number;
  }>;
}

export const fetchSuggestions = async (
  allies: Hero[], 
  enemies: Hero[], 
  side: 'radiant' | 'dire',
  role?: string,
  lang?: string
): Promise<HeroSuggestion[]> => {
  try {
    const response = await fetch('/api/suggestions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ allies, enemies, side, limit: 8, role, lang }),
    });

    const data = await response.json();
    return data.suggestions || [];
  } catch (error) {
    console.error('Suggestions fetch error:', error);
    return [];
  }
};

export const chatWithShopkeeper = async (history: {role: string, parts: {text: string}[]}[], message: string, lang: Language): Promise<string> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ history, message, lang }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to chat');
    }

    return data.text || "...";
  } catch (error: any) {
    clearTimeout(timeoutId);
    console.error("Chat Request Error:", error);
    return `The shop is closed. (Server Error: ${error.message})`;
  }
};

// ============ Meta Tier API ============
export const fetchTierList = async (
  lang: Language = 'zh',
  role?: string,
  limit: number = 20,
  sortBy: 'winRate' | 'pickRate' = 'winRate'
): Promise<TierResponse> => {
  try {
    const params = new URLSearchParams({ lang, limit: limit.toString(), sortBy });
    if (role) params.append('role', role);
    
    const response = await fetch(`/api/meta/tier?${params}`);
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.error || 'Failed to fetch tier list');
    }
    
    return data;
  } catch (error: any) {
    console.error('Tier list fetch error:', error);
    return { heroes: [], count: 0, totalHeroes: 0, source: 'error', cacheAge: null, error: error.message };
  }
};

// ============ Pro/Public Matches API ============
export const fetchProMatches = async (
  lang: Language = 'zh',
  limit: number = 10
): Promise<ProMatchesResponse> => {
  try {
    const params = new URLSearchParams({ lang, limit: limit.toString() });
    const response = await fetch(`/api/meta/pro-matches?${params}`);
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.error || 'Failed to fetch pro matches');
    }
    
    return data;
  } catch (error: any) {
    console.error('Pro matches fetch error:', error);
    return { matches: [], count: 0, source: 'error', cacheAge: null, error: error.message };
  }
};

export const fetchPublicMatches = async (
  lang: Language = 'zh',
  limit: number = 10,
  heroId?: number
): Promise<PublicMatchesResponse> => {
  try {
    const params = new URLSearchParams({ lang, limit: limit.toString() });
    if (heroId) params.append('heroId', heroId.toString());
    
    const response = await fetch(`/api/meta/public-matches?${params}`);
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.error || 'Failed to fetch public matches');
    }
    
    return data;
  } catch (error: any) {
    console.error('Public matches fetch error:', error);
    return { matches: [], count: 0, source: 'error', cacheAge: null, error: error.message };
  }
};

// ============ Playbook Streaming API ============
export const fetchPlaybookStream = (
  allies: Hero[],
  enemies: Hero[],
  side: 'radiant' | 'dire',
  lang: Language,
  focusHeroId?: number,
  callbacks?: PlaybookStreamCallbacks
): AbortController => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000);

  (async () => {
    try {
      const response = await fetch('/api/playbook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify({ allies, enemies, side, lang, focusHeroId }),
        signal: controller.signal
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to fetch playbook');
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              clearTimeout(timeoutId);
              callbacks?.onComplete();
              return;
            }
            try {
              const parsed = JSON.parse(data);
              if (parsed.error) {
                callbacks?.onError(parsed.error);
                return;
              }
              if (parsed.playbookData && callbacks?.onData) {
                callbacks.onData(parsed.playbookData, parsed.focusHero);
              }
              if (parsed.text && callbacks?.onChunk) {
                callbacks.onChunk(parsed.text);
              }
            } catch {
              // Skip malformed JSON
            }
          }
        }
      }

      clearTimeout(timeoutId);
      callbacks?.onComplete();
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        callbacks?.onError('请求已取消');
      } else {
        callbacks?.onError(error.message || 'Unknown error');
      }
    }
  })();

  return controller;
};

// ============ Match Replay Review ============

export interface ReviewStreamCallbacks {
  onData: (matchFact: MatchFact) => void;
  onChunk: (text: string) => void;
  onComplete: (grounded: boolean) => void;
  onError: (error: string) => void;
}

export const fetchMatchReviewStream = (
  matchId: number,
  lang: Language,
  heroId?: number,
  callbacks?: ReviewStreamCallbacks
): AbortController => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000);

  (async () => {
    try {
      const params = new URLSearchParams({ lang });
      if (heroId) params.append('heroId', String(heroId));

      const response = await fetch(`/api/review/${matchId}?${params}`, {
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to fetch match review');
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let isGrounded = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') {
            clearTimeout(timeoutId);
            callbacks?.onComplete(isGrounded);
            return;
          }
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              callbacks?.onError(parsed.error);
              return;
            }
            if (parsed.matchFact && callbacks?.onData) {
              callbacks.onData(parsed.matchFact);
              isGrounded = true;
            }
            if (parsed.text && callbacks?.onChunk) {
              callbacks.onChunk(parsed.text);
            }
            if (parsed.grounded !== undefined) {
              isGrounded = parsed.grounded;
            }
          } catch {
            // skip malformed
          }
        }
      }

      clearTimeout(timeoutId);
      callbacks?.onComplete(isGrounded);
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        callbacks?.onError('请求已取消');
      } else {
        callbacks?.onError(error.message || 'Unknown error');
      }
    }
  })();

  return controller;
};