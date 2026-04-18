#!/usr/bin/env node
/**
 * Tests for session-logger.js
 *
 * Run: node --test hook-scripts/tests/session/session-logger.test.js
 * Or:  npm test
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Isolate session notes into a temp dir for every test run.
const TMP_SESSIONS = fs.mkdtempSync(path.join(os.tmpdir(), 'session-logger-test-'));
process.env.CC_SESSION_LOG_DIR = TMP_SESSIONS;

const SCRIPT_PATH = path.join(__dirname, '../../session/session-logger.js');
const {
  gitInfo,
  sessionFilePath,
  findExistingFile,
  appendUnderSection,
  handleSessionStart,
  handlePostToolUse,
  handleSessionEnd,
} = require('../../session/session-logger.js');

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

function runHook(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SCRIPT_PATH], {
      env: { ...process.env, CC_SESSION_LOG_DIR: TMP_SESSIONS },
    });
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
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

function cleanSessionsDir() {
  for (const f of fs.readdirSync(TMP_SESSIONS)) {
    fs.unlinkSync(path.join(TMP_SESSIONS, f));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit: sessionFilePath
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: sessionFilePath()', () => {
  it('builds deterministic path from session_id + timestamp', () => {
    const p = sessionFilePath('abcd1234efgh', '2026-04-18T14:32:00Z', '/tmp/foo');
    assert.match(p, /2026-04-18_1432_abcd1234\.md$/);
  });

  it('pads single-digit hours/minutes', () => {
    const p = sessionFilePath('xx', '2026-01-02T03:04:00Z', '/tmp');
    assert.match(p, /2026-01-02_0304_xx\.md$/);
  });

  it('handles missing session_id', () => {
    const p = sessionFilePath(undefined, '2026-04-18T14:32:00Z', '/tmp');
    assert.match(p, /_unknown\.md$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: findExistingFile
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: findExistingFile()', () => {
  beforeEach(cleanSessionsDir);

  it('returns null when no file matches', () => {
    assert.strictEqual(findExistingFile('nomatch'), null);
  });

  it('finds a file by short session id suffix', () => {
    const target = path.join(TMP_SESSIONS, '2026-04-18_1432_abcd1234.md');
    fs.writeFileSync(target, '# test');
    assert.strictEqual(findExistingFile('abcd1234efgh'), target);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: appendUnderSection
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: appendUnderSection()', () => {
  let tmpFile;
  beforeEach(() => {
    tmpFile = path.join(TMP_SESSIONS, 'section-test.md');
    fs.writeFileSync(tmpFile, '## Files Touched\n\n## Commands Run\n\n');
  });

  it('inserts entry under the right section', () => {
    appendUnderSection(tmpFile, '## Files Touched', '- wrote foo');
    const body = fs.readFileSync(tmpFile, 'utf8');
    assert.ok(body.includes('## Files Touched\n- wrote foo'));
    assert.ok(body.indexOf('- wrote foo') < body.indexOf('## Commands Run'));
  });

  it('creates the section if missing', () => {
    fs.writeFileSync(tmpFile, '# Start\n');
    appendUnderSection(tmpFile, '## Files Touched', '- wrote foo');
    const body = fs.readFileSync(tmpFile, 'utf8');
    assert.ok(body.includes('## Files Touched'));
    assert.ok(body.includes('- wrote foo'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: gitInfo
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: gitInfo()', () => {
  it('returns branch for a real git repo', () => {
    const info = gitInfo(path.dirname(__filename));
    assert.ok(info.branch === null || typeof info.branch === 'string');
  });

  it('returns nulls for a non-git path', () => {
    const info = gitInfo('/tmp');
    assert.strictEqual(info.branch, null);
    assert.strictEqual(info.repo, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: SessionStart event
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration: SessionStart', () => {
  beforeEach(cleanSessionsDir);

  it('creates a new session note with frontmatter', async () => {
    const { code, output } = await runHook({
      hook_event_name: 'SessionStart',
      session_id: 'sess-aaaa1111',
      cwd: '/tmp',
    });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});

    const files = fs.readdirSync(TMP_SESSIONS).filter(f => f.endsWith('.md'));
    assert.strictEqual(files.length, 1);
    const body = fs.readFileSync(path.join(TMP_SESSIONS, files[0]), 'utf8');
    assert.ok(body.startsWith('---\n'));
    assert.ok(body.includes('session_id: sess-aaaa1111'));
    assert.ok(body.includes('## Files Touched'));
    assert.ok(body.includes('## Commands Run'));
  });

  it('appends resume marker instead of overwriting on duplicate SessionStart', async () => {
    await runHook({ hook_event_name: 'SessionStart', session_id: 'sess-bbbb2222', cwd: '/tmp' });
    await runHook({ hook_event_name: 'SessionStart', session_id: 'sess-bbbb2222', cwd: '/tmp' });
    const files = fs.readdirSync(TMP_SESSIONS).filter(f => f.endsWith('.md'));
    assert.strictEqual(files.length, 1, 'should not duplicate');
    const body = fs.readFileSync(path.join(TMP_SESSIONS, files[0]), 'utf8');
    assert.ok(body.includes('Resumed at'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: PostToolUse event
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration: PostToolUse', () => {
  beforeEach(cleanSessionsDir);

  it('appends file path under "Files Touched" for Edit', async () => {
    await runHook({ hook_event_name: 'SessionStart', session_id: 'sess-cccc3333', cwd: '/tmp' });
    await runHook({
      hook_event_name: 'PostToolUse',
      session_id: 'sess-cccc3333',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/foo.js', old_string: 'a', new_string: 'b' },
    });
    const f = fs.readdirSync(TMP_SESSIONS)[0];
    const body = fs.readFileSync(path.join(TMP_SESSIONS, f), 'utf8');
    assert.ok(body.includes('edited'));
    assert.ok(body.includes('/tmp/foo.js'));
  });

  it('appends command under "Commands Run" for Bash, truncated to first line', async () => {
    await runHook({ hook_event_name: 'SessionStart', session_id: 'sess-dddd4444', cwd: '/tmp' });
    await runHook({
      hook_event_name: 'PostToolUse',
      session_id: 'sess-dddd4444',
      tool_name: 'Bash',
      tool_input: { command: 'ls -la\necho multi-line-should-not-appear' },
    });
    const f = fs.readdirSync(TMP_SESSIONS)[0];
    const body = fs.readFileSync(path.join(TMP_SESSIONS, f), 'utf8');
    assert.ok(body.includes('ls -la'));
    assert.ok(!body.includes('multi-line-should-not-appear'));
  });

  it('ignores unsupported tools (e.g. Grep)', async () => {
    await runHook({ hook_event_name: 'SessionStart', session_id: 'sess-eeee5555', cwd: '/tmp' });
    await runHook({
      hook_event_name: 'PostToolUse',
      session_id: 'sess-eeee5555',
      tool_name: 'Grep',
      tool_input: { pattern: 'foo' },
    });
    const f = fs.readdirSync(TMP_SESSIONS)[0];
    const body = fs.readFileSync(path.join(TMP_SESSIONS, f), 'utf8');
    assert.ok(!body.includes('foo'), 'Grep should not produce an entry');
  });

  it('no-ops (no crash) when session file does not exist', async () => {
    const { code, output } = await runHook({
      hook_event_name: 'PostToolUse',
      session_id: 'sess-orphaned',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/x.js' },
    });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: SessionEnd event
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration: SessionEnd', () => {
  beforeEach(cleanSessionsDir);

  it('writes end timestamp into frontmatter and a Session End section', async () => {
    await runHook({ hook_event_name: 'SessionStart', session_id: 'sess-ffff6666', cwd: '/tmp' });
    await runHook({ hook_event_name: 'SessionEnd', session_id: 'sess-ffff6666', cwd: '/tmp' });
    const f = fs.readdirSync(TMP_SESSIONS)[0];
    const body = fs.readFileSync(path.join(TMP_SESSIONS, f), 'utf8');
    assert.ok(/^ended: \d{4}-/m.test(body));
    assert.ok(body.includes('## Session End'));
  });

  it('no-ops when session file does not exist', async () => {
    const { code, output } = await runHook({
      hook_event_name: 'SessionEnd',
      session_id: 'sess-nofile',
      cwd: '/tmp',
    });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });

  it('is idempotent — duplicate SessionEnd does not double-append', async () => {
    await runHook({ hook_event_name: 'SessionStart', session_id: 'sess-gggg7777', cwd: '/tmp' });
    await runHook({ hook_event_name: 'SessionEnd', session_id: 'sess-gggg7777', cwd: '/tmp' });
    await runHook({ hook_event_name: 'SessionEnd', session_id: 'sess-gggg7777', cwd: '/tmp' });
    const f = fs.readdirSync(TMP_SESSIONS)[0];
    const body = fs.readFileSync(path.join(TMP_SESSIONS, f), 'utf8');
    const matches = body.match(/## Session End/g) || [];
    assert.strictEqual(matches.length, 1, 'Session End section should appear exactly once');
  });

  it('ignores Stop events (fires per-turn, not per-session)', async () => {
    await runHook({ hook_event_name: 'SessionStart', session_id: 'sess-hhhh8888', cwd: '/tmp' });
    await runHook({ hook_event_name: 'Stop', session_id: 'sess-hhhh8888', cwd: '/tmp' });
    const f = fs.readdirSync(TMP_SESSIONS)[0];
    const body = fs.readFileSync(path.join(TMP_SESSIONS, f), 'utf8');
    assert.ok(!body.includes('## Session End'), 'Stop should not finalize the note');
    assert.ok(!/^ended: \d{4}-/m.test(body), 'Stop should not fill ended timestamp');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: malformed input
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration: error handling', () => {
  it('returns {} on malformed JSON', async () => {
    const child = spawn('node', [SCRIPT_PATH], {
      env: { ...process.env, CC_SESSION_LOG_DIR: TMP_SESSIONS },
    });
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

// Cleanup the temp sessions directory after the suite.
after(() => {
  try { fs.rmSync(TMP_SESSIONS, { recursive: true, force: true }); } catch {}
});
