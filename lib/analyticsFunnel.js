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
 *   own        review_viewed with own: true (the one they asked for, waited out)
 *   asked      chat_asked
 *   returned   return_visit on a later day
 */
const STEPS = ['opened', 'requested', 'refused', 'viewed', 'own', 'asked', 'returned'];

/** The analytics payload of a log entry: a Cloud Logging entry (jsonPayload) or the line itself. */
const payloadOf = (entry) => {
  const p = entry?.jsonPayload ?? entry;
  return p && p.type === 'analytics' && typeof p.event === 'string' ? p : null;
};

/**
 * @param {Iterable<unknown>} entries
 * @returns {{ browsers: Record<string, number>, ofOpened: Record<string, number>, anonymous: number, events: Record<string, number>, days: string[] }}
 */
export function summarizeFunnel(entries) {
  /** @type {Map<string, Set<string>>} */
  const reached = new Map(STEPS.map((s) => [s, new Set()]));
  const events = {};
  const days = new Set();
  let anonymous = 0;
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
      chat_asked: 'asked',
      return_visit: 'returned',
    }[p.event];
    if (step) reached.get(step).add(p.anonId);
    if (p.event === 'review_viewed') {
      reached.get('viewed').add(p.anonId);
      if (p.props?.own === true) reached.get('own').add(p.anonId);
    }
  }
  const opened = reached.get('opened');
  const browsers = Object.fromEntries(STEPS.map((s) => [s, reached.get(s).size]));
  const ofOpened = Object.fromEntries(STEPS.map((s) => [s, [...reached.get(s)].filter((id) => opened.has(id)).length]));
  return { browsers, ofOpened, anonymous, events, days: [...days].sort() };
}

/** Log text as `gcloud logging read --format=json` prints it (one JSON array), or one JSON object per line. */
export function parseLogText(text) {
  const t = String(text ?? '').trim();
  if (!t) return [];
  if (t.startsWith('[')) { try { const a = JSON.parse(t); return Array.isArray(a) ? a : []; } catch { return []; } }
  return t.split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}
