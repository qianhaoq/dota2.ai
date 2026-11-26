/**
 * The review page's funnel from /api/events log lines (server.js writes one
 * `{ type: 'analytics', event, props, anonId, ts }` line per event): how many
 * browsers reached each step. Counted by anonId; an event without one cannot
 * be followed and is only counted in `anonymous`. Pure: no IO.
 *
 * Steps, each counted among browsers that opened a match page:
 *   opened     match_opened
 *   requested  review_requested
 *   refused    review_refused (a leak, not a step)
 *   viewed     review_viewed  (any review page that finished loading)
 *   own        review_ready   (the review they asked for, waited out)
 *   asked      chat_asked
 *   returned   return_visit; among those who opened, only one on a later day than their first match page
 *   shared     report_shared  (sent the game to the team, or their own review)
 *   arrived    match_opened with a `ref`: came in by someone's shared link
 *   goal       goal_set       (made a review's goal their next-game goal)
 *   checked    goal_checked   (that goal was judged on a later game: the loop closed)
 *   goalOnly   goal_check_requested (asked to check a goal without a review: not counted as `requested`)
 *   played     moment_played  (replayed a moment on the map: in a review, or while waiting for one)
 *   rated      finding_rated  (said whether a finding was right)
 *
 * `ratings`: what was said, counted by event — right / wrong / useless, and how many of them were about the
 * finding the page leads with. A change of mind is a second event; the word itself, one per reader per finding,
 * is kept by /api/agent/:id/feedback (scripts/feedback-report.mjs).
 *
 * `internal`: events left out, and from how many browsers. A browser that sent one event marked `internal: true`
 * (it was opened with `?internal=1`: the owner's, a session's check) is left out whole, also for what it did
 * before it was marked — five browsers asked for a review in the week of 2026-11-20 and nobody could say how
 * many were ours (#369).
 *
 * `loop`: the plan's north star — of the browsers that set a next-game goal, how many had it checked on a later
 * game within 7 days of setting it (goal_set, then goal_checked by the same browser). A goal set less than 7 days
 * before the last event of the window may still be checked: those are counted apart (`pending`), not as failures.
 *
 * `bySource`: for each community a post linked from (`?src=`, the `arrived` event), how many browsers came,
 * opened a match page, got the review they asked for, and shared. A browser counts for the first source it
 * came by in the window.
 */
const STEPS = ['opened', 'requested', 'refused', 'viewed', 'own', 'asked', 'returned', 'shared', 'arrived', 'goal', 'checked', 'goalOnly', 'played', 'rated'];
const RATINGS = ['right', 'wrong', 'useless'];

/** The analytics payload of a log entry: a Cloud Logging entry (jsonPayload) or the line itself. */
const payloadOf = (entry) => {
  const p = entry?.jsonPayload ?? entry;
  return p && p.type === 'analytics' && typeof p.event === 'string' ? p : null;
};

/**
 * @param {Iterable<unknown>} entries
 * @returns {{ browsers: Record<string, number>, ofOpened: Record<string, number>, anonymous: number, events: Record<string, number>, days: string[], bySource: Record<string, { came: number, opened: number, own: number, shared: number }> , ratings: { right: number, wrong: number, useless: number, on_the_first_finding: number }, internal: { events: number, browsers: number } , loop: { set: number, checked_within_7_days: number, pending: number, not_checked: number } }}
 */
