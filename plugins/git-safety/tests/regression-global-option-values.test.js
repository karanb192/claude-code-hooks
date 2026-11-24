#!/usr/bin/env node
/**
 * Regression tests for git-safety: global option values with quotes or escapes inside the word do not hide the subcommand.
 *
 * Run: node --test plugins/git-safety/tests/regression-global-option-values.test.js
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

describe('git global options before a branch-aware subcommand', () => {
  it('blocks the recorded inputs on main', () => {
    for (const [c, id] of [
      ['git -c user.name="Test User" -c user.email=t@example.com commit -m "wip"', 'commit-on-protected'],
      ['git -c core.editor="code --wait" rebase -i HEAD~2', 'rebase-on-protected'],
      ["git -c user.name='Test User' commit -m wip", 'commit-on-protected'],
      ['git -C my\\ repo commit -m wip', 'commit-on-protected'],
      ['git --attr-source HEAD commit -m wip', 'commit-on-protected'],
    ]) shouldBlock(c, id, 'main');
  });
  it('blocks a quoted long option value on main', () =>
    shouldBlock('git --exec-path="/opt/my git" commit -m wip', 'commit-on-protected', 'main'));
  it('the same calls stay allowed on a feature branch', () => {
    for (const c of ['git -c user.name="Test User" commit -m wip', 'git -C my\\ repo commit -m wip', 'git --attr-source HEAD commit -m wip'])
      shouldAllow(c, 'feature');
  });
  it('a quoted value before a read-only subcommand stays allowed on main', () =>
    shouldAllow('git -c core.pager="less -R" log --oneline', 'main'));
});
