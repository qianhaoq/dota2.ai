/**
 * Typert Remote & Host reflection descriptors for `@qianhaoq/dsh-dota2ai`.
 * Built over `@deepseek-ai/dsh-typert-protocol/remote-info` and `zod` so both
 * `dsh web` (WebSocket) and DSH Desktop (Electron IPC) share one typed channel.
 */
import { z } from 'zod';

/**
 * Pure lazy RemoteInfo builder matching `@deepseek-ai/dsh-typert-protocol/remote-info`
 * (zero runtime imports so both host and browser bundles compile without external shims).
 */
function createTypertRemoteInfo(spec, zod) {
  let cached;
  const optionalParam = (p) => p.source === 'json' && p.acceptsUndefined === true;
  const makeInput = (parameters, strict) => {
    let schema;
    let proj;
    const codec = (p) => (strict ? p.strictCodec : p.codec);
    return {
      create: () => (schema ??= zod.strictObject(Object.fromEntries(parameters.map((p) => {
        const val = codec(p).create();
        return [p.wire, optionalParam(p) ? val.optional() : val.nonoptional()];
      })))),
      get jsonSchema() { return (proj ??= project()).jsonSchema; },
      get jsonSchemaError() { return (proj ??= project()).jsonSchemaError; },
    };
    function project() {
      const missing = parameters.find((p) => codec(p).jsonSchema === undefined);
      if (missing) return { jsonSchemaError: codec(missing).jsonSchemaError ?? `No JSON Schema for ${missing.wire}` };
      return {
        jsonSchema: {
          type: 'object',
          properties: Object.fromEntries(parameters.map((p) => [
            p.wire,
            { ...codec(p).jsonSchema, ...(p.description === undefined ? {} : { description: p.description }) },
          ])),
          required: parameters.filter((p) => !optionalParam(p)).map((p) => p.wire),
          additionalProperties: false,
        },
      };
    }
  };
  const resolve = () => {
    if (cached) return cached;
    const descriptors = [];
    const methods = Object.create(null);
    for (const [endpoint, def] of Object.entries(spec.methods)) {
      const sep = endpoint.indexOf('/');
      const namespace = endpoint.slice(0, sep);
      const method = endpoint.slice(sep + 1);
      const parameters = def.parameters.map((p) => ({ ...p, wire: p.wire ?? p.name }));
      const descriptor = {
        ...def,
        id: `${spec.package}#${endpoint}`,
        namespace,
        method,
        parameters,
        result: def.result,
      };
      if (def.invocation.kind === 'direct') {
        const inputs = [];
        methods[endpoint] = Object.assign(descriptor, {
          input(opts) {
            const idx = opts?.strict === true ? 1 : 0;
            return (inputs[idx] ??= makeInput(parameters, idx === 1));
          },
          invoke(remote, input, signal) {
            const args = parameters.map((p) => input[p.wire]);
            if (def.cancellation !== undefined) args.push(signal);
            const receiver = Reflect.get(remote, namespace);
            const fn = Reflect.get(receiver, method);
            return fn.apply(receiver, args);
          },
        });
      }
      descriptors.push(descriptor);
    }
    return (cached = { descriptors, methods });
  };
  return {
    get package() { return spec.package; },
    get descriptors() { return resolve().descriptors; },
    get methods() { return resolve().methods; },
  };
}

const PACKAGE = '@qianhaoq/dsh-dota2ai';

let reqSchemaVal;
const reqSchema = () => (reqSchemaVal ??= z.object({
  method: z.string().optional(),
  url: z.string(),
  body: z.union([z.string(), z.null()]).optional(),
}));

let reqStrictSchemaVal;
const reqStrictSchema = () => (reqStrictSchemaVal ??= z.strictObject({
  method: z.string().optional(),
  url: z.string(),
  body: z.union([z.string(), z.null()]).optional(),
}));

