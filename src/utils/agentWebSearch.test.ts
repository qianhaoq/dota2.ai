import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { WEB_SEARCH_TOOL, createWebSearch, isWebSearchResult, webSearchFromEnv } from '../../lib/agent/webSearch.js';
import { reviewToolkit } from '../../lib/agent/review/toolkit.js';
import { verifyReview } from '../../lib/agent/deepReview.js';

const trace = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());

const page = { title: 'Ursa counters', url: 'https://example.org/ursa', site_name: 'Example', date: '2026-10-01T00:00:00Z', summary: 'Eul\'s Scepter and Heaven\'s Halberd stop Ursa from attacking. Fury Swipes resets after 8 seconds.', snippet: 's', rerank_score: 2, authority: 3, content: '' };
const ok = (results: any[] = [page]) => vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ results }) }));

describe('web_search: DeepSeek Search as reading for the model', () => {
  it('posts the query to DeepSeek Search with the key and keeps title, url, site, date and summary', async () => {
    const f = ok();
    const r: any = await createWebSearch({ apiKey: 'k', fetchImpl: f as any })({ query: ' Ursa counter items ' });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = (f.mock.calls[0] as any[]);
    expect(url).toBe('https://api.deepseek.com/v1/tools/search');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer k');
    expect(JSON.parse(init.body)).toEqual({ query: 'Ursa counter items', count: 5 });
    expect(r).toMatchObject({ tool: 'web_search', query: 'Ursa counter items', source: 'DeepSeek Search', results: [{ title: 'Ursa counters', url: 'https://example.org/ursa', site: 'Example', date: '2026-10-01', summary: page.summary }] });
    // Nothing in it can be cited.
    expect(r).not.toHaveProperty('ref');
    expect(isWebSearchResult(r)).toBe(true);
  });

  it('each page is set against this game\'s patch, and the answer names the tools that hold that patch', async () => {
    const f = ok([{ ...page, date: '2026-01-01T00:00:00Z' }, { ...page, url: 'https://example.org/new', date: '2026-11-20T00:00:00Z' }, { ...page, url: 'https://example.org/undated', date: null }]);
    const r: any = await createWebSearch({ apiKey: 'k', fetchImpl: f as any })({ query: 'Ursa' }, { patch: { name: '7.42', released: '2026-11-18T20:00:48.000Z' } });
    expect(r.this_game_patch).toEqual({ name: '7.42', released: '2026-11-18T20:00:48.000Z' });
    expect(r.results.map((x: any) => x.before_this_game_patch)).toEqual([true, false, null]);
    expect(r.check_with).toEqual(['hero_abilities', 'item_info', 'hero_info', 'patch_changes']);
    expect(r.note).toContain('the patch data stands');
    expect(WEB_SEARCH_TOOL.description).toContain('this patch\'s data stands');
    // No patch known: nothing is said about any page's age.
    const none: any = await createWebSearch({ apiKey: 'k', fetchImpl: ok() as any })({ query: 'Ursa' });
    expect(none.this_game_patch).toBeNull();
    expect(none.results[0].before_this_game_patch).toBeNull();
    // Through the toolkit: the game's own patch and its release.
    const kit: any = reviewToolkit({ trace, hero: 'beastmaster', lang: 'en', webSearch: createWebSearch({ apiKey: 'k', fetchImpl: ok() as any }) });
    expect((await kit.runTool('web_search', { query: 'Ursa' })).this_game_patch).toEqual({ name: kit.patch.name, released: expect.any(String) });
  });

  it('a page without a date says null, not a date; no results is an empty list, said as such', async () => {
    const r: any = await createWebSearch({ apiKey: 'k', fetchImpl: ok([{ ...page, date: null }]) as any })({ query: 'Ursa' });
    expect(r.results[0].date).toBeNull();
    const none: any = await createWebSearch({ apiKey: 'k', fetchImpl: ok([]) as any })({ query: 'Ursa' });
    expect(none.results).toEqual([]);
  });

  it('never sends an id, a query out of bounds, or more than the limit; no key, no call', async () => {
    const f = ok();
    const s = createWebSearch({ apiKey: 'k', fetchImpl: f as any, maxCalls: 2 });
    expect(((await s({ query: 'match 9091400302 Tidehunter' })) as any).error).toMatch(/^query_has_an_id/);
    expect(((await s({ query: 'x' })) as any).error).toBe('query_must_be_2_to_128_characters');
    expect(((await s({ query: 'a'.repeat(129) })) as any).error).toBe('query_must_be_2_to_128_characters');
    expect(f).not.toHaveBeenCalled();
    await s({ query: 'Ursa' }); await s({ query: 'Ursa Enrage' });
    expect(((await s({ query: 'Ursa again' })) as any).error).toMatch(/^web_search_limit_reached/);
    expect(f).toHaveBeenCalledTimes(2);
    const noKey = vi.fn();
    expect(await createWebSearch({ apiKey: null, fetchImpl: noKey as any })({ query: 'Ursa' })).toMatchObject({ error: 'web_search_not_configured' });
    expect(noKey).not.toHaveBeenCalled();
    expect((await webSearchFromEnv({ DEEPSEEK_API_KEY: 'k', AGENT_WEB_SEARCH: '0' })({ query: 'Ursa' }) as any).error).toBe('web_search_not_configured');
  });

  it('a failed or odd answer is an error, not an empty result', async () => {
    const down = vi.fn(async () => { throw new Error('net'); });
    expect(((await createWebSearch({ apiKey: 'k', fetchImpl: down as any })({ query: 'Ursa' })) as any).error).toBe('web_search_unreachable');
    const e429 = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }));
    expect(((await createWebSearch({ apiKey: 'k', fetchImpl: e429 as any })({ query: 'Ursa' })) as any)).toMatchObject({ error: 'web_search_failed_429' });
    expect(((await createWebSearch({ apiKey: 'k', fetchImpl: e429 as any })({ query: 'Ursa' })) as any)).not.toHaveProperty('results');
    const odd = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ nope: 1 }) }));
    expect(((await createWebSearch({ apiKey: 'k', fetchImpl: odd as any })({ query: 'Ursa' })) as any).error).toBe('web_search_bad_answer');
  });

  it('the toolkit offers it and runs the search it was given; a number from a web page is not a fact the review may state', async () => {
    const f = ok([{ ...page, summary: 'Pros build Eul\'s in 77777 games.' }]);
    const kit: any = reviewToolkit({ trace, hero: 'beastmaster', lang: 'en', webSearch: createWebSearch({ apiKey: 'k', fetchImpl: f as any }) });
    expect(kit.tools.map((t: any) => t.name)).toContain(WEB_SEARCH_TOOL.name);
    const r = await kit.runTool('web_search', { query: 'Phantom Assassin counter' });
    expect(r.results[0].summary).toContain('77777');
    // The review's check leaves web answers out of its sources (run.js, chat.js filter on isWebSearchResult): read
    // with them left out, 77777 is not a number any tool stated.
    const review = { verdict: 'You lost 77777 times.', mainline: [], findings: [], did_well: [], next_game: [], blind_spots: [] };
    const without = verifyReview(review as any, [kit.context, ...[r].filter((x) => !isWebSearchResult(x))]);
    expect(without.problems.some((p: any) => p.where === 'verdict')).toBe(true);
  });
});

describe('web_search inside a review run', () => {
  it('the model may read a page, but a number only the page states does not pass the review\'s check', async () => {
    const { runDeepReview } = await import('../../lib/agent/deepReview.js');
    const f = ok([{ ...page, summary: 'Phantom Assassin was banned in 77777 games.' }]);
    const submit = { verdict: '幻影刺客被禁了 77777 次。', mainline: ['m'], findings: [], next_game: ['n'], blind_spots: ['b'] };
    const replies = [
      { toolCalls: [{ id: 'w', name: 'web_search', args: { query: 'Phantom Assassin counter' } }], usage: { input: 1, output: 1 } },
      { toolCalls: [{ id: 's', name: 'submit_review', args: submit }], usage: { input: 1, output: 1 } },
    ];
    let i = 0;
    const r: any = await runDeepReview({ complete: async () => replies[Math.min(i++, replies.length - 1)], trace, hero: 'beastmaster', lang: 'zh', webSearch: createWebSearch({ apiKey: 'k', fetchImpl: f as any }) });
    expect(f).toHaveBeenCalledTimes(1);
    expect(r.verification.first_pass_problems).toBeGreaterThan(0);
    expect(JSON.stringify(r.review ?? {})).not.toContain('77777');
  });
});