export function summarizeFunnel(entries) {
  /** @type {Map<string, Set<string>>} */
  const reached = new Map(STEPS.map((s) => [s, new Set()]));
  const events = {};
  const days = new Set();
  /** Per browser: the first day it opened a match page, and the days it came back. */
  const firstOpen = new Map();
  const returns = new Map();
  let anonymous = 0;
  /** Per browser: when it first set a goal, and every time a goal of its was checked. */
  const goalSetAt = new Map(); const checkedAt = new Map(); let lastTs = null;
  const ratings = { right: 0, wrong: 0, useless: 0, on_the_first_finding: 0 };
  /** Per browser: the earliest community source it came by, and when (logs come newest first from gcloud). */
  const sourceOf = new Map();
  // A browser of ours (one event of it says internal: true) is left out whole: also its events from before it was
  // marked. Its events are counted, apart, so the reader of the funnel sees how much was left out.
  const all = [...entries];
  const ourBrowsers = new Set();
  for (const entry of all) { const p = payloadOf(entry); if (p?.internal === true && typeof p.anonId === 'string' && p.anonId) ourBrowsers.add(p.anonId); }
  let internalEvents = 0;
  for (const entry of all) {
    const p = payloadOf(entry);
    if (!p) continue;
    if (p.internal === true || ourBrowsers.has(p.anonId)) { internalEvents += 1; continue; }
    events[p.event] = (events[p.event] ?? 0) + 1;
    if (typeof p.ts === 'string') days.add(p.ts.slice(0, 10));
    // Counted with or without a browser id: a rating is a rating.
    if (p.event === 'finding_rated' && RATINGS.includes(p.props?.rating)) { ratings[p.props.rating] += 1; if (p.props.first === true) ratings.on_the_first_finding += 1; }
    if (typeof p.anonId !== 'string' || !p.anonId) { anonymous += 1; continue; }
    const step = {
      match_opened: 'opened',
      review_requested: 'requested',
      review_refused: 'refused',
      review_viewed: 'viewed',
      review_ready: 'own',
      chat_asked: 'asked',
      return_visit: 'returned',
      report_shared: 'shared',
      goal_set: 'goal',
      goal_checked: 'checked',
      goal_check_requested: 'goalOnly',
      moment_played: 'played',
      finding_rated: 'rated',
    }[p.event];
    if (step) reached.get(step).add(p.anonId);
    if (p.event === 'match_opened' && (p.props?.ref === 'team' || p.props?.ref === 'share')) reached.get('arrived').add(p.anonId);
    const src = typeof p.props?.src === 'string' && /^[a-z]{1,16}$/.test(p.props.src) ? p.props.src : null;
    // Earliest by time, whatever order the log lines come in; an entry without a time only fills a gap.
    const at = typeof p.ts === 'string' ? p.ts : null;
    const had = sourceOf.get(p.anonId);
    if (src && (!had || (at && (!had.at || at < had.at)))) sourceOf.set(p.anonId, { src, at });
    const day = typeof p.ts === 'string' ? p.ts.slice(0, 10) : null;
    if (day && p.event === 'match_opened' && !(firstOpen.get(p.anonId) <= day)) firstOpen.set(p.anonId, day);
    if (day && p.event === 'return_visit') returns.set(p.anonId, [...(returns.get(p.anonId) ?? []), day]);
    if (typeof p.ts === 'string' && (!lastTs || p.ts > lastTs)) lastTs = p.ts;
    if (typeof p.ts === 'string' && p.event === 'goal_set' && !(goalSetAt.get(p.anonId) <= p.ts)) goalSetAt.set(p.anonId, p.ts);
    if (typeof p.ts === 'string' && p.event === 'goal_checked') checkedAt.set(p.anonId, [...(checkedAt.get(p.anonId) ?? []), p.ts]);
  }
  const opened = reached.get('opened');
  const browsers = Object.fromEntries(STEPS.map((s) => [s, reached.get(s).size]));
  const ofOpened = Object.fromEntries(STEPS.map((s) => [s, [...reached.get(s)].filter((id) => opened.has(id)).length]));
  // A return the same day as the first match page (or before it) is not coming back after it.
  ofOpened.returned = [...firstOpen].filter(([id, first]) => (returns.get(id) ?? []).some((d) => d > first)).length;
  const bySource = {};
  for (const [id, { src }] of sourceOf) {
    const row = (bySource[src] ??= { came: 0, opened: 0, own: 0, shared: 0 });
    row.came += 1;
    if (opened.has(id)) row.opened += 1;
    if (reached.get('own').has(id)) row.own += 1;
    if (reached.get('shared').has(id)) row.shared += 1;
  }
  const WEEK = 7 * 86_400_000;
  const loop = { set: goalSetAt.size, checked_within_7_days: 0, pending: 0, not_checked: 0 };
  for (const [id, set] of goalSetAt) {
    const t0 = Date.parse(set);
    if ((checkedAt.get(id) ?? []).some((c) => { const t = Date.parse(c); return t >= t0 && t - t0 <= WEEK; })) loop.checked_within_7_days += 1;
    else if (lastTs && Date.parse(lastTs) - t0 < WEEK) loop.pending += 1;
    else loop.not_checked += 1;
  }
  return { browsers, ofOpened, anonymous, events, days: [...days].sort(), bySource, ratings, internal: { events: internalEvents, browsers: ourBrowsers.size }, loop };
}

/** Log text as `gcloud logging read --format=json` prints it (one JSON array), or one JSON object per line. */
export function parseLogText(text) {
  const t = String(text ?? '').trim();
  if (!t) return [];
  if (t.startsWith('[')) { try { const a = JSON.parse(t); return Array.isArray(a) ? a : []; } catch { return []; } }
  return t.split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}
