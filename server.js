import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

app.use(express.json());

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.warn("WARNING: DEEPSEEK_API_KEY is not set in the server environment.");
}

const openai = apiKey ? new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: apiKey,
}) : null;

const DEEPSEEK_MODEL = 'deepseek-chat';

// ============ OpenDota Cache ============
const OPENDOTA_API = 'https://api.opendota.com/api';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const cache = {
  heroStats: { data: null, timestamp: 0 },
  matchups: new Map() // Map<heroId, { data, timestamp }>
};

async function fetchWithRetry(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
}

const MIN_GAMES_FOR_RELIABLE_WR = 20;
const MIN_MATCHUP_GAMES = 50;

async function getHeroStats() {
  const now = Date.now();
  if (cache.heroStats.data && (now - cache.heroStats.timestamp) < CACHE_TTL_MS) {
    return cache.heroStats.data;
  }
  try {
    const data = await fetchWithRetry(`${OPENDOTA_API}/heroStats`);
    const statsMap = {};
    for (const hero of data) {
      const proPick = hero.pro_pick || 0;
      const proWin = hero.pro_win || 0;
      const pubPick = hero['1_pick'] || 0;
      const pubWin = hero['1_win'] || 0;
      
      let winRate = null;
      let gamesPlayed = 0;
      if (proPick >= MIN_GAMES_FOR_RELIABLE_WR) {
        winRate = ((proWin / proPick) * 100).toFixed(1);
        gamesPlayed = proPick;
      } else if (pubPick >= MIN_GAMES_FOR_RELIABLE_WR) {
        winRate = ((pubWin / pubPick) * 100).toFixed(1);
        gamesPlayed = pubPick;
      }
      
      statsMap[hero.id] = {
        id: hero.id,
        name: hero.localized_name,
        internalName: hero.name,
        winRate,
        gamesPlayed,
        pickRate: proPick || pubPick,
        roles: hero.roles || []
      };
    }
    cache.heroStats = { data: statsMap, timestamp: now };
    return statsMap;
  } catch (err) {
    console.error('Failed to fetch heroStats:', err.message);
    return cache.heroStats.data || {};
  }
}

async function getHeroMatchups(heroId) {
  const now = Date.now();
  const cached = cache.matchups.get(heroId);
  if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
    return cached.data;
  }
  try {
    const data = await fetchWithRetry(`${OPENDOTA_API}/heroes/${heroId}/matchups`);
    const matchupMap = {};
    for (const m of data) {
      if (m.games_played > 0) {
        matchupMap[m.hero_id] = {
          heroId: m.hero_id,
          gamesPlayed: m.games_played,
          wins: m.wins,
          winRate: ((m.wins / m.games_played) * 100).toFixed(1),
          advantage: (((m.wins / m.games_played) - 0.5) * 100).toFixed(1)
        };
      }
    }
    cache.matchups.set(heroId, { data: matchupMap, timestamp: now });
    return matchupMap;
  } catch (err) {
    console.error(`Failed to fetch matchups for hero ${heroId}:`, err.message);
    return cached?.data || {};
  }
}

async function aggregateMatchupData(radiantIds, direIds, heroStats) {
  const allMatchups = {};
  const heroIdsToFetch = [...radiantIds, ...direIds];
  
  await Promise.all(heroIdsToFetch.map(async (id) => {
    allMatchups[id] = await getHeroMatchups(id);
  }));
  
  const analysis = {
    radiantAdvantages: [],
    direAdvantages: [],
    radiantCounters: [],
    direCounters: [],
    radiantSynergies: [],
    direSynergies: []
  };
  
  for (const radId of radiantIds) {
    const radName = heroStats[radId]?.name || `Hero#${radId}`;
    const radMatchups = allMatchups[radId] || {};
    
    for (const direId of direIds) {
      const direName = heroStats[direId]?.name || `Hero#${direId}`;
      const matchup = radMatchups[direId];
      
      if (matchup && matchup.gamesPlayed >= 50) {
        const adv = parseFloat(matchup.advantage);
        if (adv > 2) {
          analysis.radiantAdvantages.push({
            hero: radName,
            vsHero: direName,
            advantage: adv,
            winRate: matchup.winRate,
            games: matchup.gamesPlayed
          });
        } else if (adv < -2) {
          analysis.direAdvantages.push({
            hero: direName,
            vsHero: radName,
            advantage: -adv,
            winRate: (100 - parseFloat(matchup.winRate)).toFixed(1),
            games: matchup.gamesPlayed
          });
        }
      }
    }
  }
  
  analysis.radiantAdvantages.sort((a, b) => b.advantage - a.advantage);
  analysis.direAdvantages.sort((a, b) => b.advantage - a.advantage);
  
  return analysis;
}

