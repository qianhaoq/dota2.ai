import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { linkHeroNames } from '../../packages/review-engine/src/trace/index.js';
import { LOG_KINDS, LOG_ROWS, LOG_WINDOW, TRACK_WINDOW, combatLog, heroTrack, logRow } from '../../lib/agent/replayQuery.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { verifyReview, verifyText } from '../../lib/agent/deepReview.js';

// The fixture is an older trace: no creep kills, gold or Roshan rows, and item uses without their target.
const trace = linkHeroNames(JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString()));

describe('combat_log: the replay\'s own rows, to check a fact (#405)', () => {
  it('rows in the window, in time order, each with its own ref; filtered by hero as actor or target', () => {
    const r: any = combatLog(trace, { from: '30:20', to: '30:40', hero: 'beastmaster' });
    expect(r.rows.length).toBeGreaterThan(0);
    const ts = r.rows.filter((x: any) => typeof x.t === 'number').map((x: any) => x.t);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(ts.every((t: number) => t >= 1820 && t <= 1840)).toBe(true);
    for (const x of r.rows) {
      expect(x.ref).toMatch(/^log:[a-z_]+:\d+$/);
      const involved = [x.by, x.target, x.hero, x.killer, x.from, x.to, x.on, x.to_hero];
      expect(involved.includes('beastmaster'), JSON.stringify(x)).toBe(true);
    }
  });

  it('a kind the trace was built without is a gap, never an empty "none"', () => {
    const r: any = combatLog(trace, { from: '10:00', to: '11:00', kinds: ['creep_kill', 'gold', 'roshan_kill'] });
    expect(r.rows).toEqual([]);
    expect(r.gaps).toEqual([{ topic: 'creep_kill', reason: 'not_in_this_trace' }, { topic: 'gold', reason: 'not_in_this_trace' }, { topic: 'roshan_kill', reason: 'not_in_this_trace' }]);
    // Item uses kept without their target: the target is not known, not "nobody".
    const u: any = combatLog(trace, { from: '0:00', to: '3:00', kinds: ['item_use'] });
    expect(u.rows.length).toBeGreaterThan(0);
    expect(u.rows.every((x: any) => !('to_hero' in x))).toBe(true);
    expect(u.gaps).toEqual([{ topic: 'item_use', reason: 'item_targets_not_in_trace' }]);
  });

  it('new traces: item targets, creep kills and gold by reason come through', () => {
    const t2 = { ...trace, item_uses: [[100, trace.names.indexOf('npc_dota_hero_dark_willow'), 0, 0, trace.names.indexOf('npc_dota_hero_sven')], [101, trace.names.indexOf('npc_dota_hero_dark_willow'), 0, 0, null]], creep_kills: [[102, trace.names.indexOf('npc_dota_hero_sven'), 'd', 7, 900]], gold: [[1, trace.names.indexOf('npc_dota_hero_sven'), 13, 120]] };
    const r: any = combatLog(t2, { from: 60, to: 110, kinds: ['item_use', 'creep_kill', 'gold'] });
    expect(r.gaps).toEqual([]);
    expect(r.rows.map((x: any) => [x.kind, x.kind === 'item_use' ? x.to_hero : x.kind === 'creep_kill' ? x.what : x.reason])).toEqual([['gold', 'lane_creep'], ['item_use', 'sven'], ['item_use', null], ['creep_kill', 'deny']]);
  });

  it('limits: a window, a row cap with the count left out, bad input', () => {
    expect(combatLog(trace, { from: 0, to: LOG_WINDOW + 1 })).toMatchObject({ error: 'window_too_long' });
    expect(combatLog(trace, { from: 10, to: 5 })).toMatchObject({ error: 'bad_window' });
    expect(combatLog(trace, { from: 0, to: 10, kinds: ['vision'] })).toMatchObject({ error: 'unknown_kind' });
    expect(combatLog(trace, { from: 0, to: 10, hero: 'nobody' })).toMatchObject({ error: 'unknown_hero' });
    const all: any = combatLog(trace, { from: '30:00', to: '33:00' });
    expect(all.rows).toHaveLength(LOG_ROWS);
    expect(all.rows_not_listed).toBeGreaterThan(0);
    expect(LOG_KINDS).toContain('damage');
  });

  it('a row opens as evidence, and a sentence quoting it is backed', () => {
    const r: any = combatLog(trace, { from: '30:20', to: '30:40', hero: 'beastmaster', kinds: ['cast'] });
    const row = r.rows[0];
    expect(resolveRef(trace, row.ref, { hero: 'beastmaster', lang: 'zh' })?.record).toEqual(row);
    expect(logRow(trace, 'cast', 999999)).toBeNull();
    expect(verifyText(`${row.clock} 你放了技能。`, [r]).ok).toBe(true);
  });
});

