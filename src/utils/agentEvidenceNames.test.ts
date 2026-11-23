import { describe, expect, it } from 'vitest';
import { namesIn, tidyKey } from '../../lib/agent/evidence.js';

describe('names for the engine keys in a record', () => {
  it('states the engine names itself are named in the reader\'s language', () => {
    const keys = ['modifier_bashed', 'modifier_stunned', 'ability_capture', 'dota_fountain'];
    expect(namesIn(keys, 'zh')).toEqual({ modifier_bashed: '重击眩晕', modifier_stunned: '眩晕', ability_capture: '占领', dota_fountain: '泉水' });
    expect(namesIn(keys, 'en')).toEqual({ modifier_bashed: 'Bashed', modifier_stunned: 'Stunned', ability_capture: 'Capture', dota_fountain: 'Fountain' });
  });

  it('a key the data has no name for reads as its own words, never as a made-up name', () => {
    // Not in the ability data: shown in words, the owner's prefix dropped, the same in both languages.
    expect(namesIn(['beastmaster_summon_thunderhide'], 'zh')).toEqual({ beastmaster_summon_thunderhide: 'Summon Thunderhide' });
    expect(namesIn(['modifier_beastmaster_prima_roar_push'], 'en')).toEqual({ modifier_beastmaster_prima_roar_push: 'Prima Roar Push' });
    // What the data does name keeps its name.
    expect(namesIn(['beastmaster_primal_roar', 'item_blink', 'axe'], 'zh')).toEqual({ beastmaster_primal_roar: '原始咆哮', item_blink: '闪烁匕首', axe: '斧王' });
  });

  it('words that are not ability or modifier keys are left alone', () => {
    expect(namesIn(['ready', 'death', 'dire_top_jungle', 'radiant_base'], 'zh')).toEqual({});
    expect(tidyKey('mirana')).toBeNull();
    expect(tidyKey('modifier_')).toBeNull();
  });
});
