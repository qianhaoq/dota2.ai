import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every workflow runs on GitHub-hosted runners. Gates triggered by
// pull_request_target / issue_comment / workflow_run read their YAML from
// main, so one self-hosted label there leaves required checks queued
// forever whenever the box is offline (this blocked #139 and #141).
const dir = join(__dirname, '../../.github/workflows');
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));

describe('GitHub Actions runners', () => {
  it('finds the workflow files', () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it.each(files)('%s uses no self-hosted runner', (file) => {
    const offending = readFileSync(join(dir, file), 'utf8')
      .split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => !line.startsWith('#') && /self-hosted/i.test(line));
    expect(offending).toEqual([]);
  });
});
