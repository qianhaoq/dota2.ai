# Counter tools of the review agent

Three knowledge tools let the review agent say *why* one hero, ability or item answers another:
`ability_counters`, `item_counters` and `hero_counters` (`lib/agent/counterTools.js`). They sit at the end of
`KNOWLEDGE_TOOLS`, so the deep review and the chat both get them, and their refs (`counter_ability:<ability>`,
`counter_item:<item>`, `counter_hero:<hero>:<against>`) resolve for evidence cards (`lib/agent/evidence.js`).

## Plan (as carried out)

1. Reuse rather than rebuild. The release a game was played on comes from `patchForGame` (letter release:
   7.41b, 7.41f, 7.42). Ability flags and item text come from that release's snapshot. Win rates come from
   `heroVs` (pro), `heroVsRank` (STRATZ by bracket), `laneMatchup` and `itemLifts`. Who held what, and from
   when, comes from `itemTimeline`.
2. Add one pure module of *mechanisms* (`lib/coach/counters.js`). Each mechanism states its rule basis,
   conditions and limits. The threat side is read from Valve's flags. The answer side is a curated list
   whose every entry must be confirmed by Valve's text of the game's release, and the sentence is quoted.
3. Add the three tools, register them, make their refs resolvable, and test the key mechanisms and the
   unknown cases.

## Mechanisms modelled

| mechanism | threat (from Valve's data) | answer (confirmed in Valve's text of the release) |
| --- | --- | --- |
| `debuff_immunity` | ability flag "Pierces Debuff Immunity" (`pierces`) | BKB, Minotaur Horn; Blade Fury, Rage, Martyr, Life Break (leap), Rolling Thunder |
| `basic_dispel` / `strong_dispel` | flag "Dispellable" (`dispel`: basic / strong / no) | items with "Dispel Type: … Dispel" (Manta, Eul's, Wind Waker, Lotus, Nullifier, Disperser, Greaves, Aeon Disk…); every ability whose text has a "DISPEL TYPE" line |
| `magic_damage` | damage type magical | magic barriers (Pipe, Glimmer); Valve's magic-resistance attributes |
| `physical_damage` | damage type physical | Ghost Scepter / Crella's ghost form, physical barriers (Pavise, Solar Crest); armor ≥ 4 |
| `pure_damage` | damage type pure | only answers whose text names pure damage (BKB, Minotaur Horn in 7.42) |
| `break` | behaviour "Passive" (not hidden) | Silver Edge, Khanda; Sharpshooter, Vendetta |
| `spell_block` | behaviour "Unit Target" | Linken's Sphere, Lotus Orb |
| `true_strike` | evasion (curated abilities checked against their text; item `bonus_evasion`) | MKB, Javelin, Witch Blade, Mjollnir proc, Bloodthorn (silenced target; and Pierce in 7.40–7.41f, gone in 7.42) |
| `true_sight` | invisibility (curated abilities checked against their text) | Gem, Sentry, Dust, Third Eye |
| `heal_reduction` | healing (curated abilities checked against their text) | Spirit Vessel, Skadi, Orb of Corrosion, Crippling Crossbow, Crella's aura…; Doom |

Every answer says whom it lands on (`on`). A dispel pairing carries `only_if`, because Valve's flag does not
say whether the effect is a debuff on your side or a buff on theirs.

## Unknown stays unknown

- An ability with no "Pierces Debuff Immunity" or "Dispellable" flag is listed under `not_known`. It is
  never counted as answered or as not answered.
- A curated entry whose words are not in the release's text is reported under `not_confirmed_in_this_release`,
  and it is not used. Example: Bloodthorn's Pierce exists in 7.41f and is gone in 7.42.
- An item with cost 0 in the release's data goes under `items_without_a_shop_price`. It may be a neutral item
  or one no longer sold; the data does not say which.
- Valve's bare `evasion` item key is not read, because it does not say whose evasion it is (Radiance lists one).

## Coverage gaps (not modelled: nothing in the repository's data grounds them)

Channel interruption, illusions (area damage against them), silence and mute as general counters, forced
movement and disjoints, positioning and timing. The tools return these under `gaps`. The curated evasion,
invisibility, healing and break lists are partial. Ability behaviour and text exist for the current release
only (`lib/data/constants/abilities.json`), so for an older game the tools say so under `gaps`.

## Data versions

| data | version | source |
| --- | --- | --- |
| item text, ability flags (`dmg`, `pierces`, `dispel`) | per letter release 7.40 … 7.42 | Valve's game files (dotabuff/d2vpkr) built with OpenDota's builder, `lib/data/constants/patches/*.json` |
| ability text and behaviour | 7.42, fetched 2026-11-24 | OpenDota `/constants` abilities |
| pro hero-vs-hero, lane | pro matches since 7.41, fetched 2026-11-24 | OpenDota explorer (`lib/coach/data/matchups.json`) |
| public hero-vs-hero by bracket | STRATZ patch 7.41, weeks 2026-10-15 … 2026-11-11 | STRATZ `heroStats.matchUp` (`matchups-rank.json`) |
| items pros build more against a hero | pro matches since 7.41, fetched 2026-11-24 | OpenDota explorer (`item-vs.json`) |

## Call evidence

Run `node scripts/counter-tools-sample.mjs` (offline, no model, no cost). It calls the tools through
`reviewToolkit().runTool`, as the agent does, on the fixture match 9100904020 (7.42 by match id).
Excerpts from 2026-11-24:

- `ability_counters {ability: necrolyte_reapers_scythe}`. Flags: magical, does not pierce, not dispellable,
  unit target. Answered by debuff immunity (BKB; held by Sven from 34:26), by magic damage (Pipe, BKB,
  Glimmer, Eternal Shroud…) and by spell block (Linken's, Lotus). Not answered by a basic or strong dispel,
  because it is `not_dispellable`.
- `item_counters {item: black_king_bar}`. The immunity answers 7 enemy abilities and does not answer 7,
  because they pierce (Berserker's Call, Culling Blade, Coup de Grace…). It is not known for 6. Phantom
  Assassin's Abyssal Blade (first held 34:49) goes through it: "Pierces Debuff Immunity."
- `hero_counters {against: phantom_assassin}` from Beastmaster, Legend bracket. In public games
  (STRATZ 7.41, 2750 games) Beastmaster wins 0.43 against Phantom Assassin, against 0.46 usually:
  `unfavoured`. There are too few pro games, which is reported as a gap.
- `item_counters {item: bloodthorn}` as a 7.41f game (zh). It answers evasion in two ways, against the
  silenced target and with Pierce. `changed_since_this_release`: `true_strike/own_attacks` is only in 7.41f.
- `ability_counters {ability: doom_bringer_doom}`. Debuff immunity and both dispels do not answer it (it
  pierces, and it is not dispellable). Pure damage is answered by BKB, by its 7.42 text "immunity to
  reflected and pure damage".
