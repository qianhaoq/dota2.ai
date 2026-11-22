import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { heroAbilities, KNOWLEDGE_TOOLS, proItemChoices } from '../../lib/agent/knowledgeTools.js';
import { deepReviewProvider } from '../../lib/agent/providers.js';

const trace = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());

describe('knowledge tools', () => {
  it('hero_abilities: Valve\'s flags, in the reader\'s language, with the patch', () => {
    const r: any = heroAbilities(trace, { hero: 'Beastmaster' }, { lang: 'zh' });
    expect(r).toMatchObject({ hero: 'beastmaster', patch: expect.any(String), source: expect.any(String) });
    expect(r.abilities.find((a: any) => a.ultimate)).toMatchObject({ ability: 'beastmaster_primal_roar', name: '原始咆哮', damage_type: 'magical', goes_through_spell_immunity: true, cooldown_by_level: [90, 75, 60] });
    // A flag Valve does not give is left out, not reported as false.
    expect(r.abilities.find((a: any) => a.ability === 'beastmaster_summon_raptor')).not.toHaveProperty('goes_through_spell_immunity');
    expect((heroAbilities(trace, { hero: 'beastmaster' }, {}) as any).abilities.at(-1).name).toBe('Primal Roar');
    expect(heroAbilities(trace, { hero: 'nobody' })).toEqual({ error: 'unknown_hero' });
  });

  it('pro_item_choices: what pros build, next to when the player held it', () => {
    const r: any = proItemChoices(trace, { hero: 'beastmaster' }, { lang: 'zh' });
    const item = (k: string) => r.mid_game_items.items.find((i: any) => i.item === k);
    expect(r.mid_game_items.pro_games).toBeGreaterThan(100);
    expect(item('blink')).toMatchObject({ name: '闪烁匕首', player_first_held: null });
    expect(item('blink').share_of_pro_games).toBeGreaterThan(item('black_king_bar').share_of_pro_games);
    expect(item('ultimate_scepter').player_first_held).toBe('16:48');
    // Only this match's enemies, each with its sample size.
    const enemies = new Set(trace.heroes.filter((h: any) => h.team === 2).map((h: any) => h.key));
    expect(r.built_more_against_these_enemies.length).toBeGreaterThan(0);
    for (const x of r.built_more_against_these_enemies) { expect(enemies.has(x.enemy)).toBe(true); expect(x.pro_games).toBeGreaterThanOrEqual(30); expect(x.share_of_pro_games_against_this_enemy).toBeGreaterThan(x.share_usually); }
    expect(r.built_more_against_these_enemies.find((x: any) => x.item === 'pipe')).toMatchObject({ player_first_held: '29:08' });
    expect(r.note).toContain('not this player\'s rank');
    expect(r.gaps.map((g: any) => g.topic)).toContain('rank_bracket_items');
    expect(proItemChoices(trace, { hero: 'pudge' })).toMatchObject({ error: 'unknown_hero' });
  });

  it('registers both with a required hero', () => {
    expect(KNOWLEDGE_TOOLS.map((t) => [t.name, t.input_schema.required])).toEqual([['hero_abilities', ['hero']], ['pro_item_choices', ['hero']]]);
  });
});

describe('deepReviewProvider', () => {
  it('DeepSeek 4.1 Flash with thinking on by default', () => {
    expect(deepReviewProvider('deepseek', { DEEPSEEK_API_KEY: 'k' })).toEqual({ ok: true, provider: 'deepseek', baseURL: 'https://api.deepseek.com', apiKey: 'k', model: 'deepseek-flash', thinking: 'enabled', extraBody: { thinking: { type: 'enabled' } } });
    // The server's own switch does not turn the review's thinking off; its own does.
    expect(deepReviewProvider('deepseek', { DEEPSEEK_API_KEY: 'k', DEEPSEEK_THINKING: 'disabled' })).toMatchObject({ thinking: 'enabled' });
    expect(deepReviewProvider('deepseek', { DEEPSEEK_API_KEY: 'k', DEEP_REVIEW_THINKING: 'disabled' })).toMatchObject({ thinking: 'disabled', extraBody: { thinking: { type: 'disabled' } } });
  });
  it('GLM 5.3 Flash on Zhipu\'s endpoint', () => {
    expect(deepReviewProvider('glm', { GLM_API_KEY: 'g' })).toMatchObject({ ok: true, provider: 'glm', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3-flash', thinking: 'enabled' });
    expect(deepReviewProvider('glm', { GLM_API_KEY: 'g', GLM_MODEL: 'glm-5.3' })).toMatchObject({ model: 'glm-5.3' });
    expect(deepReviewProvider('glm', { GLM_API_KEY: 'g', GLM_MODEL: 'not a model name' })).toMatchObject({ model: 'glm-5.3-flash' });
  });
  it('says which key is missing, and rejects unknown providers', () => {
    expect(deepReviewProvider('deepseek', {})).toEqual({ ok: false, error: 'missing_key', needs: 'DEEPSEEK_API_KEY' });
    expect(deepReviewProvider('glm', {})).toEqual({ ok: false, error: 'missing_key', needs: 'GLM_API_KEY' });
    expect(deepReviewProvider('other', {})).toEqual({ ok: false, error: 'unknown_provider' });
  });
});
