import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildCoachReport as buildRaw, isParsed, objectiveTeam, dataGaps } from '../../lib/coach/analyze.js';
import type { CoachReport } from '../coach/types';
import { THREAT_TAGS, ANSWERS, BUILT_IN_IMMUNITY, ALWAYS_KEY_ITEMS, heroTags } from '../../lib/coach/knowledge.js';
import { createCoachRouter, parseCoachQuery } from '../../lib/coach/router.js';

// express ships no types in this repo; load it the way other route tests do.
const express = createRequire(import.meta.url)('express');
const buildCoachReport = (m: object, o?: { overrides?: Record<number, number> }) => buildRaw(m, o) as unknown as CoachReport;
const names = JSON.parse(readFileSync(new URL('../../lib/coach/data/names.json', import.meta.url), 'utf8'));
const unparsed = () => JSON.parse(readFileSync(new URL('../fixtures/coach/match9091400302.unparsed.json', import.meta.url), 'utf8'));
const parsed = () => JSON.parse(readFileSync(new URL('../fixtures/coach/match9094562824.parsed.json', import.meta.url), 'utf8'));
const slotOf = (r: CoachReport, slug: string) => r.players.find((p) => p.hero.slug === slug)!.slot;
const ids = (r: CoachReport, slot: number) => r.reviews[slot].findings.map((f) => f.id);

describe('coach knowledge', () => {
  it('every curated hero slug and item key exists in the names snapshot', () => {
    const slugs = new Set(Object.values(names.heroes).map((h: any) => h.slug));
    for (const list of Object.values(THREAT_TAGS)) for (const s of list) expect(slugs.has(s), s).toBe(true);
    for (const s of BUILT_IN_IMMUNITY) expect(slugs.has(s), s).toBe(true);
    for (const group of Object.values(ANSWERS)) for (const list of Object.values(group)) for (const i of list) expect(names.items[i], i).toBeTruthy();
    for (const i of ALWAYS_KEY_ITEMS) expect(names.items[i], i).toBeTruthy();
  });

  it('OpenDota roles only fill in for heroes curation does not know', () => {
    expect([...heroTags('ursa', ['Carry', 'Durable', 'Disabler'])]).toEqual(['physical']);
    expect([...heroTags('brand_new_hero', ['Nuker', 'Disabler'])].sort()).toEqual(['disable', 'magic']);
  });
});

describe('buildCoachReport — unparsed match 9091400302', () => {
  const r = buildCoachReport(unparsed());

  it('reports match facts and admits what it cannot see', () => {
    expect(r.schema).toBe('dota2.ai/coach-report@1');
    expect(r.match).toMatchObject({ id: 9091400302, parsed: false, radiant_win: false, score: [34, 75], patch: '7.41' });
    expect(r.data_gaps.length).toBeGreaterThanOrEqual(5);
    expect(r.timeline).toBeNull();
    for (const rv of r.reviews) {
      expect(rv.deaths).toBeNull();
      expect(rv.item_timeline).toBeNull();
      expect(rv.findings.every((f) => f.tier === 'basic')).toBe(true);
    }
  });

  it('never guesses lane positions without lanes: core/support only', () => {
    for (const rv of r.reviews) {
      expect(rv.role.pos).toBeNull();
      expect(rv.role.source).toBe('farm');
    }
    const kinds = (radiant: boolean) => r.reviews.filter((rv) => r.players[rv.slot].radiant === radiant).map((rv) => rv.role.kind);
    for (const side of [true, false]) {
      expect(kinds(side).filter((k) => k === 'core')).toHaveLength(3);
      expect(kinds(side).filter((k) => k === 'support')).toHaveLength(2);
    }
  });

  it('Spectre: no answer to the magic burst, too many deaths, low farm', () => {
    const s = slotOf(r, 'spectre');
    expect(r.reviews[s].role.kind).toBe('core');
    expect(ids(r, s)).toEqual(expect.arrayContaining(['items.answer_missing', 'deaths.high', 'farm.low']));
    const item = r.reviews[s].findings.find((f) => f.id === 'items.answer_missing')!;
    expect(item.body.en).toContain('Skywrath Mage');
    expect(item.body.zh).toContain('黑皇杖');
    expect(item.caveat).toBeTruthy();
  });

  it('the 28/5 Ursa gets no invented item criticism', () => {
    const u = slotOf(r, 'ursa');
    expect(r.reviews[u].won).toBe(true);
    expect(ids(r, u)).not.toContain('items.answer_missing');
    expect(ids(r, u)).toContain('farm.strong');
  });

  it('every fix carries a question, bilingual text and evidence', () => {
    for (const rv of r.reviews) for (const f of rv.findings) {
      expect(f.title.en && f.title.zh && f.body.en && f.body.zh && f.ask.en && f.ask.zh).toBeTruthy();
      expect(f.evidence.length).toBeGreaterThan(0);
    }
  });

  it('honours a user position override', () => {
    const s = slotOf(r, 'spectre');
    const o = buildCoachReport(unparsed(), { overrides: { [s]: 1 } });
    expect(o.reviews[s].role).toMatchObject({ pos: 1, kind: 'core', source: 'user' });
  });
});

