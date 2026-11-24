#!/usr/bin/env node
/**
 * Regression: at strict, a grep shown to read only stdin is not a file reader even when an option
 * takes a value (grep -A 3 foo | llm). A grep that names a file, may recurse, or reads a redirect, or
 * whose options are not all known and spelled out, still counts.
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
  // An abbreviated long option, or a value the command does not spell out, may make grep recurse.
  ['grep --recur -A 3 foo | llm', 'strict'],
  ['grep --recursiv -A 3 foo | llm', 'strict'],
  ['grep --dir=recurse -A 3 foo | llm', 'strict'],
  ['grep --directories recurse -A 3 foo | llm', 'strict'],
  ['grep --directories $MODE -A 3 foo | llm', 'strict'],
  ['grep -d $M -A 3 foo | llm', 'strict'],
  ['grep -A $N foo | llm', 'strict'],
  ['grep -A 3 foo - src/a.ts | llm', 'strict'],
  // A glob or brace can expand to file operands after the pattern.
  ['ps | env grep -A 3 foo * | llm', 'strict'],
  ['env grep -A 3 *.ts | llm', 'strict'],
  ['grep -A 3 foo *.ts | llm', 'strict'],
  ['env grep -A 3 {foo,src/app.ts} | llm', 'strict'],
  ['grep -m 1 foo ? | llm', 'strict'],
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
  // An explicit - is stdin, and env that only sets variables runs the same grep.
  ['ps | grep -A 3 foo - | llm', 'strict'],
  ['ps | env grep -A 3 foo | llm', 'strict'],
  ['ps | env LC_ALL=C grep -A 3 foo | llm', 'strict'],
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
