import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCoachReport } from '../../lib/coach/analyze.js';
import { evaluateGoal, goalFor } from '../../lib/coach/goals.js';

const load = (f: string) => JSON.parse(readFileSync(path.join(process.cwd(), 'src/fixtures/coach', f), 'utf8'));
const parsed = buildCoachReport(load('match9091400302.parsed.json'));
const unparsed = buildCoachReport(load('match9091400302.unparsed.json'));
const other = buildCoachReport(load('match9094562824.parsed.json'));
const goalOf = (r: any, slot: number, id: string) => r.reviews[slot].findings.find((f: any) => f.id === id)?.goal;

describe('goalFor: only findings with an honest next-game check', () => {
  it('attaches goals to fix findings, never to good ones', () => {
    for (const rv of [...parsed.reviews, ...other.reviews]) {
      for (const f of rv.findings) if (f.goal) expect(f.tone, f.id).toBe('fix');
    }
    expect(goalFor({ id: 'farm.strong', tone: 'good' }, {} as any)).toBeNull();
    expect(goalFor({ id: 'team.turning_point', tone: 'fix' }, { me: {}, role: {} } as any)).toBeNull();
  });

  it('deaths: a third fewer deaths per 10 minutes than this game', () => {
    const g = goalOf(unparsed, 4, 'deaths.high'); // Spectre, 15 deaths in 45:22
    expect(g).toMatchObject({ kind: 'deaths_per10_max', max: 2.2 });
    expect(g.label.zh).toBe('每 10 分钟死亡不超过 2.2 次');
  });

  it('items: carries the missing threat and every answer item', () => {
    const g = goalOf(unparsed, 4, 'items.answer_missing');
    expect(g).toMatchObject({ kind: 'answer_item', tag: 'magic', role_kind: 'core' });
    expect(g.items).toContain('black_king_bar');
  });
});

describe('evaluateGoal on a later game', () => {
  it('deaths: met or missed by the per-10-minute rate, with the numbers', () => {
    const r = evaluateGoal({ kind: 'deaths_per10_max', max: 2.2, label: {} as any }, other, 0);
    const p = other.players[0];
    const rate = Math.round((p.kda[1] / (other.match.duration / 60)) * 100) / 10;
    expect(r.result).toBe(rate <= 2.2 ? 'met' : 'missed');
    expect(r.evidence.en).toContain(`${p.kda[1]} deaths`);
  });

  it('a role goal does not count when you played the other role', () => {
    const support = other.reviews.find((rv: any) => rv.role.kind === 'support')!;
    expect(evaluateGoal({ kind: 'bench_min', key: 'gold_per_min', min: 0.4, role_kind: 'core', label: {} as any }, other, support.slot).result).toBe('no_opportunity');
  });

  it('items: no_opportunity when the enemy never brought the threat; met only with an answer in the final build', () => {
    const goal = { kind: 'answer_item', tag: 'magic', items: ['black_king_bar'], role_kind: undefined, label: {} as any };
    const slot = other.reviews.findIndex((rv: any) => rv.threats.some((x: any) => x.tag === 'magic'));
    expect(slot).toBeGreaterThanOrEqual(0);
    const has = other.players[slot].items.some((i: any) => i.key === 'black_king_bar');
    expect(evaluateGoal(goal, other, slot).result).toBe(has ? 'met' : 'missed');
    const none = other.reviews.findIndex((rv: any) => !rv.threats.some((x: any) => x.tag === 'evasion'));
    expect(evaluateGoal({ ...goal, tag: 'evasion' }, other, none).result).toBe('no_opportunity');
  });

  it('checks threat presence on the full enemy profile, not the 4-item display shortlist', () => {
    const r = structuredClone(other);
    const rv = r.reviews[0];
    rv.threats = []; // shortlist missed it
    rv.threat_tags = ['evasion'];
    const goal = { kind: 'answer_item', tag: 'evasion', items: ['monkey_king_bar'], label: {} as any };
    expect(evaluateGoal(goal, r, 0).result).toBe('missed');
    expect(other.reviews[0].threat_tags.length).toBeGreaterThanOrEqual(other.reviews[0].threats.length);
  });

  it('does not count an answer the evaluated game\'s patch retired (7.42 Bloodthorn vs evasion)', () => {
    const r = structuredClone(other);
    r.reviews[0].threat_tags = ['evasion'];
    r.players[0].items = [{ key: 'bloodthorn', en: 'Bloodthorn', zh: '血棘', cost: 0, img: null }];
    const goal = { kind: 'answer_item', tag: 'evasion', items: ['monkey_king_bar', 'bloodthorn'], label: {} as any };
    r.match.patch = '7.42';
    expect(evaluateGoal(goal, r, 0).result).toBe('missed');
    r.match.patch = '7.41';
    expect(evaluateGoal(goal, r, 0).result).toBe('met');
    r.match.patch = null;
    expect(evaluateGoal(goal, r, 0).result).toBe('missed');
  });

  it('does not count BKB against disables when this game has a BKB-piercing ultimate', () => {
    const r = structuredClone(other);
    const me = r.players[0];
    r.reviews[0].threat_tags = ['disable'];
    me.items = [{ key: 'black_king_bar', en: 'Black King Bar', zh: '黑皇杖', cost: 0, img: null }];
    const goal = { kind: 'answer_item', tag: 'disable', items: ['black_king_bar', 'sphere'], label: {} as any };
    const enemy = r.players.find((p: any) => p.radiant !== me.radiant);
    enemy.hero = { ...enemy.hero, slug: 'antimage' };
    expect(evaluateGoal(goal, r, 0).result).toBe('met');
    enemy.hero = { ...enemy.hero, slug: 'faceless_void' };
    expect(evaluateGoal(goal, r, 0).result).toBe('missed');
    me.items.push({ key: 'sphere', en: "Linken's Sphere", zh: '林肯法球', cost: 0, img: null });
    expect(evaluateGoal(goal, r, 0).result).toBe('met');
  });

  it('never guesses: wards and lanes need a parse', () => {
    expect(evaluateGoal({ kind: 'obs_per10_min', min: 2, label: {} as any }, unparsed, 1).result).toBe('unknown');
    expect(evaluateGoal({ kind: 'lane_not_lost', label: {} as any }, unparsed, 3).result).toBe('unknown');
    const lane = parsed.reviews[3].chapters.laning;
    expect(evaluateGoal({ kind: 'lane_not_lost', label: {} as any }, parsed, 3).result).toBe(['lost', 'stomped'].includes(lane.outcome) ? 'missed' : 'met');
  });

  it('unknown seat or goal is unknown, not a pass', () => {
    expect(evaluateGoal({ kind: 'deaths_per10_max', max: 9, label: {} as any }, other, 42).result).toBe('unknown');
    expect(evaluateGoal({ kind: 'nope', label: {} as any } as any, other, 0).result).toBe('unknown');
  });
});
