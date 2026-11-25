// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PatchAdvisor, advisorStepLabel, pct, points, times } from './PatchAdvisor';
import { runPatchTool } from '../../lib/patch/tools.js';

const overview = (lang: string): any => { const { tool, ...rest } = runPatchTool('patch_overview', {}, { lang }) as any; return { ...rest, advisor: true }; };
type Handler = (url: string, init?: RequestInit) => any;
function mockFetch(routes: Record<string, Handler | any>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    const body = key ? await (typeof routes[key] === 'function' ? routes[key](url, init) : routes[key]) : null;
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body ?? { code: 'not_found' }), { status: body ? 200 : 404, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}
const sse = (frames: object[]) => new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const refuse = (status: number, code: string) => new Response(JSON.stringify({ code, retryAfterSec: 30 }), { status, headers: { 'content-type': 'application/json' } });
const show = (lang: 'en' | 'zh' = 'en') => render(<PatchAdvisor lang={lang} version="7.42" notesUrl="https://www.dota2.com/patches/7.42" />);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('PatchAdvisor', () => {
  it('shows who moved since the patch, with the days compared and the credit', async () => {
    const o = overview('en');
    mockFetch({ '/api/patch?': o });
    show();
    expect(screen.getByRole('heading', { level: 2, name: 'Patch 7.42 advisor' })).toBeTruthy();
    const up = within(await screen.findByRole('table', { name: 'Win rate up' }));
    const top = o.win_rate_rose_most[0];
    expect(up.getAllByRole('row')).toHaveLength(6);
    expect(up.getByRole('row', { name: `${top.name} ${pct(top.win_rate_before)} ${pct(top.win_rate_after)} ${points(top.win_rate_change_in_points)}` })).toBeTruthy();
    const picked = o.pick_rate_rose_most[0];
    expect(within(screen.getByRole('table', { name: 'Picked more' })).getByRole('row', { name: `${picked.name} ${pct(picked.pick_rate_before)} ${pct(picked.pick_rate_after)} ${times(picked.pick_rate_times)}` })).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Win rate down' })).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Picked less' })).toBeTruthy();
    // The days either side, that it is public matches, and that it will move.
    const w = o.numbers;
    expect(screen.getByText(new RegExp(`Before: ${w.before_the_patch.from} – ${w.before_the_patch.to} \\(${w.before_the_patch.days} days\\)\\. Since: ${w.since_the_patch.from} – ${w.since_the_patch.to} \\(${w.since_the_patch.days} days\\)\\. All brackets, public matches\\. A few days of a new patch: these will move\\.`))).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Data: STRATZ' }).getAttribute('href')).toBe('https://stratz.com');
    expect(screen.getByRole('link', { name: /Valve's 7\.42 notes/ }).getAttribute('href')).toBe('https://www.dota2.com/patches/7.42');
  });

  it('a question shows the lookups, then the answer; what could not be checked is said; the next turn carries the history', async () => {
    let n = 0;
    const calls = mockFetch({
      '/api/patch/chat': () => { n += 1; return n === 1 ? sse([{ step: { tool: 'meta_movers', args: { by: 'win_rate' } } }, { step: { tool: 'hero_patch', args: { hero: 'chen' }, about: 'Chen' } }, { text: 'Chen rose most.\n\nIt will move.', unverified: [] }, { done: true }]) : sse([{ text: 'About 99% sure.', unverified: [{ kind: 'number', text: '99%' }] }, { done: true }]); },
      '/api/patch?': overview('en'),
    });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Who got stronger and who got weaker since the patch?' }));
    expect(await screen.findByText('Chen rose most.')).toBeTruthy();
    expect(screen.getByText('It will move.')).toBeTruthy();
    expect(screen.getByText('Ranking who moved most')).toBeTruthy();
    expect(screen.getByText('Reading a hero\'s notes and numbers: Chen')).toBeTruthy();
    expect(JSON.parse(String(calls.find((c) => c.url.includes('/chat'))!.init!.body))).toEqual({ lang: 'en', question: 'Who got stronger and who got weaker since the patch?', history: [] });
    // The suggestions are for an empty conversation.
    expect(screen.queryByText('Try asking')).toBeNull();
    const box = screen.getByRole('textbox', { name: 'Ask the advisor' });
    fireEvent.change(box, { target: { value: 'How sure?' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText('About 99% sure.')).toBeTruthy();
    expect(screen.getByText('Not found in the notes or the numbers, treat with care: 99%')).toBeTruthy();
    expect(JSON.parse(String(calls.filter((c) => c.url.includes('/chat'))[1].init!.body))).toEqual({ lang: 'en', question: 'How sure?', history: [{ q: 'Who got stronger and who got weaker since the patch?', a: 'Chen rose most.\n\nIt will move.', clean: true }] });
  });

  it('a hero in a table is one click from a question about that hero, in the reader\'s language', async () => {
    const o = overview('zh');
    const calls = mockFetch({ '/api/patch/chat': () => sse([{ text: '答。' }, { done: true }]), '/api/patch?': o });
    show('zh');
    const name = o.win_rate_fell_most[0].name;
    fireEvent.click(within(await screen.findByRole('table', { name: '胜率下降' })).getByRole('button', { name }));
    expect(await screen.findByText('答。')).toBeTruthy();
    expect(JSON.parse(String(calls.find((c) => c.url.includes('/chat'))!.init!.body)).question).toBe(`${name}在 7.42 改了什么？胜率和出场率怎么变了？`);
    expect(calls[0].url).toBe('/api/patch?lang=zh');
    expect(screen.getByRole('heading', { level: 2, name: '7.42 版本顾问' })).toBeTruthy();
  });

  it('says why when it cannot answer, and keeps working when the numbers do not load', async () => {
    let reply: () => Response = () => refuse(429, 'rate_limited');
    mockFetch({ '/api/patch/chat': () => reply(), '/api/patch?': () => new Response('{}', { status: 500 }) });
    show();
    expect(await screen.findByText('The numbers could not be loaded.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    // The page's one input is the match box: the advisor's own opens when asked for.
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ask your own question…' }));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Ask the advisor' }));
    const ask = async (text: string) => { const box = screen.getByRole('textbox', { name: 'Ask the advisor' }); fireEvent.change(box, { target: { value: text } }); fireEvent.click(screen.getByRole('button', { name: 'Ask' })); };
    await ask('one');
    expect((await screen.findByRole('alert')).textContent).toBe('Too many questions — wait a minute and try again.');
    reply = () => refuse(503, 'unavailable');
    await ask('two');
    await waitFor(() => expect(screen.getAllByRole('alert').at(-1)!.textContent).toBe('The advisor cannot answer right now. The numbers on the left are still current.'));
    reply = () => refuse(503, 'busy');
    await ask('three');
    await waitFor(() => expect(screen.getAllByRole('alert').at(-1)!.textContent).toBe('The advisor is at capacity right now. Try again in a few minutes.'));
    reply = () => sse([{ error: 'no_answer' }, { done: true }]);
    await ask('four');
    await waitFor(() => expect(screen.getAllByRole('alert').at(-1)!.textContent).toBe('No answer came back. Try again.'));
    // An oversized question is stopped here, not sent.
    const box = screen.getByRole('textbox', { name: 'Ask the advisor' });
    fireEvent.change(box, { target: { value: 'x'.repeat(501) } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(screen.getByText('Keep the question under 500 characters.')).toBeTruthy();
  });

  it('formats shares, changes and ratios; a number the data lacks is a dash, not zero', () => {
    expect([pct(0.478), pct(0.0066), pct(null), pct(undefined)]).toEqual(['47.8%', '0.7%', '–', '–']);
    expect([points(4.8), points(-2.9), points(0), points(null)]).toEqual(['+4.8', '−2.9', '0.0', '–']);
    expect([times(1.97), times(0.4), times(null)]).toEqual(['×1.97', '×0.40', '–']);
    expect(advisorStepLabel({ tool: 'search_notes', args: { query: 'Roshan' }, about: 'Roshan' }, 'zh')).toBe('搜索更新日志：Roshan');
    // An engine key is never shown: without a name from the server the step stands alone.
    expect(advisorStepLabel({ tool: 'hero_patch', args: { hero: 'skeleton_king' } }, 'zh')).toBe('查英雄的改动和数据');
    expect(advisorStepLabel({ tool: 'patch_overview', args: {} }, 'zh')).toBe('看版本总览');
    expect(advisorStepLabel({ tool: 'something_new', args: {} }, 'en')).toBe('something_new');
  });

  it('follows the server\'s release in the title and links every release; says when the numbers are an older patch\'s (review of #335)', async () => {
    const o = overview('zh');
    mockFetch({ '/api/patch?': {
      ...o, patch: '7.43a', major_patch: '7.43', notes: 'https://www.dota2.com/patches/7.43a',
      releases: [{ version: '7.43', released: '', url: 'https://www.dota2.com/patches/7.43' }, { version: '7.43a', released: '', url: 'https://www.dota2.com/patches/7.43a' }],
      numbers: { ...o.numbers, numbers_patch: '7.42' },
    } });
    show('zh');
    expect(await screen.findByRole('heading', { level: 2, name: '7.43a 版本顾问' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '7.43 ↗' }).getAttribute('href')).toBe('https://www.dota2.com/patches/7.43');
    expect(screen.getByRole('link', { name: '7.43a ↗' }).getAttribute('href')).toBe('https://www.dota2.com/patches/7.43a');
    expect(screen.getByText('这些数字是 7.42 前后的，还不是 7.43 的。')).toBeTruthy();
  });

  it('numbers of the same patch as the notes: no such line', async () => {
    const o = overview('zh');
    mockFetch({ '/api/patch?': o });
    show('zh');
    await screen.findByRole('table', { name: '胜率上升' });
    expect(document.querySelector('.pa-old-numbers')).toBeNull();
    expect(document.querySelector('.pa-releases')).toBeNull();
  });
});
