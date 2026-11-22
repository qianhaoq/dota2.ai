/**
 * Self-hosted replay parsing: a Valve replay goes through our own copy of
 * OpenDota's parser (github.com/odota/parser, `GET /blob?replay_url=`), and
 * its output is merged with the Steam GC scoreboard into the OpenDota match
 * shape the coach engine reads. This is how "parse this match" keeps working
 * when OpenDota is down.
 *
 * What the parser gives: everything read from the replay (timelines, purchase
 * and kill logs, teamfights, wards, lane positions). What it cannot give, and
 * what therefore stays absent: benchmarks (OpenDota's percentiles across all
 * games), rank_tier, player names. Nothing here fills those in.
 *
 * Hard rule: the parser downloads whatever URL it is handed, so only Valve's
 * own replay addresses ever reach it (isAllowedValveReplayUrl).
 *
 * mergeGcAndParsed and the helpers are pure; createOdotaParserClient does I/O.
 * Lane assignment follows OpenDota's own method (odota/core svc/util/compute.ts
 * and laneMappings.ts, MIT), so a merged match reads like OpenDota's copy.
 */

/** Valve's replay CDN, exactly: http://replay<cluster>.valve.net/570/<match>_<salt>.dem.bz2 */
const VALVE_REPLAY = /^http:\/\/replay\d{1,5}\.valve\.net\/570\/[1-9]\d{0,14}_\d{1,12}\.dem\.bz2$/;

/** True only for a Valve replay address. Anything else must never reach the parser. */
export function isAllowedValveReplayUrl(url) {
  return typeof url === 'string' && VALVE_REPLAY.test(url);
}

function parserError(message, extra) {
  return Object.assign(new Error(message), { upstream: 'odota_parser', ...extra });
}

// ---- lane from positions (OpenDota's method) ----

/** 128x128 grid cell → lane: 1 bot, 2 mid, 3 top, 4 radiant jungle, 5 dire jungle. */
function laneAt(i, j) {
  if (Math.abs(i - (127 - j)) < 8) return 2;
  if (j < 27 || i < 27) return 3;
  if (j >= 100 || i >= 100) return 1;
  if (i < 50) return 5;
  if (i >= 77) return 4;
  return 2;
}

/**
 * Lane, lane role and roaming from the first ten minutes of positions.
 * lane_role: 1 safe, 2 mid, 3 off, 4 jungle. Null when there are no positions.
 * @param {Record<string, Record<string, number>>} lanePos
 * @param {boolean} radiant
 */
export function laneFromPositions(lanePos, radiant) {
  if (!lanePos || typeof lanePos !== 'object') return null;
  const counts = new Map();
  let total = 0;
  for (const [x, col] of Object.entries(lanePos)) {
    if (!col || typeof col !== 'object') continue;
    for (const [y, n] of Object.entries(col)) {
      const adjX = Number(x) - 64;
      const adjY = 128 - (Number(y) - 64);
      if (!Number.isInteger(adjX) || !Number.isInteger(adjY) || adjX < 0 || adjX > 127 || adjY < 0 || adjY > 127) continue;
      if (!Number.isFinite(n) || n <= 0) continue;
      const lane = laneAt(adjY, adjX);
      counts.set(lane, (counts.get(lane) ?? 0) + n);
      total += n;
    }
  }
  if (total === 0) return null;
  let lane = null;
  let best = 0;
  for (const [l, n] of counts) if (n > best) { best = n; lane = l; }
  const role = { 1: radiant ? 1 : 3, 2: 2, 3: radiant ? 3 : 1, 4: 4, 5: 4 }[lane];
  // Under 45% of the time in the main lane reads as roaming.
  return { lane, lane_role: role, is_roaming: best / total < 0.45 };
}

// ---- merge ----

