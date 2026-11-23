#!/usr/bin/env node
/**
 * Regression tests for protect-tests.js: recognising test files
 *
 * Run: node --test plugins/protect-tests/tests/regression-test-files.test.js
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

function shouldAllow(toolName, toolInput, safetyLevel = undefined) {
  const result = checkTool(toolName, toolInput, safetyLevel);
  assert.strictEqual(result.blocked, false, `Expected ALLOWED but was BLOCKED by '${result.id}': ${JSON.stringify(toolInput)}`);
}

// Inputs that once passed because the test file was not recognised: a glob
// in place of the name, a JUnit/NUnit class or .NET test project outside a
// test folder, vitest's .mts, and Rust tests that live inline in src/.
describe('Regression: recognising test files', () => {
  it('denies deleting tests through a glob', () => {
    for (const command of [
      'rm -f src/*.test.js', 'rm *.test.js', 'rm test_*.py', 'rm *_test.go', 'rm src/**/*.spec.ts',
      "git rm '*.test.ts'", 'git rm *.test.js', 'for f in *.test.js; do rm "$f"; done',
      'find . -name "*.test.js" | while read f; do rm "$f"; done',
    ]) shouldBlock('Bash', { command }, 'delete-test');
  });

  it('denies deleting JUnit/NUnit classes and .NET test projects', () => {
    for (const command of [
      'rm src/FooTest.java', 'rm MyApp.Tests/CalculatorTests.cs', 'rm -rf MyApp.Tests',
      "find . -name '*Test.java' -delete", "find . -name '*Tests.cs' -delete",
    ]) shouldBlock('Bash', { command }, 'delete-test');
    shouldBlock('Bash', { command: 'mv src/FooTest.java src/FooTest.java.bak' }, 'rename-test');
  });

  it('denies a skip marker in plural, dotted, .mts and _test.rs test files', () => {
    shouldBlock('Edit', { file_path: 'MyApp.Tests/CalculatorTests.cs', old_string: '    [Test]', new_string: '    [Test]\n    [Ignore]' }, 'skip-test');
    shouldBlock('Edit', { file_path: 'MyApp.Tests/CalculatorTests.cs', old_string: '    [TestMethod]\n', new_string: '    [TestMethod]\n    [Ignore]\n' }, 'skip-test');
    shouldBlock('Edit', { file_path: 'src/math.test.mts', old_string: "it('adds'", new_string: "it.skip('adds'" }, 'skip-test');
    shouldBlock('Edit', { file_path: 'src/FooTests.java', old_string: '    @Test', new_string: '    @Disabled\n    @Test' }, 'skip-test');
    shouldBlock('Edit', { file_path: 'src/math_test.rs', old_string: '#[test]', new_string: '#[test]\n#[ignore]' }, 'skip-test');
  });

  it('denies ignoring a Rust unit test that lives inline in src/', () => {
    shouldBlock('Edit', { file_path: 'src/lib.rs', old_string: '    #[test]', new_string: '    #[test]\n    #[ignore]' }, 'skip-test');
    shouldBlock('Edit', { file_path: 'src/lib.rs', old_string: '    #[test]\n', new_string: '    #[test]\n    #[ignore]\n' }, 'skip-test');
  });

  it('reads the file when the edit itself does not show a test definition', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protect-tests-inline-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'lib.rs'), 'pub fn add(a: i32) -> i32 { a }\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn adds() { assert_eq!(super::add(1), 1); }\n}\n');
    fs.writeFileSync(path.join(dir, 'src', 'main.rs'), 'fn main() {}\n');
    const edit = (file) => checkTool('Edit', { file_path: file, old_string: '    fn adds()', new_string: '    #[ignore]\n    fn adds()' }, undefined, dir);
    assert.strictEqual(edit('src/lib.rs').id, 'skip-test');
    assert.strictEqual(edit('src/main.rs').blocked, false);
  });

  it('still allows ordinary commands and non-test files', () => {
    for (const command of ['rm *.log', 'rm -rf build/*', 'ls *.test.js', 'cat src/FooTest.java', 'rm Latest.java', 'rm src/Contest.java', 'rm -rf dist/*.js', 'git rm docs/spec.md']) {
      shouldAllow('Bash', { command });
    }
    shouldAllow('Edit', { file_path: 'README.md', old_string: 'x', new_string: "it.skip('a')" });
    shouldAllow('Edit', { file_path: 'src/util.py', old_string: 'x', new_string: "pytest.skip('a')" });
  });
});
