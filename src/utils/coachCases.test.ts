import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildCoachReport } from '../../lib/coach/analyze.js';
import { buildCaseStudies, candidateProfile, keyEnemyOf, profileOf, similarHeroes, similarity, withDamageType } from '../../lib/coach/cases.js';
import { caseCandidatesSql, chooseCandidates, createCaseService, UNUSABLE_TTL_MS } from '../../lib/coach/caseSource.js';
import { createCoachRouter } from '../../lib/coach/router.js';
import { fallbackAnswer, reportContext } from '../../lib/coach/ask.js';

const express = createRequire(import.meta.url)('express');
const parsedReal = () => JSON.parse(readFileSync(new URL('../fixtures/coach/match9091400302.parsed.json', import.meta.url), 'utf8'));
const unparsed = () => JSON.parse(readFileSync(new URL('../fixtures/coach/match9091400302.unparsed.json', import.meta.url), 'utf8'));
// 26 professional Tidehunter-vs-Ursa games (OpenDota), profiled by the engine.
const proProfiles = () => JSON.parse(readFileSync(new URL('../fixtures/coach/cases.tidehunter-vs-ursa.profiles.json', import.meta.url), 'utf8')).profiles;

const TIDE = 29; const URSA = 70;

describe('case studies (pure)', () => {
  const match = parsedReal();
  const report = buildCoachReport(match);
  const out: any = buildCaseStudies({ report, slot: 0, match, candidates: proProfiles() });

  it('is about the enemy who killed the player most', () => {
    expect(keyEnemyOf(report, 0)).toBe(URSA);
    expect(out.key_enemy).toBe(URSA);
    expect(out.pool).toEqual({ total: 26, same_hero: 26 });
  });

  it('pairs each problem with a negative that repeats it and a positive that avoided it', () => {
    const keys = out.themes.map((t: any) => t.key);
    expect(keys).toEqual(['deaths', 'fights', 'laning']);
    const deaths = out.themes[0];
    expect(deaths.title.zh).toBe('你死于熊战士 8 次');
    const pool = new Map(proProfiles().map((p: any) => [p.match_id, p]));
    const neg: any = pool.get(deaths.negative.match_id);
    const pos: any = pool.get(deaths.positive.match_id);
    // The same deterministic criteria as the theme, checked on the raw profile.
    expect(neg.deaths_to[URSA]).toBeGreaterThanOrEqual(3);
    expect(neg.won).toBe(false);
    expect(pos.deaths_to[URSA] ?? 0).toBeLessThanOrEqual(1);
    expect(pos.won).toBe(true);
    expect(deaths.positive.won).toBe(true);
    expect(deaths.negative.won).toBe(false);
    // Metric table: the player's own value is always present.
    const row = deaths.metrics.find((m: any) => m.key === 'deaths_to');
    expect(row.mine.zh).toBe('8');
    expect(row.negative.zh).toBe(String(neg.deaths_to[URSA]));
  });

  it('spreads the cases over different games when it can', () => {
    const ids = out.themes.flatMap((t: any) => [t.negative?.match_id, t.positive?.match_id]).filter(Boolean);
    expect(new Set(ids).size).toBeGreaterThanOrEqual(4);
  });

  it('the analysis quotes real numbers from both sides and never a question', () => {
    for (const th of out.themes) {
      expect(th.analysis.length).toBeGreaterThan(0);
      for (const a of th.analysis) {
        expect(a.zh).not.toMatch(/undefined|NaN|\?|？/);
        expect(a.en).not.toMatch(/undefined|NaN|\?/);
      }
    }
    const deaths = out.themes[0];
    expect(deaths.analysis.some((a: any) => a.zh.includes('死于熊战士') && a.zh.includes('（你 8）'))).toBe(true);
  });

  it('a "copy one thing" tip only appears when the positive case actually did it earlier', () => {
    const fights = out.themes.find((t: any) => t.key === 'fights');
    // The positive Tidehunter bought Blink later than the threshold for a
    // tip, so no Blink advice is invented from it.
    expect(fights.analysis.some((a: any) => a.zh.includes('跳刀'))).toBe(false);
  });

  it('a player with no key enemy gets no cases, not invented ones', async () => {
    const r = buildCoachReport(match);
    const ch = (r.reviews[0] as any).chapters;
    ch.deaths.summary.top_killer = null;
    ch.items.damage.by_hero = [];
    expect(keyEnemyOf(r, 0)).toBeNull();
    let queried = false;
    const svc = createCaseService({ explorer: async () => { queried = true; return { rows: [] }; }, fetchMatch: async () => ({}) });
    const res = await svc.get({ report: r, slot: 0, match });
    expect(queried).toBe(false);
    expect(res.themes).toEqual([]);
  });

  it('similar heroes share attribute, attack type and most roles', () => {
    const sim = similarHeroes(TIDE);
    expect(sim.length).toBeGreaterThan(0);
    expect(sim).not.toContain(TIDE);
    const names = createRequire(import.meta.url)('../../lib/coach/data/names.json');
    for (const id of sim) {
      expect(names.heroes[id].attr).toBe('str');
      expect(names.heroes[id].attack).toBe('Melee');
    }
  });

  it('ranks the same hero above a similar one with the same lineup', () => {
    const me: any = { hero: TIDE, enemies: [URSA, 1], pos: 3, lead10: -2000 };
    const same: any = { hero: TIDE, enemies: [URSA], pos: 3, lead10: -100 };
    const other: any = { hero: 97, enemies: [URSA], pos: 3, lead10: -100 };
    expect(similarity(me, same)).toBeGreaterThan(similarity(me, other));
  });

  it('profiles any parsed match and refuses an unparsed one', () => {
    const p: any = candidateProfile(parsedReal(), 0);
    expect(p.hero).toBe(TIDE);
    expect(p.deaths_to[URSA]).toBe(8);
    expect(candidateProfile(unparsed(), 0)).toBeNull();
  });
});

