#!/usr/bin/env node
/**
 * Tests for guard-pack.js
 *
 * Run: node --test plugins/guard-pack/tests/guard-pack.test.js
 * Or:  npm test
 */

const { test, describe, it } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PACK_DIR = path.join(__dirname, '..');
const SCRIPT_PATH = path.join(PACK_DIR, 'guard-pack.js');
const { GUARDS } = require(SCRIPT_PATH);

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-pack-test-'));

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

function runHook(payload, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, HOME: TMP_HOME, ...envOverrides };
    for (const key of Object.keys(env)) {
      if ((key.startsWith('HOOK_ASK_') || key.startsWith('HOOK_SAFETY') || key.startsWith('CONFIG_GUARD_') || key.startsWith('SPAWN_CAP_')) && !(key in envOverrides)) {
        delete env[key];
      }
    }
    // cwd is the isolated TMP_HOME (not a git repo) so branchOnly guards like
    // git-safety's push-on-protected read '' for the branch instead of leaking
    // in whatever branch CI happens to be on (push-to-main runs were HEAD=main).
    const child = spawn('node', [SCRIPT_PATH], { env, cwd: TMP_HOME });
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

function payload(toolName, toolInput, extra = {}) {
  return { tool_name: toolName, tool_input: toolInput, session_id: 'test-session', cwd: TMP_HOME, permission_mode: 'default', ...extra };
}

const decisionOf = (output) => output.hookSpecificOutput?.permissionDecision;
const reasonOf = (output) => output.hookSpecificOutput?.permissionDecisionReason || '';

// ─────────────────────────────────────────────────────────────────────────────
// Drift pins: the lib copies must stay byte-identical to the plugin sources
// ─────────────────────────────────────────────────────────────────────────────

describe('Drift: lib copies match the individual guard plugins', () => {
  for (const g of GUARDS) {
    it(`lib/${g.name}.js is byte-identical to plugins/${g.name}/${g.name}.js`, () => {
      const source = fs.readFileSync(path.join(PACK_DIR, '..', g.name, `${g.name}.js`), 'utf8');
      const copy = fs.readFileSync(path.join(PACK_DIR, 'lib', `${g.name}.js`), 'utf8');
      assert.strictEqual(copy, source, `lib/${g.name}.js drifted; copy plugins/${g.name}/${g.name}.js over it`);
    });
  }
});

