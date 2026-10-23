// npm does not bundle workspace symlinks. Stage the workspace as a real directory
// so npm's normal bundled-dependency traversal includes the engine and AJV.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
const destination = new URL('../node_modules/@dota2ai/review-engine/', import.meta.url);
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
for (const entry of ['package.json', 'src', 'data']) {
  cpSync(new URL(`../../review-engine/${entry}`, import.meta.url), new URL(entry, destination), { recursive: true });
}
// Include runtime transitive dependencies, so the tarball also installs offline.
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const copied = new Set();
function stage(name) {
  if (copied.has(name)) return;
  copied.add(name);
  const source = dirname(require.resolve(`${name}/package.json`));
  const target = new URL(`node_modules/${name}/`, destination);
  mkdirSync(target, { recursive: true });
  cpSync(source, fileURLToPath(target), { recursive: true });
  const manifest = JSON.parse(readFileSync(`${source}/package.json`, 'utf8'));
  Object.keys(manifest.dependencies ?? {}).forEach(stage);
}
stage('ajv');
