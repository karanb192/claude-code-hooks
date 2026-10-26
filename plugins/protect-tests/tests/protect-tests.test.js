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
const fs = require('node:fs');
const os = require('node:os');
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
  it('blocks rm -rf of a tests directory without a trailing slash', () =>
    shouldBlock('Bash', { command: 'rm -rf tests' }, 'delete-test'));
  it('blocks rm -rf of a nested spec directory without a slash', () =>
    shouldBlock('Bash', { command: 'rm -rf ./src/spec' }, 'delete-test'));
  it('blocks rm of a quoted test directory', () => shouldBlock('Bash', { command: 'rm -r "test"' }, 'delete-test'));
  it('blocks find -delete on a test directory', () => shouldBlock('Bash', { command: 'find tests -delete' }, 'delete-test'));
  it('blocks find -exec rm on test files', () =>
    shouldBlock('Bash', { command: "find . -name '*_test.py' -exec rm {} +" }, 'delete-test'));
  it('blocks moving tests into /tmp', () => shouldBlock('Bash', { command: 'mv tests /tmp/' }, 'delete-test'));
  it('blocks moving a test file into the trash', () =>
    shouldBlock('Bash', { command: 'mv src/auth.test.ts ~/.Trash/' }, 'delete-test'));
  it('allows a test run next to an unrelated rm', () =>
    shouldAllow('Bash', { command: 'rm -rf node_modules && npm test' }));
  it('allows rm of a test-results folder', () => shouldAllow('Bash', { command: 'rm -rf test-results coverage' }));
  it('allows find -delete on logs', () => shouldAllow('Bash', { command: "find . -name '*.log' -delete" }));
  it('blocks moving a test into a temp subfolder', () =>
    shouldBlock('Bash', { command: 'mv tests/auth_test.py /tmp/stash/ && echo ok' }, 'delete-test'));
  it('allows restoring a test from /tmp', () =>
    shouldAllow('Bash', { command: 'mv /tmp/new_test.py tests/new_test.py' }));
  it('blocks find -delete under a test dir whatever the name filter', () =>
    shouldBlock('Bash', { command: "find tests -name '*.py' -delete" }, 'delete-test'));
  it('blocks a capitalised test directory (case-insensitive volumes)', () => {
    shouldBlock('Bash', { command: 'rm -rf Tests' }, 'delete-test');
    shouldBlock('Bash', { command: 'find TESTS -delete' }, 'delete-test');
  });
  it('blocks a glob or brace group that expands to the test directory', () => {
    for (const command of ['rm -rf tests*', 'rm -rf tests?', 'rm -rf {tests}', 'rm -rf {tests,}'])
      shouldBlock('Bash', { command }, 'delete-test');
  });
  it('blocks find piped to xargs rm', () => {
    shouldBlock('Bash', { command: 'find tests -print | xargs rm' }, 'delete-test');
    shouldBlock('Bash', { command: 'find tests -print0 | xargs -0 rm -f' }, 'delete-test');
  });
  it('blocks find -exec with a path, a quoted rm, or git rm', () => {
    for (const command of ['find tests -exec /bin/rm {} +', "find tests -exec 'rm' {} +", 'find tests -exec git rm {} +'])
      shouldBlock('Bash', { command }, 'delete-test');
  });
  it('blocks a delete split by a backslash-newline', () =>
    shouldBlock('Bash', { command: 'rm -rf \\\n  tests' }, 'delete-test'));
  it('blocks moving tests into TMPDIR with a default or into a per-user temp folder', () => {
    shouldBlock('Bash', { command: 'mv tests ${TMPDIR:-/tmp}' }, 'delete-test');
    shouldBlock('Bash', { command: 'mv tests /var/folders/xx/T/' }, 'delete-test');
    shouldBlock('Bash', { command: 'mv tests $HOME/.Trash/' }, 'delete-test');
  });
  it('mv to a temp folder stays a discard before a comment, redirect or pipe', () => {
    for (const command of ['mv tests /tmp | cat', 'mv tests /tmp/ # archive', 'mv tests /tmp >log', 'mv tests /tmp 2>&1'])
      shouldBlock('Bash', { command }, 'delete-test');
  });
  it('blocks xargs flags that take a value, and env before rm in -exec', () => {
    for (const command of ['find tests -print | xargs -n 1 rm', 'find tests -print | xargs -P 4 rm',
      'find tests -print0 | xargs -0 -I {} rm {}', 'find tests -exec env rm {} +'])
      shouldBlock('Bash', { command }, 'delete-test');
  });
  it('blocks a glob before the test directory word', () => {
    shouldBlock('Bash', { command: 'rm -rf *tests' }, 'delete-test');
    shouldBlock('Bash', { command: 'rm -rf *tests*' }, 'delete-test');
  });
  it('allows xargs rm on non-test files', () =>
    shouldAllow('Bash', { command: "find . -name '*.log' -print | xargs rm" }));
  it('allows rm of a scripts file named rmtests.sh', () => shouldAllow('Bash', { command: 'cat rmtests.sh' }));
  it('allows moving a test within the project', () =>
    shouldAllow('Bash', { command: 'mv tests/old_test.py tests/unit/' }));
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
// Unit Tests - disabling an existing test without Edit: a whole-file Write, a
// shell in-place edit, or a redirect. These read the file on disk, so they run
// against a real temp project.
// ─────────────────────────────────────────────────────────────────────────────

