#!/usr/bin/env node
/**
 * Regression tests for block-dangerous-commands: git global option values with quoted or escaped spaces
 *
 * Run: node --test plugins/block-dangerous-commands/tests/regression-git-option-quotes.test.js
 * Or:  npm test
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

// A HOOK_SAFETY_LEVEL leaking in from the runner's shell would change the default level.
delete process.env.HOOK_SAFETY_LEVEL;

const { checkCommand } = require('../block-dangerous-commands.js');

function shouldBlock(cmd, expectedId, safetyLevel = undefined) {
  const result = checkCommand(cmd, safetyLevel);
  assert.strictEqual(result.blocked, true, `Expected BLOCKED but was ALLOWED: ${cmd}`);
  assert.strictEqual(result.pattern.id, expectedId, `Expected pattern '${expectedId}' but got '${result.pattern.id}'`);
}

function shouldAllow(cmd, safetyLevel = undefined) {
  const result = checkCommand(cmd, safetyLevel);
  assert.strictEqual(result.blocked, false, `Expected ALLOWED but was BLOCKED by '${result.pattern?.id}': ${cmd}`);
}

describe('git global option value with a quoted or escaped space', () => {
  it('blocks reset --hard after -c key="two words"', () =>
    shouldBlock('git -c core.editor="code --wait" reset --hard', 'git-reset-hard'));
  it('blocks reset --hard after -C with an escaped space', () =>
    shouldBlock('git -C my\\ repo reset --hard', 'git-reset-hard'));
  it('blocks a force push to main after such a value', () =>
    shouldBlock('git -c core.editor="code --wait" push --force origin main', 'git-force-main'));
  it('allows safe subcommands after such a value', () => {
    shouldAllow('git -c core.editor="code --wait" commit');
    shouldAllow('git -C my\\ repo status');
  });
  it('a long run of quoted option values stays fast', () => {
    const start = Date.now();
    shouldAllow('git ' + '-c a="b c" '.repeat(5000) + 'status');
    shouldAllow('git -C ' + '\\\\ '.repeat(10000) + 'x');
    assert.ok(Date.now() - start < 1000, `took ${Date.now() - start} ms`);
  });
});
