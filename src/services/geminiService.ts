import { Hero, Language } from '../types';
import type { MatchFact, ReviewParseStatus, ThreeConclusions } from '../types/matchReview';
import type { ReviewCardsPayload } from '../types/reviewCards';
import { incompleteReviewStreamMessage, isReviewSseTerminal } from '../utils/reviewSse';
import { parseReviewParseStatus } from '../utils/parseStatus';
import { serverErrorMessage } from '../utils/serverErrorMessage';
import { retryAfterFrom } from '../utils/retryAfter';

function cancelledMessage(lang: Language): string {
  return lang === 'zh' ? '请求已取消' : 'Request cancelled';
}

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
        throw new Error(serverErrorMessage(data, 'Failed to analyze draft'));
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
                callbacks.onError(serverErrorMessage(parsed, parsed.error));
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
        callbacks.onError(cancelledMessage(lang));
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
      throw new Error(serverErrorMessage(data, 'Failed to analyze draft'));
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
      throw new Error(serverErrorMessage(data, 'Failed to chat'));
    }

    return data.text || "...";
  } catch (error: any) {
    clearTimeout(timeoutId);
    console.error("Chat Request Error:", error);
    return lang === 'zh'
      ? `商店暂时关门了。（服务器错误：${error.message}）`
      : `The shop is closed. (Server Error: ${error.message})`;
  }
};

// ============ Meta Tier API ============
export const fetchTierList = async (
  lang: Language = 'en',
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
      throw new Error(serverErrorMessage(data, 'Failed to fetch tier list'));
    }
    
    return data;
  } catch (error: any) {
    console.error('Tier list fetch error:', error);
    return { heroes: [], count: 0, totalHeroes: 0, source: 'error', cacheAge: null, error: error.message };
  }
};

// ============ Pro/Public Matches API ============
export const fetchProMatches = async (
  lang: Language = 'en',
  limit: number = 10
): Promise<ProMatchesResponse> => {
  try {
    const params = new URLSearchParams({ lang, limit: limit.toString() });
    const response = await fetch(`/api/meta/pro-matches?${params}`);
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(serverErrorMessage(data, 'Failed to fetch pro matches'));
    }
    
    return data;
  } catch (error: any) {
    console.error('Pro matches fetch error:', error);
    return { matches: [], count: 0, source: 'error', cacheAge: null, error: error.message };
  }
};

