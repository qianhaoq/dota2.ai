import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildMatchFact } from '../../lib/matchReview/matchFacts.js';
import {
  buildFallbackAiCards,
  buildDeterministicReviewCards,
  canReviewAiCardsValidate,
  describeReviewCardsInvalidReason,
  isReviewAiCardsComplete,
} from '../../lib/matchReview/reviewCards.js';
import { LANE_CLUSTER_SOURCE } from '../../lib/matchReview/laneResolver.js';
import {
  isMatchParsed,
  createParseRequestTracker,
  createParseRequestBudget,
  parseStatusPayload,
  UNPARSED_MATCH_CACHE_TTL_MS,
  PARSE_REQUEST_COOLDOWN_MS,
  PARSE_BUDGET_WINDOW_MS,
} from '../../lib/matchReview/matchParse.js';
import {
  createMatchDetailCache,
  isMatchDetailEntryFresh,
  shouldReplaceMatchDetailEntry,
  MATCH_DETAIL_CACHE_TTL_MS,
} from '../../lib/matchReview/matchDetailCache.js';
import { computeApiHealth } from '../../lib/serverHealth.js';
import { reviewAiUnavailableNotice } from '../../lib/matchReview/reviewStream.js';
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

  it('claims replay grounding only when the match is actually parsed', () => {
    const parsedEn = buildMatchFact(parsedFixture, { lang: 'en', heroId: 104, heroNames: HERO_NAMES }) as MatchFact;
    const unparsedEn = buildMatchFact(unparsedFixture, { lang: 'en', heroId: 104, heroNames: HERO_NAMES }) as MatchFact;
    const parsedZh = buildMatchFact(parsedFixture, { lang: 'zh', heroId: 104, heroNames: HERO_NAMES }) as MatchFact;
    const unparsedZh = buildMatchFact(unparsedFixture, { lang: 'zh', heroId: 104, heroNames: HERO_NAMES }) as MatchFact;

    expect((buildFallbackAiCards(parsedEn, 'en') as ReviewCardsPayload).mentor_note)
      .toContain('grounded in replay data');
    expect((buildFallbackAiCards(parsedZh, 'zh') as ReviewCardsPayload).mentor_note)
      .toContain('复盘基于录像数据');

    const enNote = (buildFallbackAiCards(unparsedEn, 'en') as ReviewCardsPayload).mentor_note!;
    expect(enNote).toContain('based on basic match data (replay not parsed yet)');
    expect(enNote).not.toContain('grounded in replay data');

    const zhNote = (buildFallbackAiCards(unparsedZh, 'zh') as ReviewCardsPayload).mentor_note!;
    expect(zhNote).toContain('基于基础比赛数据（录像尚未解析）');
    expect(zhNote).not.toContain('复盘基于录像数据');
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

  it('downgrades an aborted in-flight request to a short retry window', () => {
    let now = 7_000_000;
    const tracker = createParseRequestTracker({
      cooldownMs: 300_000,
      failureCooldownMs: 60_000,
      abortCooldownMs: 60_000,
      now: () => now,
    });
    tracker.markRequested(1);
    tracker.markAborted(1);
    // Not failed (outcome unknown — later visitors must not see a bogus
    // 'failed'), but no longer plain pending either.
    expect(tracker.active(1)).toMatchObject({ jobId: null, failed: false, aborted: true });

    // Still deduped within the short abort window...
    now += 59_000;
    expect(tracker.active(1)).not.toBeNull();
    // ...and resubmittable once it lapses — far short of the success cooldown.
    now += 2_000;
    expect(tracker.active(1)).toBeNull();
  });

  it('clears the abort state on the next requested/result marking', () => {
    let now = 8_000_000;
    const tracker = createParseRequestTracker({ cooldownMs: 300_000, now: () => now });
    tracker.markAborted(1);
    tracker.markRequested(1);
    expect(tracker.active(1)).toMatchObject({ aborted: false });
    tracker.markResult(1, { jobId: 9 });
    expect(tracker.active(1)).toMatchObject({ jobId: 9, aborted: false });
  });
});

