#!/usr/bin/env node
/**
 * Tests for auto-stage.js
 *
 * Run: node --test hook-scripts/tests/post-tool-use/auto-stage.test.js
 * Or:  npm test
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { isInGitRepo, stageFile } = require('../../post-tool-use/auto-stage.js');

const SCRIPT_PATH = path.join(__dirname, '../../post-tool-use/auto-stage.js');

// Hermetic HOME: the hook logs to ~/.claude/hooks-logs — keep test noise
// out of the real home directory. realpathSync: /var vs /private/var on macOS.
const TEST_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hook-test-home-')));

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

function runHook(toolName, toolInput, cwd = '/tmp') {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SCRIPT_PATH], { env: { ...process.env, HOME: TEST_HOME } });
    let stdout = '', stderr = '';

    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('close', code => {
      try {
        resolve({ code, output: JSON.parse(stdout.trim() || '{}'), stderr });
      } catch (e) {
        reject(new Error(`Failed to parse: ${stdout}`));
      }
    });

    child.stdin.write(JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: toolName,
      tool_input: toolInput,
      tool_response: { success: true },
      session_id: 'test-session',
      cwd,
    }));
    child.stdin.end();
  });
}

let tempDir, testFile;

// ─────────────────────────────────────────────────────────────────────────────
// Unit Tests - isInGitRepo
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: isInGitRepo()', () => {
  it('returns true for file in git repo', () => {
    assert.strictEqual(isInGitRepo(__filename), true);
  });

  it('returns false for /tmp', () => {
    assert.strictEqual(isInGitRepo('/tmp/somefile.txt'), false);
  });

  it('returns false for nonexistent path', () => {
    assert.strictEqual(isInGitRepo('/nonexistent/path/file.txt'), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit Tests - stageFile
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: stageFile()', () => {
  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-stage-test-'));
    execSync('git init && git config user.email "test@test.com" && git config user.name "Test"', { cwd: tempDir, stdio: 'pipe' });
    testFile = path.join(tempDir, 'test.txt');
    fs.writeFileSync(testFile, 'hello');
  });

  after(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('stages file successfully', () => {
    const result = stageFile(testFile);
    assert.strictEqual(result.success, true);
    const status = execSync('git status --porcelain', { cwd: tempDir, encoding: 'utf8' });
    assert.ok(status.includes('A  test.txt') || status.includes('M  test.txt'));
  });

  it('handles nonexistent file', () => {
    const result = stageFile(path.join(tempDir, 'nonexistent.txt'));
    assert.ok('success' in result);
  });

  it('stages a filename containing shell metacharacters without executing them', () => {
    // Regression: stageFile used to interpolate the path into a shell string,
    // so a filename like a"b$(...).txt escaped the quotes and ran the command.
    // Relative sentinel: git runs with cwd = dirname(filePath), so a shell
    // would drop the file right here. A path separator cannot go in a filename.
    const sentinel = path.join(tempDir, 'pwned');
    const nasty = path.join(tempDir, 'a"b$(touch pwned).txt');
    fs.writeFileSync(nasty, 'x');

    const result = stageFile(nasty);

    assert.strictEqual(fs.existsSync(sentinel), false, 'command substitution must not run');
    assert.strictEqual(result.success, true);
    // -z gives raw NUL-separated names; without it git escapes the quotes.
    const staged = execSync('git diff --cached --name-only -z', { cwd: tempDir, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
    assert.ok(
      staged.includes(path.basename(nasty)),
      'the literal filename should be staged'
    );
  });

  it('stages a filename starting with a dash', () => {
    // `--` keeps git from reading the leading dash as an option.
    const dashed = path.join(tempDir, '-dashed.txt');
    fs.writeFileSync(dashed, 'x');
    assert.strictEqual(stageFile(dashed).success, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration Tests - gitignore behavior
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration: gitignore behavior', () => {
  let gitDir, ignoredFile;

  before(() => {
    gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-stage-gitignore-'));
    execSync('git init && git config user.email "test@test.com" && git config user.name "Test"', { cwd: gitDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(gitDir, '.gitignore'), 'ignored.txt\n');
    ignoredFile = path.join(gitDir, 'ignored.txt');
    fs.writeFileSync(ignoredFile, 'SECRET=123');
  });

  after(() => {
    if (gitDir) fs.rmSync(gitDir, { recursive: true, force: true });
  });

  it('git add on ignored file fails gracefully', () => {
    const result = stageFile(ignoredFile);
    // git add returns error for ignored files (exit code 1)
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('ignored'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration Tests - stdin/stdout hook flow
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration: stdin/stdout hook flow', () => {
  it('returns {} for Edit tool', async () => {
    const { code, output } = await runHook('Edit', { file_path: '/tmp/test.js', old_string: 'a', new_string: 'b' });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });

  it('returns {} for Write tool', async () => {
    const { code, output } = await runHook('Write', { file_path: '/tmp/test.js', content: 'hello' });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });

  it('returns {} for non-Edit/Write tool', async () => {
    const { code, output } = await runHook('Read', { file_path: '/tmp/test.js' });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });

  it('handles missing file_path', async () => {
    const { code, output } = await runHook('Edit', { old_string: 'a', new_string: 'b' });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });

  it('handles malformed JSON', async () => {
    const child = spawn('node', [SCRIPT_PATH], { env: { ...process.env, HOME: TEST_HOME } });
    let stdout = '';
    const result = await new Promise(resolve => {
      child.stdout.on('data', d => stdout += d);
      child.on('close', code => resolve({ code, output: stdout.trim() }));
      child.stdin.write('not json');
      child.stdin.end();
    });
    assert.strictEqual(result.output, '{}');
  });
});
