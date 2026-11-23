#!/usr/bin/env node
/**
 * Regression tests for protect-tests.js: shell edit scripts
 *
 * Run: node --test plugins/protect-tests/tests/regression-shell-scripts.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkTool } = require('../protect-tests.js');



// Shell edits whose script the hook once could not read: backreferences,
// other delimiters, text commands, perl print, ruby and awk gsub, tee flags,
// and sed output moved back over the test file.
describe('Regression: shell edit scripts that add a marker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protect-tests-scripts-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.mkdirSync(path.join(dir, 'src', 'test', 'java'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests', 'a.test.js'), "it('adds', () => { expect(1+1).toBe(2); });\ntest('subs', () => { expect(2-1).toBe(1); });\n");
  fs.writeFileSync(path.join(dir, 'tests', 'test_math.py'), 'import pytest\n\ndef test_add():\n    assert 1 + 1 == 2\n');
  fs.writeFileSync(path.join(dir, 'src', 'test', 'java', 'FooTest.java'), 'class FooTest {\n  @Test\n  void adds() {}\n}\n');
  fs.writeFileSync(path.join(dir, 'src', 'math.test.js'), "it('adds', () => {});\n");
  fs.writeFileSync(path.join(dir, 'sum.test.js'), 'it("adds numbers", () => {\n  expect(1+1).toBe(2);\n});\n');
  const run = (command) => checkTool('Bash', { command }, undefined, dir);
  const blocked = (command) => assert.strictEqual(run(command).id, 'skip-test', command);
  const allowed = (command) => assert.strictEqual(run(command).blocked, false, command);

  it('denies backreferences that carry the test name into a marker', () => {
    blocked("sed -i -E 's/^(it|test)\\(/\\1.skip(/' tests/a.test.js");
    blocked("sed -i 's/^it/&.skip/' tests/a.test.js");
    blocked("sed -E -i 's/\\b(it|test)\\(/\\1.skip(/g' tests/a.test.js");
    blocked("perl -pi -e 's/^(it|test)\\(/$1.skip(/' tests/a.test.js");
    blocked("sed -i 's/^it/x&/' tests/a.test.js");
    blocked("sed -i '/adds numbers/s/it(/x&/' sum.test.js");
  });

  it('denies substitutions with any delimiter, perl braces, perl -0pi and ruby gsub', () => {
    blocked("sed -i 's%it(%it.skip(%' tests/a.test.js");
    blocked("sed -i 's;it(;it.skip(;' tests/a.test.js");
    blocked("sed -i 's~it(~it.skip(~' tests/a.test.js");
    blocked("perl -pi -e 's{it\\(}{it.skip(}' tests/a.test.js");
    blocked("perl -0pi -e 's/it\\(/it.skip(/' tests/a.test.js");
    blocked("ruby -pi -e 'gsub(/it\\(/, \"it.skip(\")' tests/a.test.js");
  });

  it('denies sed insert and append commands and perl print that write a marker line', () => {
    blocked("sed -i '/def test_add/i @pytest.mark.skip' tests/test_math.py");
    blocked("sed -i '/@Test/a @Disabled' src/test/java/FooTest.java");
    blocked("perl -pi -e 'print \"\\@pytest.mark.skip\\n\" if /def test_add/' tests/test_math.py");
  });

  it('denies tee with flags or several files, and >|', () => {
    blocked("echo \"it.skip('later', () => {})\" | tee --append tests/a.test.js");
    blocked("echo \"it.skip('later', () => {})\" | tee -a -- tests/a.test.js");
    blocked("echo \"it.skip('later', () => {})\" | tee -i tests/a.test.js");
    blocked("echo \"it.skip('later', () => {})\" | tee -a build.log tests/a.test.js");
    blocked("echo \"it.skip('later', () => {})\" >| tests/a.test.js");
  });

  it('denies script output put back over a test file', () => {
    blocked("sed 's/it(/it.skip(/' tests/a.test.js > tmp.js && mv tmp.js tests/a.test.js");
    blocked("sed 's/it(/it.skip(/' tests/a.test.js > tmp.js; cat tmp.js > tests/a.test.js");
    blocked("awk '{sub(/it\\(/,\"it.skip(\")}1' tests/a.test.js > t && mv t tests/a.test.js");
    blocked("perl -pe 's/^it/it.skip/' src/math.test.js > tests/a.test.js");
  });

  it('answers long scripts quickly', () => {
    const start = Date.now();
    allowed(`sed -i 's/${'(ab)'.repeat(2000)}/${'\\1&'.repeat(2000)}/' tests/a.test.js`);
    allowed(`sed -i ${'s/'.repeat(5000)} tests/a.test.js`);
    allowed(`perl -pi -e '${'print "'.repeat(2000)}' tests/a.test.js`);
    assert.ok(Date.now() - start < 1000, `took ${Date.now() - start} ms`);
  });

  it('still allows ordinary edits, removals of skips and previews', () => {
    allowed("sed -i 's/skipLogin/skipAuth/' tests/a.test.js");
    allowed("sed -i 's/it.skip(/it(/' tests/a.test.js");
    allowed("sed -i 's/\\(foo\\)/\\1bar/' tests/a.test.js");
    allowed("sed -i '1i // eslint-disable' tests/a.test.js");
    allowed("ruby -pi -e 'gsub(/foo/, \"bar\")' tests/a.test.js");
    allowed("sed 's/it(/it.skip(/' tests/a.test.js > /tmp/preview.js");
    allowed('npm test 2>&1 | tee -a test.log');
  });
});
