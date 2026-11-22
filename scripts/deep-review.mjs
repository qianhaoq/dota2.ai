#!/usr/bin/env node
/**
 * Run the deep-review agent on a match trace and print the verified review.
 *
 *   node scripts/deep-review.mjs <trace.json.gz> --hero <hero> [--lang en|zh]
 *                                [--provider deepseek|glm] [--match <match.json>]
 *                                [--out <file.json>] [--steps]
 *
 * <trace.json.gz> comes from scripts/build-trace.mjs. --match adds the
 * scoreboard and the gold curve (an OpenDota-shaped match JSON; player names
 * and account ids are never sent to the model). --steps prints each tool
 * call to stderr as it happens.
 *
 * Model (--provider, default deepseek): DeepSeek through DEEPSEEK_API_KEY
 * (DEEPSEEK_MODEL, default deepseek-flash) or GLM through GLM_API_KEY
 * (GLM_MODEL, default glm-5.3-flash). Thinking is on; DEEP_REVIEW_THINKING=disabled
 * turns it off. Keys are read from the environment only.
 * Exit status: 0 review written · 2 usage · 3 no API key or unreadable input ·
 * 4 the model produced no verifiable review.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import OpenAI from 'openai';
import { DEEP_REVIEW_PROVIDERS, deepReviewProvider } from '../lib/agent/providers.js';
import { openAiCompatible } from '../lib/agent/loop.js';
import { runDeepReview } from '../lib/agent/deepReview.js';

const USAGE = 'Usage: node scripts/deep-review.mjs <trace.json.gz> --hero <hero> [--lang en|zh] [--provider deepseek|glm] [--match <match.json>] [--out <file.json>] [--steps]';

export function parseArgs(argv) {
  const o = { hero: null, lang: 'en', provider: 'deepseek', match: null, out: null, steps: false }; const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--steps') o.steps = true;
    else if (['--hero', '--lang', '--provider', '--match', '--out'].includes(a)) { const v = argv[i += 1]; if (!v || v.startsWith('--')) return null; o[a.slice(2)] = v; } else if (a.startsWith('--')) return null;
    else rest.push(a);
  }
  if (rest.length !== 1 || !o.hero || !['en', 'zh'].includes(o.lang) || !DEEP_REVIEW_PROVIDERS.includes(o.provider)) return null;
  return { ...o, trace: rest[0] };
}

const readJson = async (path) => { const b = await readFile(path); return JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : b).toString('utf8')); };

async function main(argv) {
  const o = parseArgs(argv);
  if (!o) { console.error(USAGE); return 2; }
  const cfg = deepReviewProvider(o.provider, process.env);
  if (!cfg.ok) { console.error(`${cfg.needs ?? 'Provider'} is not set.`); return 3; }
  let trace; let match = null;
  try { trace = await readJson(o.trace); if (o.match) match = await readJson(o.match); } catch { console.error('Could not read the trace or match file.'); return 3; }
  const client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
  const started = Date.now();
  const result = await runDeepReview({
    complete: openAiCompatible({ client, model: cfg.model, extraBody: cfg.extraBody }),
    trace, match, hero: o.hero, lang: o.lang,
    onEvent: o.steps ? (e) => { if (e.type === 'tool_start') console.error(`· ${e.name} ${JSON.stringify(e.args)}`); } : undefined,
  });
  const body = JSON.stringify({ ...result, provider: cfg.provider, model: cfg.model, thinking: cfg.thinking, seconds: Math.round((Date.now() - started) / 1000) }, null, 2);
  if (o.out) await writeFile(o.out, `${body}\n`); else console.log(body);
  return result.status === 'ok' ? 0 : result.status === 'unknown_hero' ? 2 : 4;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main(process.argv.slice(2));
