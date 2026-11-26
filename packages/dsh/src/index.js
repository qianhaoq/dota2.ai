import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createCoachHandlers } from 'dota2ai/handlers';
import { toolOptions } from './tools.js';
import { createReplayClient } from './replay.js';
import { headersFor, skillRegistration } from './skill.js';

/**
 * dota2.ai for DSH (DeepSeek Harness): a Cordis plugin that registers the
 * dota2.ai coach tools on `ctx.tools` and, when the host has a skill registry,
 * a skill that says how to use them. Every tool calls the public dota2.ai API
 * as the user; nothing runs a model here and no key is needed.
 */
export const name = 'dota2ai';
export const inject = ['tools'];

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('Register the dota2.ai tools'),
  lang: Schema.union(['en', 'zh']).default('en').description('Answer language when a call names none'),
  apiBase: Schema.string().default('https://dota2.ai').description('dota2.ai origin'),
  skillEnabled: Schema.boolean().default(true).description('Register the dota2ai skill'),
});

export function apply(ctx, config = {}) {
  if (config.enabled === false) return;
  const apiBase = config.apiBase || 'https://dota2.ai';
  const headers = headersFor(process.env);
  const fetchImpl = (url, init = {}) => globalThis.fetch(url, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const coach = createCoachHandlers({ env: { ...process.env, DOTA2AI_API_BASE: apiBase }, fetchImpl });
  const replay = createReplayClient({ apiBase, headers });
  for (const options of toolOptions({ coach, replay, lang: config.lang })) {
    const tool = defineTool(options);
    ctx.effect(() => ctx.tools.register(tool));
  }
  if (config.skillEnabled !== false) {
    const skill = skillRegistration();
    ctx.inject(['skills'], (scope) => {
      scope.effect(() => scope.skills.register(skill));
    });
  }
}
