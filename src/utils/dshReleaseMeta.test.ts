import { describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DSH_BUNDLED_PATH_PATTERNS,
  bumpPatch,
  checkReleaseFreshness,
  compareSemver,
  fetchNpmVersions,
  formatGithubOutput,
  generateReleaseNotes,
  hasBundledChanges,
  matchesBundledPath,
  parseSemver,
  probeNpmVersionPublished,
  readChangedFilesSinceTag,
  resolveNextVersion,
  resolveReleasePlan,
} from '../../.github/scripts/dsh-release-meta.mjs';
import { releaseManifest } from '../../packages/dsh/scripts/pack.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dshPkg = JSON.parse(readFileSync(new URL('../../packages/dsh/package.json', import.meta.url), 'utf8'));

describe('dsh-release-meta semver helpers', () => {
  it('parses valid stable and prerelease semver strings and rejects invalid inputs', () => {
    expect(parseSemver('0.2.3')).toEqual({
      major: 0,
      minor: 2,
      patch: 3,
      prerelease: [],
      raw: '0.2.3',
    });
    expect(parseSemver('1.10.2-rc.5')).toEqual({
      major: 1,
      minor: 10,
      patch: 2,
      prerelease: ['rc', '5'],
      raw: '1.10.2-rc.5',
    });

    for (const invalid of [null, undefined, '', 'v0.2.3', 'dsh-v0.2.3', '0.2', '0.2.3.4', '01.2.3', '0.2.3-', '0.2.3-01', '0.2.3-a..b', 'not-semver']) {
      expect(parseSemver(invalid), String(invalid)).toBeNull();
    }
  });

  it('compares semver versions accurately including numeric segments and prereleases', () => {
    expect(compareSemver('0.2.3', '0.2.3')).toBe(0);
    expect(compareSemver('0.2.10', '0.2.2')).toBe(1);
    expect(compareSemver('0.2.9', '0.10.0')).toBe(-1);
    expect(compareSemver('1.0.0', '0.99.99')).toBe(1);
    expect(compareSemver('0.2.3', '0.2.3-rc.5')).toBe(1);
    expect(compareSemver('0.2.3-rc.2', '0.2.3-rc.10')).toBe(-1);
    expect(compareSemver('0.2.3-1', '0.2.3-alpha')).toBe(-1);
    expect(compareSemver('0.2.3-alpha', '0.2.3-alpha.1')).toBe(-1);
    expect(() => compareSemver('bad', '0.2.3')).toThrow(/Invalid semver/);
  });

  it('bumps patch cleanly and rejects invalid versions', () => {
    expect(bumpPatch('0.2.3')).toBe('0.2.4');
    expect(bumpPatch('0.2.9')).toBe('0.2.10');
    expect(bumpPatch('0.2.3-rc.1')).toBe('0.2.4');
    expect(() => bumpPatch('v0.2.3')).toThrow(/Invalid semver/);
  });
});

