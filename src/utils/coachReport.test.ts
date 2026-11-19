import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildCoachReport as buildRaw, isParsed, objectiveTeam, dataGaps, detectionBought } from '../../lib/coach/analyze.js';
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
      expect(tp.body.en).toMatch(new RegExp(`You died (at least )?${n} time`));
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

describe('buildCoachReport — Codex P2 regressions, round 2 (#139)', () => {
  it('missing teamfights or objectives leave death classification unknown', () => {
    const m = parsed();
    delete m.teamfights;
    delete m.objectives;
    const r = buildCoachReport(m);
    const rv = r.reviews.find((x) => x.deaths && x.deaths.length)!;
    expect(rv.deaths!.every((d) => d.in_fight === null && d.converted === null)).toBe(true);
    for (const x of r.reviews) {
      const f = x.findings.find((y) => y.id === 'deaths.high');
      if (!f) continue;
      expect(f.body.en).not.toContain('outside any team fight');
      expect(f.body.en).not.toContain('within 90 seconds');
      expect(f.confidence).toBe('medium');
    }
  });

  it('BKB is not credited or recommended against BKB-piercing disablers', () => {
    const m = unparsed();
    const slugToId = new Map(Object.entries(names.heroes).map(([id, h]: [string, any]) => [h.slug, Number(id)]));
    const piercers = ['enigma', 'faceless_void', 'bane', 'batrider', 'legion_commander'];
    const s = m.players.findIndex((p: any) => p.hero_id === slugToId.get('spectre'));
    const enemies = m.players.filter((p: any) => p.isRadiant !== m.players[s].isRadiant);
    enemies.forEach((p: any, i: number) => { p.hero_id = slugToId.get(piercers[i]); });
    for (const k of ['item_0', 'item_1', 'item_2', 'item_3', 'item_4', 'item_5', 'backpack_0', 'backpack_1', 'backpack_2']) m.players[s][k] = 0;
    m.players[s].item_0 = names.items.black_king_bar.id;
    const r = buildCoachReport(m);
    const fs = r.reviews[s].findings;
    expect(fs.find((f) => f.id === 'items.answer_present' && f.title.en.includes('chain disables'))).toBeUndefined();
    const miss = fs.find((f) => f.id === 'items.answer_missing' && f.title.en.includes('chain disables'));
    expect(miss).toBeTruthy();
    expect(miss!.body.en).toContain('Black King Bar does not stop');
    expect(miss!.ask.en).not.toContain('Black King Bar instead');
  });
});

describe('buildCoachReport — Codex P2 regressions, round 3 (#139)', () => {
  it('counts detection from purchase logs when the aggregate is missing, and never asserts zero from nothing', () => {
    const m = JSON.parse(readFileSync(new URL('../fixtures/match9035042364.parsed.json', import.meta.url), 'utf8'));
    for (const radiant of [true, false]) {
      const team = m.players.filter((p: any) => Boolean(p.isRadiant) === radiant).map((raw: any) => ({ raw }));
      const fromLogs = team.reduce((n: number, x: any) => n + (x.raw.purchase_log ?? []).filter((y: any) => y.key === 'dust' || y.key === 'ward_sentry').length, 0);
      expect(detectionBought(team)).toBe(team.some((x: any) => x.raw.purchase) ? detectionBought(team) : fromLogs);
    }
    expect(detectionBought([{ raw: {} }, { raw: {} }])).toBeNull();
    const r = buildCoachReport(m);
    for (const rv of r.reviews) {
      const f = rv.findings.find((x) => x.id === 'vision.detection');
      if (f) expect(f.body.en).not.toMatch(/bought 0 dust/);
    }
  });
});

describe('buildCoachReport — Codex P2 regressions, round 4 (#139)', () => {
  const legacy = () => JSON.parse(readFileSync(new URL('../fixtures/match9035042364.parsed.json', import.meta.url), 'utf8'));

  it('a Roshan kill and its Aegis pickup count as one objective', () => {
    const r = buildCoachReport(parsed());
    const tp = r.reviews[slotOf(r, 'techies')].findings.find((f) => f.id === 'team.turning_point')!;
    expect(tp.body.en).toContain('the enemy took 5 objectives');
  });

  it('reconstructed death timelines that disagree with the scoreboard are qualified', () => {
    const r = buildCoachReport(legacy());
    const mismatched = r.reviews.filter((rv) => rv.deaths && rv.deaths.length !== r.players[rv.slot].kda[1]);
    expect(mismatched.length).toBeGreaterThan(0);
    for (const rv of mismatched) {
      const d = rv.findings.find((f) => f.id === 'deaths.high');
      if (d) expect(d.evidence.some((e) => e.k.en === 'Deaths with a timeline')).toBe(true);
      const tp = rv.findings.find((f) => f.id === 'team.turning_point');
      if (tp && tp.body.en.includes('You died')) expect(tp.body.en).toContain('at least');
    }
  });
});

