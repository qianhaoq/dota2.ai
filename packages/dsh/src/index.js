import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { BlockAssembler, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { toolOptions } from './tools.js';
import { headersFor, skillRegistration } from './skill.js';
import { createDshService } from './service.js';

const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';

/**
 * dota2.ai for DSH (DeepSeek Harness):
 *   1. Standalone full-featured UI panel (`sidebar.panellist` + `main` slot) replicating
 *      dota2.ai's home, player, and replay review pages (`src/coach`, `src/agent`);
 *   2. Local review & chat agent (`lib/agent`) powered by DSH's own configured models
 *      (`ctx.llm` / `agentDefaultModel`), caching ~250 KB replay traces under `$DSH_HOME/dota2ai`;
 *   3. Seven `dota2ai_*` conversation tools + `dota2ai` skill + chat tool cards sharing
 *      the same local service and `$DSH_HOME/dota2ai` storage.
 */
export const name = 'dota2ai';
export const inject = ['tools'];

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('Enable the dota2.ai plugin'),
  lang: Schema.union(['en', 'zh']).default('en').description('Default answer language when a tool call names none'),
  apiBase: Schema.string().default('https://dota2.ai').description('dota2.ai origin for match data and parsed replay traces'),
  skillEnabled: Schema.boolean().default(true).description('Register the dota2ai skill'),
  homeDir: Schema.string().default('').description('Custom local data directory (defaults to $DSH_HOME/dota2ai)'),
  extractorBin: Schema.string().default('').description('Optional path to a local dota-extract binary for offline replay parsing'),
});

export class Dota2AiRemote extends TypertRemoteService {
  constructor(ctx, service) {
    super(ctx, 'dota2ai', { namespace: 'dota2ai' });
    this._service = service;
  }

  request(req, signal) {
    return this._service.handleRequest(req, signal);
  }

  stream(req, signal) {
    return this._service.handleStream(req, signal);
  }

  getProfile() {
    return this._service.getProfile();
  }

  saveProfile(patch) {
    return this._service.saveProfile(patch);
  }
}

Object.defineProperty(Dota2AiRemote.prototype, REMOTE_METHOD_DESCRIPTOR, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([
      Object.freeze({ method: 'request', invocation: Object.freeze({ kind: 'direct' }) }),
      Object.freeze({ method: 'stream', mode: 'stream', invocation: Object.freeze({ kind: 'direct' }) }),
      Object.freeze({ method: 'getProfile', invocation: Object.freeze({ kind: 'direct' }) }),
      Object.freeze({ method: 'saveProfile', invocation: Object.freeze({ kind: 'direct' }) }),
    ]),
  }),
});

export function apply(ctx, config = {}) {
  if (config.enabled === false) return;
  const apiBase = config.apiBase || 'https://dota2.ai';
  const headers = headersFor(process.env);
  const fetchImpl = (url, init = {}) => globalThis.fetch(url, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });

  const logger = typeof ctx.logger === 'function' ? ctx.logger('dota2ai') : ctx.logger;
  const dshService = createDshService({
    ctx,
    config: { ...config, apiBase },
    env: process.env,
    fetchImpl,
    llmPrimitives: { BlockAssembler, createUserMessage, createAssistantMessage, createToolResultMessage },
    log: (msg) => logger?.info?.(msg),
  });

  ctx.effect(() => () => dshService.shutdown());

  // Refresh available host models on activation and whenever provider topology updates.
  void dshService.models.refresh();
  ctx.on?.('llm/adapters-updated', () => {
    void dshService.models.refresh();
  });

  // Mount Typert Remote when running in a GUI/Gateway profile (`dsh web` or Desktop).
  // Manifest registration (`./typert`) is owned by DSH's `typert-loader` in GUI profiles;
  // in headless CLI profiles without `typert`, this block stays dormant while tools/skill activate.
  ctx.inject(['typert'], (scope) => {
    scope.plugin(Dota2AiRemote, dshService);
  });

  for (const options of toolOptions({ coach: dshService.coach, replay: dshService.replay, lang: config.lang })) {
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