const SLOTS = [0, 1, 2, 3, 4, 128, 129, 130, 131, 132];
/** Replay-wide fields taken from the parser. */
const TOP_FIELDS = ['version', 'teamfights', 'objectives', 'pauses', 'chat', 'radiant_gold_adv', 'radiant_xp_adv', 'cosmetics', 'draft_timings'];
const filled = (a) => Array.isArray(a) && a.length > 0;

/**
 * GC scoreboard + parser output → one parsed match in OpenDota's shape. Pure.
 *
 * Players are matched by player_slot, never by position in the list. The
 * scoreboard (K/D/A, items, net worth) stays Valve's; the parser adds the
 * replay-derived fields. Throws (not retryable) when the two do not describe
 * the same ten seats or the parse has no timelines: a half-merged match must
 * never be stored as parsed.
 *
 * @param {object} gcMatch  mapGcMatch() output
 * @param {object} blob     odota/parser /blob output
 * @param {{ parsedAt?: string, heroNpcName?: (heroId: number) => string | null, dataSource?: string }} [o]
 *   dataSource: what the merged copy is labelled as (the scoreboard's source + the parser).
 */
export function mergeGcAndParsed(gcMatch, blob, { parsedAt = new Date().toISOString(), heroNpcName = () => null, dataSource = 'steam_gc+odota_parser' } = {}) {
  const bad = (why) => parserError(`replay parse unusable: ${why}`, { status: 502, retryable: false, code: 'parse_unusable' });
  if (!gcMatch || typeof gcMatch !== 'object' || !Array.isArray(gcMatch.players) || gcMatch.players.length !== 10) throw bad('no scoreboard');
  if (!blob || typeof blob !== 'object' || !Array.isArray(blob.players) || blob.players.length !== 10) throw bad('not ten players');
  // The parser leaves match_id 0; a real, different id means another game.
  if (blob.match_id && Number(blob.match_id) !== Number(gcMatch.match_id)) throw bad('another match');

  const bySlot = new Map();
  blob.players.forEach((p, index) => { if (p && Number.isInteger(p.player_slot)) bySlot.set(p.player_slot, { p, index }); });
  if (bySlot.size !== 10 || SLOTS.some((s) => !bySlot.has(s))) throw bad('player slots do not match');
  if (gcMatch.players.some((p) => !bySlot.has(p?.player_slot))) throw bad('scoreboard slots do not match');
  if (!filled(blob.radiant_gold_adv) || blob.players.some((p) => !filled(p.gold_t))) throw bad('no timelines');

  const players = [...gcMatch.players].sort((a, b) => a.player_slot - b.player_slot).map((gc) => {
    const { p: parsed } = bySlot.get(gc.player_slot);
    const radiant = gc.player_slot < 128;
    const { player_slot: _slot, ...replay } = parsed;
    const out = { ...replay, ...gc };
    // As OpenDota stores them: no recipes or ward dispensers in the purchase log, no self-kills.
    if (Array.isArray(out.purchase_log)) {
      out.purchase_log = out.purchase_log.filter((x) => typeof x?.key === 'string' && !x.key.startsWith('recipe_') && x.key !== 'ward_dispenser');
    }
    const self = heroNpcName(gc.hero_id);
    if (self && Array.isArray(out.kills_log)) out.kills_log = out.kills_log.filter((k) => k?.key !== self);
    const lane = laneFromPositions(out.lane_pos, radiant);
    if (lane) Object.assign(out, lane);
    if (out.life_state && typeof out.life_state === 'object') {
      out.life_state_dead = (Number(out.life_state[1]) || 0) + (Number(out.life_state[2]) || 0);
    }
    if (Array.isArray(out.buyback_log)) out.buyback_count = out.buyback_log.length;
    if (typeof gcMatch.radiant_win === 'boolean') {
      out.win = Number(radiant === gcMatch.radiant_win);
      out.lose = 1 - out.win;
    }
    return out;
  });

  // Teamfight rows are positional (the parser's player order): put them in ours.
  const order = players.map((p) => bySlot.get(p.player_slot).index);
  const teamfights = Array.isArray(blob.teamfights)
    ? blob.teamfights.map((f) => (Array.isArray(f?.players) && f.players.length === 10 ? { ...f, players: order.map((i) => f.players[i]) } : f))
    : blob.teamfights;

  const merged = { ...gcMatch };
  for (const k of TOP_FIELDS) if (blob[k] !== undefined) merged[k] = blob[k];
  if (teamfights !== undefined) merged.teamfights = teamfights;
  merged.players = players;
  merged.od_data = { has_parsed: true };
  merged.data_source = dataSource;
  merged.parsed_at = parsedAt;
  return merged;
}