describe('resolveNextVersion', () => {
  it('uses package.json version on a manual minor/major bump ahead of published tags and npm', () => {
    expect(resolveNextVersion({
      pkgVersion: '0.3.0',
      tagVersions: ['dsh-v0.1.0', 'dsh-v0.2.3'],
      npmVersions: ['0.2.0', '0.2.3'],
      forcedTag: null,
    })).toEqual({
      version: '0.3.0',
      tag: 'dsh-v0.3.0',
      alreadyPublished: false,
      prevTag: 'dsh-v0.2.3',
    });
  });

  it('uses package.json version when no tags or npm versions exist yet', () => {
    expect(resolveNextVersion({
      pkgVersion: '0.1.0',
      tagVersions: [],
      npmVersions: [],
      forcedTag: null,
    })).toEqual({
      version: '0.1.0',
      tag: 'dsh-v0.1.0',
      alreadyPublished: false,
      prevTag: null,
    });
  });

  it('auto-bumps patch above highest npm version when npm is ahead of git tags', () => {
    expect(resolveNextVersion({
      pkgVersion: '0.2.3',
      tagVersions: ['dsh-v0.2.2', 'dsh-v0.2.3'],
      npmVersions: ['0.2.3', '0.2.4', '0.2.5'],
      forcedTag: null,
    })).toEqual({
      version: '0.2.6',
      tag: 'dsh-v0.2.6',
      alreadyPublished: false,
      prevTag: 'dsh-v0.2.3',
    });
  });

  it('auto-bumps patch above highest git tag when git tags are ahead of npm', () => {
    expect(resolveNextVersion({
      pkgVersion: '0.2.3',
      tagVersions: ['dsh-v0.2.3', 'dsh-v0.2.4', 'dsh-v0.2.10'],
      npmVersions: ['0.2.3', '0.2.4'],
      forcedTag: null,
    })).toEqual({
      version: '0.2.11',
      tag: 'dsh-v0.2.11',
      alreadyPublished: false,
      prevTag: 'dsh-v0.2.10',
    });
  });

  it('skips colliding versions and ignores non-semver entries', () => {
    expect(resolveNextVersion({
      pkgVersion: '0.2.3',
      tagVersions: ['dsh-v0.2.3', 'dsh-v0.2.4', 'dsh-vnot-a-semver', 'other-tag'],
      npmVersions: ['0.2.3', '0.2.5-rc.1', '0.2.5', '0.0.0-stage', 'invalid'],
      forcedTag: '',
    })).toEqual({
      version: '0.2.6',
      tag: 'dsh-v0.2.6',
      alreadyPublished: false,
      prevTag: 'dsh-v0.2.4',
    });
  });

  it('validates forcedTag in tag mode, reports alreadyPublished, and finds previous tag', () => {
    expect(resolveNextVersion({
      pkgVersion: '0.3.0',
      tagVersions: ['dsh-v0.2.2', 'dsh-v0.2.3', 'dsh-v0.3.0'],
      npmVersions: ['0.2.3'],
      forcedTag: 'dsh-v0.3.0',
    })).toEqual({
      version: '0.3.0',
      tag: 'dsh-v0.3.0',
      alreadyPublished: false,
      prevTag: 'dsh-v0.2.3',
    });

    expect(resolveNextVersion({
      pkgVersion: '0.2.3',
      tagVersions: ['dsh-v0.2.2', 'dsh-v0.2.3'],
      npmVersions: ['0.2.2', '0.2.3'],
      forcedTag: 'dsh-v0.2.3',
    })).toEqual({
      version: '0.2.3',
      tag: 'dsh-v0.2.3',
      alreadyPublished: true,
      prevTag: 'dsh-v0.2.2',
    });
  });

  it('throws when forcedTag does not match package.json version', () => {
    expect(() => resolveNextVersion({
      pkgVersion: '0.2.3',
      tagVersions: ['dsh-v0.2.3'],
      npmVersions: ['0.2.3'],
      forcedTag: 'dsh-v0.2.4',
    })).toThrow(/does not match package\.json version/);
  });
});

describe('generateReleaseNotes', () => {
  it('returns existing manual release notes unchanged', () => {
    const manual = '**Custom notes**\n\nHand-written release notes for v0.3.0.\n';
    expect(generateReleaseNotes({
      version: '0.3.0',
      prevTag: 'dsh-v0.2.3',
      commits: ['feat: ignored when manual notes exist'],
      existingNotes: manual,
    })).toBe(manual);
  });

  it('generates concise bilingual notes capped at 30 commits with Desktop and CLI install/update instructions', () => {
    const commits = Array.from({ length: 35 }, (_, i) => `feat: change #${i + 1}`);
    const notes = generateReleaseNotes({
      version: '0.2.4',
      prevTag: 'dsh-v0.2.3',
      commits,
      existingNotes: '   ',
    });

    expect(notes).toContain('dota2.ai for DSH v0.2.4');
    expect(notes).toContain('dota2.ai DSH 插件 v0.2.4');
    expect(notes).toContain('dsh-v0.2.3');
    expect(notes).toContain('- feat: change #1');
    expect(notes).toContain('- feat: change #30');
    expect(notes).not.toContain('- feat: change #31');
    expect(notes).toContain('5 more commits');
    expect(notes).toContain('dsh plugin --profile web update @qianhaoq/dsh-dota2ai');
    expect(notes).toContain('dsh plugin --profile web add @qianhaoq/dsh-dota2ai');
    expect(notes).toContain('DeepSeek Harness Desktop');
    expect(notes).toContain('桌面客户端');
  });

  it('handles missing prevTag and empty commits gracefully', () => {
    const notes = generateReleaseNotes({
      version: '0.2.4',
      prevTag: null,
      commits: [],
      existingNotes: null,
    });
    expect(notes).toContain('### Changes / 变更');
    expect(notes).toContain('Maintenance release');
  });
});

