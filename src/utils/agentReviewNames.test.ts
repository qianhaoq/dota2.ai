import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { attackOf, buildCheck } from '../../lib/agent/situationTools.js';
import { reviewToolkit, verifyReview } from '../../lib/agent/deepReview.js';
import { withHeroNames } from '../../lib/agent/review/toolkit.js';
import { unnamedHeroes } from '../../lib/agent/review/verify.js';
import { ANSWERS } from '../../lib/coach/knowledge.js';
import { patchForGame } from '../../lib/agent/patchData.js';

const trace = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());
const match = JSON.parse(readFileSync(new URL('../fixtures/agent/match9100904020.scoreboard.json', import.meta.url), 'utf8'));
const ABILITIES = JSON.parse(readFileSync(new URL('../../lib/coach/data/abilities.json', import.meta.url), 'utf8'));

// #495: 9091400302's Tidehunter review called Ursa "厄萨" twenty times and never "熊战士", counted Ghost Scepter as
// gold against spells, offered nothing but Eul's Scepter against Ursa's attacks, and named Dead in the Water "that
// single-target skill".
describe('the names a tool answer carries', () => {
  const names = { ursa: '熊战士', tidehunter: '潮汐猎人', weaver: '编织者' };

  it('names each hero the answer speaks of, as a value or as a key, and only those', () => {
    const r = withHeroNames({ tool: 'build_check', killed_by: { ursa: 8 }, by_enemy: [{ enemy: 'weaver' }] }, names, 'zh') as any;
    expect(r.hero_names).toEqual({ ursa: '熊战士', weaver: '编织者' });
  });

  it('names an ability from Aghanim\'s Shard or an innate one, from Valve\'s data', () => {
    expect(ABILITIES.granted.tidehunter_dead_in_the_water).toMatchObject({ en: 'Dead in the Water', zh: '重如铁锚', by: 'shard' });
    const r = withHeroNames({ tool: 'ability_audit', ability: 'tidehunter_dead_in_the_water', by_target: { ursa: 4 } }, names, 'zh') as any;
    expect(r.ability_names).toEqual({ tidehunter_dead_in_the_water: '重如铁锚' });
    expect((withHeroNames({ ability: 'tidehunter_dead_in_the_water' }, names, 'en') as any).ability_names).toEqual({ tidehunter_dead_in_the_water: 'Dead in the Water' });
  });

  it('leaves an answer that names no hero and no ability as it is', () => {
    const plain = { tool: 'match_overview', duration: '45:22' };
    expect(withHeroNames(plain, names, 'zh')).toBe(plain);
    expect(withHeroNames(null, names, 'zh')).toBeNull();
  });

  it('every review tool answer comes with the names of the heroes in it', async () => {
    const kit = reviewToolkit({ trace, hero: 'beastmaster', lang: 'zh', match })!;
    const r: any = await kit.runTool('build_check', { hero: 'beastmaster' });
    expect(r.hero_names.phantom_assassin).toBe(kit.context.hero_names.phantom_assassin);
    expect(Object.keys(r.hero_names).every((k) => kit.context.hero_names[k] === r.hero_names[k])).toBe(true);
  });
});

