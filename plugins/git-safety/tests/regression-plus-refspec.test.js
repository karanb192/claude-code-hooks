#!/usr/bin/env node
/**
 * Regression tests for git-safety: a + refspec is a force push at strict.
 *
 * Run: node --test plugins/git-safety/tests/regression-plus-refspec.test.js
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

describe('force push through a + refspec (strict)', () => {
  it('blocks the recorded input', () => shouldBlock('git push origin +feature', 'force-push', 'feature', 'strict'));
  it('blocks +src:dst and a quoted refspec', () => {
    for (const c of ['git push origin +HEAD:feature', "git push origin '+feature'", 'git push -u origin +feature'])
      shouldBlock(c, 'force-push', 'feature', 'strict');
  });
  it('allows plain refspecs and --force-with-lease', () => {
    for (const c of ['git push origin feature', 'git push origin HEAD:feature', 'git push --force-with-lease origin feature', 'git push origin feature && echo +1'])
      shouldAllow(c, 'feature', 'strict');
  });
  it('high still delegates it to the sibling hook', () => shouldAllow('git push origin +feature', 'feature', 'high'));
  it('high still blocks +main through push-main', () => shouldBlock('git push origin +main', 'push-main', 'feature', 'high'));
});

describe('a push-option value is not a refspec (strict)', () => {
  it('allows -o +build', () => shouldAllow('git push -o +build origin topic', 'feature', 'strict'));
  it('allows the value after --push-option, quoted or in a short-flag cluster', () => {
    for (const c of ['git push --push-option +build origin topic', "git push -o '+build' origin topic", 'git push -uo +build origin topic'])
      shouldAllow(c, 'feature', 'strict');
  });
  it('still blocks a + refspec later in the same call', () => {
    for (const c of ['git push -o +build origin +topic', 'git push -o ci.skip origin +topic', 'git push -ou origin +topic'])
      shouldBlock(c, 'force-push', 'feature', 'strict');
  });
  it('still blocks a force flag given as the option value, as main does', () =>
    shouldBlock('git push -o -f origin topic', 'force-push', 'feature', 'strict'));
});
