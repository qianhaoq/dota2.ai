import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { candidates, createPatchNews, namesById, newItems, parsePicks, validPicks } from '../../lib/patch/news.js';
import { createPatchRouter } from '../../lib/patch/router.js';
const express = createRequire(import.meta.url)('express');

// Shaped like www.dota2.com/datafeed (checked against 7.42 / 7.42a on 2026-11-25).
const day = 86_400;
const T742 = Date.UTC(2026, 10, 18, 21) / 1000;
const list = (...extra: string[]) => ({
  patches: [
    { patch_name: '7.41f', patch_timestamp: T742 - 60 * day },
    { patch_name: '7.42', patch_timestamp: T742 },
    ...extra.map((patch_name, i) => ({ patch_name, patch_timestamp: T742 + (i + 6) * day })),
  ],
});
const general = (zh: boolean) => [{
  title: zh ? '全局机制' : 'Global Mechanics',
  generic: [
    { indent_level: 1, hide_dot: true, note: `<span class="Subtitle">${zh ? '金钱和经验' : 'Gold and Experience'}</span>` },
    { indent_level: 1, note: zh ? '被动的每分钟金钱收入不再随游戏时间提升' : 'Passive gold per minute no longer scales over game time' },
    { indent_level: 2, note: zh ? '细节' : 'A detail' },
    { indent_level: 1, hide_dot: true, note: '<br>' },
    // Not yet translated: Valve's schinese feed carries the English line.
    { indent_level: 1, note: 'Smoke now makes neutrals flee' },
  ],
}];
const notes742 = (zh: boolean) => ({
  patch_name: '7.42',
  general_notes: general(zh),
  items: [
    { ability_id: 1, ability_notes: [{ indent_level: 1, note: zh ? '冷却时间从15秒减少至14秒' : 'Cooldown decreased from 15s to 14s' }] },
    { ability_id: 2001, title: '<span class="New">New Item</span>', ability_notes: [{ indent_level: 2, note: zh ? '售价 900' : 'Costs 900g' }] },
  ],
  neutral_items: [],
  heroes: [{ hero_id: 2, hero_notes: [{ indent_level: 1, note: zh ? '基础护甲提高1' : 'Base armor increased by 1' }] }],
});
const notes742a = { patch_name: '7.42a', general_notes: [], items: [{}, {}], neutral_items: [{}], heroes: [{}, {}, {}] };
const itemlist = { result: { data: { itemabilities: [
  { id: 1, name: 'item_blink', name_loc: '闪烁匕首', name_english_loc: 'Blink Dagger' },
  { id: 2001, name: 'item_caduceus', name_loc: '双蛇杖', name_english_loc: 'Caduceus' },
] } } };
const herolist = { result: { data: { heroes: [{ id: 2, name: 'npc_dota_hero_axe', name_loc: '斧王', name_english_loc: 'Axe' }] } } };

function valve(state: { list: any; down?: boolean }) {
  const calls: string[] = [];
  const fetchJson = async (url: string) => {
    calls.push(url);
    if (state.down) throw new Error('down');
    if (url.includes('patchnoteslist')) return state.list;
    if (url.includes('itemlist')) return itemlist;
    if (url.includes('herolist')) return herolist;
    if (url.includes('version=7.42a')) return notes742a;
    if (url.includes('version=7.42')) return notes742(url.includes('schinese'));
    throw new Error(`unexpected ${url}`);
  };
  return { fetchJson, calls };
}
const memoryStore = () => { const m = new Map<string, any>(); return { m, get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: any) => { m.set(k, v); } }; };
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('patch news candidates', () => {
  const names = { items: namesById(itemlist.result.data.itemabilities), heroes: namesById(herolist.result.data.heroes) };
  const c = candidates(notes742(false), notes742(true), names);

  it('are Valve\'s lines with Valve\'s labels, sub-bullets and spacers left out', () => {
    expect(c).toEqual([
      { id: 'g0.1', en: 'Gold and Experience: Passive gold per minute no longer scales over game time', zh: '金钱和经验：被动的每分钟金钱收入不再随游戏时间提升' },
      { id: 'g0.4', en: 'Gold and Experience: Smoke now makes neutrals flee', zh: null },
      { id: 'i0.0', en: 'Blink Dagger: Cooldown decreased from 15s to 14s', zh: '闪烁匕首：冷却时间从15秒减少至14秒' },
      { id: 'h0.0', en: 'Axe: Base armor increased by 1', zh: '斧王：基础护甲提高1' },
    ]);
  });

  it('a line still in English in Valve\'s Chinese feed has no Chinese (the page shows the English one)', () => {
    expect(c.find((x) => x.id === 'g0.4')?.zh).toBeNull();
  });

  it('new items are the ones Valve marks "New Item", with Valve\'s names', () => {
    expect(newItems(notes742(false), names.items)).toEqual([{ key: 'caduceus', en: 'Caduceus', zh: '双蛇杖' }]);
  });

  it('the model\'s ids are kept only when they are candidates, once, at most five', () => {
    expect(validPicks(['h0.0', 'made.up', 'h0.0', 'g0.1', 7], c)).toEqual(['h0.0', 'g0.1']);
    expect(parsePicks('Sure! {"ids": ["g0.1"]}')).toEqual(['g0.1']);
    expect(parsePicks('no json')).toEqual([]);
  });
});

