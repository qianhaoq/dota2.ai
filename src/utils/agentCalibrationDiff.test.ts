import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calibrationRows, compareCalibration, zScore, MIN_CASES } from '../../lib/agent/calibrationDiff.js';

const KEPT = JSON.parse(readFileSync(new URL('../../data/calibration.v1.json', import.meta.url), 'utf8'));

describe('calibration diff: which quoted rates moved', () => {
  it('reads every table row with a count of cases, its outcomes over that count', () => {
    const rows = calibrationRows(KEPT);
    const fight = rows.find((r) => r.at === 'measures' && r.key === 'measure=more heroes took part');
    expect(fight).toMatchObject({ cases: 'fights', n: KEPT.measures[0].fights, outcomes: { side_ahead_won: { k: KEPT.measures[0].side_ahead_won, n: KEPT.measures[0].fights } } });
    // A tier is a label, not an outcome; the rate is never read as one.
    const tower = rows.find((r) => r.at === 'after_towers_fell');
    expect(tower!.key).toMatch(/^tier=\d after_a_won_fight=(true|false)$/);
    expect(Object.keys(tower!.outcomes)).not.toContain('tier');
    expect(rows.every((r) => !('rate' in r.outcomes))).toBe(true);
    // Nested objects too: the Roshan fights.
    expect(rows.find((r) => r.at === 'roshans.fights_in_the_next_300s')).toBeTruthy();
  });

  it('the Aegis outcomes are over the takes, and an ultimate edge is judged by the fights it decided', () => {
    const rows = calibrationRows(KEPT);
    const aegis = rows.find((r) => r.at === 'roshans.aegis');
    expect(aegis).toMatchObject({ cases: 'takes', n: KEPT.roshans.takes, outcomes: { used: { k: KEPT.roshans.aegis.used, n: KEPT.roshans.takes }, expired: { k: KEPT.roshans.aegis.expired, n: KEPT.roshans.takes } } });
    // Buildings after an Aegis are not a split of the takes (more buildings than takes): not read as a rate.
    expect(rows.find((r) => r.at === 'roshans.buildings_in_the_next_300s')).toBeUndefined();
    const u = KEPT.ultimate_edges;
    expect(rows.find((r) => r.at === 'ultimate_edges')!.outcomes.edge_side_lost_fewer_of_decided).toEqual({ k: u.edge_side_lost_fewer, n: u.edge_side_lost_fewer + u.edge_side_lost_more });

    // Codex's two cases: both are listed.
    const noAegisUsed = structuredClone(KEPT);
    noAegisUsed.roshans.aegis.expired += noAegisUsed.roshans.aegis.used; noAegisUsed.roshans.aegis.used = 0;
    expect(compareCalibration(KEPT, noAegisUsed).shifted.map((x) => `${x.row} · ${x.outcome}`)).toEqual(expect.arrayContaining(['roshans.aegis | takes · used', 'roshans.aegis | takes · expired']));
    const edge = structuredClone(KEPT);
    const decided = u.edge_side_lost_fewer + u.edge_side_lost_more;
    edge.ultimate_edges.edge_side_lost_fewer = Math.round(decided * 0.68); edge.ultimate_edges.edge_side_lost_more = decided - Math.round(decided * 0.68);
    const shifted = compareCalibration(KEPT, edge).shifted.find((x) => x.outcome === 'edge_side_lost_fewer_of_decided');
    expect(shifted).toMatchObject({ row: 'ultimate_edges | moments', after: { of: decided, rate: 68 } });
    expect(shifted!.z).toBeGreaterThan(2);
  });

  it('the kept snapshot against itself: nothing moved, nothing new', () => {
    const r = compareCalibration(KEPT, KEPT);
    expect(r).toMatchObject({ shifted: [], new_rows: [], gone_rows: [] });
    expect(r.held).toBeGreaterThan(50);
  });

  it('lists a rate that moved beyond noise, and only that one', () => {
    const after = structuredClone(KEPT);
    const m = after.measures[0];
    m.fights *= 2; m.side_ahead_won = Math.round(m.fights * 0.5);
    after.games += 30;
    const r = compareCalibration(KEPT, after);
    expect(r.games).toEqual({ before: KEPT.games, after: KEPT.games + 30 });
    expect(r.shifted).toHaveLength(1);
    expect(r.shifted[0]).toMatchObject({ row: 'measures | fights | measure=more heroes took part', outcome: 'side_ahead_won', after: { rate: 50 } });
    expect(r.shifted[0].z).toBeLessThan(-2);
  });

  it('a small change on few cases is too few to call; a new or dropped row is named', () => {
    const before = { games: 1, rows: [{ case: 'a', fights: MIN_CASES - 1, won: 2 }, { case: 'b', fights: 100, won: 50 }] };
    const after = { games: 2, rows: [{ case: 'a', fights: MIN_CASES - 1, won: 15 }, { case: 'c', fights: 100, won: 50 }] };
    const r = compareCalibration(before, after);
    expect(r).toMatchObject({ shifted: [], too_few: 1, new_rows: ['rows | fights | case=c'], gone_rows: ['rows | fights | case=b'] });
  });

  it('z score: same rate is 0, a known gap is its textbook value', () => {
    expect(zScore(50, 100, 50, 100)).toBe(0);
    expect(zScore(50, 100, 70, 100)).toBeCloseTo(2.89, 2);
    expect(zScore(0, 0, 1, 2)).toBeNull();
  });

  it('the script exits 1 when a rate moved and 0 when none did', () => {
    const dir = mkdtempSync(join(tmpdir(), 'caldiff-'));
    const same = join(dir, 'same.json');
    writeFileSync(same, JSON.stringify(KEPT));
    const moved = structuredClone(KEPT); moved.measures[0].fights *= 2; moved.measures[0].side_ahead_won = Math.round(moved.measures[0].fights * 0.5);
    const other = join(dir, 'moved.json');
    writeFileSync(other, JSON.stringify(moved));
    const run = (...a: string[]) => { try { return { code: 0, out: execFileSync('node', ['scripts/calibrate-diff.mjs', ...a], { encoding: 'utf8' }) }; } catch (e: any) { return { code: e.status, out: String(e.stdout) }; } };
    expect(run(same).code).toBe(0);
    const r = run(other);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/1 rate\(s\) moved beyond noise/);
    expect(run().code).toBe(2);
  });
});
