// Release archive: stage the bundled plugin with a release package.json (DSH
// packages as peers the host supplies, no workspace dependencies), `npm pack` it into dist/ and
// write SHA256SUMS. One archive serves every platform: there is no native code.
//   node packages/dsh/scripts/pack.mjs [--out <dir>]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlugin } from './build.mjs';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const repo = resolve(pkgDir, '../..');
const outArg = process.argv.indexOf('--out');
const out = resolve(outArg > 0 ? process.argv[outArg + 1] : join(pkgDir, 'dist'));

export function releaseManifest(source) {
  const { devDependencies: _dev, scripts: _scripts, private: _private, 'dota2ai:release': release, ...rest } = source;
  return { ...rest, peerDependencies: release.peerDependencies };
}

const stage = mkdtempSync(join(tmpdir(), 'dsh-dota2ai-'));
try {
  const source = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  await buildPlugin({ outfile: join(stage, 'lib/index.js') });
  for (const entry of ['skills', 'icon.svg', 'cordis.patch.yml', 'README.md']) cpSync(join(pkgDir, entry), join(stage, entry), { recursive: true });
  cpSync(join(repo, 'LICENSE'), join(stage, 'LICENSE'));
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(releaseManifest(source), null, 2)}\n`);
  mkdirSync(out, { recursive: true });
  const file = execFileSync('npm', ['pack', '--silent', '--pack-destination', out], { cwd: stage, encoding: 'utf8' }).trim().split('\n').pop();
  const tgz = join(out, basename(file));
  const sum = createHash('sha256').update(readFileSync(tgz)).digest('hex');
  writeFileSync(join(out, 'SHA256SUMS'), `${sum}  ${basename(tgz)}\n`);
  console.log(tgz);
  console.log(`sha256 ${sum}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
