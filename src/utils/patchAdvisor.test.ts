import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { BRACKET_NAME, META_SOURCE, PATCH, PATCH_BRACKETS, allHeroMeta, findHero, findNotedItem, heroMeta, heroNotes, metaFromCounts } from '../../lib/patch/data.js';
import { PATCH_TOOLS, runPatchTool } from '../../lib/patch/tools.js';
import { ADVISOR_MAX_QUESTION, advisorContext, advisorSystem, parseAdvisorBody, runAdvisor } from '../../lib/patch/advisor.js';
import { aboutOf, createPatchRouter } from '../../lib/patch/router.js';
import { mockPatchAnswer } from '../../scripts/mock-patch.mjs';
import { CURRENT_PATCH } from '../coach/patch';

const express = createRequire(import.meta.url)('express');
const NOTES = JSON.parse(readFileSync(new URL('../../lib/coach/data/patch-notes.json', import.meta.url), 'utf8'));
const META = JSON.parse(readFileSync(new URL('../../lib/coach/data/patch-meta.json', import.meta.url), 'utf8'));
const NAMES = JSON.parse(readFileSync(new URL('../../lib/coach/data/names.json', import.meta.url), 'utf8'));
const DAY = 86400000;
const tool = (name: string, args: any = {}, lang = 'en'): any => runPatchTool(name, args, { lang });
const call = (name: string, args: any, id: string) => ({ id, name, args });

describe('patch notes snapshot', () => {
  it('is Valve\'s notes for the patch the home page names, in both languages line for line', () => {
    expect(NOTES.version).toBe(CURRENT_PATCH.version);
    expect(NOTES.released.slice(0, 10)).toBe(CURRENT_PATCH.date);
    expect(NOTES.source).toContain('https://www.dota2.com/patches/');
    const lines: any[] = [
      ...NOTES.general.flatMap((g: any) => g.lines),
      ...Object.values(NOTES.heroes).flatMap((parts: any) => parts.flatMap((p: any) => p.lines)),
      ...Object.values(NOTES.items).flatMap((i: any) => i.lines),
      ...NOTES.creeps.flatMap((c: any) => c.lines),
    ];
    expect(lines.length).toBeGreaterThan(1000);
    for (const l of lines) { expect(typeof l.en === 'string' && l.en.length > 0 && typeof l.zh === 'string' && l.zh.length > 0).toBe(true); expect(`${l.en}${l.zh}`).not.toMatch(/<[a-z/]/i); }
    // A Chinese line is Chinese: a pairing that slipped would put English there.
    expect(lines.filter((l) => /[㐀-鿿]/.test(l.zh)).length / lines.length).toBeGreaterThan(0.97);
  });

  it('files every entry under a hero or item the rest of the site knows', () => {
    const slugs = new Set(Object.values(NAMES.heroes).map((h: any) => h.slug));
    for (const [slug, parts] of Object.entries(NOTES.heroes) as [string, any[]][]) {
      expect(slugs.has(slug)).toBe(true);
      for (const p of parts) {
        expect(['hero', 'ability', 'talent', 'unit']).toContain(p.about);
        expect(p.lines.length).toBeGreaterThan(0);
        if (p.about === 'ability') { expect(p.key.startsWith(`${slug}_`) || !p.unit).toBe(true); expect(p.name.en && p.name.zh).toBeTruthy(); }
      }
    }
    for (const key of Object.keys(NOTES.items)) expect(NAMES.items[key]).toBeTruthy();
    // The items the home page lists as new are the ones Valve labels so.
    const labelled = Object.entries(NOTES.items).filter(([, i]: any) => i.tag?.en === 'New Item' && !i.neutral).map(([k]) => k);
    for (const it of CURRENT_PATCH.newItems) expect(labelled).toContain(it.key);
    // A unit of a hero is filed under the hero, marked: Lone Druid's bear is not Lone Druid.
    expect(NOTES.heroes.lone_druid.some((p: any) => p.unit === true || p.about === 'unit')).toBe(true);
  });
});