describe('createPatchNews', () => {
  const now = () => (T742 + 7 * day) * 1000;

  it('answers without highlights at once, then shows the lines the model chose, in its order', async () => {
    const v = valve({ list: list('7.42a') });
    let asked = '';
    let release = () => {};
    const slow = new Promise<void>((r) => { release = r; });
    const complete = async (o: any) => { asked = o.messages[0].content; await slow; return { text: '{"ids": ["h0.0", "nope", "g0.1", "i0.0"]}' }; };
    const news = createPatchNews({ fetchJson: v.fetchJson, complete, now, pickWaitMs: 0 });
    const first = await news.get();
    expect(first).toMatchObject({
      version: '7.42', date: '2026-11-18', url: 'https://www.dota2.com/patches/7.42', picking: true, highlights: [],
      newItems: [{ key: 'caduceus' }],
      update: { version: '7.42a', url: 'https://www.dota2.com/patches/7.42a', changes: { heroes: 3, items: 3 } },
    });
    expect(first?.forCoach?.zh).toContain('7.41');
    expect(asked).toContain('g0.1 [zh] | Gold and Experience: Passive gold');
    expect(asked).toContain('g0.4 | Gold and Experience: Smoke');
    release(); await settle();
    const later = await news.get();
    expect(later?.picking).toBe(false);
    expect(later?.highlights.map((h: any) => h.en)).toEqual(['Axe: Base armor increased by 1', 'Gold and Experience: Passive gold per minute no longer scales over game time', 'Blink Dagger: Cooldown decreased from 15s to 14s']);
  });

  it('one model call per patch: the choice is kept, and a new instance reads it instead of asking again', async () => {
    const store = memoryStore();
    let calls = 0;
    const complete = async () => { calls += 1; return { text: '{"ids": ["g0.1", "i0.0", "h0.0"]}' }; };
    const a = createPatchNews({ fetchJson: valve({ list: list() }).fetchJson, complete, store, now, pickWaitMs: 0 });
    await a.get(); await settle();
    expect(store.m.get('patch-news-7.42.json')).toMatchObject({ version: '7.42', ids: ['g0.1', 'i0.0', 'h0.0'] });
    const b = createPatchNews({ fetchJson: valve({ list: list() }).fetchJson, complete, store, now });
    expect((await b.get())?.highlights).toHaveLength(3);
    expect(calls).toBe(1);
  });

  it('a model that answers fewer than three real lines gets no highlights, and is not asked again within the hour', async () => {
    let calls = 0;
    const complete = async () => { calls += 1; return { text: '{"ids": ["x", "y", "g0.1"]}' }; };
    const news = createPatchNews({ fetchJson: valve({ list: list() }).fetchJson, complete, now, pickWaitMs: 0 });
    await news.get(); await settle();
    const n = await news.get(); await settle();
    expect(n).toMatchObject({ picking: true, highlights: [] });
    expect(calls).toBe(1);
  });

  it('asks Valve for the list once per TTL, and for the notes only when the newest patch changes', async () => {
    const state = { list: list() };
    const v = valve(state);
    let t = now();
    const news = createPatchNews({ fetchJson: v.fetchJson, now: () => t, ttlMs: 1000 });
    await news.get(); await news.get();
    expect(v.calls.filter((u) => u.includes('patchnoteslist'))).toHaveLength(1);
    const notesCalls = v.calls.length;
    t += 1000; await news.get(); await settle();
    expect(v.calls.length).toBe(notesCalls + 1);
    state.list = list('7.42a');
    t += 1000; await news.get(); await settle();
    expect((await news.get())?.update?.version).toBe('7.42a');
  });

  it('Valve down on a cold instance: null; down later: the last news stays', async () => {
    const state: any = { list: list(), down: true };
    let t = now();
    const cold = createPatchNews({ fetchJson: valve(state).fetchJson, now: () => t });
    expect(await cold.get()).toBeNull();
    state.down = false;
    const warm = createPatchNews({ fetchJson: valve(state).fetchJson, now: () => t, ttlMs: 1000 });
    await warm.get();
    state.down = true; t += 1000;
    expect((await warm.get())?.version).toBe('7.42');
  });

  it('the benchmark-lag line is only there in a major patch\'s first 30 days', async () => {
    const news = createPatchNews({ fetchJson: valve({ list: list() }).fetchJson, now: () => (T742 + 31 * day) * 1000 });
    expect((await news.get())?.forCoach).toBeNull();
  });
});

describe('GET /api/patch/news', () => {
  let server: any;
  afterEach(() => server?.close());
  const serve = async (news: any) => {
    const a = express();
    a.use(createPatchRouter({ complete: null, resolveClientIp: () => 'ip', news }));
    server = a.listen(0);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/patch/news`;
  };

  it('is the news, cached briefly while highlights are being chosen', async () => {
    let picking = true;
    const url = await serve({ get: async () => ({ version: '7.42', picking }) });
    let res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=30');
    expect((await res.json()).version).toBe('7.42');
    picking = false;
    res = await fetch(url);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('is a 503 when there is no news (or no news source)', async () => {
    const url = await serve({ get: async () => null });
    const res = await fetch(url);
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('patch_news_unavailable');
    server.close();
    expect((await fetch(await serve(null))).status).toBe(503);
  });
});
