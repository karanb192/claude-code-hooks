#!/usr/bin/env node
/**
 * Tests for standup-autopilot.js
 *
 * Run: node --test hook-scripts/tests/session-end/standup-autopilot.test.js
 * Or:  npm test
 *
 * Hermetic: unit tests are pure (no HOME touched); integration tests spawn the
 * script with a fresh temp HOME so the real home dir is never polluted.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('../../session-end/standup-autopilot.js');
const {
  messageText,
  role,
  extractToolEvents,
  parseTestCounts,
  buildDigest,
  testSummary,
  summarizeDay,
  renderCard,
  renderSlack,
  renderResumeContext,
} = mod;

const SCRIPT_PATH = path.join(__dirname, '../../session-end/standup-autopilot.js');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers to build fake transcript messages (Claude Code JSONL shape).
// ─────────────────────────────────────────────────────────────────────────────

function userMsg(text) {
  return { type: 'user', message: { role: 'user', content: text } };
}
function assistantText(text) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
}
function toolUse(name, input) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] } };
}
function toolResult(text, isError = false) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', is_error: isError, content: text }] } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit: text / role extraction
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: messageText / role', () => {
  it('reads plain string content', () => {
    assert.strictEqual(messageText(userMsg('hello world')), 'hello world');
  });
  it('reads array text blocks', () => {
    assert.strictEqual(messageText(assistantText('did a thing')), 'did a thing');
  });
  it('returns empty for garbage', () => {
    assert.strictEqual(messageText(null), '');
    assert.strictEqual(messageText(42), '');
    assert.strictEqual(messageText({}), '');
  });
  it('reads role from nested message', () => {
    assert.strictEqual(role(userMsg('x')), 'user');
    assert.strictEqual(role(assistantText('x')), 'assistant');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: extractToolEvents
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: extractToolEvents', () => {
  it('extracts tool_use and tool_result in order', () => {
    const msgs = [
      toolUse('Bash', { command: 'npm test' }),
      toolResult('12 passing'),
    ];
    const ev = extractToolEvents(msgs);
    assert.strictEqual(ev.length, 2);
    assert.strictEqual(ev[0].kind, 'use');
    assert.strictEqual(ev[0].name, 'Bash');
    assert.strictEqual(ev[0].input.command, 'npm test');
    assert.strictEqual(ev[1].kind, 'result');
    assert.strictEqual(ev[1].text, '12 passing');
  });
  it('flags error results', () => {
    const ev = extractToolEvents([toolResult('boom', true)]);
    assert.strictEqual(ev[0].is_error, true);
  });
  it('ignores non-array content', () => {
    assert.deepStrictEqual(extractToolEvents([userMsg('plain string')]), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: parseTestCounts
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: parseTestCounts', () => {
  it('parses passing count', () => {
    assert.deepStrictEqual(parseTestCounts('14 passing'), { passed: 14, failed: 0 });
  });
  it('parses passing + failing', () => {
    assert.deepStrictEqual(parseTestCounts('10 passing\n2 failing'), { passed: 10, failed: 2 });
  });
  it('parses jest style passed', () => {
    assert.deepStrictEqual(parseTestCounts('Tests: 5 passed'), { passed: 5, failed: 0 });
  });
  it('parses pytest summary passed + failed', () => {
    assert.deepStrictEqual(parseTestCounts('3 passed, 1 failed in 0.42s'), { passed: 3, failed: 1 });
  });
  it('records a go-test FAIL verdict when no numeric counts', () => {
    const r = parseTestCounts('--- FAIL: TestFoo (0.00s)\nFAIL\texample.com/pkg\t0.012s');
    assert.strictEqual(r.failed, 1);
    assert.strictEqual(r.passed, 0);
    assert.strictEqual(r.verdict, 'fail');
  });
  it('records a go-test ok verdict when no numeric counts', () => {
    const r = parseTestCounts('ok  \texample.com/pkg\t0.008s');
    assert.strictEqual(r.passed, 1);
    assert.strictEqual(r.failed, 0);
    assert.strictEqual(r.verdict, 'pass');
  });
  it('returns null when no counts', () => {
    assert.strictEqual(parseTestCounts('nothing here'), null);
    assert.strictEqual(parseTestCounts(''), null);
    assert.strictEqual(parseTestCounts(null), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: buildDigest — the core
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: buildDigest', () => {
  it('captures task summary from last assistant message', () => {
    const msgs = [
      userMsg('please refactor auth'),
      assistantText('Refactored the auth module and wired up sessions.'),
    ];
    const d = buildDigest(msgs, { session_id: 's1', cwd: '/home/me/myrepo' });
    assert.ok(d.task.includes('Refactored the auth module'));
    assert.strictEqual(d.repo, 'myrepo');
    assert.strictEqual(d.session_id, 's1');
  });

  it('falls back to first user prompt when no assistant text', () => {
    const d = buildDigest([userMsg('add a login page')], { session_id: 's2' });
    assert.ok(d.task.includes('add a login page'));
  });

  it('detects tests run with passing counts', () => {
    const msgs = [
      toolUse('Bash', { command: 'npm test' }),
      toolResult('14 passing\n0 failing'),
      assistantText('All green.'),
    ];
    const d = buildDigest(msgs, { session_id: 's3' });
    assert.strictEqual(d.tests.length, 1);
    assert.strictEqual(d.tests[0].passed, 14);
    assert.strictEqual(d.tests[0].failed, 0);
  });

  it('surfaces failing tests as blockers', () => {
    const msgs = [
      toolUse('Bash', { command: 'npm test' }),
      toolResult('3 passing\n2 failing', true),
    ];
    const d = buildDigest(msgs, { session_id: 's4' });
    assert.ok(d.blockers.some((b) => /tests failing/.test(b)), `blockers: ${JSON.stringify(d.blockers)}`);
  });

  it('surfaces a go-test FAIL (no numeric counts) as a failing-tests blocker', () => {
    const msgs = [
      toolUse('Bash', { command: 'go test ./...' }),
      toolResult('--- FAIL: TestThing (0.00s)\nFAIL\texample.com/pkg\t0.01s', true),
    ];
    const d = buildDigest(msgs, { session_id: 'sgo' });
    assert.strictEqual(d.tests.length, 1);
    assert.strictEqual(d.tests[0].failed, 1);
    assert.ok(d.blockers.some((b) => /tests failing/.test(b)), `blockers: ${JSON.stringify(d.blockers)}`);
  });

  it('extracts PR numbers from urls and #refs', () => {
    const msgs = [
      assistantText('Opened https://github.com/acme/app/pull/412 and referenced PR #77.'),
    ];
    const d = buildDigest(msgs, { session_id: 's5' });
    assert.ok(d.prs.includes('#412'));
    assert.ok(d.prs.includes('#77'));
  });

  it('captures an unresolved error as a blocker', () => {
    const msgs = [
      toolUse('Bash', { command: 'node build.js' }),
      toolResult('Error: ENOENT missing config file', true),
    ];
    const d = buildDigest(msgs, { session_id: 's6' });
    assert.ok(d.blockers.some((b) => /ENOENT/.test(b)), `blockers: ${JSON.stringify(d.blockers)}`);
  });

  it('does NOT flag an error that was later resolved', () => {
    const msgs = [
      toolUse('Bash', { command: 'node build.js' }),
      toolResult('Error: build failed', true),
      toolUse('Bash', { command: 'node build.js' }),
      toolResult('build ok, output written'),
    ];
    const d = buildDigest(msgs, { session_id: 's7' });
    assert.strictEqual(d.blockers.length, 0, `blockers: ${JSON.stringify(d.blockers)}`);
  });

  it('handles empty transcript gracefully', () => {
    const d = buildDigest([], { session_id: 's8', cwd: '/x/y' });
    assert.strictEqual(d.task, '');
    assert.deepStrictEqual(d.tests, []);
    assert.deepStrictEqual(d.prs, []);
    assert.deepStrictEqual(d.blockers, []);
    assert.strictEqual(d.repo, 'y');
  });

  it('caps blockers at 5', () => {
    const msgs = [];
    for (let i = 0; i < 10; i++) {
      msgs.push(toolUse('Bash', { command: `cmd${i}` }));
      msgs.push(toolResult(`Error number ${i} occurred`, true));
    }
    const d = buildDigest(msgs, { session_id: 's9' });
    assert.ok(d.blockers.length <= 5, `got ${d.blockers.length}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: rendering
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: testSummary', () => {
  it('summarizes pass counts', () => {
    assert.strictEqual(testSummary([{ passed: 14, failed: 0, exitError: false }]), 'tests 14/14');
  });
  it('marks failing', () => {
    assert.ok(/failing/.test(testSummary([{ passed: 3, failed: 2, exitError: false }])));
  });
  it('empty for no tests', () => {
    assert.strictEqual(testSummary([]), '');
  });
});

describe('Unit: summarizeDay / renderCard / renderSlack', () => {
  const rows = [
    { repo: 'app', task: 'shipped auth refactor', prs: ['#412'], blockers: [], tests: [{ passed: 14, failed: 0 }] },
    { repo: 'payments', task: 'debugged CI', prs: [], blockers: ['flaky CI in payments'], tests: [] },
  ];

  it('groups by repo', () => {
    const s = summarizeDay(rows);
    assert.strictEqual(s.length, 2);
    const payments = s.find((x) => x.repo === 'payments');
    assert.ok(payments.blockers.includes('flaky CI in payments'));
  });

  it('renderCard includes repos, PR and blocker', () => {
    const card = renderCard(rows, '2026-06-18');
    assert.ok(card.includes('2026-06-18'));
    assert.ok(card.includes('app'));
    assert.ok(card.includes('#412'));
    assert.ok(card.includes('flaky CI in payments'));
    assert.ok(card.includes('STANDUP'));
  });

  it('renderCard handles empty day', () => {
    const card = renderCard([], '2026-06-18');
    assert.ok(card.includes('no sessions'));
  });

  it('renderSlack produces mrkdwn with blockers section', () => {
    const s = renderSlack(rows, '2026-06-18');
    assert.ok(s.includes('*Standup'));
    assert.ok(s.includes('*Blocked:*'));
    assert.ok(s.includes('flaky CI'));
  });

  it('renderResumeContext lists blockers', () => {
    const ctx = renderResumeContext(rows);
    assert.ok(ctx.includes('flaky CI in payments'));
    assert.ok(/Unresolved blockers/.test(ctx));
  });

  it('renderResumeContext empty when no blockers', () => {
    const ctx = renderResumeContext([{ repo: 'app', task: 't', prs: [], blockers: [], tests: [] }]);
    assert.strictEqual(ctx, '');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ledger tests with a temp HOME (hermetic)
// ─────────────────────────────────────────────────────────────────────────────

describe('Ledger: upsert/read with temp HOME', () => {
  let tmpHome;
  let origHome;

  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'standup-ledger-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });
  after(() => {
    process.env.HOME = origHome;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  it('upserts by session_id (latest wins)', () => {
    const date = '2026-06-18';
    mod.upsertLedger({ session_id: 'A', repo: 'app', task: 'v1', prs: [], blockers: [], tests: [] }, date);
    mod.upsertLedger({ session_id: 'B', repo: 'pay', task: 'x', prs: [], blockers: [], tests: [] }, date);
    mod.upsertLedger({ session_id: 'A', repo: 'app', task: 'v2', prs: [], blockers: [], tests: [] }, date);
    const rows = mod.readLedger(date);
    assert.strictEqual(rows.length, 2);
    const a = rows.find((r) => r.session_id === 'A');
    assert.strictEqual(a.task, 'v2');
  });

  it('readLedger returns [] for missing date', () => {
    assert.deepStrictEqual(mod.readLedger('1999-01-01'), []);
  });

  it('findPreviousLedgerDate finds the written day', () => {
    const prev = mod.findPreviousLedgerDate('2026-06-19', 7);
    assert.strictEqual(prev, '2026-06-18');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: spawn the script with temp HOME
// ─────────────────────────────────────────────────────────────────────────────

function runHook(payload, extraArgs = [], home) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SCRIPT_PATH, ...extraArgs], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', reject);
    if (payload !== null) child.stdin.write(typeof payload === 'string' ? payload : JSON.stringify(payload));
    child.stdin.end();
  });
}

describe('Integration: spawn with temp HOME', () => {
  let tmpHome;
  before(() => { tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'standup-int-')); });
  after(() => { try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {} });

  it('Stop event persists a digest and prints {}', async () => {
    // Write a fake transcript.
    const tp = path.join(tmpHome, 'transcript.jsonl');
    const lines = [
      userMsg('refactor the login flow'),
      toolUse('Bash', { command: 'npm test' }),
      toolResult('14 passing\n0 failing'),
      assistantText('Login flow refactored, opened https://github.com/acme/app/pull/412'),
    ].map((m) => JSON.stringify(m));
    fs.writeFileSync(tp, lines.join('\n') + '\n');

    const { code, stdout } = await runHook({
      hook_event_name: 'Stop',
      session_id: 'sess-int-1',
      cwd: '/work/acme-app',
      transcript_path: tp,
    }, [], tmpHome);

    assert.strictEqual(code, 0);
    assert.deepStrictEqual(JSON.parse(stdout.trim()), {});

    // Ledger file should now exist and contain our session.
    const dir = path.join(tmpHome, '.claude', 'standup');
    const files = fs.readdirSync(dir);
    assert.ok(files.length >= 1);
    const content = fs.readFileSync(path.join(dir, files[0]), 'utf-8');
    const row = JSON.parse(content.trim().split('\n')[0]);
    assert.strictEqual(row.session_id, 'sess-int-1');
    assert.strictEqual(row.repo, 'acme-app');
    assert.ok(row.prs.includes('#412'));
    assert.strictEqual(row.tests[0].passed, 14);
  });

  it('SessionStart injects yesterday blockers via additionalContext', async () => {
    // Seed a prior-day ledger with a blocker.
    const dir = path.join(tmpHome, '.claude', 'standup');
    fs.mkdirSync(dir, { recursive: true });
    const y = mod.today(new Date(Date.now() - 86400000));
    fs.writeFileSync(
      path.join(dir, `${y}.jsonl`),
      JSON.stringify({ session_id: 'z', repo: 'payments', task: 'debug CI', prs: [], blockers: ['flaky CI in payments'], tests: [] }) + '\n'
    );

    const { code, stdout } = await runHook({
      hook_event_name: 'SessionStart',
      session_id: 'start-1',
      source: 'startup',
    }, [], tmpHome);

    assert.strictEqual(code, 0);
    const out = JSON.parse(stdout.trim());
    assert.strictEqual(out.hookSpecificOutput?.hookEventName, 'SessionStart');
    assert.ok(out.hookSpecificOutput?.additionalContext.includes('flaky CI in payments'));
  });

  it('SessionStart with no prior ledger is a no-op', async () => {
    const freshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'standup-fresh-'));
    try {
      const { code, stdout } = await runHook({
        hook_event_name: 'SessionStart',
        session_id: 'start-2',
      }, [], freshHome);
      assert.strictEqual(code, 0);
      assert.deepStrictEqual(JSON.parse(stdout.trim()), {});
    } finally {
      fs.rmSync(freshHome, { recursive: true, force: true });
    }
  });

  it('--card CLI renders a standup card from the ledger', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'standup-card-'));
    try {
      const dir = path.join(home, '.claude', 'standup');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, '2026-06-18.jsonl'),
        JSON.stringify({ session_id: 'q', repo: 'app', task: 'shipped auth', prs: ['#412'], blockers: [], tests: [{ passed: 14, failed: 0 }] }) + '\n'
      );
      const { code, stdout } = await runHook(null, ['--card', '2026-06-18'], home);
      assert.strictEqual(code, 0);
      assert.ok(stdout.includes('STANDUP'));
      assert.ok(stdout.includes('#412'));
      assert.ok(stdout.includes('app'));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('returns {} for malformed JSON input', async () => {
    const { code, stdout } = await runHook('not json at all', [], tmpHome);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(JSON.parse(stdout.trim()), {});
  });

  it('returns {} for empty input', async () => {
    const { code, stdout } = await runHook('', [], tmpHome);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(JSON.parse(stdout.trim()), {});
  });

  it('returns {} for unregistered event', async () => {
    const { code, stdout } = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }, [], tmpHome);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(JSON.parse(stdout.trim()), {});
  });

  it('Stop with missing transcript_path still persists an (empty) digest', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'standup-notp-'));
    try {
      const { code, stdout } = await runHook({
        hook_event_name: 'SessionEnd',
        session_id: 'no-tp',
        cwd: '/work/thing',
        transcript_path: '/nonexistent/transcript.jsonl',
      }, [], home);
      assert.strictEqual(code, 0);
      assert.deepStrictEqual(JSON.parse(stdout.trim()), {});
      const dir = path.join(home, '.claude', 'standup');
      const files = fs.readdirSync(dir);
      assert.ok(files.length >= 1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
