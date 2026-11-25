import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { buildReleaseNotes, currentReleases, mergeReleases } from '../../lib/patch/valveNotes.js';
import { advances, createLiveNotes } from '../../lib/patch/liveNotes.js';
import { createValveFetch } from '../../lib/patch/valveFetch.js';
import { PATCH, useLiveNotes } from '../../lib/patch/data.js';
import { runPatchTool } from '../../lib/patch/tools.js';
import { advisorContext, advisorSystem } from '../../lib/patch/advisor.js';

const SNAPSHOT = createRequire(import.meta.url)('../../lib/coach/data/patch-notes.json');

// Shaped like www.dota2.com/datafeed (checked against 7.42 / 7.42a on 2026-11-25).
const T = Date.UTC(2026, 10, 18, 8) / 1000;
const heroList = [{ id: 2, name: 'npc_dota_hero_axe' }, { id: 8, name: 'npc_dota_hero_juggernaut' }];
const abilityLists = {
  en: { result: { data: { itemabilities: [{ id: 5007, name: 'axe_berserkers_call', name_loc: "Berserker's Call", name_english_loc: "Berserker's Call" }] } } },
  zh: { result: { data: { itemabilities: [{ id: 5007, name: 'axe_berserkers_call', name_loc: '狂战士之吼', name_english_loc: "Berserker's Call" }] } } },
};
const itemLists = {
  en: { result: { data: { itemabilities: [{ id: 1, name: 'item_blink', name_loc: 'Blink Dagger' }, { id: 1942, name: 'item_bloodslinger', name_loc: 'Bloodslinger' }] } } },
  zh: { result: { data: { itemabilities: [{ id: 1, name: 'item_blink', name_loc: '闪烁匕首' }, { id: 1942, name: 'item_bloodslinger', name_loc: '血腥投带' }] } } },
};
const lists = { heroList, abilityLists, itemLists };
const doc = (version: string, ts: number, zh: boolean, body: (zh: boolean) => object): any => ({ success: true, patch_number: version, patch_name: version, patch_timestamp: ts, ...body(zh) });
const n = (note: string, indent = 1) => ({ indent_level: indent, note });
const major = (zh: boolean) => ({
  general_notes: [{ title: zh ? '全局机制' : 'Global Mechanics', generic: [n(zh ? '基础生命值从120提高至200' : 'Base hero Health increased from 120 to 200')] }],
  items: [{ ability_id: 1, ability_notes: [n(zh ? '冷却时间从15秒减少至14秒' : 'Cooldown decreased from 15s to 14s')] }],
  heroes: [{ hero_id: 2, abilities: [{ ability_id: 5007, ability_notes: [n(zh ? '冷却时间从17秒减少至16秒' : 'Cooldown decreased from 17s to 16s')] }] }],
  neutral_creeps: [],
});
const update = (zh: boolean) => ({
  general_notes: [{ title: zh ? '全局机制' : 'Global Mechanics', generic: [n(zh ? '在诡计之雾的效果下对中立生物造成伤害会使他们尝试逃跑' : 'Damaging neutral creeps while under Smoke of Deceit will now make them attempt to flee')] }],
  items: [
    { ability_id: 1942, ability_notes: [n('Sling Grenade Health Cost increased from 75 to 100')] },
    { ability_id: 1, ability_notes: [n(zh ? '冷却时间从14秒增加至15秒' : 'Cooldown increased from 14s to 15s')] },
  ],
  heroes: [{ hero_id: 2, abilities: [{ ability_id: 5007, ability_notes: [n(zh ? '冷却时间从16秒增加至17秒' : 'Cooldown increased from 16s to 17s')] }] }],
  neutral_creeps: [],
});
const notes = (version: string, ts: number, body: (zh: boolean) => object) => ({ en: doc(version, ts, false, body), zh: doc(version, ts, true, body) });

function valve(state: { names: string[]; notes: Record<string, { en: any; zh: any }>; down?: boolean }) {
  const calls: string[] = [];
  const fetchJson = async (url: string) => {
    calls.push(url);
    if (state.down) throw new Error('down');
    const zh = url.includes('schinese');
    if (url.includes('patchnoteslist')) return { patches: state.names.map((patch_name, i) => ({ patch_name, patch_timestamp: T + i * 86_400 })) };
    if (url.includes('herolist')) return { result: { data: { heroes: heroList } } };
    if (url.includes('abilitylist')) return zh ? abilityLists.zh : abilityLists.en;
    if (url.includes('itemlist')) return zh ? itemLists.zh : itemLists.en;
    const v = decodeURIComponent(url.match(/version=([^&]+)/)?.[1] ?? '');
    const d = state.notes[v];
    if (!d) return { success: false };
    return zh ? d.zh : d.en;
  };
  return { fetchJson, calls };
}

afterEach(() => useLiveNotes(SNAPSHOT));

