#!/usr/bin/env node
/**
 * Regression: echo and printf of secret-named variables (digits in the name, PASS, PAT, PWD)
 * Each recorded input below was allowed before this fix. Both the standalone
 * hook and guard-pack's bundled copy must refuse it at its recorded level.
 *
 * Run: node --test plugins/protect-secrets/tests/regression-var-names.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const standalone = require('../protect-secrets.js');
const bundled = require('../../guard-pack/lib/protect-secrets.js');

const REFUSED = [
  ["PS-06", "echo $DB_PASS", 'high'],
  ["PS-06.1", "echo $GH_PAT", 'high'],
  ["SEC-06", "echo $S3_SECRET_KEY", 'high'],
  ["SEC-06-b", "echo $K8S_TOKEN", 'high'],
  ["SEC-06-c", "echo $B2_APPLICATION_KEY", 'high'],
  ["SEC-06-d", "echo $R2_ACCESS_KEY_ID", 'high'],
  ["SEC-06-e", "printf \"%s\\n\" \"$S3_SECRET_KEY\"", 'high'],
  ["SEC-08", "echo $DB_PASS", 'high'],
  ["SEC-08-b", "printf \"%s\" \"$DB_PASSWD\"", 'high'],
  ["SEC-08-c", "echo $MYSQL_PWD", 'high'],
  ["SEC-08-d", "echo $GH_PAT", 'high'],
  ["SEC-08-e", "echo $GPG_PASSPHRASE", 'high'],
];

const ALLOWED = [
  ['echo $PWD', 'high'],
  ['echo $OLDPWD', 'high'],
  ['printf "%s" "$PWD"', 'high'],
  ['echo $NODE_ENV', 'high'],
  ['echo $S3_BUCKET', 'high'],
  ['echo $K8S_NAMESPACE', 'high'],
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