describe('patch meta snapshot', () => {
  it('names its source and credit, and compares whole days either side of the day the patch landed', () => {
    expect(META_SOURCE.attribution).toEqual({ en: 'Data: STRATZ', url: 'https://stratz.com' });
    expect(META.patch).toBe(NOTES.version);
    const landed = Math.floor(Date.parse(NOTES.released) / DAY) * DAY;
    const b0 = Date.parse(META.before.from); const b1 = Date.parse(META.before.to); const a0 = Date.parse(META.after.from); const a1 = Date.parse(META.after.to);
    expect((b1 - b0) / DAY + 1).toBe(META.before.days);
    expect((a1 - a0) / DAY + 1).toBe(META.after.days);
    // The day it landed has games of both patches: it is in neither window.
    expect(b1).toBe(landed - DAY);
    expect(a0).toBe(landed + DAY);
    expect(Date.parse(META.fetched)).toBeGreaterThan(a1);
  });

  it('holds four counts per hero and bracket; wins are half the games and ten heroes make a match', () => {
    expect(Object.keys(META.heroes)).toEqual(['all', 'hg', 'ca', 'la', 'di']);
    expect(PATCH_BRACKETS).toEqual(['all', 'hg', 'ca', 'la', 'di']);
    for (const b of PATCH_BRACKETS) {
      const rows: number[][] = Object.values(META.heroes[b]);
      expect(rows.length).toBeGreaterThan(100);
      for (const r of rows) { expect(r).toHaveLength(4); expect(r.every((n) => Number.isInteger(n) && n >= 0) && r[1] <= r[0] && r[3] <= r[2]).toBe(true); }
      for (const [g, w, i] of [[0, 1, 0], [2, 3, 1]]) {
        const games = rows.reduce((a, r) => a + r[g], 0);
        expect(rows.reduce((a, r) => a + r[w], 0) / games).toBeCloseTo(0.5, 2);
        expect(Math.abs(games / 10 - META.games[b][i])).toBeLessThanOrEqual(1);
      }
      expect((BRACKET_NAME as any)[b].en && (BRACKET_NAME as any)[b].zh).toBeTruthy();
    }
    // The four brackets are inside "all" (which also has unranked players), never more than it.
    for (const i of [0, 1]) expect(['hg', 'ca', 'la', 'di'].reduce((a, b) => a + META.games[b][i], 0)).toBeLessThanOrEqual(META.games.all[i]);
  });
});

