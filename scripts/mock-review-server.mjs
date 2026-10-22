/**
 * Local fixture preview server (QA / screenshots — zero outbound requests).
 *
 *   npm run build && npm run preview:mock        # http://localhost:4180
 *
 * Serves ./dist and the real /api/v1 router using raw OpenDota fixtures for
 * 9035042364 and 8985182860. No outbound fetches or LLM completion.
 * Try /new/m/9035042364?hero=pudge to force the v2 UI.
 * Legacy /api/review GET/POST fixtures and feedback/event acknowledgements
 * remain available. Other match IDs return MATCH_NOT_FOUND.
 */

import express from 'express';
import { createV1Router } from '../routes/v1/index.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const FIXTURES = path.join(ROOT, 'src', 'v2', '__fixtures__');
const PORT = Number(process.env.PORT || 4180);
const HOST = process.env.HOST || '0.0.0.0';
const MATCH_ID = '9035042364';
const FIXTURE_HERO_ID = 14; // Pudge — the only hero the fixtures cover

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadFixture(lang, heroId) {
  const suffix = heroId != null ? `-pudge-${lang}` : `-${lang}`;
  const file = path.join(FIXTURES, `review-${MATCH_ID}${suffix}.json`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

const rawMatches = new Map([
  [9035042364, JSON.parse(readFileSync(path.join(ROOT, 'src/fixtures/match9035042364.parsed.json'), 'utf8'))],
  [8985182860, JSON.parse(readFileSync(path.join(ROOT, 'src/fixtures/match8985182860.json'), 'utf8'))],
]);
app.use(createV1Router({
  fetchMatch: async (id) => {
    const match = rawMatches.get(Number(id));
    if (!match) throw Object.assign(new Error('Match not found'), { code: 'MATCH_NOT_FOUND' });
    return structuredClone(match);
  },
  phrasingCompletion: undefined,
}));


app.get('/api/health', (_req, res) => {
  res.json({ ok: true, mock: true });
});

// Must be registered before /api/review/:id.
app.get('/api/review/suggestions', (_req, res) => {
  res.json({ recent: [], highMmr: [], count: 0, source: 'mock' });
});

// Any heroId other than the fixture's Pudge must 404 — serving the Pudge
// payload for another hero would let QA "validate" fabricated results.
const rejectUnknownHero = (heroId, res) => {
  if (heroId != null && heroId !== FIXTURE_HERO_ID) {
    res.status(404).json({ error: 'Fixture only covers Pudge (heroId 14)' });
    return true;
  }
  return false;
};

app.get('/api/review/:id', (req, res) => {
  if (req.params.id !== MATCH_ID) {
    return res.status(404).json({ error: 'Match not found' });
  }
  const lang = req.query.lang === 'zh' ? 'zh' : 'en';
  const heroId = req.query.heroId != null && req.query.heroId !== '' ? Number(req.query.heroId) : null;
  if (rejectUnknownHero(heroId, res)) return;
  res.json(loadFixture(lang, heroId));
});

app.post('/api/review/:id', async (req, res) => {
  if (req.params.id !== MATCH_ID) {
    return res.status(404).json({ error: 'Match not found' });
  }
  const lang = req.body?.lang === 'zh' ? 'zh' : 'en';
  const heroId = typeof req.body?.heroId === 'number' ? req.body.heroId : null;
  if (rejectUnknownHero(heroId, res)) return;
  const fixture = loadFixture(lang, heroId);

  // Deterministic answer quoting only fixture strings (turning-point evidence).
  const evidence = (fixture.threeConclusions?.turningPoint?.evidence) || [];
  const quoted = evidence.slice(0, 3).map((e) => [e.time, e.text].filter(Boolean).join(' · '));
  const answer =
    (lang === 'zh' ? '根据本局数据：' : 'From this match’s data: ')
    + (quoted.length ? quoted.join('. ') + '.' : fixture.threeConclusions?.turningPoint?.summary || '');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // res (not req) 'close': on Node ≥18 the request stream closes as soon as
  // the JSON body is consumed — req.on('close') would abort after one chunk.
  let closed = false;
  res.on('close', () => {
    closed = true;
  });
  for (const word of answer.split(/(\s+)/)) {
    if (closed) return;
    res.write(`data: ${JSON.stringify({ text: word })}\n\n`);
    await delay(word.trim() ? 24 : 10);
  }
  if (!closed) {
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

app.post('/api/events', (_req, res) => {
  res.status(202).json({ ok: true });
});

app.post('/api/feedback', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.use(express.static(DIST));

app.get('*', (req, res) => {
  // Mirror the production SPA rule: /new and /legacy are unlisted surfaces.
  const p = req.path.toLowerCase();
  if (p === '/new' || p.startsWith('/new/') || p === '/legacy' || p.startsWith('/legacy/')) {
    res.set('X-Robots-Tag', 'noindex');
  }
  res.sendFile(path.join(DIST, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`mock review server: http://localhost:${PORT} (fixtures for match ${MATCH_ID}, no outbound requests)`);
});
