import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const guard = require('../../.github/scripts/external-pr-guard.cjs');
const { decide, run, LABEL, MARKER } = guard;
const root = join(__dirname, '../..');

const base = { action: 'opened', baseRepo: 'qianhaoq/dota2.ai', headRepo: 'qianhaoq/dota2.ai', labels: [], commented: false };

describe('external PR guard: decide', () => {
  it('leaves same-repository PRs alone (pushing a branch needs write access)', () => {
    expect(decide(base)).toEqual({ external: false, addLabel: false, comment: false });
    expect(decide({ ...base, headRepo: 'QianHaoQ/Dota2.ai' }).external).toBe(false);
  });

  it('holds a fork PR for review and explains once', () => {
    expect(decide({ ...base, headRepo: 'someone/dota2.ai' })).toEqual({ external: true, addLabel: true, comment: true });
    expect(decide({ ...base, headRepo: 'someone/dota2.ai', commented: true }).comment).toBe(false);
  });

  it('treats a deleted fork as external', () => {
    expect(decide({ ...base, headRepo: null }).addLabel).toBe(true);
  });

  it('re-adds the label on every new push, so an approval covers only reviewed code', () => {
    expect(decide({ ...base, action: 'synchronize', headRepo: 'someone/dota2.ai', commented: true }))
      .toEqual({ external: true, addLabel: true, comment: false });
    expect(decide({ ...base, action: 'synchronize', headRepo: 'someone/dota2.ai', labels: [LABEL], commented: true }).addLabel).toBe(false);
  });

  it('does not fight the owner removing the label (approval) on label events', () => {
    expect(decide({ ...base, action: 'unlabeled', headRepo: 'someone/dota2.ai', commented: true }))
      .toEqual({ external: true, addLabel: false, comment: false });
  });
});

describe('external PR guard: run', () => {
  const ctx = (headRepo: string | null, action = 'opened') => ({
    repo: { owner: 'qianhaoq', repo: 'dota2.ai' },
    payload: { action, pull_request: { number: 7, head: { repo: headRepo ? { full_name: headRepo } : null }, labels: [] } },
  });
  const gh = (comments: { body: string }[] = []) => ({
    paginate: vi.fn(async () => comments),
    rest: { issues: { listComments: vi.fn(), addLabels: vi.fn(async () => ({})), createComment: vi.fn(async () => ({})) } },
  });
  const core = { info: () => {} };

  it('labels and comments on a new fork PR', async () => {
    const github = gh();
    await run({ github, context: ctx('someone/dota2.ai'), core });
    expect(github.rest.issues.addLabels).toHaveBeenCalledWith({ owner: 'qianhaoq', repo: 'dota2.ai', issue_number: 7, labels: [LABEL] });
    expect(github.rest.issues.createComment.mock.calls[0][0].body).toContain(MARKER);
  });

  it('does not comment twice', async () => {
    const github = gh([{ body: `${MARKER}\nhi` }]);
    await run({ github, context: ctx('someone/dota2.ai', 'synchronize'), core });
    expect(github.rest.issues.addLabels).toHaveBeenCalled();
    expect(github.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('touches nothing on a same-repo PR', async () => {
    const github = gh();
    await run({ github, context: ctx('qianhaoq/dota2.ai'), core });
    expect(github.paginate).not.toHaveBeenCalled();
    expect(github.rest.issues.addLabels).not.toHaveBeenCalled();
  });
});

describe('external PR guard: wiring', () => {
  const yml = readFileSync(join(root, '.github/workflows/external-pr-guard.yml'), 'utf8');
  it('never checks out the PR head under pull_request_target', () => {
    expect(yml).toMatch(/pull_request_target:/);
    expect(yml).not.toMatch(/github\.event\.pull_request\.head\.(sha|ref)/);
    expect(yml).toMatch(/ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  });
  it('is a required check of Auto Merge and of the watchdog (fail-closed)', () => {
    expect(yml).toMatch(/name: External PR Guard\n\s+runs-on/);
    expect(readFileSync(join(root, '.github/workflows/auto-merge.yml'), 'utf8')).toMatch(/required_checks: \|[\s\S]*?\n\s+External PR Guard\n/);
    const { DEFAULTS } = require('../../.github/scripts/pipeline-watchdog.cjs');
    expect(DEFAULTS.required).toContain('External PR Guard');
  });
});