describe('a hero before and since the patch', () => {
  it('reads rates from the counts, and pick rate as the share of matches', () => {
    const am = findHero('敌法师')!;
    expect(am).toMatchObject({ id: 1, slug: 'antimage', en: 'Anti-Mage' });
    const [gb, wb, ga, wa] = META.heroes.all[1];
    expect(heroMeta(1)).toMatchObject({ games_before: gb, games_after: ga, win_rate_before: Math.round((wb / gb) * 1000) / 1000, win_rate_after: Math.round((wa / ga) * 1000) / 1000, pick_rate_before: Math.round((gb / META.games.all[0]) * 10000) / 10000, pick_rate_after: Math.round((ga / META.games.all[1]) * 10000) / 10000 });
    expect(heroMeta(1, 'di')!.games_before).toBe(META.heroes.di[1][0]);
    expect(heroMeta(1, 'xx')).toBeNull();
    expect(heroMeta(99999)).toBeNull();
    expect(allHeroMeta('la').length).toBe(Object.keys(META.heroes.la).length);
    expect([findHero('Anti-Mage')?.id, findHero('antimage')?.id, findHero('anti mage')?.id, findHero('nope'), findHero(''), findHero(null)]).toEqual([1, 1, 1, null, null, null]);
    expect([findNotedItem('skypiercer')?.key, findNotedItem('破天之矛')?.key, findNotedItem('item_skypiercer')?.key, findNotedItem('Skypiercer')?.key, findNotedItem('not an item'), findNotedItem('')]).toEqual(['skypiercer', 'skypiercer', 'skypiercer', 'skypiercer', null, null]);
  });

  it('makes no claim on noise, and none on too few games', () => {
    const matches = [1_000_000, 1_000_000];
    // Two points up on many games: rose. The same rates on few games: within the noise.
    expect(metaFromCounts([50000, 25000, 50000, 26000], matches)).toMatchObject({ win_rate: 'rose', win_rate_change_in_points: 2, pick_rate: 'about_the_same', pick_rate_times: 1 });
    expect(metaFromCounts([1200, 600, 1200, 624], matches)).toMatchObject({ win_rate: 'about_the_same', win_rate_change_in_points: 2 });
    // Half a point is under the gap however many games there are.
    expect(metaFromCounts([900000, 450000, 900000, 454500], matches)).toMatchObject({ win_rate: 'about_the_same' });
    expect(metaFromCounts([50000, 26000, 50000, 25000], matches)).toMatchObject({ win_rate: 'fell', win_rate_change_in_points: -2 });
    // Picked 9% more is about the same; 10% is a rise; windows of different length are compared as shares.
    expect(metaFromCounts([10000, 5000, 10900, 5450], matches)).toMatchObject({ pick_rate: 'about_the_same', pick_rate_times: 1.09 });
    expect(metaFromCounts([10000, 5000, 5500, 2750], [1_000_000, 500_000])).toMatchObject({ pick_rate: 'rose', pick_rate_times: 1.1, pick_rate_before: 0.01, pick_rate_after: 0.011 });
    expect(metaFromCounts([10000, 5000, 4000, 2000], matches)).toMatchObject({ pick_rate: 'fell', pick_rate_times: 0.4 });
    // Under 1000 games in a window: no rate there and no verdict on either — unknown, not "about the same".
    expect(metaFromCounts([999, 600, 50000, 25000], matches)).toMatchObject({ win_rate_before: null, win_rate_after: 0.5, win_rate_change_in_points: null, win_rate: null, pick_rate: null, pick_rate_times: null });
    for (const bad of [null, undefined, [1, 2, 3]]) expect(metaFromCounts(bad as any, matches)).toBeNull();
    expect(metaFromCounts([10, 5, 10, 5], [0, 100])).toBeNull();
    expect(metaFromCounts([10, 5, 10, 5], null)).toBeNull();
  });
});

