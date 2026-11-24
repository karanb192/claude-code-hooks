#!/usr/bin/env node
/**
 * Regression tests for git-safety: a push to the short heads/main ref is a push to main.
 *
 * Run: node --test plugins/git-safety/tests/regression-heads-ref.test.js
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

describe('push to main or master spelled heads/<branch>', () => {
  it('blocks the recorded input', () => shouldBlock('git push origin HEAD:heads/main', 'push-main', 'feature'));
  it('blocks heads/master', () => shouldBlock('git push origin heads/master', 'push-master', 'feature'));
  it('still blocks the full refs/heads/main', () => shouldBlock('git push origin HEAD:refs/heads/main', 'push-main', 'feature'));
  it('allows heads/ inside a longer branch path or name', () => {
    for (const c of ['git push origin feat/heads/main', 'git push origin HEAD:heads/main-x']) shouldAllow(c, 'feature');
  });
});
