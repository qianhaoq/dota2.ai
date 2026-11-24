/**
 * Extract directory → match trace. Streams trace/states.jsonl and
 * trace/events.jsonl through the pure builder, so memory stays small
 * whatever their size; trace/metadata.jsonl (the net worth graph) is read
 * when the extractor wrote it.
 */
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createTraceBuilder } from '../../packages/review-engine/src/trace/build.js';

async function eachRow(path, fn, signal) {
  const input = createReadStream(path, { signal });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let index = 0;
  try {
    for await (const line of lines) { if (line) fn(JSON.parse(line), index); index += 1; }
  } finally { lines.close(); input.destroy(); }
  return index;
}

/** @param {string} extractDir  the extractor's output directory @param {{ match_id?: number | null, extractor?: object | null }} [meta] @param {AbortSignal} [signal] */
export async function buildTraceFromExtract(extractDir, meta = {}, signal) {
  const builder = createTraceBuilder();
  const dir = join(extractDir, 'trace');
  await eachRow(join(dir, 'states.jsonl'), (row) => builder.addState(row), signal);
  await eachRow(join(dir, 'events.jsonl'), (row, index) => builder.addEvent(row, index), signal);
  if (existsSync(join(dir, 'metadata.jsonl'))) await eachRow(join(dir, 'metadata.jsonl'), (row) => builder.addMetadata(row), signal);
  // Ward placements and removals (the extractor's own ward entity log): an extract without it leaves the trace without wards.
  if (existsSync(join(dir, 'wards-native.jsonl'))) await eachRow(join(dir, 'wards-native.jsonl'), (row) => builder.addWard(row), signal);
  return builder.finish(meta);
}
