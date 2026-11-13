# Official replay player review

The match page uses deterministic, cited replay moments rather than assigning
purchase and death records to a mandatory mistake or next-game verdict.
Match 9080127650 has five review candidates: Hook, Void before Dismember,
Darkness before Reaper’s Scythe, a skeleton death before the BKB purchase,
and two verified BKB immunity windows. Questions ask the player to inspect
health, positioning, team context and exits; they do not grade spell hits,
item timing, or the cause of the result.

## Evidence and persistence

The reviewed compact artifact remains the only replay data copied by Docker.
Its existing death timestamps, purchases, objective anchors, hashes, clock and
trace version are preserved. Enrichment comes from the same official extract:
hero ABILITY events, selected ITEM uses, and BKB immunity MODIFIER_REMOVE events.
Phase Boots uses are counted instead of listed. Deaths retain non-hero killers
and known inflictors. No death-event networth or last_hits values are interpreted
as the victim's resources. Account and persona fields are excluded.

The site extractor now retains those event types and the shared replay adapter
persists the optional arrays for future official-file parses. This does not
enable production ingest. Existing artifacts remain readable.

Combat events provide sparse health and target context, and nearby state
positions remain samples rather than exact death coordinates. These do not
establish full team visibility, spell accuracy or continuous health curves.
Natural day/night is unverified; no historical five-minute cycle is inferred.
Uncalibrated net-worth graph bins remain excluded from timed economy claims.

## Page behavior and compatibility

The page keeps scoreboard identity and parse honesty. It hides unusable charts,
shows death and key-purchase lists, collapses limitations into one section,
and offers at most three answerable followups. Replay moments keep evidence
links. Jump to latest sits above the composer, outside the scroll column, so it cannot cover review cards. The email fake door is absent from the match page.
OpenDota reviews retain their independently supported evidence and parsed state.

Old tests asserting fixed replay fix/next-game slots, gap-chip invitations and
match-page email signup were changed because those assertions described the
removed behavior. New coverage verifies moment citations, BKB windows, the
skeleton killer, bounded followups, no empty chart/legend, and artifact privacy.
Existing refusal, parse notice, ingest availability and Docker copy tests remain.
