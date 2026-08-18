#!/usr/bin/env node
/**
 * Tests for config-watch.js
 *
 * Run: node --test hook-scripts/tests/config-change/config-watch.test.js
 * Or:  npm test
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { evaluate } = require('../../config-change/config-watch.js');

const SCRIPT_PATH = path.join(__dirname, '../../config-change/config-watch.js');

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

function event(fields = {}) {
  return { hook_event_name: 'ConfigChange', session_id: 'test-session', cwd: '/tmp', ...fields };
}

// Spawns the actual script with a temp HOME (no noise in the real
// ~/.claude/hooks-logs) and without inheriting CONFIG_WATCH_* from the
// runner's shell - tests opt in explicitly via envOverrides.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'config-watch-test-'));

function runHook(payload, envOverrides = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: TMP_HOME, ...envOverrides };
    for (const key of Object.keys(env)) {
      if (key.startsWith('CONFIG_WATCH_') && !(key in envOverrides)) delete env[key];
    }
    const child = spawn('node', [SCRIPT_PATH], { env });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });

    child.on('close', (code) => {
      let output = null;
      try { output = JSON.parse(stdout.trim()); } catch {}
      resolve({ code, output, stdout, stderr });
    });

    child.stdin.write(typeof payload === 'string' ? payload : JSON.stringify(payload));
    child.stdin.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit Tests - evaluate()
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: evaluate()', () => {
  describe('warn mode (default)', () => {
    for (const source of ['user_settings', 'project_settings', 'local_settings', 'policy_settings', 'skills']) {
      it(`warns on ${source}`, () => {
        const result = evaluate(event({ source }), false);
        assert.strictEqual(result.action, 'warn');
        assert.match(result.message, new RegExp(source));
      });
    }
    it('warns even when the payload names no source (schema is undocumented)', () => {
      const result = evaluate(event(), false);
      assert.strictEqual(result.action, 'warn');
      assert.match(result.message, /unknown source/);
    });
    it('reads the config_source alias', () => {
      const result = evaluate(event({ config_source: 'project_settings' }), false);
      assert.match(result.message, /project_settings/);
    });
    it('reads the matcher alias', () => {
      const result = evaluate(event({ matcher: 'local_settings' }), false);
      assert.match(result.message, /local_settings/);
    });
    it('includes file_path in the message when present', () => {
      const result = evaluate(event({ source: 'project_settings', file_path: '/repo/.claude/settings.json' }), false);
      assert.match(result.message, /\/repo\/\.claude\/settings\.json/);
    });
    it('includes the path alias when present', () => {
      const result = evaluate(event({ source: 'user_settings', path: '/home/u/.claude/settings.json' }), false);
      assert.match(result.message, /\/home\/u\/\.claude\/settings\.json/);
    });
  });

  describe('block mode (CONFIG_WATCH_BLOCK=true)', () => {
    for (const source of ['user_settings', 'project_settings', 'local_settings', 'skills']) {
      it(`blocks ${source}`, () => {
        assert.strictEqual(evaluate(event({ source }), true).action, 'block');
      });
    }
    it('policy_settings still warns (hooks cannot block it per the docs)', () => {
      assert.strictEqual(evaluate(event({ source: 'policy_settings' }), true).action, 'warn');
    });
  });

  describe('non-events pass', () => {
    it('passes a non-ConfigChange event', () => {
      assert.strictEqual(evaluate({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }, true).action, 'pass');
    });
    it('passes a payload without hook_event_name', () => {
      assert.strictEqual(evaluate({ source: 'user_settings' }, true).action, 'pass');
    });
    it('passes null', () => {
      assert.strictEqual(evaluate(null, true).action, 'pass');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration Tests - stdin/stdout/exit-code flow
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration: hook process', () => {
  it('warn mode: exit 0 with a systemMessage naming the source', async () => {
    const { code, output } = await runHook(event({ source: 'project_settings' }));
    assert.strictEqual(code, 0);
    assert.match(output.systemMessage, /project_settings/);
  });

  it('warn mode: message tells the user to inspect unexpected changes', async () => {
    const { output } = await runHook(event({ source: 'user_settings' }));
    assert.match(output.systemMessage, /did not make this change/);
  });

  it('block mode: exit 2 with the reason on stderr', async () => {
    const { code, stderr } = await runHook(event({ source: 'project_settings' }), { CONFIG_WATCH_BLOCK: 'true' });
    assert.strictEqual(code, 2);
    assert.match(stderr, /project_settings/);
  });

  it('block mode requires the literal string "true"', async () => {
    const { code, output } = await runHook(event({ source: 'project_settings' }), { CONFIG_WATCH_BLOCK: '1' });
    assert.strictEqual(code, 0);
    assert.ok(output.systemMessage);
  });

  it('block mode: policy_settings falls back to a warn, exit 0', async () => {
    const { code, output } = await runHook(event({ source: 'policy_settings' }), { CONFIG_WATCH_BLOCK: 'true' });
    assert.strictEqual(code, 0);
    assert.match(output.systemMessage, /policy_settings/);
  });

  it('outputs {} and exits 0 on invalid JSON', async () => {
    const { code, output } = await runHook('not json at all');
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });

  it('outputs {} and exits 0 on a null payload', async () => {
    const { code, output } = await runHook('null');
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });

  it('outputs {} for a non-ConfigChange payload even in block mode', async () => {
    const { code, output } = await runHook({ hook_event_name: 'PostToolUse' }, { CONFIG_WATCH_BLOCK: 'true' });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });
});