// ---- is this replay that match? ----

/**
 * Does a parse belong to the match whose scoreboard we hold? The parser does
 * not report the match id, so compare what both sides know: the game's
 * length, and each player's kills and last hits by seat.
 *
 * Measured on real games: the right replay agrees on kills for 9-10 of the
 * ten players and on last hits for all ten; a different game agrees on kills
 * for at most 2 and never on length and both counts together. Passing needs
 * the length within a minute, and 8 of 10 on kills and on last hits.
 *
 * @returns {{ ok: boolean, minutes: { parsed: number | null, scoreboard: number | null, ok: boolean },
 *             kills: { matching: number, ok: boolean }, lastHits: { matching: number, ok: boolean } }}
 */
export function replayMatchesScoreboard(match, blob) {
  const players = Array.isArray(match?.players) ? match.players : [];
  const bySlot = new Map((Array.isArray(blob?.players) ? blob.players : []).map((p) => [p?.player_slot, p]));
  const parsedMin = filled(blob?.radiant_gold_adv) ? blob.radiant_gold_adv.length - 1 : null;
  const boardMin = Number.isFinite(match?.duration) ? Math.floor(match.duration / 60) : null;
  let kills = 0;
  let lastHits = 0;
  for (const p of players) {
    const q = bySlot.get(p?.player_slot);
    if (!q) continue;
    if (Array.isArray(q.kills_log) && Number.isInteger(p.kills) && q.kills_log.length === p.kills) kills += 1;
    const lh = filled(q.lh_t) ? q.lh_t[q.lh_t.length - 1] : null;
    // The last sample is taken at the last whole minute: a few short of the final count.
    if (Number.isFinite(lh) && Number.isInteger(p.last_hits) && Math.abs(lh - p.last_hits) <= 25) lastHits += 1;
  }
  const minutesOk = parsedMin != null && boardMin != null && Math.abs(parsedMin - boardMin) <= 1;
  const out = {
    minutes: { parsed: parsedMin, scoreboard: boardMin, ok: minutesOk },
    kills: { matching: kills, ok: kills >= 8 },
    lastHits: { matching: lastHits, ok: lastHits >= 8 },
  };
  // Both sides must be the same ten seats: nine agreeing players are not a match.
  const sameSeats = players.length === 10 && bySlot.size === 10 && players.every((p) => bySlot.has(p?.player_slot));
  return { ok: sameSeats && out.minutes.ok && out.kills.ok && out.lastHits.ok, ...out };
}

// ---- auth ----

/**
 * Google ID tokens for a private Cloud Run service, from the metadata server
 * (the service account this instance runs as). Returns an `authHeader`
 * function; a token is reused until five minutes before it expires. The
 * audience is fixed at start-up: nothing a request carries can change where a
 * token is valid.
 * @param {{ audience: string, fetchImpl?: typeof fetch, now?: () => number }} o
 */
