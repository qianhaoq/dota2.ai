// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CURRENT_PATCH, readPatchNews } from './patch';

vi.mock('../v2/i18n/I18nProvider', () => ({ useI18n: () => ({ lang: 'zh', setLang: () => {} }) }));
const { CoachHome } = await import('./CoachApp');
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
    // Home v3 order: the search box, the live sample review, the four ways to use it, then the patch as one line.
    // (The three "principles" cards are gone; their message is in the subtitle.)
    const order = [...container.querySelectorAll('.cx-hero, .hm-how, .hm-ways, .cx-patch, .cx-principles')].map((e) => e.classList[0]);
    expect(order).toEqual(['cx-hero', 'hm-how', 'hm-ways', 'cx-patch']);
    // The patch advisor stands right after the first screen, before the ways to connect.
    const withAdvisor = [...container.querySelectorAll('.hm-how, .pa, .hm-ways')].map((el) => el.className.split(' ')[0]);
    expect(withAdvisor).toEqual(['hm-how', 'pa', 'hm-ways']);
  });

  const live = {
    version: '7.43', date: '2026-12-20', url: 'https://www.dota2.com/patches/7.43', picking: false,
    newItems: [{ key: 'caduceus', en: 'Caduceus', zh: '双蛇杖' }],
    highlights: [{ en: 'Roshan: Respawns faster', zh: '肉山：复活更快' }, { en: 'Smoke now makes neutrals flee', zh: null }],
    forCoach: { en: 'Benchmarks lag', zh: '对比滞后' },
    update: { version: '7.43a', date: '2026-12-24', url: 'https://www.dota2.com/patches/7.43a', changes: { heroes: 40, items: 4 } },
  };
  const serve = (body: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    expect(url).toBe('/api/patch/news');
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
});
