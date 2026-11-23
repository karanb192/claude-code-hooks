#!/usr/bin/env node
/**
 * Regression: strict level: a recursive grep for secrets with the flag after the pattern, and base64 of any secret file
 * Each recorded input below was allowed before this fix. Both the standalone
 * hook and guard-pack's bundled copy must refuse it at its recorded level.
 *
 * Run: node --test plugins/protect-secrets/tests/regression-strict-grep.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const standalone = require('../protect-secrets.js');
const bundled = require('../../guard-pack/lib/protect-secrets.js');

const REFUSED = [
  ["grep password -r .", 'strict'],
  ["grep -i password . -r", 'strict'],
  ["base64 ~/.ssh/id_ed25519", 'strict'],
  ["base64 ~/.kube/config", 'strict'],
  // The flag still counts behind a redirection, inside a quoted pattern, or before a --.
  ["grep token . 2>&1 -r", 'strict'],
  ['grep -r "foo&token" .', 'strict'],
  ["grep -r -- password .", 'strict'],
  // A backup copy of a secret file is still the secret.
  ["base64 .npmrc.bak", 'strict'],
  ["base64 .npmrc.backup", 'strict'],
];

const ALLOWED = [
  ['grep password config.yml', 'strict'],
  ['grep -i --color=auto token file.txt', 'strict'],
  ['grep token README.md -n', 'strict'],
  ['grep -r foo .', 'strict'],
  ['base64 image.png', 'strict'],
  ['grep password -r .', 'high'],
  // A -r that belongs to another command, or a file named -r after --, is not grep's flag.
  ['grep token README.md && ls -r', 'strict'],
  ['grep token README.md\nls -r', 'strict'],
  ['grep token -- -r', 'strict'],
  // The whole operand is classified: .npmrc.md is a different file from .npmrc.
  ['base64 .npmrc.md', 'strict'],
  ['base64 docs/.npmrc.md', 'strict'],
];

for (const [name, mod] of [['protect-secrets', standalone], ['guard-pack copy', bundled]]) {
  describe(`${name}: recorded inputs are refused`, () => {
    for (const [command, level] of REFUSED) {
      it(`${level}: ${JSON.stringify(command)}`, () => {
        const r = mod.check('Bash', { command }, level);
        assert.strictEqual(r.blocked, true, `allowed: ${command}`);
      });
    }
  });

  it(`${name}: a long grep with many terms and no recursive flag stays fast`, () => {
    const started = Date.now();
    mod.check('Bash', { command: 'grep ' + 'token '.repeat(10000) }, 'strict');
    mod.check('Bash', { command: 'grep ' + '-r '.repeat(20000) }, 'strict');
    assert.ok(Date.now() - started < 500, `took ${Date.now() - started}ms`);
  });

  describe(`${name}: neighbouring commands stay allowed`, () => {
    for (const [command, level] of ALLOWED) {
      it(`${level}: ${JSON.stringify(command)}`, () => {
        const r = mod.check('Bash', { command }, level);
        assert.strictEqual(r.blocked, false, `refused as ${r.pattern && r.pattern.id}: ${command}`);
      });
    }
  });
}
