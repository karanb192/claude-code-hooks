#!/usr/bin/env node
/**
 * Regression tests for block-dangerous-commands: rm targets spelled as a glob or a doubled slash
 *
 * Run: node --test plugins/block-dangerous-commands/tests/regression-rm-globs.test.js
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

describe('rm of everything inside a home directory', () => {
  it('blocks a /* or doubled slash after ~', () => {
    shouldBlock('rm -rf ~/*', 'rm-home');
    shouldBlock('rm -rf ~//', 'rm-home');
  });
  it('blocks a /* or doubled slash after $HOME', () => {
    for (const c of ['rm -rf $HOME/*', 'rm -rf "$HOME"/*', 'rm -rf $HOME//']) shouldBlock(c, 'rm-home-var');
  });
  it('blocks a /* after a home directory by absolute path', () => {
    for (const c of ['rm -rf /Users/dev/*', 'rm -rf /home/dev/*', 'rm -rf /Users/alice/*']) shouldBlock(c, 'rm-home-abs');
  });
  it('allows a glob below home', () => {
    for (const c of ['rm -rf ~/*.log', 'rm -rf ~/*/node_modules', 'rm -rf ~/Documents/*', 'rm -rf /Users/alice/project/*']) shouldAllow(c);
  });
});

describe('rm of the root or the cwd by another spelling', () => {
  it('blocks rm -rf //', () => shouldBlock('rm -rf //', 'rm-root'));
  it('blocks a glob that matches every name in the cwd', () => {
    shouldBlock('rm -rf ?*', 'rm-cwd');
    shouldBlock('rm -rf ./**', 'rm-cwd');
  });
  it('allows a glob that matches some names', () => {
    for (const c of ['rm -rf ./*.o', 'rm -f *.tmp', 'rm -rf build/*', 'rm -rf ?']) shouldAllow(c);
  });
});
