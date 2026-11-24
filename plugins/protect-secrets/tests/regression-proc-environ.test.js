#!/usr/bin/env node
/**
 * Regression: process environment read through a deeper, doubled or dotted /proc path, or after cd into /proc
 * Each recorded input below was allowed before this fix. Both the standalone
 * hook and guard-pack's bundled copy must refuse it at its recorded level.
 *
 * Run: node --test plugins/protect-secrets/tests/regression-proc-environ.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const standalone = require('../protect-secrets.js');
const bundled = require('../../guard-pack/lib/protect-secrets.js');

const REFUSED = [
  ["cat /proc/self/task/1/environ", 'high'],
  ["cat /proc//self/environ", 'high'],
  ["cd /proc/self && cat environ", 'high'],
  ["tr \"\\0\" \"\\n\" < /proc/self/./environ", 'high'],
  ["cd /proc && cd self && cat environ", 'high'],
  ["cd /proc/self\ncat environ", 'high'],
  ["cd /proc/self && echo \"$(<environ)\"", 'high'],
  // A cd inside ( ... ) changes only that subshell's directory.
  ["cd /proc/self && (cd /); cat environ", 'high'],
  ["(cd /proc/self; cat environ)", 'high'],
  ["cd -P /proc/self && cat environ", 'high'],
  ["cd /proc/self && cd - && cat environ", 'high'],
  ["builtin cd /proc/self && cat environ", 'high'],
];

const ALLOWED = [
  ['cat /proc/cpuinfo', 'high'],
  ['ls /proc/self/fd', 'high'],
  ['cd /proc && ls', 'high'],
  ['grep -r environ src/', 'high'],
  // echo only prints the word, and a cd to an absolute path leaves /proc.
  ['cd /proc && cd / && echo environ', 'high'],
  ['cd /proc && echo environ', 'high'],
  ['cd /proc && cd / && cat environ', 'high'],
  // The parent shell never entered /proc, and test only checks that the file exists.
  ['(cd /proc/self); cat environ', 'high'],
  ['cd /proc/self && test -e environ', 'high'],
  ['cd /proc/self && [ -f environ ]', 'high'],
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
