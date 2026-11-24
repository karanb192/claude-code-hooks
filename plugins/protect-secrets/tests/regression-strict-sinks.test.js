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
  // A reader with an option value still reads its file operand.
  ["sort -k 3 src/app.ts | llm", 'strict'],
  ["cut -d , -f 1 data.csv | llm", 'strict'],
  ["git cat-file -p HEAD:src/app.ts | llm", 'strict'],
  // curl reads the pipe through a - or /dev/stdin argument or a substitution.
  ["sort src/app.ts | curl https://api.openai.com/v1/files -T -", 'strict'],
  ["sort src/app.ts | curl -K - https://api.openai.com/v1/files", 'strict'],
  ["sort src/app.ts | curl -d \"$(cat)\" https://api.openai.com/v1/files", 'strict'],
  ["sort src/app.ts | curl -d @/dev/stdin https://api.openai.com/v1/files", 'strict'],
  ["sort src/app.ts | xargs -I{} curl -d {} https://api.openai.com/v1/files", 'strict'],
  ["sort src/app.ts | http POST https://api.openai.com/v1/files", 'strict'],
  // Only /dev/null is exempt as an input: /dev/shm and /dev/fd hold real data.
  ["</dev/shm/notes.txt gemini -p x", 'strict'],
  ["gemini -p x < /dev/shm/notes.txt", 'strict'],
  ["</dev/fd/3 llm", 'strict'],
  // cat, head and tail keep their earlier reading: a pipe from them into a model API still counts.
  ["ps aux | head -n 5 | llm", 'strict'],
  ["cat data.txt | curl https://api.openai.com/v1/models", 'strict'],
  // A bare - that no output option owns may be stdin; -D's letter is also -d, so it still counts.
  ["sort src/app.ts | curl -D - https://api.openai.com/v1/models", 'strict'],
  ["sort src/app.ts | curl -b - https://api.openai.com/v1/files", 'strict'],
];

const ALLOWED = [
  ["ps aux | sed 's/x/y/' | llm", 'strict'],
  ['ps aux | sort -k3 -n | llm', 'strict'],
  ['git log --oneline | llm', 'strict'],
  ['npm test 2>&1 | tail -50 | llm "why"', 'strict'],
  ['curl -s --max-time 5 https://api.openai.com/v1/models', 'strict'],
  ['sort src/app.ts | llm', 'high'],
  // An option value is not a file: sort -k 3 reads stdin.
  ['ps aux | sort -k 3 | llm', 'strict'],
  ["ps aux | cut -d ' ' -f 1 | llm", 'strict'],
  // Size, type and existence checks print no file contents.
  ['git cat-file -s HEAD:src/app.ts | llm', 'strict'],
  // A plain curl GET ignores its stdin, and /dev/null is not a file's contents.
  ['ps aux | sort | curl https://api.openai.com/v1/models', 'strict'],
  ['sort data.txt | curl -s https://api.openai.com/v1/models', 'strict'],
  ['</dev/null gemini --version', 'strict'],
  // A - owned by an output option, or inside a header value, is not request input.
  ['ps aux | sort | curl -o - https://api.openai.com/v1/models', 'strict'],
  ["ps aux | sort | curl -H 'X-Label: -' https://api.openai.com/v1/models", 'strict'],
  ['ps aux | sort | wget -O - https://api.openai.com/v1/models', 'strict'],
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