const reqJsonSchema = {
  type: 'object',
  properties: {
    method: { type: 'string' },
    url: { type: 'string' },
    body: { oneOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: ['url'],
  additionalProperties: false,
};

let resSchemaVal;
const resSchema = () => (resSchemaVal ??= z.object({
  status: z.number(),
  body: z.unknown(),
  retryAfterSec: z.number().optional(),
}));

let frameSchemaVal;
const frameSchema = () => (frameSchemaVal ??= z.record(z.string(), z.unknown()));

let profileSchemaVal;
const profileSchema = () => (profileSchemaVal ??= z.object({
  accountId: z.union([z.string(), z.null()]),
  reviewed: z.array(z.string()),
  seenUntil: z.union([z.number(), z.null()]),
  goal: z.union([z.record(z.string(), z.unknown()), z.null()]),
  goalChecks: z.array(z.record(z.string(), z.unknown())),
}));

let profilePatchSchemaVal;
const profilePatchSchema = () => (profilePatchSchemaVal ??= z.object({
  accountId: z.union([z.string(), z.null()]).optional(),
  reviewed: z.array(z.string()).optional(),
  seenUntil: z.union([z.number(), z.null()]).optional(),
  goal: z.union([z.record(z.string(), z.unknown()), z.null()]).optional(),
  goalChecks: z.array(z.record(z.string(), z.unknown())).optional(),
}));

let profilePatchStrictSchemaVal;
const profilePatchStrictSchema = () => (profilePatchStrictSchemaVal ??= z.strictObject({
  accountId: z.union([z.string(), z.null()]).optional(),
  reviewed: z.array(z.string()).optional(),
  seenUntil: z.union([z.number(), z.null()]).optional(),
  goal: z.union([z.record(z.string(), z.unknown()), z.null()]).optional(),
  goalChecks: z.array(z.record(z.string(), z.unknown())).optional(),
}));

const profileJsonSchema = {
  type: 'object',
  properties: {
    accountId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    reviewed: { type: 'array', items: { type: 'string' } },
    seenUntil: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    goal: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
    goalChecks: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
  required: [],
  additionalProperties: false,
};

export const TYPERT_REMOTE = createTypertRemoteInfo({
  package: PACKAGE,
  methods: {
    'dota2ai/request': {
      service: 'dota2ai',
      description: 'Execute a local or proxied dota2.ai JSON API request.',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'req',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: `${PACKAGE}#dota2ai/request:req`,
            create: reqSchema,
            jsonSchema: { ...reqJsonSchema, additionalProperties: true },
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: `${PACKAGE}#dota2ai/request:req`,
            create: reqStrictSchema,
            jsonSchema: reqJsonSchema,
          },
        },
      ],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: `${PACKAGE}#dota2ai/request:result`,
        create: resSchema,
        jsonSchema: {
          type: 'object',
          properties: {
            status: { type: 'number' },
            body: {},
            retryAfterSec: { type: 'number' },
          },
          required: ['status'],
          additionalProperties: true,
        },
      },
    },
    'dota2ai/stream': {
      service: 'dota2ai',
      description: 'Stream frames of a dota2.ai chat or follow-up question powered by DSH host LLM.',
      mode: 'stream',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'req',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: `${PACKAGE}#dota2ai/stream:req`,
            create: reqSchema,
            jsonSchema: { ...reqJsonSchema, additionalProperties: true },
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: `${PACKAGE}#dota2ai/stream:req`,
            create: reqStrictSchema,
            jsonSchema: reqJsonSchema,
          },
        },
      ],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: `${PACKAGE}#dota2ai/stream:result`,
        create: frameSchema,
        jsonSchema: { type: 'object', additionalProperties: true },
      },
    },
    'dota2ai/getProfile': {
      service: 'dota2ai',
      description: 'Read durable user account, reviewed history, and active training goal.',
      invocation: { kind: 'direct' },
      parameters: [],
      result: {
        mode: 'strict',
        typeSymbol: `${PACKAGE}#dota2ai/getProfile:result`,
        create: profileSchema,
        jsonSchema: {
          ...profileJsonSchema,
          required: ['accountId', 'reviewed', 'seenUntil', 'goal', 'goalChecks'],
          additionalProperties: true,
        },
      },
    },
    'dota2ai/saveProfile': {
      service: 'dota2ai',
      description: 'Persist updates to user account, reviewed history, or active training goal.',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'patch',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: `${PACKAGE}#dota2ai/saveProfile:patch`,
            create: profilePatchSchema,
            jsonSchema: { ...profileJsonSchema, additionalProperties: true },
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: `${PACKAGE}#dota2ai/saveProfile:patch`,
            create: profilePatchStrictSchema,
            jsonSchema: profileJsonSchema,
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: `${PACKAGE}#dota2ai/saveProfile:result`,
        create: profileSchema,
        jsonSchema: {
          ...profileJsonSchema,
          required: ['accountId', 'reviewed', 'seenUntil', 'goal', 'goalChecks'],
          additionalProperties: true,
        },
      },
    },
  },
}, z);

export const TYPERT = {
  package: PACKAGE,
  face: 'host',
  schemas: [],
  get invocations() {
    return TYPERT_REMOTE.descriptors;
  },
  model: {
    services: [
      {
        key: 'dota2ai',
        exportName: 'Dota2AiRemote',
        summary: 'dota2.ai standalone review workbench and local agent service.',
        description: 'dota2.ai standalone review workbench and local agent service.',
        tags: [],
        jsDoc: '/** dota2.ai standalone review workbench and local agent service. */',
        members: [],
      },
    ],
    events: [],
    objects: [],
  },
};

export default TYPERT_REMOTE;
