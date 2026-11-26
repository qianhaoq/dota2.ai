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
    expect(out.browsers).toEqual({ opened: 2, requested: 1, refused: 1, viewed: 3, own: 1, asked: 1, returned: 2, shared: 0, arrived: 0, goal: 0, checked: 0, goalOnly: 0, played: 0, rated: 0, failed: 0 });
    expect(out.ofOpened).toEqual({ opened: 2, requested: 1, refused: 1, viewed: 2, own: 1, asked: 1, returned: 1, shared: 0, arrived: 0, goal: 0, checked: 0, goalOnly: 0, played: 0, rated: 0, failed: 0 });
    expect(out.anonymous).toBe(1);
    expect(out.events).toMatchObject({ match_opened: 3, chat_asked: 2, review_viewed: 3 });
    expect(out.days).toEqual(['2026-11-24', '2026-11-25']);
    // A return before the first match page, or with no time on it, does not count as coming back.
    expect(summarizeFunnel([line('return_visit', 'anon_d', {}, '2026-11-23T10:00:00Z'), line('match_opened', 'anon_d'), { type: 'analytics', event: 'return_visit', anonId: 'anon_d', props: {} }]).ofOpened.returned).toBe(0);
  });

  it('says where the browsers that asked went: got it, shown only a failure (and why), or neither', () => {
    const fail = (id: string, stage: string, reason: string, final = false) => line('review_failed', id, { stage, reason, final });
    const out = summarizeFunnel([
      // Got it after a failed try: counted as own, and its failure is still counted under its reason.
      line('review_requested', 'anon_a'), fail('anon_a', 'parse', 'no_replay_url'), line('review_ready', 'anon_a'),
      // Shown that the replay is gone; and an old game asked for twice: one browser.
      line('review_requested', 'anon_b'), fail('anon_b', 'parse', 'replay_gone', true), fail('anon_b', 'parse', 'replay_gone', true),
      // The model account was empty.
      line('review_requested', 'anon_c'), fail('anon_c', 'review', 'model_out_of_credit'),
      // Asked and left while it was being made.
      line('review_requested', 'anon_d'),
      // A failure without a request in the window is counted under its reason, not as an asker.
      fail('anon_e', 'parse', 'download_failed'),
      // A stage or reason the funnel does not know is not counted under any reason.
      line('review_failed', 'anon_f', { stage: 'chat', reason: 'x' }), line('review_failed', 'anon_f', { stage: 'parse' }),
    ]);
    expect(out.outcome).toEqual({ asked: 4, own: 1, failed: 2, neither: 1 });
    expect(out.failures).toEqual({ parse: { replay_gone: 1, no_replay_url: 1, download_failed: 1 }, review: { model_out_of_credit: 1 } });
    expect(out.browsers.failed).toBe(5);
    // Nothing asked: all zero.
    expect(summarizeFunnel([]).outcome).toEqual({ asked: 0, own: 0, failed: 0, neither: 0 });
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

  it('counts the next-game loop: who set a goal, and whose goal was checked on a later game', () => {
    const out = summarizeFunnel([
      line('match_opened', 'anon_g'), line('goal_set', 'anon_g', { kind: 'hold_item' }), line('goal_checked', 'anon_g', { result: 'met' }, '2026-11-26T10:00:00Z'),
      line('match_opened', 'anon_h'), line('goal_set', 'anon_h', { kind: 'deaths_per10_max' }),
    ]);
    expect(out.browsers).toMatchObject({ goal: 2, checked: 1 });
    expect(out.ofOpened).toMatchObject({ goal: 2, checked: 1 });
  });

  it('the north star: of the browsers that set a goal, who had it checked on a later game within 7 days', () => {
    const out = summarizeFunnel([
      line('goal_set', 'anon_a', {}, '2026-11-01T10:00:00Z'), line('goal_checked', 'anon_a', { result: 'met' }, '2026-11-04T10:00:00Z'),
      // Checked, but on day 9: not within the week.
      line('goal_set', 'anon_b', {}, '2026-11-01T10:00:00Z'), line('goal_checked', 'anon_b', { result: 'missed' }, '2026-11-10T10:00:00Z'),
      line('goal_set', 'anon_c', {}, '2026-11-02T10:00:00Z'),
      // Set two days before the last event: it may yet be checked — pending, not a failure.
      line('goal_set', 'anon_d', {}, '2026-11-18T10:00:00Z'), line('match_opened', 'anon_e', {}, '2026-11-20T10:00:00Z'),
      // A check before any goal was set by that browser does not count for it.
      line('goal_checked', 'anon_f', { result: 'met' }, '2026-11-01T09:00:00Z'), line('goal_set', 'anon_f', {}, '2026-11-01T10:00:00Z'),
    ]);
    expect(out.loop).toEqual({ set: 5, checked_within_7_days: 1, pending: 1, not_checked: 3 });
    expect(summarizeFunnel([line('match_opened', 'anon_a')]).loop).toEqual({ set: 0, checked_within_7_days: 0, pending: 0, not_checked: 0 });
  });

  it('a goal check without a review is its own step, not a request for a review', () => {
    const out = summarizeFunnel([line('match_opened', 'anon_q'), line('goal_check_requested', 'anon_q'), line('goal_checked', 'anon_q', { result: 'met' })]);
    expect(out.browsers).toMatchObject({ opened: 1, requested: 0, goalOnly: 1, checked: 1 });
  });

  it('counts who replayed a moment and who rated a finding, and what was said', () => {
    const e = (event: string, anonId: string | null, props: object = {}) => ({ type: 'analytics', event, anonId, props, ts: '2026-11-25T10:00:00.000Z' });
    const out = summarizeFunnel([
      e('match_opened', 'a'), e('match_opened', 'b'), e('match_opened', 'c'),
      e('moment_played', 'a'), e('moment_played', 'a'), e('moment_played', 'b'), e('moment_played', 'z'),
      e('finding_rated', 'a', { rating: 'right', first: true }), e('finding_rated', 'a', { rating: 'wrong', first: false }),
      // A change of mind is a second event; one without a browser id still counts as a rating; a rating that is none does not.
      e('finding_rated', 'a', { rating: 'useless', first: false }), e('finding_rated', null, { rating: 'wrong', first: true }), e('finding_rated', 'c', { rating: 'excellent' }),
    ]);
    // z replayed without opening a match page here (a waiting screen reached another way): a browser, not "of those who opened".
    expect(out.browsers).toMatchObject({ opened: 3, played: 3, rated: 2 });
    expect(out.ofOpened).toMatchObject({ played: 2, rated: 2 });
    expect(out.ratings).toEqual({ right: 1, wrong: 2, useless: 1, on_the_first_finding: 2 });
    // Nothing rated: zeros, and the script prints no line for it.
    expect(summarizeFunnel([e('match_opened', 'a')]).ratings).toEqual({ right: 0, wrong: 0, useless: 0, on_the_first_finding: 0 });
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
