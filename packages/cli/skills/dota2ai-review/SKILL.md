---
name: dota2ai-review
description: Retrieve and explain evidence-grounded dota2.ai post-match reviews for public Dota 2 match IDs using the CLI or public HTTP API, including missing-data limitations.
---

Use for browserless post-match review access. Requires shell + Node >=20.10
and this repository checkout, or curl + access to the public API. No Grok
internal tools, local coach/dsh installation, or LLM credentials are required.

## Parameters

- `match_id`: required positive integer, at most 2^40; public match only.
- `hero`: optional known slug such as `pudge` or numeric ID such as `14`.
  If absent, inspect the returned roster and ask which hero to review before
  making player-specific claims. Do not infer the user's identity.
- `lang`: `en` (default) or `zh`; follow the user's requested language.

## Retrieve

From the checkout root, install dependencies once and invoke the CLI:

```sh
npm ci
node packages/cli/bin/dota2ai.js review 9035042364 --hero 14 --lang en --json
```

Replace example values with the requested parameters. Packages `dota2ai`,
`@dota2ai/mcp`, and `@dota2ai/review-engine` are not published on npm yet;
use this checkout, not registry npx commands. Remote mode uses
`https://dota2.ai/api/v1/review/:id`; `DOTA2AI_API_BASE` overrides its origin.
No site `.env` is required.

Without a checkout, use the same public Review API directly:

```sh
curl --fail-with-body --silent --show-error --max-time 30 \
  'https://dota2.ai/api/v1/review/9035042364?hero=14&lang=en'
```

curl uses its own exit codes. HTTP error bodies are errors, not Review objects.
CLI exit codes: 0 success (including unparsed), 2 invalid input, 3 insufficient
(JSON still emitted), 4 upstream/network/invalid response. Report failures and
respect rate limits; do not invent a review or retry indefinitely.

If explicitly choosing the local engine, add `--offline` to the CLI. This still
needs network access to OpenDota, then builds the review locally without an LLM.
`OPENDOTA_API_KEY` is optional. State which mode supplied the result; do not
silently replace a failed remote request with a claimed remote success.

## Interpret and cite

The response is API Review JSON, schema `dota2.ai/review@1`.

- Check `state`, `match.id` and nullable `player` before summarizing. Confirm
  `player.hero_id` matches the requested hero. `unparsed` is a successful
  retrieval with limited evidence; `insufficient` is not a complete analysis.
- Read each insight's `status`, `claim.text`, `fact_ids`, `evidence`, `citations`
  and `data_gap`. Resolve `fact_ids` through top-level `facts` and citation IDs
  through top-level `citations`. Cite returned source URLs when present and
  retain relevant timestamps. If no URL is supplied, identify the returned
  fact/citation ID rather than fabricating a link.
- Preserve top-level `data_gaps` topics **and reasons**, plus insight-specific
  gaps, in any saved JSON and explain relevant limitations in the summary.
  Do not turn null values or absent evidence into zeroes or player mistakes.
- Ground numbers and timing claims in returned facts. Separate supported
  observations from advice; do not infer causation, positioning, intent,
  ability usage, patch balance or replay details that the evidence cannot show.
- Report only supported conclusions in the requested language. If evidence
  cannot answer the question, say what is unknown and which data gap applies.

Private matches are unsupported. Do not request private account data or keys,
claim npm publication, or invoke a learning loop on the public hot path. This
skill reads reviews; it does not install a coach runtime or mutate training data.
