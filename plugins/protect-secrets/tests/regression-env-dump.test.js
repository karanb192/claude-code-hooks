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
  ["export -p", 'high'],
  ["env -0", 'high'],
  ["cd /app\nenv", 'high'],
  ["env\nls", 'high'],
  ["env > /tmp/e.txt", 'high'],
  ["env 2>&1", 'high'],
  ["/usr/bin/env", 'high'],
  ["command env", 'high'],
  ["if true; then env; fi", 'high'],
  ["{ env; }", 'high'],
  ["echo \"`env`\"", 'high'],
  ["export -p", 'high'],
  ["declare -p", 'high'],
  ["env -0", 'high'],
  ["env -ui", 'high'],
  ["command -p env", 'high'],
  // A wrapper's option value is not the command it runs.
  ["exec -a NAME env", 'high'],
  ["nice -n 5 env", 'high'],
  ["sudo -u root env", 'high'],
  ["sudo --user root env", 'high'],
  ["timeout 5 env", 'high'],
  ["timeout -s KILL 5 env", 'high'],
  ["stdbuf -o0 env", 'high'],
  ["stdbuf -o 0 env", 'high'],
  ["time -p env", 'high'],
  // env runs the next word, which can be env again.
  ["env -u FOO env", 'high'],
  ["env FOO=1 env", 'high'],
  // Still refused on purpose: main refuses every printenv by name, and this branch keeps that.
  ["command -v printenv", 'high'],
  ["env -i printenv", 'high'],
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
  // The same wrappers around a command that prints no environment.
  ['exec -a NAME node server.js', 'high'],
  ['nice -n 5 make', 'high'],
  ['sudo -u root ls', 'high'],
  ['timeout 5 npm test', 'high'],
  ['stdbuf -o0 tail -f app.log', 'high'],
  ['env -i env', 'high'],
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

  describe(`${name}: neighbouring commands stay allowed`, () => {
    for (const [command, level] of ALLOWED) {
      it(`${level}: ${JSON.stringify(command)}`, () => {
        const r = mod.check('Bash', { command }, level);
        assert.strictEqual(r.blocked, false, `refused as ${r.pattern && r.pattern.id}: ${command}`);
      });
    }
  });
}
