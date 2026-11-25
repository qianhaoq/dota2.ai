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
 *
 * `bySource`: for each community a post linked from (`?src=`, the `arrived` event), how many browsers came,
 * opened a match page, got the review they asked for, and shared. A browser counts for the first source it
 * came by in the window.
 */
const STEPS = ['opened', 'requested', 'refused', 'viewed', 'own', 'asked', 'returned', 'shared', 'arrived'];

/** The analytics payload of a log entry: a Cloud Logging entry (jsonPayload) or the line itself. */
const payloadOf = (entry) => {
  const p = entry?.jsonPayload ?? entry;
  return p && p.type === 'analytics' && typeof p.event === 'string' ? p : null;
};

/**
 * @param {Iterable<unknown>} entries
 * @returns {{ browsers: Record<string, number>, ofOpened: Record<string, number>, anonymous: number, events: Record<string, number>, days: string[], bySource: Record<string, { came: number, opened: number, own: number, shared: number }> }}
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
  /** Per browser: the first community source it came by. */
  const sourceOf = new Map();
  for (const entry of entries) {
    const p = payloadOf(entry);
    if (!p) continue;
    events[p.event] = (events[p.event] ?? 0) + 1;
    if (typeof p.ts === 'string') days.add(p.ts.slice(0, 10));
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
    }[p.event];
    if (step) reached.get(step).add(p.anonId);
    if (p.event === 'match_opened' && (p.props?.ref === 'team' || p.props?.ref === 'share')) reached.get('arrived').add(p.anonId);
    const src = typeof p.props?.src === 'string' && /^[a-z]{1,16}$/.test(p.props.src) ? p.props.src : null;
    if (src && !sourceOf.has(p.anonId)) sourceOf.set(p.anonId, src);
    const day = typeof p.ts === 'string' ? p.ts.slice(0, 10) : null;
    if (day && p.event === 'match_opened' && !(firstOpen.get(p.anonId) <= day)) firstOpen.set(p.anonId, day);
    if (day && p.event === 'return_visit') returns.set(p.anonId, [...(returns.get(p.anonId) ?? []), day]);
  }
  const opened = reached.get('opened');
  const browsers = Object.fromEntries(STEPS.map((s) => [s, reached.get(s).size]));
  const ofOpened = Object.fromEntries(STEPS.map((s) => [s, [...reached.get(s)].filter((id) => opened.has(id)).length]));
  // A return the same day as the first match page (or before it) is not coming back after it.
  ofOpened.returned = [...firstOpen].filter(([id, first]) => (returns.get(id) ?? []).some((d) => d > first)).length;
  const bySource = {};
  for (const [id, src] of sourceOf) {
    const row = (bySource[src] ??= { came: 0, opened: 0, own: 0, shared: 0 });
    row.came += 1;
    if (opened.has(id)) row.opened += 1;
    if (reached.get('own').has(id)) row.own += 1;
    if (reached.get('shared').has(id)) row.shared += 1;
  }
  return { browsers, ofOpened, anonymous, events, days: [...days].sort(), bySource };
}

/** Log text as `gcloud logging read --format=json` prints it (one JSON array), or one JSON object per line. */
export function parseLogText(text) {
  const t = String(text ?? '').trim();
  if (!t) return [];
  if (t.startsWith('[')) { try { const a = JSON.parse(t); return Array.isArray(a) ? a : []; } catch { return []; } }
  return t.split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}
