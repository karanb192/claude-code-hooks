#!/usr/bin/env node
/**
 * Tests for subagent-spawn-cap.js
 *
 * Run: node --test plugins/subagent-spawn-cap/tests/subagent-spawn-cap.test.js
 * Or:  npm test
 *
 * Every test gets its own temp HOME, so the per-session ledgers and the
 * prune stamp never leak between tests or into the real ~/.claude.
 */

const { test, describe, it } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PLUGIN_DIR = path.join(__dirname, '..');
const SCRIPT_PATH = path.join(PLUGIN_DIR, 'subagent-spawn-cap.js');
const mod = require(SCRIPT_PATH);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const freshHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-cap-test-'));
const stateDir = (home) => path.join(home, '.claude', 'subagent-spawn-cap');
const ledger = (home, sessionId) => path.join(stateDir(home), `${sessionId}.jsonl`);
const lineCount = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;

function runHook(home, payload, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, ...envOverrides };
    for (const key of Object.keys(env)) {
      if ((key.startsWith('SPAWN_CAP_') || key.startsWith('HOOK_')) && !(key in envOverrides)) delete env[key];
    }
    const child = spawn('node', [SCRIPT_PATH], { env, cwd: home });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      try { resolve({ code, output: JSON.parse(stdout.trim() || '{}'), stderr }); }
      catch { reject(new Error(`Failed to parse output: ${stdout}`)); }
    });
    child.stdin.write(typeof payload === 'string' ? payload : JSON.stringify(payload));
    child.stdin.end();
  });
}

function spawnPayload(sessionId = 'sess-1', extra = {}) {
  return {
    session_id: sessionId,
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: { description: 'find endpoints', prompt: 'Find all API endpoints', subagent_type: 'Explore' },
    cwd: '/tmp',
    permission_mode: 'default',
    ...extra,
  };
}

const decisionOf = (output) => output.hookSpecificOutput?.permissionDecision;
const reasonOf = (output) => output.hookSpecificOutput?.permissionDecisionReason || '';

