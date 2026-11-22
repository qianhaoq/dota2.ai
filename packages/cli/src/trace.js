/**
 * dota2ai trace — ask a parsed replay questions, offline.
 *
 *   dota2ai trace                                   list the tools and their arguments
 *   dota2ai trace <tool> --trace <file> [--<argument> <value>]…
 *
 * <file> is a match trace (`dota2.ai/match-trace@1`, .json or .json.gz) built
 * from a replay by scripts/build-trace.mjs. Output is always JSON: the same
 * object the coach agent and the MCP tools get.
 * Exit codes: 0 ok · 2 invalid input · 3 trace file not found or unreadable.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { TRACE_TOOLS, runTraceTool } from '@dota2ai/review-engine';

const invalid = (message) => Object.assign(new Error(message), { exit: 2 });

export function readTraceFile(path, read = readFileSync) {
  let body;
  try { body = read(path); } catch { throw Object.assign(new Error(`Cannot read the trace file: ${path}`), { exit: 3 }); }
  try {
    const trace = JSON.parse((body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body).toString('utf8'));
    if (trace?.schema !== 'dota2.ai/match-trace@1') throw new Error('schema');
    return trace;
  } catch { throw Object.assign(new Error('Not a match trace (expected dota2.ai/match-trace@1; build one with scripts/build-trace.mjs)'), { exit: 3 }); }
}

/** `--name value` pairs for one tool, typed by its input schema. */
export function parseTraceArgs(tool, argv) {
  const props = tool.input_schema.properties ?? {};
  const out = {}; let file = null;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag.startsWith('--')) throw invalid(`Unexpected argument: ${flag}`);
    const name = flag.slice(2).replace(/-/g, '_');
    const value = argv[i += 1];
    if (value == null || /^--[a-z]/.test(value)) throw invalid(`Missing value: ${flag}`);
    if (name === 'trace') { file = value; continue; }
    const spec = props[name];
    if (!spec) throw invalid(`Unknown option for ${tool.name}: ${flag} (takes ${Object.keys(props).map((k) => `--${k}`).join(', ') || 'no arguments'})`);
    const types = [].concat(spec.type);
    if (types.includes('integer') || (types.includes('number') && !types.includes('string'))) {
      const n = Number(value);
      if (!Number.isFinite(n) || (types.includes('integer') && !Number.isInteger(n))) throw invalid(`${flag} must be a number`);
      out[name] = n;
    } else out[name] = value;
  }
  for (const req of tool.input_schema.required ?? []) if (out[req] == null) throw invalid(`${tool.name} needs --${req}`);
  if (!file) throw invalid('--trace <file> is required');
  return { file, args: out };
}

export function runTrace(args, { stdout, stderr, read } = {}) {
  try {
    if (!args[1]) {
      stdout.write(`${JSON.stringify({ tools: TRACE_TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema })) })}\n`);
      return 0;
    }
    const tool = TRACE_TOOLS.find((t) => t.name === args[1]);
    if (!tool) throw invalid(`Unknown tool: ${args[1]} (one of ${TRACE_TOOLS.map((t) => t.name).join(', ')})`);
    const { file, args: toolArgs } = parseTraceArgs(tool, args.slice(2));
    const result = runTraceTool(readTraceFile(file, read), tool.name, toolArgs);
    stdout.write(`${JSON.stringify(result)}\n`);
    return result.error ? 2 : 0;
  } catch (e) {
    stderr.write(`${e.exit ? e.message : 'Trace command failed'}\n`);
    return e.exit ?? 4;
  }
}
