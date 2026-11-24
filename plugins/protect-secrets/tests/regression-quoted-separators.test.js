#!/usr/bin/env node
/**
 * Regression: a ; | & or newline inside quotes before a secret variable, and a herestring of one
 * Each recorded input below was allowed before this fix. Both the standalone
 * hook and guard-pack's bundled copy must refuse it at its recorded level.
 *
 * Run: node --test plugins/protect-secrets/tests/regression-quoted-separators.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const standalone = require('../protect-secrets.js');
const bundled = require('../../guard-pack/lib/protect-secrets.js');

const REFUSED = [
  ["SEC-07", "echo \"user=$USER; token=$GITHUB_TOKEN\"", 'high'],
  ["SEC-07-b", "echo \"a|b\" $API_KEY", 'high'],
  ["SEC-07-c", "echo \"A & B: $API_KEY\"", 'high'],
  ["SEC-07-d", "cat <<< \"$SECRET_KEY\"", 'high'],
  ["SEC-16", "gemini -p \"Explain this error.\nMy key is $OPENAI_API_KEY\"", 'high'],
  ["SEC-16-b", "gemini -p \"explain; key is $OPENAI_API_KEY\"", 'high'],
  ["SEC-16-c", "gemini -p \"a & b $OPENAI_API_KEY\"", 'high'],
  ["SEC-16-d", "llm \"x | $GH_PAT\"", 'high'],
  ["escaped-backslash", "cat <<< \"\\\\$SECRET_KEY\"", 'high'],
  ["quoted-separator-then-secret", "echo \"$USER;$API_KEY\"", 'high'],
  // After the herestring, the next command can still run or print the variable.
  ["herestring-then-run", "cat <<< x;$SECRET_KEY", 'high'],
  ["herestring-assign-then-run", "cat <<< x;label=$A_TOKEN;$B_TOKEN", 'high'],
  ["herestring-assign-prefix", "cat <<< x;label=$TOKEN env", 'high'],
];

const ALLOWED = [
  ["cat <<< '$TOKEN'", 'high'],
  ['read -r user pass <<< "$CREDENTIALS"', 'high'],
  ['echo "build; test & deploy" && npm test', 'high'],
  ['gemini -p "Explain this error.\nThe build failed; see the log"', 'high'],
  // A quoted separator ends the variable name: the shell expands $USER, never $USER_KEY.
  ['echo "format $USER;KEY here"', 'high'],
  ['gemini -p "format $USER;KEY here"', 'high'],
  // An escaped dollar sign is literal text, not an expansion.
  ['cat <<< "\\$DEMO_TOKEN"', 'high'],
  ['cat <<< \\$DEMO_TOKEN', 'high'],
  // A command that is only an assignment after the herestring prints nothing.
  ['cat <<< saved\\ text;label=$DEMO_TOKEN', 'high'],
  ['cat <<< x&&label=$DEMO_TOKEN', 'high'],
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
