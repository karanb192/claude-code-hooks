#!/usr/bin/env node
/**
 * Regression tests for block-dangerous-commands: chmod 777 in other spellings
 *
 * Run: node --test plugins/block-dangerous-commands/tests/regression-chmod-modes.test.js
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

describe('chmod 777 in other spellings', () => {
  it('blocks a leading 0 or a special bit', () => {
    for (const c of ['chmod 0777 deploy.sh', 'chmod -R 0777 .', 'chmod 1777 /srv/x']) shouldBlock(c, 'chmod-777');
  });
  it('blocks rwx for everyone spelled symbolically', () => {
    for (const c of ['chmod a+rwx deploy.sh', 'chmod ugo+rwx deploy.sh']) shouldBlock(c, 'chmod-777');
  });
  it('allows narrower modes', () => {
    for (const c of ['chmod 0755 x', 'chmod 0644 f', 'chmod a+x run.sh', 'chmod u+rwx x', 'chmod ugo+rx x', 'chmod 2775 dir']) shouldAllow(c);
  });
});
