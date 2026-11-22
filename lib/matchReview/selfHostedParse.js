/**
 * "Parse this match" without OpenDota: Steam GC gives the replay's address,
 * our own odota/parser instance parses it, and the merged result is handed to
 * `onParsed` (the caches). See lib/upstream/odotaParser.js.
 *
 * Same contract as the OpenDota submitter (parseRequestSubmit.js): per-match
 * dedup and cooldown (tracker), per-client and global budget, and a quick
 * answer. The parse itself takes a minute or so and runs after the response;
 * the page's existing polling picks the parsed match up when it lands.
 *
 * A replay Valve no longer has is remembered for a while, so asking again
 * neither spends budget nor wakes the parser.
 *
 * All I/O is injected; nothing here reads the environment.
 */
import { parseStatusPayload } from './matchParse.js';
import { buildValveReplayUrl } from '../upstream/steamGc.js';
import { mergeGcAndParsed } from '../upstream/odotaParser.js';

/** A parse here usually takes under a minute or two. */
export const SELF_HOSTED_RETRY_AFTER_SEC = 45;

const MESSAGES = {
  requested: (n) => ({ en: `Parsing the replay now. Check back in about ${n}s for lanes and timelines`, zh: `正在解析录像，约 ${n} 秒后即可看到分路与时间线数据` }),
  pending: (n) => ({ en: `Still parsing this match. Check back in about ${n}s`, zh: `本场比赛仍在解析中，约 ${n} 秒后再看` }),
  failed: () => ({ en: 'The parse did not go through. Try again in a minute', zh: '解析没有成功，请一分钟后再试' }),
  replay_gone: () => ({ en: 'Valve no longer has this replay (replays are kept about two weeks), so this match cannot be parsed', zh: 'Valve 已不再保存这场比赛的录像（录像大约保留两周），无法解析这场比赛' }),
};

/**
 * The status payload the page reads (same fields as OpenDota's path), with
 * wording that says what is actually happening and `provider: 'self_hosted'`.
 * `reason: 'replay_gone'` tells the page there is no point in asking again.
 */
function payload(status, { lang, retryAfterSec, reason } = {}) {
  const base = parseStatusPayload(status, { lang, retryAfterSec });
  const text = MESSAGES[reason ?? status]?.(base.retryAfterSec);
  return { ...base, ...(text ? { message: lang === 'zh' ? text.zh : text.en } : {}), provider: 'self_hosted', ...(reason ? { reason } : {}) };
}

/** How long a "replay is gone" answer is remembered. */
export const REPLAY_GONE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * @param {{
 *   tracker: ReturnType<typeof import('./matchParse.js').createParseRequestTracker>,
 *   budget: ReturnType<typeof import('./matchParse.js').createParseRequestBudget>,
 *   steamGc: { fetchMatch: (matchId: number) => Promise<object> },
 *   parser: { parse: (replayUrl: string) => Promise<object>, replayAvailable: (replayUrl: string) => Promise<boolean | null> },
 *   onParsed: (matchId: number, match: object) => void,
 *   isParsed: (match: object) => boolean,
 *   heroNpcName?: (heroId: number) => string | null,
 *   goneTtlMs?: number, now?: () => number,
 *   log?: (msg: string) => void, warn?: (msg: string) => void,
 * }} o
 */
