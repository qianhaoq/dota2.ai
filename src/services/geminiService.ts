import { Hero, Language } from '../types';

export interface AnalyzeStreamCallbacks {
  onChunk: (text: string) => void;
  onComplete: (grounded: boolean) => void;
  onError: (error: string) => void;
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
  score: string;
  winRate: string | null;
  reasons: Array<{
    type: string;
    enemy: string;
    advantage: string;
    winRate: string;
  }>;
}

export const fetchSuggestions = async (
  allies: Hero[], 
  enemies: Hero[], 
  side: 'radiant' | 'dire'
): Promise<HeroSuggestion[]> => {
  try {
    const response = await fetch('/api/suggestions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ allies, enemies, side, limit: 8 }),
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