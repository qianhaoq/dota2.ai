import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRACE_TOOLS as fromWorkspaceImport } from '@dota2ai/review-engine';
import { TRACE_TOOLS as fromRelativeImport } from '../../packages/review-engine/src/index.js';

const ROOT = path.resolve(__dirname, '../..');

describe('worktree workspace resolution and trace-worker guard (#365)', () => {
  it('resolves @dota2ai/review-engine to this checkout even when node_modules is symlinked', () => {
    // Without the Vitest alias + inline rule, @dota2ai/review-engine resolves
    // through a symlinked node_modules to the main checkout's copy, producing
    // two distinct module instances and running CLI tests against stale code.
    expect(fromWorkspaceImport).toBe(fromRelativeImport);
  });

  it('keeps every local module imported by scripts/trace-worker.mjs inside Dockerfile.trace-worker', () => {
    const dockerfile = readFileSync(path.join(ROOT, 'Dockerfile.trace-worker'), 'utf8');
    const copiedPaths = dockerfile
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('COPY '))
      .flatMap((line) => {
        const tokens = line.replace(/^COPY\s+(?:--\S+\s+)*/, '').trim().split(/\s+/);
        // All tokens except the destination are sources in the build context.
        return tokens.slice(0, -1).filter((t) => !t.startsWith('$'));
      });

    const isCoveredByCopy = (relFile: string) =>
      copiedPaths.some((src) => {
        const clean = src.replace(/^\.\//, '').replace(/\/$/, '');
        return relFile === clean || relFile.startsWith(`${clean}/`);
      });

    // Walk local relative imports starting from scripts/trace-worker.mjs.
    const visited = new Set<string>();
    const queue = ['scripts/trace-worker.mjs'];
    const importRe = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"](\.[^'"]+)['"]/g;

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      expect(isCoveredByCopy(current), `${current} must be copied in Dockerfile.trace-worker`).toBe(true);

      const abs = path.join(ROOT, current);
      expect(existsSync(abs), `${current} must exist`).toBe(true);
      const source = readFileSync(abs, 'utf8');
      for (const match of source.matchAll(importRe)) {
        const nextRel = path.posix.normalize(path.posix.join(path.posix.dirname(current), match[1]));
        if (!visited.has(nextRel)) queue.push(nextRel);
      }
    }

    expect(visited.has('packages/review-engine/src/trace/build.js')).toBe(true);
    expect(visited.has('lib/agent/traceBuild.js')).toBe(true);
    expect(visited.has('lib/agent/tracePipeline.js')).toBe(true);
  });

  it('calls out manual trace-worker redeployment in the PR template', () => {
    const prTemplate = readFileSync(path.join(ROOT, '.github/pull_request_template.md'), 'utf8');
    expect(prTemplate).toContain('packages/review-engine/src/trace/build.js');
    expect(prTemplate).toContain('trace-worker');
  });
});
