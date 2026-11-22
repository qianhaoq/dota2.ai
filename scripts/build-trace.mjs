#!/usr/bin/env node
/**
 * Build a compact match trace from a replay extract.
 *
 *   node scripts/build-trace.mjs <extractDir> <out.json.gz> [--match <id>]
 *
 * <extractDir> is the extractor's output directory (it holds trace/events.jsonl
 * and trace/states.jsonl; see docs/REPLAY_INGEST.md for running the extractor).
 * Both files are streamed, so memory stays small whatever their size. The
 * result is a gzipped `dota2.ai/match-trace@1` the trace tools read:
 *
 *   dota2ai trace match_overview --trace <out.json.gz>
 *
 * No network. Exit status: 0 written · 2 usage · 4 unreadable extract.
 */
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { gzipSync } from 'node:zlib';
import { createTraceBuilder } from '../packages/review-engine/src/trace/build.js';

const USAGE = 'Usage: node scripts/build-trace.mjs <extractDir> <out.json.gz> [--match <id>]';

async function eachRow(path, fn) {
  const input = createReadStream(path);
  const lines = createInterface({ input, crlfDelay: Infinity });
  let index = 0;
  try {
    for await (const line of lines) { if (line) fn(JSON.parse(line), index); index += 1; }
  } finally { lines.close(); input.destroy(); }
  return index;
}

/** Stream an extract directory into a trace object. */
export async function buildTraceFromExtract(extractDir, meta = {}) {
  const builder = createTraceBuilder();
  const dir = join(extractDir, 'trace');
  await eachRow(join(dir, 'states.jsonl'), (row) => builder.addState(row));
  await eachRow(join(dir, 'events.jsonl'), (row, index) => builder.addEvent(row, index));
  return builder.finish(meta);
}

async function main(argv) {
  const rest = []; let matchId = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--match') { matchId = Number(argv[i += 1]); if (!Number.isSafeInteger(matchId) || matchId <= 0) return usage(); } else if (argv[i].startsWith('--')) return usage(); else rest.push(argv[i]);
  }
  if (rest.length !== 2) return usage();
  let trace;
  try { trace = await buildTraceFromExtract(rest[0], { match_id: matchId }); } catch (error) {
    console.error(`Could not read the extract: ${error?.code ?? error?.message ?? 'unknown error'}`);
    return 4;
  }
  const body = gzipSync(JSON.stringify(trace));
  await writeFile(rest[1], body);
  console.log(JSON.stringify({ ok: true, match_id: trace.match_id, heroes: trace.heroes.length, seconds: trace.n, casts: trace.casts.length, deaths: trace.deaths.length, damage_rows: trace.damage.length, bytes: body.length }));
  return 0;
}
function usage() { console.error(USAGE); return 2; }

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main(process.argv.slice(2));
