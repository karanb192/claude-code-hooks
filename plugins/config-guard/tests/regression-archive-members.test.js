#!/usr/bin/env node
/**
 * Regression tests for config-guard.js: archive extraction of named members
 *
 * Run: node --test plugins/config-guard/tests/regression-archive-members.test.js
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

// Extracting an archive member that is a protected config path writes that
// path in the project. These inputs once passed.
describe('Regression: archive extraction of named config members', () => {
  it('denies tar extracting a named settings.json member', () => {
    for (const cmd of [
      'tar -xf evil.tar .claude/settings.json',
      'tar xf evil.tar .claude/settings.json',
      'tar -x -f evil.tar .claude/settings.json',
      'tar --extract --file=evil.tar .claude/settings.json',
      'bsdtar -xf evil.tar .claude/settings.json',
      'tar -xf evil.tar -- .claude/settings.json',
      'tar -xvf evil.tar "./.claude/settings.json"',
    ]) bashBlocked(cmd, 'settings-file');
    bashBlocked('tar -xzf evil.tgz .claude/hooks', 'hook-script');
  });

  it('denies unzip extracting a named config member', () => {
    for (const cmd of ['unzip evil.zip .claude/settings.json', 'unzip -o evil.zip .claude/settings.json']) bashBlocked(cmd, 'settings-file');
    bashBlocked('unzip -o evil.zip .claude/hooks/pre.js', 'hook-script');
  });

  it('denies extracting a whole .claude folder by name', () => {
    for (const cmd of ['tar -xf evil.tar .claude', 'tar -xf evil.tar .claude/', 'unzip evil.zip ".claude/*"']) bashBlocked(cmd, 'claude-dir');
  });

  it('still allows listing, printing, other members and extraction elsewhere', () => {
    for (const cmd of [
      'tar -xf evil.tar',
      'tar -xf evil.tar -C /tmp/x',
      'tar -tf evil.tar .claude/settings.json',
      'tar -xOf evil.tar .claude/settings.json',
      'tar -xf evil.tar --to-stdout .claude/settings.json',
      'tar -xf .claude/backup.tar src',
      'unzip evil.zip',
      'unzip -l evil.zip .claude/settings.json',
      'unzip -p evil.zip .claude/settings.json',
      'unzip -o evil.zip src/app.js',
    ]) bashAllowed(cmd);
  });
});
