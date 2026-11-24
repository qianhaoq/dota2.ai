import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { HEROES_BY_KEY, STATIC_HEROES, heroByKey } from '../../packages/review-engine/src/staticHeroes.js';
import { heroAbilities, laneReport, lineupTiming, proItemChoices } from '../../lib/agent/knowledgeTools.js';
import { buildCheck, powerSpikes } from '../../lib/agent/situationTools.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { reviewToolkit } from '../../lib/agent/deepReview.js';
import { createAgentService } from '../../lib/agent/service.js';
import { deathContext } from '../../packages/review-engine/src/trace/index.js';

const fixture = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());
const scoreboard = JSON.parse(readFileSync(new URL('../fixtures/agent/match9100904020.scoreboard.json', import.meta.url), 'utf8'));
/**
 * The fixture game with Mirana's seat renamed the way a replay names Queen of Pain: by her entity class,
 * "queen_of_pain", where the internal slug is "queenofpain". Everything else about the seat is Mirana's.
 */
function withQueenOfPain() {
  const t = JSON.parse(JSON.stringify(fixture));
  const seat = t.heroes.find((h: any) => h.key === 'mirana');
  t.names[t.names.indexOf(seat.npc)] = 'npc_dota_hero_queen_of_pain';
  seat.key = 'queen_of_pain'; seat.npc = 'npc_dota_hero_queen_of_pain';
  const qop = Object.values(STATIC_HEROES as Record<string, any>).find((h) => h.internalSlug === 'queenofpain');
  const mirana = Object.values(STATIC_HEROES as Record<string, any>).find((h) => h.internalSlug === 'mirana');
  const match = { ...scoreboard, players: scoreboard.players.map((p: any) => (p.hero_id === mirana.id ? { ...p, hero_id: qop.id } : p)) };
  return { trace: t, match, qop };
}

describe('a hero is found by the key a replay uses for it', () => {
  it('the internal slug, the replay\'s split form of it, the internal name and the English name all mean the hero', () => {
    const qop = heroByKey('queenofpain');
    expect(qop).toMatchObject({ internalSlug: 'queenofpain', nameEn: 'Queen of Pain' });
    for (const key of ['queen_of_pain', 'npc_dota_hero_queenofpain', 'Queen of Pain']) expect(heroByKey(key)).toBe(qop);
    expect(heroByKey('anti_mage')?.internalSlug).toBe('antimage');
    expect(heroByKey('vengeful_spirit')?.internalSlug).toBe('vengefulspirit');
    expect(heroByKey('zeus')?.internalSlug).toBe('zuus');
    // An exact slug is never re-read as something else, and no two heroes collapse into one key.
    for (const h of Object.values(STATIC_HEROES as Record<string, any>)) expect(heroByKey(h.internalSlug)).toBe(h);
    const squashed = Object.values(STATIC_HEROES as Record<string, any>).map((h) => h.internalSlug.replace(/_/g, ''));
    expect(new Set(squashed).size).toBe(squashed.length);
    for (const none of ['nobody', '', null, undefined, 42]) expect(heroByKey(none as any)).toBeNull();
    expect(HEROES_BY_KEY.has('queen_of_pain')).toBe(true);
    expect(HEROES_BY_KEY.get('nobody')).toBeUndefined();
  });

  it('the review names her, and every knowledge tool answers for her under the replay\'s key', () => {
    const { trace, match, qop } = withQueenOfPain();
    const kit: any = reviewToolkit({ trace, hero: 'queen_of_pain', lang: 'zh', match });
    expect(kit.context.hero_names.queen_of_pain).toBe('痛苦女王');
    expect(kit.context.scoreboard).toMatchObject({ kills: expect.any(Number) });
    const abilities: any = heroAbilities(trace, { hero: 'queen_of_pain' }, { lang: 'zh' });
    expect(abilities).toMatchObject({ ref: 'abilities:queen_of_pain', hero: 'queen_of_pain' });
    expect(abilities.abilities.find((a: any) => a.ultimate).ability).toBe('queenofpain_sonic_wave');
    expect(proItemChoices(trace, { hero: 'queen_of_pain' }, { lang: 'zh' })).toMatchObject({ ref: 'pro_items:queen_of_pain', mid_game_items: { pro_games: expect.any(Number) } });
    expect(buildCheck(trace, { hero: 'queen_of_pain' }, { lang: 'zh', match })).toMatchObject({ ref: 'build:queen_of_pain', most_built_by_pros_on_this_hero: { pro_games: expect.any(Number) } });
    const spikes: any = powerSpikes(trace, { hero: 'beastmaster' }, { lang: 'zh', match });
    expect(spikes.enemies.find((e: any) => e.enemy === 'queen_of_pain')).toHaveProperty('my_hero_against_them_in_pro_games');
    expect((powerSpikes(trace, { hero: 'queen_of_pain' }, { lang: 'zh', match }) as any).me.ultimate).toMatchObject({ ability: 'queenofpain_sonic_wave', name: '超声冲击波' });
    const timing: any = lineupTiming(trace, {}, { perspective: 'beastmaster', match });
    expect([...timing.my_team.heroes, ...timing.enemy.heroes].find((h: any) => h.hero === 'queen_of_pain').games).toBeGreaterThan(0);
    // The lane's rows are keyed by the replay's key, not by the internal slug the match data implies.
    const lane: any = laneReport(trace, { hero: 'queen_of_pain' }, { match });
    expect(lane.ref).toBe('lane:queen_of_pain');
    expect(JSON.stringify(lane)).not.toContain('queenofpain"');
    // Refs made under that key resolve under it, with her name for the reader.
    for (const ref of ['abilities:queen_of_pain', 'build:queen_of_pain', 'spikes:queen_of_pain']) expect(resolveRef(trace, ref, { hero: 'queen_of_pain', lang: 'zh', match })).toMatchObject({ ref, names: { queen_of_pain: '痛苦女王' } });
    expect(qop.id).toBeGreaterThan(0);
  });

  it('the hero picker lists her by name with her id, and her own abilities count as hers', async () => {
    const { trace, qop } = withQueenOfPain();
    const service: any = createAgentService({ traces: { get: async () => trace }, complete: null });
    const listed = (await service.availability(9100904020)).heroes.find((h: any) => h.hero === 'queen_of_pain');
    expect(listed).toMatchObject({ hero: 'queen_of_pain', hero_id: qop.id, en: 'Queen of Pain', zh: '痛苦女王' });
    // "Ready and not cast" keeps only the hero's own abilities: hers are named queenofpain_…, not queen_of_pain_….
    const t = JSON.parse(JSON.stringify(trace));
    const h = t.heroes.findIndex((x: any) => x.key === 'queen_of_pain');
    const own = Object.keys(t.abilities[h]).filter((k) => k.startsWith('mirana_'));
    for (const k of own) { t.abilities[h][k.replace(/^mirana_/, 'queenofpain_')] = t.abilities[h][k]; delete t.abilities[h][k]; }
    t.names = t.names.map((n: string) => (n.startsWith('mirana_') ? n.replace(/^mirana_/, 'queenofpain_') : n));
    const deaths: any = deathContext(t, { hero: 'queen_of_pain' });
    const listedUnused = deaths.most_left_unused.flatMap((r: any) => r.ready_not_cast ?? []);
    const before: any = deathContext(fixture, { hero: 'mirana' });
    expect(listedUnused).toEqual(before.most_left_unused.flatMap((r: any) => r.ready_not_cast ?? []).map((k: string) => k.replace(/^mirana_/, 'queenofpain_')));
  });
});
