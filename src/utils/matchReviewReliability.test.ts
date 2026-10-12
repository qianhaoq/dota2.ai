import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildMatchFact } from '../../lib/matchReview/matchFacts.js';
import {
  buildFallbackAiCards,
  describeReviewCardsInvalidReason,
  isReviewAiCardsComplete,
} from '../../lib/matchReview/reviewCards.js';
import { LANE_CLUSTER_SOURCE } from '../../lib/matchReview/laneResolver.js';
import {
  isMatchParsed,
  createParseRequestTracker,
  parseStatusPayload,
  UNPARSED_MATCH_CACHE_TTL_MS,
  PARSE_REQUEST_COOLDOWN_MS,
} from '../../lib/matchReview/matchParse.js';
import {
  createMatchDetailCache,
  isMatchDetailEntryFresh,
  shouldReplaceMatchDetailEntry,
  MATCH_DETAIL_CACHE_TTL_MS,
} from '../../lib/matchReview/matchDetailCache.js';
import { computeApiHealth } from '../../lib/serverHealth.js';
import {
  wantsReviewStream,
  createReviewResponder,
} from '../../lib/matchReview/reviewResponder.js';
import type { MatchFact } from '../types/matchReview';
import type { ReviewCardsPayload } from '../types/reviewCards';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const parsedFixture = JSON.parse(readFileSync(path.join(fixturesDir, 'match9035042364.parsed.json'), 'utf8'));
const unparsedFixture = JSON.parse(readFileSync(path.join(fixturesDir, 'match9035042364.unparsed.json'), 'utf8'));

const HERO_NAMES = {
  9: { nameZh: '米拉娜', nameEn: 'Mirana', internalSlug: 'mirana' },
  14: { nameZh: '帕吉', nameEn: 'Pudge', internalSlug: 'pudge' },
  21: { nameZh: '风行者', nameEn: 'Windranger', internalSlug: 'windrunner' },
  35: { nameZh: '狙击手', nameEn: 'Sniper', internalSlug: 'sniper' },
  41: { nameZh: '虚空假面', nameEn: 'Faceless Void', internalSlug: 'faceless_void' },
  42: { nameZh: '冥魂大帝', nameEn: 'Wraith King', internalSlug: 'skeleton_king' },
  69: { nameZh: '末日使者', nameEn: 'Doom', internalSlug: 'doom_bringer' },
  84: { nameZh: '食人魔魔法师', nameEn: 'Ogre Magi', internalSlug: 'ogre_magi' },
  104: { nameZh: '军团指挥官', nameEn: 'Legion Commander', internalSlug: 'legion_commander' },
  123: { nameZh: '森海飞霞', nameEn: 'Hoodwink', internalSlug: 'hoodwink' },
};

describe('isMatchParsed', () => {
  it('detects parsed vs unparsed fixtures via od_data.has_parsed', () => {
    expect(isMatchParsed(parsedFixture)).toBe(true);
    expect(isMatchParsed(unparsedFixture)).toBe(false);
  });

  it('falls back to parsed-only fields when od_data is missing', () => {
    const withoutOdData = { ...parsedFixture, od_data: undefined, version: undefined };
    expect(isMatchParsed(withoutOdData)).toBe(true);
    expect(isMatchParsed({ ...unparsedFixture, od_data: undefined })).toBe(false);
    expect(isMatchParsed(null)).toBe(false);
  });
});

