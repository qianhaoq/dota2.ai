import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCoachReport } from '../../lib/coach/analyze.js';
import { createCoachRouter } from '../../lib/coach/router.js';
import { GENERIC, injectMeta, previewMeta, shareUrl } from '../../lib/coach/sharePreview.js';
import { validateAnalyticsEvent } from '../../lib/analyticsEvents.js';
import { shareLinks } from '../coach/CoachApp';

const express = createRequire(import.meta.url)('express');

const fixture = () => JSON.parse(readFileSync(path.join(process.cwd(), 'src/fixtures/coach/match9091400302.parsed.json'), 'utf8'));
// A real match carries names; a preview must never show them.
const withNames = () => {
  const m = fixture();
  m.players.forEach((p: Record<string, unknown>, i: number) => { p.personaname = `SecretName${i}`; p.account_id = 1000 + i; });
  return m;
};
const INDEX = `<!DOCTYPE html><html><head><meta charset="UTF-8" /><title>old</title><meta name="description" content="old" /><meta property="og:title" content="old" /></head><body><div id="root"></div></body></html>`;
const tag = (html: string, attr: string) => html.match(new RegExp(`<meta (?:name|property)="${attr}" content="([^"]*)"`))?.[1];

describe('share preview meta', () => {
  const report = buildCoachReport(withNames());

  it('previews one seat: hero, KDA, result and the biggest lever', () => {
    const p = report.players[4];
    const meta = previewMeta(report, { slot: 4, lang: 'zh', url: shareUrl(report.match.id, { slot: 4, lang: 'zh' }) });
    expect(meta.title).toContain(p.hero.zh);
    expect(meta.title).toContain(p.kda.join('/'));
    expect(meta.description.startsWith(report.reviews[4].headline.zh)).toBe(true);
    expect(meta.description).toContain('34–75');
    expect(meta.image).toBe(p.hero.img);
    expect(meta.url).toBe('https://dota2.ai/r/9091400302?p=4&lang=zh');
  });

  it('previews the whole match without a seat', () => {
    const meta = previewMeta(report, { lang: 'en', url: shareUrl(report.match.id) });
    expect(meta.title).toMatch(/^#9091400302 Dire victory 34–75/);
    expect(meta.description).toContain('Pick your hero');
    expect(meta.image).toBeNull();
  });

  it('never leaks player names or account ids', () => {
    for (const slot of [null, 0, 4, 9]) {
      const json = JSON.stringify(previewMeta(report, { slot, lang: 'en', url: 'u' }));
      expect(json).not.toMatch(/SecretName|"100\d"/);
    }
  });

  it('replaces the static tags once and escapes everything', () => {
    const html = injectMeta(INDEX, { title: 'A <b>"x"</b> & y', description: 'd"<', image: 'https://cdn/x.png?a=1&b=2', url: 'https://dota2.ai/r/1' });
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html).toContain('<title>A &lt;b&gt;&quot;x&quot;&lt;/b&gt; &amp; y</title>');
    expect(html.match(/name="description"/g)).toHaveLength(1);
    expect(html.match(/property="og:title"/g)).toHaveLength(1);
    expect(tag(html, 'og:image')).toBe('https://cdn/x.png?a=1&amp;b=2');
    expect(tag(html, 'twitter:card')).toBe('summary_large_image');
    expect(html).not.toContain('content="old"');
  });

  it('builds team and personal share links', () => {
    expect(shareLinks('https://dota2.ai', 9091400302, 4, 'zh')).toEqual({
      team: 'https://dota2.ai/r/9091400302?ref=team&lang=zh',
      self: 'https://dota2.ai/r/9091400302?p=4&ref=share&lang=zh',
    });
    expect(shareLinks('https://dota2.ai', 1, null, 'en').team).toBe('https://dota2.ai/r/1?ref=team');
    // A corrected role travels with the personal link (it changes the review), never with the team link.
    expect(shareLinks('https://dota2.ai', 9091400302, 4, 'en', 2)).toEqual({
      team: 'https://dota2.ai/r/9091400302?ref=team',
      self: 'https://dota2.ai/r/9091400302?p=4&pos=2&ref=share',
    });
  });

  it('accepts the share analytics events and nothing looser', () => {
    expect(validateAnalyticsEvent({ event: 'report_shared', props: { target: 'team', method: 'native', matchId: '9091400302' } }).ok).toBe(true);
    const v = validateAnalyticsEvent({ event: 'review_viewed', props: { matchId: '1', ui: 'coach', ref: 'team', extra: 'x' } });
    expect(v.ok && v.props).toEqual({ matchId: '1', ui: 'coach', ref: 'team' });
    const bad = validateAnalyticsEvent({ event: 'report_shared', props: { target: 'everyone' } });
    expect(bad.ok && bad.props).toEqual({});
  });
});

