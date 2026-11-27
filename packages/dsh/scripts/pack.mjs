// Release archive: stage the bundled host + client plugin, release-specific patch snapshots
// (`data/constants/patches/`), skill and manifest (`@deepseek-ai/*` as peers the DSH host supplies),
// `npm pack` it into dist/ and write SHA256SUMS. One archive serves Linux, macOS and Windows: no native code.
//   node packages/dsh/scripts/pack.mjs [--out <dir>] [--version <semver>]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlugin } from './build.mjs';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const repo = resolve(pkgDir, '../..');
const VERSION_OVERRIDE_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function assertValidVersionOverride(versionOverride) {
  if (typeof versionOverride !== 'string' || !VERSION_OVERRIDE_RE.test(versionOverride)) {
    throw new Error(`Invalid --version value: ${String(versionOverride)} (expected semver like 0.2.4 or 0.3.0-rc.1)`);
  }
}

/**
 * @param {Record<string, any>} source
 * @param {string | null} [versionOverride]
 * @returns {Record<string, any>}
 */
export function releaseManifest(source, versionOverride = null) {
  if (versionOverride !== null && versionOverride !== undefined) {
    assertValidVersionOverride(versionOverride);
  }
  const { devDependencies: _dev, scripts: _scripts, private: _private, 'dota2ai:release': release, ...rest } = source;
  return {
    ...rest,
    ...(versionOverride !== null && versionOverride !== undefined ? { version: versionOverride } : {}),
    peerDependencies: release.peerDependencies,
  };
}

function parsePackArgs(argv) {
  let out = join(pkgDir, 'dist');
  let versionOverride = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error('Missing value for --out');
      out = next;
      i += 1;
    } else if (arg.startsWith('--out=')) {
      const val = arg.slice('--out='.length);
      if (!val) throw new Error('Missing value for --out');
      out = val;
    } else if (arg === '--version') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error('Missing value for --version');
      assertValidVersionOverride(next);
      versionOverride = next;
      i += 1;
    } else if (arg.startsWith('--version=')) {
      const val = arg.slice('--version='.length);
      assertValidVersionOverride(val);
      versionOverride = val;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { out: resolve(out), versionOverride };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { out, versionOverride } = parsePackArgs(process.argv.slice(2));
  const stage = mkdtempSync(join(tmpdir(), 'dsh-dota2ai-'));
  try {
    const source = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    const manifest = releaseManifest(source, versionOverride);
    await buildPlugin({ outdir: join(stage, 'lib') });
    // Per-release & hotfix Valve snapshots read lazily by `patchData.js` via `new URL('../data/constants/patches/…', import.meta.url)`.
    cpSync(join(repo, 'lib/data/constants/patches'), join(stage, 'data/constants/patches'), { recursive: true });
    for (const entry of ['skills', 'icon.svg', 'cordis.patch.yml', 'README.md']) {
      cpSync(join(pkgDir, entry), join(stage, entry), { recursive: true });
    }
    cpSync(join(repo, 'LICENSE'), join(stage, 'LICENSE'));
    writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    mkdirSync(out, { recursive: true });
    const file = execFileSync('npm', ['pack', '--silent', '--pack-destination', out], { cwd: stage, encoding: 'utf8' }).trim().split('\n').pop();
    const expectedFilename = `${manifest.name.replace(/^@/, '').replace('/', '-')}-${manifest.version}.tgz`;
    if (basename(file) !== expectedFilename) {
      throw new Error(`Expected tarball ${expectedFilename}, got ${basename(file)}`);
    }
    const tgz = join(out, expectedFilename);
    const sum = createHash('sha256').update(readFileSync(tgz)).digest('hex');
    const checksumLine = `${sum}  ${expectedFilename}\n`;
    writeFileSync(join(out, 'SHA256SUMS'), checksumLine);
    const writtenSums = readFileSync(join(out, 'SHA256SUMS'), 'utf8');
    if (writtenSums !== checksumLine) {
      throw new Error(`SHA256SUMS verification mismatch for ${expectedFilename}`);
    }
    console.log(tgz);
    console.log(`sha256 ${sum}`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
