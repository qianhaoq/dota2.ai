// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { trackEvent } from '../../services/analytics';
import { reviewViewed } from './analytics';
vi.mock('../../services/analytics', () => ({ trackEvent: vi.fn() }));
beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.clearAllMocks();
});
it('view is once per match+hero per session even across rerenders and restreams', () => {
    reviewViewed('123', '14', { lang: 'en' });
    reviewViewed('123', '14', { lang: 'zh' });
    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledWith('review_viewed', { ui: 'v2', surface: 'web', matchId: '123', lang: 'en' });
    reviewViewed('123', '1', {});
    reviewViewed('456', '14', {});
    expect(trackEvent).toHaveBeenCalledTimes(3);
    sessionStorage.clear();
    reviewViewed('123', '14', {});
    expect(trackEvent).toHaveBeenCalledTimes(4);
});