describe('patch tools', () => {
  it('lists the tools with JSON-schema inputs', () => {
    expect(PATCH_TOOLS.map((t) => t.name)).toEqual(['patch_overview', 'hero_patch', 'meta_movers', 'item_patch', 'general_changes', 'search_notes']);
    for (const t of PATCH_TOOLS) expect(t.input_schema).toMatchObject({ type: 'object', additionalProperties: false });
  });

  it('patch_overview: the patch, what the numbers cover, and the largest moves the rule calls moves', () => {
    const o = tool('patch_overview', {}, 'zh');
    expect(o).toMatchObject({ ref: 'patch', patch: PATCH.version, released: PATCH.released, heroes_changed: Object.keys(NOTES.heroes).length });
    expect(o.general_sections.map((s: any) => s.section)).toEqual(NOTES.general.map((g: any) => g.title.zh));
    expect(o.numbers).toMatchObject({ bracket: '全部分段', before_the_patch: META.before, since_the_patch: META.after, matches: { before_the_patch: META.games.all[0], since_the_patch: META.games.all[1] } });
    expect(o.labelled_items.map((i: any) => i.item)).toEqual(expect.arrayContaining(CURRENT_PATCH.newItems.map((i) => i.key)));
    for (const [list, sign] of [['win_rate_rose_most', 1], ['win_rate_fell_most', -1]] as const) {
      expect(o[list]).toHaveLength(5);
      const d = o[list].map((r: any) => r.win_rate_change_in_points);
      expect(d.every((x: number) => x * sign >= 1)).toBe(true);
      expect([...d].sort((a, b) => (b - a) * sign)).toEqual(d);
    }
    expect(o.pick_rate_rose_most.every((r: any) => r.pick_rate_times >= 1.1)).toBe(true);
    expect(o.pick_rate_fell_most.every((r: any) => r.pick_rate_times <= 0.9)).toBe(true);
    // The first riser is the largest change of any hero the rule calls a rise.
    const best: any = allHeroMeta('all').filter((m: any) => m.win_rate === 'rose').sort((a: any, b: any) => b.win_rate_change_in_points - a.win_rate_change_in_points)[0];
    expect(o.win_rate_rose_most[0]).toMatchObject({ hero: best.slug, name: NAMES.heroes[best.id].zh, win_rate_change_in_points: best.win_rate_change_in_points });
    expect(o.gaps.map((g: any) => g.topic)).toEqual(['cause_of_a_change', 'item_win_rates_and_purchase_rates', 'professional_matches']);
  });

  it('hero_patch: the hero\'s notes as Valve wrote them, next to the numbers of the bracket asked for', () => {
    const lion = tool('hero_patch', { hero: 'Lion' });
    expect(lion).toMatchObject({ ref: 'hero_patch:lion', hero: 'lion', name: 'Lion', bracket: 'all', bracket_name: 'all brackets', before_the_patch: META.before, since_the_patch: META.after });
    expect(lion.notes.map((p: any) => p.lines).flat()).toEqual(heroNotes('lion')!.flatMap((p: any) => p.lines.map((l: any) => l.en)));
    expect(lion.notes_lines_total).toBe(heroNotes('lion')!.reduce((a: number, p: any) => a + p.lines.length, 0));
    const finger = lion.notes.find((p: any) => p.ability === 'lion_finger_of_death');
    expect(finger).toMatchObject({ about: 'ability', name: 'Finger of Death' });
    expect(finger.lines[0]).toBe('Damage decreased from 600/725/850 to 570/685/800');
    expect(lion).toMatchObject(heroMeta(findHero('lion')!.id)!);
    expect(Object.keys(lion.win_rate_change_in_points_by_bracket)).toEqual(PATCH_BRACKETS);
    // The same hero in Chinese and in one bracket: Valve's Chinese lines, that bracket's numbers, the bracket in the ref.
    const zh = tool('hero_patch', { hero: '莱恩', bracket: 'di' }, 'zh');
    expect(zh).toMatchObject({ ref: 'hero_patch:lion:di', name: '莱恩', bracket_name: '超凡–冠绝', games_after: META.heroes.di[findHero('lion')!.id][2] });
    expect(zh.notes.find((p: any) => p.ability === 'lion_finger_of_death')).toMatchObject({ name: '死亡之指', lines: expect.arrayContaining(['伤害从600/725/850点减少至570/685/800点']) });
    // A unit of the hero's is said to be one.
    expect(tool('hero_patch', { hero: 'lone_druid' }).notes.map((p: any) => p.about)).toEqual(expect.arrayContaining(['a_unit_of_the_hero', 'ability_of_a_unit_of_the_hero']));
    expect(tool('hero_patch', { hero: 'pudge_x' })).toMatchObject({ error: 'unknown_hero' });
    expect(tool('hero_patch', {})).toMatchObject({ error: 'unknown_hero' });
    expect(tool('hero_patch', { hero: 'lion', bracket: 'immortal' })).toMatchObject({ error: 'unknown_bracket', brackets: PATCH_BRACKETS });
  });

  it('meta_movers: only heroes the rule calls a move, largest first, in the bracket asked for', () => {
    const up = tool('meta_movers', { by: 'pick_rate', direction: 'up', bracket: 'di', limit: 4 });
    expect(up).toMatchObject({ ref: 'movers:pick_rate:up:di', by: 'pick_rate', direction: 'up', bracket: 'di' });
    expect(up.heroes).toHaveLength(4);
    expect(up.heroes_total).toBe(allHeroMeta('di').filter((m: any) => m.pick_rate === 'rose').length);
    const t = up.heroes.map((h: any) => h.pick_rate_times);
    expect([...t].sort((a, b) => b - a)).toEqual(t);
    for (const h of up.heroes) expect(h.changed_in_the_notes).toBe((heroNotes(h.hero) ?? []).length > 0);
    const down = tool('meta_movers', { by: 'win_rate', direction: 'down' });
    expect(down).toMatchObject({ ref: 'movers:win_rate:down:all', bracket: 'all' });
    expect(down.heroes).toHaveLength(10);
    expect(down.heroes.every((h: any) => h.win_rate_change_in_points <= -1)).toBe(true);
    // Defaults: win rate, up, all brackets, ten; the limit is capped.
    expect(tool('meta_movers')).toMatchObject({ ref: 'movers:win_rate:up:all' });
    expect(tool('meta_movers', { limit: 99 }).heroes.length).toBeLessThanOrEqual(15);
    for (const bad of [{ by: 'kda' }, { direction: 'sideways' }]) expect(tool('meta_movers', bad)).toMatchObject({ error: 'invalid_arguments' });
    expect(tool('meta_movers', { bracket: 'pro' })).toMatchObject({ error: 'unknown_bracket' });
  });

  it('item_patch, general_changes and search_notes quote the notes, in the reader\'s language', () => {
    const sky = tool('item_patch', { item: 'Skypiercer' }, 'zh');
    expect(sky).toMatchObject({ ref: 'item_patch:skypiercer', name: '破天之矛', label: '全新物品' });
    expect(sky.notes).toEqual(NOTES.items.skypiercer.lines.map((l: any) => l.zh));
    expect(sky.gaps).toEqual([{ topic: 'item_win_rates_and_purchase_rates', reason: 'not_in_data' }]);
    // An item the notes do not mention cannot be looked up: no guess about it.
    expect(tool('item_patch', { item: 'not_a_real_item' })).toMatchObject({ error: 'item_not_in_the_patch_notes' });

    const all = tool('general_changes');
    expect(all.sections.map((s: any) => s.section)).toEqual(NOTES.general.map((g: any) => g.title.en));
    expect(all.sections[0].lines[0]).toEqual({ heading: 'Hero Stats' });
    expect(all.sections[0].lines[1]).toBe('Base hero Health increased from 120 to 200');
    expect(tool('general_changes', { section: 'map objectives' }).sections).toHaveLength(1);
    expect(tool('general_changes', { section: '地图目标' }, 'zh').sections[0].section).toBe('地图目标');
    expect(tool('general_changes', { section: 'cosmetics' })).toMatchObject({ error: 'unknown_section' });

    const amp = tool('search_notes', { query: 'Spell Amplification decreased' });
    expect(amp.lines_total).toBeGreaterThan(0);
    expect(amp.lines).toEqual(expect.arrayContaining([{ in: 'hero', hero: 'lion', name: 'Lion', ability: 'To Hell and Back', line: 'Spell Amplification decreased from 20% to 15%' }]));
    for (const l of amp.lines) expect(l.line.toLowerCase()).toContain('spell amplification');
    // The same search in Chinese finds the Chinese lines; `in` narrows it; too many are cut with a note.
    expect(tool('search_notes', { query: '技能增强' }, 'zh').lines.every((l: any) => /技能增强/.test(l.line))).toBe(true);
    expect(tool('search_notes', { query: 'Roshan', in: 'general' }).lines.every((l: any) => l.in === 'general')).toBe(true);
    const many = tool('search_notes', { query: 'decreased' });
    expect(many.lines).toHaveLength(40);
    expect(many.lines_total).toBeGreaterThan(40);
    expect(many.truncated).toContain(String(many.lines_total));
    expect(tool('search_notes', { query: 'zzzz-not-there' })).toMatchObject({ lines_total: 0, lines: [] });
    expect(tool('search_notes', { query: 'a' })).toMatchObject({ error: 'query_too_short' });
    expect(tool('search_notes', {})).toMatchObject({ error: 'query_too_short' });
    expect(runPatchTool('nope')).toMatchObject({ error: 'unknown_tool' });
  });
});

