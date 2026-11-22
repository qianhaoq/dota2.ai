// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CURRENT_PATCH } from './patch';

vi.mock('../v2/i18n/I18nProvider', () => ({ useI18n: () => ({ lang: 'zh', setLang: () => {} }) }));
const { CoachHome } = await import('./CoachApp');
const NAMES = JSON.parse(readFileSync(path.join(process.cwd(), 'lib/coach/data/names.json'), 'utf8'));

afterEach(cleanup);

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
    const order = [...container.querySelectorAll('.cx-hero, .hm-live, .hm-ways, .cx-patch, .cx-principles')].map((e) => e.classList[0]);
    expect(order).toEqual(['cx-hero', 'hm-live', 'hm-ways', 'cx-patch']);
  });
});