describe('hero_track: one hero over a window', () => {
  it('each second: alive, where, doing, health, mana, level; the ref opens it', () => {
    const r: any = heroTrack(trace, { hero: 'beastmaster', from: '30:20', to: '30:25' });
    expect(r.ref).toBe('track:beastmaster:1820:1825');
    expect(r.seconds).toHaveLength(6);
    expect(r.seconds[0]).toMatchObject({ clock: '30:20', alive: true, place: expect.any(String), doing: expect.any(String), level: expect.any(Number) });
    expect(resolveRef(trace, r.ref, { hero: 'beastmaster', lang: 'zh' })?.record).toMatchObject({ ref: r.ref, seconds: r.seconds });
    expect(heroTrack(trace, { hero: 'beastmaster', from: 0, to: TRACK_WINDOW + 1 })).toMatchObject({ error: 'window_too_long' });
  });

  it('a sentence quoting one second of the track is backed when it cites the track (Codex on #413)', () => {
    const r: any = heroTrack(trace, { hero: 'beastmaster', from: '30:20', to: '30:30' });
    const at = r.seconds.find((x: any) => x.clock === '30:25');
    const review = { verdict: 'v', mainline: [], blind_spots: [], findings: [{ title: 't', claim: '蓝量。', fix: 'x', evidence: [{ refs: [r.ref], fact: `30:25 时你有 ${at.mana} 点蓝。` }] }] };
    const check = verifyReview(review, [r]);
    expect(check.problems.filter((p: any) => p.where === 'evidence' || p.where === 'finding')).toEqual([]);
    expect(check.unsupported.findings.size).toBe(0);
  });

  it('without creep kills in the trace, farming is not seen: a gap says so (Codex on #413)', () => {
    const r: any = heroTrack(trace, { hero: 'beastmaster', from: '30:20', to: '30:21' });
    expect(r.gaps).toEqual([{ topic: 'farming', reason: expect.stringContaining('none_of_these does not rule it out') }]);
    const withKills: any = heroTrack({ ...trace, creep_kills: [[1820, trace.names.indexOf('npc_dota_hero_beastmaster'), 'l', 100, 9000]] }, { hero: 'beastmaster', from: '30:20', to: '30:21' });
    expect(withKills.gaps).toEqual([]);
    expect(withKills.seconds[0].doing).toBe('farming');
  });

  it('a second with no sample is not known, and the gap says so', () => {
    const blank = { ...trace, states: trace.states.map((s: any, i: number) => (i === trace.heroes.findIndex((h: any) => h.key === 'beastmaster') ? { ...s, x: s.x.map(() => null), y: s.y.map(() => null) } : s)) };
    const r: any = heroTrack(blank, { hero: 'beastmaster', from: 100, to: 102 });
    expect(r.seconds.every((s: any) => s.known === false)).toBe(true);
    expect(r.gaps).toEqual([{ topic: 'samples', reason: 'some seconds have no sample' }, { topic: 'farming', reason: expect.stringContaining('no_creep_kills_in_trace') }]);
  });
});

describe('combat_log: smoke and runes (#405)', () => {
  it('a smoked hero with who used it and until when; a rune; an old trace without them is a gap', () => {
    const ix = (k: string) => trace.names.indexOf(`npc_dota_hero_${k}`);
    const t2 = { ...trace, smokes: [[100.2, ix('sven'), ix('dark_willow'), 112.5], [100.4, ix('dark_willow'), ix('dark_willow'), null]], runes: [[130, ix('sven'), 'haste', 152]] };
    const r: any = combatLog(t2, { from: 90, to: 140, kinds: ['smoke', 'rune'] });
    expect(r.gaps).toEqual([]);
    expect(r.rows.map((x: any) => [x.clock, x.kind, x.hero, x.used_by ?? x.rune, x.until])).toEqual([
      ['1:40', 'smoke', 'sven', 'dark_willow', '1:52'],
      // Still on when the log ended: null, not a made-up end.
      ['1:40', 'smoke', 'dark_willow', 'dark_willow', null],
      ['2:10', 'rune', 'sven', 'haste', '2:32'],
    ]);
    expect((combatLog(trace, { from: 90, to: 140, kinds: ['smoke', 'rune'] }) as any).gaps).toEqual([{ topic: 'smoke', reason: 'not_in_this_trace' }, { topic: 'rune', reason: 'not_in_this_trace' }]);
  });
});
