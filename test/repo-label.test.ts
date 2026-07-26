import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitRoot, repoLabel } from '../src/repo.js';

const sandbox = mkdtempSync(join(tmpdir(), 'claude-ping-repo-'));

// A normal clone: .git is a directory.
const clone = join(sandbox, 'my-repo');
mkdirSync(join(clone, '.git'), { recursive: true });
mkdirSync(join(clone, 'packages', 'web'), { recursive: true });

// A worktree or submodule: .git is a file pointing elsewhere.
const worktree = join(sandbox, 'wt-checkout');
mkdirSync(worktree, { recursive: true });
writeFileSync(join(worktree, '.git'), 'gitdir: /somewhere/else\n');

// Not a repo at all.
const loose = join(sandbox, 'loose-dir');
mkdirSync(loose, { recursive: true });

test('gitRoot: finds the root from the repo directory itself', () => {
  assert.equal(gitRoot(clone), clone);
});

test('gitRoot: walks up from a nested directory', () => {
  assert.equal(gitRoot(join(clone, 'packages', 'web')), clone);
});

test('gitRoot: returns null outside a repo', () => {
  assert.equal(gitRoot(loose), null);
});

test('repoLabel: uses the repo name at the root', () => {
  assert.equal(repoLabel(clone), 'my-repo');
});

// The point of the feature: "web" alone is meaningless when several projects ping
// the same chat, so the repo name leads and the sub-path is kept for precision.
test('repoLabel: prefixes the repo name for a nested directory', () => {
  assert.equal(repoLabel(join(clone, 'packages', 'web')), 'my-repo/packages/web');
});

test('repoLabel: a .git file (worktree/submodule) counts as a repo root', () => {
  assert.equal(repoLabel(worktree), 'wt-checkout');
});

test('repoLabel: falls back to the directory name outside a repo', () => {
  assert.equal(repoLabel(loose), 'loose-dir');
});

test('repoLabel: handles a missing cwd', () => {
  assert.equal(repoLabel(undefined), 'claude');
});

test('repoLabel: handles the filesystem root without looping', () => {
  assert.equal(typeof repoLabel('/'), 'string');
});
