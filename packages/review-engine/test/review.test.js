import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, it, expect } from 'vitest';
import { buildReview, validateReview, ENGINE_VERSION } from '../src/index.js';
import { clock, findWindow } from '../src/facts/index.js';
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
  expect(r.facts.patch.display).toEqual({ en: 'test-patch', zh: 'test-patch' });
  expect(buildReview(raw, { ...opts, patch: 42 }).facts.patch.display.en).toBe('42');
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
  const repeated = buildReview(raw, opts).insights[1];
  expect(repeated.pattern).toBe('repeat_killer');
  expect(repeated.fact_ids).toEqual(['killed_by.doom_bringer']);
  expect(repeated.claim.slots).toContain('{killed_by.doom_bringer}');
  expect(repeated.claim.text).toContain('Doom (2 deaths)');
  expect(repeated.claim.text).not.toContain('hoodwink');
  expect(buildReview(raw, { ...opts, lang: 'zh' }).insights[1].claim.text).toContain('末日使者（2 次）');
  raw.players[0].deaths_log[1].key = 'sniper';
  expect(buildReview(raw, opts).insights[1].pattern).toBe('phase_repeat');
  expect(buildReview(raw, opts).insights[1].claim.text).toContain('lane phase: 3');
  expect(buildReview(raw, { ...opts, lang: 'zh' }).insights[1].claim.text).toContain('对线期集中死亡：3');
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

it('keeps supported insights when unrelated kill logs are missing', () => {
  const raw = load(9035042364);
  const focus = raw.players.find(p => p.hero_id === 14);
  delete raw.players.find(p => p !== focus).kills_log;
  const review = buildReview(raw, opts);
  expect(review.state).toBe('parsed');
  expect(review.insights.map(i => i.status)).toEqual(['ok', 'ok', 'ok']);
  expect(review.facts['deaths.total'].value).toBe(19);
  expect(buildReview(raw, { ...opts, heroId: undefined }).state).toBe('parsed');
  delete focus.deaths_log;
  const inverted = buildReview(raw, opts);
  expect(inverted.deaths).toEqual([]);
  expect(inverted.facts['deaths.total']).toBeUndefined();
  expect(inverted.insights.map(i => i.status)).toEqual(['ok', 'insufficient', 'ok']);
  expect(inverted.data_gaps).toContainEqual({ topic: 'deaths', reason: 'missing_death_timeline' });
});

it('cites the original killer events for inverted death facts and aggregates', () => {
  const raw = { version: 1, radiant_gold_adv: Array(11).fill(0), players: [
    { hero_id: 14, player_slot: 0, deaths: 2, kills_log: [] },
    { hero_id: 1, player_slot: 128, kills_log: [{ time: 5, key: 'npc_dota_hero_axe' }, { time: 121, key: 'npc_dota_hero_pudge' }] },
    { hero_id: 2, player_slot: 129, kills_log: [{ time: 61, key: 'npc_dota_hero_pudge' }] },
  ] };
  const review = buildReview(raw, opts);
  expect(review.facts['death.1'].source_path).toBe('players[2].kills_log[0]');
  expect(review.facts['death.2'].source_path).toBe('players[1].kills_log[1]');
  for (const id of ['killed_by', 'deaths.total', 'deaths.before_15', 'deaths.before_22.killed_by', 'deaths.phase.lane']) {
    expect(review.facts[id].source_path).toBe('players[2].kills_log[0]; players[1].kills_log[1]');
  }
  expect(review.citations[0].fields).toContain('players[2].kills_log[0]');
  expect(review.citations[0].fields.join('; ')).not.toContain('players[0].kills_log');
  expect(review.citations[0].fields.join('; ')).not.toContain('inversion');
});

it('preserves objective indices after discarding invalid times', () => {
  const raw = load(9035042364);
  raw.objectives = [{ time: null }, { time: 120, key: 'tower' }];
  const review = buildReview(raw, opts);
  expect(review.objectives).toHaveLength(1);
  expect(review.objectives[0].fact_id).toBe('obj.120.1');
  expect(review.facts['obj.120.1'].source_path).toBe('objectives[1]');
});


