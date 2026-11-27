// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { EvidenceCard } from './EvidenceCard';
import { resolveRef } from '../../lib/agent/evidence.js';
import { linkHeroNames } from '../../packages/review-engine/src/trace/index.js';
import { combatLog } from '../../lib/agent/replayQuery.js';

/** A row of the replay's log and a hero's track under a line: the reader sees what was cited (Codex on #413). */
// Read by path: under jsdom import.meta.url is not a file URL. Vitest runs from the repo root.
const trace = linkHeroNames(JSON.parse(gunzipSync(readFileSync(join(process.cwd(), 'packages/review-engine/test/fixtures/trace-9100904020.json.gz'))).toString()));
const open = async (ref: string, t: any = trace) => {
  const served = resolveRef(t, ref, { hero: 'beastmaster', lang: 'en' }) as any;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'ok', ...served }), { status: 200, headers: { 'content-type': 'application/json' } })));
  render(<ul><EvidenceCard matchId="9100904020" hero="beastmaster" lang="en" item={{ refs: [ref], fact: 'f' }} onAsk={() => {}} /></ul>);
  fireEvent.click(screen.getByRole('button', { name: 'Show the record' }));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return document.querySelector('.ag-rec')!.textContent!;
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('evidence cards for the replay\'s own rows', () => {
  it('a cast: its clock, the kind, who cast what', async () => {
    const row = (combatLog(trace, { from: '30:20', to: '30:40', hero: 'beastmaster', kinds: ['cast'] }) as any).rows[0];
    const text = await open(row.ref);
    expect(text).toContain(row.clock);
    expect(text).toContain('cast');
    expect(text.toLowerCase()).toContain('beastmaster');
  });
  it('a gold row names whose gold it was (Codex on #413)', async () => {
    const t2 = { ...trace, gold: [[1, trace.names.indexOf('npc_dota_hero_sven'), 13, 120]] };
    const text = await open('log:gold:0', t2);
    expect(text.toLowerCase()).toContain('sven');
    expect(text).toContain('120');
  });
  it('an effect names who put it and on whom (Codex on #413)', async () => {
    const ix = (k: string) => trace.names.indexOf(`npc_dota_hero_${k}`);
    const t2 = { ...trace, modifiers: [[100, ix('venomancer'), trace.names.indexOf('npc_dota_hero_dark_willow'), ix('dark_willow'), 1, 0, 't', 0]] };
    const text = (await open('log:effect:0', t2)).toLowerCase();
    expect(text).toContain('dark willow');
    expect(text).toContain('venomancer');
  });
  it('a track: one line a second with where, health and mana', async () => {
    const text = await open('track:beastmaster:1820:1823');
    for (const c of ['30:20', '30:21', '30:22', '30:23']) expect(text).toContain(c);
    expect(text).toContain('%');
  });
});