function buildGroundedPrompt(radiant, dire, heroStats, matchupAnalysis, lang, userContext, isGrounded) {
  const isZh = lang === 'zh';
  
  const t = {
    radiant: isZh ? '天辉' : 'Radiant',
    dire: isZh ? '夜魇' : 'Dire',
    none: isZh ? '无' : 'None',
    winRate: isZh ? '胜率' : 'WR',
    games: isZh ? '场比赛' : 'games',
    advantage: isZh ? '优势' : 'advantage',
    vs: isZh ? '对' : 'vs',
    statsTitle: isZh ? '来自 OpenDota 的数据统计' : 'OpenDota Statistics',
    radiantHeroes: isZh ? '天辉英雄数据' : 'Radiant Heroes',
    direHeroes: isZh ? '夜魇英雄数据' : 'Dire Heroes',
    radiantAdvantages: isZh ? '天辉优势对位 (基于OpenDota历史数据)' : 'Radiant Favorable Matchups (OpenDota data)',
    direAdvantages: isZh ? '夜魇优势对位 (基于OpenDota历史数据)' : 'Dire Favorable Matchups (OpenDota data)',
    dataUnavailable: isZh ? '[注意: OpenDota 数据暂时不可用，以下分析未经数据验证]' : '[Note: OpenDota data unavailable, analysis unverified]',
    userContext: isZh ? '用户补充的战术背景' : 'User-provided tactical context',
    analysisPrompt: isZh 
      ? '请基于以上OpenDota真实数据进行分析' 
      : 'Analyze based on the OpenDota data above',
    instructions: isZh ? [
      '预测胜率时必须引用上述具体数据',
      '分析关键对位优劣势时引用具体的胜率数据',
      '给出天辉的取胜条件',
      '推荐针对性装备'
    ] : [
      'Cite specific data when predicting win probability',
      'Reference specific win rates when analyzing key matchups',
      'Identify Radiant win conditions',
      'Recommend counter items'
    ],
    incompleteNote: isZh ? '如果阵容不完整，请针对已选英雄给出建议。' : 'If draft is incomplete, provide suggestions for the selected heroes.',
    langInstruction: isZh ? '请使用中文(简体)进行回答。' : 'Please respond in English.'
  };

  const radiantNames = radiant.map(h => h.name).join(', ');
  const direNames = dire.map(h => h.name).join(', ');
  
  let statsSection = '';
  if (isGrounded) {
    const radiantStats = radiant.map(h => {
      const s = heroStats[h.id];
      return s ? `${s.name} (${t.winRate}: ${s.winRate || 'N/A'}%)` : h.name;
    }).join(', ');
    
    const direStats = dire.map(h => {
      const s = heroStats[h.id];
      return s ? `${s.name} (${t.winRate}: ${s.winRate || 'N/A'}%)` : h.name;
    }).join(', ');
    
    statsSection = `
## ${t.statsTitle}:

### ${t.radiantHeroes}:
${radiantStats}

### ${t.direHeroes}:
${direStats}
`;

    if (matchupAnalysis.radiantAdvantages.length > 0) {
      statsSection += `
### ${t.radiantAdvantages}:
${matchupAnalysis.radiantAdvantages.slice(0, 5).map(a => 
  `- ${a.hero} ${t.vs} ${a.vsHero}: +${a.advantage}% ${t.advantage} (${a.winRate}% ${t.winRate}, ${a.games} ${t.games})`
).join('\n')}
`;
    }
    
    if (matchupAnalysis.direAdvantages.length > 0) {
      statsSection += `
### ${t.direAdvantages}:
${matchupAnalysis.direAdvantages.slice(0, 5).map(a => 
  `- ${a.hero} ${t.vs} ${a.vsHero}: +${a.advantage}% ${t.advantage} (${a.winRate}% ${t.winRate}, ${a.games} ${t.games})`
).join('\n')}
`;
    }
  } else {
    statsSection = `\n${t.dataUnavailable}\n`;
  }

  return `
${isZh ? '分析这场 DOTA 2 对局' : 'Analyze this DOTA 2 match'}:

**${t.radiant}:** ${radiantNames || t.none}
**${t.dire}:** ${direNames || t.none}

${statsSection}

**${t.userContext}:** ${userContext || t.none}

${t.analysisPrompt}:
${t.instructions.map((instr, i) => `${i + 1}. ${instr}`).join('\n')}

${t.incompleteNote}
${t.langInstruction}
`;
}

