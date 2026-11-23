#!/usr/bin/env node
/**
 * Regression tests for config-guard.js: the .claude folder and cd
 *
 * Run: node --test plugins/config-guard/tests/regression-dir-and-cd.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

delete process.env.HOOK_SAFETY_LEVEL;
delete process.env.CLAUDE_CONFIG_DIR;

const { checkBashCommand } = require('../config-guard.js');

function bashBlocked(cmd, expectedId = null, level = undefined) {
  const result = checkBashCommand(cmd, level);
  assert.strictEqual(result.blocked, true, `Expected BLOCKED but ALLOWED: ${cmd}`);
  if (expectedId) assert.strictEqual(result.id, expectedId, `Expected '${expectedId}' but got '${result.id}'`);
}

function bashAllowed(cmd, level = undefined) {
  const result = checkBashCommand(cmd, level);
  assert.strictEqual(result.blocked, false, `Expected ALLOWED but BLOCKED by '${result.id}': ${cmd}`);
}

// The protected path was not named: the .claude folder itself, or a bare
// name after cd into a protected folder. These inputs once passed.
describe('Regression: the .claude folder and a cd into protected config', () => {
  it('denies deleting or moving a .claude folder itself', () => {
    for (const cmd of ['rm -rf .claude', 'mv .claude .claude.off', 'rm -rf .claude/*']) bashBlocked(cmd, 'claude-dir');
  });

  it('denies writes and deletes after cd into .claude or ~/.codex', () => {
    bashBlocked('cd .claude && jq ".hooks={}" settings.json > s.tmp && mv s.tmp settings.json', 'settings-file');
    bashBlocked('cd .claude && echo {} > settings.json', 'settings-file');
    bashBlocked('(cd .claude && rm -rf hooks)', 'hook-script');
    bashBlocked('cd ~/.codex && echo x >> config.toml', 'codex-config');
    bashBlocked('cd .claude && echo x >> rules/style.md', 'rules-dir', 'strict');
  });

  it('still allows copying .claude out, reads after cd, and unrelated folders', () => {
    for (const cmd of ['cp -r .claude /tmp/backup && rm -rf node_modules', 'cd .claude && ls && cat settings.json', 'cd src && rm settings.json',
      'cd build && rm -rf hooks', 'rm -rf .claude-old', 'rm -rf docs/.claude-example']) bashAllowed(cmd);
  });
});