describe('match 9035042364 parsed fixture', () => {
  const fact = buildMatchFact(parsedFixture, { lang: 'zh', heroId: 104, heroNames: HERO_NAMES }) as MatchFact;

  it('derives real lanes for all 10 players from replay positioning', () => {
    expect(fact.players).toHaveLength(10);
    expect(fact.laneSource).toBe(LANE_CLUSTER_SOURCE);
    for (const player of fact.players) {
      expect(player.laneSource).toBe(LANE_CLUSTER_SOURCE);
      expect(['top', 'mid', 'bot']).toContain(player.lane);
    }
    expect(new Set(fact.lanes.map((l) => l.laneLabel))).toEqual(new Set(['top', 'mid', 'bot']));
  });

  it('does not blindly trust the OpenDota auto lane field', () => {
    // OpenDota lane=3 (bot) for Legion Commander; replay positioning says top.
    const lc = parsedFixture.players.find((p: { hero_id: number }) => p.hero_id === 104);
    expect(lc?.lane).toBe(3);
    const lcFact = fact.players.find((p) => p.heroId === 104);
    expect(lcFact?.lane).toBe('top');
    expect(fact.focusLens?.lane).toBe('top');
    expect(fact.focusLens?.opponents.map((o) => o.heroId).sort((a, b) => a - b)).toEqual([42, 84]);
  });

  it('is grounded with non-empty timeline and economy checkpoints', () => {
    expect(fact.grounded).toBe(true);
    expect(fact.parsed).toBe(true);
    expect(fact.timeline.length).toBeGreaterThan(0);
    expect(fact.economy.checkpoints.length).toBeGreaterThan(0);
    expect(Object.keys(fact.fieldReasons ?? {})).toHaveLength(0);
  });

  it('builds deterministic fallback key moments for hero 104 (Legion Commander)', () => {
    const cards = buildFallbackAiCards(fact, 'zh') as ReviewCardsPayload;
    expect(cards.key_moments?.length ?? 0).toBeGreaterThan(0);
    cards.key_moments?.forEach((m) => {
      expect(m.timestampLabel).toMatch(/^\d+:\d{2}$/);
      expect(m.headline).toBeTruthy();
      expect(m.headline).toBe(m.evidence[0].value);
      expect(m.why).toBeTruthy();
    });
  });

  it('fills fallback key moments from hero kills/deaths when objectives are missing', () => {
    const stripped = buildMatchFact(
      { ...parsedFixture, objectives: [] },
      { lang: 'zh', heroId: 104, heroNames: HERO_NAMES },
    ) as MatchFact;
    expect(stripped.timeline).toHaveLength(0);
    const cards = buildFallbackAiCards(stripped, 'zh') as ReviewCardsPayload;
    const moments = cards.key_moments || [];
    expect(moments.length).toBeGreaterThan(0);
    const factKeys = moments.map((m) => m.evidence[0].factKey);
    expect(factKeys.some((key) => key.startsWith('hero_kill_') || key.startsWith('hero_death_'))).toBe(true);
    // Deterministic: same facts in, same moments out.
    const again = buildFallbackAiCards(stripped, 'zh') as ReviewCardsPayload;
    expect(again.key_moments).toEqual(moments);
  });

  it('fallback mentor note has no first-person Rubick persona (zh + en)', () => {
    const zhCards = buildFallbackAiCards(fact, 'zh') as ReviewCardsPayload;
    expect(zhCards.mentor_note).toBeTruthy();
    expect(zhCards.mentor_note!).not.toMatch(/拉比克|我是/);
    expect(zhCards.mentor_note!).toContain('军团指挥官');

    const enFact = buildMatchFact(parsedFixture, { lang: 'en', heroId: 104, heroNames: HERO_NAMES }) as MatchFact;
    const enCards = buildFallbackAiCards(enFact, 'en') as ReviewCardsPayload;
    expect(enCards.mentor_note).toBeTruthy();
    expect(enCards.mentor_note!).not.toMatch(/Rubick|I am|i'm/i);
    expect(enCards.mentor_note!).toContain('Legion Commander');
  });
});

describe('match 9035042364 unparsed fixture', () => {
  it('marks lanes unknown, timeline empty, grounded false with field reasons', () => {
    const fact = buildMatchFact(unparsedFixture, { lang: 'zh', heroId: 104, heroNames: HERO_NAMES }) as MatchFact;
    expect(fact.parsed).toBe(false);
    expect(fact.grounded).toBe(false);
    expect(fact.lanes).toHaveLength(0);
    expect(fact.players.every((p) => p.lane === 'unknown')).toBe(true);
    expect(fact.timeline).toHaveLength(0);
    expect(fact.economy.checkpoints).toHaveLength(0);

    expect(Object.keys(fact.fieldReasons ?? {}).sort()).toEqual(['economy', 'focusLane', 'lanes', 'timeline']);
    for (const reason of Object.values(fact.fieldReasons ?? {})) {
      expect(reason!.reason).toBe('not_parsed_yet');
      expect(reason!.message).toContain('尚未解析');
    }
  });

  it('localizes field reasons per lang', () => {
    const enFact = buildMatchFact(unparsedFixture, { lang: 'en', heroNames: HERO_NAMES }) as MatchFact;
    expect(enFact.fieldReasons?.lanes?.reason).toBe('not_parsed_yet');
    expect(enFact.fieldReasons?.lanes?.message).toMatch(/not parsed yet/i);
    expect(enFact.fieldReasons?.lanes?.message).not.toContain('尚未解析');
  });

  it('does not invent fallback key moments when there is no parsed data', () => {
    const fact = buildMatchFact(unparsedFixture, { lang: 'zh', heroId: 104, heroNames: HERO_NAMES }) as MatchFact;
    const cards = buildFallbackAiCards(fact, 'zh') as ReviewCardsPayload;
    expect(cards.key_moments).toHaveLength(0);
    expect(cards.primary_mistake).toBeUndefined();
  });
});

describe('parse status payload', () => {
  it('returns retry guidance in zh and en', () => {
    const zh = parseStatusPayload('requested', { jobId: 42, lang: 'zh' });
    expect(zh).toMatchObject({ status: 'requested', jobId: 42 });
    expect(zh.retryAfterSec).toBeGreaterThan(0);
    expect(zh.message).toMatch(/解析|重试/);

    const en = parseStatusPayload('pending', { lang: 'en' });
    expect(en.message).toMatch(/parsing|retry/i);

    const parsed = parseStatusPayload('parsed', { lang: 'en' });
    expect(parsed.retryAfterSec).toBeNull();
    expect(parsed.message).toMatch(/parsed/i);

    const failed = parseStatusPayload('failed', { lang: 'zh' });
    expect(failed.message).toContain('失败');
  });

  it('dedupes parse requests per match within the cooldown window', () => {
    let now = 1_000_000;
    const tracker = createParseRequestTracker({ now: () => now });
    expect(tracker.active(9035042364)).toBeNull();

    tracker.markRequested(9035042364);
    tracker.markResult(9035042364, { jobId: 7 });
    const active = tracker.active(9035042364);
    expect(active).toMatchObject({ jobId: 7, failed: false });
    expect(active!.retryAfterSec).toBeGreaterThan(0);

    now += PARSE_REQUEST_COOLDOWN_MS - 1_000;
    expect(tracker.active(9035042364)).not.toBeNull();

    now += 2_000;
    expect(tracker.active(9035042364)).toBeNull();
  });

  it('uses a shorter cooldown after a failed request', () => {
    let now = 5_000_000;
    const tracker = createParseRequestTracker({ cooldownMs: 60_000, failureCooldownMs: 10_000, now: () => now });
    tracker.markRequested(1);
    tracker.markResult(1, { failed: true });
    expect(tracker.active(1)).toMatchObject({ failed: true });
    now += 9_000;
    expect(tracker.active(1)).not.toBeNull();
    now += 2_000;
    expect(tracker.active(1)).toBeNull();
  });
});

describe('match detail cache', () => {
  const parsedData = parsedFixture;
  const unparsedData = unparsedFixture;

  it('serves unparsed entries only for the short TTL, then refreshes to parsed', async () => {
    let now = 10_000_000;
    const responses = [unparsedData, parsedData];
    let fetches = 0;
    const cache = createMatchDetailCache({
      now: () => now,
      fetchMatch: async () => {
        fetches += 1;
        return responses[Math.min(fetches - 1, responses.length - 1)];
      },
    });

    expect(await cache.get(9035042364)).toBe(unparsedData);
    expect(fetches).toBe(1);

    // Within the short TTL the unparsed entry is served from cache.
    now += UNPARSED_MATCH_CACHE_TTL_MS - 1_000;
    expect(await cache.get(9035042364)).toBe(unparsedData);
    expect(fetches).toBe(1);

    // Once the short TTL lapses, the upstream (now parsed) replaces the entry.
    now += 2_000;
    const refreshed = await cache.get(9035042364);
    expect(fetches).toBe(2);
    expect(refreshed).toBe(parsedData);

    // Parsed entries use the long TTL — no further upstream calls.
    now += MATCH_DETAIL_CACHE_TTL_MS - 1_000;
    expect(await cache.get(9035042364)).toBe(parsedData);
    expect(fetches).toBe(2);
  });

  it('never lets unparsed upstream data overwrite a parsed entry', () => {
    expect(shouldReplaceMatchDetailEntry(undefined, unparsedData)).toBe(true);
    expect(shouldReplaceMatchDetailEntry({ data: parsedData, timestamp: 1 }, unparsedData)).toBe(false);
    expect(shouldReplaceMatchDetailEntry({ data: parsedData, timestamp: 1 }, parsedData)).toBe(true);
    expect(shouldReplaceMatchDetailEntry({ data: unparsedData, timestamp: 1 }, parsedData)).toBe(true);
  });

  it('keeps the parsed entry when an unparsed refresh comes back', async () => {
    let now = 20_000_000;
    const responses = [parsedData, unparsedData];
    let fetches = 0;
    const cache = createMatchDetailCache({
      now: () => now,
      fetchMatch: async () => {
        fetches += 1;
        return responses[Math.min(fetches - 1, responses.length - 1)];
      },
    });
    expect(await cache.get(1)).toBe(parsedData);
    now += MATCH_DETAIL_CACHE_TTL_MS + 1_000;
    expect(await cache.get(1)).toBe(parsedData);
    expect(fetches).toBe(2);
  });

  it('serves stale data when the upstream refresh fails', async () => {
    let now = 30_000_000;
    let fetches = 0;
    const cache = createMatchDetailCache({
      now: () => now,
      fetchMatch: async () => {
        fetches += 1;
        if (fetches === 1) return parsedData;
        throw new Error('upstream 522');
      },
    });
    expect(await cache.get(1)).toBe(parsedData);
    now += MATCH_DETAIL_CACHE_TTL_MS + 1_000;
    expect(await cache.get(1)).toBe(parsedData);
    expect(fetches).toBe(2);
  });

  it('freshness follows parse state (short vs long TTL)', () => {
    const at = 100_000;
    const unparsedEntry = { data: unparsedData, timestamp: at };
    const parsedEntry = { data: parsedData, timestamp: at };
    expect(isMatchDetailEntryFresh(unparsedEntry, at + UNPARSED_MATCH_CACHE_TTL_MS - 1)).toBe(true);
    expect(isMatchDetailEntryFresh(unparsedEntry, at + UNPARSED_MATCH_CACHE_TTL_MS + 1)).toBe(false);
    expect(isMatchDetailEntryFresh(parsedEntry, at + MATCH_DETAIL_CACHE_TTL_MS - 1)).toBe(true);
    expect(isMatchDetailEntryFresh(parsedEntry, at + MATCH_DETAIL_CACHE_TTL_MS + 1)).toBe(false);
    expect(isMatchDetailEntryFresh(undefined, at)).toBe(false);
  });
});

describe('api health constants', () => {
  it('is healthy only when heroes/items/abilities are all loaded', () => {
    expect(computeApiHealth({ heroesLoaded: true, itemsLoaded: true, abilitiesLoaded: true }))
      .toMatchObject({ status: 'healthy' });
    expect(computeApiHealth({ heroesLoaded: true, itemsLoaded: true, abilitiesLoaded: true }).opendotaConstants.missing)
      .toEqual([]);
  });

  it('reports degraded with the missing constants listed', () => {
    const health = computeApiHealth({ heroesLoaded: false, itemsLoaded: true, abilitiesLoaded: false });
    expect(health.status).toBe('degraded');
    expect(health.opendotaConstants).toMatchObject({ heroes: false, items: true, abilities: false });
    expect(health.opendotaConstants.missing).toEqual(['heroes', 'abilities']);
  });
});

describe('review responder (POST /api/review Accept negotiation)', () => {
  it('treats only text/event-stream as streaming', () => {
    expect(wantsReviewStream('text/event-stream')).toBe(true);
    expect(wantsReviewStream('application/json')).toBe(false);
    expect(wantsReviewStream('*/*')).toBe(false);
    expect(wantsReviewStream(undefined)).toBe(false);
  });

  it('returns the full result as JSON (not a bare 406) for non-SSE Accept', () => {
    const res = createMockRes();
    const responder = createReviewResponder(res.mock, false);

    responder.begin();
    responder.send({ matchFact: { grounded: true }, grounded: true });
    responder.send({ text: 'he' });
    responder.send({ text: 'llo' });
    responder.send({ reviewCards: { drill: { title: 't' } } });
    responder.end({ parse: { status: 'parsed' } });

    expect(res.state.statusCode).toBe(200);
    expect(res.state.headersSent).toBe(false);
    expect(res.state.headers['Content-Type']).toBeUndefined();
    expect(res.state.body).toEqual({
      matchFact: { grounded: true },
      grounded: true,
      text: 'hello',
      reviewCards: { drill: { title: 't' } },
      parse: { status: 'parsed' },
    });
  });

  it('uses 502 for JSON results carrying an error payload', () => {
    const res = createMockRes();
    const responder = createReviewResponder(res.mock, false);
    responder.send({ text: 'partial' });
    responder.end({ error: 'Review stream ended incomplete' });
    expect(res.state.statusCode).toBe(502);
    expect(res.state.body).toMatchObject({ error: 'Review stream ended incomplete', text: 'partial' });
  });

  it('streams SSE frames when Accept: text/event-stream', () => {
    const res = createMockRes();
    const responder = createReviewResponder(res.mock, true);
    responder.begin();
    responder.send({ grounded: true });
    responder.end({ reviewCards: { ok: true } });

    expect(res.state.headers['Content-Type']).toBe('text/event-stream');
    expect(res.state.writes.join('')).toBe(
      'data: {"grounded":true}\n\n'
      + 'data: {"reviewCards":{"ok":true}}\n\n'
      + 'data: [DONE]\n\n',
    );
    expect(res.state.ended).toBe(true);
    expect(res.state.body).toBeUndefined();
  });
});

function createMockRes() {
  const state = {
    headers: {} as Record<string, string>,
    headersSent: false,
    statusCode: 0,
    body: undefined as unknown,
    writes: [] as string[],
    ended: false,
    writableEnded: false,
  };
  const mock = {
    setHeader(key: string, value: string) {
      state.headers[key] = value;
    },
    flushHeaders() {
      state.headersSent = true;
    },
    write(chunk: string) {
      state.writes.push(chunk);
      return true;
    },
    end() {
      state.ended = true;
      state.writableEnded = true;
    },
    status(code: number) {
      state.statusCode = code;
      return { json(body: unknown) { state.body = body; } };
    },
    json(body: unknown) {
      state.body = body;
    },
  };
  return { mock, state };
}

describe('review card validation reason codes', () => {
  it('describes why AI cards failed validation (no PII)', () => {
    expect(describeReviewCardsInvalidReason(undefined)).toBe('primary_mistake_not_grounded');
    expect(describeReviewCardsInvalidReason({})).toBe('primary_mistake_not_grounded');
    expect(describeReviewCardsInvalidReason({
      primary_mistake: {
        category: 'fight_timing',
        headline: 'h',
        explanation: 'e',
        evidence: [{ factKey: 'timeline_0' }],
      },
      key_moments: [],
      drill: { duration: '15 min', title: 't', steps: ['s'] },
    })).toBe('key_moments_not_grounded');
    expect(describeReviewCardsInvalidReason({
      primary_mistake: {
        category: 'fight_timing',
        headline: 'h',
        explanation: 'e',
        evidence: [{ factKey: 'timeline_0' }],
      },
      key_moments: [
        { timestamp: 1, headline: 'a', why: 'b', evidence: [{ factKey: 'timeline_0' }] },
        { timestamp: 2, headline: 'c', why: 'd', evidence: [{ factKey: 'timeline_1' }] },
        { timestamp: 3, headline: 'e', why: 'f', evidence: [{ factKey: 'timeline_2' }] },
      ],
      drill: {},
    })).toBe('drill_invalid');
    expect(isReviewAiCardsComplete({
      primary_mistake: {
        category: 'fight_timing',
        headline: 'h',
        explanation: 'e',
        evidence: [{ factKey: 'timeline_0' }],
      },
      key_moments: [
        { timestamp: 1, headline: 'a', why: 'b', evidence: [{ factKey: 'timeline_0' }] },
        { timestamp: 2, headline: 'c', why: 'd', evidence: [{ factKey: 'timeline_1' }] },
        { timestamp: 3, headline: 'e', why: 'f', evidence: [{ factKey: 'timeline_2' }] },
      ],
      drill: { duration: '15 min', title: 't', steps: ['s'] },
    })).toBe(true);
  });
});
