/**
 * Logged-in Steam accounts, each with a Dota 2 Game Coordinator session.
 * Accounts log on with a stored refresh token only (see login.mjs for the
 * one-time interactive login): no password ever reaches this process.
 *
 * An account is "ready" once the GC has welcomed it, and stops being ready
 * when Steam or the GC drops it. The Steam client reconnects by itself and we
 * say hello again; when that has not brought the account back within a few
 * minutes, the session is thrown away and a fresh one is started (the
 * client's own reconnect can stall for good: it did in production after a
 * Steam maintenance window, and the account stayed offline for fifteen hours
 * until the process was restarted). A token Steam rejects stays down until
 * someone logs in again.
 *
 * The Steam client is passed in (`createClient`), so this module has no
 * dependency on steam-user and can be tested. Logs name accounts by label
 * only, and never print a token.
 */
import {
  DOTA_APPID, MSG, decodeHistoryResponse, decodeMatchDetailsResponse,
  encodeHistoryRequest, encodeMatchDetailsRequest,
} from './codec.mjs';
import { tokenProblem } from './tokens.mjs';

const HELLO_EVERY_MS = 5000;
/** Not ready this long: start a fresh session. Doubles per failed try, up to the cap. */
export const STUCK_AFTER_MS = 3 * 60_000;
export const STUCK_AFTER_MAX_MS = 15 * 60_000;
/** Steam says the token is no good: retrying cannot help. */
const NEEDS_LOGIN = new Set(['InvalidPassword', 'AccessDenied', 'Expired', 'Revoked', 'AccountLoginDeniedNeedTwoFactor', 'InvalidSignature']);

/** CMsgConnectionStatus.status (field 1, varint): 0 is GCConnectionStatus_HAVE_SESSION, also the default. */
function haveSession(payload) {
  if (!payload || payload.length === 0) return true;
  return payload[0] === 0x08 ? payload[1] === 0 : true;
}

function gcTimeout() {
  return Object.assign(new Error('GC did not answer'), { code: 'gc_timeout' });
}

/**
 * @param {{
 *   accounts: { label: string, refreshToken: string }[],
 *   createClient: () => any,                       a steam-user client (or a stand-in)
 *   eresultName?: (eresult: number) => string | undefined,
 *   onRefreshToken?: (label: string, token: string) => void,
 *   log?: (line: string) => void,
 *   now?: () => number,
 *   stuckAfterMs?: number, stuckAfterMaxMs?: number,
 *   watchEveryMs?: number,                         0 turns the timer off (tests call check())
 * }} o
 */