describe('case studies — unknown is never zero (Codex #153)', () => {
  const pool = () => proProfiles();

  it('a hero without a tracked ultimate gets no ultimate theme and is never a fight case', () => {
    const match = parsedReal();
    const report = buildCoachReport(match);
    const pudge = 3;
    const me: any = profileOf(match, report, pudge);
    expect(me.fights.ult_in).toBeNull();
    expect(me.fights.ult_unused).toBeNull();
    const out: any = buildCaseStudies({ report, slot: pudge, match, candidates: pool() });
    expect(out.themes.map((t: any) => t.key)).not.toContain('fights');
    expect(JSON.stringify(out)).not.toMatch(/\bnull of\b|undefined/);
    // As a candidate: untracked usage cannot make a losing game a negative case.
    const tide = buildCoachReport(match);
    const fake = pool().map((p: any) => ({ ...p, fights: p.fights && { ...p.fights, ult_in: null, ult_unused: null } }));
    const r2: any = buildCaseStudies({ report: tide, slot: 0, match, candidates: fake });
    expect(r2.themes.map((t: any) => t.key)).not.toContain('fights');
  });

  it('defensive items come from the full purchase log (a Pavise counts)', () => {
    const match = parsedReal();
    const ss = 1; // Shadow Shaman, support
    match.players[ss].purchase_log = [...match.players[ss].purchase_log, { time: 700, key: 'pavise' }].sort((a: any, b: any) => a.time - b.time);
    const report = buildCoachReport(match);
    const p: any = withDamageType(profileOf(match, report, ss), 'physical');
    expect(p.first_answer).toMatchObject({ key: 'pavise', time: 700 });
    // No purchase log at all: unknown, not "no defensive item".
    const bare = parsedReal();
    delete bare.players[ss].purchase_log;
    const q: any = profileOf(bare, buildCoachReport(bare), ss);
    expect(q.defence).toBeNull();
    expect(q.has_items).toBe(false);
  });

  it('without a complete death log, deaths to the key enemy are unknown — not a positive case', () => {
    const match = parsedReal();
    for (const pl of match.players) { delete pl.deaths_log; delete pl.kills_log; }
    const report = buildCoachReport(match);
    const p: any = profileOf(match, report, 0);
    expect(p.deaths_to).toBeNull();
    expect(p.caught).toBeNull();
    const unknownPool = pool().map((c: any) => ({ ...c, deaths_to: null, caught: null, share_dead: null }));
    const full = parsedReal();
    const out: any = buildCaseStudies({ report: buildCoachReport(full), slot: 0, match: full, candidates: unknownPool });
    expect(out.themes.find((t: any) => t.key === 'deaths')).toBeUndefined();
  });

  it('zero scoreboard deaths is a known zero, so a deathless winner can be a positive case', () => {
    const m = parsedReal();
    // Make Ursa (winning side) deathless, with no death rows at all.
    const s = m.players.findIndex((p: any) => p.hero_id === 70);
    m.players[s].deaths = 0;
    delete m.players[s].deaths_log;
    for (const pl of m.players) if (pl.kills_log) pl.kills_log = pl.kills_log.filter((k: any) => !String(k.key).includes('ursa'));
    const p: any = profileOf(m, buildCoachReport(m), s);
    expect(p.deaths).toBe(0);
    expect(p.deaths_to).toEqual({});
    expect(p.caught).toBe(0);
  });

  it('the "caught outside fights" tip needs the positive case to actually be caught less', () => {
    const match = parsedReal();
    const report = buildCoachReport(match);
    const caughtALot = pool().map((c: any) => ({ ...c, caught: 6, defence: [] }));
    const out: any = buildCaseStudies({ report, slot: 0, match, candidates: caughtALot });
    const deaths = out.themes.find((t: any) => t.key === 'deaths');
    expect(deaths.positive).toBeTruthy();
    expect(deaths.analysis.some((a: any) => a.zh.includes('团战外被抓') && a.zh.includes('学一件事'))).toBe(false);
  });
});

