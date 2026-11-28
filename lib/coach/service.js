/**
 * The coach as an in-process service, shared by the HTTP routes
 * (lib/coach/router.js) and the remote MCP endpoint (/mcp).
 *
 * - One limiter for both surfaces, keyed by the caller's IP through
 *   rateLimitKey (IPv6 grouped by /64), so an agent cannot get a second
 *   budget by going through MCP, nor rotate addresses inside one /64.
 * - `forRequest(req, res)` returns an adapter with the same shape as the CLI's
 *   createCoachApi (report / cases / recent / matchup / ask), so the MCP coach
 *   tools run in process instead of calling this server over HTTP (which would
 *   put every agent behind one IP and one bucket).
 * - `runCoachAsk` is the follow-up answer flow (LLM stream, truncation and
 *   failure fallbacks) for both the SSE route and the MCP tool.
 */
import { buildCoachReport } from './analyze.js';
import { parseAskBody, askMessages, fallbackAnswer, FALLBACK_NOTICE } from './ask.js';
import { decideFollowUpOutcome } from '../matchReview/followUpFallback.js';
import { createSlidingWindowLimiter } from '../rateLimiter.js';
import { rateLimitKey } from '../rateLimitKey.js';
import { matchupBrief, matchupLines } from './matchupBrief.js';
import { parseAccount } from '../../packages/cli/src/coachApi.js';
import { normalizeMatchId } from '../../packages/review-engine/src/parseMatchId.js';

/** Errors the MCP coach tools understand (same codes as the CLI client). */
export function coachError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

/** The default coach budget: 40 requests a minute per caller, 1200 overall. */
export function createCoachLimiter() {
  return createSlidingWindowLimiter({ limit: 40, globalLimit: 1200, windowMs: 60_000 });
}

/**
 * Streams one follow-up answer through `send` (frames `{text}`, `{text,
 * fallback}`, `{notice}`), falling back to the report's own answer when no
 * model is used, every provider fails, or the stream stops early.
 * @param {{ input: object, ask?: object, providers: object[], useLlm: boolean, signal: AbortSignal,
 *   send: (frame: object) => void, isGone: () => boolean, log: (msg: string) => void, tag: string }} o
 */
export async function runCoachAsk({ input, ask, providers, useLlm, signal, send, isGone, log, tag }) {
  const fallback = (reason) => {
    log(`ask fallback ${tag} reason=${reason}`);
    send({ text: fallbackAnswer(input), fallback: true });
    send({ notice: FALLBACK_NOTICE[input.lang] });
  };
  try {
    if (!useLlm) {
      fallback(providers.length ? 'cost_guard' : 'unconfigured');
      return;
    }
    let forwarded = false;
    const out = await ask.stream({
      providers,
      attemptMs: ask.attemptMs,
      signal,
      onText: (text) => { forwarded = true; send({ text }); },
      shouldStop: isGone,
      onProviderError: ({ provider, error }) => log(`ask provider_error ${tag} provider=${provider} error=${error}`),
    });
    // Text that stopped without a terminal finish_reason is truncated, not
    // done: append the report's own answer and say so.
    const decision = decideFollowUpOutcome({ ...out, forwarded: out.forwarded ?? forwarded });
    if (decision.action === 'fallback') {
      if (decision.append) {
        log(`ask fallback ${tag} reason=${decision.reason}`);
        send({ text: `\n\n${fallbackAnswer(input)}`, fallback: true, incomplete: true });
        send({ notice: FALLBACK_NOTICE[input.lang], incomplete: true });
      } else {
        fallback('provider_failed');
      }
    }
  } catch (error) {
    if (!isGone()) { log(`ask failed ${tag}: ${error?.name ?? 'error'}`); fallback('error'); }
  }
}

/**
 * @param {{
 *   getMatchDetail: (id: number) => Promise<object>,
 *   resolveClientIp: (req: object) => string,
 *   mapError?: (error: unknown, isZh: boolean) => { status: number, body: object },
 *   cases?: { get: Function, peek: Function },
 *   recent?: { get: (accountId: number) => Promise<object> },
 *   ask?: { llm?: { acquire: (req: object) => { ok: boolean, reason?: string, retryAfterSec?: number } },
 *           providers: (messages: object[]) => object[], stream: Function, attemptMs: number },
 *   limiter?: { tryConsume: (key: string) => { ok: boolean, retryAfterSec: number } },
 *   log?: (msg: string) => void,
 * }} deps
 */