describe('buildCoachReport — parsed match 9094562824', () => {
  const m = parsed();
  const r = buildCoachReport(m);

  it('detects the parse and assigns positions 1–5 from lanes', () => {
    expect(isParsed(m)).toBe(true);
    expect(r.match.parsed).toBe(true);
    expect(r.data_gaps).toEqual([]);
    for (const side of [true, false]) {
      const pos = r.reviews.filter((rv) => r.players[rv.slot].radiant === side).map((rv) => rv.role.pos).sort();
      expect(pos).toEqual([1, 2, 3, 4, 5]);
    }
  });

  it('Timbersaw lost the lane to Outworld Destroyer', () => {
    const s = slotOf(r, 'shredder');
    const lane = r.reviews[s].findings.find((f) => f.id === 'laning.lost')!;
    expect(lane).toBeTruthy();
    expect(r.players[r.reviews[s].opponent!].hero.slug).toBe('obsidian_destroyer');
  });

  it('classifies deaths and finds the turning point', () => {
    const s = slotOf(r, 'techies');
    const rv = r.reviews[s];
    expect(rv.deaths!.length).toBe(r.players[s].kda[1]);
    expect(rv.deaths!.every((d) => typeof d.in_fight === 'boolean')).toBe(true);
    const tp = rv.findings.find((f) => f.id === 'team.turning_point')!;
    expect(tp.window![1] - tp.window![0]).toBe(180);
    expect(r.timeline!.radiant_gold_adv.length).toBeGreaterThan(10);
  });

  it('objectiveTeam reads building owner, Roshan team and Aegis slot', () => {
    expect(objectiveTeam({ type: 'building_kill', key: 'npc_dota_goodguys_tower1_bot' })).toBe('dire');
    expect(objectiveTeam({ type: 'building_kill', key: 'npc_dota_badguys_tower2_mid' })).toBe('radiant');
    expect(objectiveTeam({ type: 'CHAT_MESSAGE_ROSHAN_KILL', team: 3 })).toBe('dire');
    expect(objectiveTeam({ type: 'CHAT_MESSAGE_AEGIS', player_slot: 2 })).toBe('radiant');
    expect(objectiveTeam({ type: 'CHAT_MESSAGE_FIRSTBLOOD' })).toBeNull();
  });
});