describe('Valve releases laid one on the other', () => {
  const r742 = buildReleaseNotes({ version: '7.42', notes: notes('7.42', T, major), ...lists });
  const r742a = buildReleaseNotes({ version: '7.42a', notes: notes('7.42a', T + 6 * 86_400, update), ...lists });
  const merged = mergeReleases([r742, r742a], '2026-11-25');

  it('the newest release names it; the major patch and its date stay', () => {
    expect(merged).toMatchObject({ version: '7.42a', major: '7.42', released: r742.released, url: 'https://www.dota2.com/patches/7.42a' });
    expect(merged.releases.map((r: any) => r.version)).toEqual(['7.42', '7.42a']);
  });

  it('an update\'s lines come after the major\'s, each marked with the update, Valve\'s words untouched', () => {
    expect(merged.general.map((g: any) => g.patch ?? null)).toEqual([null, '7.42a']);
    expect(merged.heroes.axe.map((p: any) => [p.patch ?? null, p.lines[0].en])).toEqual([[null, 'Cooldown decreased from 17s to 16s'], ['7.42a', 'Cooldown increased from 16s to 17s']]);
    expect(merged.items.blink.lines[0].en).toBe('Cooldown decreased from 15s to 14s');
    expect(merged.items.blink.updates).toEqual([{ patch: '7.42a', lines: [{ en: 'Cooldown increased from 14s to 15s', zh: '冷却时间从14秒增加至15秒' }] }]);
    // An item only the update mentions.
    expect(merged.items.bloodslinger).toMatchObject({ lines: [], updates: [{ patch: '7.42a' }] });
  });

  it('the releases of the newest major patch, from Valve\'s list', () => {
    expect(currentReleases([{ patch_name: '7.41f' }, { patch_name: '7.42' }, { patch_name: '7.42a' }, { patch_name: '7.42b' }])).toEqual(['7.42', '7.42a', '7.42b']);
    expect(currentReleases([{ patch_name: '7.42' }])).toEqual(['7.42']);
    expect(currentReleases([])).toEqual([]);
  });

  it('a release whose two languages do not line up is refused', () => {
    const bad = notes('7.42b', T, update);
    bad.zh.items = bad.zh.items.slice(1);
    expect(() => buildReleaseNotes({ version: '7.42b', notes: bad, ...lists })).toThrow(/2 English entries, 1 Chinese/);
  });
});

