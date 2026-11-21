import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { staticNotFound } from '../../../lib/staticNotFound.js';

// Mirrors server.js: express.static(dist), then staticNotFound, then the SPA catch-all.
const servers = [];
const dirs = [];
async function setup() {
  const dist = mkdtempSync(path.join(tmpdir(), 'static-404-'));
  dirs.push(dist);
  mkdirSync(path.join(dist, 'assets'));
  writeFileSync(path.join(dist, 'assets', 'index-abc123.js'), 'console.log(1);');
  writeFileSync(path.join(dist, 'index.html'), '<!DOCTYPE html><p>spa</p>');
  const app = express();
  app.use(express.static(dist));
  app.use(staticNotFound());
  app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
  app.post('/assets/upload', (req, res) => res.status(201).send('posted'));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => { s.closeAllConnections(); s.close(resolve); })));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('missing build files 404 instead of serving index.html', () => {
  it('serves an existing asset as-is', async () => {
    const base = await setup();
    const r = await fetch(`${base}/assets/index-abc123.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/javascript/);
  });

  it('404s a missing chunk under /assets/ and /home-scene/, uncached, never as HTML', async () => {
    const base = await setup();
    for (const p of ['/assets/index-OLDHASH.js', '/assets/index-OLDHASH.css', '/home-scene/gone.jpg']) {
      const r = await fetch(`${base}${p}`);
      expect(r.status, p).toBe(404);
      expect(r.headers.get('content-type'), p).toMatch(/^text\/plain/);
      expect(r.headers.get('cache-control'), p).toBe('no-store');
      expect(await r.text(), p).not.toContain('<!DOCTYPE');
    }
    const head = await fetch(`${base}/assets/index-OLDHASH.js`, { method: 'HEAD' });
    expect(head.status).toBe(404);
  });

  it('leaves app routes and non-GET requests to later handlers', async () => {
    const base = await setup();
    for (const p of ['/', '/r/9091400302', '/p/86745912', '/assetsx/thing']) {
      const r = await fetch(`${base}${p}`);
      expect(r.status, p).toBe(200);
      expect(await r.text(), p).toContain('spa');
    }
    const post = await fetch(`${base}/assets/upload`, { method: 'POST' });
    expect(post.status).toBe(201);
  });
});