describe('parse request budget (global + per client)', () => {
  it('enforces the per-client cap within the window', () => {
    let now = 100_000_000;
    const budget = createParseRequestBudget({ now: () => now, globalMax: 10, perClientMax: 3 });
    expect(budget.tryConsume('203.0.113.7')).toBeNull();
    expect(budget.tryConsume('203.0.113.7')).toBeNull();
    expect(budget.tryConsume('203.0.113.7')).toBeNull();

    const blocked = budget.tryConsume('203.0.113.7');
    expect(blocked).toMatchObject({ scope: 'client' });
    expect(blocked!.retryAfterSec).toBeGreaterThan(0);

    // Other clients are unaffected; the window slides open again.
    expect(budget.tryConsume('198.51.100.9')).toBeNull();
    now += PARSE_BUDGET_WINDOW_MS + 1;
    expect(budget.tryConsume('203.0.113.7')).toBeNull();
  });

  it('enforces the global cap across all clients', () => {
    let now = 200_000_000;
    const budget = createParseRequestBudget({ now: () => now, globalMax: 3, perClientMax: 10 });
    expect(budget.tryConsume('a')).toBeNull();
    expect(budget.tryConsume('b')).toBeNull();
    expect(budget.tryConsume('c')).toBeNull();

    const blocked = budget.tryConsume('d');
    expect(blocked).toMatchObject({ scope: 'global' });
    expect(blocked!.retryAfterSec).toBeGreaterThan(0);

    now += PARSE_BUDGET_WINDOW_MS + 1;
    expect(budget.tryConsume('d')).toBeNull();
  });

  it('does not consume global budget for a throttled client', () => {
    let now = 300_000_000;
    const budget = createParseRequestBudget({ now: () => now, globalMax: 2, perClientMax: 1 });
    expect(budget.tryConsume('a')).toBeNull();
    // 'a' hits its per-client cap — this must NOT burn a global slot.
    expect(budget.tryConsume('a')).toMatchObject({ scope: 'client' });
    expect(budget.tryConsume('b')).toBeNull();
    expect(budget.tryConsume('c')).toMatchObject({ scope: 'global' });
  });
});

describe('parse status payload (throttled)', () => {
  it('reports throttling with retry guidance in zh and en', () => {
    const zh = parseStatusPayload('throttled', { retryAfterSec: 240, lang: 'zh' });
    expect(zh).toMatchObject({ status: 'throttled', retryAfterSec: 240 });
    expect(zh.message).toMatch(/频率上限|稍后/);

    const en = parseStatusPayload('throttled', { lang: 'en' });
    expect(en.retryAfterSec).toBeGreaterThan(0);
    expect(en.message).toMatch(/limit reached|try again/i);
  });
});

describe('AI card validation satisfiability', () => {
  it('requires timeline evidence for validation to be satisfiable', () => {
    expect(canReviewAiCardsValidate([])).toBe(false);
    expect(canReviewAiCardsValidate([{ factKey: 'kda', label: 'KDA', value: '1/2/3' }])).toBe(false);
    expect(canReviewAiCardsValidate([
      { factKey: 'kda', label: 'KDA', value: '1/2/3' },
      { factKey: 'timeline_0', label: '10:00', value: 'tower', timestamp: 600 },
    ])).toBe(true);
  });

  it('is unsatisfiable for unparsed matches and satisfiable for parsed ones', () => {
    const parsedFact = buildMatchFact(parsedFixture, { lang: 'zh', heroId: 104, heroNames: HERO_NAMES }) as MatchFact;
    const unparsedFact = buildMatchFact(unparsedFixture, { lang: 'zh', heroId: 104, heroNames: HERO_NAMES }) as MatchFact;
    const parsedCatalog = (buildDeterministicReviewCards(parsedFact, 'zh') as { _catalog: unknown[] })._catalog || [];
    const unparsedCatalog = (buildDeterministicReviewCards(unparsedFact, 'zh') as { _catalog: unknown[] })._catalog || [];
    expect(canReviewAiCardsValidate(parsedCatalog)).toBe(true);
    expect(canReviewAiCardsValidate(unparsedCatalog)).toBe(false);
  });
});

