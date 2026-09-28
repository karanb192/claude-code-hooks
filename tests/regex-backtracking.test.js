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
const { spawnSync } = require('node:child_process');
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

// Same segment as grep, many quotes, no ".env". A `&&` before the quotes
// hides them from grep-env, which is how the first version of this test passed
// on the exponential regex.
const QUOTE_HEAVY = [
  'grep -c ' + Array.from({ length: 40 }, (_, i) => `'a${i}' "b${i}"`).join(' '),
  'grep -c ' + Array.from({ length: 40 }, (_, i) => `'a${i}'"b${i}"x`).join(''),
  'grep -c "' + 'a '.repeat(200),
];

test('every exported guard regex finishes quote-heavy non-targets in under 50ms', () => {
  const rules = [];
  for (const name of MODULES) {
    const mod = require(path.join(ROOT, 'plugins', name, `${name}.js`));
    for (const rule of rulesOf(mod)) {
      rules.push({ name, id: rule.id, source: rule.regex.source, flags: rule.regex.flags });
    }
  }
  assert.ok(rules.some((r) => r.name === 'protect-secrets' && r.id === 'grep-env'));
  assert.ok(rules.length > 20, `expected the guard rule set, scanned ${rules.length}`);
  // A child so an exponential rule is killed. The child prints each id first.
  const script = `
    const rules = ${JSON.stringify(rules)};
    const inputs = ${JSON.stringify(QUOTE_HEAVY)};
    for (const rule of rules) {
      process.stdout.write(rule.name + ':' + rule.id + '\\n');
      const re = new RegExp(rule.source, rule.flags);
      for (const input of inputs) {
        const start = process.hrtime.bigint();
        re.test(input);
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        if (!(ms < 50)) {
          process.stdout.write('SLOW ' + ms + ' on ' + input.slice(0, 40) + '\\n');
          process.exit(2);
        }
      }
    }
    process.stdout.write('OK\\n');
  `;
  const child = spawnSync(process.execPath, ['-e', script], { timeout: 5000, encoding: 'utf8' });
  if (child.error) assert.fail(`${child.error.code}. Last output:\n${child.stdout}`);
  assert.strictEqual(child.status, 0, child.stdout + child.stderr);
});