export function createIdTokenProvider({ audience, fetchImpl = (...a) => fetch(...a), now = () => Date.now() }) {
  let aud;
  try { aud = new URL(audience); } catch { throw new Error('ODOTA_PARSER_AUDIENCE is not a URL'); }
  if (aud.protocol !== 'https:') throw new Error('ODOTA_PARSER_AUDIENCE must be https');
  const url = `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(aud.origin)}`;
  let cached = null;
  return async () => {
    if (cached && cached.until > now()) return cached.header;
    const res = await fetchImpl(url, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw parserError('identity token unavailable', { status: 503, retryable: true, code: 'parser_failed' });
    const token = (await res.text()).trim();
    let exp = null;
    try { exp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).exp; } catch { exp = null; }
    const until = Number.isFinite(exp) ? exp * 1000 - 5 * 60_000 : now() + 10 * 60_000;
    cached = { header: `Bearer ${token}`, until };
    return cached.header;
  };
}

// ---- client ----

/**
 * Client for an odota/parser instance.
 *
 * `parse(replayUrl)` resolves to the blob. Errors carry `code`:
 *   url_not_allowed  not a Valve replay address (never sent)
 *   replay_gone      Valve no longer has the replay, or it is corrupt (do not retry)
 *   busy             too many parses already waiting (retry later)
 *   parser_failed    the parser failed or timed out (retry later)
 * Parses of the same replay share one request; at most `maxConcurrent` run at
 * once and at most `maxQueued` wait, because each one holds a whole replay in
 * the parser's memory.
 *
 * @param {{ baseUrl: string, authHeader?: () => Promise<string | null> | string | null,
 *           fetchImpl?: typeof fetch, timeoutMs?: number, headTimeoutMs?: number,
 *           maxConcurrent?: number, maxQueued?: number, maxBytes?: number, log?: (m: string) => void }} o
 */
