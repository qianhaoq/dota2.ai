/**
 * Logged-in Steam accounts, each with a Dota 2 Game Coordinator session.
 * Accounts log on with a stored refresh token only (see login.mjs for the
 * one-time interactive login): no password ever reaches this process.
 *
 * An account is "ready" once the GC has welcomed it, and stops being ready
 * when Steam or the GC drops it; steam-user reconnects by itself and we say
 * hello again. A token Steam rejects stays down until someone logs in again.
 *
 * Logs name accounts by label only, and never print a token.
 */
import SteamUser from 'steam-user';
import {
  DOTA_APPID, MSG, decodeHistoryResponse, decodeMatchDetailsResponse,
  encodeHistoryRequest, encodeMatchDetailsRequest,
} from './codec.mjs';
import { tokenProblem } from './tokens.mjs';

const HELLO_EVERY_MS = 5000;
const RELOGIN_AFTER_MS = 5 * 60_000;
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
 * @param {{ accounts: { label: string, refreshToken: string }[], dataDir: string,
 *           onRefreshToken?: (label: string, token: string) => void, log?: (line: string) => void }} o
 */
export function createSteamPool({ accounts, dataDir, onRefreshToken = () => {}, log = () => {} }) {
  const sessions = new Map();
  let requestId = 1;

  for (const { label, refreshToken } of accounts) {
    const problem = tokenProblem(refreshToken);
    if (problem) {
      // Stays down, the others carry on.
      sessions.set(label, { label, client: null, token: null, ready: false, state: 'needs_login', hello: null, relogin: null });
      log(`${label}: stored token unusable (${problem}). Run "npm run login" for this account.`);
      continue;
    }
    const client = new SteamUser({ dataDirectory: dataDir, autoRelogin: true, renewRefreshTokens: true });
    const s = { label, client, token: refreshToken, ready: false, state: 'connecting', hello: null, relogin: null };
    sessions.set(label, s);

    const stopHello = () => { clearInterval(s.hello); s.hello = null; };
    const sayHello = () => {
      stopHello();
      const hello = () => client.sendToGC(DOTA_APPID, MSG.clientHello, {}, Buffer.alloc(0));
      hello();
      s.hello = setInterval(hello, HELLO_EVERY_MS);
    };
    const down = (state) => { s.ready = false; s.state = state; stopHello(); };

    client.on('loggedOn', () => {
      s.state = 'steam';
      log(`${label}: logged on to Steam`);
      // Dota 2 is free but must be in the library before it can be "played".
      client.requestFreeLicense([DOTA_APPID], () => {});
      client.gamesPlayed([DOTA_APPID], true);
    });
    client.on('appLaunched', (appid) => { if (appid === DOTA_APPID) sayHello(); });
    client.on('appQuit', (appid) => { if (appid === DOTA_APPID) down('steam'); });
    client.on('receivedFromGC', (appid, msgType, payload) => {
      if (appid !== DOTA_APPID) return;
      if (msgType === MSG.clientWelcome) {
        stopHello();
        if (!s.ready) log(`${label}: Dota 2 GC ready`);
        s.ready = true;
        s.state = 'ready';
      } else if (msgType === MSG.clientConnectionStatus && s.ready && !haveSession(payload)) {
        // The GC dropped the session (restart, maintenance): greet it again.
        log(`${label}: GC connection status changed, saying hello again`);
        s.ready = false;
        s.state = 'steam';
        sayHello();
      }
    });
    client.on('refreshToken', (token) => {
      s.token = token;
      try { onRefreshToken(label, token); log(`${label}: refresh token renewed and saved`); }
      catch { log(`${label}: could not save the renewed refresh token`); }
    });
    client.on('disconnected', (eresult) => {
      down('reconnecting');
      log(`${label}: disconnected from Steam (${SteamUser.EResult[eresult] ?? eresult})`);
    });
    client.on('error', (err) => {
      const name = SteamUser.EResult[err?.eresult] ?? 'error';
      if (NEEDS_LOGIN.has(name)) {
        down('needs_login');
        log(`${label}: Steam refused the stored token (${name}). Run "npm run login" for this account.`);
        return;
      }
      down('error');
      log(`${label}: Steam error (${name}), logging on again in ${RELOGIN_AFTER_MS / 60_000} min`);
      clearTimeout(s.relogin);
      s.relogin = setTimeout(() => { s.state = 'connecting'; client.logOn({ refreshToken: s.token }); }, RELOGIN_AFTER_MS);
      s.relogin.unref?.();
    });
    client.logOn({ refreshToken });
  }

  /**
   * One request to the GC. The answer normally comes back on the job; some
   * messages are answered as a plain message instead, so `accept` may claim one.
   */
  function ask(label, msgType, payload, { replyType, accept, timeoutMs }) {
    const s = sessions.get(label);
    if (!s?.ready) return Promise.reject(Object.assign(new Error('account not ready'), { code: 'not_ready' }));
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
        s.client.removeListener('receivedFromGC', onMessage);
        settle(value);
      }
      s.client.on('receivedFromGC', onMessage);
      s.client.sendToGC(DOTA_APPID, msgType, {}, payload, (appid, type, body) => {
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
      for (const s of sessions.values()) {
        clearInterval(s.hello); clearTimeout(s.relogin);
        try { s.client?.logOff(); } catch { /* already off */ }
      }
    },
  };
}
