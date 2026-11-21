import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildCoachReport } from '../../lib/coach/analyze.js';
import { heroVsRank } from '../../lib/coach/matchupsRank.js';
import { itemLifts } from '../../lib/coach/matchups.js';

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
        expect(fd.action.en).toMatch(itemLifts(me.id, cands[0].h.id).length ? /pro .+ build/ : /\(Valve data\)/);
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
