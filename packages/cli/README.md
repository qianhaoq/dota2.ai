# dota2ai

`dota2ai`, `@dota2ai/mcp` and `@dota2ai/review-engine` are **not published on npm yet**.
Use Node >=20.10 and a clone/worktree of this repository. From its root:

```sh
npm ci
node packages/cli/bin/dota2ai.js review 9035042364 --hero 14 --lang en --json
node packages/cli/bin/dota2ai.js review 9035042364 --hero pudge --json --offline
```

No site `.env` or LLM keys are needed to use the CLI. Alternatively, after
`npm ci` at the root, create and run a local tarball:

```sh
cd packages/cli
npm pack
npx --yes --package ./dota2ai-*.tgz dota2ai review 9035042364 --hero 14 --json
```

Use a directory containing only the desired tarball when using the wildcard.
Packing bundles the workspace engine and its runtime dependencies; it does not
publish anything. The tarball also includes the agent skill in `skills/`.

## Coach commands (for you and your agent)

```sh
node packages/cli/bin/dota2ai.js help
node packages/cli/bin/dota2ai.js recent <friend code | profile link>
node packages/cli/bin/dota2ai.js coach 9091400302 --hero tidehunter --lang zh
node packages/cli/bin/dota2ai.js coach 9091400302 --hero tidehunter --section why --json
node packages/cli/bin/dota2ai.js cases 9091400302 --hero tidehunter
node packages/cli/bin/dota2ai.js ask 9091400302 --hero tidehunter "Which death was the most avoidable?"
node packages/cli/bin/dota2ai.js goal set 9091400302 --hero tidehunter
node packages/cli/bin/dota2ai.js goal check            # your next public game
node packages/cli/bin/dota2ai.js matchup tidehunter ursa --lang zh   # pro games, no match needed
```

- `coach --section`: `summary` (default: the causes that decided the game,
  yours first; what to practise; findings), `why`, `lane`, `deaths`, `items`,
  `fights`, `plan`, `all`. `--json` prints `{schema, engine, match, player,
  review, data_gaps, url}` for the seat, or `{section, value}` with `--section`.
- `matchup <hero> <vs>`: from pro games since the previous patch — win rate and
  lane gold at 10:00 (a verdict only when the gap is real, always with the
  number of games), the items pros on each side build clearly more often
  against the other, and Valve's damage-type / spell-immunity facts for the
  other hero's abilities. `--json` prints the structured brief plus `lines`.
- `goal` keeps the goal in `$DOTA2AI_HOME/goal.json` (default `~/.dota2ai`) and
  judges later games with the same function as the web page.
- Same exit codes as below; same origin override (`DOTA2AI_API_BASE`).

### Use it from your agent

The skill [`skills/dota2ai-coach/SKILL.md`](skills/dota2ai-coach/SKILL.md)
tells an agent when to call which command and how to read the output.

- **Claude Code**: copy the folder into your skills directory —
  `cp -r packages/cli/skills/dota2ai-coach ~/.claude/skills/` (all projects) or
  `.claude/skills/` (one project). Then ask "review my last Dota game".
