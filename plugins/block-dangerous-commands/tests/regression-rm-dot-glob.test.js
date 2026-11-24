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

describe('dot globs after other operands, with a trailing slash, and their breadth', () => {
  it('blocks a dot glob of hidden directories in the cwd', () => {
    for (const c of ['rm -rf .*/', 'rm -rf ./.*/']) shouldBlock(c, 'rm-cwd');
  });
  it('blocks a dot glob after other operands when rm has no flags', () => {
    for (const c of ['rm x .*', 'rm a b .[!.]*', 'rm x *']) shouldBlock(c, 'rm-cwd');
    shouldBlock('rm x ~/.* y', 'rm-home');
  });
  it('blocks a dot glob made only of wildcards, whatever the ? count', () => {
    for (const c of ['rm -rf ~/.???*', 'rm -rf ~/.????*', 'rm -rf ~/.[a-z]*', 'rm -rf ~/.[[:alpha:]]*', 'rm -rf ~/.?']) shouldBlock(c, 'rm-home');
    shouldBlock('rm -rf .???*', 'rm-cwd');
  });
  it('still refuses a long run of ? on purpose', () => shouldBlock('rm -rf ~/.????????????*', 'rm-home'));
  it('allows a dot glob with a literal character after the dot', () => {
    for (const c of ['rm -rf ~/.cache*', 'rm -rf ~/.c*', 'rm -rf ~/.*rc', 'rm -f .*.swp', 'rm -f .env.*']) shouldAllow(c);
  });
  it('allows a quoted bracket expression, which is literal', () => shouldAllow("rm -rf ~/.'[!.]'*"));
  it('allows a dot glob in another command after rm', () => {
    for (const c of ['rm x; ls .*', 'rm x | ls .*']) shouldAllow(c);
  });
  it('still blocks a quoted ~ directory, read as home', () => shouldBlock("rm -rf '~'/.*", 'rm-home'));
});

describe('repeated ./ components, quoted brackets and comments', () => {
  it('blocks a glob behind any run of ./ components', () => {
    for (const c of ['rm -rf ././.*', 'rm -rf ./././*', 'rm -rf .//.*', 'rm -rf ./.']) shouldBlock(c, 'rm-cwd');
  });
  it('allows a quoted bracket expression, which names one file', () => {
    for (const c of ["rm -f '.[ab]'", 'rm -f ".[ab]"', 'rm -f .\\[!.]*']) shouldAllow(c);
  });
  it('allows a glob that is only in a comment after rm', () => {
    for (const c of ['rm scratch # inspect .*', 'rm x #y .*']) shouldAllow(c);
  });
  it('still refuses on purpose a glob used as an input redirect, and a comment after flags, as main does', () => {
    shouldBlock('rm x < .*', 'rm-cwd');
    shouldBlock('rm -f x # .*', 'rm-cwd');
  });
});
