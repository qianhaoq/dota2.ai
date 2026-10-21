# @dota2ai/review-engine

Pure match-review logic shared through an ESM workspace package. Legacy lib imports remain available through re-export shims. No network requests or credentials are required.

The bundled hero table provides offline name and slug fallbacks; live metadata takes priority. Its patch and source date are recorded in data/static-heroes.json.

Run `npm run build:types -w @dota2ai/review-engine` to generate declarations in dist, or `npm run typecheck -w @dota2ai/review-engine` to check JavaScript without emitting.

## Review v1 (PR2)

```js
import { buildReview, validateReview, ENGINE_VERSION } from '@dota2ai/review-engine';
const review = buildReview(raw, {
  heroId: 14, lang: 'en', fetchedAt: '2026-10-22T00:00:00Z', patch: '7.41f',
});
const { ok, errors } = validateReview(review);
```

The JSON Schema lives at `src/schema/review.v1.json` and ships with `src`.
`fetchedAt` supplies both citation and generation timestamps: the engine never
reads the clock, fetches data, or calls an LLM. `raw.patch` takes precedence over
`opts.patch`; no static hero-table patch is substituted for a match patch.
Without `heroId`, player is null and insights are empty; shared facts use Radiant
perspective. With a hero, gold/XP facts use that player's team perspective, while
`series.radiant_*` retains the original Radiant values.

Window rules (earliest start wins ties):

- Turning point: smallest `gold[m+5] - gold[m]`, requiring all six samples.
- Comeback: after the global gold low, largest five-minute XP increase, provided
  gold starts below zero and improves over the same window. This identifies
  52–57 in 9035042364; it describes recovery, not a prediction or a match win.
- Death disadvantage: `gold[floor(t/60)] < -1000`, strictly. Missing samples
  invalidate the count; no clamping or interpolation. Legacy deathTimeline
  behavior is unchanged.
- Fix-this priority: at least two behind deaths, then a repeated killer, then
  phase concentration (0–10, 10–25, 25+). Next-game uses available ten-minute
  economy/last-hit facts, without inventing a benchmark.

Death timelines prefer `deaths_log`; when absent, complete roster-mapped
`kills_log` can be inverted. Disagreement with scoreboard deaths is registered
as a gap. Gold fed and time dead only come from complete `deaths_log` fields,
never inferred from kills, respawn formulas or scoreboard values. PR2 does not
interpret `opts.kb`: build recommendations remain a gap until a compliant,
patch-matched KB adapter exists. Death location coordinates remain unavailable.
All purchases are retained; `key_item: false` means no key-item classifier was
applied. Objective types/keys preserve OpenDota identifiers.

Run `npm test -w @dota2ai/review-engine` or root `npm test`. The golden corpus
covers all 28 IDs in the supplied `eval/gold.json`; the 9035042364 test locks
all PR2 acceptance values. Corpus-wide checks cover all players and both
languages, schema validity, evidence references, input immutability and repeat
serialization. Only the focal match has manually specified numerical gold
assertions; other games are regression/contract coverage, not manually verified
numeric baselines.
