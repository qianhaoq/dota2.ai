import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, it, expect } from 'vitest';
import { buildReview, validateReview, ENGINE_VERSION } from '../src/index.js';
import { findWindow } from '../src/facts/index.js';
const dir = new URL('./fixtures/gold/', import.meta.url);
const load = id => JSON.parse(gunzipSync(readFileSync(new URL(`${id}.json.gz`, dir))));
const opts = { heroId: 14, lang: 'en', fetchedAt: '2026-10-22T00:00:00Z' };

it('reproduces every PR2 numerical acceptance criterion for Pudge', () => {
  const review = buildReview(load(9035042364), opts);
  const f = review.facts;
  const values = {
    'gold.low': -28965, 'gold.window.40_45.start': -19971, 'gold.window.40_45.end': -26954, 'gold.window.40_45.delta': -6983,
    'xp.window.40_45.start': -13731, 'xp.window.40_45.end': -23361, 'xp.window.40_45.delta': -9630,
    'comeback.52_57.gold.start': -25878, 'comeback.52_57.gold.end': -8124,
    'comeback.52_57.xp.start': -17796, 'comeback.52_57.xp.end': 21255,
    'xp.peak': 21945, 'gold.at.61': -4176, 'gold.at.10': -2060,
    'ancient.fell': 3715, 'deaths.before_15': 5, 'deaths.before_22': 7,
    'deaths.behind_1k': 16, 'deaths.total': 19, gold_fed: 10253, time_dead: 776, lh_at_10: 13,
  };
  for (const [id, value] of Object.entries(values)) expect(f[id]?.value, id).toBe(value);
  expect(f['gold.low'].t).toBe(2760);
  expect(f['gold.low'].display.t).toBe('46:00');
  expect(f['xp.peak'].t).toBe(3480);
  expect(f['ancient.fell'].display.en).toBe('61:55');
  expect(f.time_dead.display.en).toBe('12:56');
  expect(f.killed_by.value).toEqual({ skeleton_king: 8, doom_bringer: 5, hoodwink: 4, sniper: 2 });
  expect(f['deaths.before_22.killed_by'].value).toEqual({ doom_bringer: 3, hoodwink: 4 });
  expect(f['gold.window.40_45'].value).toEqual({ start: -19971, end: -26954, delta: -6983, start_minute: 40, end_minute: 45 });
  expect(f['comeback.52_57.gold'].value.delta).toBe(17754);
  expect(f['comeback.52_57.xp'].value.delta).toBe(39051);
  expect(review.insights.map(i => [i.id, i.status])).toEqual([['turning_point', 'ok'], ['fix_this', 'ok'], ['next_game', 'ok']]);
  expect(review.insights[1].pattern).toBe('behind_1k');
  expect(review.engine_version).toBe(ENGINE_VERSION);
  expect(validateReview(review)).toEqual({ ok: true, errors: [] });
});

describe('gold corpus', () => {
  for (const file of readdirSync(dir).filter(file => file.endsWith('.json.gz')).sort()) it(`${file}: schema, determinism, no mutation, evidence references`, () => {
    const raw = load(file.replace('.json.gz', ''));
    const before = JSON.stringify(raw);
    for (const heroId of [undefined, ...raw.players.map(p => p.hero_id)]) for (const lang of ['en', 'zh']) {
      const options = { ...opts, heroId, lang };
      const review = buildReview(raw, options);
      expect(validateReview(review), `${file}/${heroId}/${lang}`).toEqual({ ok: true, errors: [] });
      expect(JSON.stringify(buildReview(raw, options))).toBe(JSON.stringify(review));
      for (const [id, fact] of Object.entries(review.facts)) expect(fact.id).toBe(id);
      for (const insight of review.insights) {
        for (const id of [...insight.fact_ids, ...(insight.comeback?.fact_ids ?? [])]) expect(review.facts[id], id).toBeDefined();
        expect(insight.claim.text).not.toMatch(/\{[^{}]+\}/);
      }
      if (heroId == null) { expect(review.player).toBeNull(); expect(review.insights).toEqual([]); }
    }
    expect(JSON.stringify(raw)).toBe(before);
  });
});

it('uses strict < -1000 and floor(t/60), never clamps missing gold samples', () => {
  const raw = { version: 1, match_id: 1, radiant_gold_adv: [-1000, -1001, 0, 0, 0, 0], players: [{ hero_id: 14, player_slot: 0, deaths: 3, kills_log: [], deaths_log: [{ time: 59, key: 'doom_bringer' }, { time: 60, key: 'doom_bringer' }, { time: 119, key: 'doom_bringer' }] }] };
  expect(buildReview(raw, opts).facts['deaths.behind_1k'].value).toBe(2);
  raw.players[0].deaths_log.push({ time: 600, key: 'doom_bringer' });
  raw.players[0].deaths = 4; // Keep the scoreboard complete to isolate the missing-gold boundary.
  const review = buildReview(raw, opts);
  expect(review.facts['deaths.behind_1k']).toBeUndefined();
  expect(review.data_gaps).toContainEqual({ topic: 'deaths.behind_1k', reason: 'missing_gold_at_death' });
});

