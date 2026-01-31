import { GoogleGenAI, HarmCategory, HarmBlockThreshold } from "@google/genai";
import { DRAFT_SYSTEM_INSTRUCTION, LORE_SYSTEM_INSTRUCTION } from '../constants';
import { Hero } from '../types';

// Initialize Gemini Client
// NOTE: In a real production app, you should proxy these requests through a backend (like Cloud Functions)
// to protect your API_KEY. For this demo, we use the env var directly.
const apiKey = process.env.API_KEY || ''; 
const ai = new GoogleGenAI({ apiKey });

const safetySettings = [
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
  },
];

export const analyzeDraft = async (radiant: Hero[], dire: Hero[]): Promise<string> => {
  if (!apiKey) return "Error: API_KEY is missing. Please set it in your environment.";

  const radiantNames = radiant.map(h => h.name).join(', ');
  const direNames = dire.map(h => h.name).join(', ');

  const prompt = `
    Analyze this DOTA 2 Matchup:
    **Radiant:** ${radiantNames || 'None'}
    **Dire:** ${direNames || 'None'}
    
    If teams are incomplete, provide general advice for the heroes present.
  `;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: {
        systemInstruction: DRAFT_SYSTEM_INSTRUCTION,
        temperature: 0.7,
        // Removed maxOutputTokens to rely on dynamic budgets or defaults
        safetySettings,
      },
    });
    
    return response.text || "Failed to generate analysis.";
  } catch (error: any) {
    console.error("Gemini Analysis Error:", error);
    // Return the actual error message to the UI
    return `The Ancient is under attack! (API Error: ${error.message || error.toString()})`;
  }
};

export const chatWithShopkeeper = async (history: {role: string, parts: {text: string}[]}[], message: string): Promise<string> => {
  if (!apiKey) return "Error: API_KEY is missing.";

  try {
    const chat = ai.chats.create({
      model: 'gemini-3-flash-preview',
      config: {
        systemInstruction: LORE_SYSTEM_INSTRUCTION,
        temperature: 0.8,
      },
      history: history.map(h => ({
        role: h.role,
        parts: h.parts
      }))
    });

    const result = await chat.sendMessage({ message });
    return result.text || "...";
  } catch (error: any) {
    console.error("Gemini Chat Error:", error);
    return `The shop is closed. (API Error: ${error.message || error.toString()})`;
  }
};