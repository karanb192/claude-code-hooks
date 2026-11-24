#!/usr/bin/env node
/**
 * Regression tests for config-guard.js: in-place edit spellings
 *
 * Run: node --test plugins/config-guard/tests/regression-inplace-flags.test.js
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

// In-place edits written with clustered short flags, GNU long flags, ruby
// -pi or awk -i inplace. These inputs once passed.
describe('Regression: in-place edit spellings', () => {
  it('denies every in-place spelling on settings.json', () => {
    for (const cmd of [
      `sed -Ei 's/"hooks"/"hooks_off"/' .claude/settings.json`,
      "sed --in-place 's/a/b/' .claude/settings.json",
      "sed -ni '/hooks/!p' .claude/settings.json",
      `ruby -pi -e 'gsub(/a/,"b")' .claude/settings.json`,
      "sed --in-place 's/node/true/' .claude/settings.json",
      "sed -Ei 's/node/true/' .claude/settings.json",
      "awk -i inplace '{print}' .claude/settings.json",
      'perl -0pi -e s/a/b/ .claude/settings.json',
    ]) bashBlocked(cmd, 'settings-file');
  });

  it('denies sed -Ei on CLAUDE.md at strict', () => bashBlocked("sed -Ei 's/always/never/' CLAUDE.md", 'claude-md', 'strict'));

  it('allows perl and ruby with a -I library path that only read', () => {
    for (const cmd of [
      'perl -Ilib -ne print .claude/settings.json',
      'ruby -Ilib -ne print .claude/settings.json',
      'perl -MList::Util -ne print .claude/settings.json',
    ]) bashAllowed(cmd);
  });

  it('still denies an in-place edit next to a -I library path', () => {
    for (const cmd of [
      'perl -Ilib -pi -e s/a/b/ .claude/settings.json',
      'perl -Ilib -i -pe s/a/b/ .claude/settings.json',
      'ruby -Ilib -pi -e x .claude/settings.json',
      'PERL -pi -e s/a/b/ .claude/settings.json',
      'perl -i.bak -pe s/a/b/ .claude/settings.json',
      'sed -I "" s/a/b/ .claude/settings.json',
    ]) bashBlocked(cmd, 'settings-file');
  });

  it('allows a separate -I value and file names after --', () => {
    for (const cmd of [
      'perl -I -include -ne print .claude/settings.json',
      'ruby -I -include -ne print .claude/settings.json',
      'perl -ne print -- -input.txt .claude/settings.json',
      'ruby -ne print -- -ifoo .claude/settings.json',
    ]) bashAllowed(cmd);
  });

  it('still denies -i after a separate value, a quoted -i, and clusters perl does not end early', () => {
    for (const cmd of [
      'perl -I lib -pi -e s/a/b/ .claude/settings.json',
      'perl -C -i -pe x .claude/settings.json',
      'perl -e x -i .claude/settings.json',
      'perl "-i" -pe x .claude/settings.json',
      'perl -0x1Fi -pe x .claude/settings.json',
      'sed "-i" s/a/b/ .claude/settings.json',
      'sed \\-i s/a/b/ .claude/settings.json',
    ]) bashBlocked(cmd, 'settings-file');
  });

  it('still allows reading with sed, perl and awk', () => {
    for (const cmd of ["sed -n p .claude/settings.json", "sed -e 's/x/y/' .claude/settings.json", 'perl -ne print .claude/settings.json', "awk '{print}' .claude/settings.json"]) bashAllowed(cmd);
  });
});
