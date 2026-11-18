#!/usr/bin/env bash
# Seeds the same tiny node --test project as the failing case, but with sum.js
# correct so the suite starts green. Idempotent: every write truncates, so a
# second run leaves the same tree.
set -e

mkdir -p tests

cat > package.json <<'JSON'
{
  "name": "sum-kata",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "test": "node --test"
  }
}
JSON

cat > sum.js <<'JS'
function sum(a, b) {
  return a + b;
}

module.exports = { sum };
JS

cat > tests/sum.test.js <<'JS'
const { test } = require('node:test');
const assert = require('node:assert');
const { sum } = require('../sum.js');

test('adds two positive numbers', () => {
  assert.strictEqual(sum(2, 3), 5);
});

test('cancels a negative and a positive', () => {
  assert.strictEqual(sum(-1, 1), 0);
});
JS