describe('fetchNpmVersions & formatGithubOutput', () => {
  it('returns empty versions on HTTP 404', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 404, ok: false }));
    const res = await fetchNpmVersions({ fetchImpl });
    expect(res).toEqual({ versions: [], latest: null, registryFallback: false });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://registry.npmjs.org/@qianhaoq%2fdsh-dota2ai',
      expect.any(Object),
    );
  });

  it('extracts versions and dist-tags.latest on HTTP 200', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => ({
        versions: { '0.2.2': {}, '0.2.3': {} },
        'dist-tags': { latest: '0.2.3' },
      }),
    }));
    const res = await fetchNpmVersions({ fetchImpl });
    expect(res).toEqual({ versions: ['0.2.2', '0.2.3'], latest: '0.2.3', registryFallback: false });
  });

  it('fails closed on registry error unless allowFallback is enabled', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(fetchNpmVersions({ fetchImpl, allowFallback: false })).rejects.toThrow(/Failed to query npm registry/);

    const warn = vi.fn();
    const fallback = await fetchNpmVersions({ fetchImpl, allowFallback: true, warn });
    expect(fallback).toEqual({ versions: [], latest: null, registryFallback: true });
    expect(warn).toHaveBeenCalledOnce();
  });

  it('sends no-cache headers on fetchNpmVersions and probes per-version npm endpoint accurately', async () => {
    const seenHeaders: any[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      seenHeaders.push({ url, headers: init?.headers });
      if (url.endsWith('/0.2.22')) {
        return { ok: true, status: 200, json: async () => ({ version: '0.2.22' }) };
      }
      if (url.endsWith('/0.2.23')) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      if (url.endsWith('/0.2.24')) {
        return { ok: true, status: 200, json: async () => ({ version: '0.2.21' }) };
      }
      return { ok: true, status: 200, json: async () => ({ 'dist-tags': { latest: '0.2.21' }, versions: { '0.2.21': {} } }) };
    });

    await fetchNpmVersions({ packageName: '@qianhaoq/dsh-dota2ai', fetchImpl: fetchImpl as any });
    expect(seenHeaders[0].headers).toMatchObject({ 'cache-control': 'no-cache', pragma: 'no-cache' });

    expect(await probeNpmVersionPublished({ packageName: '@qianhaoq/dsh-dota2ai', version: '0.2.22', fetchImpl: fetchImpl as any })).toBe(true);
    expect(await probeNpmVersionPublished({ packageName: '@qianhaoq/dsh-dota2ai', version: '0.2.23', fetchImpl: fetchImpl as any })).toBe(false);
    expect(await probeNpmVersionPublished({ packageName: '@qianhaoq/dsh-dota2ai', version: '0.2.24', fetchImpl: fetchImpl as any })).toBe(false);
    expect(await probeNpmVersionPublished({ packageName: '@qianhaoq/dsh-dota2ai', version: 'invalid', fetchImpl: fetchImpl as any })).toBe(false);
    expect(await probeNpmVersionPublished({
      packageName: '@qianhaoq/dsh-dota2ai',
      version: '0.2.22',
      fetchImpl: (async () => { throw new Error('network'); }) as any,
    })).toBe(false);
  });

  it('formats GitHub output lines cleanly including staleness, target_sha, and bundled_changes metadata', () => {
    expect(formatGithubOutput({
      version: '0.2.4',
      tag: 'dsh-v0.2.4',
      alreadyPublished: false,
      prevTag: 'dsh-v0.2.3',
      targetSha: 'abc1234',
      bundledChanges: true,
    })).toBe(
      'version=0.2.4\ntag=dsh-v0.2.4\nalready_published=false\nprev_tag=dsh-v0.2.3\nstale=false\nstale_reason=\ntarget_sha=abc1234\nbundled_changes=true\n',
    );

    expect(formatGithubOutput({
      version: '0.2.6',
      tag: 'dsh-v0.2.6',
      alreadyPublished: false,
      prevTag: 'dsh-v0.2.5',
      stale: true,
      staleReason: 'older_than_latest_tag',
      targetSha: 'def5678',
      bundledChanges: null,
    })).toBe(
      'version=0.2.6\ntag=dsh-v0.2.6\nalready_published=false\nprev_tag=dsh-v0.2.5\nstale=true\nstale_reason=older_than_latest_tag\ntarget_sha=def5678\nbundled_changes=\n',
    );
  });
});

