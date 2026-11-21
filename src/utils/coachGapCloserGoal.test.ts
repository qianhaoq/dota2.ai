import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCoachReport } from '../../lib/coach/analyze.js';
import { evaluateGoal } from '../../lib/coach/goals.js';
import { GAP_CLOSERS } from '../../lib/coach/knowledge.js';

const load = (name: string) => JSON.parse(readFileSync(path.join(process.cwd(), 'src/fixtures/coach', name), 'utf8'));
const r = buildCoachReport(load('match9091400302.parsed.json')) as any;
const later = buildCoachReport(load('match9094562824.parsed.json')) as any;
const finding = (seat: number) => r.reviews[seat].findings.find((f: any) => f.id === 'deaths.high');
const SPECTRE = r.players.findIndex((p: any) => p.hero.id === 67);

describe('deaths.high: the advice follows where the deaths happened', () => {
  it('Tidehunter died to Ursa mostly in fights after his Blink: positioning and timing', () => {
    expect(finding(0).action.zh).toContain('熊战士在 16:56 做出闪烁匕首后，又杀了你 6 次，其中 5 次在团战里：开团前站在队伍后面');
    expect(finding(0).action.zh).not.toContain('不要单独待在没有视野的地方');
  });

  it('Spectre died to Ursa mostly outside fights after his Blink: do not stand alone outside vision', () => {
    expect(finding(SPECTRE).action.zh).toContain('熊战士在 16:56 做出闪烁匕首后，又杀了你 5 次：从这件装备起，他不在小地图上就当他随时能跳到你身边');
  });
});

describe('goal: deaths to enemies who already own a gap closer', () => {
  it('is set when those deaths are a large share, and carries its own item list', () => {
    expect(finding(0).goal).toEqual({
      kind: 'deaths_to_gap_closer_max', max: 3, items: GAP_CLOSERS,
      label: { en: 'At most 3 deaths to enemies who already have a Blink-type item', zh: '被已有跳刀类位移装的敌人击杀不超过 3 次' },
    });
  });

  it('falls back to the per-10-minute goal without replay logs', () => {
    const u = buildCoachReport(load('match9091400302.unparsed.json')) as any;
    const g = u.reviews[0].findings.find((f: any) => f.id === 'deaths.high')?.goal;
    if (g) expect(g.kind).toBe('deaths_per10_max');
  });

  it('judges a later game with any lineup: met, missed, with whose gap closers', () => {
    const g = finding(0).goal;
    const seat0 = evaluateGoal(g, later, 0);
    expect(seat0.result).toBe('missed');
    expect(seat0.evidence.zh).toBe('被已有位移装的敌人击杀 7 次（目标 ≤ 3）；他们的位移装：殁境神蚀者 闪烁匕首 15:58、末日使者 闪烁匕首 20:13、拉比克 闪烁匕首 20:34');
    expect(evaluateGoal(g, later, 1).result).toBe('met');
  });

  it('is no_opportunity when no enemy bought one, and unknown without replay logs', () => {
    const g = finding(0).goal;
    const none = structuredClone(later);
    for (const s of none.spikes) if (s) s.items = s.items.filter((x: any) => !GAP_CLOSERS.includes(x.item.key));
    expect(evaluateGoal(g, none, 0).result).toBe('no_opportunity');
    const unparsed = structuredClone(later);
    unparsed.spikes = null;
    expect(evaluateGoal(g, unparsed, 0).result).toBe('unknown');
  });

  it('uses the item list stored in the goal, not whatever the list is today', () => {
    // Nobody on the later game's enemy team bought Shadow Blade.
    expect(evaluateGoal({ ...finding(0).goal, items: ['invis_sword'] }, later, 0).result).toBe('no_opportunity');
    // Only Outworld Destroyer had a Force Staff (19:10): fewer deaths count than with every gap closer.
    const force = evaluateGoal({ ...finding(0).goal, items: ['force_staff'] }, later, 0);
    expect(force.evidence.zh).toMatch(/^被已有位移装的敌人击杀 [0-6] 次/);
    expect(force.evidence.zh).toContain('殁境神蚀者 原力法杖 19:10');
  });
});

describe('goals.js stays safe for the browser and the packed CLI', () => {
  it('imports only knowledge.js', () => {
    const src = readFileSync(path.join(process.cwd(), 'lib/coach/goals.js'), 'utf8');
    const imports = [...src.matchAll(/^import .* from '(.+)';$/gm)].map((m) => m[1]);
    expect(imports).toEqual(['./knowledge.js']);
    const k = readFileSync(path.join(process.cwd(), 'lib/coach/knowledge.js'), 'utf8');
    expect(k).not.toMatch(/^import /m);
  });
});