it('registers absent death sums and can recover a timeline from kills_log', () => {
  const raw = load(9035042364);
  delete raw.players.find(p => p.hero_id === 14).deaths_log;
  const review = buildReview(raw, opts);
  expect(review.facts.gold_fed).toBeUndefined();
  expect(review.facts.time_dead).toBeUndefined();
  expect(review.facts['deaths.total'].value).toBe(19);
  expect(review.data_gaps.map(g => g.topic)).toEqual(expect.arrayContaining(['gold_fed', 'time_dead', 'death_locations', 'build_vs_lineup']));
});

it('applies Dire perspective and patch fallback without mutating raw', () => {
  const raw = load(9035042364);
  delete raw.patch;
  const heroId = raw.players.find(p => p.player_slot >= 128).hero_id;
  const r = buildReview(raw, { ...opts, heroId, patch: 'test-patch' });
  expect(r.facts['gold.at.10'].value).toBe(2060);
  expect(r.facts.patch.value).toBe('test-patch');
  raw.patch = 42;
  expect(buildReview(raw, { ...opts, patch: 'fallback' }).facts.patch.value).toBe(42);
});

it('handles unparsed, missing player and empty evidence honestly', () => {
  const raw = load(9035042364);
  raw.od_data = { has_parsed: false };
  const r = buildReview(raw, opts);
  expect(r.state).toBe('unparsed');
  expect(r.insights.every(i => i.status === 'insufficient' && i.reason === 'not_parsed_yet')).toBe(true);
  expect(r.facts['gold.low']).toBeUndefined();
  expect(validateReview(r).ok).toBe(true);
  expect(buildReview({ version: 1 }, opts).state).toBe('insufficient');
  expect(validateReview(buildReview({}, opts)).ok).toBe(true);
  expect(buildReview(load(9035042364), { ...opts, heroId: 9999 }).player).toBeNull();
});

it('selects exact five-minute windows with earliest tie-breaking and no gaps', () => {
  expect(findWindow([0, 0, 0, 0, 0, -5, -8])).toEqual({ from: 1, to: 6, delta: -8 });
  expect(findWindow([0, 0, 0, 0, 0, 0, 0]).from).toBe(0);
  expect(findWindow([0, 0, null, 0, 0, -100])).toBeNull();
});

it('rejects malformed nested review payloads with independent errors', () => {
  const r = buildReview(load(9035042364), opts);
  r.facts['gold.low'].kind = 'invented';
  r.insights[0].status = 'invented';
  const invalid = validateReview(r);
  expect(invalid.ok).toBe(false);
  expect(invalid.errors.length).toBeGreaterThanOrEqual(2);
  expect(validateReview(buildReview(load(9035042364), opts)).ok).toBe(true);
  expect(invalid.errors.length).toBeGreaterThanOrEqual(2);
});

it('prioritizes repeated killers over phase concentration, with phase as fallback', () => {
  const raw = { version: 1, match_id: 1, radiant_gold_adv: [0, 0, 0, 0, 0, 0, 0], players: [{ hero_id: 14, player_slot: 0, kills_log: [], deaths: 3, deaths_log: [{ time: 61, key: 'doom_bringer' }, { time: 121, key: 'doom_bringer' }, { time: 181, key: 'hoodwink' }] }] };
  expect(buildReview(raw, opts).insights[1].pattern).toBe('repeat_killer');
  raw.players[0].deaths_log[1].key = 'sniper';
  expect(buildReview(raw, opts).insights[1].pattern).toBe('phase_repeat');
  raw.players[0].deaths_log = [];
  raw.players[0].deaths = 0;
  expect(buildReview(raw, opts).insights[1].status).toBe('insufficient');
});

it('does not invent death sums for partial log fields', () => {
  const raw = load(9035042364);
  delete raw.players.find(p => p.hero_id === 14).deaths_log[0].time_dead;
  const r = buildReview(raw, opts);
  expect(r.facts.gold_fed.value).toBe(10253);
  expect(r.facts.time_dead).toBeUndefined();
  expect(r.data_gaps).toContainEqual({ topic: 'time_dead', reason: 'missing_or_incomplete_deaths_log' });
});

it('can choose a supported recovery window over a larger unsupported one', () => {
  const series = [0, 0, 0, 0, 0, 20, 10];
  expect(findWindow(series, 0, 'max', w => w.from > 0)).toEqual({ from: 1, to: 6, delta: 10 });
});

it('withholds aggregate death claims when the observed timeline is incomplete', () => {
  const raw = load(9035042364);
  raw.players.find(p => p.hero_id === 14).deaths_log.pop();
  const r = buildReview(raw, opts);
  expect(r.deaths).toHaveLength(18);
  for (const id of ['deaths.total', 'deaths.before_15', 'deaths.behind_1k', 'killed_by', 'gold_fed', 'time_dead']) expect(r.facts[id], id).toBeUndefined();
  expect(r.insights[1].status).toBe('insufficient');
  expect(r.data_gaps).toContainEqual({ topic: 'deaths', reason: 'death_timeline_incomplete' });
});
