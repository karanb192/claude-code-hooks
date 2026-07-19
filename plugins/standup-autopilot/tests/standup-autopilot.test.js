#!/usr/bin/env node
/**
 * Tests for standup-autopilot.js
 *
 * Run: node --test plugins/standup-autopilot/tests/standup-autopilot.test.js
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

const mod = require('../standup-autopilot.js');
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

const SCRIPT_PATH = path.join(__dirname, '../standup-autopilot.js');

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
  it('does not count compile-error prose as failing tests', () => {
    assert.strictEqual(parseTestCounts('2 modules failed to compile'), null);
    assert.strictEqual(parseTestCounts('Compilation failed with errors'), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: redactSecrets — transcript text must not leak credentials into ledgers
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: redactSecrets', () => {
  const { redactSecrets } = mod;

  it('redacts GitHub tokens', () => {
    const out = redactSecrets('export GITHUB_TOKEN=ghp_abcdefghij1234567890KLMNOP && npm test');
    assert.ok(!out.includes('ghp_abcdefghij'), out);
    assert.ok(out.includes('[REDACTED]'), out);
    assert.ok(out.includes('npm test'), out);
  });
  it('redacts sk- style API keys', () => {
    const out = redactSecrets('using key sk-ant-abcdefghijklmnop1234');
    assert.ok(!out.includes('sk-ant-abcdefghijklmnop1234'), out);
  });
  it('redacts key=value secrets', () => {
    const out = redactSecrets('login with token=supersecret123 now');
    assert.ok(!out.includes('supersecret123'), out);
    assert.ok(out.includes('token=[REDACTED]'), out);
  });
  it('redacts JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
    assert.ok(!redactSecrets(`saw ${jwt} in logs`).includes(jwt));
  });
  it('redacts AWS access key ids', () => {
    assert.ok(!redactSecrets('creds AKIAIOSFODNN7EXAMPLE found').includes('AKIAIOSFODNN7EXAMPLE'));
  });
  it('leaves benign text untouched', () => {
    const s = 'ran npm test, 14 passing, refactored the auth module';
    assert.strictEqual(redactSecrets(s), s);
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

  it('pairs test results by tool_use_id when tool calls run in parallel', () => {
    const msgs = [
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'tu_ls', name: 'Bash', input: { command: 'ls -la' } },
        { type: 'tool_use', id: 'tu_test', name: 'Bash', input: { command: 'npm test' } },
      ] } },
      // Results arrive out of order: ls result lands first.
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_ls', content: 'total 0' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_test', content: '7 passing\n1 failing' }] } },
    ];
    const d = buildDigest(msgs, { session_id: 's10' });
    assert.strictEqual(d.tests.length, 1);
    assert.strictEqual(d.tests[0].passed, 7);
    assert.strictEqual(d.tests[0].failed, 1);
  });

  it('does NOT flag incidental "failed" prose in a clean tool result', () => {
    const msgs = [
      toolUse('Read', { file_path: '/docs/postmortem.md' }),
      toolResult('the deploy failed last week and we could not find the cause'),
    ];
    const d = buildDigest(msgs, { session_id: 's11' });
    assert.strictEqual(d.blockers.length, 0, `blockers: ${JSON.stringify(d.blockers)}`);
  });

  it('still flags a strong error signature even when is_error is false', () => {
    const msgs = [
      toolUse('Bash', { command: 'node run.js' }),
      toolResult("TypeError: cannot read properties of undefined (reading 'foo')"),
    ];
    const d = buildDigest(msgs, { session_id: 's12' });
    assert.strictEqual(d.blockers.length, 1, `blockers: ${JSON.stringify(d.blockers)}`);
  });

  it('redacts secrets from test commands and blocker snippets', () => {
    const token = 'ghp_' + 'a'.repeat(30);
    const msgs = [
      toolUse('Bash', { command: `GITHUB_TOKEN=${token} npm test` }),
      toolResult('1 failing', true),
      toolUse('Bash', { command: 'node deploy.js' }),
      toolResult('Error: auth rejected for token=abc123secretvalue', true),
    ];
    const d = buildDigest(msgs, { session_id: 's13' });
    const persisted = JSON.stringify(d);
    assert.ok(!persisted.includes(token), persisted);
    assert.ok(!persisted.includes('abc123secretvalue'), persisted);
    assert.ok(d.tests[0].command.includes('npm test'), d.tests[0].command);
  });

  it('records branch and diffstat from ctx', () => {
    const d = buildDigest([], { session_id: 's14', branch: 'feat/x', diffstat: '2 files changed' });
    assert.strictEqual(d.branch, 'feat/x');
    assert.strictEqual(d.diffstat, '2 files changed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: dates — local calendar days, timezone-safe arithmetic
// ─────────────────────────────────────────────────────────────────────────────

function nodeEval(expr, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', expr], { env: { ...process.env, ...env } });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', () => resolve(stdout.trim()));
    child.on('error', reject);
  });
}

describe('Unit: today() / shiftDate — local time, not UTC', () => {
  const expr = (iso) =>
    `const m=require(${JSON.stringify(SCRIPT_PATH)});process.stdout.write(m.today(new Date('${iso}')))`;

  it('files an evening session under the LOCAL date east of UTC', async () => {
    // 20:00 UTC on Jun 18 is already Jun 19 at UTC+14.
    const out = await nodeEval(expr('2026-06-18T20:00:00Z'), { TZ: 'Etc/GMT-14' });
    assert.strictEqual(out, '2026-06-19');
  });

  it('files an early-UTC session under the LOCAL date west of UTC', async () => {
    // 05:00 UTC on Jun 19 is still Jun 18 at UTC-10.
    const out = await nodeEval(expr('2026-06-19T05:00:00Z'), { TZ: 'Etc/GMT+10' });
    assert.strictEqual(out, '2026-06-18');
  });

  it('shiftDate crosses month and year boundaries', () => {
    assert.strictEqual(mod.shiftDate('2026-03-01', -1), '2026-02-28');
    assert.strictEqual(mod.shiftDate('2026-01-01', -1), '2025-12-31');
    assert.strictEqual(mod.shiftDate('2026-06-15', -3), '2026-06-12');
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

  it('renderResumeContext caps injection at 8 blockers with a "more" marker', () => {
    const blockers = Array.from({ length: 20 }, (_, i) => `blocker number ${i}`);
    const ctx = renderResumeContext([{ repo: 'app', task: 't', prs: [], blockers, tests: [] }]);
    const bullets = ctx.split('\n').filter((l) => l.startsWith('- ')).length;
    assert.ok(bullets <= 9, ctx); // 8 blockers + 1 "more" line
    assert.ok(/and 12 more/.test(ctx), ctx);
    assert.ok(!ctx.includes('blocker number 19'), ctx);
  });

  it('renderCard surfaces diffstat', () => {
    const card = renderCard(
      [{ repo: 'app', task: 'work', prs: [], blockers: [], tests: [], diffstat: '3 files changed, 42 insertions(+)' }],
      '2026-06-18'
    );
    assert.ok(card.includes('3 files changed'), card);
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

  it('is append-only on disk: upserts never rewrite (no lost-update window)', () => {
    const date = '2026-06-20';
    mod.upsertLedger({ session_id: 'A', task: 'v1' }, date);
    mod.upsertLedger({ session_id: 'B', task: 'x' }, date);
    mod.upsertLedger({ session_id: 'A', task: 'v2' }, date);
    const rawLines = fs.readFileSync(mod.ledgerPath(date), 'utf-8').trim().split('\n');
    assert.strictEqual(rawLines.length, 3, 'every upsert must append a snapshot line');
    const rows = mod.readLedger(date);
    assert.strictEqual(rows.length, 2, 'read dedupes by session_id');
    assert.strictEqual(rows.find((r) => r.session_id === 'A').task, 'v2', 'last write wins');
  });

  it('tolerates a torn/partial trailing line (concurrent write in flight)', () => {
    const date = '2026-06-21';
    mod.upsertLedger({ session_id: 'A', task: 'ok' }, date);
    fs.appendFileSync(mod.ledgerPath(date), '{"session_id":"B","task":"tru'); // torn write
    const rows = mod.readLedger(date);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].session_id, 'A');
  });

  it('Monday pulls Friday across the weekend gap', () => {
    // 2026-06-12 is a Friday; 2026-06-15 the following Monday.
    mod.upsertLedger({ session_id: 'fri', task: 'friday work' }, '2026-06-12');
    assert.strictEqual(mod.findPreviousLedgerDate('2026-06-15', 7), '2026-06-12');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: spawn the script with temp HOME
// ─────────────────────────────────────────────────────────────────────────────

function hasGit() {
  try {
    require('node:child_process').execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

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

  it('concurrent sessions writing the same date file do not lose digests', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'standup-race-'));
    try {
      const N = 6;
      const runs = [];
      for (let i = 0; i < N; i++) {
        runs.push(runHook({
          hook_event_name: i % 2 ? 'Stop' : 'SessionEnd',
          session_id: `race-${i}`,
          cwd: `/work/repo-${i}`,
        }, [], home));
      }
      const results = await Promise.all(runs);
      for (const r of results) assert.strictEqual(r.code, 0);

      const dir = path.join(home, '.claude', 'standup');
      const files = fs.readdirSync(dir);
      assert.strictEqual(files.length, 1);
      const seen = new Set(
        fs.readFileSync(path.join(dir, files[0]), 'utf-8')
          .trim().split('\n')
          .map((l) => JSON.parse(l).session_id)
      );
      for (let i = 0; i < N; i++) {
        assert.ok(seen.has(`race-${i}`), `lost digest for race-${i}; saw ${[...seen]}`);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('captures git branch and diffstat from the session cwd', { skip: !hasGit() }, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'standup-git-'));
    try {
      const repo = path.join(home, 'myrepo');
      fs.mkdirSync(repo);
      // GIT_CONFIG_GLOBAL/SYSTEM=/dev/null: a contributor's real gitconfig
      // (e.g. commit.gpgsign=true) must not leak into this hermetic repo.
      const git = (...args) => require('node:child_process').execFileSync('git', args, {
        cwd: repo, stdio: 'pipe',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      });
      git('init', '-q');
      git('checkout', '-qb', 'feat/standup-test');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
      git('add', 'a.txt');
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n'); // dirty working tree

      const { code } = await runHook({
        hook_event_name: 'SessionEnd',
        session_id: 'git-1',
        cwd: repo,
      }, [], home);
      assert.strictEqual(code, 0);

      const dir = path.join(home, '.claude', 'standup');
      const row = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf-8').trim().split('\n')[0]);
      assert.strictEqual(row.branch, 'feat/standup-test');
      assert.ok(/1 file changed/.test(row.diffstat), `diffstat: ${JSON.stringify(row.diffstat)}`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('--card rejects a non-date argument (no path traversal) and still renders', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'standup-badcard-'));
    try {
      const { code, stdout } = await runHook(null, ['--card', '../../../etc/passwd'], home);
      assert.strictEqual(code, 0);
      assert.ok(stdout.includes('STANDUP'), stdout);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// Integration: --card render CLI (powers the /standup-autopilot:standup skill)
//
// The skill runs `node standup-autopilot.js --card` (no date = the most recent
// day with recorded sessions). The ledger is HOME-keyed, so a temp HOME fully
// isolates these; no cwd is set, so the /var→/private/var symlink is a non-issue.
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration: --card render CLI', () => {
  it('prints the empty-state card and exits 0 when no ledger exists', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'standup-render-empty-'));
    try {
      const { code, stdout } = await runHook(null, ['--card'], home);
      assert.strictEqual(code, 0);
      assert.ok(stdout.includes('STANDUP'), stdout);
      assert.ok(/no sessions recorded/.test(stdout), stdout);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('renders a card populated by a real Stop hook invocation', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'standup-render-pop-'));
    try {
      const tp = path.join(home, 'transcript.jsonl');
      fs.writeFileSync(tp, [
        userMsg('refactor the billing service'),
        assistantText('Refactored billing and opened https://github.com/acme/app/pull/900'),
      ].map((m) => JSON.stringify(m)).join('\n') + '\n');

      const rec = await runHook({
        hook_event_name: 'Stop',
        session_id: 'render-pop-1',
        cwd: '/work/billing-svc',
        transcript_path: tp,
      }, [], home);
      assert.strictEqual(rec.code, 0);

      // Render the exact day the hook wrote (deterministic, no midnight race).
      const dir = path.join(home, '.claude', 'standup');
      const date = fs.readdirSync(dir)[0].replace(/\.jsonl$/, '');
      const { code, stdout } = await runHook(null, ['--card', date], home);
      assert.strictEqual(code, 0);
      assert.ok(stdout.includes('billing-svc'), stdout);
      assert.ok(stdout.includes('#900'), stdout);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('renders plain text, not a hook JSON envelope', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'standup-render-plain-'));
    try {
      const { code, stdout } = await runHook(null, ['--card'], home);
      assert.strictEqual(code, 0);
      assert.doesNotMatch(stdout.trim(), /^\{/, 'render output is a human card, not JSON');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
