import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildCoachReport as buildRaw } from '../../lib/coach/analyze.js';
import { heroTags, BUILT_IN_MAGIC_RESIST, THREAT_TAGS } from '../../lib/coach/knowledge.js';
import type { CoachReport } from '../coach/types';

// https://dota2.ai/r/9079014980 — an unparsed Turbo game, Anti-Mage won with
// Battle Fury/Manta/Butterfly/Skadi/Satanic/Abyssal and was told the biggest
// lever was "no item answer to their magic burst" (Pipe, Eternal Shroud…),
// because the OpenDota "Nuker" role made a Daedalus/Butterfly/MKB Nature's
// Prophet count as magic burst.
const turbo = () => JSON.parse(readFileSync(new URL('../fixtures/coach/match9079014980.turbo.unparsed.json', import.meta.url), 'utf8'));
const unparsed = () => JSON.parse(readFileSync(new URL('../fixtures/coach/match9091400302.unparsed.json', import.meta.url), 'utf8'));
const abilities = JSON.parse(readFileSync(new URL('../../lib/data/constants/abilities.json', import.meta.url), 'utf8'));
const heroes = JSON.parse(readFileSync(new URL('../../lib/data/constants/heroes.json', import.meta.url), 'utf8'));
const build = (m: object) => buildRaw(m) as unknown as CoachReport;
const slotOf = (r: CoachReport, slug: string) => r.players.find((p) => p.hero.slug === slug)!.slot;
const ids = (r: CoachReport, slot: number) => r.reviews[slot].findings.map((f) => f.id);
const roles = (slug: string) => (Object.values(heroes) as { name: string; roles: string[] }[]).find((h) => h.name === `npc_dota_hero_${slug}`)!.roles;

describe('role fallback: a Carry that is also a "Nuker" is not called magic burst', () => {
  it('Nature\'s Prophet (Carry, Pusher, Escape, Nuker) guesses physical only', () => {
    expect(roles('furion')).toEqual(expect.arrayContaining(['Carry', 'Nuker']));
    expect([...heroTags('furion', roles('furion'))]).toEqual(['physical']);
  });
  it('a Nuker that is not a Carry still guesses magic (Hoodwink)', () => {
    expect(roles('hoodwink')).not.toContain('Carry');
    expect([...heroTags('hoodwink', roles('hoodwink'))]).toContain('magic');
  });
  it('curation still wins over roles', () => {
    expect(THREAT_TAGS.magic).toContain('templar_assassin');
    expect([...heroTags('templar_assassin', roles('templar_assassin'))]).toContain('magic');
  });
});

describe('match 9079014980 (Turbo, unparsed)', () => {
  const r = build(turbo());
  const am = slotOf(r, 'antimage');

  it('Anti-Mage is not told to build a magic answer; Nature\'s Prophet is never listed as magic burst', () => {
    expect(ids(r, am)).not.toContain('items.answer_missing');
    expect(r.reviews[am].headline.en).not.toMatch(/magic/i);
    const np = r.players[slotOf(r, 'furion')].hero.id;
    for (const v of r.reviews) {
      const magic = v.threats.find((x) => x.tag === 'magic');
      if (magic) expect(magic.heroes).not.toContain(np);
    }
  });

  it('percentiles name the Turbo population they come from', () => {
    const farm = r.reviews[am].findings.find((f) => f.id === 'farm.strong')!;
    expect(farm.body.en).toContain('of Turbo Anti-Mage games');
    expect(farm.body.zh).toContain('加速模式敌法师对局');
  });

  it('a share of games stays within 1–99% ("more than 100%" was printed for Dawnbreaker)', () => {
    const db = r.reviews[slotOf(r, 'dawnbreaker')].findings.find((f) => f.id === 'deaths.high')!;
    expect(db.body.en).toContain('more than 99% of Turbo Dawnbreaker games');
    for (const v of r.reviews) for (const f of v.findings) expect(`${f.body.en} ${f.body.zh}`).not.toMatch(/100%/);
  });
});

describe('built-in magic resistance', () => {
  it('every listed hero\'s ability passively grants magic resistance per the ability constants', () => {
    for (const [slug, key] of Object.entries(BUILT_IN_MAGIC_RESIST)) {
      expect(key.startsWith(`${slug}_`)).toBe(true);
      expect(abilities[key]?.desc).toMatch(/passively grants magic resistance/i);
    }
  });

  it('Anti-Mage in Spectre\'s place gets no "no answer to their magic burst"; Spectre still does', () => {
    const base = build(unparsed());
    const s = slotOf(base, 'spectre');
    expect(base.reviews[s].findings.find((f) => f.id === 'items.answer_missing')?.goal).toMatchObject({ tag: 'magic' });
    const m = unparsed();
    const p = m.players.find((x: { hero_id: number }) => x.hero_id === base.players[s].hero.id);
    p.hero_id = 1; // Anti-Mage
    const r = build(m);
    const miss = r.reviews[s].findings.find((f) => f.id === 'items.answer_missing');
    expect(miss?.goal).not.toMatchObject({ tag: 'magic' });
  });
});