export function createCoachService(deps) {
  const limiter = deps.limiter ?? createCoachLimiter();
  const log = deps.log ?? (() => {});
  const mapError = deps.mapError ?? (() => ({ status: 502, body: {} }));

  /** One request from `ip` against the shared budget (IPv6 grouped by /64). */
  const consume = (ip) => limiter.tryConsume(rateLimitKey(ip));

  /** The in-process coach for one MCP request: rate-limited as that caller. */
  function forRequest(req, res) {
    const ip = deps.resolveClientIp(req);
    // Disconnects are tracked from the start of the request: a tool may await
    // a report load (coach_ask resolves the hero first) before any model call,
    // and a caller who left by then must not reach the LLM budget.
    const ac = new AbortController();
    let gone = false;
    const markGone = () => { if (!res?.writableEnded) { gone = true; ac.abort(); } };
    if (res) {
      if (res.destroyed || req?.destroyed) markGone();
      else res.on?.('close', markGone);
    }
    const gate = () => {
      const g = consume(ip);
      if (!g.ok) {
        if (res && !res.headersSent) res.set('Retry-After', String(g.retryAfterSec));
        throw coachError('RATE_LIMITED', `Rate limited: try again in ${g.retryAfterSec}s`, { retryAfterSec: g.retryAfterSec });
      }
    };
    const matchIdOf = (raw) => {
      const s = normalizeMatchId(raw);
      if (!s) throw coachError('INVALID_INPUT', `Not a match id: ${String(raw ?? '').trim() || '(empty)'}`);
      return Number(s);
    };
    const load = async (matchId, overrides = {}) => {
      let match;
      try {
        match = await deps.getMatchDetail(matchId);
        return { match, report: buildCoachReport(match, { overrides }) };
      } catch (error) {
        if (error?.code === 'INSUFFICIENT') throw coachError('NOT_FOUND', 'OpenDota has no player data for this match yet');
        const mapped = mapError(error, false);
        throw coachError(mapped.status === 404 ? 'NOT_FOUND' : 'UPSTREAM', mapped.status === 404 ? 'Match not found' : 'Could not load the match right now');
      }
    };

    return {
      ...(typeof deps.replayAvailability === 'function'
        ? { replayAvailability: (matchIdRaw) => deps.replayAvailability(String(matchIdOf(matchIdRaw))) }
        : {}),
      async report(matchIdRaw) {
        const id = matchIdOf(matchIdRaw);
        gate();
        return (await load(id)).report;
      },
      async cases(matchIdRaw, seat) {
        const id = matchIdOf(matchIdRaw);
        if (!deps.cases) throw coachError('NOT_FOUND', 'Case studies are not enabled');
        gate();
        const { match, report } = await load(id);
        if (!report.match.parsed) {
          throw coachError(
            'NOT_FOUND',
            'Case studies need an OpenDota-parsed match (basic scoreboard data only). Call replay_review for full Valve replay analysis.',
            { reason: 'needs_parse' },
          );
        }
        try {
          return await deps.cases.get({ report, slot: seat, match });
        } catch (error) {
          log(`mcp cases failed match=${id} slot=${seat}: ${error?.message ?? error}`);
          throw coachError('UPSTREAM', 'Could not load professional games right now');
        }
      },
      async recent(account) {
        let accountId;
        try { accountId = parseAccount(account); } catch (error) { throw coachError('INVALID_INPUT', error.message); }
        if (!deps.recent) throw coachError('NOT_FOUND', 'Recent games are not enabled');
        gate();
        try {
          return await deps.recent.get(Number(accountId));
        } catch (error) {
          const mapped = mapError(error, false);
          throw coachError(mapped.status === 404 ? 'NOT_FOUND' : 'UPSTREAM', mapped.status === 404 ? 'No such player' : 'Could not load recent games right now');
        }
      },
      // Committed snapshots only: no upstream call, so no budget (same as GET /api/coach/matchup).
      async matchup(hero, vs, rank) {
        const brief = matchupBrief(String(hero ?? '').slice(0, 40), String(vs ?? '').slice(0, 40), { rank: rank == null ? null : String(rank).slice(0, 20) });
        if (brief.error) throw coachError('INVALID_INPUT', brief.error);
        return { ...brief, lines: { en: matchupLines(brief, 'en'), zh: matchupLines(brief, 'zh') } };
      },
      /** The SSE answer, collected: `{ text, fallback, notice }`. */
      async ask(matchIdRaw, seat, question, { lang = 'en' } = {}) {
        const id = matchIdOf(matchIdRaw);
        const body = parseAskBody({ slot: seat, lang, question });
        if (body.error) throw coachError('INVALID_INPUT', body.error);
        if (gone) throw coachError('UPSTREAM', 'Caller disconnected');
        gate();
        const { report } = await load(id);
        // Gone while the match loaded: stop before any budget or paid completion.
        if (gone) throw coachError('UPSTREAM', 'Caller disconnected');
        const cases = report.match.parsed ? (deps.cases?.peek({ report, slot: body.slot }) ?? null) : null;
        const input = { report, slot: body.slot, lang: body.lang, question: body.question, history: body.history, cases };
        const providers = deps.ask ? deps.ask.providers(askMessages(input)) : [];
        let useLlm = providers.length > 0;
        if (useLlm && deps.ask.llm) {
          const g = await deps.ask.llm.acquire(req);
          if (!g.ok) {
            if (g.reason !== 'cost_guard') {
              if (res && !res.headersSent) res.set('Retry-After', String(g.retryAfterSec ?? 60));
              throw coachError('RATE_LIMITED', `Rate limited: try again in ${g.retryAfterSec ?? 60}s`, { retryAfterSec: g.retryAfterSec });
            }
            useLlm = false;
          }
        }
        let text = ''; let fallback = false; let notice = null;
        await runCoachAsk({
          input, ask: deps.ask, providers, useLlm, signal: ac.signal,
          send: (f) => {
            if (typeof f.text === 'string') text += f.text;
            if (f.fallback) fallback = true;
            if (f.notice) notice = f.notice;
          },
          isGone: () => gone,
          log,
          tag: `match=${id} via=mcp`,
        });
        return { text, fallback, notice };
      },
    };
  }

  return { limiter, consume, forRequest };
}
