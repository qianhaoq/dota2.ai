#!/usr/bin/env node
// Release metadata & notes generator for `@qianhaoq/dsh-dota2ai` (zero external dependencies).
//
// Usage:
//   node .github/scripts/dsh-release-meta.mjs version [--tag <ref>] [--pkg packages/dsh/package.json] [--allow-registry-fallback] [--out-github-output <file>]
//   node .github/scripts/dsh-release-meta.mjs notes --version <v> [--prev-tag <t>] [--out <file>]
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG_PREFIX = 'dsh-v';
const DEFAULT_PACKAGE_NAME = '@qianhaoq/dsh-dota2ai';
const MAX_COMMITS = 30;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/**
 * Parse a SemVer 2.0.0 version string (without build metadata).
 * Returns `null` if invalid.
 * @param {unknown} v
 */
export function parseSemver(v) {
  if (typeof v !== 'string') return null;
  const match = SEMVER_RE.exec(v);
  if (!match) return null;
  const prerelease = match[4] ? match[4].split('.') : [];
  for (const id of prerelease) {
    if (/^0\d+$/.test(id)) return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
    raw: v,
  };
}

function coerceSemver(v) {
  if (
    v
    && typeof v === 'object'
    && Number.isInteger(v.major)
    && Number.isInteger(v.minor)
    && Number.isInteger(v.patch)
    && Array.isArray(v.prerelease)
  ) {
    return v;
  }
  const parsed = parseSemver(v);
  if (!parsed) {
    throw new Error(`Invalid semver: ${String(v)}`);
  }
  return parsed;
}

/**
 * Compare two SemVer versions (`-1`, `0`, `1`). Throws if either is invalid.
 * @param {string | { major: number, minor: number, patch: number, prerelease: string[] }} a
 * @param {string | { major: number, minor: number, patch: number, prerelease: string[] }} b
 */
export function compareSemver(a, b) {
  const pa = coerceSemver(a);
  const pb = coerceSemver(b);
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  const aPre = pa.prerelease;
  const bPre = pb.prerelease;
  if (aPre.length === 0 && bPre.length === 0) return 0;
  if (aPre.length === 0) return 1;
  if (bPre.length === 0) return -1;
  const len = Math.min(aPre.length, bPre.length);
  for (let i = 0; i < len; i += 1) {
    const ai = aPre[i];
    const bi = bPre[i];
    if (ai === bi) continue;
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) return Number(ai) < Number(bi) ? -1 : 1;
    if (aNum !== bNum) return aNum ? -1 : 1;
    return ai < bi ? -1 : 1;
  }
  if (aPre.length !== bPre.length) return aPre.length < bPre.length ? -1 : 1;
  return 0;
}

/**
 * Increment the patch segment and return a stable `major.minor.(patch+1)` string.
 * @param {string | { major: number, minor: number, patch: number, prerelease: string[] }} v
 */
