#!/usr/bin/env node
/**
 * The replay worker for the review agent: a private HTTP service that turns
 * a replay into a match trace and stores it where the site reads it.
 *
 *   POST /run   { "match_id": 9100904020, "replay_url": "http://replay413…/570/9100904020_….dem.bz2" }
 *               → { ok: true, bytes } | { ok: false, reason }
 *   GET  /health → ok
 *
 * It must never be public: host it behind IAM (Cloud Run
 * --no-allow-unauthenticated); the site calls it with an ID token. Even so,
 * the address it is given is checked: a Valve / Perfect World replay host,
 * for that match, fetched without following redirects and never from a
 * private address.
 *
 * Environment: DOTA_EXTRACT_BIN (the pinned extractor), and where traces go:
 * AGENT_BUCKET (a GCS bucket; objects under agent/) or AGENT_TRACE_DIR.
 * One parse at a time: the extractor's output lives in memory-backed /tmp.
 */
import { createServer } from 'node:http';
import { createGcsBucket } from '../lib/matchReview/replayIngest/gcs.js';
import { createBucketStore, createFileStore, createTraceStore } from '../lib/agent/stores.js';
import { createTracePipeline, replayUrlIsFor } from '../lib/agent/tracePipeline.js';

const bin = process.env.DOTA_EXTRACT_BIN;
const bucket = (process.env.AGENT_BUCKET || '').trim();
const dir = (process.env.AGENT_TRACE_DIR || '').trim();
const workerRole = (process.env.TRACE_WORKER_ROLE || '').trim() || (/-hk$/i.test(process.env.K_SERVICE || '') ? 'fallback' : 'primary');
if (!bin) throw new Error('DOTA_EXTRACT_BIN is required');
if (!bucket && !dir) throw new Error('AGENT_BUCKET or AGENT_TRACE_DIR is required');
const traces = createTraceStore(bucket ? createBucketStore(createGcsBucket(bucket), 'agent/') : createFileStore(dir));

let busy = false;
const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') { res.end('ok'); return; }
  if (req.method !== 'POST' || req.url !== '/run') { res.writeHead(404); res.end(); return; }
  let text = '';
  for await (const chunk of req) { text += chunk; if (text.length > 4096) { send(res, 413, { ok: false, reason: 'bad_request' }); return; } }
  let body;
  try { body = JSON.parse(text); } catch { send(res, 400, { ok: false, reason: 'bad_request' }); return; }
  const id = Number(body?.match_id);
  if (!Number.isSafeInteger(id) || id <= 0 || !replayUrlIsFor(body?.replay_url, id)) { send(res, 400, { ok: false, reason: 'bad_request' }); return; }
  if (busy) { send(res, 429, { ok: false, reason: 'busy' }); return; }
  busy = true;
  try {
    let metrics = null;
    const pipeline = createTracePipeline({
      getMatchDetail: async () => ({ match_id: id, replay_url: body.replay_url }),
      extractorBin: bin,
      store: traces,
      worker: workerRole,
      log: (m) => console.log(m),
      onMetrics: (m) => { metrics = m; },
    });
    const result = await pipeline.run(id);
    send(res, 200, metrics ? {
      ...result,
      ...(typeof metrics.detail === 'string' && metrics.detail ? { detail: metrics.detail } : {}),
      metrics: {
        downloading_ms: metrics.downloading_ms,
        extracting_ms: metrics.extracting_ms,
        building_ms: metrics.building_ms,
        storing_ms: metrics.storing_ms,
        demo_bytes: metrics.demo_bytes,
      },
    } : result);
  } catch {
    send(res, 500, { ok: false, reason: 'error' });
  } finally { busy = false; }
});
// A parse holds its request open (Cloud Run allocates CPU only during requests).
server.requestTimeout = 900_000;
server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0', () => console.log(`trace worker listening on ${server.address().port}`));
