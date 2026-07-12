#!/usr/bin/env node
/**
 * Standup Autopilot - SessionEnd + Stop + SessionStart Hook
 *
 * Turns what your agents ACTUALLY did into a standup, captured from session
 * transcripts (not commits/tickets, which miss uncommitted work, real test
 * exit codes, and unresolved errors) and rolled up cross-repo.
 *
 *   Stop / SessionEnd -> snapshot the latest outcome of the session (task
 *                   summary, tests run + exit codes, PRs, blockers) to
 *                   ~/.claude/standup/<date>.jsonl. Both events run the SAME
 *                   idempotent upsert keyed by session_id, so Stop keeps the
 *                   digest fresh mid-session and SessionEnd captures the final
 *                   state — whichever fires last wins.
 *   SessionStart -> (matcher: startup) re-injects YESTERDAY's unresolved
 *                   blockers/open threads back into the agent via
 *                   additionalContext, and on the first session of the day
 *                   prints a standup-ready terminal card to stderr.
 *
 * Ledger:   ~/.claude/standup/<YYYY-MM-DD>.jsonl  (one line per session, upserted)
 * Logs:     ~/.claude/hooks-logs/<YYYY-MM-DD>.jsonl
 *
 * Render a standup card any time:   node standup-autopilot.js --card [YYYY-MM-DD]
 *
 * Setup in .claude/settings.json:
 * {
 *   "hooks": {
 *     "Stop": [{
 *       "hooks": [{ "type": "command", "command": "node /path/to/standup-autopilot.js" }]
 *     }],
 *     "SessionEnd": [{
 *       "hooks": [{ "type": "command", "command": "node /path/to/standup-autopilot.js" }]
 *     }],
 *     "SessionStart": [{
 *       "matcher": "startup",
 *       "hooks": [{ "type": "command", "command": "node /path/to/standup-autopilot.js" }]
 *     }]
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');

const HOME = () => process.env.HOME || process.env.USERPROFILE || require('os').homedir();
const STANDUP_DIR = () => path.join(HOME(), '.claude', 'standup');
const LOG_DIR = () => path.join(HOME(), '.claude', 'hooks-logs');

// Cost/latency discipline: never read more than this many bytes of a transcript.
const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_TRANSCRIPT_LINES = 4000;

function today(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function log(data) {
  try {
    const dir = LOG_DIR();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${today()}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), hook: 'standup-autopilot', ...data }) + '\n');
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Transcript parsing (pure) — extract standup-worthy signal from a session.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read up to a bounded chunk of a JSONL transcript and return parsed message
 * objects. Time/size-bounded so hooks stay fast. Returns [] on any problem.
 */
function readTranscript(transcriptPath) {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];
    const stat = fs.statSync(transcriptPath);
    let raw;
    if (stat.size > MAX_TRANSCRIPT_BYTES) {
      // Read only the tail so we still capture the most recent outcome.
      const fd = fs.openSync(transcriptPath, 'r');
      const buf = Buffer.alloc(MAX_TRANSCRIPT_BYTES);
      fs.readSync(fd, buf, 0, MAX_TRANSCRIPT_BYTES, stat.size - MAX_TRANSCRIPT_BYTES);
      fs.closeSync(fd);
      raw = buf.toString('utf-8');
      raw = raw.slice(raw.indexOf('\n') + 1); // drop partial first line
    } else {
      raw = fs.readFileSync(transcriptPath, 'utf-8');
    }
    const lines = raw.split('\n').filter(Boolean);
    const slice = lines.length > MAX_TRANSCRIPT_LINES ? lines.slice(-MAX_TRANSCRIPT_LINES) : lines;
    const out = [];
    for (const line of slice) {
      try { out.push(JSON.parse(line)); } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

// Flatten a message's textual content regardless of shape.
function messageText(msg) {
  if (!msg || typeof msg !== 'object') return '';
  const m = msg.message || msg;
  const content = m.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c && typeof c.text === 'string') return c.text;
        return '';
      })
      .join(' ');
  }
  if (typeof m.text === 'string') return m.text;
  return '';
}

function role(msg) {
  const m = (msg && msg.message) || msg || {};
  return m.role || msg.type || '';
}

// Pull tool_use / tool_result pairs out of the transcript for signal extraction.
function extractToolEvents(messages) {
  const events = [];
  for (const msg of messages) {
    const m = (msg && msg.message) || msg || {};
    const content = m.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use') {
        events.push({ kind: 'use', name: block.name, input: block.input || {} });
      } else if (block.type === 'tool_result') {
        const t = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((c) => (c && c.text) || '').join(' ')
            : '';
        events.push({ kind: 'result', is_error: !!block.is_error, text: t });
      }
    }
  }
  return events;
}

