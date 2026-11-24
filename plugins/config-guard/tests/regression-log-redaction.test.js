#!/usr/bin/env node
/**
 * Regression: the hook log keeps a redacted form of a refused Bash command, so an inline
 * credential typed into the command never lands in the log file.
 *
 * Run: node --test plugins/config-guard/tests/regression-log-redaction.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const standalone = require('../config-guard.js');
const bundled = require('../../guard-pack/lib/config-guard.js');

const REDACTED = [
  ['mysql -pSECRET db < .claude/settings.json', 'mysql * * < .claude/settings.json'],
  ['TOKEN=abc cmd > .claude/settings.json', '* * > .claude/settings.json'],
  ['curl https://user:pass@example.com/s.json -o .claude/settings.json', 'curl * -o .claude/settings.json'],
  ['curl --header=X-Key:abc123 -o .claude/settings.json https://example.com/s.json', 'curl --header=* -o .claude/settings.json *'],
  ['echo {} > .claude/settings.json', 'echo * > .claude/settings.json'],
  ['rm -rf .claude', 'rm -rf .claude'],
];

for (const [name, mod] of [['config-guard', standalone], ['guard-pack copy', bundled]]) {
  describe(`${name}: a refused command is logged in redacted form`, () => {
    for (const [command, expected] of REDACTED) {
      it(JSON.stringify(command), () => {
        assert.strictEqual(mod.redactCommand(command), expected);
      });
    }
    it('an empty or missing command logs nothing', () => {
      assert.strictEqual(mod.redactCommand(''), '');
      assert.strictEqual(mod.redactCommand(undefined), undefined);
    });
  });
}

describe('config-guard hook: the log file never holds the inline credential', () => {
  it('logs the rule id and the redacted command', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-log-'));
    const command = 'curl https://user:hunter2@example.com/s.json -o .claude/settings.json';
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'config-guard.js')], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, session_id: 't', cwd: home }),
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home }, encoding: 'utf8', timeout: 20000, cwd: home,
    });
    assert.match(r.stdout, /"permissionDecision":"deny"/);
    const dir = path.join(home, '.claude', 'hooks-logs');
    const text = fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
    assert.ok(!text.includes('hunter2'), text);
    const entry = JSON.parse(text.trim().split('\n').pop());
    assert.strictEqual(entry.target, 'curl * -o .claude/settings.json');
    assert.ok(entry.id);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
