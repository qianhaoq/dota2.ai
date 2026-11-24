/**
 * The patch advisor for the fixture preview server (scripts/mock-review-server.mjs):
 * the real router, tools and verifier over the committed patch snapshots, with
 * a scripted "model", so nothing leaves the machine and every run gives the
 * same answer.
 *
 * The scripted answer quotes the tools it called — the hero whose win rate
 * rose most and that hero's own notes — read from the same snapshots, so a
 * data refresh never leaves the script quoting last week's numbers and the
 * verifier marking the answer.
 */
import { createPatchRouter } from '../lib/patch/router.js';
import { runPatchTool } from '../lib/patch/tools.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (name, args, id) => ({ id, name, args });
const pct = (v) => `${(v * 100).toFixed(1)}%`;

/** What the scripted model answers, in the reader's language: every number is in the two lookups it made. */
export function mockPatchAnswer(lang) {
  const o = runPatchTool('patch_overview', {}, { lang });
  const top = o.win_rate_rose_most[0];
  const h = runPatchTool('hero_patch', { hero: top.hero }, { lang });
  const line = h.notes[0]?.lines[0] ?? '';
  const w = o.numbers;
  return lang === 'zh'
    ? `补丁后胜率涨得最多的是${top.name}：路人局胜率从 ${pct(top.win_rate_before)} 到 ${pct(top.win_rate_after)}（补丁前 ${w.before_the_patch.from} 至 ${w.before_the_patch.to}，补丁后 ${w.since_the_patch.from} 至 ${w.since_the_patch.to}）。\n\n官方日志里它的第一条改动是：「${line}」。数字只有几天，还会变；涨了不等于是这条改动造成的。`
    : `${top.name} rose most: its public win rate went from ${pct(top.win_rate_before)} to ${pct(top.win_rate_after)} (before: ${w.before_the_patch.from} to ${w.before_the_patch.to}; since: ${w.since_the_patch.from} to ${w.since_the_patch.to}).\n\nThe first line of its notes: "${line}". These are a few days of a new patch and will move; a rise after the patch is not proof this line caused it.`;
}

/** A "model" that looks at the overview and the top riser, then answers. */
async function complete({ system, messages }) {
  await sleep(300);
  const lang = system.includes('简体中文') ? 'zh' : 'en';
  if (messages.at(-1).role === 'tool') return { text: mockPatchAnswer(lang) };
  const top = runPatchTool('patch_overview', {}, { lang }).win_rate_rose_most[0];
  return { toolCalls: [call('patch_overview', {}, 'a'), call('hero_patch', { hero: top.hero }, 'b')] };
}

export function createMockPatch({ resolveClientIp }) {
  return { router: createPatchRouter({ complete, resolveClientIp }) };
}
