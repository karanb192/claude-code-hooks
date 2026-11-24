#!/usr/bin/env node
/**
 * Regression tests for config-guard.js: git writing through an output option
 *
 * Run: node --test plugins/config-guard/tests/regression-git-output.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

delete process.env.HOOK_SAFETY_LEVEL;
delete process.env.CLAUDE_CONFIG_DIR;

const { checkBashCommand } = require('../config-guard.js');

function bashBlocked(cmd, expectedId = null, level = undefined) {
  const result = checkBashCommand(cmd, level);
  assert.strictEqual(result.blocked, true, `Expected BLOCKED but ALLOWED: ${cmd}`);
  if (expectedId) assert.strictEqual(result.id, expectedId, `Expected '${expectedId}' but got '${result.id}'`);
}

function bashAllowed(cmd, level = undefined) {
  const result = checkBashCommand(cmd, level);
  assert.strictEqual(result.blocked, false, `Expected ALLOWED but BLOCKED by '${result.id}': ${cmd}`);
}

// git writes the file named by an output option. These inputs once passed.
describe('Regression: git output options onto protected config', () => {
  it('denies --output on diff, log and show', () => {
    for (const cmd of [
      'git diff --output=.claude/settings.json',
      'git diff --output .claude/settings.json',
      'git log -p --output=.claude/settings.json',
      'git show HEAD --output=".claude/settings.json"',
      'sudo git diff --output=.claude/settings.json',
      'git -C .claude diff --output=settings.json',
      'cd .claude && git diff --output=settings.json',
    ]) bashBlocked(cmd, 'settings-file');
  });

  it('denies format-patch and archive output into config', () => {
    for (const cmd of [
      'git format-patch -o .claude/hooks HEAD~1',
      'git format-patch -o.claude/hooks HEAD~1',
      'git format-patch --output-directory .claude/hooks HEAD~1',
      'git format-patch --output-directory=.claude/hooks HEAD~1',
    ]) bashBlocked(cmd, 'hook-script');
    for (const cmd of ['git archive -o .claude/settings.json HEAD', 'git archive --output=.claude/settings.json HEAD']) bashBlocked(cmd, 'settings-file');
  });

  it('denies git bundle create writing a protected file', () => {
    for (const cmd of [
      'git bundle create .claude/settings.json --all',
      'git bundle create -q .claude/settings.json --all',
      'git bundle create --quiet .claude/settings.json HEAD',
      'git bundle create --version 3 .claude/settings.json --all',
      'git -C .claude bundle create settings.json --all',
      'cd .claude && git bundle create settings.json --all',
    ]) bashBlocked(cmd, 'settings-file');
  });

  it('finds git by path or behind env, and normalises the output path', () => {
    for (const cmd of [
      '/usr/bin/git diff --output=.claude/settings.json',
      'env GIT_PAGER=cat git diff --output=.claude/settings.json',
      'GIT_PAGER=cat git diff --output=.claude/settings.json',
      'git diff --output=.claude/./settings.json',
      'cd .claude && git archive -osettings.json HEAD',
    ]) bashBlocked(cmd, 'settings-file');
  });

  it('denies --output on blame, cherry-pick, revert, shortlog, reflog and rev-list', () => {
    for (const cmd of [
      'git blame --output=.claude/settings.json README.md',
      'git cherry-pick --output=.claude/settings.json HEAD',
      'git revert --output=.claude/settings.json HEAD',
      'git shortlog --output=.claude/settings.json',
      'git reflog --output=.claude/settings.json',
      'git rev-list --output=.claude/settings.json HEAD',
    ]) bashBlocked(cmd, 'settings-file');
  });

  it('finds git after wrapper options, not at the first word named git', () => {
    for (const cmd of [
      'sudo -u git git archive -o .claude/settings.json HEAD',
      'sudo -u admin git archive -o .claude/settings.json HEAD',
      'env -u X git diff --output=.claude/settings.json',
      'timeout 5 git diff --output=.claude/settings.json',
      'xargs -i git bundle create .claude/settings.json',
    ]) bashBlocked(cmd, 'settings-file');
    for (const cmd of ['env printf git diff --output=.claude/settings.json', 'echo git diff --output=.claude/settings.json']) bashAllowed(cmd);
  });

  it('allows a search pattern or message that reads --output=', () => {
    for (const cmd of [
      'git grep "--output=.claude/settings.json" README.md',
      'git grep -- "--output=.claude/settings.json" README.md',
      'git log --grep "--output=.claude/settings.json"',
      'git commit -m "--output=.claude/settings.json"',
    ]) bashAllowed(cmd);
  });

  it('still allows output elsewhere and reading config through git', () => {
    for (const cmd of [
      'git diff --output=/tmp/x.patch',
      'git diff --output=/tmp/x.patch -- .claude/settings.json',
      'git format-patch -o /tmp/patches HEAD~1',
      'git archive -o /tmp/a.tar HEAD .claude/settings.json',
      'git diff -- .claude/settings.json',
      'git log --output-indicator-new=+ -- .claude/settings.json',
      'git bundle create /tmp/x.bundle --all',
      'git bundle create -q /tmp/x.bundle main',
      'git bundle verify .claude/x.bundle',
    ]) bashAllowed(cmd);
  });
});