const TEST_CMD_RE = /\b(npm (run )?test|npx (jest|vitest|mocha)|pytest|jest|vitest|go test|cargo test|mocha|node --test|rspec|phpunit)\b/i;
const PR_URL_RE = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/g;
const PR_HASH_RE = /\bPR\s*#(\d+)\b/gi;
const ERROR_RE = /\b(error|failed|failure|exception|traceback|cannot|not found|ENOENT|refused|timed out|flaky)\b/i;
const TEST_RESULT_RE = /(\d+)\s+(?:passing|passed)\b|(\d+)\s+(?:failing|failed)\b|Tests:\s*(\d+)\s+failed.*?(\d+)\s+passed|(\d+)\s+passed,\s*(\d+)\s+failed/i;

// Parse a test result blob into { passed, failed } when possible.
// Handles: mocha/npm ("14 passing", "2 failing"), jest ("Tests: 5 passed"),
// pytest summary ("3 passed, 1 failed", "5 passed"), and go test
// (a bare "FAIL"/"ok" verdict when no numeric counts are present).
function parseTestCounts(text) {
  if (!text) return null;
  let passed = null;
  let failed = null;
  const passM = text.match(/(\d+)\s+(?:passing|passed)\b/i);
  if (passM) passed = parseInt(passM[1], 10);
  const failM = text.match(/(\d+)\s+(?:failing|failed)\b/i);
  if (failM) failed = parseInt(failM[1], 10);
  if (passed !== null || failed !== null) {
    return { passed: passed || 0, failed: failed || 0 };
  }
  // go test / generic: no numeric counts, but a clear verdict line.
  // "--- FAIL", "FAIL\tpkg", "ok  \tpkg" — record pass/fail as a boolean-ish
  // signal (0/0 counts is uninformative, so encode the verdict instead).
  if (/^\s*(?:---\s*)?FAIL\b/im.test(text) || /\bFAIL\b/.test(text)) {
    return { passed: 0, failed: 1, verdict: 'fail' };
  }
  if (/^\s*ok\s/im.test(text) || /\bPASS\b/.test(text)) {
    return { passed: 1, failed: 0, verdict: 'pass' };
  }
  return null;
}

/**
 * Given transcript messages + the hook input, build the per-session digest.
 * Pure: no I/O. This is the heart of the hook.
 */
