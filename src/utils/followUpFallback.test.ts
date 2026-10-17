import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { buildMatchFact } from '../../lib/matchReview/matchFacts.js';
import { buildThreeConclusions } from '../../lib/matchReview/threeConclusions.js';
import {
  buildFollowUpFallbackText,
  decideFollowUpOutcome,
  followUpFallbackLeadLine,
  reviewFollowUpFallbackNotice,
} from '../../lib/matchReview/followUpFallback.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const match = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/match9035042364.parsed.json'), 'utf8')
);

const HERO_NAMES: Record<number, { nameZh: string; nameEn: string; internalSlug: string }> = {
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

// Radiant Pudge — the player the per-player prompt tests use for this fixture.
const FOCUS_HERO_ID = 14;

// focus: 'none' builds a focus-less fact (null focusLens); omitting it
// defaults to the focus hero.
function buildInputs(lang: 'en' | 'zh', focus: number | 'none' = FOCUS_HERO_ID) {
  const matchFact = buildMatchFact(
    match,
    focus === 'none'
      ? { lang, heroNames: HERO_NAMES }
      : { lang, heroId: focus, heroNames: HERO_NAMES },
  );
  const threeConclusions = buildThreeConclusions(matchFact, { lang });
  return { matchFact, threeConclusions };
}

const NUMBER_PATTERN = /-?\d[\d,]*/g;

describe('buildFollowUpFallbackText', () => {
  for (const lang of ['en', 'zh'] as const) {
    it(`starts with the lead line and lists all three conclusions (${lang})`, () => {
      const { matchFact, threeConclusions } = buildInputs(lang);
      const text = buildFollowUpFallbackText(matchFact, threeConclusions, lang);

      expect(text.startsWith(followUpFallbackLeadLine(lang))).toBe(true);
      for (const key of ['turningPoint', 'topMistake', 'nextGameRule'] as const) {
        expect(text).toContain(threeConclusions[key].title);
        expect(text).toContain(threeConclusions[key].summary);
      }
    });

    it(`states only numbers traceable to the conclusions or the match fact (${lang})`, () => {
      const { matchFact, threeConclusions } = buildInputs(lang);
      const text = buildFollowUpFallbackText(matchFact, threeConclusions, lang);

      const sources = [
        JSON.stringify(matchFact),
        threeConclusions.turningPoint.title,
        threeConclusions.turningPoint.summary,
        threeConclusions.topMistake.title,
        threeConclusions.topMistake.summary,
        threeConclusions.nextGameRule.title,
        threeConclusions.nextGameRule.summary,
      ].join('\n');

      for (const rawNumber of text.match(NUMBER_PATTERN) ?? []) {
        // Strip a trailing comma picked up by the digit[,digit]* pattern so
        // "22, GPM" compares as the number 22, not the string "22,".
        const number = rawNumber.replace(/,$/, '');
        expect(sources).toContain(number);
      }
    });

    it(`ends with the focus hero KDA/GPM when focusLens exists (${lang})`, () => {
      const { matchFact } = buildInputs(lang);
      const lens = matchFact.focusLens!;
      const text = buildFollowUpFallbackText(
        matchFact,
        buildThreeConclusions(matchFact, { lang }),
        lang,
      );
      expect(text).toContain(`KDA ${lens.kda}`);
      expect(text).toContain(`GPM ${lens.gpm}`);
    });

    it(`omits the KDA/GPM line when there is no focus hero (${lang})`, () => {
      const { matchFact } = buildInputs(lang, 'none');
      expect(matchFact.focusLens).toBeNull();
      const text = buildFollowUpFallbackText(
        matchFact,
        buildThreeConclusions(matchFact, { lang }),
        lang,
      );
      expect(text).not.toContain('KDA');
      expect(text).not.toContain('GPM');
    });
  }

  it('lists insufficient conclusions verbatim instead of inventing facts', () => {
    // No focus hero: topMistake and nextGameRule come back insufficient.
    const { matchFact, threeConclusions } = buildInputs('en', 'none');
    expect(threeConclusions.topMistake.status).toBe('insufficient');
    const text = buildFollowUpFallbackText(matchFact, threeConclusions, 'en');
    expect(text).toContain(threeConclusions.topMistake.summary);
    expect(text).toContain('Insufficient data');
  });

  it('returns only the lead line and an insufficient marker when inputs are missing', () => {
    for (const lang of ['en', 'zh'] as const) {
      const insufficient = lang === 'zh' ? '数据不足' : 'Insufficient data';
      const expected = `${followUpFallbackLeadLine(lang)}\n\n${insufficient}`;
      expect(buildFollowUpFallbackText(null, null, lang)).toBe(expected);
      expect(buildFollowUpFallbackText(undefined, undefined, lang)).toBe(expected);
      const { matchFact, threeConclusions } = buildInputs(lang);
      expect(buildFollowUpFallbackText(null, threeConclusions, lang)).toBe(expected);
      expect(buildFollowUpFallbackText(matchFact, null, lang)).toBe(expected);
    }
  });
});

describe('reviewFollowUpFallbackNotice', () => {
  it('is a short localized hint', () => {
    expect(reviewFollowUpFallbackNotice('zh')).toContain('追问');
    expect(reviewFollowUpFallbackNotice('zh')).toContain('比赛数据');
    expect(reviewFollowUpFallbackNotice('en')).toMatch(/match data/i);
    expect(reviewFollowUpFallbackNotice('en').length).toBeLessThan(120);
  });
});

describe('decideFollowUpOutcome', () => {
  it('ends normally on a clean provider finish with a terminal finish_reason', () => {
    for (const finishReason of ['stop', 'length', 'content_filter']) {
      expect(decideFollowUpOutcome({ status: 'done', finishReason, forwarded: true }))
        .toEqual({ action: 'end' });
    }
  });

  it('treats text-forwarded EOF without a terminal finish_reason as incomplete — template appended', () => {
    // Upstream proxies often drop finish_reason before [DONE]; without the
    // terminal signal the forwarded text may be a truncated half-answer, so
    // the deterministic template is appended after it (never a bare error).
    expect(decideFollowUpOutcome({ status: 'done', finishReason: null, forwarded: true }))
      .toEqual({ action: 'fallback', reason: 'incomplete', append: true });
    expect(decideFollowUpOutcome({ status: 'done', finishReason: undefined, forwarded: true }))
      .toEqual({ action: 'fallback', reason: 'incomplete', append: true });
    expect(decideFollowUpOutcome({ status: 'done', finishReason: 'tool_calls', forwarded: true }))
      .toEqual({ action: 'fallback', reason: 'incomplete', append: true });
  });

  it('ends on a non-terminal finish when no text was forwarded (empty streams are handled upstream)', () => {
    // streamFollowUpCompletion retries/empties streams before any text as the
    // next provider, so 'done' with forwarded=false is unreachable from it;
    // keep the defensive end (nothing to append to).
    expect(decideFollowUpOutcome({ status: 'done', finishReason: null, forwarded: false }))
      .toEqual({ action: 'end' });
    expect(decideFollowUpOutcome({ status: 'done', finishReason: 'stop', forwarded: false }))
      .toEqual({ action: 'end' });
  });

  it('ends without writing when the caller stopped the stream (client gone)', () => {
    expect(decideFollowUpOutcome({ status: 'stopped', finishReason: 'stop', forwarded: true }))
      .toEqual({ action: 'end' });
    expect(decideFollowUpOutcome({ status: 'stopped', finishReason: null, forwarded: false }))
      .toEqual({ action: 'end' });
  });

  it('replaces the whole answer when every provider failed before any text', () => {
    // failed = nothing was forwarded, so the template is sent as the only body.
    expect(decideFollowUpOutcome({ status: 'failed', finishReason: null }))
      .toEqual({ action: 'fallback', reason: 'all_failed', append: false });
  });

  it('appends the template when the stream broke after partial text', () => {
    // incomplete = text already reached the client; a retry would duplicate it.
    expect(decideFollowUpOutcome({ status: 'incomplete', finishReason: null }))
      .toEqual({ action: 'fallback', reason: 'incomplete', append: true });
  });

  it('defaults to a full-replacement fallback with no arguments', () => {
    expect(decideFollowUpOutcome()).toEqual({ action: 'fallback', reason: 'all_failed', append: false });
  });
});
