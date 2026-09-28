#!/usr/bin/env node
/**
 * Every exported guard regex must reject a quote-heavy non-match quickly.
 * The grep-env rule used to take exponential time on quotes that never
 * reached ".env", which wedged the PreToolUse process (issue 67).
 *
 * Run: node --test tests/regex-backtracking.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const MODULES = [
  'protect-secrets',
  'block-dangerous-commands',
  'git-safety',
  'config-guard',
  'protect-tests',
  'subagent-spawn-cap',
  'case-insensitive-guard',
];

function rulesOf(mod) {
  const rules = [];
  for (const value of Object.values(mod)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (item && item.regex instanceof RegExp) rules.push(item);
    }
  }
  return rules;
}

// ~2KB, many quotes, no ".env". The old grep-env rule did not finish this.
function quoteHeavy() {
  return `grep -c 'needle' out.txt && ` +
    Array.from({ length: 40 }, (_, i) => `s = s.replace('old-${i}', "new-${i}")`).join(' && ');
}

test('every exported guard regex finishes a quote-heavy non-target in under 50ms', () => {
  const input = quoteHeavy();
  const seen = [];
  for (const name of MODULES) {
    const mod = require(path.join(ROOT, 'plugins', name, `${name}.js`));
    for (const rule of rulesOf(mod)) {
      seen.push(`${name}:${rule.id}`);
      const re = new RegExp(rule.regex.source, rule.regex.flags);
      const start = process.hrtime.bigint();
      re.test(input);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      assert.ok(ms < 50, `${name}:${rule.id} took ${ms.toFixed(1)}ms`);
    }
  }
  assert.ok(seen.includes('protect-secrets:grep-env'), 'grep-env was not in the scanned rules');
  assert.ok(seen.length > 20, `expected the guard rule set, scanned ${seen.length}`);
});
