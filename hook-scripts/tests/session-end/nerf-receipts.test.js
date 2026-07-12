#!/usr/bin/env node
/**
 * Tests for nerf-receipts.js
 *
 * Run: node --test hook-scripts/tests/session-end/nerf-receipts.test.js
 * Or:  npm test
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  isToolFailure,
  editTargetPath,
  applyToolEvent,
  totalChurn,
  parseTranscript,
  buildSessionRecord,
  extractMeta,
  mean,
  sparkline,
  detectShifts,
  renderTrendCard,
  MIN_SESSIONS_FOR_TREND,
} = require('../../session-end/nerf-receipts.js');

const SCRIPT_PATH = path.join(__dirname, '../../session-end/nerf-receipts.js');

// ─────────────────────────────────────────────────────────────────────────────
// Hermetic temp-HOME helpers
// ─────────────────────────────────────────────────────────────────────────────

const tempHomes = [];
function makeTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nerf-receipts-test-'));
  tempHomes.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempHomes) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

/**
 * Spawn the hook with a fresh temp HOME (fully hermetic — no ambient env, no
 * pollution of the real home dir). Returns { code, output, home }.
 */
function runHook(payload, home = makeTempHome()) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SCRIPT_PATH], {
      env: { PATH: process.env.PATH, HOME: home },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      try {
        resolve({ code, output: JSON.parse(stdout.trim()), stderr, home });
      } catch (e) {
        reject(new Error(`Failed to parse output: [${stdout}] stderr: ${stderr}`));
      }
    });
    child.stdin.write(typeof payload === 'string' ? payload : JSON.stringify(payload));
    child.stdin.end();
  });
}

