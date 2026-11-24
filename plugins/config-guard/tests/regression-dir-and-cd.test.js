#!/usr/bin/env node
/**
 * Regression tests for config-guard.js: the .claude folder and cd
 *
 * Run: node --test plugins/config-guard/tests/regression-dir-and-cd.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

  it('allows a cd that ends with its subshell or runs in the background', () => {
    for (const cmd of ['(cd .claude); rm settings.json', '(cd .claude && ls) && rm -rf hooks', 'cd .claude & rm settings.json',
      'echo "$(cd .claude; pwd)"; rm settings.json', 'pushd .claude; popd; rm settings.json']) bashAllowed(cmd);
  });

  it('still follows a cd inside its subshell and builds on earlier cds', () => {
    bashBlocked('(cd .claude && rm settings.json)', 'settings-file');
    bashBlocked('cd .claude; (ls); rm settings.json', 'settings-file');
    bashBlocked('cd .claude && cd hooks && rm guard.js', 'hook-script');
    bashBlocked('cd .claude; cd /tmp; cd -; rm settings.json', 'settings-file');
    bashBlocked('(cd .claude; case $x in a) rm settings.json;; esac)', 'settings-file');
  });

  it('judges a move into an existing .claude folder by where the file lands', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-mv-'));
    try {
      fs.mkdirSync(path.join(dir, '.claude'));
      const at = (cmd) => checkBashCommand(cmd, 'high', dir).blocked;
      for (const cmd of ['mv notes.txt .claude', 'git mv notes.txt .claude/', 'mv -t .claude a.txt b.txt'])
        assert.strictEqual(at(cmd), false, `Expected ALLOWED: ${cmd}`);
      for (const cmd of ['mv settings.json .claude', 'mv hooks .claude/', 'mv *.json .claude', 'mv -T notes .claude', 'mv .claude notes'])
        assert.strictEqual(at(cmd), true, `Expected BLOCKED: ${cmd}`);
      assert.strictEqual(checkBashCommand('mv notes .claude', 'high', path.join(dir, 'missing')).id, 'claude-dir');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still allows copying .claude out, reads after cd, and unrelated folders', () => {
    for (const cmd of ['cp -r .claude /tmp/backup && rm -rf node_modules', 'cd .claude && ls && cat settings.json', 'cd src && rm settings.json',
      'cd build && rm -rf hooks', 'rm -rf .claude-old', 'rm -rf docs/.claude-example']) bashAllowed(cmd);
  });
});
