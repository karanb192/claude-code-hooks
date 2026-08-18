#!/usr/bin/env node
/**
 * Tests for protect-tests.js
 *
 * Run: node --test plugins/protect-tests/tests/protect-tests.test.js
 * Or:  npm test
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const { checkTool } = require('../protect-tests.js');

const SCRIPT_PATH = path.join(__dirname, '../protect-tests.js');

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

function shouldBlock(toolName, toolInput, expectedId = null, safetyLevel = undefined) {
  const result = checkTool(toolName, toolInput, safetyLevel);
  assert.strictEqual(result.blocked, true, `Expected BLOCKED but was ALLOWED: ${JSON.stringify(toolInput)}`);
  if (expectedId) {
    assert.strictEqual(result.id, expectedId, `Expected id '${expectedId}' but got '${result.id}'`);
  }
}

function shouldAllow(toolName, toolInput, safetyLevel = undefined) {
  const result = checkTool(toolName, toolInput, safetyLevel);
  assert.strictEqual(result.blocked, false, `Expected ALLOWED but was BLOCKED by '${result.id}': ${JSON.stringify(toolInput)}`);
}

// Spawns the real script. HOOK_SAFETY_LEVEL is stripped from the inherited env
// so the ambient shell can never flip a test; pass it via extraEnv to set it.
function runHook(payload, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.HOOK_SAFETY_LEVEL;
    const child = spawn('node', [SCRIPT_PATH], { env: { ...env, ...extraEnv } });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', () => {
      try { resolve(JSON.parse(stdout.trim())); }
      catch (e) { reject(new Error(`Failed to parse output: ${stdout}`)); }
    });
    child.stdin.write(JSON.stringify({ session_id: 'test', cwd: '/tmp', permission_mode: 'default', ...payload }));
    child.stdin.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit Tests - deleting tests via Bash
// ─────────────────────────────────────────────────────────────────────────────

describe('Bash: deleting test files', () => {
  it('blocks rm of a pytest file', () => shouldBlock('Bash', { command: 'rm test_auth.py' }, 'delete-test'));
  it('blocks rm -rf of a tests directory', () => shouldBlock('Bash', { command: 'rm -rf tests/' }, 'delete-test'));
  it('blocks rm of a jest spec', () => shouldBlock('Bash', { command: 'rm src/auth.test.ts' }, 'delete-test'));
  it('blocks rm of a go test', () => shouldBlock('Bash', { command: 'rm handler_test.go' }, 'delete-test'));
  it('blocks git rm of a test file', () => shouldBlock('Bash', { command: 'git rm test_payment.py' }, 'delete-test'));
  it('blocks rm of __tests__ dir', () => shouldBlock('Bash', { command: 'rm -r src/__tests__/' }, 'delete-test'));
});

describe('Bash: renaming tests away', () => {
  it('blocks mv test to .bak', () => shouldBlock('Bash', { command: 'mv test_auth.py test_auth.py.bak' }, 'rename-test'));
  it('blocks mv test to .disabled', () => shouldBlock('Bash', { command: 'mv auth.test.ts auth.test.ts.disabled' }, 'rename-test'));
});

describe('Bash: legitimate commands are allowed', () => {
  it('allows running the tests', () => shouldAllow('Bash', { command: 'pytest tests/' }));
  it('allows npm test', () => shouldAllow('Bash', { command: 'npm test' }));
  it('allows rm of non-test artifacts', () => shouldAllow('Bash', { command: 'rm -rf node_modules' }));
  it('allows rm of build output', () => shouldAllow('Bash', { command: 'rm -rf dist build .pytest_cache' }));
  it('allows creating a test dir', () => shouldAllow('Bash', { command: 'mkdir -p tests/unit' }));
  it('allows go test', () => shouldAllow('Bash', { command: 'go test ./...' }));
  it('allows refactor rename to another test name', () => shouldAllow('Bash', { command: 'mv test_old.py test_new.py' }));
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit Tests - disabling tests via Edit
// ─────────────────────────────────────────────────────────────────────────────

describe('Edit: disabling tests in place', () => {
  it('blocks adding @pytest.mark.skip', () => shouldBlock('Edit', {
    file_path: 'tests/test_auth.py',
    old_string: 'def test_login():',
    new_string: '@pytest.mark.skip\ndef test_login():'
  }, 'skip-test'));

  it('blocks adding @pytest.mark.xfail', () => shouldBlock('Edit', {
    file_path: 'test_math.py',
    old_string: 'def test_add():',
    new_string: '@pytest.mark.xfail\ndef test_add():'
  }, 'skip-test'));

  it('blocks converting it() to it.skip()', () => shouldBlock('Edit', {
    file_path: 'src/auth.test.js',
    old_string: "it('logs in', () => {",
    new_string: "it.skip('logs in', () => {"
  }, 'skip-test'));

  it('blocks converting it() to xit()', () => shouldBlock('Edit', {
    file_path: 'src/auth.spec.ts',
    old_string: "it('logs in', () => {",
    new_string: "xit('logs in', () => {"
  }, 'skip-test'));

  it('blocks adding t.Skip in Go', () => shouldBlock('Edit', {
    file_path: 'handler_test.go',
    old_string: 'func TestHandler(t *testing.T) {',
    new_string: 'func TestHandler(t *testing.T) {\n\tt.Skip("flaky")'
  }, 'skip-test'));

  it('blocks adding @Disabled in JUnit', () => shouldBlock('Edit', {
    file_path: 'src/AuthTest.java',
    old_string: '  @Test',
    new_string: '  @Disabled\n  @Test'
  }, 'skip-test'));
});

describe('Edit: legitimate edits are allowed', () => {
  it('allows editing a test body', () => shouldAllow('Edit', {
    file_path: 'tests/test_auth.py',
    old_string: 'assert login() == True',
    new_string: 'assert login() is True'
  }));
  it('allows editing non-test files even with skip-looking text', () => shouldAllow('Edit', {
    file_path: 'src/app.py',
    old_string: 'x = 1',
    new_string: 'x = 2  # @pytest.mark.skip in a comment, not a test file'
  }));
  it('allows removing a skip marker (re-enabling a test)', () => shouldAllow('Edit', {
    file_path: 'tests/test_auth.py',
    old_string: '@pytest.mark.skip\ndef test_login():',
    new_string: 'def test_login():'
  }));
});

// ─────────────────────────────────────────────────────────────────────────────
// Safety levels
// ─────────────────────────────────────────────────────────────────────────────

describe('Safety levels', () => {
  it('critical level still blocks deletion', () => shouldBlock('Bash', { command: 'rm test_x.py' }, 'delete-test', 'critical'));
  it('critical level does NOT block skip markers', () => shouldAllow('Edit', {
    file_path: 'tests/test_auth.py', old_string: 'def test_a():', new_string: '@pytest.mark.skip\ndef test_a():'
  }, 'critical'));
  it('strict level blocks a Write of an already-skipped test', () => shouldBlock('Write', {
    file_path: 'tests/test_new.py', content: '@pytest.mark.skip\ndef test_new():\n    assert True'
  }, 'write-skipped-test', 'strict'));
  it('high level does NOT block that Write', () => shouldAllow('Write', {
    file_path: 'tests/test_new.py', content: '@pytest.mark.skip\ndef test_new():\n    assert True'
  }, 'high'));
});

// ─────────────────────────────────────────────────────────────────────────────
// HOOK_SAFETY_LEVEL env override - through the real spawned script, since the
// level is resolved once at load time
// ─────────────────────────────────────────────────────────────────────────────

describe('HOOK_SAFETY_LEVEL env override', () => {
  const skipEdit = {
    tool_name: 'Edit',
    tool_input: { file_path: 'tests/test_auth.py', old_string: 'def test_a():', new_string: '@pytest.mark.skip\ndef test_a():' }
  };
  const skippedWrite = {
    tool_name: 'Write',
    tool_input: { file_path: 'tests/test_new.py', content: '@pytest.mark.skip\ndef test_new():\n    assert True' }
  };

  it('env unset → default high: skip markers deny', async () => {
    const out = await runHook(skipEdit);
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  });
  it('env unset → default high: an already-skipped Write passes', async () => {
    const out = await runHook(skippedWrite);
    assert.deepStrictEqual(out, {});
  });
  it('HOOK_SAFETY_LEVEL=strict blocks an already-skipped Write', async () => {
    const out = await runHook(skippedWrite, { HOOK_SAFETY_LEVEL: 'strict' });
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  });
  it('HOOK_SAFETY_LEVEL=critical stops blocking skip markers', async () => {
    const out = await runHook(skipEdit, { HOOK_SAFETY_LEVEL: 'critical' });
    assert.deepStrictEqual(out, {});
  });
  it('HOOK_SAFETY_LEVEL=critical still blocks test deletion', async () => {
    const out = await runHook({ tool_name: 'Bash', tool_input: { command: 'rm test_x.py' } }, { HOOK_SAFETY_LEVEL: 'critical' });
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  });
  it('invalid value falls back to the high default', async () => {
    const w = await runHook(skippedWrite, { HOOK_SAFETY_LEVEL: 'bogus' });
    assert.deepStrictEqual(w, {}, 'bogus must not behave like strict');
    const e = await runHook(skipEdit, { HOOK_SAFETY_LEVEL: 'bogus' });
    assert.strictEqual(e.hookSpecificOutput.permissionDecision, 'deny', 'bogus must not behave like critical');
  });
  it('hostile value (an Object.prototype key) also falls back to high', async () => {
    const out = await runHook(skipEdit, { HOOK_SAFETY_LEVEL: 'toString' });
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration - real stdin/stdout through the script
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration (stdin/stdout)', () => {
  it('emits a deny decision for test deletion', async () => {
    const out = await runHook({ tool_name: 'Bash', tool_input: { command: 'rm -rf tests/' } });
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  });
  it('emits {} for a normal command', async () => {
    const out = await runHook({ tool_name: 'Bash', tool_input: { command: 'pytest -q' } });
    assert.deepStrictEqual(out, {});
  });
  it('fails open on malformed input', async () => {
    const out = await runHook({ tool_name: 'Bash' });
    assert.deepStrictEqual(out, {});
  });
});