export function bumpPatch(v) {
  const parsed = coerceSemver(v);
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

function stripTagPrefix(raw) {
  if (typeof raw !== 'string') return '';
  return raw.startsWith(TAG_PREFIX) ? raw.slice(TAG_PREFIX.length) : raw;
}

/**
 * Resolve the next release version and tag from `package.json`, existing `dsh-v*` git tags,
 * npm registry versions, and an optional forced tag (from a `push` tag event).
 * @param {{
 *   pkgVersion: string,
 *   tagVersions?: string[],
 *   npmVersions?: string[],
 *   forcedTag?: string | null,
 * }} opts
 */
export function resolveNextVersion({ pkgVersion, tagVersions = [], npmVersions = [], forcedTag = null }) {
  if (!parseSemver(pkgVersion)) {
    throw new Error(`Invalid package.json version: ${String(pkgVersion)}`);
  }

  const validNpm = [...new Set((Array.isArray(npmVersions) ? npmVersions : []).filter((v) => parseSemver(v) !== null))];
  const npmSet = new Set(validNpm);

  const tagMap = new Map();
  for (const raw of Array.isArray(tagVersions) ? tagVersions : []) {
    const ver = stripTagPrefix(raw);
    if (parseSemver(ver)) {
      tagMap.set(ver, `${TAG_PREFIX}${ver}`);
    }
  }
  const sortedTagVers = [...tagMap.keys()].sort(compareSemver);

  const normalizedForcedTag = typeof forcedTag === 'string' ? forcedTag.trim() : '';
  if (normalizedForcedTag) {
    const expectedTag = `${TAG_PREFIX}${pkgVersion}`;
    if (normalizedForcedTag !== expectedTag) {
      throw new Error(`Tag ${normalizedForcedTag} does not match package.json version (${expectedTag})`);
    }
    const olderTags = sortedTagVers.filter((ver) => compareSemver(ver, pkgVersion) < 0);
    const prevTag = olderTags.length > 0 ? tagMap.get(olderTags[olderTags.length - 1]) : null;
    return {
      version: pkgVersion,
      tag: normalizedForcedTag,
      alreadyPublished: npmSet.has(pkgVersion),
      prevTag,
    };
  }

  const allPublished = [...new Set([...sortedTagVers, ...validNpm])].sort(compareSemver);
  const highestPublished = allPublished.length > 0 ? allPublished[allPublished.length - 1] : null;
  const usedVersions = new Set(allPublished);
  const prevTag = sortedTagVers.length > 0 ? tagMap.get(sortedTagVers[sortedTagVers.length - 1]) : null;

  let version;
  if (!highestPublished || compareSemver(pkgVersion, highestPublished) > 0) {
    version = pkgVersion;
  } else {
    version = bumpPatch(highestPublished);
    while (usedVersions.has(version)) {
      version = bumpPatch(version);
    }
  }

  return {
    version,
    tag: `${TAG_PREFIX}${version}`,
    alreadyPublished: npmSet.has(version),
    prevTag,
  };
}

/**
 * Determine whether `HEAD` is stale relative to the latest existing `dsh-v*` tag.
 * Prevents workflow reruns of older commits, already-released commits, or diverged
 * checkouts from allocating a newer version and overwriting newer releases.
 * @param {{
 *   headSha?: string | null,
 *   prevTag?: string | null,
 *   prevTagSha?: string | null,
 *   headIsAncestorOfPrevTag?: boolean | null,
 *   prevTagIsAncestorOfHead?: boolean | null,
 * }} [opts]
 * @returns {{ stale: boolean, reason: string | null }}
 */
export function checkReleaseFreshness({
  headSha = null,
  prevTag = null,
  prevTagSha = null,
  headIsAncestorOfPrevTag = null,
  prevTagIsAncestorOfHead = null,
} = {}) {
  const cleanPrevTag = typeof prevTag === 'string' && prevTag.trim() ? prevTag.trim() : null;
  if (!cleanPrevTag) {
    return { stale: false, reason: null };
  }
  if (headSha && prevTagSha && headSha === prevTagSha) {
    return { stale: true, reason: 'already_released_at_head' };
  }
  if (headIsAncestorOfPrevTag === true) {
    return { stale: true, reason: 'older_than_latest_tag' };
  }
  if (prevTagIsAncestorOfHead === false) {
    return { stale: true, reason: 'not_descendant_of_latest_tag' };
  }
  return { stale: false, reason: null };
}

/**
 * Generate concise bilingual (English + 简体中文) GitHub Release notes, or return `existingNotes`
 * unchanged when hand-written release notes already exist for the version.
 * @param {{
 *   version: string,
 *   prevTag?: string | null,
 *   commits?: string[],
 *   existingNotes?: string | null,
 * }} opts
 */
export function generateReleaseNotes({ version, prevTag = null, commits = [], existingNotes = null }) {
  if (typeof existingNotes === 'string' && existingNotes.trim().length > 0) {
    return existingNotes;
  }
  if (!parseSemver(version)) {
    throw new Error(`Invalid release version: ${String(version)}`);
  }

  const cleanPrev = typeof prevTag === 'string' && prevTag.trim() ? prevTag.trim() : null;
  const cleanCommits = (Array.isArray(commits) ? commits : [])
    .map((line) => (typeof line === 'string' ? line.trim() : ''))
    .filter(Boolean);
  const shown = cleanCommits.slice(0, MAX_COMMITS);
  const omitted = cleanCommits.length - shown.length;

  const changeHeading = cleanPrev
    ? `### Changes since \`${cleanPrev}\` / 自 \`${cleanPrev}\` 以来的变更`
    : '### Changes / 变更';

  const commitLines = shown.length > 0
    ? shown.map((subject) => `- ${subject}`)
    : ['- Maintenance release / 维护更新'];
  if (omitted > 0) {
    commitLines.push(`- …and ${omitted} more commits / 其余 ${omitted} 条提交`);
  }

  const tag = `${TAG_PREFIX}${version}`;
  return [
    `**dota2.ai for DSH v${version}** — automated release of \`@qianhaoq/dsh-dota2ai\` from \`main\`.`,
    '',
    `**dota2.ai DSH 插件 v${version}** — \`@qianhaoq/dsh-dota2ai\` 从 \`main\` 分支自动构建并发布。`,
    '',
    changeHeading,
    '',
    ...commitLines,
    '',
    '### Update & Install / 更新与安装',
    '',
    '**DeepSeek Harness Desktop / 桌面客户端**',
    '- Update / 更新: paste into chat / 粘贴到聊天框: `Update my @qianhaoq/dsh-dota2ai plugin to the latest version and reload if needed.` / `帮我把 @qianhaoq/dsh-dota2ai 插件更新到最新版本，如需刷新或重启请提示我。`',
    '- Fresh install / 首次安装: paste into chat / 粘贴到聊天框: `Install the dota2.ai Dota 2 replay coach plugin @qianhaoq/dsh-dota2ai into my active desktop profile, then tell me how to open dota2.ai in the left sidebar.` / `帮我安装 dota2.ai 的 Dota 2 复盘插件 @qianhaoq/dsh-dota2ai 到当前桌面端 profile，装好后告诉我怎么在左侧栏打开 dota2.ai。`',
    '',
    '**CLI (`dsh web`) / 命令行** (Node ≥ 24.9, DSH 0.2.x ≥ 0.2.1-rc.3):',
    '',
    '```sh',
    '# Update existing installation / 更新已安装版本',
    'dsh plugin --profile web update @qianhaoq/dsh-dota2ai',
    '',
    '# Fresh install / 首次安装',
    'dsh plugin --profile web add @qianhaoq/dsh-dota2ai',
    '```',
    '',
    `To verify the release archive directly, download \`qianhaoq-dsh-dota2ai-${version}.tgz\` and \`SHA256SUMS\` from release \`${tag}\` and run \`sha256sum -c SHA256SUMS\`.`,
    '',
  ].join('\n');
}

/**
 * Query the npm registry for published versions of the package.
 * - HTTP 404 is treated as unpublished (`versions: []`).
 * - Network/server errors fail closed unless `allowFallback` is true.
 * @param {{
 *   packageName?: string,
 *   registryUrl?: string,
 *   allowFallback?: boolean,
 *   fetchImpl?: (url: string, init?: RequestInit) => Promise<{ status: number, ok: boolean, json?: () => Promise<any> }>,
 *   warn?: (msg: string) => void,
 * }} [opts]
 */
export async function fetchNpmVersions({
  packageName = DEFAULT_PACKAGE_NAME,
  registryUrl = 'https://registry.npmjs.org',
  allowFallback = false,
  fetchImpl = globalThis.fetch,
  warn = (msg) => console.error(msg),
} = {}) {
  const encoded = packageName.startsWith('@')
    ? `@${packageName.slice(1).replace('/', '%2f')}`
    : encodeURIComponent(packageName);
  const url = `${registryUrl.replace(/\/+$/, '')}/${encoded}`;
  try {
    const res = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) {
      return { versions: [], latest: null, registryFallback: false };
    }
    if (!res.ok) {
      throw new Error(`npm registry returned HTTP ${res.status} for ${url}`);
    }
    const data = await res.json();
    const latest = typeof data?.['dist-tags']?.latest === 'string' ? data['dist-tags'].latest : null;
    const versions = Object.keys(data?.versions ?? {});
    if (latest && !versions.includes(latest)) {
      versions.push(latest);
    }
    return { versions, latest, registryFallback: false };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!allowFallback) {
      throw new Error(`Failed to query npm registry for ${packageName}: ${detail}`);
    }
    warn(`[dsh-release-meta] Warning: npm registry query failed (${detail}); falling back to git tags only.`);
    return { versions: [], latest: null, registryFallback: true };
  }
}