describe('hasBundledChanges & workflow_run bundled-path gating', () => {
  it('matches bundled directories, exact bundled files, and workflow files while ignoring unrelated files', () => {
    expect(hasBundledChanges(['docs/AGENT_PIPELINE.md', 'README.md', 'scripts/calibrate.mjs'])).toBe(false);
    expect(hasBundledChanges([])).toBe(false);
    expect(hasBundledChanges(['docs/AGENT_PIPELINE.md', 'lib/agent/deepReview.js'])).toBe(true);
    expect(hasBundledChanges(['lib/matchReview/replayIngest/discovery.js'])).toBe(true);
    expect(hasBundledChanges(['packages/review-engine/data/static-heroes.json'])).toBe(true);
    expect(hasBundledChanges(['lib/aiLanguage.js'])).toBe(true);
    expect(hasBundledChanges(['LICENSE'])).toBe(true);
    expect(hasBundledChanges(['.github/workflows/dsh-release.yml'])).toBe(true);
    expect(hasBundledChanges(['.github/scripts/dsh-release-meta.mjs'])).toBe(true);
    expect(hasBundledChanges(['.github/workflows/ci.yml'])).toBe(false);
    expect(matchesBundledPath('lib/matchReviewOther/foo.js', 'lib/matchReview/**')).toBe(false);
  });

  it('skips workflow_run release when only docs changed since prevTag', () => {
    expect(resolveReleasePlan({
      pkgVersion: '0.2.3',
      tagVersions: ['dsh-v0.2.3'],
      npmVersions: ['0.2.3'],
      headSha: 'docs999',
      prevTagSha: 'rel111',
      headIsAncestorOfPrevTag: false,
      prevTagIsAncestorOfHead: true,
      requireBundledChanges: true,
      changedFilesSincePrevTag: ['README.md', 'docs/GAME_UNDERSTANDING.md'],
    })).toEqual({
      version: '0.2.4',
      tag: 'dsh-v0.2.4',
      alreadyPublished: false,
      prevTag: 'dsh-v0.2.3',
      stale: true,
      staleReason: 'no_bundled_changes_since_last_tag',
      resumeTag: null,
      bundledChanges: false,
    });
  });

  it('proceeds on workflow_run when bundled code changed since prevTag', () => {
    expect(resolveReleasePlan({
      pkgVersion: '0.2.3',
      tagVersions: ['dsh-v0.2.3'],
      npmVersions: ['0.2.3'],
      headSha: 'feat999',
      prevTagSha: 'rel111',
      headIsAncestorOfPrevTag: false,
      prevTagIsAncestorOfHead: true,
      requireBundledChanges: true,
      changedFilesSincePrevTag: ['README.md', 'lib/agent/webSearch.js'],
    })).toEqual({
      version: '0.2.4',
      tag: 'dsh-v0.2.4',
      alreadyPublished: false,
      prevTag: 'dsh-v0.2.3',
      stale: false,
      staleReason: null,
      resumeTag: null,
      bundledChanges: true,
    });
  });

  it('still resumes incomplete npm publish on workflow_run when resumeTag is set even with empty diff', () => {
    expect(resolveReleasePlan({
      pkgVersion: '0.2.3',
      tagVersions: ['dsh-v0.2.3', 'dsh-v0.2.4'],
      npmVersions: ['0.2.3'],
      headSha: 'rel222',
      prevTagSha: 'rel222',
      headIsAncestorOfPrevTag: true,
      prevTagIsAncestorOfHead: true,
      requireBundledChanges: true,
      changedFilesSincePrevTag: [],
    })).toEqual({
      version: '0.2.4',
      tag: 'dsh-v0.2.4',
      alreadyPublished: false,
      prevTag: 'dsh-v0.2.3',
      stale: false,
      staleReason: null,
      resumeTag: 'dsh-v0.2.4',
      bundledChanges: null,
    });
  });

  it('reports both source and destination paths via --no-renames when a bundled file is moved out of a watched dir', () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'dsh-meta-rename-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: tmpRepo, encoding: 'utf8' });
      git('init', '-q');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      mkdirSync(join(tmpRepo, 'lib/data/constants/patches'), { recursive: true });
      writeFileSync(join(tmpRepo, 'lib/data/constants/patches/old.json'), '{"patch":"7.40","data":[1,2,3]}\n');
      git('add', '.');
      git('commit', '-q', '-m', 'add patch snapshot');
      git('tag', '-a', 'dsh-v0.2.3', '-m', 'release 0.2.3');

      mkdirSync(join(tmpRepo, 'docs/archive'), { recursive: true });
      git('mv', 'lib/data/constants/patches/old.json', 'docs/archive/old.json');
      git('commit', '-q', '-m', 'archive old patch snapshot');

      const changed = readChangedFilesSinceTag('dsh-v0.2.3', tmpRepo);
      expect(changed).toContain('lib/data/constants/patches/old.json');
      expect(changed).toContain('docs/archive/old.json');
      expect(hasBundledChanges(changed)).toBe(true);
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });
});

