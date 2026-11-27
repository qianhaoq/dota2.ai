// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CURRENT_PATCH, readPatchNews } from './patch';

vi.mock('../v2/i18n/I18nProvider', () => ({ useI18n: () => ({ lang: 'zh', setLang: () => {} }) }));
const { CoachHome, PATCH_NEWS_RETRIES } = await import('./CoachApp');
const NAMES = JSON.parse(readFileSync(path.join(process.cwd(), 'lib/coach/data/names.json'), 'utf8'));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('current patch on the home page', () => {
  it('matches the names table the coach uses', () => {
    expect(NAMES.patch).toBe(CURRENT_PATCH.version);
    for (const it of CURRENT_PATCH.newItems) {
      expect(NAMES.items[it.key], it.key).toBeTruthy();
      expect({ en: it.en, zh: it.zh }).toEqual({ en: NAMES.items[it.key].en, zh: NAMES.items[it.key].zh });
    }
  });

  it('shows the patch, its new items and a link to the notes', () => {
    const { container } = render(<MemoryRouter><CoachHome /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: '7.42 版本已上线' })).toBeTruthy();
    expect(container.querySelectorAll('.cx-patch-list li')).toHaveLength(CURRENT_PATCH.highlights.length);
    expect(container.querySelectorAll('.cx-patch-item')).toHaveLength(CURRENT_PATCH.newItems.length);
    expect(screen.getByText('双蛇杖')).toBeTruthy();
    expect(screen.getByRole('link', { name: /完整更新日志/ }).getAttribute('href')).toBe('https://www.dota2.com/patches/7.42');
    // Home order: the search box and what happens next, then the 3-step DeepSeek Harness / ways block,
    // then the patch as one block (Valve's news as the strip on top of the advisor).
    const order = [...container.querySelectorAll('.cx-hero, .hm-how, .cx-patch, .pa, .hm-ways, .cx-principles')].map((e) => e.classList[0]);
    expect(order).toEqual(['cx-hero', 'hm-how', 'hm-ways', 'cx-patch', 'pa']);
    expect(container.querySelector('.hm-patch > .cx-patch + .pa')).toBeTruthy();
  });

  const live = {
    version: '7.43', date: '2026-12-20', url: 'https://www.dota2.com/patches/7.43', picking: false,
    newItems: [{ key: 'caduceus', en: 'Caduceus', zh: '双蛇杖' }],
    highlights: [{ en: 'Roshan: Respawns faster', zh: '肉山：复活更快' }, { en: 'Smoke now makes neutrals flee', zh: null }],
    forCoach: { en: 'Benchmarks lag', zh: '对比滞后' },
    update: { version: '7.43a', date: '2026-12-24', url: 'https://www.dota2.com/patches/7.43a', changes: { heroes: 40, items: 4 } },
  };
  const serve = (body: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url !== '/api/patch/news') return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }));

  it('replaces the shipped patch with the live one from Valve: its lines, items, update and links', async () => {
    serve(live);
    const { container } = render(<MemoryRouter><CoachHome /></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: '7.43 版本已上线' })).toBeTruthy();
    expect([...container.querySelectorAll('.cx-patch-list li')].map((li) => li.textContent)).toEqual(['肉山：复活更快', 'Smoke now makes neutrals flee']);
    expect(container.querySelectorAll('.cx-patch-item')).toHaveLength(1);
    expect(screen.getByRole('link', { name: /完整更新日志/ }).getAttribute('href')).toBe('https://www.dota2.com/patches/7.43');
    expect(screen.getByRole('link', { name: '7.43a 更新 ↗' }).getAttribute('href')).toBe('https://www.dota2.com/patches/7.43a');
    expect(container.querySelector('.hm-patch-update')?.textContent).toContain('40 位英雄、4 件物品调整');
    expect(container.querySelector('.cx-patch-coach')?.textContent).toContain('对比滞后');
  });

  it('keeps the shipped patch when the server has none, or sends something else', async () => {
    serve({ code: 'patch_news_unavailable' }, 503);
    const { container } = render(<MemoryRouter><CoachHome /></MemoryRouter>);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.getByRole('heading', { name: `${CURRENT_PATCH.version} 版本已上线` })).toBeTruthy();
    expect(container.querySelectorAll('.cx-patch-list li')).toHaveLength(CURRENT_PATCH.highlights.length);
    expect(readPatchNews({ ...live, url: 'https://evil.example/7.43' })).toBeNull();
    expect(readPatchNews(null)).toBeNull();
  });

  it('while the server is still choosing highlights for the shipped patch, the shipped ones stand in; for another patch, none', () => {
    expect(readPatchNews({ ...live, version: CURRENT_PATCH.version, highlights: [], picking: true })?.highlights).toEqual(CURRENT_PATCH.highlights);
    expect(readPatchNews({ ...live, highlights: [], picking: true })?.highlights).toEqual([]);
    expect(readPatchNews({ ...live, forCoach: null, update: null })).toMatchObject({ forCoach: null, update: null });
  });

  it('while highlights are being chosen it asks again past the browser cache, until they are there (review of #326)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const answers = [{ ...live, highlights: [], picking: true }, { ...live, highlights: [], picking: true }, live];
      const calls: (RequestInit | undefined)[] = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (url !== '/api/patch/news') return new Response('{}', { status: 404 });
        calls.push(init);
        return new Response(JSON.stringify(answers[Math.min(calls.length - 1, answers.length - 1)]), { status: 200 });
      }));
      const { container } = render(<MemoryRouter><CoachHome /></MemoryRouter>);
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]?.cache).toBeUndefined();
      await vi.advanceTimersByTimeAsync(20_000);
      await waitFor(() => expect(calls).toHaveLength(2));
      await vi.advanceTimersByTimeAsync(20_000);
      await waitFor(() => expect(container.querySelectorAll('.cx-patch-list li')).toHaveLength(2));
      expect(calls).toHaveLength(3);
      expect(calls.slice(1).map((c) => c?.cache)).toEqual(['no-store', 'no-store']);
      // Done choosing: no more requests.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after PATCH_NEWS_RETRIES retries if the server never finishes choosing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let n = 0;
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url !== '/api/patch/news') return new Response('{}', { status: 404 });
        n += 1;
        return new Response(JSON.stringify({ ...live, highlights: [], picking: true }), { status: 200 });
      }));
      render(<MemoryRouter><CoachHome /></MemoryRouter>);
      await waitFor(() => expect(n).toBe(1));
      for (let i = 0; i < PATCH_NEWS_RETRIES + 3; i++) await vi.advanceTimersByTimeAsync(20_000);
      expect(n).toBe(PATCH_NEWS_RETRIES + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});