describe('buildCoachReport — 9091400302 parsed (real OpenDota parse)', () => {
  const m = () => JSON.parse(readFileSync(new URL('../fixtures/coach/match9091400302.parsed.json', import.meta.url), 'utf8'));

  it('upgrades the unparsed report: no data gaps, lane positions 1–5 for all ten', () => {
    const r = buildCoachReport(m());
    expect(r.match.parsed).toBe(true);
    expect(r.data_gaps).toEqual([]);
    for (const team of [r.reviews.slice(0, 5), r.reviews.slice(5)]) {
      expect(team.map((rv) => rv.role.pos).sort()).toEqual([1, 2, 3, 4, 5]);
      expect(team.every((rv) => rv.role.source === 'lanes')).toBe(true);
    }
    const spectre = r.reviews[slotOf(r, 'spectre')];
    expect(spectre.role.pos).toBe(1);
    expect(spectre.deaths!.length).toBe(15);
  });

  it('the losing side sees the real turn; the winning side (still 23k ahead) sees a slipped lead, not a turn', () => {
    const r = buildCoachReport(m());
    const spectre = r.reviews[slotOf(r, 'spectre')];
    const tp = spectre.findings.find((f) => f.id === 'team.turning_point')!;
    expect(tp.title.en).toBe('The game turned at 39:00–42:00');
    expect(spectre.findings.some((f) => f.id === 'team.lead_slipped')).toBe(false);
    for (const slug of ['ursa', 'skywrath_mage', 'hoodwink', 'weaver', 'dawnbreaker']) {
      const rv = r.reviews[slotOf(r, slug)];
      expect(rv.findings.some((f) => f.id === 'team.turning_point')).toBe(false);
      const slip = rv.findings.find((f) => f.id === 'team.lead_slipped')!;
      expect(slip.title.en).toBe('Your lead slipped at 34:00–37:00');
      expect(slip.body.en).toContain('28.2k ahead');
      expect(slip.severity).toBe(1);
      expect(rv.headline.en).not.toMatch(/turned/);
    }
  });
});

