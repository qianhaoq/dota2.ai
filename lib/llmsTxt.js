export const LLMS_TXT = `# dota2.ai
Dota 2 post-match replay coach grounded in Valve replay traces and OpenDota data. Never invent numbers; all displayed numbers come from verified match or replay evidence. Missing data (vision, voice, unparsed timelines) is disclosed.

Remote MCP (no install, Streamable HTTP): https://dota2.ai/mcp
One line per client:
- Claude Code: claude mcp add --transport http dota2ai https://dota2.ai/mcp
- Codex: codex mcp add dota2ai --url https://dota2.ai/mcp
- Gemini CLI: gemini mcp add --transport http dota2ai https://dota2.ai/mcp
- Any other MCP client: https://dota2.ai/mcp (POST with Accept: application/json, text/event-stream)

Tools on /mcp:
- replay_review({match_id, hero?, lang?, retry?, refresh?}) — full replay-backed review; never blocks: while status is parsing or reviewing, call again after poll_after_sec (typically 2-4 minutes total).
- recent_matches({account}) — a player's recent public matches (friend code or profile link).
- coach_report({match_id, hero?, section?, lang?}) — immediate match summary/report.
- coach_cases({match_id, hero, lang?}) — pro games on the same problem (parsed matches only).
- coach_ask({match_id, hero, question, lang?}) — follow-up question answered from the report.
- goal_check({match_id, hero, goal}) — evaluate a saved goal on a later match.
- hero_matchup({hero, vs, rank?}) — hero vs hero pro & ranked public matchup data (no match needed).

Pages:
- Review page: /r/{matchId}?hero={hero}&lang=en (also zh, ru)
- Player page: /p/{friendCode}

HTTP API:
- GET  /api/agent/{matchId} — replay trace & parse availability + hero roster.
- POST /api/agent/{matchId}/prepare — start parsing the Valve replay into a trace.
- GET  /api/agent/{matchId}/review?hero={hero}&lang={en|zh|ru} — poll deep review status/result.
- POST /api/agent/{matchId}/review — start a deep replay review ({hero, lang, plan?}).
- POST /api/agent/{matchId}/chat — ask the replay coach a follow-up ({hero, lang, question, history?}).
- GET  /api/agent/{matchId}/evidence?ref={ref}&hero={hero}&lang={en|zh} — fetch verified raw replay evidence.
- GET  /api/coach/{matchId} — match report & scoreboard.
- GET  /api/coach/players/{friendCode}/recent — player recent public games.
- GET  /api/coach/matchup?hero={hero}&vs={hero}[&rank=hg|ca|la|di] — hero matchup brief.

CLI (repository checkout after npm ci):
  node packages/cli/bin/dota2ai.js help
  node packages/cli/bin/dota2ai.js recent <friend code | profile link>
  node packages/cli/bin/dota2ai.js coach <matchId> --hero <hero> --section why
  node packages/cli/bin/dota2ai.js matchup <hero> <vs> [--rank di]
  node packages/cli/bin/dota2ai.js trace <tool> --trace <file>
Every command supports --lang en|zh and --json.

Rate limits apply per caller (IPv6 aggregated by /64). Respect Retry-After.
`;