// Run n sequential spawns for one session; returns the decisions in order.
async function spawnN(home, n, sessionId = 'sess-1', env = {}) {
  const decisions = [];
  for (let i = 0; i < n; i++) {
    const { output } = await runHook(home, spawnPayload(sessionId), env);
    decisions.push(decisionOf(output) || 'allow');
  }
  return decisions;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure functions
// ─────────────────────────────────────────────────────────────────────────────

describe('readThresholds: env validation', () => {
  it('defaults to 20 / 60 with nothing set', () => {
    assert.deepStrictEqual(mod.readThresholds({}), { ask: 20, deny: 60, clamped: false });
  });

  it('reads valid integers, tolerating whitespace', () => {
    assert.deepStrictEqual(mod.readThresholds({ SPAWN_CAP_ASK: ' 5 ', SPAWN_CAP_DENY: '9' }), { ask: 5, deny: 9, clamped: false });
  });

  for (const bad of ['0', '-3', '2e1', 'twenty', '', '1.5', '10abc']) {
    it(`falls back to the default on ${JSON.stringify(bad)}`, () => {
      const t = mod.readThresholds({ SPAWN_CAP_ASK: bad, SPAWN_CAP_DENY: bad });
      assert.strictEqual(t.ask, 20);
      assert.strictEqual(t.deny, 60);
    });
  }

  it('clamps deny up to ask when set lower, and says so', () => {
    assert.deepStrictEqual(mod.readThresholds({ SPAWN_CAP_ASK: '100' }), { ask: 100, deny: 100, clamped: true });
    assert.deepStrictEqual(mod.readThresholds({ SPAWN_CAP_ASK: '10', SPAWN_CAP_DENY: '3' }), { ask: 10, deny: 10, clamped: true });
  });

  it('ask equal to deny is allowed (skips the ask stage)', () => {
    assert.deepStrictEqual(mod.readThresholds({ SPAWN_CAP_ASK: '7', SPAWN_CAP_DENY: '7' }), { ask: 7, deny: 7, clamped: false });
  });
});

describe('sessionFile and buildReason', () => {
  it('sanitises the session id into a safe file name', () => {
    const f = mod.sessionFile('../../etc/passwd?x=1');
    assert.strictEqual(path.dirname(f), mod.STATE_DIR);
    assert.strictEqual(path.basename(f), '.._.._etc_passwd_x_1.jsonl');
  });

  it('truncates very long session ids', () => {
    assert.ok(path.basename(mod.sessionFile('a'.repeat(500))).length <= 134);
  });

  it('reason strings carry count, threshold, env var, and the escape hatch', () => {
    const t = { ask: 20, deny: 60 };
    for (const [decision, n] of [['ask', 20], ['deny', 60]]) {
      const r = mod.buildReason(decision, n, t);
      assert.match(r, new RegExp(`#${n}\\b`));
      assert.match(r, decision === 'ask' ? /SPAWN_CAP_ASK=20/ : /SPAWN_CAP_DENY=60/);
      assert.match(r, /SPAWN_CAP_ALLOW=true/);
    }
  });

  it('isSpawnTool matches Agent and Task only', () => {
    assert.ok(mod.isSpawnTool('Agent'));
    assert.ok(mod.isSpawnTool('Task'));
    assert.ok(!mod.isSpawnTool('Bash'));
    assert.ok(!mod.isSpawnTool(undefined));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Thresholds through the process
// ─────────────────────────────────────────────────────────────────────────────

describe('Thresholds', () => {
  it('below the ask threshold: exit 0, {} output, one ledger line per spawn', async () => {
    const home = freshHome();
    const decisions = await spawnN(home, 3, 'sess-1', { SPAWN_CAP_ASK: '5', SPAWN_CAP_DENY: '10' });
    assert.deepStrictEqual(decisions, ['allow', 'allow', 'allow']);
    assert.strictEqual(lineCount(ledger(home, 'sess-1')), 3);
  });

  it('asks exactly at the ask threshold and keeps asking until deny', async () => {
    const home = freshHome();
    const decisions = await spawnN(home, 5, 'sess-1', { SPAWN_CAP_ASK: '3', SPAWN_CAP_DENY: '5' });
    assert.deepStrictEqual(decisions, ['allow', 'allow', 'ask', 'ask', 'deny']);
  });

  it('the ask reason names the count, both thresholds, and the escape hatch', async () => {
    const home = freshHome();
    const { output } = await runHook(home, spawnPayload(), { SPAWN_CAP_ASK: '1', SPAWN_CAP_DENY: '9' });
    assert.strictEqual(decisionOf(output), 'ask');
    assert.match(reasonOf(output), /^⚠️ \[spawn-cap\] Subagent spawn #1 /);
    assert.match(reasonOf(output), /SPAWN_CAP_ASK=1; hard cap SPAWN_CAP_DENY=9/);
    assert.match(reasonOf(output), /SPAWN_CAP_ALLOW=true/);
    assert.strictEqual(output.hookSpecificOutput.hookEventName, 'PreToolUse');
  });

  it('denies at the deny threshold with the deny reason', async () => {
    const home = freshHome();
    const decisions = await spawnN(home, 2, 'sess-1', { SPAWN_CAP_ASK: '2', SPAWN_CAP_DENY: '2' });
    assert.deepStrictEqual(decisions, ['allow', 'deny']);
    const { output } = await runHook(home, spawnPayload(), { SPAWN_CAP_ASK: '2', SPAWN_CAP_DENY: '2' });
    assert.strictEqual(decisionOf(output), 'deny');
    assert.match(reasonOf(output), /^🚨 \[spawn-cap\] Subagent spawn #2 in this session reached the hard cap \(SPAWN_CAP_DENY=2\)/);
    assert.match(reasonOf(output), /SPAWN_CAP_ALLOW=true/);
  });

  it('denied calls are not counted: the ledger stops growing at deny', async () => {
    const home = freshHome();
    await spawnN(home, 6, 'sess-1', { SPAWN_CAP_ASK: '2', SPAWN_CAP_DENY: '3' });
    // spawns 1 and 2 allowed/asked, 3 onward denied: two lines only
    assert.strictEqual(lineCount(ledger(home, 'sess-1')), 2);
  });

  it('defaults apply when the env is unset: 20th spawn asks', async () => {
    const home = freshHome();
    const decisions = await spawnN(home, 20);
    assert.deepStrictEqual(decisions.slice(0, 19), Array(19).fill('allow'));
    assert.strictEqual(decisions[19], 'ask');
  });

  it('invalid env values fall back to the defaults', async () => {
    const home = freshHome();
    const decisions = await spawnN(home, 3, 'sess-1', { SPAWN_CAP_ASK: '1', SPAWN_CAP_DENY: 'lots' });
    // deny "lots" -> 60, ask 1 -> ask from the first call, never deny
    assert.deepStrictEqual(decisions, ['ask', 'ask', 'ask']);
    const garbage = await spawnN(freshHome(), 2, 'sess-1', { SPAWN_CAP_ASK: '0', SPAWN_CAP_DENY: '-5' });
    assert.deepStrictEqual(garbage, ['allow', 'allow']);
  });

  it('the Task tool name (older builds) is counted too', async () => {
    const home = freshHome();
    const { output } = await runHook(home, spawnPayload('sess-1', { tool_name: 'Task' }), { SPAWN_CAP_ASK: '1' });
    assert.strictEqual(decisionOf(output), 'ask');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Escape hatch
// ─────────────────────────────────────────────────────────────────────────────

describe('SPAWN_CAP_ALLOW', () => {
  it('true lets a call through past deny and still records it', async () => {
    const home = freshHome();
    await spawnN(home, 3, 'sess-1', { SPAWN_CAP_ASK: '2', SPAWN_CAP_DENY: '3' });
    const { output } = await runHook(home, spawnPayload(), { SPAWN_CAP_ASK: '2', SPAWN_CAP_DENY: '3', SPAWN_CAP_ALLOW: 'true' });
    assert.deepStrictEqual(output, {});
    const lines = fs.readFileSync(ledger(home, 'sess-1'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(lines.length, 3);
    assert.strictEqual(lines[2].decision, 'bypass');
    assert.strictEqual(lines[2].n, 3);
  });

  it('is one call only: the next call without it is denied again', async () => {
    const home = freshHome();
    const env = { SPAWN_CAP_ASK: '1', SPAWN_CAP_DENY: '1' };
    await runHook(home, spawnPayload(), { ...env, SPAWN_CAP_ALLOW: 'true' });
    const { output } = await runHook(home, spawnPayload(), env);
    assert.strictEqual(decisionOf(output), 'deny');
  });

  it('anything but the literal "true" does not bypass', async () => {
    const home = freshHome();
    const { output } = await runHook(home, spawnPayload(), { SPAWN_CAP_ASK: '1', SPAWN_CAP_DENY: '1', SPAWN_CAP_ALLOW: '1' });
    assert.strictEqual(decisionOf(output), 'deny');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sessions and subagents
// ─────────────────────────────────────────────────────────────────────────────

describe('Session scoping', () => {
  it('a hook event from inside a subagent (agent_id present) counts under the same session', async () => {
    const home = freshHome();
    const env = { SPAWN_CAP_ASK: '3', SPAWN_CAP_DENY: '9' };
    await runHook(home, spawnPayload('sess-1'), env);
    await runHook(home, spawnPayload('sess-1', { agent_id: 'agent-abc123', agent_type: 'Explore' }), env);
    const { output } = await runHook(home, spawnPayload('sess-1', { agent_id: 'agent-def456', agent_type: 'general-purpose' }), env);
    assert.strictEqual(decisionOf(output), 'ask');
    assert.match(reasonOf(output), /#3 /);
    const lines = fs.readFileSync(ledger(home, 'sess-1'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(lines.length, 3);
    assert.strictEqual(lines[1].agent_id, 'agent-abc123');
    assert.strictEqual(lines[1].agent_type, 'Explore');
    assert.strictEqual(lines[0].agent_id, undefined);
  });

  it('a different session_id has its own counter', async () => {
    const home = freshHome();
    const env = { SPAWN_CAP_ASK: '2', SPAWN_CAP_DENY: '9' };
    await spawnN(home, 2, 'sess-A', env);
    const { output } = await runHook(home, spawnPayload('sess-B'), env);
    assert.deepStrictEqual(output, {});
    assert.strictEqual(lineCount(ledger(home, 'sess-A')), 2);
    assert.strictEqual(lineCount(ledger(home, 'sess-B')), 1);
  });

  it('ledger lines carry ts, n, decision, subagent_type, and a truncated description', async () => {
    const home = freshHome();
    const long = 'd'.repeat(200);
    await runHook(home, spawnPayload('sess-1', { tool_input: { description: long, prompt: 'p', subagent_type: 'Plan' } }));
    const [line] = fs.readFileSync(ledger(home, 'sess-1'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.match(line.ts, /^\d{4}-\d{2}-\d{2}T/);
    assert.strictEqual(line.n, 1);
    assert.strictEqual(line.decision, 'allow');
    assert.strictEqual(line.subagent_type, 'Plan');
    assert.strictEqual(line.description.length, 80);
  });

  it('a missing session_id fails open and writes nothing', async () => {
    const home = freshHome();
    const { code, output } = await runHook(home, spawnPayload(undefined, { session_id: undefined }), { SPAWN_CAP_ASK: '1', SPAWN_CAP_DENY: '1' });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
    assert.ok(!fs.existsSync(stateDir(home)));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Non-spawn tools and robustness
// ─────────────────────────────────────────────────────────────────────────────

describe('Non-spawn tools', () => {
  for (const tool of ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'WebFetch']) {
    it(`${tool} produces {} and creates no files`, async () => {
      const home = freshHome();
      const { code, output } = await runHook(home, spawnPayload('sess-1', { tool_name: tool, tool_input: { command: 'ls' } }), { SPAWN_CAP_ASK: '1', SPAWN_CAP_DENY: '1' });
      assert.strictEqual(code, 0);
      assert.deepStrictEqual(output, {});
      assert.ok(!fs.existsSync(path.join(home, '.claude')), `${tool} touched the filesystem`);
    });
  }
});

describe('Robustness', () => {
  it('malformed JSON exits 0 with {}', async () => {
    const home = freshHome();
    const { code, output } = await runHook(home, 'not json {{{');
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });

  it('empty stdin exits 0 with {}', async () => {
    const home = freshHome();
    const { code, output } = await runHook(home, '');
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });

  it('missing tool_input still counts the spawn', async () => {
    const home = freshHome();
    const { code, output } = await runHook(home, spawnPayload('sess-1', { tool_input: undefined }));
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
    assert.strictEqual(lineCount(ledger(home, 'sess-1')), 1);
  });

  it('an unreadable ledger fails open (a directory where the file should be)', async () => {
    const home = freshHome();
    fs.mkdirSync(ledger(home, 'sess-1'), { recursive: true });
    const { code, output } = await runHook(home, spawnPayload('sess-1'), { SPAWN_CAP_ASK: '1', SPAWN_CAP_DENY: '1' });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency: parallel tool calls fire parallel hook processes
// ─────────────────────────────────────────────────────────────────────────────

describe('Concurrency', () => {
  it('10 hook processes at once against one session leave exactly 10 ledger lines', async () => {
    const home = freshHome();
    const env = { SPAWN_CAP_ASK: '100', SPAWN_CAP_DENY: '200' };
    const results = await Promise.all(Array.from({ length: 10 }, () => runHook(home, spawnPayload('sess-race'), env)));
    for (const r of results) {
      assert.strictEqual(r.code, 0);
      assert.deepStrictEqual(r.output, {});
    }
    const lines = fs.readFileSync(ledger(home, 'sess-race'), 'utf8').split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 10);
    for (const l of lines) assert.doesNotThrow(() => JSON.parse(l), `torn line: ${l}`);
    // A sequential follow-up sees all ten.
    const { output } = await runHook(home, spawnPayload('sess-race'), { SPAWN_CAP_ASK: '11', SPAWN_CAP_DENY: '200' });
    assert.strictEqual(decisionOf(output), 'ask');
    assert.match(reasonOf(output), /#11 /);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pruning
// ─────────────────────────────────────────────────────────────────────────────

describe('Pruning', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('removes a ledger older than 7 days and keeps a fresh one', async () => {
    const home = freshHome();
    fs.mkdirSync(stateDir(home), { recursive: true });
    const old = ledger(home, 'ancient');
    const fresh = ledger(home, 'recent');
    fs.writeFileSync(old, '{"n":1}\n');
    fs.writeFileSync(fresh, '{"n":1}\n');
    const eightDaysAgo = new Date(Date.now() - 8 * DAY);
    fs.utimesSync(old, eightDaysAgo, eightDaysAgo);
    const sixDaysAgo = new Date(Date.now() - 6 * DAY);
    fs.utimesSync(fresh, sixDaysAgo, sixDaysAgo);

    await runHook(home, spawnPayload('sess-1'));

    assert.ok(!fs.existsSync(old), 'stale ledger should be pruned');
    assert.ok(fs.existsSync(fresh), 'fresh ledger should be kept');
    assert.ok(fs.existsSync(ledger(home, 'sess-1')));
    assert.ok(fs.existsSync(path.join(stateDir(home), '.last-prune')));
  });

  it('runs at most once a day: a fresh stamp skips the sweep', async () => {
    const home = freshHome();
    fs.mkdirSync(stateDir(home), { recursive: true });
    const old = ledger(home, 'ancient');
    fs.writeFileSync(old, '{"n":1}\n');
    const eightDaysAgo = new Date(Date.now() - 8 * DAY);
    fs.utimesSync(old, eightDaysAgo, eightDaysAgo);
    fs.writeFileSync(path.join(stateDir(home), '.last-prune'), String(Date.now()));

    await runHook(home, spawnPayload('sess-1'));

    assert.ok(fs.existsSync(old), 'sweep should be skipped while the stamp is fresh');
  });

  it('ignores non-ledger files in the state dir', async () => {
    const home = freshHome();
    fs.mkdirSync(stateDir(home), { recursive: true });
    const stray = path.join(stateDir(home), 'notes.txt');
    fs.writeFileSync(stray, 'keep me');
    const eightDaysAgo = new Date(Date.now() - 8 * DAY);
    fs.utimesSync(stray, eightDaysAgo, eightDaysAgo);
    await runHook(home, spawnPayload('sess-1'));
    assert.ok(fs.existsSync(stray));
  });
});

test('meta: hooks.json registers PreToolUse on Agent|Task, synchronous', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(manifest.hooks), ['PreToolUse']);
  const [entry] = manifest.hooks.PreToolUse;
  assert.strictEqual(entry.matcher, 'Agent|Task');
  assert.strictEqual(entry.hooks[0].async, undefined, 'a guard that returns a permissionDecision must stay synchronous');
  assert.match(entry.hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}\/subagent-spawn-cap\.js/);
});

test('meta: plugin.json is metadata-only', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(manifest).sort(), ['author', 'description', 'homepage', 'keywords', 'license', 'name', 'version']);
  assert.strictEqual(manifest.name, 'subagent-spawn-cap');
});