function getDraftSystemInstruction(lang) {
  const isZh = lang === 'zh';
  
  const headers = isZh 
    ? `## 胜率预测
## 关键对位分析
## 天辉取胜条件
## 推荐装备`
    : `## Win Probability
## Key Matchup Analysis
## Radiant Win Conditions
## Recommended Items`;

  const langNote = isZh 
    ? '请使用中文(简体)回答。' 
    : 'Please respond in English.';

  return `You are a professional DOTA 2 analyst and coach (like Ceb or Notail).
Your task is to analyze two team compositions (Radiant vs Dire) using the OpenDota statistics provided.

IMPORTANT: You must cite the specific statistics from OpenDota data when making claims about win rates, matchups, and advantages. Do not invent statistics.

Format your analysis with clear Markdown headers:
${headers}

Keep it concise, strategic, and use DOTA 2 terminology (e.g., "BKB", "power spike", "roshan control").
${langNote}`;
}

const LORE_SYSTEM_INSTRUCTION = `
You are the Shopkeeper from the Secret Shop in DOTA 2. 
You are mysterious, ancient, and knowledgeable about the lore of the Ancients.
Answer questions about hero backstories, item lore, and the history of the world.
Speak in a slightly archaic, mystical tone.
`;

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
    model: DEEPSEEK_MODEL,
    provider: 'deepseek'
  });
});

