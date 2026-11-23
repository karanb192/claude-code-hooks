#!/usr/bin/env node
/**
 * Regression: commands that print the whole environment
 * Each recorded input below was allowed before this fix. Both the standalone
 * hook and guard-pack's bundled copy must refuse it at its recorded level.
 *
 * Run: node --test plugins/protect-secrets/tests/regression-env-dump.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const standalone = require('../protect-secrets.js');
const bundled = require('../../guard-pack/lib/protect-secrets.js');

const REFUSED = [
  ["PS-05", "export -p", 'high'],
  ["PS-05.1", "env -0", 'high'],
  ["SEC-05", "cd /app\nenv", 'high'],
  ["SEC-05-b", "env\nls", 'high'],
  ["SEC-05-c", "env > /tmp/e.txt", 'high'],
  ["SEC-05-d", "env 2>&1", 'high'],
  ["SEC-05-e", "/usr/bin/env", 'high'],
  ["SEC-05-f", "command env", 'high'],
  ["SEC-05-g", "if true; then env; fi", 'high'],
  ["SEC-05-h", "{ env; }", 'high'],
  ["SEC-05-i", "echo \"`env`\"", 'high'],
  ["SEC-05-j", "export -p", 'high'],
  ["SEC-05-k", "declare -p", 'high'],
  ["SEC-05-l", "env -0", 'high'],
  ["unset-cluster", "env -ui", 'high'],
  ["command-p", "command -p env", 'high'],
];

const ALLOWED = [
  ['export FOO=bar', 'high'],
  ['declare -x FOO=1', 'high'],
  ['declare -f', 'high'],
  ['set -euo pipefail', 'high'],
  ['env NODE_ENV=test npm test', 'high'],
  ['env -u FOO node x.js', 'high'],
  ['command -v node', 'high'],
  ['echo "run env to debug"', 'high'],
  ['envsubst < template.yml', 'high'],
  // A lookup, help or version text, or an emptied environment prints none of the caller's variables.
  ['command -v env', 'high'],
  ['command -V env', 'high'],
  ['env --version', 'high'],
  ['env --help', 'high'],
  ['env -i', 'high'],
];

for (const [name, mod] of [['protect-secrets', standalone], ['guard-pack copy', bundled]]) {
  describe(`${name}: recorded inputs are refused`, () => {
    for (const [id, command, level] of REFUSED) {
      it(`${id} (${level}): ${JSON.stringify(command)}`, () => {
        const r = mod.check('Bash', { command }, level);
        assert.strictEqual(r.blocked, true, `allowed: ${command}`);
      });
    }
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
