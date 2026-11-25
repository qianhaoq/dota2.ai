import { describe, expect, it } from 'vitest';
import { parseLogText, summarizeFunnel } from '../../lib/analyticsFunnel.js';

const line = (event: string, anonId: string | null, props: Record<string, unknown> = {}, ts = '2026-11-24T01:00:00Z') => ({ type: 'analytics', event, props, anonId, ts });

describe('the review page funnel from event logs', () => {
  it('counts browsers per step, and among those who opened a match page', () => {
    const entries = [
      line('match_opened', 'anon_a'), line('review_requested', 'anon_a'), line('review_refused', 'anon_a', { reason: 'rate' }),
      line('review_requested', 'anon_a'), line('review_viewed', 'anon_a'), line('review_ready', 'anon_a'), line('chat_asked', 'anon_a'), line('chat_asked', 'anon_a'),
      line('return_visit', 'anon_a', {}, '2026-11-25T09:00:00Z'),
      // A returning browser's visit is logged as the app starts, before its first match page that day: not a return after it.
      line('return_visit', 'anon_b', {}, '2026-11-24T00:59:00Z'), line('match_opened', 'anon_b'), line('review_viewed', 'anon_b'),
      // Came straight to a review from a link, without a match_opened in the window.
      line('review_viewed', 'anon_c'),
      line('match_opened', null),
      { type: 'other', event: 'match_opened', anonId: 'anon_x' },
    ];
    const out = summarizeFunnel(entries);
    expect(out.browsers).toEqual({ opened: 2, requested: 1, refused: 1, viewed: 3, own: 1, asked: 1, returned: 2, shared: 0, arrived: 0 });
    expect(out.ofOpened).toEqual({ opened: 2, requested: 1, refused: 1, viewed: 2, own: 1, asked: 1, returned: 1, shared: 0, arrived: 0 });
    expect(out.anonymous).toBe(1);
    expect(out.events).toMatchObject({ match_opened: 3, chat_asked: 2, review_viewed: 3 });
    expect(out.days).toEqual(['2026-11-24', '2026-11-25']);
    // A return before the first match page, or with no time on it, does not count as coming back.
    expect(summarizeFunnel([line('return_visit', 'anon_d', {}, '2026-11-23T10:00:00Z'), line('match_opened', 'anon_d'), { type: 'analytics', event: 'return_visit', anonId: 'anon_d', props: {} }]).ofOpened.returned).toBe(0);
  });

  it('counts who shared, and who came in by a shared link', () => {
    const out = summarizeFunnel([
      line('match_opened', 'anon_a'), line('report_shared', 'anon_a', { target: 'team', method: 'copy' }), line('report_shared', 'anon_a', { target: 'self', method: 'copy' }),
      line('match_opened', 'anon_t', { ref: 'team' }), line('review_ready', 'anon_t'),
      line('match_opened', 'anon_s', { ref: 'share' }),
      // A ref the page does not send is not an arrival by link.
      line('match_opened', 'anon_z', { ref: 'ad' }),
    ]);
    expect(out.browsers).toMatchObject({ opened: 4, shared: 1, arrived: 2, own: 1 });
    expect(out.ofOpened).toMatchObject({ shared: 1, arrived: 2 });
    expect(out.events.report_shared).toBe(2);
  });

  it('splits browsers by the community link they came by, first source wins', () => {
    const out = summarizeFunnel([
      line('arrived', 'anon_n', { src: 'nga', page: 'match' }), line('match_opened', 'anon_n', { src: 'nga' }), line('review_ready', 'anon_n', { src: 'nga' }), line('report_shared', 'anon_n', { target: 'team' }),
      line('arrived', 'anon_m', { src: 'nga', page: 'home' }),
      // Came by Bilibili first, later by NGA: counted for Bilibili.
      line('arrived', 'anon_b', { src: 'bili', page: 'home' }), line('match_opened', 'anon_b', { src: 'bili' }), line('arrived', 'anon_b', { src: 'nga', page: 'match' }),
      line('match_opened', 'anon_plain'),
    ]);
    expect(out.bySource).toEqual({ nga: { came: 2, opened: 1, own: 1, shared: 1 }, bili: { came: 1, opened: 1, own: 0, shared: 0 } });
    expect(out.events.arrived).toBe(4);
  });

  it('first source means earliest in time, in whatever order the log comes (gcloud prints newest first)', () => {
    const entries = [
      line('arrived', 'anon_r', { src: 'nga', page: 'home' }, '2026-11-24T10:00:00Z'),
      line('arrived', 'anon_r', { src: 'bili', page: 'home' }, '2026-11-25T10:00:00Z'),
    ];
    expect(summarizeFunnel(entries).bySource).toEqual({ nga: { came: 1, opened: 0, own: 0, shared: 0 } });
    expect(summarizeFunnel([...entries].reverse()).bySource).toEqual({ nga: { came: 1, opened: 0, own: 0, shared: 0 } });
  });

  it('reads gcloud JSON output (entries with jsonPayload) and one object per line', () => {
    const entries = [{ jsonPayload: line('match_opened', 'anon_a') }, { textPayload: 'Server is running' }];
    expect(summarizeFunnel(parseLogText(JSON.stringify(entries))).browsers.opened).toBe(1);
    const ndjson = [JSON.stringify(line('match_opened', 'anon_a')), 'not json', JSON.stringify(line('chat_asked', 'anon_a'))].join('\n');
    expect(summarizeFunnel(parseLogText(ndjson)).browsers).toMatchObject({ opened: 1, asked: 1 });
    expect(parseLogText('')).toEqual([]);
    expect(parseLogText('[broken')).toEqual([]);
  });
});
