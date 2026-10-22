import { trackEvent } from '../../services/analytics';
import type { AnalyticsProps } from '../../utils/analyticsClient';
const memory = new Set<string>();
export function claimSession(key: string) {
    try {
        if (sessionStorage.getItem(key))
            return false;
        sessionStorage.setItem(key, '1');
        return true;
    }
    catch {
        if (memory.has(key))
            return false;
        memory.add(key);
        return true;
    }
}
export function reviewViewed(match: string, hero: string, props: AnalyticsProps) {
    if (claimSession(`d2.v2.view.${match}.${hero}`))
        trackEvent('review_viewed', { ...props, ui: 'v2', surface: 'web', matchId: match });
}
