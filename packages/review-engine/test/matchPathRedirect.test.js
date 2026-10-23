import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { matchPathRedirect } from '../../../lib/matchPathRedirect.js';

// Mirrors how server.js mounts the handler: the route first, a stand-in for
// the SPA catch-all after it, so fall-through behavior is covered too.
const servers = [];
async function setup() {
  const app = express();
  app.get('/match/:id', matchPathRedirect);
  app.get('*', (req, res) => res.status(200).send('spa'));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise(resolve => { s.closeAllConnections(); s.close(resolve); }))); });

describe('match path redirect (/match/:id → /m/:id)', () => {
  it('301s a numeric match id and preserves the query string verbatim', async () => {
    const base = await setup();
    const response = await fetch(`${base}/match/9035042364?lang=zh&ff=ui_v2`, { redirect: 'manual' });
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('/m/9035042364?lang=zh&ff=ui_v2');
  });
  it('301s without a query and leaves non-ids to the SPA', async () => {
    const base = await setup();
    const plain = await fetch(`${base}/match/9035042364`, { redirect: 'manual' });
    expect(plain.status).toBe(301);
    expect(plain.headers.get('location')).toBe('/m/9035042364');
    for (const suffix of ['abc', '0', '-1', '1.2', '9035042364/timeline', '1099511627777']) {
      const response = await fetch(`${base}/match/${suffix}`, { redirect: 'manual' });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('spa');
    }
  });
});
