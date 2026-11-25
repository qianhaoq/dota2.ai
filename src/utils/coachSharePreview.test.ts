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

  it('cuts a long verdict at a word, and keeps a short one whole', () => {
    const p = report.players[4];
    const long = `${'The fight at thirty minutes was started without the stun ready, '.repeat(4)}end.`;
    const d = previewMeta(report, { slot: p.slot, lang: 'en', url: 'u', verdict: long }).description;
    expect(d.startsWith('The fight at thirty minutes')).toBe(true);
    expect(d).toMatch(/^[^…]{100,180}… /);
    expect(d).not.toContain('end.');
    expect(previewMeta(report, { slot: p.slot, lang: 'zh', url: 'u', verdict: '短。' }).description.startsWith('短。 ')).toBe(true);
    // No seat, no verdict: the match preview.
    expect(previewMeta(report, { lang: 'en', url: 'u', verdict: 'x' }).description).not.toContain('x ');
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
  async function start(opts: { match?: () => Promise<object>; html?: string | null; limited?: boolean; timeoutMs?: number; review?: (...a: any[]) => Promise<any> } = {}) {
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
        ...(opts.review ? { review: opts.review } : {}),
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

  it('a review page link (?hero=) previews that player, led by the verdict of their stored review', async () => {
    const asked: unknown[][] = [];
    const base = await start({ review: async (...a: unknown[]) => { asked.push(a); return { verdict: 'Ravage <late> & "alone" — every fight started a step behind.' }; } });
    const p = buildCoachReport(withNames()).players[4];
    const html = await (await fetch(`${base}/r/9091400302?hero=${p.hero.slug}&plan=push&lang=zh&ref=share`)).text();
    expect(asked).toEqual([[9091400302, p.hero.slug, 'zh', 'push']]);
    expect(tag(html, 'og:title')).toContain(p.hero.zh);
    expect(tag(html, 'og:description')?.startsWith('Ravage &lt;late&gt; &amp; &quot;alone&quot; — every fight started a step behind.')).toBe(true);
    expect(tag(html, 'og:image')).toBe(p.hero.img);
    // The canonical link keeps what makes the review this one, and drops the tracking ref.
    expect(tag(html, 'og:url')).toBe(`https://dota2.ai/r/9091400302?hero=${p.hero.slug}&amp;plan=push&amp;lang=zh`);
    expect(html).not.toContain('SecretName');
  });

  it('a hero whose replay key is not its scoreboard slug (queen_of_pain / queenofpain) is still found, and its review read by the replay key', async () => {
    const asked: unknown[][] = [];
    const qop = () => { const m = withNames(); m.players[4].hero_id = 39; return m; };
    const base = await start({ match: async () => qop(), review: async (...a: unknown[]) => { asked.push(a); return { verdict: 'Blinked in before the stun.' }; } });
    const html = await (await fetch(`${base}/r/9091400302?hero=queen_of_pain`)).text();
    expect(asked).toEqual([[9091400302, 'queen_of_pain', 'en', null]]);
    expect(tag(html, 'og:title')).toContain('Queen of Pain');
    expect(tag(html, 'og:description')?.startsWith('Blinked in before the stun.')).toBe(true);
  });

  it('without a stored review (or with one that fails or is slow) the hero link still previews the player', async () => {
    const p = buildCoachReport(withNames()).players[4];
    const headline = buildCoachReport(withNames()).reviews.find((r: any) => r.slot === p.slot).headline.en;
    for (const review of [async () => null, async () => { throw new Error('gcs'); }, () => new Promise(() => {})]) {
      const base = await start({ review, timeoutMs: 300 });
      const html = await (await fetch(`${base}/r/9091400302?hero=${p.hero.slug}`)).text();
      expect(tag(html, 'og:title')).toContain(p.hero.en);
      expect(tag(html, 'og:description')?.startsWith(headline.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))).toBe(true);
      server?.close(); server = null;
    }
  });

  it('a hero not in this game, or not a hero key, previews the match and asks for no review', async () => {
    const asked: unknown[] = [];
    const base = await start({ review: async (...a: unknown[]) => { asked.push(a); return { verdict: 'x' }; } });
    const html = await (await fetch(`${base}/r/9091400302?hero=crystal_maiden_x`)).text();
    expect(tag(html, 'og:title')).toContain('match review');
    expect(tag(html, 'og:description')).not.toContain('x Radiant');
    await fetch(`${base}/r/9091400302?hero=${encodeURIComponent('../../etc')}`);
    expect(asked).toHaveLength(1);
  });

  it('QQ\'s card tags (itemprop) say what Open Graph says, and a link with no picture of its own gets the site card', async () => {
    const base = await start();
    const html = await (await fetch(`${base}/r/9091400302?lang=zh`)).text();
    const item = (k: string) => html.match(new RegExp(`<meta itemprop="${k}" content="([^"]*)"`))?.[1];
    expect(item('name')).toBe(tag(html, 'og:title'));
    expect(item('description')).toBe(tag(html, 'og:description'));
    expect(tag(html, 'og:image')).toBe('https://dota2.ai/og-card.png');
    expect(item('image')).toBe('https://dota2.ai/og-card.png');
    expect(tag(html, 'twitter:card')).toBe('summary_large_image');
    // A player's link keeps the hero's own art.
    const p = buildCoachReport(withNames()).players[4];
    const own = await (await fetch(`${base}/r/9091400302?hero=${p.hero.slug}`)).text();
    expect(own.match(/<meta itemprop="image" content="([^"]*)"/)?.[1]).toBe(p.hero.img);
    // The page's own static tags are replaced, never doubled.
    expect(html.match(/itemprop="name"/g)).toHaveLength(1);
  });

  it('the home page previews in the link\'s language, with the site card', async () => {
    const base = await start({ html: INDEX.replace('</head>', '<meta itemprop="name" content="old" /></head>') });
    const zh = await (await fetch(`${base}/?lang=zh`)).text();
    expect(tag(zh, 'og:title')).toBe(GENERIC.zh.title);
    expect(tag(zh, 'og:url')).toBe('https://dota2.ai/?lang=zh');
    expect(zh.match(/<meta itemprop="name" content="([^"]*)"/g)).toEqual([`<meta itemprop="name" content="${GENERIC.zh.title}"`]);
    expect(zh).toContain('<div id="root"></div>');
    const en = await (await fetch(`${base}/`)).text();
    expect(tag(en, 'og:title')).toBe(GENERIC.en.title);
    expect(tag(en, 'og:image')).toBe('https://dota2.ai/og-card.png');
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
    expect(await (await fetch(`${base}/?lang=zh`)).text()).toBe('spa-fallback');
  });
});