describe('buildCoachReport — Codex P2 regressions (#139)', () => {
  const legacy = () => JSON.parse(readFileSync(new URL('../fixtures/match9035042364.parsed.json', import.meta.url), 'utf8'));

  it('turning point uses reconstructed deaths, never a fabricated zero', () => {
    const r = buildCoachReport(legacy());
    for (const rv of r.reviews) {
      const tp = rv.findings.find((f) => f.id === 'team.turning_point');
      if (!tp || !rv.deaths) continue;
      const [a, b] = tp.window!;
      const n = rv.deaths.filter((d) => d.time >= a - 30 && d.time <= b).length;
      expect(tp.body.en).toContain(`You died ${n} time`);
    }
    const noDeaths = legacy();
    for (const p of noDeaths.players) { delete p.kills_log; delete p.deaths_log; }
    const r2 = buildCoachReport(noDeaths);
    for (const rv of r2.reviews) {
      const tp = rv.findings.find((f) => f.id === 'team.turning_point');
      if (tp) expect(tp.body.en).not.toContain('You died');
    }
  });

  it('labels the lane metric as gold earned when net worth series is missing', () => {
    const m = legacy();
    const hasNw = m.players.every((p: any) => Array.isArray(p.networth_t));
    const r = buildCoachReport(m);
    const lane = r.reviews.flatMap((rv) => rv.findings).filter((f) => f.area === 'laning');
    for (const f of lane) {
      expect(f.evidence[0].k.en).toBe(hasNw ? 'Net worth at 10:00' : 'Gold earned at 10:00');
      if (!hasNw) expect(f.body.en).toContain('gold earned');
    }
  });

  it('reports gaps per field, so a partial parse keeps honest gaps', () => {
    const m = unparsed();
    for (const p of m.players) p.kills_log = [];
    m.players[0].kills_log = [{ time: 100, key: 'npc_dota_hero_ursa' }];
    const gaps = dataGaps(m).map((g: any) => g.en);
    expect(gaps).not.toContain('When and to whom you died');
    expect(gaps).toContain('Laning (last hits, gold at 10:00)');
    expect(dataGaps(parsed())).toEqual([]);
  });
});

describe('buildCoachReport — input guard', () => {
  it('rejects a payload without a 10-player roster', () => {
    expect(() => buildCoachReport({ players: [] })).toThrow(/roster/);
  });
});

describe('GET /api/coach/:matchId', () => {
  let server: Server | null = null;
  afterEach(() => { server?.close(); server = null; });

  async function start(getMatchDetail: (id: number) => Promise<object>, limit = 100) {
    const app = express();
    let hits = 0;
    app.use(createCoachRouter({
      getMatchDetail,
      resolveClientIp: () => '1.2.3.4',
      mapError: (e: any) => ({ status: e?.status === 404 ? 404 : 502, body: { error: 'x' } }),
      limiter: { tryConsume: () => (++hits > limit ? { ok: false, retryAfterSec: 9 } : { ok: true, retryAfterSec: 0 }) },
    }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server!.once('listening', r));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  it('validates the id and override before touching upstream', () => {
    expect(parseCoachQuery({ matchId: 'abc' }, {})).toEqual({ error: 'invalid_match_id' });
    expect(parseCoachQuery({ matchId: '0' }, {})).toEqual({ error: 'invalid_match_id' });
    expect(parseCoachQuery({ matchId: '9091400302' }, { slot: '3', pos: '9' })).toEqual({ error: 'invalid_override' });
    expect(parseCoachQuery({ matchId: '9091400302' }, { slot: '3', pos: '2' })).toMatchObject({ matchId: 9091400302, overrides: { 3: 2 } });
  });

  it('serves the report, maps 404s and rate limits', async () => {
    const base = await start(async (id) => {
      if (id === 1) throw Object.assign(new Error('nope'), { status: 404 });
      return unparsed();
    }, 3);
    const ok = await fetch(`${base}/api/coach/9091400302`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect((await ok.json()).match.id).toBe(9091400302);
    expect((await fetch(`${base}/api/coach/1`)).status).toBe(404);
    expect((await fetch(`${base}/api/coach/abc`)).status).toBe(400);
    expect((await fetch(`${base}/api/coach/9091400302`)).status).toBe(200);
    const limited = await fetch(`${base}/api/coach/9091400302`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('9');
  });

  it('answers 422 when OpenDota has no roster yet', async () => {
    const base = await start(async () => ({ match_id: 5, players: [] }));
    expect((await fetch(`${base}/api/coach/5`)).status).toBe(422);
  });
});
