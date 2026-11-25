// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pageKind, sourceFrom } from '../utils/analyticsClient';
import { TRAFFIC_SOURCES } from '../../lib/analyticsEvents.js';

describe('community link source', () => {
  it('reads ?src= only when it is a known source', () => {
    expect(sourceFrom('?src=nga', TRAFFIC_SOURCES)).toBe('nga');
    expect(sourceFrom('?lang=zh&src=XHH', TRAFFIC_SOURCES)).toBe('xhh');
    expect(sourceFrom('?src=some%20post', TRAFFIC_SOURCES)).toBeNull();
    expect(sourceFrom('', TRAFFIC_SOURCES)).toBeNull();
    expect(pageKind('/')).toBe('home');
    expect(pageKind('/r/9100904020')).toBe('match');
    expect(pageKind('/r/9100904020/x')).toBe('other');
  });

  afterEach(() => { vi.resetModules(); window.sessionStorage.clear(); window.localStorage.clear(); delete (navigator as any).sendBeacon; window.history.replaceState(null, '', '/'); });

  async function boot(path: string) {
    window.history.replaceState(null, '', path);
    const sent: Blob[] = [];
    (navigator as any).sendBeacon = (_u: string, b: Blob) => { sent.push(b); return true; };
    const mod = await import('./analytics');
    mod.initAnalytics();
    const read = (b: Blob) => new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsText(b); });
    const events = await Promise.all(sent.map((b) => read(b).then((t) => JSON.parse(t))));
    return { mod, events };
  }

  it('a visit by a community link says where it came from once, and the session keeps the source', async () => {
    const { mod, events } = await boot('/r/9100904020?src=nga&lang=zh');
    expect(events.filter((e) => e.event === 'arrived').map((e) => e.props)).toEqual([{ src: 'nga', page: 'match' }]);
    expect(mod.trafficSource()).toBe('nga');
    // A later page load in the same session (another link, another source) keeps the first source and is not a new arrival.
    vi.resetModules();
    const again = await boot('/?src=bili');
    expect(again.events.filter((e) => e.event === 'arrived')).toEqual([]);
    expect(again.mod.trafficSource()).toBe('nga');
  });

  it('a visit without a known source sends no arrival and has no source', async () => {
    const { mod, events } = await boot('/r/9100904020?src=elsewhere');
    expect(events.filter((e) => e.event === 'arrived')).toEqual([]);
    expect(mod.trafficSource()).toBeNull();
  });
});
