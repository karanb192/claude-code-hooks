#!/usr/bin/env node
/**
 * Regression tests for block-dangerous-commands: a +ref force refspec at strict
 *
 * Run: node --test plugins/block-dangerous-commands/tests/regression-strict-force-refspec.test.js
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

describe('force push by a +ref refspec at strict', () => {
  it('blocks git push origin +feature', () => {
    shouldBlock('git push origin +feature', 'git-force-any', 'strict');
    shouldBlock('git push origin +HEAD:feature', 'git-force-any', 'strict');
  });
  it('allows a plain push and a + in a later command', () => {
    shouldAllow('git push origin feature', 'strict');
    shouldAllow('git push origin feature && echo +x', 'strict');
  });
  it('allows a +feature refspec at the default level', () => shouldAllow('git push origin +feature'));
  it('allows a push-option value that starts with +', () => {
    shouldAllow('git push -o +build origin topic', 'strict');
    shouldAllow('git push --push-option +build origin topic', 'strict');
  });
  it('still blocks a +ref after a push option', () => shouldBlock('git push -o +build origin +topic', 'git-force-any', 'strict'));
});

describe('each push option takes exactly its own value', () => {
  it('still blocks a +ref after an option whose value is attached or already taken', () => {
    for (const c of ['git push -oo +topic origin', 'git push -o -o +x origin', 'git push --repo +t'])
      shouldBlock(c, 'git-force-any', 'strict');
  });
  it('allows the separate value of -o', () => shouldAllow('git push -ofoo -o +x', 'strict'));
});
