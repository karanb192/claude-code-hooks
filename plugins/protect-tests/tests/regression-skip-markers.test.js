#!/usr/bin/env node
/**
 * Regression tests for protect-tests.js: skip markers across frameworks
 *
 * Run: node --test plugins/protect-tests/tests/regression-skip-markers.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

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

// Skip spellings each framework documents that the marker list once missed.
describe('Regression: skip markers across frameworks', () => {
  const skips = [
    ['spec/calc_spec.rb', "  it 'adds' do", "  xit 'adds' do"],
    ['spec/math_spec.rb', '    expect', "    skip 'flaky'\n    expect"],
    ['tests/test_calc.py', '    def test_add(self):', '    @unittest.expectedFailure\n    def test_add(self):'],
    ['tests/test_calc.py', '    def test_add(self):\n', '    def test_add(self):\n        self.skipTest("flaky")\n'],
    ['tests/test_calc.py', 'import pytest\n', 'import pytest\npytestmark = pytest.mark.skip(reason="wip")\n'],
    ['tests/test_math.py', 'def test_add', 'pytestmark = pytest.mark.skip\n\ndef test_add'],
    ['tests/test_math.py', '    assert', '    pytest.xfail("flaky")\n    assert'],
    ['tests/test_math.py', 'def test_add', '@mark.skip\ndef test_add'],
    ['sum.test.js', 'it("adds numbers"', 'it.skipIf(true)("adds numbers"'],
    ['sum.test.js', 'it("adds numbers"', 'it.skip.each([[1]])("adds numbers"'],
    ['tests/a.test.js', "it('adds'", "it.todo('adds'"],
    ['tests/a.test.js', "test('subs'", "test.concurrent.skip('subs'"],
    ['tests/a.test.js', "it('adds'", "it\n.skip('adds'"],
    ['calc_test.go', 'func TestAdd(t *testing.T) {\n', 'func TestAdd(t *testing.T) {\n\tt.Skipf("flaky %d", 1)\n'],
    ['src/test/java/CalcTest.java', '  @Test\n  public void adds', '  @Test(enabled = false)\n  public void adds'],
    ['src/test/java/CalcTest.java', '  @Test\n', '  @Test\n  @DisabledIf("true")\n'],
    ['tests/CalcTests.cs', '    [Test]\n', '    [Test]\n    [Ignore("flaky")]\n'],
    ['tests/CalcTests.cs', '    [Fact]\n', '    [Fact(Skip = "flaky")]\n'],
    ['tests/calc.rs', '#[test]\n', '#[test]\n#[ignore = "slow"]\n'],
  ];
  for (const [file_path, old_string, new_string] of skips) {
    it(`denies ${new_string.trim().split('\n').find(l => !old_string.includes(l.trim())) || new_string} in ${file_path}`, () =>
      shouldBlock('Edit', { file_path, old_string, new_string }, 'skip-test'));
  }

  it('still allows test names and code that only mention skipping', () => {
    shouldAllow('Edit', { file_path: 'tests/a.test.js', old_string: 'x', new_string: "it('skips empty input', () => { expect(skip(1)).toBe(0); });" });
    shouldAllow('Edit', { file_path: 'spec/orders_spec.rb', old_string: 'x', new_string: "describe 'pending orders' do" });
    shouldAllow('Edit', { file_path: 'tests/test_x.py', old_string: 'x', new_string: 'def test_skip_list():\n    assert skipped == []' });
    shouldAllow('Edit', { file_path: 'calc_test.go', old_string: 'x', new_string: 'if testing.Short() { return }' });
  });
});

describe('Regression: markers match whole names in their own language', () => {
  it('does not treat a helper called skip or a custom pytest mark as a marker', () => {
    shouldAllow('Edit', { file_path: 'calc.test.js', old_string: 'tick(1)', new_string: 'skip(1)' });
    shouldAllow('Edit', { file_path: 'tests/test_x.py', old_string: 'x', new_string: '@pytest.mark.skiplint' });
    shouldAllow('Edit', { file_path: 'tests/test_x.py', old_string: 'x', new_string: '@mark.skipped_slow' });
  });

  it('still denies the RSpec and pytest forms', () => {
    shouldBlock('Edit', { file_path: 'spec/a_spec.rb', old_string: '    expect', new_string: '    pending "wip"\n    expect' }, 'skip-test');
    shouldBlock('Edit', { file_path: 'tests/test_x.py', old_string: 'x', new_string: '@pytest.mark.skip(reason="x")' }, 'skip-test');
  });
});