describe('GET /r/:matchId', () => {
  let server: Server | null = null;
  const logs: string[] = [];
  afterEach(() => { server?.close(); server = null; logs.length = 0; });
  async function start(opts: { match?: () => Promise<object>; html?: string | null; limited?: boolean; timeoutMs?: number } = {}) {
    const app = express();
    app.use(createCoachRouter({
      getMatchDetail: opts.match ?? (async () => withNames()),
      resolveClientIp: () => '1.2.3.4',
      mapError: () => ({ status: 502, body: { error: 'x' } }),
      log: (m: string) => logs.push(m),
      page: {
        html: () => (opts.html === undefined ? INDEX : opts.html),
        timeoutMs: opts.timeoutMs ?? 1000,
        limiter: { tryConsume: () => ({ ok: !opts.limited, retryAfterSec: 1 }) },
      },
    }));
    app.get('*', (_req: unknown, res: { send: (s: string) => void }) => res.send('spa-fallback'));
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server!.once('listening', r));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  it('serves the app with this match in the preview', async () => {
    const base = await start();
    const res = await fetch(`${base}/r/9091400302?p=4&lang=zh&ref=team`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    const html = await res.text();
    expect(html).toContain('<div id="root"></div>');
    expect(tag(html, 'og:title')).toContain('#9091400302');
    expect(tag(html, 'og:url')).toBe('https://dota2.ai/r/9091400302?p=4&amp;lang=zh');
    expect(html).not.toContain('SecretName');
    expect(logs).toContain('share-visit ref=team match=9091400302');
  });

  it('applies the shared role override to the preview, like the page does', async () => {
    const base = await start();
    const html = await (await fetch(`${base}/r/9091400302?p=4&pos=1`)).text();
    const forced = buildCoachReport(withNames(), { overrides: { 4: 1 } });
    expect(tag(html, 'og:url')).toBe('https://dota2.ai/r/9091400302?p=4&amp;pos=1');
    expect(tag(html, 'og:description')?.startsWith(forced.reviews[4].headline.en.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))).toBe(true);
  });

  it('falls back to the generic preview when the match is slow, missing or rate-limited', async () => {
    for (const opts of [
      { match: () => new Promise<object>((r) => setTimeout(() => r(withNames()), 500)), timeoutMs: 50 },
      { match: async () => { throw Object.assign(new Error('nope'), { status: 404 }); } },
      { limited: true },
    ]) {
      const base = await start(opts);
      const res = await fetch(`${base}/r/9091400302`);
      expect(res.status).toBe(200);
      expect(tag(await res.text(), 'og:title')).toBe(GENERIC.en.title);
      server?.close(); server = null;
    }
  });

  it('serves the generic preview for a bad id and defers to Vite in dev (no built index)', async () => {
    let base = await start();
    expect(tag(await (await fetch(`${base}/r/abc`)).text(), 'og:title')).toBe(GENERIC.en.title);
    server?.close(); server = null;
    base = await start({ html: null });
    expect(await (await fetch(`${base}/r/9091400302`)).text()).toBe('spa-fallback');
  });
});