describe('a review that never names the hero who killed the player most', () => {
  const ctx = { player_hero: 'tidehunter', hero_names: { tidehunter: '潮汐猎人', ursa: '熊战士', weaver: '编织者', warlock: '术士' } };
  const tools = [{ tool: 'build_check', hero: 'tidehunter', killed_by: { ursa: 8, weaver: 2 } }, { tool: 'death_context', hero: 'warlock', killed_by: { weaver: 5 } }];

  it('is asked about the name it never used', () => {
    expect(unnamedHeroes({ verdict: '杀死你 8 次的厄萨只靠普攻。' }, [ctx, ...tools], ctx)).toEqual(['熊战士 (ursa)']);
  });

  it('is not asked when the name, or the key the site names for it, is there', () => {
    expect(unnamedHeroes({ verdict: '杀死你 8 次的熊战士只靠普攻。' }, [ctx, ...tools], ctx)).toEqual([]);
    expect(unnamedHeroes({ verdict: '杀死你 8 次的 ursa 只靠普攻。' }, [ctx, ...tools], ctx)).toEqual([]);
  });

  it('nor about a hero who killed the player less than 3 times, or killed somebody else', () => {
    // Weaver: 2 of the player's deaths; the 5 are Warlock's.
    expect(unnamedHeroes({ verdict: '熊战士' }, [ctx, ...tools], ctx)).toEqual([]);
    // Without the names, or without a killed_by, there is nothing to ask.
    expect(unnamedHeroes({ verdict: '厄萨' }, tools, {})).toEqual([]);
    expect(unnamedHeroes({ verdict: '厄萨' }, [ctx, { hero: 'tidehunter', by_target: { ursa: 9 } }], ctx)).toEqual([]);
  });

  it('verifyReview puts it to the model once, and drops nothing for it', () => {
    const check = verifyReview({ verdict: '杀死你多次的厄萨只靠普攻。' }, [ctx, ...tools]);
    expect(check.problems).toContainEqual({ where: 'whole_review', index: 0, kind: 'unnamed', text: '熊战士 (ursa)', soft: true });
  });
});

describe('a story link telling of a time outside its stretch', () => {
  it('is asked about once; a cause from earlier (because) is not', () => {
    const story = [{ phase: '41:19–45:22，收尾', what_changed: '35:00 你们是少死人的一边，却一座建筑都没换到。', because: '31:00 的肉山之后对面一直压着。', whose: 'team', evidence: [] }];
    const check = verifyReview({ story }, [{ times: ['41:19', '45:22', '35:00', '31:00'] }]);
    const phase = check.problems.filter((p) => p.kind === 'phase');
    expect(phase).toEqual([{ where: 'story', index: 0, kind: 'phase', text: '35:00 (outside 41:19–45:22)', soft: true }]);
  });
});

describe('build_check: the shop\'s items that act on the damage that killed the player', () => {
  const r: any = buildCheck(trace, { hero: 'beastmaster' }, { lang: 'zh', match });
  const pd = patchForGame(trace.match_id, match);
  const [pa, necro] = r.answers_to_top_killers;

  it('against an attacker: what disarms, pushes, turns ethereal, blocks or returns attacks — whatever the role, cheapest first', () => {
    expect(pa.killer).toBe('phantom_assassin');
    expect(pa.items_acting_on_their_damage.against_their).toBe('attacks');
    const by = Object.fromEntries(pa.items_acting_on_their_damage.items.map((i: any) => [i.item, i]));
    expect(by.heavens_halberd.how).toContain('disarms_target');
    expect(by.force_staff.how).toContain('moves_a_unit');
    expect(by.ghost.how).toContain('physical_immunity');
    expect(by.blade_mail.how).toContain('returns_attack_damage');
    const costs = pa.items_acting_on_their_damage.items.map((i: any) => i.cost);
    expect(costs).toEqual([...costs].sort((a: number, b: number) => a - b));
    // Each with this patch's price and Valve's text, as every other item build_check lists.
    expect(by.heavens_halberd.cost).toBe(pd.items.heavens_halberd.cost);
    expect(by.heavens_halberd.does[0].valve_text).toContain('Prevents a target from attacking');
  });

  it('against a caster: spell immunity, magic barriers, magic resistance — and never Ghost Scepter', () => {
    expect(necro.items_acting_on_their_damage.against_their).toBe('abilities');
    const by = Object.fromEntries(necro.items_acting_on_their_damage.items.map((i: any) => [i.item, i]));
    expect(by.black_king_bar.how).toContain('spell_immunity');
    expect(by.ghost).toBeUndefined();
  });

  it('Ghost Scepter is no answer to spells: Valve says it makes magic damage hurt more', () => {
    expect(pd.items.ghost.abilities[0].description).toMatch(/more vulnerable to magic damage/);
    expect([...ANSWERS.magic.core, ...ANSWERS.magic.support]).not.toContain('ghost');
    expect([...ANSWERS.physical.core, ...ANSWERS.physical.support]).toContain('ghost');
  });
});