describe('case source', () => {
  it('builds SQL from integers only', () => {
    const sql = caseCandidatesSql({ heroIds: [29, 7], enemyId: 70, excludeMatchId: 9091400302 });
    expect(sql).toContain('pm.hero_id IN (29,7)');
    expect(sql).toContain('e.hero_id = 70');
    expect(sql).toContain('m.match_id <> 9091400302');
    expect(() => caseCandidatesSql({ heroIds: ['29; DROP' as never], enemyId: 70, excludeMatchId: 1 })).toThrow();
  });

  it('takes the same hero first and fills with similar heroes only when short', () => {
    const rows = [
      { match_id: 1, hero_id: 29 }, { match_id: 1, hero_id: 29 }, { match_id: 2, hero_id: 29 },
      { match_id: 3, hero_id: 7 }, { match_id: 4, hero_id: 7 },
    ];
    expect(chooseCandidates(rows, 29, { maxFetch: 3, minSame: 2 }).map((r: any) => r.match_id)).toEqual([1, 2]);
    expect(chooseCandidates(rows, 29, { maxFetch: 3, minSame: 5 }).map((r: any) => r.match_id)).toEqual([1, 2, 3]);
  });

  function fakeUpstream() {
    const calls = { explorer: 0, fetch: 0 };
    const base = parsedReal();
    const svc = createCaseService({
      explorer: async () => { calls.explorer += 1; return { rows: [{ match_id: 11, hero_id: 29, player_slot: 0 }, { match_id: 12, hero_id: 29, player_slot: 0 }] }; },
      fetchMatch: async (id: number) => { calls.fetch += 1; return { ...parsedReal(), match_id: id }; },
    });
    return { calls, svc, base };
  }

  it('fetches once, then serves profiles and results from cache', async () => {
    const { calls, svc, base } = fakeUpstream();
    const report = buildCoachReport(base);
    expect(svc.peek({ report, slot: 0 })).toBeNull();
    const [a, b] = await Promise.all([svc.get({ report, slot: 0, match: base }), svc.get({ report, slot: 0, match: base })]);
    expect(a).toBe(b); // concurrent requests share one job
    expect(a.pool.total).toBe(2);
    expect(calls).toEqual({ explorer: 1, fetch: 2 });
    await svc.get({ report, slot: 0, match: base });
    expect(calls).toEqual({ explorer: 1, fetch: 2 });
    expect(svc.peek({ report, slot: 0 })).toBe(a);
  });

  it('a pro game that was not parsed yet is retried later, not cached as unusable forever', async () => {
    let clock = 0;
    let parsedNow = false;
    let fetches = 0;
    const svc = createCaseService({
      now: () => clock,
      resultTtlMs: 1000,
      explorer: async () => ({ rows: [{ match_id: 11, hero_id: 29, player_slot: 0 }] }),
      fetchMatch: async () => { fetches += 1; return parsedNow ? { ...parsedReal(), match_id: 11 } : { ...unparsed(), match_id: 11 }; },
    });
    const base = parsedReal();
    const report = buildCoachReport(base);
    expect((await svc.get({ report, slot: 0, match: base })).pool.total).toBe(0);
    parsedNow = true;
    clock += 2000; // results expired, unusable entry still fresh: no refetch
    expect((await svc.get({ report, slot: 0, match: base })).pool.total).toBe(0);
    expect(fetches).toBe(1);
    clock += UNUSABLE_TTL_MS;
    expect((await svc.get({ report, slot: 0, match: base })).pool.total).toBe(1);
    expect(fetches).toBe(2);
  });

  it('an upstream outage is an error, not "no similar games"', async () => {
    const svc = createCaseService({
      explorer: async () => ({ rows: [{ match_id: 11, hero_id: 29, player_slot: 0 }] }),
      fetchMatch: async () => { throw new Error('HTTP 503'); },
    });
    const base = parsedReal();
    await expect(svc.get({ report: buildCoachReport(base), slot: 0, match: base })).rejects.toThrow(/unavailable/);
  });
});

