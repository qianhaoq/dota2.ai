import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCoachReport } from '../../lib/coach/analyze.js';
import {
  deathsAroundSpikes, isSpikeItem, powerSpikes, slotOfHero, spikeStateAt,
} from '../../lib/coach/spikes.js';

const load = (name: string) => JSON.parse(readFileSync(path.join(process.cwd(), 'src/fixtures/coach', name), 'utf8'));
const parsed = load('match9091400302.parsed.json');
const URSA = 5; // slot of Ursa (hero 70) in 9091400302

describe('isSpikeItem', () => {
  it('keeps finished key items and drops components, recipes and cheap items', () => {
    expect(isSpikeItem('blink')).toBe(true); // bought outright, but a listed key item
    expect(isSpikeItem('bfury')).toBe(true); // built, 2000+
    expect(isSpikeItem('abyssal_blade')).toBe(true);
    expect(isSpikeItem('demon_edge')).toBe(false); // 2200 but a component
    expect(isSpikeItem('mithril_hammer')).toBe(false);
    expect(isSpikeItem('recipe_sphere')).toBe(false);
    expect(isSpikeItem('magic_wand')).toBe(false); // built, but under 2000
    expect(isSpikeItem('not_an_item')).toBe(false);
  });
});

describe('powerSpikes — 9091400302 (real OpenDota parse)', () => {
  const spikes = powerSpikes(parsed);

  it("lists Ursa's finished key items in order, once each", () => {
    const keys = spikes[URSA]!.items.map((x) => x.key);
    expect(keys.slice(0, 4)).toEqual(['bfury', 'blink', 'aghanims_shard', 'basher']);
    expect(spikes[URSA]!.items[1].time).toBe(1016);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain('demon_edge');
  });

  it('records the Aegis pickup only — never how long it was held', () => {
    // Picked up at 30:57. The next logged death (35:02, 601 gold lost, 95 s
    // dead) is a real death, so the Aegis revival is not in the logs and
    // possession at any later moment is unknown.
    expect(spikes[URSA]!.aegis).toEqual([{ time: 1857 }]);
    expect(spikeStateAt(spikes, URSA, 1900)).toEqual({ items: expect.any(Array), latest: { key: 'ultimate_scepter', time: 1652 } });
    expect(spikeStateAt(spikes, URSA, 1000)!.latest!.key).toBe('bfury');
  });

  it('anchors deaths on the first gap closer, not the first item', () => {
    const a = deathsAroundSpikes(spikes, URSA, [368, 492, 1100, 1200, 1900, 2500])!;
    expect(a.anchor).toEqual({ key: 'blink', time: 1016 });
    expect(a.initiation).toBe(true);
    expect([a.before, a.after]).toEqual([2, 4]);
    expect(a).not.toHaveProperty('with_aegis');
  });

  it('finds a hero by id', () => {
    expect(slotOfHero(parsed, 70)).toBe(URSA);
    expect(slotOfHero(parsed, 99999)).toBeNull();
  });
});

describe('powerSpikes — missing or partial data stays unknown', () => {
  it('is null for a player without a purchase log, and has no Aegis without the objective', () => {
    const m = structuredClone(parsed);
    delete m.players[0].purchase_log;
    m.objectives = [];
    const s = powerSpikes(m);
    expect(s[0]).toBeNull();
    expect(s[URSA]!.aegis).toEqual([]);
    expect(spikeStateAt(s, 0, 1000)).toBeNull();
    expect(deathsAroundSpikes(s, 0, [100])).toBeNull();
  });

  it('reads player_slot when slot is missing', () => {
    const m = structuredClone(parsed);
    m.objectives = [{ time: 1857, type: 'CHAT_MESSAGE_AEGIS', player_slot: 128 }];
    expect(powerSpikes(m)[URSA]!.aegis).toEqual([{ time: 1857 }]);
  });
});

describe('report: advice anchored to the killer\'s timeline', () => {
  const r = buildCoachReport(parsed) as any;

  it('ships per-slot spikes with item names', () => {
    expect(r.spikes).toHaveLength(10);
    expect(r.spikes[URSA].items[1]).toEqual({ time: 1016, item: expect.objectContaining({ key: 'blink', zh: '闪烁匕首' }) });
  });

  it('turns the generic minimap rule into the killer\'s Blink timing for Tidehunter', () => {
    const f = r.reviews[0].findings.find((x: any) => x.id === 'deaths.high');
    expect(f.action.zh).toContain('熊战士在 16:56 做出闪烁匕首后，又杀了你 6 次');
    expect(f.action.zh).not.toContain('不朽之守护');
    expect(f.evidence.map((e: any) => `${e.k.zh} ${e.v}`)).toContain('熊战士做出闪烁匕首（16:56）后死于他 6/8');
  });

  it('keeps the general advice when no single killer stands out (Warlock)', () => {
    const f = r.reviews[2].findings.find((x: any) => x.id === 'deaths.high');
    expect(f.action.zh).not.toContain('做出');
    expect(f.action.zh).toContain('小地图上至少能看到 3 个敌人');
  });

  it('marks the killer\'s latest key item on each death row, and never an Aegis state', () => {
    const rows = r.reviews[0].chapters.deaths.rows;
    const at = (sec: number) => rows.find((x: any) => x.time === sec);
    expect(at(1954).killer_item).toEqual({ item: expect.objectContaining({ key: 'ultimate_scepter' }), time: 1652 });
    for (const row of rows) {
      expect(row).toHaveProperty('killer_item');
      expect(row).not.toHaveProperty('killer_aegis');
    }
  });

  it('puts the carrier\'s key items in the "why" evidence, with no Aegis claim', () => {
    const c = r.reviews[0].chapters.story.why.find((x: any) => x.id === 'fights.carrier');
    const ev = c.evidence.map((e: any) => e.zh);
    expect(ev).toContain('熊战士的关键装：狂战斧 14:31、闪烁匕首 16:56、阿哈利姆魔晶 18:57、碎颅锤 23:07、阿哈利姆神杖 27:32');
    expect(ev.some((x: string) => x.includes('不朽之守护'))).toBe(false);
  });

  it('has no spikes for an unparsed match', () => {
    const u = buildCoachReport(load('match9091400302.unparsed.json')) as any;
    expect(u.spikes).toBeNull();
  });
});
