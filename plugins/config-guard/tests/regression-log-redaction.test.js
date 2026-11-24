#!/usr/bin/env node
/**
 * Regression: the hook log records the guard, the rule and the command name of a refused
 * Bash call, and no argument text, so an inline credential never lands in the log file.
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

const NAMES = [
  ['mysql -pab db < x > .claude/settings.json', 'mysql'],
  ['echo "a | hunter2" > .claude/settings.json', 'echo'],
  ['TOKEN=abc cmd > .claude/settings.json', undefined],
  ['/usr/bin/curl -o .claude/settings.json https://user:pass@example.com/s.json', 'curl'],
  ['"quoted cmd" > .claude/settings.json', undefined],
  ['', undefined],
];

for (const [name, mod] of [['config-guard', standalone], ['guard-pack copy', bundled]]) {
  describe(`${name}: only the command name of a refused command is logged`, () => {
    for (const [command, expected] of NAMES) {
      it(JSON.stringify(command), () => assert.strictEqual(mod.commandName(command), expected));
    }
    it('a missing command logs no name', () => assert.strictEqual(mod.commandName(undefined), undefined));
  });
}

function runHook(command) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-log-'));
  try {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'config-guard.js')], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, session_id: 't', cwd: home }),
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home }, encoding: 'utf8', timeout: 20000, cwd: home,
    });
    assert.match(r.stdout, /"permissionDecision":"deny"/);
    const dir = path.join(home, '.claude', 'hooks-logs');
    return fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe('config-guard hook: the log file never holds argument text', () => {
  it('a quoted | does not expose the word after it', () => {
    const text = runHook('echo "x | hunter2" > .claude/settings.json');
    assert.ok(!text.includes('hunter2'), text);
    const entry = JSON.parse(text.trim().split('\n').pop());
    assert.strictEqual(entry.guard, 'config-guard');
    assert.strictEqual(entry.id, 'settings-file');
    assert.strictEqual(entry.command, 'echo');
    assert.strictEqual(entry.target, undefined);
  });

  it('a short attached password stays out of the log', () => {
    const text = runHook('mysql -pab db > .claude/settings.json');
    assert.ok(!text.includes('-pab'), text);
    assert.strictEqual(JSON.parse(text.trim().split('\n').pop()).command, 'mysql');
  });
});

describe('config-guard hook: malformed input is logged with a fixed text', () => {
  it('the JSON parse error never copies the input into the log', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-log-'));
    try {
      const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'config-guard.js')], {
        input: 'hunter2',
        env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home }, encoding: 'utf8', timeout: 20000, cwd: home,
      });
      assert.strictEqual(r.stdout.trim(), '{}');
      const dir = path.join(home, '.claude', 'hooks-logs');
      const text = fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
      assert.ok(!text.includes('hunter2'), text);
      assert.strictEqual(JSON.parse(text.trim().split('\n').pop()).error, 'hook input is not valid JSON');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