function ledgerPath(home) {
  return path.join(home, '.claude', 'nerf-receipts', 'sessions.jsonl');
}
function readLedgerFile(home) {
  const p = ledgerPath(home);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit: isToolFailure
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: isToolFailure()', () => {
  it('returns false for null/undefined', () => {
    assert.strictEqual(isToolFailure(null), false);
    assert.strictEqual(isToolFailure(undefined), false);
  });
  it('detects success:false', () => assert.strictEqual(isToolFailure({ success: false }), true));
  it('detects is_error / isError', () => {
    assert.strictEqual(isToolFailure({ is_error: true }), true);
    assert.strictEqual(isToolFailure({ isError: true }), true);
  });
  it('detects an error field', () => assert.strictEqual(isToolFailure({ error: 'boom' }), true));
  it('detects non-zero exit_code', () => assert.strictEqual(isToolFailure({ exit_code: 1 }), true));
  it('detects non-zero status', () => assert.strictEqual(isToolFailure({ status: 127 }), true));
  it('treats exit_code 0 as success', () => assert.strictEqual(isToolFailure({ exit_code: 0, stdout: 'ok' }), false));
  it('detects stderr-only bash error', () => assert.strictEqual(isToolFailure({ stderr: 'bash: foo: command not found' }), true));
  it('does not fail on benign stderr with stdout', () => assert.strictEqual(isToolFailure({ stdout: 'done', stderr: 'note' }), false));
  it('detects error-ish strings', () => {
    assert.strictEqual(isToolFailure('Error: file not found'), true);
    assert.strictEqual(isToolFailure('Traceback (most recent call last)'), true);
  });
  it('passes benign strings', () => assert.strictEqual(isToolFailure('all tests passed'), false));
  it('ignores plain success objects', () => assert.strictEqual(isToolFailure({ stdout: 'ok', exit_code: 0 }), false));
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: editTargetPath
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: editTargetPath()', () => {
  it('resolves Edit file_path', () => assert.strictEqual(editTargetPath('Edit', { file_path: '/a/b.js' }), '/a/b.js'));
  it('resolves Write file_path', () => assert.strictEqual(editTargetPath('Write', { file_path: '/a/c.ts' }), '/a/c.ts'));
  it('resolves MultiEdit file_path', () => assert.strictEqual(editTargetPath('MultiEdit', { file_path: '/a/d' }), '/a/d'));
  it('resolves NotebookEdit notebook_path', () => assert.strictEqual(editTargetPath('NotebookEdit', { notebook_path: '/n.ipynb' }), '/n.ipynb'));
  it('returns null for non-edit tools', () => assert.strictEqual(editTargetPath('Bash', { command: 'ls' }), null));
  it('returns null for Read', () => assert.strictEqual(editTargetPath('Read', { file_path: '/a' }), null));
  it('returns null for missing input', () => assert.strictEqual(editTargetPath('Edit', null), null));
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: applyToolEvent + totalChurn
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: applyToolEvent() and churn', () => {
  it('counts tool calls and failures', () => {
    const s = {};
    applyToolEvent(s, 'Bash', { command: 'ls' }, { exit_code: 0 });
    applyToolEvent(s, 'Bash', { command: 'nope' }, { exit_code: 1 });
    assert.strictEqual(s.toolCalls, 2);
    assert.strictEqual(s.toolFailures, 1);
  });

  it('detects edit -> fail -> re-edit churn on the same file', () => {
    const s = {};
    // edit ok
    applyToolEvent(s, 'Edit', { file_path: '/x.js' }, { success: true });
    // edit fails
    applyToolEvent(s, 'Edit', { file_path: '/x.js' }, { error: 'no match' });
    // re-edit after failure => +1 churn
    applyToolEvent(s, 'Edit', { file_path: '/x.js' }, { success: true });
    assert.strictEqual(totalChurn(s), 1);
    assert.strictEqual(s.fileEdits['/x.js'].edits, 3);
    assert.strictEqual(s.fileEdits['/x.js'].fails, 1);
  });

  it('does not count churn across different files', () => {
    const s = {};
    applyToolEvent(s, 'Edit', { file_path: '/a.js' }, { error: 'x' });
    applyToolEvent(s, 'Edit', { file_path: '/b.js' }, { success: true });
    assert.strictEqual(totalChurn(s), 0);
  });

  it('accumulates multiple churn loops', () => {
    const s = {};
    applyToolEvent(s, 'Edit', { file_path: '/a' }, { error: 'x' });
    applyToolEvent(s, 'Edit', { file_path: '/a' }, { error: 'y' }); // re-edit after fail (+1)
    applyToolEvent(s, 'Edit', { file_path: '/a' }, { success: true }); // re-edit after fail (+1)
    assert.strictEqual(totalChurn(s), 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: parseTranscript (transcript JSONL — issue #11008 caveat)
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: parseTranscript()', () => {
  it('returns nulls for empty / non-string input', () => {
    assert.strictEqual(parseTranscript('').totalTokens, null);
    assert.strictEqual(parseTranscript(null).totalTokens, null);
    assert.strictEqual(parseTranscript(42).totalTokens, null);
  });

  it('sums usage across assistant messages', () => {
    const jsonl = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', usage: { input_tokens: 100, output_tokens: 50 } } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', usage: { input_tokens: 200, output_tokens: 25 } } }),
    ].join('\n');
    const r = parseTranscript(jsonl);
    assert.strictEqual(r.inputTokens, 300);
    assert.strictEqual(r.outputTokens, 75);
    assert.strictEqual(r.totalTokens, 375);
    assert.strictEqual(r.userPrompts, 1);
  });

  it('includes cache tokens in input total', () => {
    const jsonl = JSON.stringify({
      type: 'assistant',
      message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, output_tokens: 0 } },
    });
    const r = parseTranscript(jsonl);
    assert.strictEqual(r.inputTokens, 105);
  });

  it('does not count tool_result-only user turns as prompts', () => {
    const jsonl = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'real prompt' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1, output_tokens: 1 } } }),
    ].join('\n');
    assert.strictEqual(parseTranscript(jsonl).userPrompts, 1);
  });

  it('degrades to null tokens when no usage present', () => {
    const jsonl = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } });
    const r = parseTranscript(jsonl);
    assert.strictEqual(r.totalTokens, null);
    assert.strictEqual(r.userPrompts, 1);
  });

  it('skips malformed lines without throwing', () => {
    const jsonl = ['not json', '{bad', JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 5, output_tokens: 5 } } })].join('\n');
    const r = parseTranscript(jsonl);
    assert.strictEqual(r.totalTokens, 10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: buildSessionRecord
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: buildSessionRecord()', () => {
  it('computes failure_rate and tokens_per_task', () => {
    const state = { toolCalls: 10, toolFailures: 3, fileEdits: {}, stopEvents: 1 };
    const rec = buildSessionRecord(state, { totalTokens: 6000, userPrompts: 3 }, { model: 'claude-x', cc_version: '2.1.0', session_id: 's1' });
    assert.strictEqual(rec.failure_rate, 0.3);
    assert.strictEqual(rec.tokens_per_task, 2000);
    assert.strictEqual(rec.model, 'claude-x');
    assert.strictEqual(rec.stop_events, 1);
  });

  it('sets tokens_per_task null when tokens unknown', () => {
    const rec = buildSessionRecord({ toolCalls: 1 }, { totalTokens: null, userPrompts: 0 }, {});
    assert.strictEqual(rec.tokens_per_task, null);
    assert.strictEqual(rec.total_tokens, null);
  });

  it('handles zero tool calls without dividing by zero', () => {
    const rec = buildSessionRecord({ toolCalls: 0 }, { totalTokens: 100, userPrompts: 0 }, {});
    assert.strictEqual(rec.failure_rate, 0);
    assert.strictEqual(rec.tokens_per_task, null);
  });

  it('falls back to unknown model/version', () => {
    const rec = buildSessionRecord({ toolCalls: 1 }, { totalTokens: null }, {});
    assert.strictEqual(rec.model, 'unknown');
    assert.strictEqual(rec.cc_version, 'unknown');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: extractMeta
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: extractMeta()', () => {
  it('reads model + version from payload', () => {
    const m = extractMeta({ model: 'claude-x-2', cc_version: '2.2.0', session_id: 's', cwd: '/tmp' });
    assert.strictEqual(m.model, 'claude-x-2');
    assert.strictEqual(m.cc_version, '2.2.0');
    assert.strictEqual(m.session_id, 's');
  });
  it('defaults to unknown', () => {
    const m = extractMeta({});
    assert.strictEqual(m.model, 'unknown');
    assert.strictEqual(m.cc_version, 'unknown');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: mean / sparkline
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: mean() and sparkline()', () => {
  it('mean ignores non-numbers', () => assert.strictEqual(mean([1, 2, 3, NaN, null, undefined]), 2));
  it('mean returns null for empty', () => assert.strictEqual(mean([NaN, null]), null));
  it('sparkline renders one char per point', () => {
    const s = sparkline([1, 2, 3, 4]);
    assert.strictEqual([...s].length, 4);
  });
  it('sparkline uses low char for min and high for max', () => {
    const s = sparkline([0, 10]);
    assert.strictEqual([...s][0], '▁');
    assert.strictEqual([...s][1], '█');
  });
  it('sparkline handles empty series', () => assert.strictEqual(sparkline([]), ''));
  it('sparkline handles all-equal series', () => {
    const s = sparkline([5, 5, 5]);
    assert.strictEqual([...s].length, 3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: detectShifts (the statistical shift detector)
// ─────────────────────────────────────────────────────────────────────────────

function sess(model, failure_rate, tokens_per_task) {
  return { model, failure_rate, tokens_per_task, edit_churn: 0 };
}

describe('Unit: detectShifts()', () => {
  it('returns [] with a single model group', () => {
    const recs = [sess('a', 0.1, 1000), sess('a', 0.1, 1000), sess('a', 0.1, 1000)];
    assert.deepStrictEqual(detectShifts(recs), []);
  });

  it('returns [] when groups are too small', () => {
    const recs = [sess('a', 0.1, 1000), sess('b', 0.5, 3000)];
    assert.deepStrictEqual(detectShifts(recs, { minPerGroup: 3 }), []);
  });

  it('flags a failure-rate spike across a model rollout', () => {
    const recs = [
      sess('claude-x-1', 0.10, 1000), sess('claude-x-1', 0.11, 1000), sess('claude-x-1', 0.09, 1000),
      sess('claude-x-2', 0.20, 1000), sess('claude-x-2', 0.19, 1000), sess('claude-x-2', 0.21, 1000),
    ];
    const shifts = detectShifts(recs);
    const fail = shifts.find((s) => s.metric === 'failure_rate');
    assert.ok(fail, 'expected a failure_rate shift');
    assert.strictEqual(fail.direction, 'up');
    assert.strictEqual(fail.toModel, 'claude-x-2');
    assert.strictEqual(fail.fromModel, 'claude-x-1');
    assert.ok(fail.relChange > 0.5);
  });

  it('flags a tokens-per-task shift', () => {
    const recs = [
      sess('m1', 0.1, 1000), sess('m1', 0.1, 1000), sess('m1', 0.1, 1000),
      sess('m2', 0.1, 2000), sess('m2', 0.1, 2000), sess('m2', 0.1, 2000),
    ];
    const shifts = detectShifts(recs);
    const tok = shifts.find((s) => s.metric === 'tokens_per_task');
    assert.ok(tok);
    assert.ok(Math.abs(tok.relChange - 1.0) < 1e-9);
  });

  it('does not flag sub-threshold noise', () => {
    const recs = [
      sess('m1', 0.10, 1000), sess('m1', 0.10, 1000), sess('m1', 0.10, 1000),
      sess('m2', 0.11, 1050), sess('m2', 0.11, 1050), sess('m2', 0.11, 1050),
    ];
    assert.deepStrictEqual(detectShifts(recs), []);
  });

  it('compares only the two newest model groups', () => {
    const recs = [
      sess('old', 0.9, 9000), sess('old', 0.9, 9000), sess('old', 0.9, 9000),
      sess('m1', 0.10, 1000), sess('m1', 0.10, 1000), sess('m1', 0.10, 1000),
      sess('m2', 0.10, 1000), sess('m2', 0.10, 1000), sess('m2', 0.10, 1000),
    ];
    // m1 -> m2 is flat, so no shift despite huge 'old' values.
    assert.deepStrictEqual(detectShifts(recs), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: renderTrendCard
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: renderTrendCard()', () => {
  it('returns null below the minimum session count', () => {
    const recs = Array.from({ length: MIN_SESSIONS_FOR_TREND - 1 }, () => sess('m', 0.1, 1000));
    assert.strictEqual(renderTrendCard(recs), null);
  });

  it('renders a card once enough sessions exist', () => {
    const recs = Array.from({ length: MIN_SESSIONS_FOR_TREND }, () => sess('m', 0.1, 1000));
    const card = renderTrendCard(recs);
    assert.ok(card);
    assert.ok(card.includes('NERF RECEIPTS'));
    assert.ok(card.includes('failure rate'));
    assert.ok(card.includes('tokens/task'));
  });

  it('surfaces the shift warning line in the card', () => {
    const recs = [
      ...Array.from({ length: 4 }, () => sess('claude-x-1', 0.10, 1000)),
      ...Array.from({ length: 4 }, () => sess('claude-x-2', 0.30, 1000)),
    ];
    const card = renderTrendCard(recs);
    assert.ok(card.includes('⚠'));
    assert.ok(card.includes('claude-x-2'));
    assert.ok(card.toLowerCase().includes("not in your head"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: stdin/stdout hook flow (hermetic temp HOME)
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration: event routing', () => {
  it('PostToolUse persists in-flight state without emitting decisions', async () => {
    const home = makeTempHome();
    const { code, output } = await runHook({
      hook_event_name: 'PostToolUse',
      session_id: 'int1',
      tool_name: 'Bash',
      tool_input: { command: 'false' },
      tool_response: { exit_code: 1 },
    }, home);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
    const statePath = path.join(home, '.claude', 'nerf-receipts', 'sessions', 'int1.json');
    assert.ok(fs.existsSync(statePath), 'expected per-session state file');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.strictEqual(state.toolCalls, 1);
    assert.strictEqual(state.toolFailures, 1);
  });

  it('accumulates across multiple PostToolUse events then finalizes on SessionEnd', async () => {
    const home = makeTempHome();
    const sid = 'int2';
    await runHook({ hook_event_name: 'PostToolUse', session_id: sid, tool_name: 'Bash', tool_input: { command: 'a' }, tool_response: { exit_code: 0 } }, home);
    await runHook({ hook_event_name: 'PostToolUse', session_id: sid, tool_name: 'Bash', tool_input: { command: 'b' }, tool_response: { exit_code: 1 } }, home);
    await runHook({ hook_event_name: 'Stop', session_id: sid }, home);

    const { output } = await runHook({ hook_event_name: 'SessionEnd', session_id: sid, model: 'claude-x', cc_version: '2.1.0' }, home);
    assert.deepStrictEqual(output, {});

    const ledger = readLedgerFile(home);
    assert.strictEqual(ledger.length, 1);
    const rec = ledger[0];
    assert.strictEqual(rec.tool_calls, 2);
    assert.strictEqual(rec.tool_failures, 1);
    assert.strictEqual(rec.failure_rate, 0.5);
    assert.strictEqual(rec.stop_events, 1);
    assert.strictEqual(rec.model, 'claude-x');

    // in-flight state cleared after finalization
    const statePath = path.join(home, '.claude', 'nerf-receipts', 'sessions', `${sid}.json`);
    assert.ok(!fs.existsSync(statePath));
  });

  it('SessionEnd on an empty session does not pollute the ledger', async () => {
    const home = makeTempHome();
    const { output } = await runHook({ hook_event_name: 'SessionEnd', session_id: 'empty' }, home);
    assert.deepStrictEqual(output, {});
    assert.strictEqual(readLedgerFile(home).length, 0);
  });

  it('SessionEnd parses tokens from a real transcript file', async () => {
    const home = makeTempHome();
    const sid = 'int-tok';
    const transcript = path.join(home, 'transcript.jsonl');
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'do a thing' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'and another' } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 3000, output_tokens: 1000 } } }),
    ].join('\n'));

    await runHook({ hook_event_name: 'PostToolUse', session_id: sid, tool_name: 'Read', tool_input: { file_path: '/x' }, tool_response: { stdout: 'ok' } }, home);
    await runHook({ hook_event_name: 'SessionEnd', session_id: sid, transcript_path: transcript, model: 'claude-x' }, home);

    const rec = readLedgerFile(home)[0];
    assert.strictEqual(rec.total_tokens, 4000);
    assert.strictEqual(rec.prompts, 2);
    assert.strictEqual(rec.tokens_per_task, 2000);
  });

  it('SessionStart returns {} with too few sessions, then a card once enough exist', async () => {
    const home = makeTempHome();
    // Seed a ledger directly with enough sessions across two models.
    const ledgerFile = ledgerPath(home);
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    const rows = [
      ...Array.from({ length: 4 }, () => sess('claude-x-1', 0.10, 1000)),
      ...Array.from({ length: 4 }, () => sess('claude-x-2', 0.40, 1000)),
    ].map((r) => JSON.stringify(r));
    fs.writeFileSync(ledgerFile, rows.join('\n') + '\n');

    const { code, output } = await runHook({ hook_event_name: 'SessionStart', session_id: 'ss1' }, home);
    assert.strictEqual(code, 0);
    assert.strictEqual(output.hookSpecificOutput?.hookEventName, 'SessionStart');
    const ctx = output.hookSpecificOutput?.additionalContext;
    assert.ok(typeof ctx === 'string' && ctx.includes('NERF RECEIPTS'));
    assert.ok(ctx.includes('⚠'));
  });

  it('SessionStart returns {} when the ledger is empty', async () => {
    const home = makeTempHome();
    const { output } = await runHook({ hook_event_name: 'SessionStart', session_id: 'ss-empty' }, home);
    assert.deepStrictEqual(output, {});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: defensive / malformed input
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration: defensive handling', () => {
  it('returns {} for invalid JSON', async () => {
    const { code, output } = await runHook('not json at all');
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });

  it('returns {} for empty stdin', async () => {
    const { code, output } = await runHook('');
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });

  it('returns {} for an unrecognized event', async () => {
    const { output } = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash' });
    assert.deepStrictEqual(output, {});
  });

  it('returns {} for a JSON payload with no event name', async () => {
    const { output } = await runHook({ foo: 'bar' });
    assert.deepStrictEqual(output, {});
  });

  it('does not throw on a PostToolUse with missing tool fields', async () => {
    const { code, output } = await runHook({ hook_event_name: 'PostToolUse', session_id: 'defensive' });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });
});