export function createOdotaParserClient({
  baseUrl, authHeader = () => null, fetchImpl = (...a) => fetch(...a),
  timeoutMs = 240_000, headTimeoutMs = 10_000, maxConcurrent = 2, maxQueued = 4, maxBytes = 40 * 1024 * 1024, log = () => {},
}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new Error('ODOTA_PARSER_URL is not a URL'); }
  if (!/^https?:$/.test(base.protocol)) throw new Error('ODOTA_PARSER_URL must be http(s)');
  const root = base.href.replace(/\/+$/, '');
  const stats = { parses: 0, ok: 0, gone: 0, failed: 0, busy: 0, rejectedUrls: 0, running: 0, queued: 0, lastMs: null };
  const inflight = new Map();
  const waiting = [];

  const idOf = (url) => /\/570\/(\d+)_/.exec(url)?.[1] ?? '?';
  async function slot() {
    if (stats.running < maxConcurrent) { stats.running += 1; return; }
    if (waiting.length >= maxQueued) { stats.busy += 1; throw parserError('replay parser busy', { status: 503, retryable: true, code: 'busy' }); }
    stats.queued = waiting.length + 1;
    await new Promise((go) => waiting.push(go)); // the slot is handed over, already counted
  }
  function release() {
    const next = waiting.shift();
    stats.queued = waiting.length;
    if (next) next(); else stats.running -= 1;
  }

  /** Is the replay still on Valve's CDN? true / false, or null when that could not be learned. */
  async function replayAvailable(replayUrl) {
    if (!isAllowedValveReplayUrl(replayUrl)) { stats.rejectedUrls += 1; throw parserError('replay url not allowed', { status: 400, retryable: false, code: 'url_not_allowed' }); }
    try {
      const res = await fetchImpl(replayUrl, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(headTimeoutMs) });
      if (res.status === 200) return true;
      if (res.status === 404 || res.status === 403 || res.status === 410) return false;
      return null;
    } catch { return null; }
  }

  async function run(replayUrl) {
    await slot();
    const started = Date.now();
    stats.parses += 1;
    try {
      const auth = await authHeader();
      let res;
      try {
        res = await fetchImpl(`${root}/blob?replay_url=${encodeURIComponent(replayUrl)}`, {
          headers: { accept: 'application/json', ...(auth ? { authorization: auth } : {}) },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw parserError(err?.name === 'TimeoutError' ? 'replay parser timeout' : 'replay parser unreachable', { status: 503, retryable: true, code: 'parser_failed', cause: err });
      }
      // The parser answers 204 for a replay it cannot read (gone from the CDN, truncated).
      if (res.status === 204) throw parserError('replay not available', { status: 404, retryable: false, code: 'replay_gone' });
      if (!res.ok) throw parserError(`replay parser HTTP ${res.status}`, { status: 502, retryable: true, code: 'parser_failed' });
      const declared = Number(res.headers?.get?.('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) throw parserError('replay parse too large', { status: 502, retryable: false, code: 'parser_failed' });
      const text = await res.text();
      if (!text) throw parserError('replay not available', { status: 404, retryable: false, code: 'replay_gone' });
      if (text.length > maxBytes) throw parserError('replay parse too large', { status: 502, retryable: false, code: 'parser_failed' });
      let blob;
      try { blob = JSON.parse(text); } catch { blob = null; }
      if (!blob || typeof blob !== 'object' || !Array.isArray(blob.players)) throw parserError('replay parse unreadable', { status: 502, retryable: true, code: 'parser_failed' });
      stats.ok += 1;
      return blob;
    } catch (err) {
      if (err?.code === 'replay_gone') stats.gone += 1; else stats.failed += 1;
      log(`match ${idOf(replayUrl)}: ${err?.message || 'failed'}`);
      throw err;
    } finally {
      stats.lastMs = Date.now() - started;
      release();
    }
  }

  /**
   * Parse a replay we hold ourselves (a local .dem): POST the raw,
   * uncompressed file to the parser. `body` is a Buffer or a readable stream.
   * The parser answers 200 with an empty body for a file it cannot read.
   */
  async function parseDem(body) {
    await slot();
    const started = Date.now();
    stats.parses += 1;
    try {
      const auth = await authHeader();
      let res;
      try {
        res = await fetchImpl(`${root}/?blob`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream', accept: 'application/json', ...(auth ? { authorization: auth } : {}) },
          body,
          duplex: 'half', // required by fetch for a streamed body
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw parserError(err?.name === 'TimeoutError' ? 'replay parser timeout' : 'replay parser unreachable', { status: 503, retryable: true, code: 'parser_failed', cause: err });
      }
      if (!res.ok) throw parserError(`replay parser HTTP ${res.status}`, { status: 502, retryable: true, code: 'parser_failed' });
      const text = await res.text();
      if (!text) throw parserError('not a readable replay (truncated, or not a Dota 2 .dem)', { status: 422, retryable: false, code: 'replay_unreadable' });
      if (text.length > maxBytes) throw parserError('replay parse too large', { status: 502, retryable: false, code: 'parser_failed' });
      let blob;
      try { blob = JSON.parse(text); } catch { blob = null; }
      if (!blob || typeof blob !== 'object' || !Array.isArray(blob.players)) throw parserError('replay parse unreadable', { status: 502, retryable: true, code: 'parser_failed' });
      stats.ok += 1;
      return blob;
    } catch (err) {
      stats.failed += 1;
      log(`local replay: ${err?.message || 'failed'}`);
      throw err;
    } finally {
      stats.lastMs = Date.now() - started;
      release();
    }
  }

  return {
    replayAvailable,
    parseDem,
    /** @param {string} replayUrl */
    parse(replayUrl) {
      if (!isAllowedValveReplayUrl(replayUrl)) {
        stats.rejectedUrls += 1;
        return Promise.reject(parserError('replay url not allowed', { status: 400, retryable: false, code: 'url_not_allowed' }));
      }
      const existing = inflight.get(replayUrl);
      if (existing) return existing;
      const job = run(replayUrl).finally(() => inflight.delete(replayUrl));
      inflight.set(replayUrl, job);
      return job;
    },
    snapshot: () => ({ configured: true, ...stats }),
  };
}
