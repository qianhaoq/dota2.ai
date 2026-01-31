import { Hero, Language } from '../types';

// NOTE: We now fetch from our own backend ('/api/...') to keep the API_KEY secret.
// The backend handles the actual communication with Google Gemini.

export const analyzeDraft = async (radiant: Hero[], dire: Hero[], lang: Language, userContext?: string): Promise<string> => {
  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ radiant, dire, lang, userContext }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to analyze draft');
    }

    return data.text || "Failed to generate analysis.";
  } catch (error: any) {
    console.error("Analysis Request Error:", error);
    return `The Ancient is under attack! (Server Error: ${error.message})`;
  }
};

export const chatWithShopkeeper = async (history: {role: string, parts: {text: string}[]}[], message: string, lang: Language): Promise<string> => {
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ history, message, lang }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to chat');
    }

    return data.text || "...";
  } catch (error: any) {
    console.error("Chat Request Error:", error);
    return `The shop is closed. (Server Error: ${error.message})`;
  }
};