describe('the advisor on the live notes', () => {
  it('follows the newest release: tools quote the update and say which one, the prompt names every release', async () => {
    const live = createLiveNotes({ fetchJson: valve({ names: ['7.41f', '7.42', '7.42a'], notes: { '7.42': notes('7.42', T, major), '7.42a': notes('7.42a', T + 6 * 86_400, update) } }).fetchJson });
    await live.ensure(5000);
    expect(live.inUse()).toBe('7.42,7.42a');
    expect(PATCH).toMatchObject({ version: '7.42a', major: '7.42' });
    const hero = runPatchTool('hero_patch', { hero: 'axe' }, { lang: 'zh' });
    expect(hero.patch).toBe('7.42a');
    expect(hero.notes).toEqual([
      { about: 'ability', ability: 'axe_berserkers_call', name: '狂战士之吼', lines: ['冷却时间从17秒减少至16秒'] },
      { about: 'ability', ability: 'axe_berserkers_call', name: '狂战士之吼', patch: '7.42a', lines: ['冷却时间从16秒增加至17秒'] },
    ]);
    expect(runPatchTool('item_patch', { item: 'blink' }, { lang: 'en' })).toMatchObject({ notes: ['Cooldown decreased from 15s to 14s'], updates: [{ patch: '7.42a', notes: ['Cooldown increased from 14s to 15s'] }] });
    const search = runPatchTool('search_notes', { query: 'Sling Grenade' }, { lang: 'en' });
    expect(search.lines).toEqual([{ in: 'item', item: 'bloodslinger', where: 'Bloodslinger', patch: '7.42a', line: 'Sling Grenade Health Cost increased from 75 to 100' }]);
    const overview = runPatchTool('patch_overview', {}, { lang: 'en' });
    expect(overview).toMatchObject({ patch: '7.42a', major_patch: '7.42', notes: 'https://www.dota2.com/patches/7.42a' });
    expect(overview.releases.map((r: any) => r.version)).toEqual(['7.42', '7.42a']);
    expect(advisorSystem('en')).toContain('7.42 and then 7.42a');
    expect(advisorSystem('en')).toContain('replaces it');
    expect(advisorContext('en')).toMatchObject({ patch: '7.42a', major_patch: '7.42' });
  });

  it('asks Valve for the list once per TTL and builds again only when a release is added', async () => {
    const state = { names: ['7.42'], notes: { '7.42': notes('7.42', T, major), '7.42a': notes('7.42a', T + 6 * 86_400, update) } };
    const v = valve(state);
    let t = 0;
    const applied: string[] = [];
    const live = createLiveNotes({ fetchJson: v.fetchJson, now: () => t, ttlMs: 1000, apply: (x: any) => applied.push(x.version) });
    await live.ensure(5000); await live.ensure(5000);
    expect(v.calls.filter((u) => u.includes('patchnoteslist'))).toHaveLength(1);
    t += 1000; await live.ensure(5000);
    expect(applied).toEqual(['7.42']);
    state.names = ['7.42', '7.42a'];
    t += 1000; await live.ensure(5000);
    expect(applied).toEqual(['7.42', '7.42a']);
  });

  it('an update that cannot be paired is not taken, nor anything after it; the earlier ones are', async () => {
    const bad = notes('7.42a', T, update);
    bad.zh.heroes = [];
    const applied: any[] = [];
    const logs: string[] = [];
    const live = createLiveNotes({ fetchJson: valve({ names: ['7.42', '7.42a', '7.42b'], notes: { '7.42': notes('7.42', T, major), '7.42a': bad, '7.42b': notes('7.42b', T, update) } }).fetchJson, apply: (x) => applied.push(x), log: (m) => logs.push(m) });
    await live.ensure(5000);
    expect(applied.map((x) => x.version)).toEqual(['7.42']);
    expect(logs.some((m) => m.includes('7.42a not taken'))).toBe(true);
  });

  it('a rebuild that comes up short keeps the updates already in use (review of #335)', async () => {
    const state: any = { names: ['7.42', '7.42a'], notes: { '7.42': notes('7.42', T, major), '7.42a': notes('7.42a', T + 6 * 86_400, update), '7.42b': notes('7.42b', T + 7 * 86_400, update) } };
    let t = 0;
    const applied: string[] = [];
    const live = createLiveNotes({ fetchJson: valve(state).fetchJson, now: () => t, ttlMs: 1000, apply: (x: any) => applied.push(x.releases.map((r: any) => r.version).join()) });
    await live.ensure(5000);
    // 7.42b is out, and this time Valve does not serve 7.42a.
    state.names = ['7.42', '7.42a', '7.42b'];
    delete state.notes['7.42a'];
    t += 1000; await live.ensure(5000);
    expect(applied).toEqual(['7.42,7.42a']);
    expect(live.inUse()).toBe('7.42,7.42a');
  });

  it('advances: forward only — more updates of the same major, or a newer major', () => {
    expect(advances('7.42', null)).toBe(true);
    expect(advances('7.42,7.42a', '7.42')).toBe(true);
    expect(advances('7.42', '7.42,7.42a')).toBe(false);
    expect(advances('7.42,7.42a', '7.42,7.42a')).toBe(false);
    expect(advances('7.43', '7.42,7.42a,7.42b')).toBe(true);
    expect(advances('7.9', '7.10')).toBe(false);
  });

  it('notes of a newer major than the numbers: tools and prompt say the numbers are the older patch\'s (review of #335)', () => {
    const r743 = buildReleaseNotes({ version: '7.43', notes: notes('7.43', T, major), ...lists });
    useLiveNotes(mergeReleases([r743], '2026-12-20'));
    const gap = { topic: 'numbers_for_the_current_patch', reason: 'the_numbers_are_from_patch_7.42_not_7.43' };
    const hero = runPatchTool('hero_patch', { hero: 'axe' }, { lang: 'en' });
    expect(hero).toMatchObject({ patch: '7.43', numbers_patch: '7.42' });
    expect(hero.gaps).toContainEqual(gap);
    expect(runPatchTool('meta_movers', {}, { lang: 'en' }).gaps).toContainEqual(gap);
    const o = runPatchTool('patch_overview', {}, { lang: 'en' });
    expect(o.numbers.numbers_patch).toBe('7.42');
    expect(o.gaps).toContainEqual(gap);
    expect(advisorSystem('en')).toContain('never present it as how heroes are doing in 7.43');
    expect(advisorContext('en').numbers.patch).toBe('7.42');
    useLiveNotes(SNAPSHOT);
    expect(runPatchTool('meta_movers', {}, { lang: 'en' }).gaps).not.toContainEqual(gap);
    expect(advisorSystem('en')).not.toContain('never present it');
  });

  it('Valve down: the notes in use stay (the committed snapshot at first)', async () => {
    const applied: any[] = [];
    const live = createLiveNotes({ fetchJson: valve({ names: [], notes: {}, down: true }).fetchJson, apply: (x) => applied.push(x) });
    await live.ensure(5000);
    expect(applied).toEqual([]);
    expect(PATCH.version).toBe(SNAPSHOT.version);
  });
});

describe('createValveFetch', () => {
  it('one request per URL per TTL, shared by callers at the same time; a failure is not kept', async () => {
    let t = 0; let calls = 0; let fail = true;
    const f = createValveFetch({ now: () => t, ttlMs: 100, fetch: (async () => { calls += 1; if (fail) return new Response('no', { status: 500 }); return new Response('{"a":1}'); }) as any });
    await expect(f('u')).rejects.toThrow('500');
    fail = false;
    expect(await Promise.all([f('u'), f('u')])).toEqual([{ a: 1 }, { a: 1 }]);
    expect(calls).toBe(2);
    t += 100; await f('u');
    expect(calls).toBe(3);
  });
});
