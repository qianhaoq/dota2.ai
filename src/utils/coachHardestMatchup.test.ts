import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildCoachReport } from '../../lib/coach/analyze.js';
import { heroVsRank } from '../../lib/coach/matchupsRank.js';
import { itemLifts } from '../../lib/coach/matchups.js';

// The Naga Siren vs Timbersaw case (#204) is about pure damage, not about this week's STRATZ numbers: the pair is
// held clearly unfavoured here, so a data refresh that moves another hero a point lower cannot change the case (#419).
vi.mock('../../lib/coach/matchupsRank.js', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    heroVsRank: (hero: number, vs: number, bracket: string) => (hero === 89 && vs === 98 && bracket === 'di'
      ? { bracket: 'di', n: 215, wr: 0.35, base: 0.495, diff: -0.145, verdict: 'unfavoured' }
      : actual.heroVsRank(hero, vs, bracket)),
  };
});

const load = (f: string) => JSON.parse(readFileSync(new URL(`../fixtures/coach/${f}`, import.meta.url), 'utf8'));
const FIXTURES = ['match9079014980.turbo.unparsed.json', 'match9091400302.unparsed.json', 'match9091400302.parsed.json', 'match9094562824.parsed.json'];
const ID = 'draft.hardest_matchup';

describe('draft.hardest_matchup', () => {
  it('names the clearest disadvantage at your bracket, with a measured or Valve-backed plan, never as the headline', () => {
    let seen = 0;
    for (const f of FIXTURES) {
      const r = buildCoachReport(load(f)) as any;
      for (const v of r.reviews) {
        const fd = v.findings.find((x: any) => x.id === ID);
        if (!fd) continue;
        seen++;
        const me = r.players[v.slot].hero;
        const cands = r.players.filter((p: any) => p.radiant !== r.players[v.slot].radiant)
          .map((p: any) => ({ h: p.hero, m: heroVsRank(me.id, p.hero.id, v.bracket.key) }))
          .filter((x: any) => x.m && x.m.verdict === 'unfavoured' && x.m.diff <= -0.03)
          .sort((a: any, b: any) => a.m.diff - b.m.diff);
        expect(fd.title.en).toBe(`${cands[0].h.en} is your hardest matchup at ${v.bracket.label.en}`);
        expect(fd.evidence[0].k.en).toContain('data: STRATZ');
        // Measured pro items, else the curated threat list, else (uncurated non-Carry heroes only) Valve ability data.
        expect(fd.action.en).toMatch(itemLifts(me.id, cands[0].h.id).length ? /pro .+ build/ : new RegExp(`^(${cands[0].h.en}'s damage is mostly (magic|physical)|More than half of ${cands[0].h.en}'s damaging abilities deal (magic|physical) damage \\(Valve data\\))`));
        expect(v.headline.en).not.toContain('hardest matchup');
        expect(fd.goal).toBeUndefined();
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('Anti-Mage is not sent to magic-answer items here either (Counterspell)', () => {
    const r = buildCoachReport(load('match9079014980.turbo.unparsed.json')) as any;
    const am = r.reviews.find((v: any) => r.players[v.slot].hero.slug === 'antimage');
    for (const f of am.findings) expect(f.action.en).not.toMatch(/Pipe of Insight|Eternal Shroud|Mage Slayer/);
  });

  it('no medal in the match: no finding (never a guessed bracket)', () => {
    const m = load('match9079014980.turbo.unparsed.json');
    for (const p of m.players) p.rank_tier = null;
    const r = buildCoachReport(m) as any;
    for (const v of r.reviews) expect(v.findings.map((x: any) => x.id)).not.toContain(ID);
  });
});

describe('draft.hardest_matchup — pure damage (review #204)', () => {
  it('Naga Siren vs Timbersaw (3 pure, 1 magic abilities): never "mostly magic", never magic items', () => {
    const m = load('match9079014980.turbo.unparsed.json');
    const radiant = m.players.filter((p: any) => p.player_slot < 128);
    const dire = m.players.filter((p: any) => p.player_slot >= 128);
    radiant[0].hero_id = 89; // Naga Siren
    dire[0].hero_id = 98; // Timbersaw
    for (const p of m.players) p.rank_tier = 80; // Divine–Immortal
    const r = buildCoachReport(m) as any;
    const naga = r.reviews.find((v: any) => r.players[v.slot].hero.id === 89);
    // Timbersaw is the clearest disadvantage (the case Codex found)…
    const worst = r.players.filter((p: any) => !p.radiant)
      .map((p: any) => ({ id: p.hero.id, m: heroVsRank(89, p.hero.id, 'di') }))
      .filter((x: any) => x.m && x.m.verdict === 'unfavoured' && x.m.diff <= -0.03)
      .sort((a: any, b: any) => a.m.diff - b.m.diff)[0];
    expect(worst.id).toBe(98);
    // …with no pro item data, so only the Valve fallback could speak, and pure damage has no majority type.
    expect(itemLifts(89, 98)).toEqual([]);
    expect(naga.findings.map((x: any) => x.id)).not.toContain(ID);
    for (const f of naga.findings) expect(f.action.en).not.toMatch(/Timbersaw's damaging abilities deal magic/);
  });
});

describe('draft.hardest_matchup — right-click carries (review #204)', () => {
  it('Bloodseeker vs Chaos Knight: curated physical, never magic-resistance items', () => {
    const m = load('match9079014980.turbo.unparsed.json');
    m.players.filter((p: any) => p.player_slot < 128)[0].hero_id = 4; // Bloodseeker
    m.players.filter((p: any) => p.player_slot >= 128)[0].hero_id = 81; // Chaos Knight
    for (const p of m.players) p.rank_tier = 80;
    const r = buildCoachReport(m) as any;
    const bs = r.reviews.find((v: any) => r.players[v.slot].hero.id === 4);
    for (const f of bs.findings) {
      expect(f.action.en).not.toMatch(/Pipe of Insight|Eternal Shroud|Mage Slayer/);
      expect(f.action.en).not.toMatch(/Chaos Knight's damaging abilities deal magic/);
    }
  });

  it('every Valve-based plan in the fixtures is for a hero the threat list does not know, and never a Carry', () => {
    const NAMES = JSON.parse(readFileSync(new URL('../../lib/coach/data/names.json', import.meta.url), 'utf8'));
    for (const f of FIXTURES) {
      const r = buildCoachReport(load(f)) as any;
      for (const v of r.reviews) {
        const fd = v.findings.find((x: any) => x.id === ID);
        if (!fd || !/Valve data/.test(fd.action.en)) continue;
        const vs = r.players.find((p: any) => fd.title.en.startsWith(p.hero.en)).hero;
        expect(NAMES.heroes[vs.id].roles).not.toContain('Carry');
      }
    }
  });
});
