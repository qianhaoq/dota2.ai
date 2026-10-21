# Offline OpenDota corpus

28 deterministic gzip JSON files, one per match ID in
`/workspace/dota2ai-kb/eval/gold.json` (as read on 2026-10-22).

Sources:

- 9035042364: `/workspace/dota2ai-kb/eval/pro/m9035042364.json`, including
  all original player deaths_log entries and their gold_fed/time_dead fields.
- 8985182860: repository `src/fixtures/match8985182860.json`. This source lacks
  deaths_log; missing death sums are expected gaps, not zero-valued facts.
- Remaining 26: `/workspace/dota2ai-kb/eval/pro/matches/<match_id>.json`.

Trim retains only match_id, duration, radiant_win, radiant_score, dire_score,
start_time, patch, version, od_data, radiant_gold_adv, radiant_xp_adv, objectives,
and players. Player fields retained: hero_id, player_slot, kills, deaths,
assists, account_id, kills_log, deaths_log, lh_t, purchase_log. No missing field
was synthesized. Compression uses gzip mtime=0. No fetch is needed for tests.

9035042364 has manually specified acceptance assertions in review.test.js.
Other matches have exhaustive player/language contract checks, without a claim
of manual numerical review.
