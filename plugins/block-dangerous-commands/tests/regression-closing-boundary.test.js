#!/usr/bin/env node
/**
 * Regression tests for block-dangerous-commands: a closing paren or redirect right after the target
 *
 * Run: node --test plugins/block-dangerous-commands/tests/regression-closing-boundary.test.js
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

describe('rm target closed by a paren or followed by a redirect', () => {
  it('blocks rm of home in a subshell or before a redirect', () => {
    shouldBlock('(cd /tmp && rm -rf ~)', 'rm-home');
    shouldBlock('(rm -rf ~)', 'rm-home');
    shouldBlock('rm -rf ~>/dev/null', 'rm-home');
  });
  it('blocks rm of the cwd, its parent or a system directory closed by a paren', () => {
    shouldBlock('(cd build && rm -rf *)', 'rm-cwd');
    shouldBlock('(cd pkg && rm -rf ..)', 'rm-parent');
    shouldBlock('rm -rf /usr)', 'rm-system');
  });
  it('allows an ordinary rm in a subshell or before a redirect', () => {
    shouldAllow('(rm -rf build)');
    shouldAllow('rm -rf ./node_modules>/dev/null');
  });
});

describe('force push closed by a subshell paren', () => {
  it('blocks a force push to main', () => {
    shouldBlock('(cd repo && git push --force origin main)', 'git-force-main');
    shouldBlock('(git push origin main --force)', 'git-force-main');
  });
  it('allows a force push to a feature branch at the default level', () => shouldAllow('(git push -f origin feature)'));
  it('blocks any force push at strict', () => shouldBlock('(git push -f)', 'git-force-any', 'strict'));
  it('allows --force-with-lease at strict', () => shouldAllow('(git push --force-with-lease)', 'strict'));
});

describe('a paren or redirect inside quotes is part of the name', () => {
  it('allows rm of one file whose quoted name holds > or )', () => {
    shouldAllow("rm -f '$HOME>bak'");
    shouldAllow('rm -f "$HOME>bak"');
    shouldAllow("rm -f '~)x'");
  });
  it('allows a force push of a branch whose quoted name holds )', () => shouldAllow("git push --force origin 'main)fix'"));
  it('still blocks a quoted target before a real paren or redirect', () => {
    shouldBlock('(rm -rf "$HOME")', 'rm-home-var');
    shouldBlock('rm -rf "~">/dev/null', 'rm-home');
    shouldBlock("(git push --force origin 'main')", 'git-force-main');
  });
});

describe('a variable that holds a paren or redirect in a name', () => {
  it('allows the name when it comes from a variable', () => {
    shouldAllow("b='main)fix'; git push --force origin \"$b\"");
    shouldAllow("b='$HOME>bak'; rm -f \"$b\"");
  });
  it('still blocks a variable that holds the target itself', () => {
    shouldBlock('b=main; (git push --force origin "$b")', 'git-force-main');
    shouldBlock('(rm -rf "$HOME")', 'rm-home-var');
  });
});
