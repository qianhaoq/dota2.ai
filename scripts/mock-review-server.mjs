/**
 * Local fixture preview server (QA / screenshots — zero outbound requests).
 *
 *   npm run build && npm run preview:mock        # http://localhost:4180
 *
 * Serves ./dist and the real /api/v1 router using raw OpenDota fixtures for
 * 9035042364 and 8985182860. No outbound fetches or LLM completion.
 * Event acknowledgements
 * remain available. Other match IDs return MATCH_NOT_FOUND.
 *
 * The coach (/r/9091400302, /api/coach/*) runs the real router and engine on
 * the parsed 9091400302 fixture; pro cases come from the recorded
 * Tidehunter-vs-Ursa profiles, and "ask" answers with the deterministic
 * fallback (no LLM).
 */

import express from 'express';
import { createV1Router } from '../routes/v1/index.js';
import { createCoachRouter } from '../lib/coach/router.js';
import { createCoachService } from '../lib/coach/service.js';
import { buildCaseStudies } from '../lib/coach/cases.js';
import { mapOpenDotaFetchError } from '../lib/matchReview/openDotaErrors.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticNotFound } from '../lib/staticNotFound.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const PORT = Number(process.env.PORT || 4180);
const HOST = process.env.HOST || '0.0.0.0';
const MATCH_ID = '9035042364';
 

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

const rawMatches = new Map([
  [9035042364, JSON.parse(readFileSync(path.join(ROOT, 'src/fixtures/match9035042364.parsed.json'), 'utf8'))],
  [8985182860, JSON.parse(readFileSync(path.join(ROOT, 'src/fixtures/match8985182860.json'), 'utf8'))],
]);

const coachMatches = new Map([
  [9091400302, JSON.parse(readFileSync(path.join(ROOT, 'src/fixtures/coach/match9091400302.parsed.json'), 'utf8'))],
]);
const caseProfiles = JSON.parse(readFileSync(path.join(ROOT, 'src/fixtures/coach/cases.tidehunter-vs-ursa.profiles.json'), 'utf8')).profiles;
const coachGetMatch = async (id) => {
  const match = coachMatches.get(Number(id));
  if (!match) throw Object.assign(new Error('HTTP 404'), { status: 404, upstream: 'opendota' });
  return structuredClone(match);
};
const coachCaseService = {
  get: async ({ report, slot, match }) => buildCaseStudies({ report, slot, match, candidates: caseProfiles }),
  peek: () => null,
};
// Local fixture server: no per-IP limit (e2e runs many page loads a minute).
const noLimit = { tryConsume: () => ({ ok: true, retryAfterSec: 0 }) };
const coachService = createCoachService({
  getMatchDetail: coachGetMatch,
  resolveClientIp: (req) => req.ip || 'local',
  mapError: mapOpenDotaFetchError,
  cases: coachCaseService,
  limiter: noLimit,
});
app.use(createCoachRouter({
  getMatchDetail: coachGetMatch,
  resolveClientIp: (req) => req.ip || 'local',
  mapError: mapOpenDotaFetchError,
  limiter: noLimit,
  cases: coachCaseService,
}));

app.use(createV1Router({
  fetchMatch: async (id) => {
    const match = rawMatches.get(Number(id));
    if (!match) throw Object.assign(new Error('Match not found'), { code: 'MATCH_NOT_FOUND' });
    return structuredClone(match);
  },
  phrasingCompletion: undefined,
  // Remote MCP coach tools in process over the coach fixtures, like production.
  coachForRequest: coachService.forRequest,
  // Optional synthetic snapshot for local learning-flow acceptance, never a production upload.
  knowledgeSnapshot: process.env.SITE_KNOWLEDGE_PREVIEW_FILE
    ? JSON.parse(readFileSync(process.env.SITE_KNOWLEDGE_PREVIEW_FILE, 'utf8'))
    : undefined,
}));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, mock: true });
});

app.post('/api/events', (_req, res) => {
  res.status(202).json({ ok: true });
});

app.use(express.static(DIST));
// A missing build file 404s instead of becoming index.html (lib/staticNotFound.js).
app.use(staticNotFound());

app.get('*', (req, res) => {
  res.sendFile(path.join(DIST, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`mock review server: http://localhost:${PORT} (fixtures for match ${MATCH_ID}, no outbound requests)`);
});