// Owner, 2026-11-28: no fixed pick; the tools give how each item meets this enemy's kit — Blink starts the fight, Heaven's
// Halberd disarms the melee attacker, Eul's Scepter on him dispels his buff — and the model weighs them in the game.
describe('build_check: how each item meets the enemy who killed the player', () => {
  const r: any = buildCheck(trace, { hero: 'beastmaster' }, { lang: 'en', match });
  const [pa, necro] = r.answers_to_top_killers;
  const items = JSON.parse(readFileSync(new URL('../../lib/data/constants/items.json', import.meta.url), 'utf8'));
  const by = (k: any) => Object.fromEntries(k.items_acting_on_their_damage.items.map((i: any) => [i.item, i]));

  it('how the enemy attacks, how each of their abilities is cast, and the big items they held with when', () => {
    const heroes = JSON.parse(readFileSync(new URL('../../lib/data/constants/heroes.json', import.meta.url), 'utf8'));
    expect(pa.their_attack).toEqual({ type: 'melee', range: heroes['44'].attack_range });
    expect(necro.their_attack.type).toBe('ranged');
    expect(pa.their_abilities.find((a: any) => a.ability === 'phantom_assassin_phantom_strike')).toMatchObject({ cast: 'Unit Target', dispelled_by: 'basic' });
    expect(pa.their_big_items.find((i: any) => i.item === 'black_king_bar')).toEqual({ item: 'black_king_bar', name: 'Black King Bar', first_held: '21:29' });
    const ts = pa.their_big_items.map((i: any) => i.first_held.split(':').reduce((m: number, s: string) => m * 60 + Number(s), 0));
    expect(ts).toEqual([...ts].sort((a: number, b: number) => a - b));
  });

  it('a dispel says on whom it lands, and which of the enemy\'s abilities Valve marks removable by it', () => {
    const a = by(pa);
    // Eul's: cast on an enemy (Valve: "can only be cast on enemy units or yourself"), a basic dispel.
    expect(a.cyclone).toMatchObject({ applies_dispel: 'basic', dispel_lands_on: 'an_enemy_target' });
    expect(a.cyclone.their_abilities_marked_removable_by_it).toEqual(pa.their_abilities.filter((x: any) => x.dispelled_by === 'basic').map((x: any) => x.name));
    expect(a.nullifier.dispel_lands_on).toBe('an_enemy_target');
    // Black King Bar's dispel is on the player, never on the enemy.
    expect(a.black_king_bar).toMatchObject({ applies_dispel: 'basic', dispel_lands_on: 'self_or_allies' });
    expect(a.aeon_disk).toMatchObject({ applies_dispel: 'strong', dispel_lands_on: 'self_or_allies' });
    // Halberd: Valve's disarm durations for this patch.
    const pd = patchForGame(trace.match_id, match);
    const disarm = pd.items.heavens_halberd.attrib.find((x: any) => x.key === 'disarm_melee');
    expect(a.heavens_halberd.disarm_seconds.melee).toBe(Number(disarm.value));
    // No dispel, no dispel fields: nothing is said that the data does not hold.
    expect(a.force_staff).not.toHaveProperty('applies_dispel');
    expect(items.force_staff.abilities.some((x: any) => /dispel/i.test(x.description))).toBe(false);
  });

  it('a hero the constants do not hold, or hold without an attack type, has no attack: unknown, not a guess', () => {
    expect(attackOf(44)).toMatchObject({ type: 'melee' });
    expect(attackOf(99999)).toBeNull();
    expect(attackOf(null)).toBeNull();
    expect(attackOf(44, { 44: { attack_range: 150 } })).toBeNull();
    expect(attackOf(44, { 44: { attack_type: 'Melee' } })).toEqual({ type: 'melee' });
  });
});
