// Bundle the plugin into lib/index.js (Node 24 ESM). The workspace code it uses
// (dota2ai/*, the review engine pieces, lib/coach/goals.js) and the MCP client
// are not on npm, so they go into the bundle; the DSH packages stay external:
// the host profile provides them (see "dota2ai:release" in package.json).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const goals = fileURLToPath(new URL('../../../lib/coach/goals.js', import.meta.url));

/** dota2ai/agent loads the goal judge from a vendored copy when packed, else from the checkout. */
const vendoredGoals = {
  name: 'vendored-goals',
  setup(b) {
    b.onResolve({ filter: /^\.\/vendor\/goals\.js$/ }, () => ({ path: goals }));
  },
};

export async function buildPlugin({ outfile = fileURLToPath(new URL('lib/index.js', root)) } = {}) {
  await build({
    entryPoints: [fileURLToPath(new URL('src/index.js', root))],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['@deepseek-ai/*'],
    plugins: [vendoredGoals],
    // CommonJS dependencies of the MCP client call require() inside an ESM bundle.
    banner: { js: "import { createRequire as __dota2aiRequire } from 'node:module'; const require = __dota2aiRequire(import.meta.url);" },
    legalComments: 'linked',
    logLevel: 'warning',
  });
  return outfile;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(await buildPlugin());
}
