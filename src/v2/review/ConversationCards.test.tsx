// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '../i18n/I18nProvider';
import TopBar from '../components/TopBar';
import { HeroGrid, HeroCollapsedRow, Share } from './ConversationCards';
import ResultHeader from './ResultHeader';
import type { Review } from './types';

const cases = [
  ['pudge', 'Pudge', '帕吉'],
  ['doom_bringer', 'Doom', '末日使者'],
  ['skeleton_king', 'Wraith King', '冥魂大帝'],
  ['life_stealer', 'Lifestealer', '噬魂鬼'],
  ['nyx_assassin', 'Nyx Assassin', '司夜刺客'],
  ['keeper_of_the_light', 'Keeper of the Light', '光之守卫'],
];
function wrap(content: React.ReactNode, lang = 'en') {
  window.localStorage.clear();
  return render(<MemoryRouter initialEntries={[`/m/9035042364?lang=${lang}`]}><I18nProvider>{content}</I18nProvider></MemoryRouter>);
}
afterEach(cleanup);
describe('review hero display names', () => {
  for (const lang of ['en', 'zh'] as const) {
    it.each(cases)(`localizes %s in all three surfaces (${lang})`, (slug, en, zh) => {
      const pick = vi.fn();
      const hero = { hero: slug, hero_id: 14, team: 'radiant' };
      wrap(<><HeroGrid roster={[hero]} pick={pick}/><HeroCollapsedRow hero={slug} change={() => {}}/><ResultHeader heroName={slug.replaceAll('_', ' ')} heroSlug={slug} kda="" isRadiant outcome="loss" duration="61:55"/></>, lang);
      const name = lang === 'en' ? en : zh;
      fireEvent.click(screen.getByRole('button', { name }));
      expect(pick).toHaveBeenCalledWith(hero);
      expect(screen.getByRole('heading', { name })).toBeTruthy();
      expect(screen.getByText(`${lang === 'en' ? 'You' : '你'}: ${name}`)).toBeTruthy();
    });
  }
  it.each(['en', 'zh'])('renders a nullable roster hero safely (%s)', lang => {
    wrap(<HeroGrid roster={[{ hero: null, hero_id: 0, team: 'radiant' } as any]} pick={() => {}}/>, lang);
    expect(screen.getByRole('button', { name: lang === 'zh' ? '未知英雄' : 'Unknown' })).toBeTruthy();
  });
  it('uses the prototype heading and note typography', () => {
    wrap(<HeroGrid roster={[]} pick={() => {}}/>);
    expect(screen.getByRole('heading').className).toContain('text-d2-17 font-semibold');
    expect(screen.getByText('Pick the hero you played to focus the review.').className).toContain('text-d2-13 text-d2-ink-3');
  });
});
it.each(['en', 'zh'])('keeps the sample review toolbar compact with accessible 44px controls (%s)', lang => {
  wrap(<TopBar action={<Share matchId="9035042364" hero="pudge" lang={lang} claim="" review={{} as Review}/>}/>, lang);
  const share = screen.getByRole('button', { name: lang === 'en' ? 'Share' : '分享' });
  expect(share.querySelector('span')?.className).toBe('hidden sm:inline');
  expect(screen.getByText(lang === 'en' ? 'Sample data' : '示例数据').parentElement?.className).toContain('hidden min-[400px]:inline-flex');
  const controls = screen.getAllByRole('button').filter(button => button.getAttribute('aria-label'));
  expect(controls).toHaveLength(4);
  for (const button of controls) {
    expect(button.className).toContain('min-w-[44px]');
    expect(button.className).toContain('min-h-[44px]');
  }
});
