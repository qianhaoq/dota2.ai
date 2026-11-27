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

/**
 * Incremented when `packages/review-engine/src/trace/build.js` or `buildTraceFromExtract` gains fields that stored
 * traces built earlier lack (#365: `creep_kills`, `roshan_kills`, `tormentor_kills`, `roshan_damage`, `buybacks`;
 * 3, #405: `smokes`, `runes`).
 */
export const TRACE_BUILD_VERSION = 3;

/**
 * Whether a stored trace was built before the current trace builder's fields existed (#365).
 * Older traces lack `creep_kills`, `roshan_kills`, `tormentor_kills` or `buybacks` (or carry an older `build` number).
 */
export function traceIsOutdated(trace) {
  if (!trace || typeof trace !== 'object') return false;
  if (Number.isInteger(trace.build) && trace.build >= TRACE_BUILD_VERSION) return false;
  if (Number.isInteger(trace.build) && trace.build < TRACE_BUILD_VERSION) return true;
  return !Array.isArray(trace.creep_kills)
    || !Array.isArray(trace.roshan_kills)
    || !Array.isArray(trace.tormentor_kills)
    || !Array.isArray(trace.buybacks)
    || !Array.isArray(trace.smokes)
    || !Array.isArray(trace.runes)
    || (Array.isArray(trace.item_uses) && trace.item_uses.length > 0 && trace.item_uses[0].length < 5);
}

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
  const trace = builder.finish(meta);
  trace.build = TRACE_BUILD_VERSION;
  return trace;
}
