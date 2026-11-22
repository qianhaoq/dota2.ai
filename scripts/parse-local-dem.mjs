#!/usr/bin/env node
/**
 * Parse a replay file you hold and make the match fully reviewable.
 *
 * For games whose replay Valve no longer serves (older than about two weeks,
 * or hidden): the Dota 2 client can still have the file, under
 * `…/dota 2 beta/game/dota/replays/<match_id>.dem`.
 *
 *   node scripts/parse-local-dem.mjs <match_id> <file> [--source auto|gc|opendota|<match.json>]
 *                                    [--out <file.json>] [--store] [--parser <url>]
 *
 * It asks the parser (odota/parser, default http://127.0.0.1:5600) to parse
 * the file, checks the parse really is that match, merges it with the
 * match's scoreboard, and writes the parsed match:
 *   --out    to a JSON file (default ./match<id>.parsed.json)
 *   --store  also to the site's match cache (MATCH_CACHE_BUCKET), where the
 *            site reads it. Needs Google credentials: runs as is on GCE /
 *            Cloud Run; elsewhere set GOOGLE_OAUTH_ACCESS_TOKEN
 *            (`gcloud auth print-access-token`).
 *
 * Scoreboard source (--source): `gc` uses the Steam GC retriever
 * (STEAM_RETRIEVER_URL + STEAM_RETRIEVER_SECRET, one request of its daily
 * budget); `opendota` the public API; a path reads a saved match JSON;
 * `auto` (default) is gc when configured, else opendota.
 *
 * Exit status: 0 written · 2 usage · 3 refused (wrong replay, unreadable
 * file, already parsed, no scoreboard) · 4 parser or store failure.
 * Prints no account ids and no secrets.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { heroInfo } from '../lib/coach/analyze.js';
import { isMatchParsed } from '../lib/matchReview/matchParse.js';
import { createGcsBucket } from '../lib/matchReview/replayIngest/gcs.js';
import { createMatchStore } from '../lib/matchStore.js';
import { parseLocalReplay } from '../lib/upstream/localReplay.js';
import { createOdotaParserClient, mergeGcAndParsed, replayMatchesScoreboard } from '../lib/upstream/odotaParser.js';
import { createSteamGcClient, mapGcMatch } from '../lib/upstream/steamGc.js';

const USAGE = 'Usage: node scripts/parse-local-dem.mjs <match_id> <file> [--source auto|gc|opendota|<match.json>] [--out <file.json>] [--store] [--parser <url>]';
const REFUSALS = new Set(['wrong_replay', 'replay_unreadable', 'already_parsed', 'no_scoreboard', 'file_not_found', 'file_too_large', 'decompressor_missing', 'parse_unusable']);

export function parseArgs(argv) {
  const o = { source: 'auto', out: null, store: false, parser: null };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--store') o.store = true;
    else if (a === '--source' || a === '--out' || a === '--parser') {
      const v = argv[i += 1];
      if (!v || v.startsWith('--')) return null;
      o[a.slice(2)] = v;
    } else if (a.startsWith('--')) return null;
    else rest.push(a);
  }
  if (rest.length !== 2 || !/^[1-9]\d{0,14}$/.test(rest[0])) return null;
  return { ...o, matchId: Number(rest[0]), path: rest[1] };
}

/** The scoreboard loader for --source. */
export function scoreboardLoader(source, env = process.env, fetchImpl = (...a) => fetch(...a)) {
  const gcConfigured = Boolean(env.STEAM_RETRIEVER_URL && env.STEAM_RETRIEVER_SECRET);
  const pick = source === 'auto' ? (gcConfigured ? 'gc' : 'opendota') : source;
  if (pick === 'gc') {
    if (!gcConfigured) throw Object.assign(new Error('--source gc needs STEAM_RETRIEVER_URL and STEAM_RETRIEVER_SECRET'), { code: 'usage' });
    const client = createSteamGcClient({ baseUrl: env.STEAM_RETRIEVER_URL, secret: env.STEAM_RETRIEVER_SECRET });
    return { name: 'Steam GC', load: (id) => client.fetchMatch(id) };
  }
  if (pick === 'opendota') {
    return {
      name: 'OpenDota',
      async load(id) {
        const key = env.OPENDOTA_API_KEY ? `?api_key=${encodeURIComponent(env.OPENDOTA_API_KEY)}` : '';
        const res = await fetchImpl(`https://api.opendota.com/api/matches/${id}${key}`, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw Object.assign(new Error(`OpenDota HTTP ${res.status}`), { status: res.status });
        return res.json();
      },
    };
  }
  return {
    name: 'file',
    async load() {
      const body = JSON.parse(await readFile(pick, 'utf8'));
      // The retriever's own answer ({ match: CMsgDOTAMatch }) or a match in OpenDota's shape.
      return body?.match && !body.match_id ? mapGcMatch(body.match) : body;
    },
  };
}

/** Put the match in the cache bucket. 'written', or 'exists' when a parsed copy is already there. */
export async function storeMatch(matchId, match, bucket, { waitMs = 60_000, log = (m) => console.error(`  store: ${m}`) } = {}) {
  const matchStore = createMatchStore({ bucket, isParsed: isMatchParsed, log });
  matchStore.putMatch(matchId, match);
  for (let waited = 0; waited <= waitMs; waited += 50) {
    const s = matchStore.snapshot();
    if (s.writes) return 'written';
    if (s.writeSkips) return 'exists';
    if (s.writeErrors) throw new Error('the store refused the write');
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`the store did not answer in ${Math.round(waitMs / 1000)} s`);
}

function cacheBucket(env) {
  const name = (env.MATCH_CACHE_BUCKET || '').trim();
  if (!name) throw new Error('--store needs MATCH_CACHE_BUCKET');
  const token = env.GOOGLE_OAUTH_ACCESS_TOKEN;
  return createGcsBucket(name, token ? { tokenProvider: async () => token } : {});
}

export async function main(argv = process.argv.slice(2), env = process.env, print = console.log) {
  const args = parseArgs(argv);
  if (!args) { console.error(USAGE); return 2; }
  let scoreboard;
  let bucket = null;
  // Settle what can fail on configuration before spending a parse.
  try { scoreboard = scoreboardLoader(args.source, env); if (args.store) bucket = cacheBucket(env); } catch (err) { console.error(err.message); return 2; }
  const parser = createOdotaParserClient({ baseUrl: args.parser || env.ODOTA_PARSER_URL || 'http://127.0.0.1:5600', timeoutMs: 600_000 });
  print(`match ${args.matchId}: scoreboard from ${scoreboard.name}, parsing ${args.path} …`);
  let result;
  try {
    result = await parseLocalReplay({
      matchId: args.matchId, path: resolve(args.path),
      loadScoreboard: scoreboard.load, parser,
      merge: mergeGcAndParsed, check: replayMatchesScoreboard, isParsed: isMatchParsed,
      heroNpcName: (id) => { const slug = heroInfo(id).slug; return slug ? `npc_dota_hero_${slug}` : null; },
    });
  } catch (err) {
    const refused = REFUSALS.has(err.code);
    console.error(`${refused ? 'refused' : 'failed'}: ${err.message}`);
    if (err.check) {
      const c = err.check;
      console.error(`  length: replay ${c.minutes.parsed ?? '?'} min, match ${c.minutes.scoreboard ?? '?'} min · kills agree for ${c.kills.matching}/10 players · last hits for ${c.lastHits.matching}/10`);
    }
    return refused ? 3 : 4;
  }
  const { match, check, file } = result;
  print(`  file: ${file.format}, ${(file.demBytes / 1048576).toFixed(1)} MB replay, sha256 ${file.demSha256.slice(0, 16)}…`);
  print(`  it is this match: length ${check.minutes.parsed} min, kills agree for ${check.kills.matching}/10 players, last hits for ${check.lastHits.matching}/10`);
  const out = resolve(args.out || `match${args.matchId}.parsed.json`);
  await writeFile(out, JSON.stringify(match));
  print(`  written: ${out}`);
  if (args.store) {
    try {
      const how = await storeMatch(args.matchId, match, bucket);
      print(how === 'written'
        ? `  stored in the match cache: the site shows the parsed review within a minute (/r/${args.matchId})`
        : '  the match cache already has a parsed copy of this match: left as it is');
    } catch (err) { console.error(`store failed: ${err.message}`); return 4; }
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  process.exit(await main());
}
