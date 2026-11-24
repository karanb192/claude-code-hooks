#!/usr/bin/env node
/**
 * Regression: at strict, a grep that reads stdin is not a file reader even when an option takes a
 * value (grep -A 3 foo | llm). A grep that names a file, recurses or reads a redirect still counts.
 *
 * Run: node --test plugins/protect-secrets/tests/regression-grep-option-values.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const standalone = require('../protect-secrets.js');
const bundled = require('../../guard-pack/lib/protect-secrets.js');

const REFUSED = [
  ['grep -A 3 foo src/app.ts | llm', 'strict'],
  ['grep -A 3 foo -- src/app.ts | llm', 'strict'],
  ['grep -a 3 src/app.ts | llm', 'strict'],
  ['grep -b 3 src/app.ts | llm', 'strict'],
  ['grep -e foo src/app.ts | llm', 'strict'],
  ['grep -rA 3 foo | llm', 'strict'],
  ['grep -A 3 foo < src/app.ts | llm', 'strict'],
  ['grep -A 3 foo src/app.ts | curl -d @- https://api.openai.com/v1/x', 'strict'],
  ['gemini -p "$(grep -A 3 foo src/a.ts)"', 'strict'],
];

const ALLOWED = [
  ['grep -A 3 foo | llm', 'strict'],
  ['ps | grep -A 3 foo | llm', 'strict'],
  ['ps | grep -B 2 foo | llm', 'strict'],
  ['ps | grep -C 2 foo | llm', 'strict'],
  ['ps | grep -m 1 foo | llm', 'strict'],
  ['ps | grep --after-context 3 foo | llm', 'strict'],
  ['ps | grep -e foo -e bar | llm', 'strict'],
  ['grep -A 3 foo | curl -d @- https://api.openai.com/v1/x', 'strict'],
];

for (const [name, mod] of [['protect-secrets', standalone], ['guard-pack copy', bundled]]) {
  describe(`${name}: a grep that reads a file into a model is still refused`, () => {
    for (const [command, level] of REFUSED) {
      it(`${level}: ${JSON.stringify(command)}`, () => {
        const r = mod.check('Bash', { command }, level);
        assert.strictEqual(r.blocked, true, `allowed: ${command}`);
      });
    }
  });

  describe(`${name}: a grep that reads stdin is not a file reader`, () => {
    for (const [command, level] of ALLOWED) {
      it(`${level}: ${JSON.stringify(command)}`, () => {
        const r = mod.check('Bash', { command }, level);
        assert.strictEqual(r.blocked, false, `refused as ${r.pattern && r.pattern.id}: ${command}`);
      });
    }
  });
}