export function createPool({
  accounts, createClient, eresultName = () => undefined, onRefreshToken = () => {}, log = () => {},
  now = Date.now, stuckAfterMs = STUCK_AFTER_MS, stuckAfterMaxMs = STUCK_AFTER_MAX_MS, watchEveryMs = 30_000,
}) {
  const sessions = new Map();
  let requestId = 1;

  /** Start a session for the account on a new client. */
  function connect(s) {
    const { label } = s;
    const client = createClient();
    s.client = client;
    s.ready = false;
    s.state = 'connecting';
    s.downSince = now();
    // Events of a client that has been replaced must not touch the session.
    const mine = () => s.client === client;

    const stopHello = () => { clearInterval(s.hello); s.hello = null; };
    const sayHello = () => {
      stopHello();
      const hello = () => client.sendToGC(DOTA_APPID, MSG.clientHello, {}, Buffer.alloc(0));
      hello();
      s.hello = setInterval(hello, HELLO_EVERY_MS);
      s.hello.unref?.();
    };
    const down = (state) => {
      if (s.ready) s.downSince = now();
      s.ready = false;
      s.state = state;
      stopHello();
    };

    client.on('loggedOn', () => {
      if (!mine()) return;
      s.state = 'steam';
      log(`${label}: logged on to Steam`);
      // Dota 2 is free but must be in the library before it can be "played".
      client.requestFreeLicense([DOTA_APPID], () => {});
      client.gamesPlayed([DOTA_APPID], true);
    });
    client.on('appLaunched', (appid) => { if (mine() && appid === DOTA_APPID) sayHello(); });
    client.on('appQuit', (appid) => { if (mine() && appid === DOTA_APPID) down('steam'); });
    client.on('receivedFromGC', (appid, msgType, payload) => {
      if (!mine() || appid !== DOTA_APPID) return;
      if (msgType === MSG.clientWelcome) {
        stopHello();
        if (!s.ready) log(`${label}: Dota 2 GC ready`);
        s.ready = true;
        s.state = 'ready';
        s.tries = 0;
      } else if (msgType === MSG.clientConnectionStatus && s.ready && !haveSession(payload)) {
        // The GC dropped the session (restart, maintenance): greet it again.
        log(`${label}: GC connection status changed, saying hello again`);
        down('steam');
        sayHello();
      }
    });
    client.on('refreshToken', (token) => {
      if (!mine()) return;
      s.token = token;
      try { onRefreshToken(label, token); log(`${label}: refresh token renewed and saved`); }
      catch { log(`${label}: could not save the renewed refresh token`); }
    });
    client.on('disconnected', (eresult) => {
      if (!mine()) return;
      down('reconnecting');
      log(`${label}: disconnected from Steam (${eresultName(eresult) ?? eresult})`);
    });
    client.on('error', (err) => {
      if (!mine()) return;
      const name = eresultName(err?.eresult) ?? 'error';
      if (NEEDS_LOGIN.has(name)) {
        down('needs_login');
        log(`${label}: Steam refused the stored token (${name}). Run "npm run login" for this account.`);
        return;
      }
      down('error');
      log(`${label}: Steam error (${name}); a fresh session follows`);
    });
    client.logOn({ refreshToken: s.token });
  }

  /** Let go of a client for good: no events, no crash on a late error, logged off if it can be. */
  function discard(s) {
    const old = s.client;
    clearInterval(s.hello); s.hello = null;
    s.client = null;
    if (!old) return;
    try { old.removeAllListeners(); } catch { /* not an emitter */ }
    try { old.on('error', () => {}); } catch { /* same */ }
    try { old.logOff(); } catch { /* was not logged on */ }
  }

  /** How long this account may be down before its next fresh session. */
  const patience = (s) => Math.min(stuckAfterMs * 2 ** s.tries, stuckAfterMaxMs);

  /**
   * Start a fresh session for every account that has been down too long.
   * Runs on a timer; returns the labels it restarted.
   */
  function check() {
    const restarted = [];
    for (const s of sessions.values()) {
      if (s.ready || s.state === 'needs_login') continue;
      const downFor = now() - s.downSince;
      if (downFor < patience(s)) continue;
      log(`${s.label}: not ready for ${Math.round(downFor / 60_000)} min (${s.state}), starting a fresh session`);
      s.tries += 1;
      discard(s);
      try { connect(s); } catch (err) {
        // Could not even start: stay down, the next check tries again.
        s.state = 'error'; s.downSince = now();
        log(`${s.label}: could not start a session (${err?.message || 'error'})`);
      }
      restarted.push(s.label);
    }
    return restarted;
  }

  for (const { label, refreshToken } of accounts) {
    const s = { label, client: null, token: refreshToken, ready: false, state: 'connecting', hello: null, downSince: now(), tries: 0 };
    sessions.set(label, s);
    const problem = tokenProblem(refreshToken);
    if (problem) {
      // Stays down, the others carry on.
      s.token = null;
      s.state = 'needs_login';
      log(`${label}: stored token unusable (${problem}). Run "npm run login" for this account.`);
      continue;
    }
    connect(s);
  }
  const watch = watchEveryMs > 0 ? setInterval(check, watchEveryMs) : null;
  watch?.unref?.();

  /**
   * One request to the GC. The answer normally comes back on the job; some
   * messages are answered as a plain message instead, so `accept` may claim one.
   */
  function ask(label, msgType, payload, { replyType, accept, timeoutMs }) {
    const s = sessions.get(label);
    if (!s?.ready) return Promise.reject(Object.assign(new Error('account not ready'), { code: 'not_ready' }));
    const client = s.client;
    return new Promise((resolve, reject) => {
      const onMessage = (appid, type, body) => {
        if (appid !== DOTA_APPID || type !== replyType) return;
        let ok = false;
        try { ok = accept(body); } catch { ok = false; }
        if (ok) finish(resolve, body);
      };
      const timer = setTimeout(() => finish(reject, gcTimeout()), timeoutMs);
      function finish(settle, value) {
        clearTimeout(timer);
        client.removeListener('receivedFromGC', onMessage);
        settle(value);
      }
      client.on('receivedFromGC', onMessage);
      client.sendToGC(DOTA_APPID, msgType, {}, payload, (appid, type, body) => {
        if (type === replyType) finish(resolve, body);
      });
    });
  }

  return {
    size: () => sessions.size,
    ready: () => [...sessions.values()].filter((s) => s.ready).map((s) => s.label),
    /** Counts per state, for the log line at startup and /healthz debugging. No labels. */
    states() {
      const out = {};
      for (const s of sessions.values()) out[s.state] = (out[s.state] ?? 0) + 1;
      return out;
    },
    check,
    async matchDetails(label, matchId, { timeoutMs }) {
      const body = await ask(label, MSG.matchDetailsRequest, encodeMatchDetailsRequest(matchId), {
        replyType: MSG.matchDetailsResponse,
        accept: (buf) => String(decodeMatchDetailsResponse(buf).match?.match_id) === String(matchId),
        timeoutMs,
      });
      return decodeMatchDetailsResponse(body);
    },
    async history(label, accountId, limit, { timeoutMs }) {
      const id = requestId++ % 0x7fffffff || 1;
      const body = await ask(label, MSG.playerMatchHistory, encodeHistoryRequest({ accountId, limit, requestId: id }), {
        replyType: MSG.playerMatchHistoryResponse,
        accept: (buf) => decodeHistoryResponse(buf).request_id === id,
        timeoutMs,
      });
      return decodeHistoryResponse(body);
    },
    stop() {
      clearInterval(watch);
      for (const s of sessions.values()) discard(s);
    },
  };
}