describe('the advisor', () => {
  const lion = tool('hero_patch', { hero: 'lion' }, 'zh');
  const pc = (v: number) => `${(v * 100).toFixed(1)}%`;
  const good = `莱恩的死亡之指伤害从600/725/850点减少至570/685/800点；路人局胜率从 ${pc(lion.win_rate_before)} 到 ${pc(lion.win_rate_after)}。`;
  const scripted = (replies: any[]) => { const seen: any[] = []; let i = 0; return { seen, complete: async (o: any) => { seen.push(JSON.parse(JSON.stringify(o))); return replies[Math.min(i++, replies.length - 1)]; } }; };
  const lookup = { toolCalls: [call('hero_patch', { hero: 'lion' }, 'a')] };

  it('looks the hero up and answers from the notes and the numbers; the lookups are reported as they happen', async () => {
    const m = scripted([lookup, { text: good }]);
    const steps: any[] = [];
    const r: any = await runAdvisor({ complete: m.complete, lang: 'zh', question: '莱恩怎么样了？', onEvent: (e: any) => steps.push(e) });
    expect(r).toMatchObject({ status: 'ok', text: good, unverified: [], tool_calls: [{ name: 'hero_patch', args: { hero: 'lion' } }] });
    expect(steps[0]).toEqual({ type: 'tool_start', name: 'hero_patch', args: { hero: 'lion' } });
    // The model is told the patch and the days the numbers cover, gets only the lookup tools, and reads Valve's Chinese.
    expect(m.seen[0].system).toBe(advisorSystem('zh'));
    expect(m.seen[0].system).toContain('简体中文');
    expect(JSON.parse(m.seen[0].messages[0].content)).toMatchObject({ patch: PATCH.version, numbers: { before_the_patch: META.before, since_the_patch: META.after } });
    expect(m.seen[0].tools.map((t: any) => t.name)).toEqual(PATCH_TOOLS.map((t) => t.name));
    expect(m.seen[1].messages.at(-1).content).toContain('死亡之指');
  });

  it('a number the tools never gave is asked about once, then returned marked — never hidden', async () => {
    const wrong = '莱恩的死亡之指伤害减少到 555/685/800，胜率 71.3%。';
    const fixed = scripted([lookup, { text: wrong }, { text: good }]);
    const ok: any = await runAdvisor({ complete: fixed.complete, lang: 'zh', question: 'q' });
    expect(ok).toMatchObject({ text: good, unverified: [] });
    expect(fixed.seen[2].messages.at(-1).content).toContain('555');
    expect(fixed.seen[2].messages.at(-1).content).toContain('71.3%');
    const still = scripted([lookup, { text: wrong }, { text: wrong }]);
    const marked: any = await runAdvisor({ complete: still.complete, lang: 'zh', question: 'q' });
    expect(marked.status).toBe('ok');
    expect(marked.unverified.map((p: any) => p.text)).toEqual(expect.arrayContaining(['555', '71.3%']));
  });

  it('an earlier answer backs a later one only when it came back clean; an engine key is given the hero\'s name', async () => {
    const earlier = '混沌骑士的出场率是原来的 2.81 倍。';
    const repeat = (clean: boolean) => runAdvisor({ complete: scripted([{ text: '刚才说过，混沌骑士的出场率是原来的 2.81 倍。' }, { text: '刚才说过，混沌骑士的出场率是原来的 2.81 倍。' }]).complete, lang: 'zh', question: '再说一遍', history: [{ q: 'q', a: earlier, clean }] });
    expect(((await repeat(true)) as any).unverified).toEqual([]);
    expect(((await repeat(false)) as any).unverified).toEqual([{ kind: 'number', text: '2.81' }]);
    const named: any = await runAdvisor({ complete: scripted([{ text: 'skeleton_king 没有被改动。' }]).complete, lang: 'zh', question: 'q' });
    expect(named.text).toBe('冥魂大帝 没有被改动。');
    expect(await runAdvisor({ complete: scripted([{ text: '  ' }]).complete, lang: 'en', question: 'q' })).toMatchObject({ status: 'no_answer' });
  });

  it('the prompt says what an answer may rest on and what it must not claim', () => {
    const s = advisorSystem('en');
    expect(s).toContain(`patch ${PATCH.version}`);
    expect(s).toContain('Do not answer from memory');
    expect(s).toContain('After is not because');
    expect(s).toContain('too few games');
    expect(s).toContain('unknown, not false');
    expect(advisorContext('zh').language).toBe('zh');
  });

  it('accepts a question and clean history, and nothing oversized or empty', () => {
    expect(parseAdvisorBody({ question: '  谁变强了？ ', lang: 'zh', history: [{ q: 'a', a: 'b', clean: true }, { q: 'c', a: 'd' }, { q: 1, a: 'x' }, { q: ' ', a: 'x' }] })).toEqual({ question: '谁变强了？', lang: 'zh', history: [{ q: 'a', a: 'b', clean: true }, { q: 'c', a: 'd', clean: false }] });
    expect(parseAdvisorBody({ question: 'q', lang: 'fr' })).toEqual({ question: 'q', lang: 'en', history: [] });
    expect(parseAdvisorBody({ question: 'x'.repeat(ADVISOR_MAX_QUESTION + 1) })).toEqual({ error: 'question_too_long' });
    for (const bad of [{}, null, { question: '   ' }, { question: 5 }]) expect(parseAdvisorBody(bad)).toEqual({ error: 'empty_question' });
    expect(parseAdvisorBody({ question: 'q', history: Array.from({ length: 9 }, (_, i) => ({ q: `q${i}`, a: 'a' })) }).history).toHaveLength(6);
  });

  it('the scripted answer of the fixture server passes the same check in both languages', async () => {
    for (const lang of ['zh', 'en']) {
      const top = tool('patch_overview', {}, lang).win_rate_rose_most[0].hero;
      const m = scripted([{ toolCalls: [call('patch_overview', {}, 'a'), call('hero_patch', { hero: top }, 'b')] }, { text: mockPatchAnswer(lang) }]);
      expect(await runAdvisor({ complete: m.complete, lang, question: 'q' })).toMatchObject({ status: 'ok', unverified: [] });
    }
  });
});

