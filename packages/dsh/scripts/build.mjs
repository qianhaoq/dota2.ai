// Bundle @qianhaoq/dsh-dota2ai into lib/:
//   - lib/index.js               Node 24 ESM host plugin (local agent service, tools, skill, Typert Remote)
//   - lib/typert.host.js         Host Typert reflection artifact
//   - lib/typert.remote-client.js Client Typert Remote Info artifact
//   - lib/client.js              Browser CJS factory for DSH's `window.__ModuleLoader__.load`
import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = resolve(root, '../..');
const goals = join(repoRoot, 'lib/coach/goals.js');

/** dota2ai/agent loads the goal judge from a vendored copy when packed, else from the checkout. */
const vendoredGoals = {
  name: 'vendored-goals',
  setup(b) {
    b.onResolve({ filter: /^\.\/vendor\/goals\.js$/ }, () => ({ path: goals }));
  },
};

/**
 * Rewrite `createRequire(import.meta.url)('...json')` and `const require = createRequire(import.meta.url); require('...json')`
 * inside `lib/` into static ESM JSON imports so esbuild deduplicates every snapshot JSON directly into the host bundle,
 * independent of the bundled output directory's relative depth.
 */
const inlineLibJsonRequires = {
  name: 'inline-lib-json-requires',
  setup(b) {
    const libDir = join(repoRoot, 'lib') + '/';
    b.onLoad({ filter: /\.js$/ }, (args) => {
      if (!args.path.startsWith(libDir)) return undefined;
      let contents = readFileSync(args.path, 'utf8');
      if (!contents.includes('.json')) return undefined;
      const imports = [];
      let idx = 0;
      const replaceReq = (_match, relPath) => {
        const abs = resolve(dirname(args.path), relPath);
        const ident = `__dshJson_${idx += 1}`;
        imports.push(`import ${ident} from ${JSON.stringify(abs)};`);
        return ident;
      };
      contents = contents.replace(/createRequire\(import\.meta\.url\)\(\s*['"]([^'"]+\.json)['"]\s*\)/g, replaceReq);
      if (/const\s+require\s*=\s*createRequire\(import\.meta\.url\)/.test(contents)) {
        contents = contents.replace(/\brequire\(\s*['"]([^'"]+\.json)['"]\s*\)/g, replaceReq);
      }
      if (!imports.length) return undefined;
      return {
        contents: `${imports.join('\n')}\n${contents}`,
        loader: 'js',
        resolveDir: dirname(args.path),
      };
    });
  },
};

/** Ensure workspace imports resolve to this checkout even when node_modules is symlinked to another worktree. */
const workspaceAliases = {
  '@dota2ai/review-engine': join(repoRoot, 'packages/review-engine/src/index.js'),
  'dota2ai/client': join(repoRoot, 'packages/cli/src/client.js'),
  'dota2ai/coach': join(repoRoot, 'packages/cli/src/coachApi.js'),
  'dota2ai/agent': join(repoRoot, 'packages/cli/src/agent.js'),
  'dota2ai/render': join(repoRoot, 'packages/cli/src/coach.js'),
  'dota2ai/handlers': join(repoRoot, 'packages/cli/src/handlers.js'),
  'dota2ai/tools': join(repoRoot, 'packages/cli/src/toolDocs.js'),
};

export async function buildPlugin({ outdir = join(root, 'lib'), outfile } = {}) {
  const targetDir = outfile ? dirname(outfile) : outdir;
  const hostOut = outfile ?? join(targetDir, 'index.js');
  mkdirSync(targetDir, { recursive: true });

  // 1. Host entry (`lib/index.js`)
  await build({
    entryPoints: [join(root, 'src/index.js')],
    outfile: hostOut,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['@deepseek-ai/*'],
    alias: workspaceAliases,
    plugins: [vendoredGoals, inlineLibJsonRequires],
    legalComments: 'linked',
    logLevel: 'warning',
  });

  // 2. Host & Remote Typert descriptors (`lib/typert.host.js`, `lib/typert.remote-client.js`)
  await build({
    entryPoints: {
      'typert.host': join(root, 'src/typert.js'),
      'typert.remote-client': join(root, 'src/typert.js'),
    },
    outdir: targetDir,
    bundle: true,
    platform: 'neutral',
    format: 'esm',
    target: 'es2022',
    external: ['@deepseek-ai/*'],
    logLevel: 'warning',
  });

  // 3. Browser / Electron Web UI bundle (`lib/client.js`)
  await build({
    entryPoints: [join(root, 'src/client/index.tsx')],
    outfile: join(targetDir, 'client.js'),
    bundle: true,
    platform: 'browser',
    format: 'cjs',
    target: 'es2022',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/dsh-client-store'],
    alias: workspaceAliases,
    loader: { '.css': 'text' },
    define: {
      'import.meta.env.DEV': 'false',
      'import.meta.env.VITE_ALLOW_FF_OVERRIDE': '"0"',
      'import.meta.env.VITE_LANG_DETECT_BROWSER': '"0"',
      'import.meta.env': '{}',
    },
    banner: {
      js: 'window.__ModuleLoader__.load({ id: "@qianhaoq/dsh-dota2ai", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
    },
    footer: {
      js: 'return module.exports; } });',
    },
    legalComments: 'none',
    logOverride: { 'ignored-bare-import': 'silent' },
    logLevel: 'warning',
  });

  return hostOut;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(await buildPlugin());
}
