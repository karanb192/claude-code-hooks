#!/usr/bin/env node
/**
 * Regression: code given to an interpreter on the command line or in a heredoc that names a
 * protected file in a string literal, and perl or ruby -n/-p over a protected file, are refused.
 *
 * Run: node --test plugins/protect-secrets/tests/regression-inline-code.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const standalone = require('../protect-secrets.js');
const bundled = require('../../guard-pack/lib/protect-secrets.js');

const REFUSED = [
  [`python3 -c "print(open('.env').read())"`, 'high'],
  [`python3 -c 'print(open(".env").read())'`, 'high'],
  [`python -c 'import os;print(open(os.path.expanduser("~/.aws/credentials")).read())'`, 'high'],
  [`sudo python3 -c "print(open('/root/.ssh/id_rsa').read())"`, 'high'],
  [`node -e "console.log(require('fs').readFileSync('.env','utf8'))"`, 'high'],
  [`node -p "require('fs').readFileSync('.npmrc','utf8')"`, 'high'],
  [`ruby -e 'puts File.read(".env")'`, 'high'],
  [`perl -e 'open F, "<.env"; print <F>'`, 'high'],
  [`php -r 'echo file_get_contents(".env");'`, 'high'],
  [`python3 - <<'EOF'\nprint(open(".env").read())\nEOF`, 'high'],
  ['perl -ne print .env', 'high'],
  [`perl -pe 's/x/y/' .npmrc`, 'high'],
  [`ruby -ne 'puts $_' .env`, 'high'],
];

const ALLOWED = [
  [`python3 -c "import json;print(json.load(open('package.json')))"`, 'high'],
  [`node -e "console.log(1+1)"`, 'high'],
  [`python3 -c "print('.env.example')"`, 'high'],
  ['python3 manage.py runserver', 'high'],
  ['python3 -m json.tool data.json', 'high'],
  [`ruby -e 'puts 1'`, 'high'],
  [`perl -e 'print 1' data.txt`, 'high'],
  ['perl -ne print data.txt', 'high'],
];

for (const [name, mod] of [['protect-secrets', standalone], ['guard-pack copy', bundled]]) {
  describe(`${name}: interpreter code that opens a protected file is refused`, () => {
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
