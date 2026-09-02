import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, HarmCategory, HarmBlockThreshold } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

app.use(express.json());

const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
if (!apiKey) {
  console.warn("WARNING: GEMINI_API_KEY is not set in the server environment.");
}
const ai = new GoogleGenAI({ apiKey: apiKey || 'dummy' });

const GEMINI_MODEL = 'gemini-3.6-flash';

const DRAFT_SYSTEM_INSTRUCTION = `
You are a professional DOTA 2 analyst and coach (like Ceb or Notail).
Your task is to analyze two team compositions (Radiant vs Dire).
1. Predict the win probability.
2. Identify the win conditions for Radiant.
3. Suggest key items for the Radiant team to counter Dire.
4. Keep it concise, strategic, and use DOTA 2 terminology (e.g., "BKB", "power spike", "roshan control").
Format the output with Markdown headers.
`;

const LORE_SYSTEM_INSTRUCTION = `
You are the Shopkeeper from the Secret Shop in DOTA 2. 
You are mysterious, ancient, and knowledgeable about the lore of the Ancients.
Answer questions about hero backstories, item lore, and the history of the world.
Speak in a slightly archaic, mystical tone.
`;

const safetySettings = [
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
  },
];

app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0'
  });
});

app.get('/api/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    apiKeyConfigured: !!apiKey,
    model: GEMINI_MODEL
  });
});

app.post('/api/analyze', async (req, res) => {
  try {
    const { radiant, dire, lang, userContext } = req.body;
    
    if (!apiKey) {
      return res.status(500).json({ error: "Server API Key not configured" });
    }

    const radiantNames = radiant.map(h => h.name).join(', ');
    const direNames = dire.map(h => h.name).join(', ');
    
    const langInstruction = lang === 'zh' 
      ? '请使用中文(简体)进行回答。' 
      : 'Please answer in English.';

    const prompt = `
      Analyze this DOTA 2 Matchup:
      **Radiant:** ${radiantNames || 'None'}
      **Dire:** ${direNames || 'None'}
      
      **Additional Context/Strategy from User:** ${userContext || 'None'}

      If teams are incomplete, provide general advice for the heroes present.
      ${langInstruction}
    `;

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        systemInstruction: DRAFT_SYSTEM_INSTRUCTION,
        safetySettings,
      },
    });

    res.json({ text: response.text });
  } catch (error) {
    console.error("Gemini Analysis Error:", error);
    res.status(500).json({ error: error.message || "Internal Server Error" });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { history, message, lang } = req.body;

    if (!apiKey) {
      return res.status(500).json({ error: "Server API Key not configured" });
    }

    const langInstruction = lang === 'zh' 
      ? '请使用中文(简体)回答所有问题。' 
      : 'Please answer in English.';

    const chat = ai.chats.create({
      model: GEMINI_MODEL,
      config: {
        systemInstruction: `${LORE_SYSTEM_INSTRUCTION}\n${langInstruction}`,
      },
      history: history.map(h => ({
        role: h.role,
        parts: h.parts
      }))
    });

    const result = await chat.sendMessage({ message });
    res.json({ text: result.text });
  } catch (error) {
    console.error("Gemini Chat Error:", error);
    res.status(500).json({ error: error.message || "Internal Server Error" });
  }
});

app.use(express.static(path.join(__dirname, 'dist')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
  console.log(`Health check available at http://${HOST}:${PORT}/health`);
});