app.post('/api/analyze', async (req, res) => {
  const acceptHeader = req.headers.accept || '';
  const wantsStream = acceptHeader.includes('text/event-stream');
  
  try {
    const { radiant = [], dire = [], lang = 'zh', userContext } = req.body;
    
    if (!apiKey || !openai) {
      if (wantsStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.write(`data: ${JSON.stringify({ error: "Server API Key not configured" })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      return res.status(500).json({ error: "Server API Key not configured" });
    }

    const radiantIds = radiant.map(h => h.id).filter(Boolean);
    const direIds = dire.map(h => h.id).filter(Boolean);
    
    let heroStats = {};
    let matchupAnalysis = { radiantAdvantages: [], direAdvantages: [] };
    let isGrounded = false;
    
    try {
      heroStats = await getHeroStats();
      if (Object.keys(heroStats).length > 0 && (radiantIds.length > 0 || direIds.length > 0)) {
        matchupAnalysis = await aggregateMatchupData(radiantIds, direIds, heroStats);
        isGrounded = true;
      }
    } catch (err) {
      console.error('OpenDota fetch error:', err.message);
    }
    
    const prompt = buildGroundedPrompt(radiant, dire, heroStats, matchupAnalysis, lang, userContext, isGrounded);

    const systemInstruction = getDraftSystemInstruction(lang);

    if (wantsStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const matchupSummary = {
        radiantAdvantages: matchupAnalysis.radiantAdvantages.slice(0, 5),
        direAdvantages: matchupAnalysis.direAdvantages.slice(0, 5),
        grounded: isGrounded
      };
      res.write(`data: ${JSON.stringify({ matchupData: matchupSummary, grounded: isGrounded })}\n\n`);

      const stream = await openai.chat.completions.create({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: prompt }
        ],
        stream: true,
      });

      req.on('close', () => {
        stream.controller?.abort();
      });

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content;
        if (content) {
          res.write(`data: ${JSON.stringify({ text: content, grounded: isGrounded })}\n\n`);
        }
      }
      
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      const response = await openai.chat.completions.create({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: prompt }
        ],
      });

      res.json({ 
        text: response.choices[0].message.content,
        grounded: isGrounded,
        matchupData: {
          radiantAdvantages: matchupAnalysis.radiantAdvantages.slice(0, 5),
          direAdvantages: matchupAnalysis.direAdvantages.slice(0, 5)
        }
      });
    }
  } catch (error) {
    console.error("DeepSeek Analysis Error:", error);
    if (wantsStream) {
      res.write(`data: ${JSON.stringify({ error: error.message || "Internal Server Error" })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.status(500).json({ error: error.message || "Internal Server Error" });
    }
  }
});

// Next hero suggestions based on OpenDota matchup data
app.post('/api/suggestions', async (req, res) => {
  try {
    const { allies = [], enemies = [], side = 'radiant', limit = 8, role } = req.body;
    
    const heroStats = await getHeroStats();
    if (!heroStats || Object.keys(heroStats).length === 0) {
      return res.json({ suggestions: [], error: 'OpenDota data unavailable' });
    }
    
    const alliedIds = new Set(allies.map(h => h.id));
    const enemyIds = enemies.map(h => h.id).filter(Boolean);
    const pickedIds = new Set([...allies.map(h => h.id), ...enemies.map(h => h.id)]);
    
    const enemyMatchups = {};
    await Promise.all(enemyIds.map(async (enemyId) => {
      enemyMatchups[enemyId] = await getHeroMatchups(enemyId);
    }));
    
    const heroScores = [];
    
    for (const heroId of Object.keys(heroStats)) {
      const hid = parseInt(heroId);
      if (pickedIds.has(hid)) continue;
      
      const hero = heroStats[hid];
      
      if (role && hero.roles && !hero.roles.includes(role)) {
        continue;
      }
      
      let score = 0;
      let reasons = [];
      let totalGames = 0;
      let matchupCount = 0;
      
      for (const enemyId of enemyIds) {
        const enemyMatchup = enemyMatchups[enemyId];
        if (enemyMatchup && enemyMatchup[hid]) {
          const m = enemyMatchup[hid];
          if (m.gamesPlayed >= MIN_MATCHUP_GAMES) {
            const counterAdvantage = 50 - parseFloat(m.winRate);
            const ourWinRate = (100 - parseFloat(m.winRate)).toFixed(1);
            score += counterAdvantage * Math.log10(m.gamesPlayed + 1);
            totalGames += m.gamesPlayed;
            matchupCount++;
            
            reasons.push({
              type: 'counter',
              enemy: heroStats[enemyId]?.name || `Hero#${enemyId}`,
              enemyId: parseInt(enemyId),
              advantage: counterAdvantage.toFixed(1),
              winRate: ourWinRate,
              gamesPlayed: m.gamesPlayed
            });
          }
        }
      }
      
      if (hero.winRate && hero.gamesPlayed >= MIN_GAMES_FOR_RELIABLE_WR) {
        score += (parseFloat(hero.winRate) - 50) * 0.5;
      }
      
      reasons.sort((a, b) => parseFloat(b.advantage) - parseFloat(a.advantage));
      
      const bestAdvantage = reasons.length > 0 ? parseFloat(reasons[0].advantage) : 0;
      if (enemyIds.length > 0 && matchupCount === 0) {
        continue;
      }
      
      heroScores.push({
        id: hid,
        name: hero.name,
        score: score,
        winRate: hero.winRate,
        roles: hero.roles,
        reasons: reasons.slice(0, 3),
        totalGames: totalGames,
        matchupCount: matchupCount,
        bestAdvantage: bestAdvantage
      });
    }
    
    heroScores.sort((a, b) => {
      if (b.bestAdvantage !== a.bestAdvantage) {
        return b.bestAdvantage - a.bestAdvantage;
      }
      return b.score - a.score;
    });
    
    const topHeroes = heroScores.filter(h => h.score > 0 || h.reasons.length > 0);
    const suggestions = topHeroes.slice(0, limit).map(h => ({
      id: h.id,
      name: h.name,
      score: h.score.toFixed(1),
      winRate: h.winRate,
      roles: h.roles,
      reasons: h.reasons,
      totalGames: h.totalGames,
      bestAdvantage: h.bestAdvantage.toFixed(1)
    }));
    
    res.json({ suggestions });
  } catch (error) {
    console.error("Suggestions Error:", error);
    res.json({ suggestions: [], error: error.message });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { history, message, lang } = req.body;

    if (!apiKey || !openai) {
      return res.status(500).json({ error: "Server API Key not configured" });
    }

    const langInstruction = lang === 'zh' 
      ? '请使用中文(简体)回答所有问题。' 
      : 'Please answer in English.';

    const systemContent = `${LORE_SYSTEM_INSTRUCTION}\n${langInstruction}`;

    const messages = [
      { role: 'system', content: systemContent },
      ...history.map(h => ({
        role: h.role,
        content: h.parts.map(p => p.text).join('')
      })),
      { role: 'user', content: message }
    ];

    const response = await openai.chat.completions.create({
      model: DEEPSEEK_MODEL,
      messages: messages,
    });

    res.json({ text: response.choices[0].message.content });
  } catch (error) {
    console.error("DeepSeek Chat Error:", error);
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
