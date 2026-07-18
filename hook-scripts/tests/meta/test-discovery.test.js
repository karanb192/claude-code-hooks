#!/usr/bin/env node
/**
 * Meta: test-discovery guard.
 *
 * Run: node --test hook-scripts/tests/meta/test-discovery.test.js
 * Or:  npm test
 *
 * The `npm test` glob — "hook-scripts/tests/**\/*.test.js plugins/**\/tests/*.test.js" —
 * only matches ONE directory level deep under a POSIX shell (no globstar). A test
 * file added at an unexpected depth would be silently skipped while the suite still
 * reports green. This guard fails if any *.test.js sits somewhere the glob can't reach,
 * so coverage loss surfaces instead of hiding behind a green run.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function walk(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.name.endsWith('.test.js')) acc.push(path.relative(ROOT, full).split(path.sep).join('/'));
  }
  return acc;
}

// The two path shapes the npm test glob matches under a POSIX shell (no globstar):
//   hook-scripts/tests/<subdir>/<file>.test.js
//   plugins/<name>/tests/<file>.test.js
const HOOK_SHAPE = /^hook-scripts\/tests\/[^/]+\/[^/]+\.test\.js$/;
const PLUGIN_SHAPE = /^plugins\/[^/]+\/tests\/[^/]+\.test\.js$/;

test('every *.test.js is reachable by the npm test glob', () => {
  const all = [
    ...walk(path.join(ROOT, 'hook-scripts', 'tests')),
    ...walk(path.join(ROOT, 'plugins')),
  ];

  assert.ok(all.length > 0, 'expected to discover at least one test file');

  const orphans = all.filter((p) => !HOOK_SHAPE.test(p) && !PLUGIN_SHAPE.test(p));
  assert.deepStrictEqual(
    orphans,
    [],
    `these *.test.js files sit at a depth the npm test glob will silently skip:\n  ${orphans.join('\n  ')}`
  );
});
