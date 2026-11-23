#!/usr/bin/env node
/**
 * Regression tests for protect-tests.js: Edit judged on the resulting file
 *
 * Run: node --test plugins/protect-tests/tests/regression-edit-result.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkTool } = require('../protect-tests.js');

function shouldBlock(toolName, toolInput, expectedId = null, safetyLevel = undefined) {
  const result = checkTool(toolName, toolInput, safetyLevel);
  assert.strictEqual(result.blocked, true, `Expected BLOCKED but was ALLOWED: ${JSON.stringify(toolInput)}`);
  if (expectedId) assert.strictEqual(result.id, expectedId, `Expected id '${expectedId}' but got '${result.id}'`);
}


// An edit whose replaced span starts after the test function's name can still
// write a marker into the file. These inputs once passed.
describe('Regression: markers completed by the text around an edit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protect-tests-edit-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests', 'a.test.js'), "it('adds', () => { expect(1+1).toBe(2); });\ntest('subs', () => { expect(2-1).toBe(1); });\n");
  fs.writeFileSync(path.join(dir, 'sum.test.js'), "it(\"adds numbers\", () => {\n  expect(1+1).toBe(2);\n});\n");
  const check = (tool, input) => checkTool(tool, input, undefined, dir);

  it('denies an Edit that inserts .skip right after the test name', () => {
    assert.strictEqual(check('Edit', { file_path: 'tests/a.test.js', old_string: "('adds'", new_string: ".skip('adds'" }).id, 'skip-test');
    assert.strictEqual(check('Edit', { file_path: 'tests/a.test.js', old_string: "t('subs'", new_string: "t.skip('subs'" }).id, 'skip-test');
    assert.strictEqual(check('Edit', { file_path: 'sum.test.js', old_string: '("adds numbers"', new_string: '.skip("adds numbers"' }).id, 'skip-test');
  });

  it('denies a MultiEdit that builds the marker across two edits', () => {
    const edits = [{ old_string: "it('adds'", new_string: "it.sk('adds'" }, { old_string: '.sk(', new_string: '.skip(' }];
    assert.strictEqual(check('MultiEdit', { file_path: 'tests/a.test.js', edits }).id, 'skip-test');
  });

  it('honours replace_all when it judges the resulting file', () => {
    assert.strictEqual(check('Edit', { file_path: 'tests/a.test.js', old_string: "('", new_string: ".skip('", replace_all: true }).id, 'skip-test');
  });

  it('falls back to the test-name prefixes when the file cannot be read', () => {
    shouldBlock('Edit', { file_path: '/nonexistent/a.test.js', old_string: "('adds'", new_string: ".skip('adds'" }, 'skip-test');
    shouldBlock('Edit', { file_path: '/nonexistent/a.test.js', old_string: "t('subs'", new_string: "t.skip('subs'" }, 'skip-test');
  });

  it('still allows edits that change a test without disabling it', () => {
    assert.strictEqual(check('Edit', { file_path: 'tests/a.test.js', old_string: "('adds'", new_string: "('adds two numbers'" }).blocked, false);
    assert.strictEqual(check('Edit', { file_path: 'sum.test.js', old_string: 'toBe(2)', new_string: 'toBe(2); // .skip( is not used here' }).blocked, false);
    assert.strictEqual(check('MultiEdit', { file_path: 'tests/a.test.js', edits: [{ old_string: 'toBe(2)', new_string: 'toEqual(2)' }] }).blocked, false);
  });
});

describe('Regression: the final file decides', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protect-tests-final-'));
  fs.writeFileSync(path.join(dir, 'a.test.js'), "it('adds', () => {});\n");
  fs.writeFileSync(path.join(dir, 'big.test.js'), 'x'.repeat(1024 * 1024) + "\nit('adds', () => {});\n");

  it('allows a MultiEdit that adds a marker and removes it again', () => {
    const edits = [{ old_string: "it('adds'", new_string: "it.skip('adds'" }, { old_string: "it.skip('adds'", new_string: "it('adds'" }];
    assert.strictEqual(checkTool('MultiEdit', { file_path: 'a.test.js', edits }, undefined, dir).blocked, false);
  });

  it('does not build an oversized replay for replace_all', () => {
    const start = Date.now();
    const r = checkTool('Edit', { file_path: 'big.test.js', old_string: 'x', new_string: 'y'.repeat(64), replace_all: true }, undefined, dir);
    assert.strictEqual(r.blocked, false);
    assert.ok(Date.now() - start < 2000, `took ${Date.now() - start} ms`);
  });
});
