import { describe, it, expect } from 'vitest';
import { DEFAULT_FLAGS, parseFfOverride, resolveFlags } from './flags';

const NO_ENV: Record<string, string | undefined> = {};

describe('resolveFlags — env parsing', () => {
  it('defaults: v2 UI owns / (cutover), legacy pieces stay available', () => {
    expect(resolveFlags({ env: NO_ENV, pathname: '/', search: '' })).toEqual(DEFAULT_FLAGS);
  });

  it('reads VITE_FF_<NAME> as 1/0/true/false', () => {
    const env = {
      VITE_FF_UI_V2: '1',
      VITE_FF_LEGACY_MENTOR: '0',
      VITE_FF_LEGACY_TABS: 'true',
      VITE_FF_LEGACY_NEXT_ACTIONS: 'false',
      VITE_FF_FAKEDOOR_V2: 'true',
    };
    expect(resolveFlags({ env, pathname: '/', search: '' })).toEqual({
      ui_v2: true,
      legacy_mentor: false,
      legacy_tabs: true,
      legacy_next_actions: false,
      fakedoor_v2: true,
    });
  });

  it('ignores invalid env values (defaults stay in effect)', () => {
    const flags = resolveFlags({ env: { VITE_FF_UI_V2: 'yes', VITE_FF_FAKEDOOR_V2: '2' }, pathname: '/', search: '' });
    expect(flags.ui_v2).toBe(true);
    expect(flags.fakedoor_v2).toBe(true);
  });

  it('fakedoor_v2 kill switch: VITE_FF_FAKEDOOR_V2=0 hides the card', () => {
    const flags = resolveFlags({ env: { VITE_FF_FAKEDOOR_V2: '0' }, pathname: '/m/9035042364', search: '' });
    expect(flags.fakedoor_v2).toBe(false);
    expect(flags.ui_v2).toBe(true);
  });

  it('rollback lever: VITE_FF_UI_V2=0 puts the legacy app back on /', () => {
    const flags = resolveFlags({ env: { VITE_FF_UI_V2: '0' }, pathname: '/', search: '' });
    expect(flags.ui_v2).toBe(false);
    // Route-forced surfaces are unaffected by the rollback env.
    expect(resolveFlags({ env: { VITE_FF_UI_V2: '0' }, pathname: '/m/9035042364', search: '' }).ui_v2).toBe(true);
    expect(resolveFlags({ env: { VITE_FF_UI_V2: '0' }, pathname: '/new', search: '' }).ui_v2).toBe(true);
  });
});

describe('resolveFlags — route forcing', () => {
  const env = { VITE_FF_UI_V2: '0', VITE_FF_LEGACY_MENTOR: '1' };

  it('/new and /m force ui_v2 on and legacy_* off', () => {
    for (const pathname of ['/new', '/new/preview', '/m/9035042364']) {
      const flags = resolveFlags({ env, pathname, search: '' });
      expect(flags.ui_v2, pathname).toBe(true);
      expect(flags.legacy_mentor, pathname).toBe(false);
      expect(flags.legacy_tabs, pathname).toBe(false);
      expect(flags.legacy_next_actions, pathname).toBe(false);
    }
  });

  it('/legacy forces ui_v2 off and legacy_* on', () => {
    for (const pathname of ['/legacy', '/legacy/tactical']) {
      const flags = resolveFlags({ env: { VITE_FF_UI_V2: '1', VITE_FF_LEGACY_TABS: '0' }, pathname, search: '' });
      expect(flags.ui_v2, pathname).toBe(false);
      expect(flags.legacy_mentor, pathname).toBe(true);
      expect(flags.legacy_tabs, pathname).toBe(true);
      expect(flags.legacy_next_actions, pathname).toBe(true);
    }
  });

  it('/ keeps env defaults (everything visible)', () => {
    const flags = resolveFlags({ env: NO_ENV, pathname: '/', search: '' });
    expect(flags.legacy_mentor && flags.legacy_tabs && flags.legacy_next_actions).toBe(true);
  });
});

describe('resolveFlags — ?ff= override', () => {
  it('parses name:1, other:0, bare name (on) and -name (off)', () => {
    expect(parseFfOverride('ui_v2:1,legacy_tabs:0,fakedoor_v2,-legacy_mentor')).toEqual({
      ui_v2: true,
      legacy_tabs: false,
      fakedoor_v2: true,
      legacy_mentor: false,
    });
    expect(parseFfOverride('bogus:1,ui_v2:maybe')).toEqual({});
    expect(parseFfOverride(null)).toEqual({});
  });

  it('applies when allowOverride is true', () => {
    const flags = resolveFlags({ env: NO_ENV, pathname: '/', search: '?ff=ui_v2:1,-legacy_tabs', allowOverride: true });
    expect(flags.ui_v2).toBe(true);
    expect(flags.legacy_tabs).toBe(false);
  });

  it('is ignored when not allowed', () => {
    const flags = resolveFlags({ env: NO_ENV, pathname: '/', search: '?ff=-ui_v2,-legacy_tabs', allowOverride: false });
    // ui_v2 stays on its default (cutover) value — the override is ignored.
    expect(flags.ui_v2).toBe(true);
    expect(flags.legacy_tabs).toBe(true);
  });

  it('is always allowed on /new (preview prefix), still beating route forcing', () => {
    const flags = resolveFlags({ env: NO_ENV, pathname: '/new', search: '?ff=legacy_mentor:1,ui_v2:0', allowOverride: false });
    expect(flags.legacy_mentor).toBe(true);
    expect(flags.ui_v2).toBe(false);
  });

  it('preview kill switch: /new?ff=-fakedoor_v2 hides the card', () => {
    const flags = resolveFlags({ env: NO_ENV, pathname: '/new', search: '?ff=-fakedoor_v2', allowOverride: false });
    expect(flags.fakedoor_v2).toBe(false);
  });
});