describe('checkReleaseFreshness & resolveReleasePlan', () => {
  it('allows release when no previous dsh-v* tag exists', () => {
    expect(checkReleaseFreshness({
      headSha: 'aaa111',
      prevTag: null,
      prevTagSha: null,
      prevTagPublishedOnNpm: null,
      headIsAncestorOfPrevTag: null,
      prevTagIsAncestorOfHead: null,
    })).toEqual({ stale: false, reason: null, resumeTag: null });
  });

  it('marks HEAD stale when HEAD is the exact commit already released at prevTag and on npm', () => {
    expect(checkReleaseFreshness({
      headSha: 'abc123',
      prevTag: 'dsh-v0.2.5',
      prevTagSha: 'abc123',
      prevTagPublishedOnNpm: true,
      headIsAncestorOfPrevTag: true,
      prevTagIsAncestorOfHead: true,
    })).toEqual({ stale: true, reason: 'already_released_at_head', resumeTag: null });
  });

  it('resumes prevTag when HEAD is tagged with prevTag but that version is not yet on npm', () => {
    expect(checkReleaseFreshness({
      headSha: 'abc123',
      prevTag: 'dsh-v0.2.4',
      prevTagSha: 'abc123',
      prevTagPublishedOnNpm: false,
      headIsAncestorOfPrevTag: true,
      prevTagIsAncestorOfHead: true,
    })).toEqual({ stale: false, reason: null, resumeTag: 'dsh-v0.2.4' });

    expect(resolveReleasePlan({
      pkgVersion: '0.2.3',
      tagVersions: ['dsh-v0.2.2', 'dsh-v0.2.3', 'dsh-v0.2.4'],
      npmVersions: ['0.2.2', '0.2.3'],
      headSha: 'abc123',
      prevTagSha: 'abc123',
      headIsAncestorOfPrevTag: true,
      prevTagIsAncestorOfHead: true,
    })).toEqual({
      version: '0.2.4',
      tag: 'dsh-v0.2.4',
      alreadyPublished: false,
      prevTag: 'dsh-v0.2.3',
      stale: false,
      staleReason: null,
      resumeTag: 'dsh-v0.2.4',
      bundledChanges: null,
    });
  });

  it('refuses to resume prevTag at HEAD if a strictly newer version is already published on npm', () => {
    expect(resolveReleasePlan({
      pkgVersion: '0.2.3',
      tagVersions: ['dsh-v0.2.3', 'dsh-v0.2.4'],
      npmVersions: ['0.2.3', '0.2.5'],
      headSha: 'abc123',
      prevTagSha: 'abc123',
      headIsAncestorOfPrevTag: true,
      prevTagIsAncestorOfHead: true,
    })).toEqual({
      version: '0.2.6',
      tag: 'dsh-v0.2.6',
      alreadyPublished: false,
      prevTag: 'dsh-v0.2.4',
      stale: true,
      staleReason: 'older_than_latest_npm',
      resumeTag: null,
      bundledChanges: null,
    });
  });

  it('marks HEAD stale when an older workflow run is retried after a newer release tag exists (even if unpublished on npm)', () => {
    expect(checkReleaseFreshness({
      headSha: 'old111',
      prevTag: 'dsh-v0.2.5',
      prevTagSha: 'new222',
      prevTagPublishedOnNpm: false,
      headIsAncestorOfPrevTag: true,
      prevTagIsAncestorOfHead: false,
    })).toEqual({ stale: true, reason: 'older_than_latest_tag', resumeTag: null });

    expect(resolveReleasePlan({
      pkgVersion: '0.2.3',
      tagVersions: ['dsh-v0.2.3', 'dsh-v0.2.5'],
      npmVersions: ['0.2.3'],
      headSha: 'old111',
      prevTagSha: 'new222',
      headIsAncestorOfPrevTag: true,
      prevTagIsAncestorOfHead: false,
    })).toEqual({
      version: '0.2.6',
      tag: 'dsh-v0.2.6',
      alreadyPublished: false,
      prevTag: 'dsh-v0.2.5',
      stale: true,
      staleReason: 'older_than_latest_tag',
      resumeTag: null,
      bundledChanges: null,
    });
  });

  it('marks HEAD stale when HEAD is on a diverged branch that does not descend from prevTag', () => {
    expect(checkReleaseFreshness({
      headSha: 'side333',
      prevTag: 'dsh-v0.2.5',
      prevTagSha: 'main222',
      prevTagPublishedOnNpm: true,
      headIsAncestorOfPrevTag: false,
      prevTagIsAncestorOfHead: false,
    })).toEqual({ stale: true, reason: 'not_descendant_of_latest_tag', resumeTag: null });
  });

  it('allows release when HEAD is a fresh descendant of prevTag', () => {
    expect(checkReleaseFreshness({
      headSha: 'new333',
      prevTag: 'dsh-v0.2.5',
      prevTagSha: 'prev222',
      prevTagPublishedOnNpm: true,
      headIsAncestorOfPrevTag: false,
      prevTagIsAncestorOfHead: true,
    })).toEqual({ stale: false, reason: null, resumeTag: null });
  });
});

