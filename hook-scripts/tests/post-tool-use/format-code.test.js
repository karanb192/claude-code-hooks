#!/usr/bin/env node
/**
 * Tests for format-code.js
 *
 * Run: node --test hook-scripts/tests/post-tool-use/format-code.test.js
 * Or:  npm test
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { getFormatter, formatFile, log, FORMATTERS } = require('../../post-tool-use/format-code.js');

const SCRIPT_PATH = path.join(__dirname, '../../post-tool-use/format-code.js');

// ----------------------------------------------------------------------------
// Test helpers
// ----------------------------------------------------------------------------

const tmpDirs = [];

afterEach(() => {
  for (const d of tmpDirs) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

function tmpFile(ext, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'format-code-test-'));
  tmpDirs.push(dir);
  const filePath = path.join(dir, `test${ext}`);
  fs.writeFileSync(filePath, content || '');
  return filePath;
}

function readContent(filePath) {
  return fs.readFileSync(filePath, 'utf-8');
}

function runHook(hookData) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SCRIPT_PATH]);
    let stdout = '';

    child.stdout.on('data', (data) => { stdout += data; });
    child.on('close', (code) => {
      try {
        resolve({ code, output: JSON.parse(stdout.trim() || '{}') });
      } catch (e) {
        reject(new Error(`Failed to parse output: ${stdout}`));
      }
    });

    child.stdin.write(JSON.stringify(hookData));
    child.stdin.end();
  });
}

// ----------------------------------------------------------------------------
// Unit Tests - getFormatter
// ----------------------------------------------------------------------------

describe('Unit: getFormatter()', () => {
  it('returns ruff for .py files', () => {
    const result = getFormatter('/path/to/file.py');
    assert.strictEqual(typeof result, 'function');
    assert.ok(Array.isArray(result('/path/to/file.py')));
  });

  it('returns prettier for .js files', () => {
    assert.strictEqual(typeof getFormatter('/path/to/file.js'), 'function');
  });

  it('returns prettier for .ts files', () => {
    assert.strictEqual(typeof getFormatter('/path/to/file.ts'), 'function');
  });

  it('returns prettier for .md files', () => {
    assert.strictEqual(typeof getFormatter('/path/to/readme.md'), 'function');
  });

  it('returns prettier for .yaml files', () => {
    assert.strictEqual(typeof getFormatter('/path/to/config.yaml'), 'function');
  });

  it('returns prettier for .yml files', () => {
    assert.strictEqual(typeof getFormatter('/path/to/config.yml'), 'function');
  });

  it('returns prettier for .json files', () => {
    assert.strictEqual(typeof getFormatter('/path/to/package.json'), 'function');
  });

  it('returns prettier for .html files', () => {
    assert.strictEqual(typeof getFormatter('/path/to/index.html'), 'function');
  });

  it('returns null for unsupported extensions', () => {
    assert.strictEqual(getFormatter('/path/to/file.go'), null);
    assert.strictEqual(getFormatter('/path/to/file.txt'), null);
  });

  it('handles uppercase extensions', () => {
    assert.strictEqual(typeof getFormatter('/path/to/file.PY'), 'function');
    assert.strictEqual(typeof getFormatter('/path/to/file.MD'), 'function');
    assert.strictEqual(typeof getFormatter('/path/to/file.JSON'), 'function');
  });

  it('handles extensions with paths containing dots', () => {
    assert.strictEqual(typeof getFormatter('/path/to/some.config.file.yaml'), 'function');
  });
});

// ----------------------------------------------------------------------------
// Unit Tests - formatFile
// ----------------------------------------------------------------------------

describe('Unit: formatFile()', () => {
  it('returns error for non-existent file', () => {
    const result = formatFile('/nonexistent/path/file.py', '/tmp', 'test-session');
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'file not found');
  });

  it('returns error for unsupported file type', () => {
    const fp = tmpFile('.txt', 'hello world');
    const result = formatFile(fp, '/tmp', 'test-session');
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'unsupported file type');
  });

  it('returns error for invalid Python syntax', () => {
    const fp = tmpFile('.py', 'def broken(\n');
    const result = formatFile(fp, '/tmp', 'test-session');
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.formatter, 'ruff');
  });

  it('formats .py files with ruff and fixes spacing', () => {
    const fp = tmpFile('.py', 'x=1\n');
    const result = formatFile(fp, '/tmp', 'test-session');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.formatter, 'ruff');
    const content = readContent(fp);
    assert.ok(content.includes('x = 1'), `Expected ruff to add spaces around '=' but got: ${JSON.stringify(content)}`);
  });

  it('formats .md files with prettier', () => {
    const fp = tmpFile('.md', '# Hello\n');
    const result = formatFile(fp, '/tmp', 'test-session');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.formatter, 'prettier');
  });

  it('formats .json files with prettier', () => {
    const fp = tmpFile('.json', '{"a":1}');
    const result = formatFile(fp, '/tmp', 'test-session');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.formatter, 'prettier');
    const content = readContent(fp);
    assert.ok(content.includes('"a": 1'), `Expected prettier to add space after colon but got: ${JSON.stringify(content)}`);
  });

  it('resolves relative paths using cwd', () => {
    const fp = tmpFile('.py', 'x=1\n');
    const relPath = path.basename(fp);
    const result = formatFile(relPath, path.dirname(fp), 'test-session');
    assert.strictEqual(result.success, true);
  });
});

// ----------------------------------------------------------------------------
// Integration Tests - stdin/stdout hook flow
// ----------------------------------------------------------------------------

describe('Integration: stdin/stdout hook flow', () => {
  it('formats .py file via Write tool and returns {}', async () => {
    const fp = tmpFile('.py', 'x=1\n');
    const { code, output } = await runHook({
      tool_name: 'Write',
      tool_input: { file_path: fp },
      session_id: 'test-session',
      cwd: '/tmp',
    });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
    const content = readContent(fp);
    assert.ok(content.includes('x = 1'), `Expected formatting but got: ${JSON.stringify(content)}`);
  });

  it('formats .json file via Edit tool and returns {}', async () => {
    const fp = tmpFile('.json', '{"a":1}');
    const { code, output } = await runHook({
      tool_name: 'Edit',
      tool_input: { file_path: fp },
      session_id: 'test-session',
      cwd: '/tmp',
    });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
    const content = readContent(fp);
    assert.ok(content.includes('"a": 1'), `Expected formatting but got: ${JSON.stringify(content)}`);
  });

  it('handles filenames with shell characters safely', async () => {
    const maliciousName = 'test$(touch HACKED).py';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'format-code-sec-'));
    tmpDirs.push(dir);
    const fp = path.join(dir, maliciousName);
    fs.writeFileSync(fp, 'x=1\n');

    const { code, output } = await runHook({
      tool_name: 'Write',
      tool_input: { file_path: fp },
      session_id: 'test-session',
      cwd: dir,
    });

    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
    assert.strictEqual(fs.existsSync(path.join(dir, 'HACKED')), false, 'Shell injection triggered: HACKED file created');

    const content = readContent(fp);
    assert.ok(content.includes('x = 1'), 'File should still be processed');
  });

  it('returns {} for non-matching tool (Read)', async () => {
    const { code, output } = await runHook({
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/test.py' },
      session_id: 'test-session',
      cwd: '/tmp',
    });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });

  it('returns {} for non-matching tool (Bash)', async () => {
    const { code, output } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      session_id: 'test-session',
      cwd: '/tmp',
    });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });

  it('returns {} for malformed JSON gracefully', async () => {
    const child = spawn('node', [SCRIPT_PATH]);
    let stdout = '';

    const result = await new Promise((resolve) => {
      child.stdout.on('data', (data) => { stdout += data; });
      child.on('close', (code) => resolve({ code, output: stdout.trim() }));
      child.stdin.write('not valid json');
      child.stdin.end();
    });

    assert.strictEqual(result.output, '{}');
  });

  it('returns {} when no file_path provided', async () => {
    const { code, output } = await runHook({
      tool_name: 'Write',
      tool_input: {},
      session_id: 'test-session',
      cwd: '/tmp',
    });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });

  it('returns {} for non-existent file_path', async () => {
    const { code, output } = await runHook({
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/nonexistent-format-code-test.py' },
      session_id: 'test-session',
      cwd: '/tmp',
    });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });
});

// ----------------------------------------------------------------------------
// Config Tests - validate FORMATTERS structure
// ----------------------------------------------------------------------------

describe('Config: FORMATTERS structure', () => {
  it('has valid extensions as keys', () => {
    const exts = Object.keys(FORMATTERS);
    assert.ok(exts.length > 0);
    for (const ext of exts) {
      assert.ok(ext.startsWith('.'), `Extension should start with dot: ${ext}`);
    }
  });

  it('has commands for each formatter', () => {
    for (const [ext, getCmds] of Object.entries(FORMATTERS)) {
      assert.ok(typeof getCmds === 'function', `Formatter ${ext} missing commands function`);
      const cmds = getCmds(`/tmp/test${ext}`);
      assert.ok(Array.isArray(cmds), `commands for ${ext} should return array`);
      assert.ok(cmds.length > 0, `commands for ${ext} should have at least one command`);
    }
  });

  it('exports expected functions', () => {
    assert.strictEqual(typeof getFormatter, 'function');
    assert.strictEqual(typeof formatFile, 'function');
    assert.strictEqual(typeof log, 'function');
  });
});