/**
 * @param {{
 *   version?: string,
 *   tag?: string,
 *   alreadyPublished?: boolean,
 *   prevTag?: string | null,
 *   stale?: boolean,
 *   staleReason?: string | null,
 * }} meta
 */
export function formatGithubOutput(meta) {
  const entries = [
    ['version', String(meta.version ?? '')],
    ['tag', String(meta.tag ?? '')],
    ['already_published', String(Boolean(meta.alreadyPublished))],
    ['prev_tag', String(meta.prevTag ?? '')],
    ['stale', String(Boolean(meta.stale))],
    ['stale_reason', String(meta.staleReason ?? '')],
  ];
  for (const [k, v] of entries) {
    if (/[\r\n]/.test(v)) {
      throw new Error(`Refusing to write multiline GitHub output for ${k}`);
    }
  }
  return `${entries.map(([k, v]) => `${k}=${v}`).join('\n')}\n`;
}

function listLocalDshTags(cwd = process.cwd()) {
  const out = execFileSync('git', ['tag', '-l', `${TAG_PREFIX}*`], { cwd, encoding: 'utf8' });
  return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function gitIsAncestor(ancestorRef, descendantRef, cwd = process.cwd()) {
  const res = spawnSync('git', ['merge-base', '--is-ancestor', ancestorRef, descendantRef], {
    cwd,
    encoding: 'utf8',
  });
  if (res.error) throw res.error;
  if (res.status === 0) return true;
  if (res.status === 1) return false;
  throw new Error(`git merge-base --is-ancestor ${ancestorRef} ${descendantRef} failed (${res.status}): ${(res.stderr || '').trim()}`);
}

function resolveGitFreshness(prevTag, cwd = process.cwd()) {
  if (!prevTag) {
    return { stale: false, reason: null };
  }
  const headSha = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  const prevTagSha = execFileSync('git', ['rev-parse', '--verify', `${prevTag}^{commit}`], { cwd, encoding: 'utf8' }).trim();
  const headIsAncestorOfPrevTag = gitIsAncestor(headSha, prevTagSha, cwd);
  const prevTagIsAncestorOfHead = gitIsAncestor(prevTagSha, headSha, cwd);
  return checkReleaseFreshness({
    headSha,
    prevTag,
    prevTagSha,
    headIsAncestorOfPrevTag,
    prevTagIsAncestorOfHead,
  });
}

function readGitCommits(prevTag, cwd = process.cwd()) {
  const cleanPrev = typeof prevTag === 'string' ? prevTag.trim() : '';
  let args = ['log', '-n', '10', '--pretty=format:%s'];
  if (cleanPrev) {
    let tagExists = false;
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${cleanPrev}`], { cwd, stdio: 'ignore' });
      tagExists = true;
    } catch {
      tagExists = false;
    }
    if (tagExists) {
      args = ['log', `${cleanPrev}..HEAD`, '--pretty=format:%s'];
    }
  }
  const out = execFileSync('git', args, { cwd, encoding: 'utf8' });
  return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function parseFlags(argv, valueFlags, boolFlags = new Set()) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (boolFlags.has(key)) {
      if (eq >= 0) throw new Error(`Flag --${key} does not take a value`);
      parsed[key] = true;
    } else if (valueFlags.has(key)) {
      let val;
      if (eq >= 0) {
        val = arg.slice(eq + 1);
      } else {
        if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`Missing value for --${key}`);
        val = argv[i + 1];
        i += 1;
      }
      parsed[key] = val;
    } else {
      throw new Error(`Unknown flag: --${key}`);
    }
  }
  return parsed;
}

async function runCli(argv) {
  const [subcommand, ...rest] = argv;
  if (subcommand === 'version') {
    const flags = parseFlags(
      rest,
      new Set(['tag', 'pkg', 'out-github-output']),
      new Set(['allow-registry-fallback']),
    );
    const pkgPath = resolve(flags.pkg ?? 'packages/dsh/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const packageName = typeof pkg.name === 'string' && pkg.name ? pkg.name : DEFAULT_PACKAGE_NAME;
    const tagVersions = listLocalDshTags();
    const npmInfo = await fetchNpmVersions({
      packageName,
      allowFallback: Boolean(flags['allow-registry-fallback']),
    });
    const meta = resolveNextVersion({
      pkgVersion: pkg.version,
      tagVersions,
      npmVersions: npmInfo.versions,
      forcedTag: flags.tag ?? null,
    });
    const isForcedTag = Boolean(typeof flags.tag === 'string' && flags.tag.trim());
    const freshness = isForcedTag ? { stale: false, reason: null } : resolveGitFreshness(meta.prevTag);
    const result = {
      ...meta,
      stale: freshness.stale,
      staleReason: freshness.reason,
      npmLatest: npmInfo.latest,
      registryFallback: npmInfo.registryFallback,
    };
    if (flags['out-github-output']) {
      appendFileSync(resolve(flags['out-github-output']), formatGithubOutput(result), 'utf8');
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (subcommand === 'notes') {
    const flags = parseFlags(rest, new Set(['version', 'prev-tag', 'out', 'notes-dir']));
    const version = flags.version;
    if (!version) {
      throw new Error('Missing required flag: --version <semver>');
    }
    if (!parseSemver(version)) {
      throw new Error(`Invalid --version value: ${version}`);
    }
    const notesDir = resolve(flags['notes-dir'] ?? '.github/release-notes');
    const handWrittenPath = join(notesDir, `${TAG_PREFIX}${version}.md`);
    let existingNotes = null;
    if (existsSync(handWrittenPath)) {
      const content = readFileSync(handWrittenPath, 'utf8');
      if (content.trim().length > 0) {
        existingNotes = content;
      }
    }
    const commits = existingNotes ? [] : readGitCommits(flags['prev-tag'] ?? null);
    const notes = generateReleaseNotes({
      version,
      prevTag: flags['prev-tag'] ?? null,
      commits,
      existingNotes,
    });
    if (flags.out) {
      const outPath = resolve(flags.out);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, notes, 'utf8');
    } else {
      process.stdout.write(notes);
    }
    return;
  }

  throw new Error(`Unknown subcommand "${subcommand ?? ''}". Expected "version" or "notes".`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
