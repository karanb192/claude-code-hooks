#!/usr/bin/env node
/**
 * Regression: strict level: file contents reaching a model CLI or API through more readers, a leading redirect, a substitution or a multi-line prompt
 * Each recorded input below was allowed before this fix. Both the standalone
 * hook and guard-pack's bundled copy must refuse it at its recorded level.
 *
 * Run: node --test plugins/protect-secrets/tests/regression-strict-sinks.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const standalone = require('../protect-secrets.js');
const bundled = require('../../guard-pack/lib/protect-secrets.js');

const REFUSED = [
  ["sed -n p src/app.ts | gemini -p \"summarize\"", 'strict'],
  ["sort src/app.ts | llm", 'strict'],
  ["awk 1 src/app.ts | llm", 'strict'],
  ["jq . data.json | llm", 'strict'],
  ["git log -p | llm", 'strict'],
  ["gemini -p \"$(<src/app.ts)\"", 'strict'],
  ["gemini -p \"$(sed -n p src/app.ts)\"", 'strict'],
  ["<src/app.ts gemini -p x", 'strict'],
  ["gemini -p \"a\nb\" < src/app.ts", 'strict'],
  ["sed -n p src/app.ts | curl https://api.openai.com/v1/chat/completions -d @-", 'strict'],
  ["curl https://api.openai.com/v1/files -sT src/app.ts", 'strict'],
];

const ALLOWED = [
  ["ps aux | sed 's/x/y/' | llm", 'strict'],
  ['ps aux | sort -k3 -n | llm', 'strict'],
  ['git log --oneline | llm', 'strict'],
  ['npm test 2>&1 | tail -50 | llm "why"', 'strict'],
  ['curl -s --max-time 5 https://api.openai.com/v1/models', 'strict'],
  ['sort src/app.ts | llm', 'high'],
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