- **Codex / other agents**: point `AGENTS.md` (or the agent's instructions) at
  the skill file, or paste its body; the agent needs a shell in this checkout.
- **MCP clients**: see [the MCP guide](../mcp/README.md).

## Replay questions (`trace`)

The coach commands above read the scoreboard-level match data. `trace` reads a
parsed replay: where every hero stood each second, every cooldown, every cast.
It is offline and always prints JSON.

```bash
# 1. Parse the replay with the extractor (docs/REPLAY_INGEST.md), then compact it:
node scripts/build-trace.mjs <extractDir> match.trace.json.gz --match <matchId>

# 2. Ask it things:
dota2ai trace                                              # the tools and their arguments
dota2ai trace match_overview   --trace match.trace.json.gz
dota2ai trace death_context    --trace match.trace.json.gz --hero beastmaster --index 9
dota2ai trace ability_audit    --trace match.trace.json.gz --hero beastmaster --ability primal_roar
dota2ai trace immunity_windows --trace match.trace.json.gz --hero phantom_assassin \
                               --watch-hero beastmaster --watch-ability primal_roar
dota2ai trace fight_timeline   --trace match.trace.json.gz --from 30:05 --to 31:00
```

- `match_overview`: line-ups, every fight and who lost fewer heroes, buildings.
- `tempo_report` (`--hero`): the game in stretches of ten minutes from that
  hero's side — buildings each side took, hero deaths, each fight with whether
  a building followed within two minutes and whether the hero was there, and
  where the hero spent their living time (which side of the map, alone or
  with allies) and their damage to buildings.
- `death_context`: the seconds before each death — who was near, what was
  ready, who dealt the damage, which disables landed. Over all the deaths:
  how many began below half health, with no ally near, against three or more
  enemies, and where the damage came from (one hero's attacks, or abilities).
  An ability off cooldown the hero had no mana for is not listed as ready.
- `ability_audit`: every cast of one ability — target, whether the target was
  spell immune, which enemy heroes it damaged in the next 15 seconds, who died after — and the deaths with it ready and not cast.
- `immunity_windows`: every Black King Bar, and what a watched ability was
  doing when it opened.
- `fight_timeline`: up to 180 seconds, event by event.

The tools report facts with their game time and the combat-log row behind
them; they do not judge. What a replay does not hold (fog of war, creeps,
Roshan) is listed under `gaps`, never guessed. Exit codes: 0 ok, 2 invalid
input, 3 trace file missing or not a trace.

## Inputs and network access

```text
dota2ai review <matchId> [--hero slug|id] [--lang en|zh] [--json] [--offline]
```

- `matchId`: positive integer, at most 2^40; public matches only.
- `--hero`: known hero slug (e.g. `pudge`) or numeric ID (`14`). Omit it to
  receive the roster with no selected player; do not guess the user's hero.
- `--lang`: `en` (default) or `zh`.
- `--json`: emit the full API Review JSON to stdout; errors go to stderr.
- Default remote mode requests `https://dota2.ai/api/v1/review/:id` and needs
  network access. `DOTA2AI_API_BASE` overrides the origin, e.g.
  `DOTA2AI_API_BASE=http://localhost:8080 node packages/cli/bin/dota2ai.js review 9035042364 --hero 14 --json`.
- `--offline` bypasses dota2.ai but **still fetches OpenDota over the network**,
  then runs the bundled `@dota2ai/review-engine` locally. No LLM or LLM keys;
  `OPENDOTA_API_KEY` is optional. It is not a disconnected replay reader.

## Output and boundaries

JSON uses the same `dota2.ai/review@1` schema as the public API:
[Review schema](../review-engine/src/schema/review.v1.json).
Read `state`, `match`, nullable `player`, `roster`, `insights`, `facts`,
`citations` and `data_gaps` together. Preserve `data_gaps` topics and reasons
and each insight's `data_gap`; missing evidence is not evidence of a mistake.
Resolve insight `fact_ids` against `facts` and citation IDs against `citations`
when explaining a claim. Use returned source URLs and timestamps; never invent
numbers, timings, causal conclusions or private-match access.

| Exit | Meaning |
| --- | --- |
| 0 | Success, including `unparsed` (not a promise of complete evidence) |
| 2 | Invalid input, including unknown hero |
| 3 | `insufficient`; JSON is still emitted with `--json` |
| 4 | Upstream/network failure, timeout, invalid JSON or invalid review |

An unparsed or insufficient review may only support a limited summary. Report
its gaps instead of filling them. Private matches and a learning loop on the
public request path are unsupported. This CLI reuses the public Review API or
local engine; it does not start a second AI runtime.

Agents: [dota2ai-coach skill](skills/dota2ai-coach/SKILL.md) (the coach) and [dota2ai-review skill](skills/dota2ai-review/SKILL.md) (the v1 review).
Optional existing MCP: [MCP guide](../mcp/README.md).

## Verification

From the repo root:

```sh
npm test -- packages/cli/test/cli.test.js
node packages/cli/scripts/verify-packed.js
```

The packed check uses the existing gzipped fixture as the fetch response and
compares full JSON with the engine, including match ID, gold.low and insight
IDs. It needs no keys or registry access.

Opt-in **live** smoke (not part of CI; requires production network access):

```sh
node packages/cli/scripts/smoke-live.js
```

This runs the actual CLI with `9035042364 --hero 14 --lang en --json`, pins the
API origin to `https://dota2.ai`, asserts exit 0, schema validity, match/player
identity, and presence of `insights` and `data_gaps`. It prints only match ID,
hero, insight count and gap topics. A failure is a failed smoke, never fixture
evidence of live availability. Respect upstream rate limits; do not retry in a
tight loop.
