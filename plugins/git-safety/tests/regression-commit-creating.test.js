#!/usr/bin/env node
/**
 * Regression tests for git-safety: cherry-pick, revert, am and a merging or
 * rebasing pull write commits on a protected branch, like commit and merge.
 *
 * Run: node --test plugins/git-safety/tests/regression-commit-creating.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

delete process.env.HOOK_SAFETY_LEVEL;

const { checkCommand } = require('../git-safety.js');

function shouldBlock(cmd, expectedId, branch = 'main') {
  const result = checkCommand(cmd, branch, 'high');
  assert.strictEqual(result.blocked, true, `Expected BLOCKED but was ALLOWED: ${cmd}`);
  assert.strictEqual(result.pattern.id, expectedId, `Expected pattern '${expectedId}' but got '${result.pattern.id}'`);
  assert.ok(result.reason.includes('main'), result.reason);
}

function shouldAllow(cmd, branch = 'main') {
  const result = checkCommand(cmd, branch, 'high');
  assert.strictEqual(result.blocked, false, `Expected ALLOWED but was BLOCKED by '${result.pattern?.id}': ${cmd}`);
}

describe('commit-creating calls on main', () => {
  it('blocks the recorded inputs', () => {
    shouldBlock('git cherry-pick abc123', 'cherry-pick-on-protected');
    shouldBlock('git revert HEAD', 'revert-on-protected');
    shouldBlock('git am fix.patch', 'am-on-protected');
  });
  it('blocks nearby spellings', () => {
    for (const c of ['git -C . cherry-pick abc', 'git cherry-pick -x abc', 'git cherry-pick -m 1 abc', 'git cherry-pick --continue', '/usr/bin/git cherry-pick abc', 'sh -c "git cherry-pick abc"'])
      shouldBlock(c, 'cherry-pick-on-protected');
    for (const c of ['git revert --no-edit HEAD', 'git -C . revert HEAD~2']) shouldBlock(c, 'revert-on-protected');
    for (const c of ['git am -3 fix.patch', 'git am --skip', 'git am < fix.patch']) shouldBlock(c, 'am-on-protected');
  });
  it('blocks after a switch to main earlier in the line', () =>
    shouldBlock('git checkout main && git cherry-pick abc', 'cherry-pick-on-protected', 'feature'));
});

describe('calls that write no commit', () => {
  it('allows -n/--no-commit, which only stages the change, and --abort/--quit', () => {
    for (const c of ['git cherry-pick -n abc', 'git cherry-pick --no-commit abc', 'git revert -n HEAD', 'git cherry-pick --abort', 'git revert --quit', 'git am --abort', 'git am --show-current-patch'])
      shouldAllow(c);
  });
  it('keeps -n refused when it is an option value, follows an unknown long option or the line cannot be read exactly', () => {
    for (const c of ['git cherry-pick -m -n abc', 'git cherry-pick -X -n abc', 'git cherry-pick --main -n abc', 'git cherry-pick -n $REV', 'env git cherry-pick abc; git cherry-pick -n def'])
      shouldBlock(c, 'cherry-pick-on-protected');
  });
});

describe('git pull on main', () => {
  it('blocks a pull that merges another branch or rebases', () => {
    for (const c of ['git pull --no-ff', 'git pull --rebase', 'git pull -r', 'git pull --rebase=merges', 'git pull origin other-branch', 'git pull origin feature:main', 'git pull --ff-only origin feature'])
      shouldBlock(c, 'pull-merge-on-protected');
  });
  it('allows a plain pull of the branch itself', () => {
    for (const c of ['git pull', 'git pull origin main', 'git pull --ff-only', 'git pull -q', 'git pull --no-rebase', 'git pull --rebase=false', 'git pull --depth 1 origin main'])
      shouldAllow(c);
  });
  it('blocks a pull whose branch or options are known only when the shell runs', () => {
    for (const c of ['git pull origin "$BRANCH"', 'git pull origin $BRANCH', 'git pull origin $(git rev-parse --abbrev-ref @{u})', 'git pull origin `cat branch`', 'git pull origin feat*', 'git pull origin {main,feature}', 'git pull $ARGS', 'git pull "$REMOTE" main'])
      shouldBlock(c, 'pull-merge-on-protected');
  });
});

describe('pull forms read exactly', () => {
  it('blocks a wrapped git, whose call the guard cannot clear', () => {
    for (const c of ['env git pull --rebase', 'env GIT_TRACE=1 git pull origin feature']) shouldBlock(c, 'pull-merge-on-protected');
    shouldBlock('sudo git cherry-pick abc', 'cherry-pick-on-protected');
    shouldBlock('nice git am fix.patch', 'am-on-protected');
  });
  it('a flag with an optional attached value does not take the remote as its value', () => {
    for (const c of ['git pull --recurse-submodules origin feature', 'git pull --gpg-sign origin feature']) shouldBlock(c, 'pull-merge-on-protected');
  });
  it('compares the pulled branch with the branch the pull lands on', () => {
    for (const c of ['git pull origin master', 'git pull origin HEAD']) shouldBlock(c, 'pull-merge-on-protected');
    shouldAllow('git pull origin main:main');
    shouldBlock('git checkout main && git pull origin feature', 'pull-merge-on-protected', 'feature');
    shouldAllow('git pull origin feature', 'feature');
  });
  it('allows modes that write nothing', () => {
    for (const c of ['git pull --dry-run', 'git pull --dry-run origin feature', 'git revert --no-commit --no-edit HEAD', 'git cherry-pick -n --signoff abc', 'git am --show-current-patch=diff'])
      shouldAllow(c);
  });
});

describe('only a plain git call moves the branch', () => {
  it('words handed to another program do not leave main', () => {
    for (const c of ['git switch main && logger git switch scratch && git commit -m x', 'git switch main && echo git switch scratch && git commit -m x', 'git switch main && ./git switch scratch && git commit -m x'])
      shouldBlock(c, 'commit-on-protected', 'feature');
  });
  it('a wrapped switch does not leave main either', () => {
    for (const c of ['git switch main && env git switch scratch && git commit -m x', 'git switch main && sudo git switch scratch && git commit -m x'])
      shouldBlock(c, 'commit-on-protected', 'feature');
    shouldBlock('env git switch -c fix && git commit -m x', 'commit-on-protected');
  });
  it('words handed to another program do not move a feature session onto main', () => {
    for (const c of ['logger git switch main; git commit -m x', 'logger "git switch main" && git commit -m x'])
      shouldAllow(c, 'feature');
  });
});

describe('a pull judged on the branch it reaches', () => {
  it('allows a same-branch pull after a certain switch to master', () => shouldAllow('git switch master && git pull origin master'));
  it('blocks it when the switch may not have run, or the source differs', () => {
    for (const c of ['git switch master; git pull origin master', 'git switch master && git pull origin feature'])
      shouldBlock(c, 'pull-merge-on-protected');
  });
});

describe('controls', () => {
  it('allows the same calls on a feature branch', () => {
    for (const c of ['git cherry-pick abc123', 'git revert HEAD', 'git am fix.patch', 'git pull --rebase', 'git pull origin other-branch'])
      shouldAllow(c, 'feature');
  });
  it('allows them on main after a certain switch to a new branch', () => {
    for (const c of ['git checkout -b fix && git cherry-pick x', 'git switch -c fix && git revert HEAD', 'git checkout -b fix && git pull origin feature', 'git checkout -b fix && git am fix.patch && git commit -m x'])
      shouldAllow(c);
  });
  it('keeps commit and merge refused on main', () => {
    shouldBlock('git commit -m x', 'commit-on-protected');
    shouldBlock('git merge topic', 'merge-on-protected');
  });
});
