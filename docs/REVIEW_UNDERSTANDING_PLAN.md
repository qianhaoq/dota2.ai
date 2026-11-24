# Review agent: game understanding — plan and status

What the review agent has to understand before it gives advice, the tools that supply each part, and what
this branch adds. The acceptance case is match 9080127650 (Night Stalker): the review must say where the
lane support was during the early deaths in the bottom lane, and what it did there. It must weigh staying
for a 2v2 against leaving, and say how Night Stalker could have answered. It must tie this back to the
draft, items and skill build. Blame and hindsight are not answers.

## The chain

| link | what it needs | tools before this branch | added here |
| --- | --- | --- | --- |
| rules and version | the game's letter release, what abilities and items do in it, day and night | `hero_abilities`, patch data per release | `ability_counters` / `item_counters` / `hero_counters` (mechanisms from Valve's text of the release); day and night per phase, checked against Night Stalker's Void where the replay shows it (`lane_phase`) |
| lane | who laned where, partner presence, 2v1 and 2v2 time, deaths with both sides' health, levels and spells, consumables | `lane_report` (needs OpenDota's parse), `death_context` | `lane_phase` (replay only: works without the parse) |
| levels and skills | the skill order, the levels of everyone in the lane | `power_spikes` (levels 6/12/18) | the order of the player's first ten skill points in `lane_phase`, next to the professional distribution for the same hero and lane role (`learn_from_pros`) |
| health, mana and items | per moment | `death_context`, `item_timeline`, `build_check` | consumables held at each lane death; purchases before 10:00 next to professionals' (`learn_from_pros`) |
| position and known vision | where everyone was; what was seen | positions; vision is a gap | wards placed by both sides with the placer's position. What anyone saw stays unknown and is never called "no vision". |
| roles and power spikes | lane roles, day/night windows, level and item timings | `power_spikes`, `lineup_timing` | lane roles from positions; the next night phase relative to each death |
| alternatives | what else the player or the support could have done | — | each support absence as a choice: what the roam produced and what the lane lost, both measured; the 2v2 that did not happen stays unknown |
| payoff and opportunity cost | measured gains and losses | — | kills the absent support took part in, wards, levels gained; the player's deaths, seconds dead and levels against the lane opponents |
| evidence and uncertainty | facts, inferences and gaps kept apart | refs, verification, `blind_spots` | each finding gets `inference` and `unknown` beside its cited facts. Each rule gets `why` and `depends_on`. `learn_from_pros` entries name their source, version and sample. A repair round catches empty advice ("少死", "注意地图", "提升打钱"…). |

## Learning from professionals, without copying

`learn_from_pros` reads the same hero in the same lane role. For the skills: professionals' order of the
first ten points, by level, from OpenDota's professional matches since 7.41. For the items: professionals'
purchases before 10:00, and their mid-game items. For the draft: the lane opponents in public games of the
player's bracket (STRATZ) and in professional games, plus the counter mechanisms. Each entry says what
professionals chose, how often, what the player chose, the Valve text that explains the choice, and its
limits. Professional teams play as coordinated five-stacks, while a public game is solo queue, and the pro
sample is not the player's bracket. The review then states its advice with the reason, the conditions it
applies under, and the trade-off.

## Not in this branch (gaps, stated rather than promised)

- Creep waves, lane equilibrium, pulls and stacks: the trace has no creep entities.
- Gold and last hits for unparsed matches: OpenDota's per-minute data is needed, and this match has none.
- Fog of war: what each side could see.
- Professional macro (rotations, the timing of the first tower push, smoke timings) and pro support roaming patterns.
- Rune pickups.
- Talent choices beyond level 10, and the neutral items.
- A full model-run review of the acceptance match. It costs model tokens on the owner's key, so it was not run
  here; the acceptance evidence is the tool outputs and the deterministic checks.
