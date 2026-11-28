// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { EvidenceCard } from './EvidenceCard';
import { resolveRef } from '../../lib/agent/evidence.js';

/** Knowledge records under a line: the reader sees what was cited (Codex on #409: the generic view showed nothing). */
// Read by path: under jsdom import.meta.url is not a file URL. Vitest runs from the repo root.
const trace = JSON.parse(gunzipSync(readFileSync(join(process.cwd(), 'packages/review-engine/test/fixtures/trace-9100904020.json.gz'))).toString());
const open = async (ref: string, lang: 'en' | 'zh' = 'en') => {
  cleanup();
  const served = resolveRef(trace, ref, { hero: 'beastmaster', lang }) as any;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'ok', ...served }), { status: 200, headers: { 'content-type': 'application/json' } })));
  render(<ul><EvidenceCard matchId="9100904020" hero="beastmaster" lang={lang} item={{ refs: [ref], fact: 'f' }} onAsk={() => {}} /></ul>);
  fireEvent.click(screen.getByRole('button', { name: lang === 'en' ? 'Show the record' : /记录/ }));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return document.querySelector('.ag-rec')!.textContent!;
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('evidence cards for knowledge records', () => {
  it('an item: cost, recipe and Valve\'s text for what it does', async () => {
    const text = await open('item_info:glimmer_cape');
    expect(text).toContain('2150 gold');
    expect(text).toContain('Glimmer');
    expect(text).toContain('375');
  });
  it('a hero\'s base numbers and official Scepter/Shard upgrades', async () => {
    const text = await open('hero_info:sven');
    expect(text).toContain('strength');
    expect(text).toContain('move speed');
    expect(text).toContain("Aghanim's Scepter");
    expect(text).toContain('Storm Hammer');
    expect(text).toContain('780');
    expect(text).toContain("Aghanim's Shard");
    expect(text).toContain('Warcry');
    expect(text).toContain('350');
    expect(text).not.toMatch(/sven_storm_bolt|sven_warcry|granted_ability/);
  });
  it('hero_abilities and hero_info render Enchantress Scepter/Shard granted abilities localized in en and zh without raw engine keys', async () => {
    const abZh = await open('abilities:enchantress', 'zh');
    expect(abZh).toContain('密友');
    expect(abZh).toContain('阿哈利姆神杖');
    expect(abZh).toContain('跃动');
    expect(abZh).toContain('阿哈利姆魔晶');
    expect(abZh).toContain('神杖效果');
    expect(abZh).toContain('授予技能');
    expect(abZh).toContain('魅惑');
    expect(abZh).not.toMatch(/enchantress_little_friends|enchantress_bunny_hop|granted_ability|granted_by/);

    const infoZh = await open('hero_info:enchantress', 'zh');
    expect(infoZh).toContain('魅惑魔女');
    expect(infoZh).toContain('密友');
    expect(infoZh).toContain('跃动');
    expect(infoZh).not.toMatch(/enchantress_little_friends|enchantress_bunny_hop|granted_ability|granted_by/);

    const abEn = await open('abilities:enchantress', 'en');
    expect(abEn).toContain('Little Friends');
    expect(abEn).toContain('Sproink');
    expect(abEn).toContain('new ability');
    expect(abEn).not.toMatch(/enchantress_little_friends|enchantress_bunny_hop|granted_ability|granted_by/);
  });
  it('a matchup by bracket, with its games and its source', async () => {
    const text = await open('matchup:beastmaster:phantom_assassin');
    expect(text).toContain('Herald–Guardian');
    expect(text).toContain('win rate vs its own');
    expect(text).toContain('STRATZ');
  });
  it('patch notes, with the ability each line is about', async () => {
    const text = await open('patch_notes:beastmaster');
    expect(text).toContain('Summon Ancient Thunderhide');
  });
});