it.each(['hole', 'null', 'non-finite'])('keeps independently supported insights with a %s in the gold series', gap => {
  const raw = load(9035042364);
  if (gap === 'hole') delete raw.radiant_gold_adv[0];
  else raw.radiant_gold_adv[0] = gap === 'null' ? null : Infinity;
  const review = buildReview(raw, opts);
  expect(review.state).toBe('parsed');
  expect(review.insights.map(i => i.status)).toEqual(['ok', 'ok', 'ok']);
  expect(review.insights[0].fact_ids).toContain('gold.window.40_45.delta');
  expect(review.insights[2].fact_ids).toContain('lh_at_10');
  expect(review.data_gaps).toContainEqual({ topic: 'radiant_gold_adv', reason: 'missing_or_incomplete_gold_series' });
  expect(validateReview(review).ok).toBe(true);
});

it('keeps death insights without gold and gates economy insights on their own facts', () => {
  const raw = load(9035042364);
  delete raw.radiant_gold_adv;
  delete raw.players.find(p => p.hero_id === 14).lh_t;
  const review = buildReview(raw, opts);
  expect(review.state).toBe('parsed');
  expect(review.insights.map(i => i.status)).toEqual(['insufficient', 'ok', 'insufficient']);
  expect(review.insights[1].pattern).toBe('repeat_killer');
  expect(validateReview(review).ok).toBe(true);
  raw.players.find(p => p.hero_id === 14).lh_t = Array(11).fill(13);
  const withLastHits = buildReview(raw, opts);
  expect(withLastHits.insights[2].status).toBe('ok');
  expect(withLastHits.insights[2].fact_ids).toEqual(['lh_at_10']);
});

it.each(['en', 'zh'])('falls back to the slug for an unknown repeated killer in %s', lang => {
  const raw = { version: 1, players: [{ hero_id: 14, player_slot: 0, deaths: 2, deaths_log: [{ time: 61, key: 'unknown_hero' }, { time: 121, key: 'unknown_hero' }] }] };
  const insight = buildReview(raw, { ...opts, lang }).insights[1];
  expect(insight.status).toBe('ok');
  expect(insight.fact_ids).toEqual(['killed_by.unknown_hero']);
  expect(insight.claim.text).toContain(lang === 'zh' ? 'unknown_hero（2 次）' : 'unknown_hero (2 deaths)');
});

it.each([[-5, '-0:05'], [-65, '-1:05'], [0, '0:00'], [65, '1:05']])('formats clock(%s) as %s', (seconds, expected) => {
  expect(clock(seconds)).toBe(expected);
});

it('uses the normalized unknown type for objectives without a key or type', () => {
  const raw = load(9035042364);
  raw.objectives = [{ time: -5 }];
  const review = buildReview(raw, opts);
  expect(review.objectives[0].type).toBe('unknown');
  expect(review.facts['obj.-5.0'].display).toEqual({ en: 'unknown', zh: 'unknown' });
  expect(validateReview(review).ok).toBe(true);
});

it('excludes same-team denies and self-kills from inverted death evidence', () => {
  const raw = { version: 1, radiant_gold_adv: Array(11).fill(0), players: [
    { hero_id: 14, player_slot: 0, deaths: 2, kills_log: [{ time: 10, key: 'npc_dota_hero_pudge' }] },
    { hero_id: 1, player_slot: 1, kills_log: [{ time: 20, key: 'npc_dota_hero_pudge' }, { time: 30, key: 'npc_dota_hero_pudge' }] },
    { hero_id: 2, player_slot: 128, kills_log: [{ time: 61, key: 'npc_dota_hero_pudge' }] },
    { hero_id: 5, player_slot: 129, kills_log: [{ time: 121, key: 'npc_dota_hero_pudge' }] },
  ] };
  const review = buildReview(raw, opts);
  expect(review.deaths.map(d => d.t)).toEqual([61, 121]);
  expect(review.facts['deaths.total'].value).toBe(2);
  expect(review.facts.killed_by.value).toEqual({ axe: 1, crystal_maiden: 1 });
  expect(review.facts['killed_by.antimage']).toBeUndefined();
  expect(review.facts['killed_by.pudge']).toBeUndefined();
  expect(review.insights[1].status).toBe('ok');
  expect(review.insights[1].pattern).toBe('phase_repeat');
});

