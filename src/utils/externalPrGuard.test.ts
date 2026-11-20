import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const guard = require('../../.github/scripts/external-pr-guard.cjs');
const { decide, run, LABEL, MARKER, CHECK_NAME } = guard;
const root = join(__dirname, '../..');

const base = { action: 'opened', baseRepo: 'qianhaoq/dota2.ai', headRepo: 'qianhaoq/dota2.ai', author: 'qianhaoq', owner: 'qianhaoq', labels: [], commented: false };

describe('external PR guard: decide', () => {
  it("leaves only the owner's own same-repository PRs alone", () => {
    expect(decide(base)).toEqual({ external: false, addLabel: false, comment: false });
    expect(decide({ ...base, headRepo: 'QianHaoQ/Dota2.ai', author: 'QianHaoQ' }).external).toBe(false);
  });

  it('holds same-repository PRs from anyone else: bots, collaborators, a deleted account', () => {
    for (const author of ['dependabot[bot]', 'Copilot', 'a-collaborator', null]) {
      expect(decide({ ...base, author }), String(author)).toEqual({ external: true, addLabel: true, comment: true });
    }
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
  const ctx = (headRepo: string | null, action = 'opened', author = 'qianhaoq') => ({
    repo: { owner: 'qianhaoq', repo: 'dota2.ai' },
    payload: { action, pull_request: { number: 7, user: { login: author }, head: { sha: 'abc123', repo: headRepo ? { full_name: headRepo } : null }, labels: [] } },
  });
  const gh = (comments: { body: string }[] = []) => ({
    paginate: vi.fn(async () => comments),
    rest: {
      issues: { listComments: vi.fn(), addLabels: vi.fn(async () => ({})), createComment: vi.fn(async () => ({})) },
      checks: { create: vi.fn(async () => ({})) },
    },
  });
  const core = { info: () => {} };

  it('labels and comments on a new fork PR', async () => {
    const github = gh();
    await run({ github, context: ctx('someone/dota2.ai'), core });
    expect(github.rest.issues.addLabels).toHaveBeenCalledWith({ owner: 'qianhaoq', repo: 'dota2.ai', issue_number: 7, labels: [LABEL] });
    expect((github.rest.issues.createComment.mock.calls as unknown as [{ body: string }][])[0]?.[0].body).toContain(MARKER);
  });

  it('does not comment twice', async () => {
    const github = gh([{ body: `${MARKER}\nhi` }]);
    await run({ github, context: ctx('someone/dota2.ai', 'synchronize'), core });
    expect(github.rest.issues.addLabels).toHaveBeenCalled();
    expect(github.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('labels a Dependabot PR from a branch of this repository', async () => {
    const github = gh();
    await run({ github, context: ctx('qianhaoq/dota2.ai', 'opened', 'dependabot[bot]'), core });
    expect(github.rest.issues.addLabels).toHaveBeenCalled();
    expect(github.rest.checks.create).toHaveBeenCalledWith(expect.objectContaining({ output: expect.objectContaining({ title: 'Held for owner review' }) }));
  });

  it("only publishes the head check on the owner's own PR", async () => {
    const github = gh();
    await run({ github, context: ctx('qianhaoq/dota2.ai'), core });
    expect(github.paginate).not.toHaveBeenCalled();
    expect(github.rest.issues.addLabels).not.toHaveBeenCalled();
    expect(github.rest.checks.create).toHaveBeenCalledWith(expect.objectContaining({ name: CHECK_NAME, head_sha: 'abc123', conclusion: 'success' }));
  });

  it('publishes the head check only after the label is in place (fail-closed)', async () => {
    const github = gh();
    github.rest.issues.addLabels.mockRejectedValueOnce(new Error('API down'));
    await expect(run({ github, context: ctx('someone/dota2.ai'), core })).rejects.toThrow('API down');
    expect(github.rest.checks.create).not.toHaveBeenCalled();
    const ok = gh();
    await run({ github: ok, context: ctx('someone/dota2.ai'), core });
    expect(ok.rest.checks.create.mock.invocationCallOrder[0]).toBeGreaterThan(ok.rest.issues.addLabels.mock.invocationCallOrder[0]);
  });
});

describe('external PR guard: wiring', () => {
  const yml = readFileSync(join(root, '.github/workflows/external-pr-guard.yml'), 'utf8');
  it('never checks out the PR head under pull_request_target', () => {
    expect(yml).toMatch(/pull_request_target:/);
    expect(yml).not.toMatch(/github\.event\.pull_request\.head\.(sha|ref)/);
    expect(yml).toMatch(/ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  });
  it('publishes its result on the PR head, and that check gates Auto Merge and the watchdog', () => {
    // A pull_request_target job's own check lands on main's commit, so the gate is the script's head check.
    expect(CHECK_NAME).toBe('External PR Guard');
    expect(yml).toMatch(/checks: write/);
    expect(yml).not.toMatch(/^ {4}name: External PR Guard$/m); // job name; the workflow may keep it
    expect(readFileSync(join(root, '.github/workflows/auto-merge.yml'), 'utf8')).toMatch(/required_checks: \|[\s\S]*?\n\s+External PR Guard\n/);
    const { DEFAULTS } = require('../../.github/scripts/pipeline-watchdog.cjs');
    expect(DEFAULTS.required).toContain('External PR Guard');
  });
});