export const fetchPublicMatches = async (
  lang: Language = 'en',
  limit: number = 10,
  heroId?: number
): Promise<PublicMatchesResponse> => {
  try {
    const params = new URLSearchParams({ lang, limit: limit.toString() });
    if (heroId) params.append('heroId', heroId.toString());
    
    const response = await fetch(`/api/meta/public-matches?${params}`);
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(serverErrorMessage(data, 'Failed to fetch public matches'));
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
        throw new Error(serverErrorMessage(data, 'Failed to fetch playbook'));
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
                callbacks?.onError(serverErrorMessage(parsed, parsed.error));
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
        callbacks?.onError(cancelledMessage(lang));
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
  /** OpenDota replay parse status (SSE facts event or JSON result). */
  onParseStatus?: (parse: ReviewParseStatus) => void;
  /** Fact-derived three conclusions riding alongside matchFact. */
  onThreeConclusions?: (conclusions: ThreeConclusions) => void;
  onReviewCards?: (cards: ReviewCardsPayload) => void;
  onReviewNotice?: (notice: string) => void;
  onChunk: (text: string) => void;
  onComplete: (grounded: boolean) => void;
  onError: (error: string) => void;
  /**
   * HTTP 429 rate limit (server PR #89): invoked INSTEAD of onError so the
   * UI can show a live countdown. Null retryAfterSec = server didn't say how
   * long. Legacy callers without this callback still get onError.
   */
  onRateLimited?: (retryAfterSec: number | null, message: string) => void;
  /**
   * HTTP 400 { error: 'message_too_long' } on a follow-up (server PR #89):
   * invoked INSTEAD of onError so the UI can show the server's localized
   * message inline and keep the user's text in the composer. Legacy callers
   * without this callback still get onError.
   */
  onMessageTooLong?: (message: string) => void;
}

export const REVIEW_CLIENT_TIMEOUT_MS = 180000;

export const fetchMatchReviewStream = (
  matchId: number | string,
  lang: Language,
  heroId?: number,
  followUp?: string,
  callbacks?: ReviewStreamCallbacks
): AbortController => {
  const controller = new AbortController();
  // Must exceed the server's review budget (REVIEW_REQUEST_BUDGET_MS = 170s:
  // OpenDota fetch + DeepSeek 40s + Gemini 40s + validation retry).
  const timeoutId = setTimeout(() => controller.abort(), REVIEW_CLIENT_TIMEOUT_MS);

  const cleanup = async (reader?: ReadableStreamDefaultReader<Uint8Array>) => {
    clearTimeout(timeoutId);
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        // ignore cancel errors
      }
    }
  };

  (async () => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      let response: Response;
      const reviewBody = {
        lang,
        ...(heroId ? { heroId } : {}),
        ...(followUp ? { followUp } : {}),
      };
      response = await fetch(`/api/review/${matchId}`, {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(reviewBody),
        signal: controller.signal,
      });

      if (response.status === 429) {
        // Rate limited before any streaming started: surface the wait via
        // onRateLimited (Retry-After header, falling back to the body's
        // retryAfterSec) instead of a generic stream error.
        const data = await response.json().catch(() => ({} as { retryAfterSec?: unknown }));
        const retryAfterSec = retryAfterFrom(
          response.headers?.get?.('retry-after'),
          data.retryAfterSec,
        );
        const message = serverErrorMessage(
          data,
          lang === 'zh' ? '请求太频繁，请稍后再试。' : 'Too many requests right now. Try again in a moment.',
        );
        clearTimeout(timeoutId);
        if (callbacks?.onRateLimited) callbacks.onRateLimited(retryAfterSec, message);
        else callbacks?.onError(message);
        return;
      }

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        // Oversized follow-up (server PR #89): 400 message_too_long with a
        // localized message — dedicated callback so the UI can keep the user's
        // text in the composer; other errors keep flowing through onError.
        if (response.status === 400 && data.error === 'message_too_long') {
          const message = serverErrorMessage(data, 'Failed to fetch match review');
          clearTimeout(timeoutId);
          if (callbacks?.onMessageTooLong) callbacks.onMessageTooLong(message);
          else callbacks?.onError(message);
          return;
        }
        throw new Error(serverErrorMessage(data, 'Failed to fetch match review'));
      }

      // JSON path: server answered with a single accumulated result instead of
      // SSE (non-stream Accept upstream, or an intermediary stripped the SSE
      // content type). Dispatch the same callbacks once.
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await response.json();
        if (data.error) {
          callbacks?.onError(serverErrorMessage(data, data.error));
          return;
        }
        const jsonParseStatus = parseReviewParseStatus(data.parse);
        if (jsonParseStatus) callbacks?.onParseStatus?.(jsonParseStatus);
        if (data.matchFact) callbacks?.onData(data.matchFact);
        if (data.threeConclusions) callbacks?.onThreeConclusions?.(data.threeConclusions);
        if (data.reviewCards) callbacks?.onReviewCards?.(data.reviewCards);
        if (data.reviewNotice) callbacks?.onReviewNotice?.(data.reviewNotice);
        if (typeof data.text === 'string' && data.text) callbacks?.onChunk(data.text);
        clearTimeout(timeoutId);
        callbacks?.onComplete(data.grounded ?? Boolean(data.matchFact));
        return;
      }

      reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let isGrounded = false;
      let sawDone = false;

      const processLine = (line: string): 'complete' | 'error' | 'continue' => {
        if (!line.startsWith('data: ')) return 'continue';
        const data = line.slice(6).trim();
        if (isReviewSseTerminal(data)) {
          sawDone = true;
          return 'complete';
        }
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            callbacks?.onError(serverErrorMessage(parsed, parsed.error));
            return 'error';
          }
          if (parsed.reviewNotice && callbacks?.onReviewNotice) {
            callbacks.onReviewNotice(parsed.reviewNotice);
          }
          const parseStatus = parseReviewParseStatus(parsed.parse);
          if (parseStatus && callbacks?.onParseStatus) {
            callbacks.onParseStatus(parseStatus);
          }
          if (parsed.matchFact && callbacks?.onData) {
            callbacks.onData(parsed.matchFact);
            isGrounded = parsed.grounded ?? true;
          }
          if (parsed.threeConclusions && callbacks?.onThreeConclusions) {
            callbacks.onThreeConclusions(parsed.threeConclusions);
          }
          if (parsed.reviewCards && callbacks?.onReviewCards) {
            callbacks.onReviewCards(parsed.reviewCards);
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
        return 'continue';
      };

      const drainLines = (lines: string[]): 'complete' | 'error' | 'continue' => {
        for (const line of lines) {
          const result = processLine(line);
          if (result !== 'continue') return result;
        }
        return 'continue';
      };

      while (true) {
        const { done, value } = await reader.read();
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          const result = drainLines(lines);
          if (result === 'complete') {
            await cleanup(reader);
            callbacks?.onComplete(isGrounded);
            return;
          }
          if (result === 'error') {
            await cleanup(reader);
            return;
          }
        }
        if (done) {
          buffer += decoder.decode();
          const tail = buffer.split('\n').filter((line) => line.length > 0);
          const result = drainLines(tail);
          if (result === 'complete') {
            await cleanup(reader);
            callbacks?.onComplete(isGrounded);
            return;
          }
          if (result === 'error') {
            await cleanup(reader);
            return;
          }
          break;
        }
      }

      await cleanup(reader);
      if (!sawDone) {
        callbacks?.onError(incompleteReviewStreamMessage(lang));
        return;
      }
      callbacks?.onComplete(isGrounded);
    } catch (error: any) {
      await cleanup(reader);
      if (error.name === 'AbortError') {
        callbacks?.onError(cancelledMessage(lang));
      } else {
        callbacks?.onError(error.message || 'Unknown error');
      }
    }
  })();

  return controller;
};