function buildDigest(messages, ctx = {}) {
  const toolEvents = extractToolEvents(messages);

  // Task summary: last substantive assistant text, trimmed to one line.
  let taskSummary = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    if (role(messages[i]) === 'assistant') {
      const t = messageText(messages[i]).replace(/\s+/g, ' ').trim();
      if (t && t.length > 12) { taskSummary = t; break; }
    }
  }
  // Fallback: first user prompt (the ask).
  if (!taskSummary) {
    for (const msg of messages) {
      if (role(msg) === 'user') {
        const t = messageText(msg).replace(/\s+/g, ' ').trim();
        if (t) { taskSummary = t; break; }
      }
    }
  }
  taskSummary = taskSummary.slice(0, 240);

  // Tests: find bash tool_use running tests, pair with the following result.
  const tests = [];
  for (let i = 0; i < toolEvents.length; i++) {
    const ev = toolEvents[i];
    if (ev.kind !== 'use') continue;
    const cmd = ev.input && (ev.input.command || ev.input.cmd || '');
    if (typeof cmd !== 'string' || !TEST_CMD_RE.test(cmd)) continue;
    // Look ahead for the matching result.
    let resultText = '';
    let isError = false;
    for (let j = i + 1; j < toolEvents.length; j++) {
      if (toolEvents[j].kind === 'result') {
        resultText = toolEvents[j].text || '';
        isError = toolEvents[j].is_error;
        break;
      }
    }
    const counts = parseTestCounts(resultText);
    tests.push({
      command: cmd.slice(0, 120),
      exitError: isError,
      passed: counts ? counts.passed : null,
      failed: counts ? counts.failed : null,
    });
  }

  // PRs: scan all text for PR urls / #numbers.
  const prSet = new Set();
  const allText = messages.map(messageText).join('\n') + '\n' +
    toolEvents.filter((e) => e.kind === 'result').map((e) => e.text).join('\n');
  let m;
  PR_URL_RE.lastIndex = 0;
  while ((m = PR_URL_RE.exec(allText))) prSet.add('#' + m[1]);
  PR_HASH_RE.lastIndex = 0;
  while ((m = PR_HASH_RE.exec(allText))) prSet.add('#' + m[1]);
  const prs = [...prSet];

  // Blockers: unresolved errors — tool_results flagged is_error, or error-ish
  // result text that was NOT followed by a clean test pass / success later.
  const blockers = [];
  for (let i = 0; i < toolEvents.length; i++) {
    const ev = toolEvents[i];
    if (ev.kind !== 'result') continue;
    const errish = ev.is_error || ERROR_RE.test(ev.text || '');
    if (!errish) continue;
    // Consider it resolved if a later result in the same session succeeded
    // for a similar action (heuristic: any later non-error result).
    let resolvedLater = false;
    for (let j = i + 1; j < toolEvents.length; j++) {
      if (toolEvents[j].kind === 'result' && !toolEvents[j].is_error && !ERROR_RE.test(toolEvents[j].text || '')) {
        resolvedLater = true;
        break;
      }
    }
    if (resolvedLater) continue;
    const snippet = (ev.text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (snippet) blockers.push(snippet);
  }
  // Any failing tests are blockers too.
  for (const t of tests) {
    if ((t.failed && t.failed > 0) || t.exitError) {
      blockers.push(`tests failing: ${t.command}${t.failed ? ` (${t.failed} failed)` : ''}`);
    }
  }
  // Dedup + cap.
  const blockerSet = [...new Set(blockers)].slice(0, 5);

  return {
    session_id: ctx.session_id || '',
    cwd: ctx.cwd || '',
    repo: ctx.cwd ? path.basename(ctx.cwd) : '',
    branch: ctx.branch || '',
    task: taskSummary,
    tests,
    prs,
    blockers: blockerSet,
    reason: ctx.reason || '',
    updated_at: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ledger (JSONL, upsert-per-session-per-day)
// ─────────────────────────────────────────────────────────────────────────────

function ledgerPath(date = today()) {
  return path.join(STANDUP_DIR(), `${date}.jsonl`);
}

function readLedger(date = today()) {
  try {
    const file = ledgerPath(date);
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Upsert a digest keyed by session_id: the latest snapshot wins.
function upsertLedger(digest, date = today()) {
  try {
    const dir = STANDUP_DIR();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const rows = readLedger(date).filter((r) => r.session_id !== digest.session_id);
    rows.push(digest);
    fs.writeFileSync(ledgerPath(date), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering — the screenshot-able standup card + the blocker re-injection text.
// ─────────────────────────────────────────────────────────────────────────────

function testSummary(tests) {
  if (!tests || !tests.length) return '';
  let passed = 0;
  let total = 0;
  let anyFail = false;
  for (const t of tests) {
    if (t.passed != null) { passed += t.passed; total += t.passed; }
    if (t.failed != null) { total += t.failed; if (t.failed > 0) anyFail = true; }
    if (t.exitError) anyFail = true;
  }
  if (total === 0) return anyFail ? 'tests failed' : 'tests run';
  return `tests ${passed}/${total}${anyFail ? ' (failing)' : ''}`;
}

// One-line-per-repo standup summary from a day's rows.
function summarizeDay(rows) {
  const byRepo = new Map();
  for (const r of rows) {
    const key = r.repo || r.cwd || 'unknown';
    if (!byRepo.has(key)) byRepo.set(key, { repo: key, tasks: [], prs: new Set(), blockers: new Set(), tests: [] });
    const g = byRepo.get(key);
    if (r.task) g.tasks.push(r.task);
    (r.prs || []).forEach((p) => g.prs.add(p));
    (r.blockers || []).forEach((b) => g.blockers.add(b));
    (r.tests || []).forEach((t) => g.tests.push(t));
  }
  return [...byRepo.values()].map((g) => ({
    repo: g.repo,
    task: g.tasks[g.tasks.length - 1] || '',
    prs: [...g.prs],
    blockers: [...g.blockers],
    tests: testSummary(g.tests),
  }));
}

function renderCard(rows, date = today()) {
  const lines = [];
  lines.push('┌─────────────────────────────────────────────────────────┐');
  lines.push(`│  📋 STANDUP · ${date}${' '.repeat(Math.max(0, 42 - date.length))}│`);
  lines.push('└─────────────────────────────────────────────────────────┘');
  if (!rows.length) {
    lines.push('  (no sessions recorded)');
    return lines.join('\n');
  }
  const summary = summarizeDay(rows);
  lines.push('Yesterday:');
  for (const s of summary) {
    const bits = [];
    if (s.task) bits.push(s.task.slice(0, 80));
    if (s.prs.length) bits.push(`PR ${s.prs.join(', ')}`);
    if (s.tests) bits.push(s.tests);
    lines.push(`  • [${s.repo}] ${bits.join(' — ')}`);
  }
  const allBlockers = summary.flatMap((s) => s.blockers.map((b) => ({ repo: s.repo, b })));
  if (allBlockers.length) {
    lines.push('Blocked on:');
    for (const { repo, b } of allBlockers.slice(0, 8)) {
      lines.push(`  ⚠ [${repo}] ${b}`);
    }
  } else {
    lines.push('Blocked on: nothing 🎉');
  }
  return lines.join('\n');
}

// Slack-friendly plain text (for the optional CLI post / clipboard).
function renderSlack(rows, date = today()) {
  const summary = summarizeDay(rows);
  const parts = [`*Standup — ${date}*`];
  const done = summary
    .filter((s) => s.task)
    .map((s) => {
      const extra = [s.prs.length ? `PR ${s.prs.join(', ')}` : '', s.tests].filter(Boolean).join(', ');
      return `• [${s.repo}] ${s.task.slice(0, 100)}${extra ? ` (${extra})` : ''}`;
    });
  if (done.length) parts.push('*Yesterday:*\n' + done.join('\n'));
  const blockers = summary.flatMap((s) => s.blockers.map((b) => `• [${s.repo}] ${b}`));
  parts.push(blockers.length ? '*Blocked:*\n' + blockers.join('\n') : '*Blocked:* none');
  return parts.join('\n');
}

// The SessionStart re-injection: yesterday's open threads, as additionalContext.
function renderResumeContext(rows) {
  const summary = summarizeDay(rows);
  const blockers = summary.flatMap((s) => s.blockers.map((b) => `[${s.repo}] ${b}`));
  if (!blockers.length) return '';
  const lines = ['Unresolved blockers / open threads from your last standup session(s):'];
  blockers.slice(0, 8).forEach((b) => lines.push(`- ${b}`));
  lines.push('If any of these are still relevant to the current work, consider resuming them.');
  return lines.join('\n');
}

// Most recent prior day that has a ledger, searching back up to `lookback` days.
function findPreviousLedgerDate(fromDate = today(), lookback = 7) {
  const base = new Date(fromDate + 'T00:00:00Z');
  for (let i = 1; i <= lookback; i++) {
    const d = new Date(base.getTime() - i * 86400000);
    const ds = today(d);
    if (fs.existsSync(ledgerPath(ds))) return ds;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event handlers
// ─────────────────────────────────────────────────────────────────────────────

function handleStopOrEnd(data) {
  const messages = readTranscript(data.transcript_path);
  const digest = buildDigest(messages, {
    session_id: data.session_id,
    cwd: data.cwd,
    reason: data.reason,
  });
  const ok = upsertLedger(digest);
  log({
    event: data.hook_event_name,
    session_id: data.session_id,
    repo: digest.repo,
    tests: digest.tests.length,
    prs: digest.prs.length,
    blockers: digest.blockers.length,
    persisted: ok,
  });
  return '{}';
}

function handleSessionStart(data) {
  const prevDate = findPreviousLedgerDate();
  if (!prevDate) {
    log({ event: 'SessionStart', session_id: data.session_id, injected: false });
    return '{}';
  }
  const rows = readLedger(prevDate);

  // First session of the day: print the standup card to stderr (visible in terminal).
  const firstToday = readLedger(today()).length === 0;
  if (firstToday) {
    try { process.stderr.write('\n' + renderCard(rows, prevDate) + '\n\n'); } catch {}
  }

  const additionalContext = renderResumeContext(rows);
  log({
    event: 'SessionStart',
    session_id: data.session_id,
    from: prevDate,
    injected: !!additionalContext,
    card: firstToday,
  });
  if (!additionalContext) return '{}';
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI: render a card for any day (default = most recent prior ledger).
// ─────────────────────────────────────────────────────────────────────────────

function runCli(argv) {
  const idx = argv.indexOf('--card');
  const slack = argv.includes('--slack');
  let date = argv[idx + 1];
  if (!date || date.startsWith('--')) date = findPreviousLedgerDate(today(), 30) || today();
  const rows = readLedger(date);
  process.stdout.write((slack ? renderSlack(rows, date) : renderCard(rows, date)) + '\n');
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--card')) {
    try { runCli(argv); } catch { process.stdout.write('{}\n'); }
    return;
  }

  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let data;
  try {
    data = JSON.parse(input);
  } catch (e) {
    log({ level: 'ERROR', error: 'bad input' });
    return console.log('{}');
  }

  try {
    const event = data && data.hook_event_name;
    if (event === 'SessionStart') {
      return console.log(handleSessionStart(data));
    }
    if (event === 'Stop' || event === 'SessionEnd') {
      return console.log(handleStopOrEnd(data));
    }
    // Unknown/unregistered event → no-op.
    console.log('{}');
  } catch (e) {
    log({ level: 'ERROR', error: e && e.message });
    console.log('{}');
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    readTranscript,
    messageText,
    role,
    extractToolEvents,
    parseTestCounts,
    buildDigest,
    readLedger,
    upsertLedger,
    ledgerPath,
    testSummary,
    summarizeDay,
    renderCard,
    renderSlack,
    renderResumeContext,
    findPreviousLedgerDate,
    handleStopOrEnd,
    handleSessionStart,
    today,
  };
}
