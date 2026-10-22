// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ANON_ID_STORAGE_KEY, LAST_VISIT_DAY_STORAGE_KEY, localDayStamp } from '../utils/analyticsClient';
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); vi.resetModules();
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-23T12:00:00Z'));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('initialization alone emits return_visit with identity-scoped days once per session across reloads', async () => {
  const id = 'anon_123e4567-e89b-42d3-a456-426614174000';
  localStorage.setItem(ANON_ID_STORAGE_KEY, id);
  localStorage.setItem(LAST_VISIT_DAY_STORAGE_KEY, '2026-10-21');
  localStorage.setItem(`dota2ai.firstVisit.${id}`, String(Date.now() - 2 * 86400000));
  const { initAnalytics } = await import('./analytics');
  initAnalytics(); initAnalytics();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toEqual({ event: 'return_visit', props: { days_since_first: 2 }, anonId: id });
  vi.resetModules(); (await import('./analytics')).initAnalytics();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('first visit records timestamp; same-day new session remains silent', async () => {
  (await import('./analytics')).initAnalytics();
  const id = localStorage.getItem(ANON_ID_STORAGE_KEY);
  expect(localStorage.getItem(`dota2ai.firstVisit.${id}`)).toBe(String(Date.now()));
  expect(localStorage.getItem(LAST_VISIT_DAY_STORAGE_KEY)).toBe(localDayStamp());
  sessionStorage.clear(); vi.resetModules();
  (await import('./analytics')).initAnalytics();
  expect(fetch).not.toHaveBeenCalled();
});