describe('Config: GUARDS structure', () => {
  it('covers exactly the seven guards in cheap-first order', () => {
    assert.deepStrictEqual(GUARDS.map((g) => g.name), [
      'subagent-spawn-cap', 'config-guard', 'block-dangerous-commands', 'protect-secrets',
      'protect-tests', 'git-safety', 'case-insensitive-guard',
    ]);
  });
  it('every guard has an emoji per level and a run function', () => {
    for (const g of GUARDS) {
      for (const level of ['critical', 'high', 'strict']) assert.ok(g.emojis[level], `${g.name} missing ${level} emoji`);
      assert.strictEqual(typeof g.run, 'function');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: one process, six guards
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration: verdicts through the pack', () => {
  it('benign Bash passes', async () => {
    const { code, output } = await runHook(payload('Bash', { command: 'git status && ls src/' }));
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });

  it('benign Read passes', async () => {
    const { output } = await runHook(payload('Read', { file_path: path.join(TMP_HOME, 'notes.md') }));
    assert.deepStrictEqual(output, {});
  });

  it('unmatched tools pass untouched', async () => {
    const { output } = await runHook(payload('Grep', { pattern: 'x' }));
    assert.deepStrictEqual(output, {});
  });

  it('block-dangerous-commands: rm -rf ~ denied in its own format', async () => {
    const { output } = await runHook(payload('Bash', { command: 'rm -rf ~' }));
    assert.strictEqual(decisionOf(output), 'deny');
    assert.match(reasonOf(output), /^🚨 \[rm-home\] rm targeting home directory \(via guard-pack\)$/);
  });

  it('config-guard wins on a settings.json write and names its escape hatch', async () => {
    const { output } = await runHook(payload('Write', { file_path: '.claude/settings.json', content: '{}' }));
    assert.strictEqual(decisionOf(output), 'deny');
    assert.match(reasonOf(output), /^🔒 \[settings-file\]/);
    assert.match(reasonOf(output), /CONFIG_GUARD_ALLOW=true/);
  });

  it('protect-secrets: .env read denied with the Cannot-read phrasing', async () => {
    const { output } = await runHook(payload('Read', { file_path: '.env' }));
    assert.strictEqual(decisionOf(output), 'deny');
    assert.match(reasonOf(output), /\[env-file\] Cannot read:/);
  });

  it('protect-tests: deleting a test dir denied with its advice line', async () => {
    const { output } = await runHook(payload('Bash', { command: 'rm -rf tests/' }));
    assert.strictEqual(decisionOf(output), 'deny');
    assert.match(reasonOf(output), /\[delete-test\]/);
    assert.match(reasonOf(output), /Fix the code/);
  });

  it('git-safety: push to main denied', async () => {
    const { output } = await runHook(payload('Bash', { command: 'git push origin main' }));
    assert.strictEqual(decisionOf(output), 'deny');
    assert.match(reasonOf(output), /\[push-main\]/);
  });

  it('every deny carries the (via guard-pack) suffix', async () => {
    const { output } = await runHook(payload('Bash', { command: 'rm -rf ~' }));
    assert.match(reasonOf(output), /\(via guard-pack\)$/);
  });
});

describe('Integration: env passthrough', () => {
  it('HOOK_SAFETY_LEVEL=strict tightens every guard in the pack', async () => {
    const cmd = 'git push --force origin feature-branch';
    const relaxed = await runHook(payload('Bash', { command: cmd }));
    assert.deepStrictEqual(relaxed.output, {});
    const strict = await runHook(payload('Bash', { command: cmd }), { HOOK_SAFETY_LEVEL: 'strict' });
    assert.strictEqual(decisionOf(strict.output), 'deny');
  });

  it('HOOK_ASK_CRITICAL=true degrades a critical deny to ask', async () => {
    const { output } = await runHook(payload('Read', { file_path: '.env' }), { HOOK_ASK_CRITICAL: 'true' });
    assert.strictEqual(decisionOf(output), 'ask');
  });

  it('ask mode never softens the deny-only guards', async () => {
    const { output } = await runHook(payload('Bash', { command: 'git push origin main' }), { HOOK_ASK_HIGH: 'true' });
    assert.strictEqual(decisionOf(output), 'deny');
  });

  it('CONFIG_GUARD_ALLOW=true skips config-guard but only config-guard', async () => {
    const allowed = await runHook(payload('Write', { file_path: '.claude/settings.json', content: '{}' }), { CONFIG_GUARD_ALLOW: 'true' });
    assert.deepStrictEqual(allowed.output, {});
    const stillDenied = await runHook(payload('Read', { file_path: '.env' }), { CONFIG_GUARD_ALLOW: 'true' });
    assert.strictEqual(decisionOf(stillDenied.output), 'deny');
  });
});

describe('Integration: case-insensitive-guard through the pack', () => {
  // Only provable on a case-folding volume (macOS APFS default, NTFS).
  // On case-sensitive filesystems the collision cannot exist, so assert
  // the benign direction there instead of skipping silently.
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-pack-case-'));
  fs.mkdirSync(path.join(probeDir, 'Content'));
  const folds = fs.existsSync(path.join(probeDir, 'content'));

  it(folds ? 'denies rm -rf onto a case-variant directory' : 'passes on a case-sensitive volume (collision impossible)', async () => {
    const { output } = await runHook(payload('Bash', { command: 'rm -rf content' }, { cwd: probeDir }));
    if (folds) {
      assert.strictEqual(decisionOf(output), 'deny');
      assert.match(reasonOf(output), /\[case-collision\]/);
    } else {
      assert.deepStrictEqual(output, {});
    }
  });
});

describe('Integration: subagent-spawn-cap through the pack', () => {
  const spawnCall = (sessionId, extra = {}) => payload('Agent', { description: 'x', prompt: 'y', subagent_type: 'general-purpose' }, { session_id: sessionId, ...extra });
  const ledgerOf = (home, sessionId) => path.join(home, '.claude', 'subagent-spawn-cap', `${sessionId}.jsonl`);

  it('a spawn below the thresholds passes and is recorded in the session ledger', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-pack-spawn-'));
    const { code, output } = await runHook(spawnCall('pack-s1'), { HOME: home });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
    assert.strictEqual(fs.readFileSync(ledgerOf(home, 'pack-s1'), 'utf8').split('\n').filter(Boolean).length, 1);
  });

  it('asks at SPAWN_CAP_ASK in the spawn cap format with the (via guard-pack) suffix', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-pack-spawn-'));
    const env = { HOME: home, SPAWN_CAP_ASK: '2', SPAWN_CAP_DENY: '3' };
    const first = await runHook(spawnCall('pack-s2'), env);
    assert.deepStrictEqual(first.output, {});
    const second = await runHook(spawnCall('pack-s2'), env);
    assert.strictEqual(decisionOf(second.output), 'ask');
    assert.match(reasonOf(second.output), /^⚠️ \[spawn-cap\] Subagent spawn #2 in this session \(ask threshold SPAWN_CAP_ASK=2, hard cap SPAWN_CAP_DENY=3\)/);
    assert.match(reasonOf(second.output), /deleting ~\/\.claude\/subagent-spawn-cap\/pack-s2\.jsonl/);
    assert.match(reasonOf(second.output), /\(via guard-pack\)$/);
  });

  it('denies at SPAWN_CAP_DENY and does not record the denied call', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-pack-spawn-'));
    const env = { HOME: home, SPAWN_CAP_ASK: '1', SPAWN_CAP_DENY: '2' };
    await runHook(spawnCall('pack-s3'), env);
    const { output } = await runHook(spawnCall('pack-s3'), env);
    assert.strictEqual(decisionOf(output), 'deny');
    assert.match(reasonOf(output), /^🚨 \[spawn-cap\] Subagent spawn #2 in this session hit the hard cap \(SPAWN_CAP_DENY=2\)\. Do not retry/);
    assert.strictEqual(fs.readFileSync(ledgerOf(home, 'pack-s3'), 'utf8').split('\n').filter(Boolean).length, 1);
  });

  const logLines = (home) => {
    const dir = path.join(home, '.claude', 'hooks-logs');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  };

  it('SPAWN_CAP_ALLOW=true lets a call through past deny and the pack path logs ALLOW_OVERRIDE', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-pack-spawn-'));
    const env = { HOME: home, SPAWN_CAP_ASK: '1', SPAWN_CAP_DENY: '1' };
    const blocked = await runHook(spawnCall('pack-s4'), env);
    assert.strictEqual(decisionOf(blocked.output), 'deny');
    const allowed = await runHook(spawnCall('pack-s4'), { ...env, SPAWN_CAP_ALLOW: 'true' });
    assert.deepStrictEqual(allowed.output, {});
    const overrides = logLines(home).filter((l) => l.level === 'ALLOW_OVERRIDE');
    assert.strictEqual(overrides.length, 1, 'bypass past the hard cap must leave an audit line through the pack');
    assert.strictEqual(overrides[0].hook, 'subagent-spawn-cap');
    assert.strictEqual(overrides[0].session_id, 'pack-s4');
    assert.strictEqual(overrides[0].count, 1);
  });

  it('the pack verdict log carries the spawn count, thresholds, and subagent_type', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-pack-spawn-'));
    await runHook(spawnCall('pack-s8'), { HOME: home, SPAWN_CAP_ASK: '1', SPAWN_CAP_ASK_STEP: '4', SPAWN_CAP_DENY: '9' });
    const [line] = logLines(home).filter((l) => l.hook === 'guard-pack' && l.level === 'ASK');
    assert.ok(line, 'expected a guard-pack ASK line');
    assert.deepStrictEqual([line.guard, line.id, line.count, line.ask, line.step, line.deny, line.subagent_type], ['subagent-spawn-cap', 'spawn-cap', 1, 1, 4, 9, 'general-purpose']);
  });

  it('a clamped SPAWN_CAP_DENY is logged through the pack too', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-pack-spawn-'));
    await runHook(spawnCall('pack-s9'), { HOME: home, SPAWN_CAP_ASK: '5', SPAWN_CAP_DENY: '2' });
    assert.strictEqual(logLines(home).filter((l) => l.level === 'WARN' && /clamped/.test(l.msg)).length, 1);
  });

  it('a nested spawn (agent_id present) draws from the same session budget', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-pack-spawn-'));
    const env = { HOME: home, SPAWN_CAP_ASK: '2', SPAWN_CAP_DENY: '9' };
    await runHook(spawnCall('pack-s5'), env);
    const { output } = await runHook(spawnCall('pack-s5', { agent_id: 'agent-1', agent_type: 'Explore' }), env);
    assert.strictEqual(decisionOf(output), 'ask');
  });

  it('the older Task tool name is matched too', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-pack-spawn-'));
    const { output } = await runHook(payload('Task', { prompt: 'y' }, { session_id: 'pack-s6' }), { HOME: home, SPAWN_CAP_ASK: '1' });
    assert.strictEqual(decisionOf(output), 'ask');
  });

  it('a Bash call never touches the spawn ledger', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-pack-spawn-'));
    await runHook(payload('Bash', { command: 'git status' }, { session_id: 'pack-s7' }), { HOME: home });
    assert.ok(!fs.existsSync(path.join(home, '.claude', 'subagent-spawn-cap')));
  });

  it('evaluate() in-process: null below threshold, spawn-cap verdict at it', () => {
    // The lib module fixes its HOME on first require, so point HOME at a
    // temp dir before evaluate() loads it; nothing touches the real ~/.claude.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-pack-eval-'));
    const saved = { HOME: process.env.HOME, SPAWN_CAP_ASK: process.env.SPAWN_CAP_ASK, SPAWN_CAP_DENY: process.env.SPAWN_CAP_DENY };
    process.env.HOME = home;
    process.env.SPAWN_CAP_ASK = '2';
    process.env.SPAWN_CAP_DENY = '9';
    try {
      const { evaluate } = require(SCRIPT_PATH);
      const event = { session_id: 'eval-s1', cwd: home };
      assert.strictEqual(evaluate('Agent', { prompt: 'y' }, home, event), null);
      const v = evaluate('Agent', { prompt: 'y' }, home, event);
      assert.strictEqual(v.guard, 'subagent-spawn-cap');
      assert.strictEqual(v.id, 'spawn-cap');
      assert.strictEqual(v.ask, true);
      assert.strictEqual(v.emojis[v.level], '⚠️');
      assert.match(v.reason, /^\[spawn-cap\] Subagent spawn #2 /);
      assert.strictEqual(v.log.count, 2);
      assert.strictEqual(v.log.deny, 9);
      assert.strictEqual(evaluate('Bash', { command: 'git status' }, home, event), null);
    } finally {
      for (const [k, val] of Object.entries(saved)) {
        if (val === undefined) delete process.env[k]; else process.env[k] = val;
      }
    }
  });
});

describe('Integration: robustness', () => {
  it('malformed JSON exits 0 with {}', async () => {
    const { code, output } = await runHook('not json');
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });

  it('non-string command passes without crashing', async () => {
    const { code, output } = await runHook(payload('Bash', { command: 12345 }));
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });

  it('missing tool_input passes', async () => {
    const { output } = await runHook(payload('Bash', undefined));
    assert.deepStrictEqual(output, {});
  });
});

test('meta: the pack advertises exactly one PreToolUse registration', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PACK_DIR, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(manifest.hooks), ['PreToolUse']);
  assert.strictEqual(manifest.hooks.PreToolUse[0].matcher, 'Bash|Read|Edit|MultiEdit|Write|Agent|Task');
});