it('excludes same-team denies and self-kills from direct-log killer counts while keeping all deaths', () => {
  const deaths_log = [
    { time: 10, key: 'npc_dota_hero_pudge' },
    { time: 20, key: 'antimage' },
    { time: 30, key: 'npc_dota_hero_antimage' },
    { time: 61, key: 'npc_dota_hero_axe' },
    { time: 121, key: 'crystal_maiden' },
    { time: 601, key: 'npc_dota_badguys_tower1_mid' },
    { time: 1300, key: 'unknown_hero' },
    { time: 1501 },
  ].map(d => ({ ...d, gold_fed: 100, time_dead: 20 }));
  const raw = { version: 1, radiant_gold_adv: Array(26).fill(0), players: [
    { hero_id: 14, player_slot: 0, deaths: 8, deaths_log },
    { hero_id: 1, player_slot: 1 },
    { hero_id: 2, player_slot: 128 },
    { hero_id: 5, player_slot: 129 },
  ] };
  const review = buildReview(raw, opts);
  const f = review.facts;
  expect(review.deaths.map(d => d.t)).toEqual(deaths_log.map(d => d.time));
  expect(f['death.2'].value.killer).toBe('antimage');
  expect(f['deaths.total'].value).toBe(8);
  expect(f['deaths.before_15'].value).toBe(6);
  expect(f['deaths.before_22'].value).toBe(7);
  expect(['lane', 'mid', 'late'].map(phase => f[`deaths.phase.${phase}`].value)).toEqual([5, 2, 1]);
  expect(f['deaths.behind_1k'].value).toBe(0);
  expect(f.gold_fed.value).toBe(800);
  expect(f.time_dead.value).toBe(160);
  expect(f.killed_by.value).toEqual({ axe: 1, crystal_maiden: 1, npc_dota_badguys_tower1_mid: 1, unknown_hero: 1 });
  expect(f['deaths.before_15.killed_by'].value).toEqual({ axe: 1, crystal_maiden: 1, npc_dota_badguys_tower1_mid: 1 });
  expect(f['deaths.before_22.killed_by'].value).toEqual(f.killed_by.value);
  expect(f['killed_by.antimage']).toBeUndefined();
  expect(f['killed_by.pudge']).toBeUndefined();
  const insight = review.insights.find(i => i.id === 'fix_this');
  expect(insight.status).toBe('ok');
  expect(insight.pattern).toBe('phase_repeat');
});

it.each([
  [{ player_slot: 0 }, 'radiant'],
  [{ player_slot: 128 }, 'dire'],
  [{ team: 3, player_slot: 0 }, 'dire'],
  [{ team: 2, player_slot: 128 }, 'radiant'],
  [{ team: 0, player_slot: 128 }, 'dire'],
  [{}, null],
])('recovers objective teams while preferring explicit teams: %j', (fields, team) => {
  const review = buildReview({ version: 1, objectives: [{ time: 120, type: 'building_kill', ...fields }] }, opts);
  expect(review.objectives[0].team).toBe(team);
  expect(review.facts['obj.120.0'].value.team).toBe(team);
});

it('localizes Chinese followup labels while retaining internal insight and gap keys', () => {
  const raw = load(9035042364);
  delete raw.players.find(p => p.hero_id === 14).deaths_log[0].gold_fed;
  const review = buildReview(raw, { ...opts, lang: 'zh' });
  expect(review.followups.filter(f => f.answerable).map(f => [f.id, f.label])).toEqual([
    ['why_turning_point', '查看结论证据：转折点'],
    ['why_fix_this', '查看结论证据：本场要改'],
    ['why_next_game', '查看结论证据：下局重点'],
  ]);
  for (const [gap, label] of [['gold_fed', '死亡送出金钱'], ['death_locations', '死亡位置']]) {
    expect(review.followups).toContainEqual({ id: gap, label, answerable: false, gap });
  }
  const english = buildReview(raw, opts);
  expect(english.followups).toContainEqual({ id: 'gold_fed', label: 'Gold fed', answerable: false, gap: 'gold_fed' });
});
