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
  // Wrapper, option and path runs that never complete a match.
  'curl x | ' + 'sudo -n '.repeat(60) + 'harmless',
  'git ' + '-C x '.repeat(80) + 'status',
  'git ' + '-C "a" '.repeat(80) + 'status',
  'git ' + '--git-dir=.git '.repeat(80) + 'status',
  'curl x | sudo ' + '-u x '.repeat(80) + 'harmless',
  'curl x | sudo ' + '-ux '.repeat(80) + 'harmless',
  'curl x | env ' + '-uNAME '.repeat(80) + 'harmless',
  'curl x ' + '| sudo env '.repeat(80) + 'harmless',
  'curl x | env ' + '-u x A=1 '.repeat(60) + 'harmless',
  'git push ' + '--push-option="a;b" '.repeat(80) + 'origin feat',
  'find tests' + ' -print'.repeat(60) + ' | xargs' + ' -n 1'.repeat(60) + ' echo',
  'rm -rf ' + 'a/'.repeat(300) + 'b',
  'mv ' + 'x '.repeat(300) + 'y',
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

// Rules that live in private regexes or code (protect-tests' delete checks,
// the pipe-to-shell walker) are reached only through the exported checker.
test('every guard checker finishes the same inputs in under 50ms', () => {
  const script = `
    const path = require('path');
    const inputs = ${JSON.stringify(QUOTE_HEAVY)};
    const calls = {
      'protect-secrets': (m, s) => m.check('Bash', { command: s }, 'strict'),
      'block-dangerous-commands': (m, s) => m.checkCommand(s, 'strict'),
      'git-safety': (m, s) => m.checkCommand(s, 'feature', 'strict'),
      'protect-tests': (m, s) => m.checkTool('Bash', { command: s }, 'strict'),
    };
    for (const [name, call] of Object.entries(calls)) {
      const mod = require(path.join(${JSON.stringify(ROOT)}, 'plugins', name, name + '.js'));
      process.stdout.write(name + '\\n');
      // Warm up so one-time regex compilation is not counted as backtracking.
      call(mod, 'echo warm');
      for (const input of inputs) {
        const start = process.hrtime.bigint();
        call(mod, input);
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
