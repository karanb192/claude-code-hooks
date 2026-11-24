#!/usr/bin/env node
/**
 * Regression tests for block-dangerous-commands: a fork bomb with any function name
 *
 * Run: node --test plugins/block-dangerous-commands/tests/regression-fork-bomb.test.js
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

describe('fork bomb with any function name', () => {
  it('blocks a named function that pipes itself into itself in the background', () => {
    shouldBlock('bomb(){ bomb|bomb& };bomb', 'fork-bomb');
    shouldBlock('f(){ f|f& };f', 'fork-bomb');
  });
  it('still blocks the classic spelling', () => shouldBlock(':(){ :|:& };:', 'fork-bomb'));
  it('allows a function that pipes into other commands', () => {
    shouldAllow('foo(){ bar|baz& }; foo');
    shouldAllow('build(){ make | tee log & }; build');
  });
});

describe('quoted text inside a function body', () => {
  it('allows a function that only prints its own name in a pipe', () => {
    shouldAllow("build(){ echo ' build | build &'; }; build");
    shouldAllow('build(){ echo " build | build &"; }; build');
  });
  it('still blocks a real self-pipe next to quoted text', () => {
    shouldBlock("f(){ echo 'hi'; f|f& }; f", 'fork-bomb');
    shouldBlock('bomb(){ bomb|bomb& }; bomb "x"', 'fork-bomb');
  });
});

describe('a comment inside a function body', () => {
  it('allows a function whose comment spells a self-pipe', () => {
    shouldAllow('ready(){ echo ready # ready|ready&\n}; ready');
    shouldAllow('ready(){ echo ready; # ready | ready &\n}');
  });
  it('still blocks a real self-pipe before or after a comment', () => {
    shouldBlock('f(){ # note\nf|f& }; f', 'fork-bomb');
    shouldBlock('f(){ f|f& # note\n}; f', 'fork-bomb');
  });
});
