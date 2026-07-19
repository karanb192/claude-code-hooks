#!/usr/bin/env node
/**
 * Tests for notify-permission.js
 *
 * Run: node --test hook-scripts/tests/notification/notify-permission.test.js
 * Or:  npm test
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

// Hermetic: never inherit a real webhook from the developer's shell. The hook
// module reads CCH_SLA_WEBHOOK at require time, so scrub it before requiring.
delete process.env.CCH_SLA_WEBHOOK;

const {
  SLACK_WEBHOOK,
  getNotificationType,
  getProjectName,
  getShortSessionId,
  getEmoji,
  getTitle,
  formatMessage,
  sendSlack,
} = require('../../notification/notify-permission.js');

const SCRIPT_PATH = path.join(__dirname, '../../notification/notify-permission.js');

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────
function runHook(hookData) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SCRIPT_PATH], {
      env: { ...process.env, CCH_SLA_WEBHOOK: '' }
    });
    let stdout = '';

    child.stdout.on('data', (data) => { stdout += data; });
    child.on('close', (code) => {
      try {
        resolve({ code, output: JSON.parse(stdout.trim() || '{}') });
      } catch (e) {
        reject(new Error(`Failed to parse: ${stdout}`));
      }
    });

    child.stdin.write(JSON.stringify(hookData));
    child.stdin.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit Tests - getNotificationType
// ─────────────────────────────────────────────────────────────────────────────
describe('Unit: getNotificationType()', () => {
  it('uses notification_type from hook data when available', () => {
    assert.strictEqual(getNotificationType({ notification_type: 'permission_prompt' }), 'permission_prompt');
    assert.strictEqual(getNotificationType({ notification_type: 'idle_prompt' }), 'idle_prompt');
    assert.strictEqual(getNotificationType({ notification_type: 'elicitation_dialog' }), 'elicitation_dialog');
  });

  it('detects permission_prompt from message', () => {
    assert.strictEqual(getNotificationType({ message: 'Permission needed' }), 'permission_prompt');
    assert.strictEqual(getNotificationType({ message: 'Please approve' }), 'permission_prompt');
  });

  it('detects idle_prompt from message', () => {
    assert.strictEqual(getNotificationType({ message: 'Claude idle' }), 'idle_prompt');
    assert.strictEqual(getNotificationType({ message: 'Waiting for input' }), 'idle_prompt');
  });

  it('detects elicitation_dialog from message', () => {
    assert.strictEqual(getNotificationType({ message: 'elicitation required' }), 'elicitation_dialog');
    assert.strictEqual(getNotificationType({ message: 'MCP tool needs input' }), 'elicitation_dialog');
  });

  it('returns notification for unknown', () => {
    assert.strictEqual(getNotificationType({ message: 'Hello' }), 'notification');
    assert.strictEqual(getNotificationType({}), 'notification');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit Tests - getProjectName
// ─────────────────────────────────────────────────────────────────────────────
describe('Unit: getProjectName()', () => {
  it('extracts project name from path', () => {
    assert.strictEqual(getProjectName('/Users/dev/projects/my-app'), 'my-app');
    assert.strictEqual(getProjectName('/home/user/code/api-server'), 'api-server');
  });

  it('handles root path', () => {
    assert.strictEqual(getProjectName('/'), '');
  });

  it('handles null/undefined', () => {
    assert.strictEqual(getProjectName(null), 'unknown');
    assert.strictEqual(getProjectName(undefined), 'unknown');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit Tests - getShortSessionId
// ─────────────────────────────────────────────────────────────────────────────
describe('Unit: getShortSessionId()', () => {
  it('returns first 6 chars', () => {
    assert.strictEqual(getShortSessionId('a1b2c3d4e5f6'), 'a1b2c3');
    assert.strictEqual(getShortSessionId('123456789'), '123456');
  });

  it('handles short session IDs', () => {
    assert.strictEqual(getShortSessionId('abc'), 'abc');
  });

  it('handles null/undefined', () => {
    assert.strictEqual(getShortSessionId(null), '????');
    assert.strictEqual(getShortSessionId(undefined), '????');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit Tests - getEmoji
// ─────────────────────────────────────────────────────────────────────────────
describe('Unit: getEmoji()', () => {
  it('returns correct emoji for each type', () => {
    assert.strictEqual(getEmoji('permission_prompt'), '🔐');
    assert.strictEqual(getEmoji('idle_prompt'), '💤');
    assert.strictEqual(getEmoji('elicitation_dialog'), '🔧');
  });

  it('returns default for unknown type', () => {
    assert.strictEqual(getEmoji('unknown'), '🔔');
    assert.strictEqual(getEmoji('notification'), '🔔');
    assert.strictEqual(getEmoji(null), '🔔');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit Tests - getTitle
// ─────────────────────────────────────────────────────────────────────────────
describe('Unit: getTitle()', () => {
  it('returns choice title for elicitation_dialog', () => {
    assert.strictEqual(getTitle('elicitation_dialog', 'anything'), 'Claude needs your choice');
  });

  it('infers choice from message content', () => {
    assert.strictEqual(getTitle('permission_prompt', 'Please select an option'), 'Claude needs your choice');
    assert.strictEqual(getTitle('permission_prompt', 'Choose which one'), 'Claude needs your choice');
    assert.strictEqual(getTitle('permission_prompt', 'Which library?'), 'Claude needs your choice');
  });

  it('returns tool-specific permission titles', () => {
    assert.strictEqual(getTitle('permission_prompt', 'Run bash command'), 'Claude needs permission (Bash)');
    assert.strictEqual(getTitle('permission_prompt', 'Write to file'), 'Claude needs permission (Write)');
    assert.strictEqual(getTitle('permission_prompt', 'Edit the code'), 'Claude needs permission (Edit)');
    assert.strictEqual(getTitle('permission_prompt', 'Read config'), 'Claude needs permission (Read)');
  });

  it('returns generic attention title for unknown permission_prompt', () => {
    assert.strictEqual(getTitle('permission_prompt', 'Do something'), 'Claude needs your attention');
    assert.strictEqual(getTitle('permission_prompt', 'Claude Code needs your attention'), 'Claude needs your attention');
  });

  it('returns idle title', () => {
    assert.strictEqual(getTitle('idle_prompt', 'anything'), 'Claude is waiting for you');
  });

  it('returns default for unknown type', () => {
    assert.strictEqual(getTitle('unknown', 'anything'), 'Claude notification');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit Tests - formatMessage
// ─────────────────────────────────────────────────────────────────────────────
describe('Unit: formatMessage()', () => {
  it('returns message as-is if short', () => {
    assert.strictEqual(formatMessage('Hello world'), 'Hello world');
  });

  it('truncates long messages', () => {
    const longMsg = 'x'.repeat(250);
    const result = formatMessage(longMsg);
    assert.ok(result.length <= 203); // 200 + '...'
    assert.ok(result.endsWith('...'));
  });

  it('handles null/undefined', () => {
    assert.strictEqual(formatMessage(null), '_No details provided_');
    assert.strictEqual(formatMessage(undefined), '_No details provided_');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit Tests - sendSlack
// ─────────────────────────────────────────────────────────────────────────────
describe('Unit: sendSlack()', () => {
  it('returns no webhook when CCH_SLA_WEBHOOK not set', async () => {
    // SLACK_WEBHOOK is empty string when env var not set
    const result = await sendSlack({ message: 'test' }, 'permission_prompt');
    assert.strictEqual(result.sent, false);
    assert.strictEqual(result.reason, 'no webhook');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration Tests
// ─────────────────────────────────────────────────────────────────────────────
describe('Integration: stdin/stdout hook flow', () => {
  it('returns {} for Notification event', async () => {
    const { code, output } = await runHook({
      hook_event_name: 'Notification',
      message: 'Permission needed',
      session_id: 'abc123',
      cwd: '/tmp/my-project',
    });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });

  it('returns {} for non-Notification event', async () => {
    const { code, output } = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
    });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });

  it('returns {} for any notification type (filtering via matchers)', async () => {
    const { code, output } = await runHook({
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Claude needs permission',
    });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });

  it('handles malformed JSON gracefully', async () => {
    const child = spawn('node', [SCRIPT_PATH], {
      env: { ...process.env, CCH_SLA_WEBHOOK: '' }
    });
    let stdout = '';

    const result = await new Promise((resolve) => {
      child.stdout.on('data', (data) => { stdout += data; });
      child.on('close', (code) => resolve({ code, output: stdout.trim() }));
      child.stdin.write('not json');
      child.stdin.end();
    });

    assert.strictEqual(result.output, '{}');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Config Tests
// ─────────────────────────────────────────────────────────────────────────────
describe('Config: Structure validation', () => {
  it('SLACK_WEBHOOK is string', () => {
    assert.strictEqual(typeof SLACK_WEBHOOK, 'string');
  });

  it('SLACK_WEBHOOK defaults to empty string when env not set', () => {
    // Since tests run without CCH_SLA_WEBHOOK set, it should be empty
    assert.strictEqual(SLACK_WEBHOOK, '');
  });
});
