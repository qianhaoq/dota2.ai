import { describe, expect, it } from 'vitest';
import { fetchFromSources, parseUpstreamPrimary, sourceOrder } from '../../lib/upstream/sourceOrder.js';

describe('UPSTREAM_PRIMARY', () => {
  it('defaults to opendota; accepts steam_gc; a typo is reported, never guessed', () => {
    expect(parseUpstreamPrimary(undefined)).toEqual({ primary: 'opendota', invalid: null });
    expect(parseUpstreamPrimary(' Steam_GC ')).toEqual({ primary: 'steam_gc', invalid: null });
    expect(parseUpstreamPrimary('stratz')).toEqual({ primary: 'opendota', invalid: 'stratz' });
  });

  it('orders configured sources only, primary first', () => {
    const all = { opendota: true, steam_gc: true, stratz: true };
    expect(sourceOrder('match', { configured: all })).toEqual(['opendota', 'steam_gc', 'stratz']);
    expect(sourceOrder('match', { primary: 'steam_gc', configured: all })).toEqual(['steam_gc', 'opendota', 'stratz']);
    // Recent matches: OpenDota, then the Steam Web API. Never the GC (it answers history for its own account alone).
    expect(sourceOrder('recent', { primary: 'steam_gc', configured: all })).toEqual(['opendota']);
    expect(sourceOrder('recent', { configured: all })).toEqual(['opendota']);
    const web = { ...all, steam_web_api: true };
    expect(sourceOrder('recent', { configured: web })).toEqual(['opendota', 'steam_web_api']);
    // UPSTREAM_PRIMARY=steam_gc is the operator saying OpenDota is down: do not wait on it first.
    expect(sourceOrder('recent', { primary: 'steam_gc', configured: web })).toEqual(['steam_web_api', 'opendota']);
    expect(sourceOrder('recent', { configured: { opendota: true, steam_web_api: false } })).toEqual(['opendota']);
    // The Web API is not a source of single matches.
    expect(sourceOrder('match', { configured: web })).toEqual(['opendota', 'steam_gc', 'stratz']);
    // steam_gc asked for but not deployed: today's chain, unchanged.
    expect(sourceOrder('match', { primary: 'steam_gc', configured: { opendota: true, stratz: false } })).toEqual(['opendota']);
  });
});

describe('fetchFromSources', () => {
  const fail = (status?: number) => async () => { throw Object.assign(new Error(`HTTP ${status}`), { status }); };

  it('falls through an outage to the next source', async () => {
    const seen: string[] = [];
    const r = await fetchFromSources(['opendota', 'stratz'], { opendota: fail(520), stratz: async () => 'basic' }, { onFallback: (a, b) => seen.push(`${a}->${b}`) });
    expect(r).toEqual({ source: 'stratz', value: 'basic' });
    expect(seen).toEqual(['opendota->stratz']);
  });

  it('a 404 is the answer: no other source is asked', async () => {
    let asked = false;
    await expect(fetchFromSources(['opendota', 'stratz'], { opendota: fail(404), stratz: async () => { asked = true; return 'x'; } })).rejects.toMatchObject({ status: 404 });
    expect(asked).toBe(false);
  });

  it('an aborted caller stops the chain', async () => {
    const ac = new AbortController();
    let asked = false;
    const p = fetchFromSources(['opendota', 'stratz'], { opendota: async () => { ac.abort(); throw new Error('aborted'); }, stratz: async () => { asked = true; return 'x'; } }, { signal: ac.signal });
    await expect(p).rejects.toThrow('aborted');
    expect(asked).toBe(false);
  });

  it('every source failing throws the primary error (the one callers map)', async () => {
    await expect(fetchFromSources(['opendota', 'stratz'], { opendota: fail(520), stratz: fail(503) })).rejects.toMatchObject({ status: 520 });
  });
});
