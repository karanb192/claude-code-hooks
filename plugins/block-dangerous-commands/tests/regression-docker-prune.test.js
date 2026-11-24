#!/usr/bin/env node
/**
 * Regression tests for block-dangerous-commands: docker prune of other object types (strict)
 *
 * Run: node --test plugins/block-dangerous-commands/tests/regression-docker-prune.test.js
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

describe('docker prune of other object types at strict', () => {
  it('blocks container, builder, network and buildx prune', () => {
    for (const c of ['docker container prune -f', 'docker builder prune -af', 'docker network prune -f', 'docker buildx prune -f'])
      shouldBlock(c, 'docker-prune', 'strict');
  });
  it('allows listing them', () => {
    shouldAllow('docker container ls', 'strict');
    shouldAllow('docker network ls', 'strict');
  });
  it('allows prune at the default level', () => shouldAllow('docker container prune -f'));
});