describe('deep review chapters — 9091400302 (real OpenDota parse)', () => {
  const m = () => JSON.parse(readFileSync(new URL('../fixtures/coach/match9091400302.parsed.json', import.meta.url), 'utf8'));
  const ch = (slug: string) => { const r = buildCoachReport(m()); return r.reviews[slotOf(r, slug)].chapters!; };

  it('laning: Tidehunter + Shadow Shaman lost top to Ursa + Hoodwink on lane gold at 10:00', () => {
    const l = ch('tidehunter').laning!;
    expect(l.lane).toBe('top');
    expect(l.gold).toEqual([2986 + 1729, 3663 + 1776]);
    expect(l.outcome).toBe('lost');
    expect(l.deaths).toBe(3);
    expect(l.read.zh).toContain('4:21 被森海飞霞');
    expect(l.towers).toEqual({ ours: 974, theirs: 1208 });
  });

  it('deaths: every death gets a context, and the repeated killer is named', () => {
    const d = ch('tidehunter').deaths!;
    expect(d.rows).toHaveLength(12);
    expect(d.summary.top_killer).toEqual({ hero: 70, deaths: 8 });
    const c = d.summary as unknown as { by_context: Record<string, number> };
    expect(Object.values(c.by_context).reduce((a, b) => a + b, 0)).toBe(12);
    expect(d.read.zh).toContain('其中 8 次死于熊战士');
  });

  it('items: damage split by type points at physical, and the first anti-physical item came after 11 deaths', () => {
    const it = ch('tidehunter').items!;
    expect(it.damage!.by_hero[0].hero).toBe(70);
    expect(it.damage!.types!.physical).toBeGreaterThan(0.55);
    const mm = (it as unknown as { mismatch: { kind: string; answer: { key: string } } }).mismatch;
    expect(mm.kind).toBe('physical');
    expect(mm.answer.key).toBe('ghost');
    expect(it.read.zh).toContain('此时你已经死了 11 次');
    // Lotus Orb is a support's answer, not counted as a core's physical defence.
    expect(it.rows.find((r) => r.item.key === 'lotus_orb')!.vs).toEqual([]);
  });

  it('fights: 18 fights, won/lost by gold edge, Ravage tracked with cooldown honesty', () => {
    const f = ch('tidehunter').fights!;
    expect(f.summary.fights).toBe(18);
    expect(f.ultimate!.key).toBe('tidehunter_ravage');
    expect(f.summary.ult_in).toBe(7);
    expect(f.rows.filter((r) => r.ult_state === 'unused')).toHaveLength(f.summary.ult_unused);
    // A short-cooldown self-buff is not tracked as a fight-defining ultimate.
    expect(ch('ursa').fights!.ultimate).toBeNull();
  });

  it('story: the lead trajectory is relative to gold earned and phases add up to the final lead', () => {
    const s = ch('tidehunter').story!;
    expect(s.phases.map((p) => p.key)).toEqual(['early', 'mid', 'late']);
    expect(s.phases.reduce((a, p) => a + p.swing, 0)).toBe(-43787);
    expect(s.read.zh).toContain('10:00 落后 18%，25:00 落后 30%');
  });

  it('plan: at most three, each with a reason and a check; winners still get one from their findings', () => {
    const tide = ch('tidehunter').plan;
    expect(tide.map((p) => p.key)).toEqual(['deaths.top_killer', 'items.defense_order', 'laning.deaths']);
    for (const slug of ['ursa', 'skywrath_mage', 'spectre', 'pudge']) {
      const plan = ch(slug).plan;
      expect(plan.length).toBeGreaterThan(0);
      expect(plan.length).toBeLessThanOrEqual(3);
      for (const p of plan) { expect(p.why.zh).toBeTruthy(); expect(p.check.zh).toBeTruthy(); }
    }
  });

  it('a pre-horn death (negative time) is laning, not a 500', () => {
    const raw = m();
    const tide = raw.players.find((p: { hero_id: number }) => p.hero_id === 29);
    tide.deaths_log[0].time = -15;
    const r = buildCoachReport(raw);
    const d = r.reviews[slotOf(r, 'tidehunter')].chapters!.deaths!;
    expect(d.rows[0]).toMatchObject({ time: -15, phase: 'early' });
  });

  it('an item that answers both damage types counts for both (Glimmer Cape for a support)', () => {
    const it = ch('shadow_shaman').items!;
    const glimmer = it.rows.find((r) => r.item.key === 'glimmer_cape')!;
    expect(glimmer.vs.sort()).toEqual(['magic', 'physical']);
    const raw = m();
    const ss = raw.players.find((p: { hero_id: number }) => p.hero_id === 27);
    ss.damage_inflictor_received = { null: 1000, skywrath_mage_arcane_bolt: 9000 };
    const r = buildCoachReport(raw);
    const items = r.reviews[slotOf(r, 'shadow_shaman')].chapters!.items!;
    expect(items.read.en).toContain('first item against magic damage was Glimmer Cape');
    expect(items.read.en).not.toMatch(/never bought an item against magic/);
  });

  it('ultimate cooldown counts from the end of the fight that cast it', () => {
    const raw = m();
    const ti = raw.players.findIndex((p: { hero_id: number }) => p.hero_id === 29);
    const blank = () => raw.players.map(() => ({ damage: 0, deaths: 0, gold_delta: 0, ability_uses: {}, item_uses: {}, healing: 0 }));
    const fight = (start: number, end: number, ravage: boolean) => {
      const players = blank();
      players[ti] = { ...players[ti], damage: 500, ability_uses: ravage ? { tidehunter_ravage: 1 } : { tidehunter_gush: 1 } };
      return { start, end, deaths: 0, players };
    };
    raw.teamfights = [fight(600, 650, true), fight(760, 770, false), fight(780, 790, false), fight(820, 830, false)];
    const r = buildCoachReport(raw);
    const rows = r.reviews[slotOf(r, 'tidehunter')].chapters!.fights!.rows;
    // 650 + 150 = 800: 760 and 780 are still on cooldown, 820 is not.
    expect(rows.map((x) => x.ult_state)).toEqual(['used', 'cooldown', 'cooldown', 'unused']);
  });

  it('the trajectory labels each point ahead/behind on its own (comeback)', () => {
    const raw = m();
    raw.radiant_gold_adv = raw.radiant_gold_adv.map((v: number, i: number) => (i <= 10 ? -2000 * (i / 10) : 4000));
    const r = buildCoachReport(raw);
    const s = r.reviews[slotOf(r, 'tidehunter')].chapters!.story!;
    expect(s.read.en).toMatch(/behind \d+% at 10:00, ahead \d+% at 25:00/);
    expect(s.read.zh).toMatch(/10:00 落后 \d+%，25:00 领先 \d+%/);
  });

  it('defence audit reads the full purchase log (a cheap Pavise counts)', () => {
    const raw = m();
    const ss = raw.players.find((p: { hero_id: number }) => p.hero_id === 27);
    ss.damage_inflictor_received = { null: 9000, skywrath_mage_arcane_bolt: 1000 };
    ss.purchase_log = [{ time: 400, key: 'pavise' }, ...ss.purchase_log];
    const r = buildCoachReport(raw);
    expect(r.reviews[slotOf(r, 'shadow_shaman')].chapters!.items!.read.en).toContain('first item against physical damage was Pavise at 6:40');
  });

  it('no purchase log: damage is shown, but nothing is claimed about what was (not) bought', () => {
    const raw = m();
    const ss = raw.players.find((p: { hero_id: number }) => p.hero_id === 27);
    ss.damage_inflictor_received = { null: 1000, skywrath_mage_arcane_bolt: 9000 };
    delete ss.purchase_log;
    const r = buildCoachReport(raw);
    const rv = r.reviews[slotOf(r, 'shadow_shaman')];
    expect(rv.chapters!.items!.read.en).toContain('By type');
    expect(rv.chapters!.items!.read.en).not.toMatch(/never bought|first item against/);
    expect(rv.chapters!.plan.some((p) => p.key === 'items.defense_order')).toBe(false);
  });

  it('casts outside fights = total casts minus casts recorded in fights, not fights with a cast', () => {
    const raw = m();
    const wi = raw.players.findIndex((p: { hero_id: number }) => p.hero_id === 37);
    const players = raw.players.map(() => ({ damage: 0, deaths: 0, gold_delta: 0, ability_uses: {}, item_uses: {}, healing: 0 }));
    players[wi] = { ...players[wi], damage: 300, ability_uses: { warlock_rain_of_chaos: 2 } };
    raw.teamfights = [{ start: 900, end: 960, deaths: 0, players }];
    raw.players[wi].ability_uses = { ...raw.players[wi].ability_uses, warlock_rain_of_chaos: 2 };
    const r = buildCoachReport(raw);
    const f = r.reviews[slotOf(r, 'warlock')].chapters!.fights!;
    expect(f.summary.ult_in).toBe(1);
    expect(f.read.en).not.toMatch(/outside recorded fights/);
  });

  it('no death timeline: the lane chapter claims nothing about lane deaths', () => {
    const raw = m();
    for (const p of raw.players) { delete p.deaths_log; delete p.kills_log; }
    const r = buildCoachReport(raw);
    const l = r.reviews[slotOf(r, 'tidehunter')].chapters!.laning!;
    expect(l.deaths).toBeNull();
    expect(l.read.en).not.toMatch(/did not die/);
    expect(l.read.zh).not.toMatch(/没有死亡/);
  });

  it('the defence plan keeps the damage-type split and the top hero as separate facts', () => {
    const p = ch('tidehunter').plan.find((x) => x.key === 'items.defense_order')!;
    expect(p.why.en).toMatch(/^Most of the damage you took was physical \(\d+% of all sources\); the hero who hurt you most was Ursa \(50% of hero damage\)\.$/);
  });

  it('unparsed matches get no chapters', () => {
    const r = buildCoachReport(unparsed());
    expect(r.reviews.every((rv) => rv.chapters == null)).toBe(true);
  });

  it('auto-triggered and passive ultimates are never audited as "not cast" (Reincarnation)', () => {
    const raw = JSON.parse(readFileSync(new URL('../fixtures/match9035042364.parsed.json', import.meta.url), 'utf8'));
    const r = buildCoachReport(raw);
    const wk = r.reviews[slotOf(r, 'skeleton_king')].chapters!;
    expect(wk.fights?.ultimate ?? null).toBeNull();
    expect(wk.plan.some((p) => p.key === 'fights.ult_unused')).toBe(false);
  });

  it('an incomplete death timeline says so instead of presenting it as the total', () => {
    const raw = JSON.parse(readFileSync(new URL('../fixtures/match9035042364.parsed.json', import.meta.url), 'utf8'));
    const r = buildCoachReport(raw);
    const rv = r.reviews[slotOf(r, 'hoodwink')];
    const d = rv.chapters!.deaths!;
    expect(r.players[rv.slot].kda[1]).toBe(10);
    expect(d.summary.recorded).toBe(10);
    expect(d.read.en).toMatch(/^You died 10 times \(the timeline has 9 of them/);
  });

  it('another real parse builds chapters without throwing for all ten players', () => {
    const r = buildCoachReport(parsed());
    for (const rv of r.reviews) expect(rv.chapters).toBeTruthy();
    // Fight membership still comes from the fight windows: deaths inside one
    // are "fight" (result unknown), never "caught".
    const d0 = r.reviews[0].chapters!.deaths!;
    expect(d0.rows.filter((x) => x.time === 1580 || x.time === 1680).map((x) => x.context)).toEqual(['fight', 'fight']);
    expect(d0.rows.filter((x) => x.context === 'caught').length).toBe(r.reviews[0].deaths!.filter((x) => x.in_fight === false && x.time >= 600).length);
    // Its teamfights carry no per-player rows: no fight table, no "0 of 4 fights".
    expect(r.reviews.every((rv) => rv.chapters!.fights == null)).toBe(true);
    expect(r.reviews[0].chapters!.story!.phases.every((p) => p.fights == null)).toBe(true);
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
