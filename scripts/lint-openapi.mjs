import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { openapi } from '../routes/v1/openapi.js';

/** Dependency-free structure and reference lint, including external schema refs. */
export async function lintOpenapi(doc = openapi) {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  assert(/^3\.1\.\d+$/.test(doc.openapi), 'Expected OpenAPI 3.1');
  assert(doc.info?.title && doc.info?.version && doc.paths, 'Missing API metadata');
  for (const [path, item] of Object.entries(doc.paths)) {
    assert(path.startsWith('/'), `Invalid path ${path}`);
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'options', 'head']) {
      const op = item[method];
      if (!op) continue;
      assert(op.responses && Object.keys(op.responses).length, `Missing responses: ${path}`);
      for (const response of Object.values(op.responses)) assert(response.description || response.$ref, `Missing response description: ${path}`);
      for (const name of path.matchAll(/\{([^}]+)\}/g)) assert([...(item.parameters ?? []), ...(op.parameters ?? [])].some(p => p.name === name[1] && p.in === 'path' && p.required), `Missing path parameter ${name[1]}`);
    }
  }
  const schemaUrl = new URL('../packages/review-engine/src/schema/review.v1.json', import.meta.url);
  const seen = new Set();
  async function walk(node, root, base) {
    if (!node || typeof node !== 'object') return;
    if (node.$ref) {
      const reference = new URL(node.$ref, base);
      const key = reference.href;
      if (!seen.has(key)) {
        seen.add(key);
        const [file, fragment = ''] = key.split('#');
        const target = file === base.split('#')[0] ? root : JSON.parse(await readFile(new URL(file), 'utf8'));
        let resolved = target;
        for (const part of fragment.split('/').slice(1)) resolved = resolved?.[decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~')];
        assert(resolved !== undefined, `Unresolved reference ${key}`);
        await walk(resolved, target, file);
      }
    }
    for (const value of Object.values(node)) if (value && typeof value === 'object') await walk(value, root, base);
  }
  // The public schema URL maps to the engine's schema file at runtime.
  const local = structuredClone(doc);
  const rewrite = node => {
    if (!node || typeof node !== 'object') return;
    if (node.$ref === './schema/review.v1.json') node.$ref = schemaUrl.href;
    Object.values(node).forEach(rewrite);
  };
  rewrite(local);
  await walk(local, local, new URL('../openapi.json', import.meta.url).href);
  return true;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await lintOpenapi();
  console.log('OpenAPI 3.1 structure and all references: OK');
}