function parseWorkflowPushPaths(workflowYaml: string): string[] {
  const lines = workflowYaml.split(/\r?\n/);
  const paths: string[] = [];
  let inPaths = false;
  let pathsIndent = -1;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (!inPaths) {
      if (trimmed === 'paths:') {
        inPaths = true;
        pathsIndent = indent;
      }
      continue;
    }
    if (indent <= pathsIndent) break;
    const match = /^-\s+['"]?([^'"]+)['"]?$/.exec(trimmed);
    if (match) paths.push(match[1]);
  }
  return paths;
}

function matchesWorkflowPath(filePath: string, pattern: string): boolean {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -2);
    return filePath.startsWith(prefix);
  }
  return filePath === pattern;
}

describe('.github/workflows/dsh-release.yml path coverage', () => {
  it('keeps DSH_BUNDLED_PATH_PATTERNS in lockstep with dsh-release.yml on.push.paths', () => {
    const workflow = readFileSync(join(repoRoot, '.github/workflows/dsh-release.yml'), 'utf8');
    const pathGlobs = parseWorkflowPushPaths(workflow);
    expect(pathGlobs).toEqual([...DSH_BUNDLED_PATH_PATTERNS]);
  });

  it('covers every repo file bundled or packed into @qianhaoq/dsh-dota2ai', async () => {
    const workflow = readFileSync(join(repoRoot, '.github/workflows/dsh-release.yml'), 'utf8');
    const pathGlobs = parseWorkflowPushPaths(workflow);
    expect(pathGlobs.length).toBeGreaterThan(0);

    const dshRoot = join(repoRoot, 'packages/dsh');
    const goals = join(repoRoot, 'lib/coach/goals.js');
    const vendoredGoals = {
      name: 'vendored-goals',
      setup(b: import('esbuild').PluginBuild) {
        b.onResolve({ filter: /^\.\/vendor\/goals\.js$/ }, () => ({ path: goals }));
      },
    };
    const inlineLibJsonRequires = {
      name: 'inline-lib-json-requires',
      setup(b: import('esbuild').PluginBuild) {
        const libDir = `${join(repoRoot, 'lib')}/`;
        b.onLoad({ filter: /\.js$/ }, (args) => {
          if (!args.path.startsWith(libDir)) return undefined;
          let contents = readFileSync(args.path, 'utf8');
          if (!contents.includes('.json')) return undefined;
          const imports: string[] = [];
          let idx = 0;
          const replaceReq = (_m: string, relPath: string) => {
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
          return { contents: `${imports.join('\n')}\n${contents}`, loader: 'js' as const, resolveDir: dirname(args.path) };
        });
      },
    };
    const workspaceAliases = {
      '@dota2ai/review-engine': join(repoRoot, 'packages/review-engine/src/index.js'),
      'dota2ai/client': join(repoRoot, 'packages/cli/src/client.js'),
      'dota2ai/coach': join(repoRoot, 'packages/cli/src/coachApi.js'),
      'dota2ai/agent': join(repoRoot, 'packages/cli/src/agent.js'),
      'dota2ai/render': join(repoRoot, 'packages/cli/src/coach.js'),
      'dota2ai/handlers': join(repoRoot, 'packages/cli/src/handlers.js'),
      'dota2ai/tools': join(repoRoot, 'packages/cli/src/toolDocs.js'),
    };

    const [hostRes, typertRes, clientRes] = await Promise.all([
      build({
        entryPoints: [join(dshRoot, 'src/index.js')],
        bundle: true,
        write: false,
        metafile: true,
        platform: 'node',
        format: 'esm',
        target: 'node24',
        external: ['@deepseek-ai/*'],
        alias: workspaceAliases,
        plugins: [vendoredGoals, inlineLibJsonRequires],
      }),
      build({
        entryPoints: [join(dshRoot, 'src/typert.js')],
        bundle: true,
        write: false,
        metafile: true,
        platform: 'neutral',
        format: 'esm',
        target: 'es2022',
        external: ['@deepseek-ai/*'],
      }),
      build({
        entryPoints: [join(dshRoot, 'src/client/index.tsx')],
        bundle: true,
        write: false,
        metafile: true,
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
        logOverride: { 'ignored-bare-import': 'silent' },
      }),
    ]);

    const bundledRepoFiles = new Set<string>([
      'lib/data/constants/patches/index.json',
      'LICENSE',
      'packages/dsh/package.json',
      'packages/dsh/cordis.patch.yml',
      'packages/dsh/icon.svg',
      'packages/dsh/README.md',
    ]);
    for (const res of [hostRes, typertRes, clientRes]) {
      for (const input of Object.keys(res.metafile?.inputs ?? {})) {
        if (input.startsWith('node_modules/') || input.startsWith('<')) continue;
        bundledRepoFiles.add(input);
      }
    }

    expect(bundledRepoFiles.has('lib/matchReview/replayIngest/discovery.js')).toBe(true);
    const uncovered = [...bundledRepoFiles].filter((f) => !pathGlobs.some((p) => matchesWorkflowPath(f, p))).sort();
    expect(uncovered, `Files bundled into @qianhaoq/dsh-dota2ai missing from dsh-release.yml on.push.paths`).toEqual([]);
  }, 30_000);
});

describe('packages/dsh/scripts/pack.mjs releaseManifest', () => {
  it('keeps source version when no override is supplied and strips internal fields', () => {
    const manifest = releaseManifest(dshPkg);
    expect(manifest.version).toBe(dshPkg.version);
    expect(manifest.private).toBeUndefined();
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.scripts).toBeUndefined();
    expect(manifest['dota2ai:release']).toBeUndefined();
    expect(manifest.peerDependencies).toEqual(dshPkg['dota2ai:release'].peerDependencies);
  });

  it('overrides version in staged manifest without mutating source package.json', () => {
    const originalVersion = dshPkg.version;
    const manifest = releaseManifest(dshPkg, '0.2.99');
    expect(manifest.version).toBe('0.2.99');
    expect(dshPkg.version).toBe(originalVersion);

    const preManifest = releaseManifest(dshPkg, '0.3.0-rc.1');
    expect(preManifest.version).toBe('0.3.0-rc.1');
  });

  it('rejects invalid semver overrides', () => {
    for (const bad of ['', 'v0.2.4', '0.2', '0.2.4.5', '0.2.4;rm -rf /', 'invalid']) {
      expect(() => releaseManifest(dshPkg, bad), bad).toThrow(/Invalid --version/);
    }
  });
});