describe('GET /api/coach/:matchId/cases', () => {
  let server: Server | null = null;
  afterEach(() => { server?.close(); server = null; });
  async function start(opts: { cases?: object; match?: () => object } = {}) {
    const app = express();
    app.use(express.json());
    app.use(createCoachRouter({
      getMatchDetail: async () => (opts.match ?? parsedReal)(),
      resolveClientIp: () => '1.2.3.4',
      mapError: () => ({ status: 502, body: { error: 'x' } }),
      limiter: { tryConsume: () => ({ ok: true, retryAfterSec: 0 }) },
      cases: opts.cases as never,
    }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server!.once('listening', r));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  it('validates the slot, needs a parsed match, and maps upstream failure to 502', async () => {
    const ok = { get: async () => ({ themes: [] }), peek: () => null };
    let base = await start({ cases: ok });
    expect((await fetch(`${base}/api/coach/9091400302/cases`)).status).toBe(400);
    expect((await fetch(`${base}/api/coach/9091400302/cases?slot=10`)).status).toBe(400);
    const res = await fetch(`${base}/api/coach/9091400302/cases?slot=0`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ themes: [] });
    server!.close();
    base = await start({ cases: ok, match: unparsed });
    expect((await fetch(`${base}/api/coach/9091400302/cases?slot=0`)).status).toBe(422);
    server!.close();
    base = await start({ cases: { get: async () => { throw new Error('boom'); }, peek: () => null } });
    expect((await fetch(`${base}/api/coach/9091400302/cases?slot=0`)).status).toBe(502);
  });

  it('passes a position override through to the report', async () => {
    let seenPos: unknown;
    const base = await start({ cases: { get: async ({ report, slot }: any) => { seenPos = report.reviews[slot].role.pos; return { themes: [] }; }, peek: () => null } });
    expect((await fetch(`${base}/api/coach/9091400302/cases?slot=0&pos=4`)).status).toBe(200);
    expect(seenPos).toBe(4);
  });
});

describe('follow-up context with case studies', () => {
  it('adds the cases, labelled positive / negative with their match ids', () => {
    const match = parsedReal();
    const report = buildCoachReport(match);
    const cases: any = buildCaseStudies({ report, slot: 0, match, candidates: proProfiles() });
    const ctx = reportContext(report, 0, 'zh', cases);
    expect(ctx).toContain('## 相似职业对局（正例 / 反例）');
    expect(ctx).toContain('### 你死于熊战士 8 次');
    expect(ctx).toContain(`反例比赛 ${cases.themes[0].negative.match_id}`);
    expect(reportContext(report, 0, 'zh')).not.toContain('相似职业对局');
  });

  it('without a model, a question about the pro cases is answered from the cases', () => {
    const match = parsedReal();
    const report = buildCoachReport(match);
    const cases: any = buildCaseStudies({ report, slot: 0, match, candidates: proProfiles() });
    const a = fallbackAnswer({ report, slot: 0, lang: 'zh', question: '关于职业对局的正例和反例：正例做了什么不一样的？', cases });
    expect(a).toContain('**你死于熊战士 8 次**');
    expect(a).toContain('反例 · ');
    expect(a).toContain('正例做得不一样的地方');
    // Cases not loaded: the usual headline answer, never an empty one.
    const b = fallbackAnswer({ report, slot: 0, lang: 'zh', question: '正例做了什么？', cases: null });
    expect(b).toContain(`**${report.reviews[0].headline.zh}**`);
  });

  it('pure damage is not compared on defensive items (no item list classifies it)', () => {
    const match = parsedReal();
    const report = buildCoachReport(match);
    (report.reviews[0] as any).chapters.items.damage.types = { physical: 0.2, magic: 0.1, pure: 0.7, other: 0 };
    const out: any = buildCaseStudies({ report, slot: 0, match, candidates: proProfiles() });
    expect(out.damage_type).toBeNull();
    expect(out.themes.map((t: any) => t.key)).not.toContain('items');
    expect(JSON.stringify(out)).not.toMatch(/pure|纯粹/);
  });
});
