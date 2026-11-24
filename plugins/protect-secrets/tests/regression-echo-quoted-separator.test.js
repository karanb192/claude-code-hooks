#!/usr/bin/env node
/**
 * Regression: a quoted ; | or & after a variable ends its name, so echo "$USER;TOKEN" prints $USER
 * and the word TOKEN, not a variable named USER_TOKEN, and is allowed.
 *
 * Run: node --test plugins/protect-secrets/tests/regression-echo-quoted-separator.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const standalone = require('../protect-secrets.js');
const bundled = require('../../guard-pack/lib/protect-secrets.js');

const REFUSED = [
  ['echo "$USER;$API_KEY"', 'high'],
  ['echo "user=$USER; token=$GITHUB_TOKEN"', 'high'],
  ['echo "$SECRET_KEY;"', 'high'],
  ['echo "${SECRET_KEY};x"', 'high'],
  ['echo "a;b" $API_KEY', 'high'],
  ['echo "$(true;echo $SECRET_KEY)"', 'high'],
  [String.raw`echo $USER\;TOKEN`, 'high'],
  ['printf "%s;%s" "$USER" "$GH_TOKEN"', 'high'],
];

const ALLOWED = [
  ['echo "$USER;TOKEN"', 'high'],
  ['echo "$USER|TOKEN"', 'high'],
  ['echo "$USER&KEY"', 'high'],
  ['echo "$HOME;SECRET"', 'high'],
  ['printf "$USER;TOKEN"', 'high'],
  ["echo '$USER;TOKEN'", 'high'],
];

for (const [name, mod] of [['protect-secrets', standalone], ['guard-pack copy', bundled]]) {
  describe(`${name}: a secret variable print is still refused`, () => {
    for (const [command, level] of REFUSED) {
      it(`${level}: ${JSON.stringify(command)}`, () => {
        const r = mod.check('Bash', { command }, level);
        assert.strictEqual(r.blocked, true, `allowed: ${command}`);
      });
    }
  });

  describe(`${name}: a quoted separator does not join two words into one variable`, () => {
    for (const [command, level] of ALLOWED) {
      it(`${level}: ${JSON.stringify(command)}`, () => {
        const r = mod.check('Bash', { command }, level);
        assert.strictEqual(r.blocked, false, `refused as ${r.pattern && r.pattern.id}: ${command}`);
      });
    }
  });
}
