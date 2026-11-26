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
  it('a hero\'s base numbers', async () => {
    const text = await open('hero_info:sven');
    expect(text).toContain('strength');
    expect(text).toContain('move speed');
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
