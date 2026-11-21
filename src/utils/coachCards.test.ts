import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildCoachReport } from '../../lib/coach/analyze.js';
import { ACTIONS, AUTHORITIES, CATALOG_V2, COMPONENTS, buildSurface, validCard, validateSurface } from '../../lib/coach/cards.js';
import { createCoachRouter } from '../../lib/coach/router.js';

const express = createRequire(import.meta.url)('express');
const load = (f: string) => JSON.parse(readFileSync(new URL(`../fixtures/coach/${f}`, import.meta.url), 'utf8'));
const parsed = buildCoachReport(load('match9091400302.parsed.json')) as any;
const unparsed = buildCoachReport(load('match9091400302.unparsed.json')) as any;
// JS module: the surface is untyped here.
const surf = (r: any, slot: number): any => buildSurface(r, slot);

describe('dota-coach-ui/2 surface from the engine', () => {
  it('every seat of both fixtures: a valid surface, unique ids, header and headline first', () => {
    for (const r of [parsed, unparsed]) {
      for (let slot = 0; slot < 10; slot++) {
        const s = surf(r, slot);
        expect(s.catalog).toBe(CATALOG_V2);
        expect(validateSurface(s)).toEqual(s); // nothing the engine emits is dropped by its own validator
        expect(s.cards.slice(0, 2).map((c: any) => c.component)).toEqual(['MatchHeader', 'Headline']);
        expect(new Set(s.cards.map((c: any) => c.id)).size).toBe(s.cards.length);
        for (const c of s.cards) {
          expect(COMPONENTS).toContain(c.component);
          expect(AUTHORITIES).toContain(c.authority);
          for (const a of c.actions) expect(ACTIONS).toContain(a.action);
        }
        // One Finding card per finding, in the engine's order.
        expect(s.cards.filter((c: any) => c.component === 'Finding').map((c: any) => c.data.finding.id)).toEqual(r.reviews[slot].findings.map((f: any) => f.id));
      }
    }
  });

  it('actions only point at what exists: inspect → a chapter, save_goal → a goal, parse → unparsed only', () => {
    for (const r of [parsed, unparsed]) {
      const s = surf(r, 0);
      const ch = r.reviews[0].chapters ?? {};
      for (const c of s.cards) {
        for (const a of c.actions) {
          if (a.action === 'inspect') expect(ch[a.target]).toBeTruthy();
          if (a.action === 'save_goal') expect(c.data.finding.goal).toEqual(a.goal);
          if (a.action === 'parse') expect(r.match.parsed).toBe(false);
          if (a.action === 'open_cases') expect(r.match.parsed).toBe(true);
        }
      }
    }
    expect(surf(unparsed, 0).cards.find((c: any) => c.component === 'DataGaps').actions.map((a: any) => a.action)).toEqual(['parse']);
    expect(surf(parsed, 0).cards.some((c: any) => ['Lane', 'Deaths', 'Items', 'Fights', 'Story'].includes(c.component))).toBe(true);
    expect(surf(unparsed, 0).cards.some((c: any) => ['Lane', 'Deaths', 'Items', 'Fights', 'Story', 'GoldGraph'].includes(c.component))).toBe(false);
  });

  it('a draft-level statistic is labelled as one; match facts stay facts', () => {
    const s = surf(parsed, 0);
    expect(s.cards.find((c: any) => c.component === 'MatchHeader').authority).toBe('fact');
    const mu = s.cards.find((c: any) => c.component === 'Matchups');
    if (mu) expect(mu.authority).toBe('statistic');
    for (const c of s.cards.filter((x: any) => x.id.startsWith('finding:draft.'))) expect(c.authority).toBe('statistic');
  });

  it('null for a seat with no review', () => {
    expect(surf(parsed, 10)).toBeNull();
    expect(surf({} as any, 0)).toBeNull();
  });
});

describe('validator (any card source is untrusted)', () => {
  const ok = { id: 'x', component: 'Headline', title: { en: 'a', zh: 'b' }, authority: 'fact', tone: 'neutral', data: {}, actions: [], evidence: [] };

  it('rejects unknown components, authorities, tones, bad titles and non-object data', () => {
    expect(validCard(ok)).toEqual(ok);
    expect(validCard({ ...ok, component: 'RawHtml' })).toBeNull();
    expect(validCard({ ...ok, authority: 'vibes' })).toBeNull();
    expect(validCard({ ...ok, tone: 'loud' })).toBeNull();
    expect(validCard({ ...ok, title: 'plain string' })).toBeNull();
    expect(validCard({ ...ok, data: [1] })).toBeNull();
    expect(validCard({ ...ok, id: '' })).toBeNull();
  });

  it('drops unknown or malformed actions but keeps the card', () => {
    const label = { en: 'l', zh: 'l' };
    const c = validCard({ ...ok, actions: [
      { action: 'eval', label, code: 'alert(1)' },
      { action: 'inspect', label, target: 'settings' },
      { action: 'inspect', label, target: 'deaths', row: 2 },
      { action: 'ask', label, question: 'not bilingual' },
      { action: 'compare', label, hero: 29, vs: '70' },
      { action: 'save_goal', label, goal: { kind: 'deaths_per10_max', max: 2 } },
      { action: 'parse' },
    ] })!;
    expect(c.actions.map((a: any) => a.action)).toEqual(['inspect', 'save_goal']);
  });

  it('a wrong catalog is rejected whole; bad and duplicate cards are dropped in order', () => {
    expect(validateSurface({ catalog: 'dota-coach-ui/1', cards: [ok] })).toBeNull();
    const s = validateSurface({ catalog: CATALOG_V2, cards: [ok, { ...ok, component: 'Nope', id: 'y' }, { ...ok }, { ...ok, id: 'z' }] })!;
    expect(s.cards.map((c: any) => c.id)).toEqual(['x', 'z']);
  });
});

describe('GET /api/coach/:matchId/cards', () => {
  let server: Server | null = null;
  afterEach(async () => { await new Promise((r) => (server ? server.close(r) : r(null))); server = null; });
  async function start() {
    const app = express();
    app.use(createCoachRouter({
      getMatchDetail: async () => load('match9091400302.parsed.json'),
      resolveClientIp: () => '1.2.3.4',
      mapError: () => ({ status: 502, body: { error: 'x' } }),
      limiter: { tryConsume: () => ({ ok: true, retryAfterSec: 0 }) },
    }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server!.once('listening', r));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  it('returns the same surface the engine builds for that seat; 400 on a bad seat', async () => {
    const base = await start();
    const res = await fetch(`${base}/api/coach/9091400302/cards?seat=4`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(surf(parsed, 4))));
    expect((await fetch(`${base}/api/coach/9091400302/cards?seat=12`)).status).toBe(400);
    expect((await fetch(`${base}/api/coach/9091400302/cards`)).status).toBe(400);
    // The report route is unchanged.
    expect((await (await fetch(`${base}/api/coach/9091400302`)).json()).engine).toBe(parsed.engine);
  });
});