export function createSelfHostedParseSubmitter({
  tracker, budget, steamGc, parser, onParsed, isParsed, heroNpcName,
  goneTtlMs = REPLAY_GONE_TTL_MS, now = () => Date.now(), log = () => {}, warn = () => {},
}) {
  if (!tracker || !budget || !steamGc || !parser || typeof onParsed !== 'function' || typeof isParsed !== 'function') {
    throw new TypeError('createSelfHostedParseSubmitter requires tracker, budget, steamGc, parser, onParsed and isParsed');
  }
  /** matchId → time until which its replay is known to be gone. */
  const gone = new Map();
  const jobs = new Set();
  const isGone = (matchId) => {
    const until = gone.get(matchId);
    if (until == null) return false;
    if (until > now()) return true;
    gone.delete(matchId);
    return false;
  };
  const markGone = (matchId) => {
    gone.set(matchId, now() + goneTtlMs);
    while (gone.size > 500) gone.delete(gone.keys().next().value);
  };

  /** The GC copy we already hold has the replay address: no second GC request. */
  const usable = (matchId, known) => (known?.data_source === 'steam_gc' && Number(known.match_id) === matchId && Array.isArray(known.players) ? known : null);
  const goneError = (message) => Object.assign(new Error(message), { code: 'replay_gone' });

  async function run(matchId, known, checked) {
    const base = known ?? await steamGc.fetchMatch(matchId);
    const replayUrl = buildValveReplayUrl(base);
    if (!replayUrl) throw goneError('no replay address for this match');
    if (!checked && await parser.replayAvailable(replayUrl) === false) throw goneError('replay no longer on Valve CDN');
    const blob = await parser.parse(replayUrl);
    const merged = mergeGcAndParsed(base, blob, { parsedAt: new Date(now()).toISOString(), heroNpcName });
    if (!isParsed(merged)) throw Object.assign(new Error('merged match does not read as parsed'), { code: 'parse_unusable' });
    return merged;
  }

  /**
   * @param {number} matchId
   * @param {string} clientIp
   * @param {{ lang?: string, matchData?: object, signal?: AbortSignal }} [opts]
   */
  async function submit(matchId, clientIp, opts = {}) {
    const { lang, matchData, signal } = opts;
    if (isGone(matchId)) return payload('failed', { lang, reason: 'replay_gone' });
    const active = tracker.active(matchId);
    if (active) {
      return payload(active.failed ? 'failed' : 'pending', { retryAfterSec: Math.min(active.retryAfterSec, SELF_HOSTED_RETRY_AFTER_SEC), lang });
    }
    const overBudget = budget.tryConsume(clientIp);
    if (overBudget) {
      warn(`match=${matchId} throttled scope=${overBudget.scope} retryAfterSec=${overBudget.retryAfterSec}`);
      return payload('throttled', { retryAfterSec: overBudget.retryAfterSec, lang });
    }
    tracker.markRequested(matchId);
    // The failure cooldown counts from the failure, not from the request: a
    // parse that failed after two minutes must still be backed off.
    const markFailed = () => { tracker.markRequested(matchId); tracker.markResult(matchId, { failed: true }); };
    const fail = (err) => {
      if (err?.code === 'replay_gone') markGone(matchId);
      markFailed();
      warn(`match=${matchId} self-hosted parse failed: ${err?.code || err?.status || 'error'} (${err?.message || 'unknown'})`);
    };

    // With the replay address already in hand, learn now whether Valve still
    // has it: the page can say so at once instead of polling for nothing.
    const known = usable(matchId, matchData);
    let checked = false;
    if (known) {
      const replayUrl = buildValveReplayUrl(known);
      let available = null;
      try { available = replayUrl ? await parser.replayAvailable(replayUrl) : false; } catch { available = false; }
      if (available === false) {
        fail(goneError(replayUrl ? 'replay no longer on Valve CDN' : 'no replay address for this match'));
        return payload('failed', { lang, reason: 'replay_gone' });
      }
      checked = available === true;
    }
    // The caller left while we were checking: nobody is waiting for this
    // parse, so do not start one. A short retry window, not a failure.
    if (signal?.aborted) {
      tracker.markAborted(matchId);
      throw signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' });
    }

    const started = now();
    const job = run(matchId, known, checked).then((merged) => {
      onParsed(matchId, merged);
      tracker.markResult(matchId, {});
      log(`match=${matchId} self-hosted parse done in ${Math.round((now() - started) / 1000)}s`);
    }, fail).catch((err) => {
      // onParsed threw: the parse is lost, say so rather than leave it pending.
      markFailed();
      warn(`match=${matchId} self-hosted parse could not be stored: ${err?.message || 'unknown'}`);
    }).finally(() => jobs.delete(job));
    jobs.add(job);
    log(`match=${matchId} self-hosted parse started`);
    return payload('requested', { lang, retryAfterSec: SELF_HOSTED_RETRY_AFTER_SEC });
  }
  /** Resolves when every parse started so far has finished (tests, shutdown). */
  submit.idle = () => Promise.all([...jobs]);
  return submit;
}

/**
 * One submitter for the parse-request endpoint: our own parser when it is
 * configured and `useSelfHosted(matchData)` says OpenDota is not the place to
 * ask, OpenDota otherwise.
 * @param {{ openDota: Function, selfHosted?: Function | null, useSelfHosted?: (matchData?: object) => boolean }} o
 */
export function chooseParseSubmitter({ openDota, selfHosted = null, useSelfHosted = () => false }) {
  if (typeof openDota !== 'function') throw new TypeError('chooseParseSubmitter requires the OpenDota submitter');
  return (matchId, clientIp, opts = {}) => (selfHosted && useSelfHosted(opts.matchData)
    ? selfHosted(matchId, clientIp, opts)
    : openDota(matchId, clientIp, opts));
}
