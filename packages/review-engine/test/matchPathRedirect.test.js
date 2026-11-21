import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { matchPathRedirect, retiredPathRedirect } from '../../../lib/matchPathRedirect.js';

// Mirrors how server.js mounts the handler: the route first, a stand-in for
// the SPA catch-all after it, so fall-through behavior is covered too.
const servers = [];
async function setup() {
  const app = express();
  app.use(retiredPathRedirect);
  app.get('/match/:id', matchPathRedirect);
  app.get('*', (req, res) => res.status(200).send('spa'));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise(resolve => { s.closeAllConnections(); s.close(resolve); }))); });

describe('match path redirect (/match/:id → /r/:id)', () => {
  it('301s a numeric match id to the review page, keeping only ?lang', async () => {
    const base = await setup();
    const response = await fetch(`${base}/match/9035042364?lang=zh&ff=ui_v2`, { redirect: 'manual' });
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('/r/9035042364?lang=zh');
  });
  it('301s without a query and leaves non-ids to the SPA', async () => {
    const base = await setup();
    const plain = await fetch(`${base}/match/9035042364`, { redirect: 'manual' });
    expect(plain.status).toBe(301);
    expect(plain.headers.get('location')).toBe('/r/9035042364');
    for (const suffix of ['abc', '0', '-1', '1.2', '9035042364/timeline', '1099511627777']) {
      const response = await fetch(`${base}/match/${suffix}`, { redirect: 'manual' });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('spa');
    }
  });
});

describe('retired surfaces (/new, /m, /legacy) go home', () => {
  it('301s each prefix and anything under it to /, keeping only ?lang', async () => {
    const base = await setup();
    const cases = [
      ['/new', '/'], ['/new/', '/'], ['/new/m/9035042364?hero=pudge&lang=zh', '/?lang=zh'],
      ['/m', '/'], ['/m/9035042364?lang=en', '/?lang=en'], ['/M/9035042364', '/'],
      ['/legacy', '/'], ['/legacy/tools?lang=fr', '/'],
    ];
    for (const [from, to] of cases) {
      const response = await fetch(`${base}${from}`, { redirect: 'manual' });
      expect(response.status, from).toBe(301);
      expect(response.headers.get('location'), from).toBe(to);
    }
  });
  it('leaves pages and look-alike paths to the SPA', async () => {
    const base = await setup();
    for (const path of ['/', '/r/9035042364', '/p/86745912', '/newsletter', '/match', '/mine', '/legacyish']) {
      const response = await fetch(`${base}${path}`, { redirect: 'manual' });
      expect(response.status, path).toBe(200);
    }
  });
});