describe('review AI unavailable notices', () => {
  it('explains the no-evidence fallback in zh and en', () => {
    expect(reviewAiUnavailableNotice('zh', 'no_evidence')).toMatch(/尚未解析|基础比赛数据/);
    expect(reviewAiUnavailableNotice('en', 'no_evidence')).toMatch(/not parsed yet|basic match data/);
  });

  it('explains the parsed-but-no-timeline fallback without claiming the replay is unparsed', () => {
    expect(reviewAiUnavailableNotice('zh', 'no_timeline')).toMatch(/缺少时间线证据|基础比赛数据/);
    expect(reviewAiUnavailableNotice('zh', 'no_timeline')).not.toContain('尚未解析');
    expect(reviewAiUnavailableNotice('en', 'no_timeline')).toMatch(/No timeline evidence|basic match data/);
    expect(reviewAiUnavailableNotice('en', 'no_timeline')).not.toMatch(/not parsed yet/i);
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

  it('re-timestamps the retained parsed entry so requests stop hammering upstream', async () => {
    // Without the timestamp refresh the retained entry stays expired forever:
    // every request refetches while upstream keeps answering "unparsed".
    let now = 25_000_000;
    let fetches = 0;
    const cache = createMatchDetailCache({
      now: () => now,
      fetchMatch: async () => {
        fetches += 1;
        return fetches === 1 ? parsedData : unparsedData;
      },
    });

    expect(await cache.get(1)).toBe(parsedData);
    expect(fetches).toBe(1);

    // Entry goes stale; the refresh comes back unparsed and is refused.
    now += MATCH_DETAIL_CACHE_TTL_MS + 1_000;
    expect(await cache.get(1)).toBe(parsedData);
    expect(fetches).toBe(2);

    // Re-timestamped: the retained entry is fresh for a full long TTL —
    // repeated requests must not refetch upstream.
    now += 1_000;
    expect(await cache.get(1)).toBe(parsedData);
    now += MATCH_DETAIL_CACHE_TTL_MS - 2_000;
    expect(await cache.get(1)).toBe(parsedData);
    expect(fetches).toBe(2);

    // After the renewed TTL lapses, one refresh may run again (OpenDota may
    // have re-parsed by then).
    now += 2_000;
    expect(await cache.get(1)).toBe(parsedData);
    expect(fetches).toBe(3);
  });

  it('serves stale data when the upstream refresh fails, then backs off', async () => {
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

    // Stale-on-error re-timestamps the entry: during the outage every further
    // request must be served from the cache instead of firing another
    // (4-retry) upstream refresh.
    now += 1_000;
    expect(await cache.get(1)).toBe(parsedData);
    now += MATCH_DETAIL_CACHE_TTL_MS - 2_000;
    expect(await cache.get(1)).toBe(parsedData);
    expect(fetches).toBe(2);

    // Parsed data is immutable, so the renewed long TTL fully elapses before
    // another refresh attempt runs.
    now += 2_000;
    expect(await cache.get(1)).toBe(parsedData);
    expect(fetches).toBe(3);
  });

  it('backs off with the short TTL after serving stale unparsed data on error', async () => {
    let now = 35_000_000;
    let fetches = 0;
    const cache = createMatchDetailCache({
      now: () => now,
      fetchMatch: async () => {
        fetches += 1;
        if (fetches === 1) return unparsedData;
        throw new Error('upstream 522');
      },
    });
    expect(await cache.get(1)).toBe(unparsedData);
    // Entry expires; the refresh fails and the stale unparsed data is served
    // with a renewed (short) TTL.
    now += UNPARSED_MATCH_CACHE_TTL_MS + 1_000;
    expect(await cache.get(1)).toBe(unparsedData);
    expect(fetches).toBe(2);
    now += 1_000;
    expect(await cache.get(1)).toBe(unparsedData);
    expect(fetches).toBe(2);
    // Unparsed freshness matters (the parse may complete upstream): retry
    // after the short TTL, not the parsed long TTL.
    now += UNPARSED_MATCH_CACHE_TTL_MS;
    expect(await cache.get(1)).toBe(unparsedData);
    expect(fetches).toBe(3);
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

  it('dedupes overlapping refreshes into a single upstream fetch', async () => {
    let now = 400_000_000;
    let fetches = 0;
    const resolvers: Array<(data: object) => void> = [];
    const cache = createMatchDetailCache({
      now: () => now,
      fetchMatch: () => new Promise((resolve) => {
        fetches += 1;
        resolvers.push(resolve);
      }),
    });

    const first = cache.get(9035042364);
    const second = cache.get(9035042364);
    const third = cache.get(9035042364);
    // Without in-flight dedup each caller would start its own fetch and a
    // slow unparsed response could land after (and overwrite) a parsed one.
    expect(fetches).toBe(1);

    resolvers[0](unparsedData);
    expect(await first).toBe(unparsedData);
    expect(await second).toBe(unparsedData);
    expect(await third).toBe(unparsedData);

    // After the short TTL a single replacement refresh may run.
    now += UNPARSED_MATCH_CACHE_TTL_MS + 1_000;
    const fourth = cache.get(9035042364);
    resolvers[1](parsedData);
    expect(await fourth).toBe(parsedData);
    expect(fetches).toBe(2);
  });

  it('retries on its own when a shared refresh dies with its initiator', async () => {
    let fetches = 0;
    let failFirst = true;
    let resolveSecond: (data: object) => void = () => {};
    const cache = createMatchDetailCache({
      fetchMatch: () => new Promise((resolve, reject) => {
        fetches += 1;
        if (failFirst) {
          failFirst = false;
          reject(new Error('This operation was aborted'));
          return;
        }
        resolveSecond = resolve;
      }),
    });

    // Caller 1 supplies an abort signal; caller 2 (still connected) shares
    // the in-flight refresh. Caller 1 disconnects, aborting the shared fetch.
    const controller = new AbortController();
    const first = cache.get(1, { signal: controller.signal });
    const second = cache.get(1);
    controller.abort();

    await expect(first).rejects.toThrow(/aborted/);
    resolveSecond(parsedData);
    expect(await second).toBe(parsedData);
    expect(fetches).toBe(2);
  });

  it('propagates ordinary upstream failures to every shared-refresh waiter', async () => {
    let fetches = 0;
    const cache = createMatchDetailCache({
      fetchMatch: () => new Promise((resolve, reject) => {
        fetches += 1;
        reject(new Error('upstream 522'));
      }),
    });

    // Three callers share one in-flight refresh whose failure is NOT an
    // initiator abort. Every waiter must see the same error — none may start
    // its own retry wave of upstream fetches.
    const controller = new AbortController();
    const calls = [
      cache.get(1, { signal: controller.signal }),
      cache.get(1),
      cache.get(1),
    ];
    await Promise.all(calls.map((p) => expect(p).rejects.toThrow(/upstream 522/)));
    expect(fetches).toBe(1);
  });

  it('keeps the parsed entry a late unparsed refresh would replace', async () => {
    let now = 500_000_000;
    let fetches = 0;
    const resolvers: Array<(data: object) => void> = [];
    const cache = createMatchDetailCache({
      now: () => now,
      fetchMatch: () => new Promise((resolve) => {
        fetches += 1;
        resolvers.push(resolve);
      }),
    });

    const first = cache.get(1);
    resolvers[0](parsedData);
    expect(await first).toBe(parsedData);

    // The parsed entry goes stale; the refresh that comes back is unparsed.
    now += MATCH_DETAIL_CACHE_TTL_MS + 1_000;
    const second = cache.get(1);
    resolvers[1](unparsedData);
    expect(await second).toBe(parsedData);
    expect(fetches).toBe(2);

    // The cache still holds the parsed entry, so a later refresh that comes
    // back unparsed again is also refused.
    now += MATCH_DETAIL_CACHE_TTL_MS + 1_000;
    const third = cache.get(1);
    resolvers[2](unparsedData);
    expect(await third).toBe(parsedData);
    expect(fetches).toBe(3);
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