describe('patch routes', () => {
  let server: any; let base = '';
  let budget = true; let ran = 0;
  const sse = async (res: Response) => (await res.text()).split('\n\n').filter((f) => f.startsWith('data: ')).map((f) => JSON.parse(f.slice(6)));
  const post = (body: any, headers: Record<string, string> = {}) => fetch(`${base}/api/patch/chat`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const app = (complete: any, extra: any = {}) => { const a = express(); a.use(express.json()); a.use(createPatchRouter({ complete, resolveClientIp: (req: any) => String(req.headers['x-test-ip'] ?? 'ip'), ...extra })); return a; };
  beforeAll(async () => {
    const complete = async (o: any) => { ran += 1; return o.messages.at(-1).role === 'tool' ? { text: 'Lion: Damage decreased from 600/725/850 to 570/685/800.' } : { toolCalls: [call('hero_patch', { hero: 'lion' }, 'a')] }; };
    const a = app(complete, {
      llm: { acquire: () => (budget ? { ok: true } : { ok: false, reason: 'cost_guard', retryAfterSec: 30 }) },
      guard: (req: any) => (req.headers.origin === 'https://evil.example' ? { ok: false, status: 403, error: 'Cross-origin' } : { ok: true }),
    });
    const off = app(null);
    a.use('/off', off);
    server = a.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server?.close());

  it('GET /api/patch and /api/patch/hero/:hero are the tools\' records, cacheable, in the language asked for', async () => {
    const res = await fetch(`${base}/api/patch?lang=zh`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=600');
    const o = await res.json();
    expect(o).toMatchObject({ patch: PATCH.version, advisor: true, numbers: { bracket: '全部分段' } });
    expect(o).not.toHaveProperty('tool');
    expect(o.win_rate_rose_most).toEqual(tool('patch_overview', {}, 'zh').win_rate_rose_most);
    expect((await (await fetch(`${base}/off/api/patch`)).json()).advisor).toBe(false);
    const hero = await (await fetch(`${base}/api/patch/hero/lion?bracket=di&lang=en`)).json();
    expect(hero).toMatchObject({ ref: 'hero_patch:lion:di', name: 'Lion' });
    // A bracket that is none is ignored (all brackets), a hero that is none is a 404.
    expect((await (await fetch(`${base}/api/patch/hero/lion?bracket=zz`)).json()).bracket).toBe('all');
    const none = await fetch(`${base}/api/patch/hero/nobody`);
    expect(none.status).toBe(404);
    expect(await none.json()).toMatchObject({ code: 'unknown_hero' });
  });

  it('POST /api/patch/chat streams the lookups, then the checked answer', async () => {
    const res = await post({ question: 'Lion?', lang: 'en', history: [] }, { 'x-test-ip': 'reader' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(await sse(res)).toEqual([{ step: { tool: 'hero_patch', args: { hero: 'lion' }, about: 'Lion' } }, { text: 'Lion: Damage decreased from 600/725/850 to 570/685/800.' }, { done: true }]);
  });

  it('a step is named for the reader: the hero, the item, or the words searched for', () => {
    expect([aboutOf('hero_patch', { hero: 'skeleton_king' }, 'zh'), aboutOf('hero_patch', { hero: 'Wraith King' }, 'en'), aboutOf('item_patch', { item: 'skypiercer' }, 'zh'), aboutOf('search_notes', { query: ' Roshan ' }, 'en')]).toEqual(['冥魂大帝', 'Wraith King', '破天之矛', 'Roshan']);
    // Unknown, or about nothing in particular: no name, so the page shows the step on its own.
    expect([aboutOf('hero_patch', { hero: 'nobody' }, 'en'), aboutOf('item_patch', {}, 'en'), aboutOf('patch_overview', {}, 'en'), aboutOf('search_notes', { query: 5 }, 'en'), aboutOf('hero_patch', null, 'en')]).toEqual([null, null, null, null, null]);
  });

  it('nothing is spent on a turn that cannot be answered, and a refusal leaves nothing reserved', async () => {
    const before = ran;
    expect((await post({ question: '' })).status).toBe(400);
    expect((await post({ question: 'x'.repeat(501) })).status).toBe(400);
    expect((await post({ question: 'q' }, { origin: 'https://evil.example' })).status).toBe(403);
    const off = await fetch(`${base}/off/api/patch/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'q' }) });
    expect(off.status).toBe(503);
    expect(await off.json()).toMatchObject({ code: 'unavailable' });
    // The model budget says no: 503 with a wait, and the caller's own allowance is not used up by it.
    budget = false;
    for (let i = 0; i < 10; i += 1) { const r = await post({ question: 'q' }, { 'x-test-ip': 'budget' }); expect(r.status).toBe(503); expect(r.headers.get('retry-after')).toBe('30'); }
    budget = true;
    expect(ran).toBe(before);
    expect((await post({ question: 'q' }, { 'x-test-ip': 'budget' })).status).toBe(200);
    // Eight questions a minute per caller; the ninth waits. Another caller is not affected.
    const codes: number[] = [];
    for (let i = 0; i < 9; i += 1) { const r = await post({ question: 'q' }, { 'x-test-ip': 'eager' }); codes.push(r.status); await r.text(); }
    expect(codes).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 429]);
    expect((await post({ question: 'q' }, { 'x-test-ip': 'someone-else' })).status).toBe(200);
  });
});
