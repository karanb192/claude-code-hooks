#!/usr/bin/env node
/**
 * Regression tests for git-safety: delete, gh and force flags are read wherever they sit.
 *
 * Run: node --test plugins/git-safety/tests/regression-flag-spellings.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

delete process.env.HOOK_SAFETY_LEVEL;

const { checkCommand } = require('../git-safety.js');

function shouldBlock(cmd, expectedId, branch, level) {
  const result = checkCommand(cmd, branch, level);
  assert.strictEqual(result.blocked, true, `Expected BLOCKED but was ALLOWED: ${cmd}`);
  assert.strictEqual(result.pattern.id, expectedId, `Expected pattern '${expectedId}' but got '${result.pattern.id}'`);
}

function shouldAllow(cmd, branch, level) {
  const result = checkCommand(cmd, branch, level);
  assert.strictEqual(result.blocked, false, `Expected ALLOWED but was BLOCKED by '${result.pattern?.id}': ${cmd}`);
}

describe('git branch delete with other flags or branch names in the call', () => {
  it('blocks the recorded inputs', () => {
    for (const c of [
      'git branch --delete --force main', 'git branch -d -f main', 'git branch -D "main"',
      'git branch -D old-feature main', 'git branch -Dq main', 'git branch -D -- main', 'git branch -D feature master',
    ]) shouldBlock(c, 'branch-delete-protected', 'feature');
  });
  it('still blocks the plain forms', () => {
    for (const c of ['git branch -D main', 'git branch -d master', 'git branch --delete main', '(git branch -D main)'])
      shouldBlock(c, 'branch-delete-protected', 'feature');
  });
  it('allows deleting a branch whose name only starts with main', () => shouldAllow('git branch -D main-backup', 'feature'));
  it('allows renaming main, listing, and a later command that names main', () => {
    for (const c of ['git branch -m main trunk', 'git branch --list main -v', 'git branch -d feat && git checkout main', 'git branch -d feature-branch'])
      shouldAllow(c, 'feature');
  });
});

describe('gh with group flags between the two words', () => {
  const cases = [
    ['gh pr --repo owner/repo merge 12', 'gh-pr-merge'],
    ['gh issue --repo owner/repo close 3', 'gh-issue-close'],
    ['gh release --repo owner/repo delete v1', 'gh-release-delete'],
    ['gh pr -R acme/app merge 12 --squash', 'gh-pr-merge'],
    ['gh pr --repo acme/app merge 12', 'gh-pr-merge'],
    ['gh pr -R acme/app close 12', 'gh-pr-close'],
    ['gh issue -R acme/app close 7', 'gh-issue-close'],
    ['gh release -R acme/app delete v1.0.0 --yes', 'gh-release-delete'],
    ['gh pr --repo=acme/app merge 12', 'gh-pr-merge'],
  ];
  for (const [cmd, id] of cases) it(`blocks: ${cmd}`, () => shouldBlock(cmd, id, 'feature'));
  it('allows read-only calls with a repo flag', () => {
    for (const c of ['gh pr -R acme/app view 12', 'gh pr -R acme/app list --search merge', 'gh pr view 1 --json merge'])
      shouldAllow(c, 'feature');
  });
});

describe('force push with -f in a short-flag cluster (strict)', () => {
  it('blocks the recorded inputs', () => {
    for (const c of ['git push -fu origin feature', 'git push -uf origin feature', 'git push -qf origin feature'])
      shouldBlock(c, 'force-push', 'feature', 'strict');
  });
  it('allows a push option value that contains f', () => shouldAllow('git push -of origin feature', 'feature', 'strict'));
  it('allows --force-with-lease', () => shouldAllow('git push --force-with-lease origin feature', 'feature', 'strict'));
  it('high still delegates a clustered force push to the sibling hook', () => shouldAllow('git push -fu origin feature', 'feature', 'high'));
});