const JS_TEST = "const { add } = require('./math');\ntest('add works', () => {\n  expect(add(2, 2)).toBe(4);\n});\n";
const JS_TEST_ONE_SKIP = "test.skip('old', () => {});\ntest('add works', () => {\n  expect(add(2, 2)).toBe(4);\n});\n";
const PY_TEST = 'def test_a():\n    assert 1 == 1\n';

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protect-tests-'));
  fs.writeFileSync(path.join(dir, 'math.test.js'), JS_TEST);
  fs.writeFileSync(path.join(dir, 'one-skip.test.js'), JS_TEST_ONE_SKIP);
  fs.writeFileSync(path.join(dir, 'test_x.py'), PY_TEST);
  return dir;
}

describe('Write: rewriting an existing test file', () => {
  const dir = tempProject();
  const check = (input, level) => checkTool('Write', input, level, dir);

  it('blocks a full rewrite that turns test( into test.skip(', () => {
    const r = check({ file_path: 'math.test.js', content: JS_TEST.replace("test('add", "test.skip('add") });
    assert.strictEqual(r.blocked, true);
    assert.strictEqual(r.id, 'skip-test');
    assert.strictEqual(r.level, 'high');
  });
  it('blocks it with an absolute path too', () => {
    const r = checkTool('Write', { file_path: path.join(dir, 'math.test.js'), content: JS_TEST.replace("test('add", "xit('add") });
    assert.strictEqual(r.id, 'skip-test');
  });
  it('blocks adding a second skip to a file that already has one', () => {
    const r = check({ file_path: 'one-skip.test.js', content: JS_TEST_ONE_SKIP.replace("test('add", "test.skip('add") });
    assert.strictEqual(r.id, 'skip-test');
  });
  it('allows a rewrite that only changes test bodies', () => {
    assert.strictEqual(check({ file_path: 'math.test.js', content: JS_TEST.replace('toBe(4)', 'toEqual(4)') }).blocked, false);
  });
  it('allows a rewrite that removes a skip', () => {
    assert.strictEqual(check({ file_path: 'one-skip.test.js', content: JS_TEST_ONE_SKIP.replace('test.skip(', 'test(') }).blocked, false);
  });
  it('critical level does not block the rewrite', () => {
    assert.strictEqual(check({ file_path: 'math.test.js', content: JS_TEST.replace("test('add", "test.skip('add") }, 'critical').blocked, false);
  });
  it('a brand-new skipped test file is still strict-only', () => {
    assert.strictEqual(check({ file_path: 'new.test.js', content: "test.skip('x', () => {});" }).blocked, false);
    assert.strictEqual(check({ file_path: 'new.test.js', content: "test.skip('x', () => {});" }, 'strict').id, 'write-skipped-test');
  });
});

describe('Bash: disabling a test from the shell', () => {
  const dir = tempProject();
  const block = (command) => {
    const r = checkTool('Bash', { command }, undefined, dir);
    assert.strictEqual(r.blocked, true, `Expected BLOCKED: ${command}`);
    assert.strictEqual(r.id, 'skip-test');
  };
  const allow = (command) => {
    const r = checkTool('Bash', { command }, undefined, dir);
    assert.strictEqual(r.blocked, false, `Expected ALLOWED but got '${r.id}': ${command}`);
  };

  it("blocks sed -i '' s/test(/test.skip(/", () => block("sed -i '' 's/test(/test.skip(/' math.test.js"));
  it('blocks GNU sed -i with an escaped dot', () => block("sed -i 's/test(/test\\.skip(/' math.test.js"));
  it('blocks sed -i.bak turning it( into xit(', () => block("sed -i.bak 's/^it(/xit(/' src/auth.test.js"));
  it('blocks perl -pi adding @pytest.mark.skip', () => block("perl -pi -e 's/^def test_a/\\@pytest.mark.skip\\ndef test_a/' test_x.py"));
  it('blocks a heredoc rewrite of an existing test file with a skip', () =>
    block(`cat > math.test.js <<'EOF'\n${JS_TEST.replace("test('add", "test.skip('add")}EOF`));
  it('blocks appending a skipped test with >>', () => block(`echo "test.skip('later', () => {});" >> math.test.js`));
  it('blocks tee -a into a test file', () => block(`echo "xit('later', () => {});" | tee -a math.test.js`));

  it('allows sed -i that removes a skip', () => allow("sed -i '' 's/test.skip(/test(/' one-skip.test.js"));
  it('allows sed without -i (it only prints)', () => allow("sed 's/test(/test.skip(/' math.test.js"));
  it('allows a heredoc rewrite with no new markers', () => allow(`cat > math.test.js <<'EOF'\n${JS_TEST}EOF`));
  it('allows sed -i on a non-test file', () => allow("sed -i '' 's/test(/test.skip(/' src/app.js"));
  it('critical level does not block shell skips', () => {
    assert.strictEqual(checkTool('Bash', { command: "sed -i '' 's/test(/test.skip(/' math.test.js" }, 'critical', dir).blocked, false);
  });
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
  it('resolves a relative Write path against the payload cwd', async () => {
    const dir = tempProject();
    const out = await runHook({
      cwd: dir,
      tool_name: 'Write',
      tool_input: { file_path: 'math.test.js', content: JS_TEST.replace("test('add", "test.skip('add") },
    });
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /\[skip-test\]/);
  });
});
