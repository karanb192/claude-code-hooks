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

  it('still allows reading with sed, perl and awk', () => {
    for (const cmd of ["sed -n p .claude/settings.json", "sed -e 's/x/y/' .claude/settings.json", 'perl -ne print .claude/settings.json', "awk '{print}' .claude/settings.json"]) bashAllowed(cmd);
  });
});
