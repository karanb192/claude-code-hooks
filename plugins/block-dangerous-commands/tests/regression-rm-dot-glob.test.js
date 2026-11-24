#!/usr/bin/env node
/**
 * Regression tests for block-dangerous-commands: rm of every hidden entry by a dot glob
 *
 * Run: node --test plugins/block-dangerous-commands/tests/regression-rm-dot-glob.test.js
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

describe('rm of every hidden entry in a home directory', () => {
  it('blocks a dot glob after ~', () => {
    for (const c of ['rm -rf ~/.*', 'rm -rf ~/.?*', 'rm -rf ~/.??*', 'rm -rf ~/.[!.]*', 'rm -rf ~/.[^.]*', 'rm -rf ~/.*/', '(rm -rf ~/.*)', 'sudo rm -rf ~/.*'])
      shouldBlock(c, 'rm-home');
  });
  it('blocks a dot glob after $HOME and a home directory by absolute path', () => {
    for (const c of ['rm -rf $HOME/.*', 'rm -rf "$HOME"/.*', 'rm -rf ${HOME}/.??*']) shouldBlock(c, 'rm-home-var');
    for (const c of ['rm -rf /Users/dev/.*', 'rm -rf /home/dev/.[!.]*']) shouldBlock(c, 'rm-home-abs');
  });
});

describe('rm of every hidden entry in the cwd', () => {
  it('blocks a dot glob on its own', () => {
    for (const c of ['rm -rf .*', 'rm -rf ./.*', 'rm -rf .[!.]*', 'cd ~ && rm -rf .??*']) shouldBlock(c, 'rm-cwd');
  });
});

describe('dot files that are not all of them', () => {
  it('allows one hidden entry or a narrower glob', () => {
    for (const c of ['rm -rf ~/.cache', 'rm -f ~/.bash_history', 'rm -rf ~/.npm/_cacache', 'rm -f ~/.zcompdump*', 'rm -f ~/.*rc.bak', 'rm -rf .next', 'rm -rf ./.venv', 'rm .DS_Store', 'rm -f .*.swp', 'rm -f .env.*', 'rm -rf build/.*', 'rm -rf .git/hooks/*.sample'])
      shouldAllow(c);
  });
  it('allows a quoted dot glob, which names one file', () => {
    for (const c of ['rm -rf "~/.*"', "rm -rf '$HOME/.*'", "rm -f '.*'"]) shouldAllow(c);
  });
});
