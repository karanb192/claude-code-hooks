#!/usr/bin/env node
/**
 * Standup Autopilot - SessionEnd + Stop + SessionStart Hook
 *
 * Turns what your agents ACTUALLY did into a standup, captured from session
 * transcripts (not commits/tickets, which miss uncommitted work, real test
 * exit codes, and unresolved errors) and rolled up cross-repo.
 *
 *   Stop / SessionEnd -> snapshot the latest outcome of the session (task
 *                   summary, git branch + diffstat, tests run + exit codes,
 *                   PRs, blockers) to ~/.claude/standup/<date>.jsonl. Both
 *                   events run the SAME idempotent upsert keyed by session_id,
 *                   so Stop keeps the digest fresh mid-session and SessionEnd
 *                   captures the final state — whichever fires last wins.
 *   SessionStart -> (matcher: startup) re-injects the PREVIOUS ledger day's
 *                   unresolved blockers/open threads back into the agent via
 *                   additionalContext, and on the first session of the day
 *                   prints a standup-ready terminal card to stderr.
 *
 * Ledger:   ~/.claude/standup/<YYYY-MM-DD>.jsonl  (append-only; one snapshot
 *           per line, deduped on read by session_id with last-write-wins, so
 *           concurrent sessions never clobber each other's digests)
 * Logs:     ~/.claude/hooks-logs/<YYYY-MM-DD>.jsonl
 *
 * Dates are LOCAL calendar days (your standup is in your timezone, not UTC).
 * A session spanning midnight leaves a snapshot in both days' ledgers — the
 * later day has the final state. "Yesterday" means the most recent prior day
 * that has a ledger (looking back up to 7 days), so Monday pulls Friday and
 * days off are skipped naturally.
 *
 * Secret hygiene: task summaries, test commands, and blocker snippets are
 * derived from transcript text; common credential shapes (ghp_/sk-/xox
 * tokens, AWS keys, JWTs, key=value secrets) are redacted before anything
 * touches disk. Everything is local — no network calls, ever.
 *
 * Render a standup card any time:   node standup-autopilot.js --card [YYYY-MM-DD]
 *
 * Install as a plugin:   /plugin install standup-autopilot@claude-code-hooks
 * (then /standup-autopilot:standup renders today's card on demand)
 *
 * Setup in .claude/settings.json:
 * {
 *   "hooks": {
 *     "Stop": [{
 *       "hooks": [{ "type": "command", "command": "node /path/to/standup-autopilot.js", "async": true }]
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
const { execFileSync } = require('child_process');

const HOME = () => process.env.HOME || process.env.USERPROFILE || require('os').homedir();
const STANDUP_DIR = () => path.join(HOME(), '.claude', 'standup');
const LOG_DIR = () => path.join(HOME(), '.claude', 'hooks-logs');

// Cost/latency discipline: never read more than this many bytes of a transcript.
const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_TRANSCRIPT_LINES = 4000;
// Append-only ledgers grow with every Stop; never read more than the tail.
const MAX_LEDGER_BYTES = 5 * 1024 * 1024; // 5 MB
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// LOCAL calendar date — a standup day is the user's day, not UTC's.
function today(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Pure calendar-day arithmetic on a YYYY-MM-DD string (timezone-independent).
function shiftDate(dateStr, days) {
  const base = new Date(dateStr + 'T00:00:00Z');
  return new Date(base.getTime() + days * 86400000).toISOString().slice(0, 10);
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

// Redact common credential shapes before transcript-derived text hits disk.
// Conservative by design: better to mangle a fake token than persist a real one.
const REDACTION_RES = [
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/g, // GitHub tokens
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI/Anthropic-style keys
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, // JWTs
  /((?:api[_-]?key|access[_-]?key|token|secret|passw(?:or)?d|authorization|bearer)["']?\s*[=:]\s*)["']?[^\s"']{6,}/gi,
];

function redactSecrets(text) {
  if (!text) return text;
  let out = text;
  for (const re of REDACTION_RES) {
    out = out.replace(re, (match, g1) => (typeof g1 === 'string' ? g1 + '[REDACTED]' : '[REDACTED]'));
  }
  return out;
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
        events.push({ kind: 'use', id: block.id || null, name: block.name, input: block.input || {} });
      } else if (block.type === 'tool_result') {
        const t = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((c) => (c && c.text) || '').join(' ')
            : '';
        events.push({ kind: 'result', id: block.tool_use_id || null, is_error: !!block.is_error, text: t });
      }
    }
  }
  return events;
}

const TEST_CMD_RE = /\b(npm (run )?test|npx (jest|vitest|mocha)|pytest|jest|vitest|go test|cargo test|mocha|node --test|rspec|phpunit)\b/i;
const PR_URL_RE = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/g;
const PR_HASH_RE = /\bPR\s*#(\d+)\b/gi;
// Broad error-word match — used only to decide whether a LATER result looks
// clean enough to consider an earlier error resolved (conservative on purpose).
const ERROR_RE = /\b(error|failed|failure|exception|traceback|cannot|not found|ENOENT|refused|timed out|flaky)\b/i;
// Strict error match for FLAGGING blockers: an incidental "failed"/"cannot"
// in ordinary output (file contents, grep hits, prose) must not become a
// blocker unless the tool itself reported is_error.
const STRONG_ERROR_RE = /(?:error:|\bexception\b|\btraceback\b|panic:|fatal:|\bENOENT\b|\bEACCES\b|command not found|segmentation fault|\btimed out\b)/i;

// Parse a test result blob into { passed, failed } when possible.
// Handles: mocha/npm ("14 passing", "2 failing"), jest ("Tests: 5 passed"),
// pytest summary ("3 passed, 1 failed", "5 passed"), and go test
// (a bare "FAIL"/"ok" verdict when no numeric counts are present).
function parseTestCounts(text) {
  if (!text) return null;
  let passed = null;
  let failed = null;
  const passM = text.match(/(\d+)\s+(?:passing|passed)\b(?!\s+to\b)/i);
  if (passM) passed = parseInt(passM[1], 10);
  // "(?!\s+to\b)" keeps compile-error prose like "2 modules failed to
  // compile" from being counted as 2 failing tests.
  const failM = text.match(/(\d+)\s+(?:failing|failed)\b(?!\s+to\b)/i);
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
  taskSummary = redactSecrets(taskSummary).slice(0, 240);

  // Tests: find bash tool_use running tests, pair with the matching result —
  // by tool_use_id when present (parallel tool calls interleave results),
  // falling back to the next result in sequence.
  const tests = [];
  for (let i = 0; i < toolEvents.length; i++) {
    const ev = toolEvents[i];
    if (ev.kind !== 'use') continue;
    const cmd = ev.input && (ev.input.command || ev.input.cmd || '');
    if (typeof cmd !== 'string' || !TEST_CMD_RE.test(cmd)) continue;
    let resultText = '';
    let isError = false;
    let paired = false;
    if (ev.id) {
      for (const r of toolEvents) {
        if (r.kind === 'result' && r.id && r.id === ev.id) {
          resultText = r.text || '';
          isError = r.is_error;
          paired = true;
          break;
        }
      }
    }
    if (!paired) {
      for (let j = i + 1; j < toolEvents.length; j++) {
        if (toolEvents[j].kind === 'result') {
          resultText = toolEvents[j].text || '';
          isError = toolEvents[j].is_error;
          break;
        }
      }
    }
    const counts = parseTestCounts(resultText);
    tests.push({
      command: redactSecrets(cmd).slice(0, 120),
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

  // Blockers: unresolved errors — tool_results flagged is_error, or result
  // text with a STRONG error signature (error:/traceback/ENOENT/…) that was
  // NOT followed by a clean success later. Loose words like "failed" alone
  // don't qualify: they show up in ordinary file contents and prose.
  const blockers = [];
  for (let i = 0; i < toolEvents.length; i++) {
    const ev = toolEvents[i];
    if (ev.kind !== 'result') continue;
    const errish = ev.is_error || STRONG_ERROR_RE.test(ev.text || '');
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
    const snippet = redactSecrets((ev.text || '').replace(/\s+/g, ' ').trim()).slice(0, 160);
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
    diffstat: ctx.diffstat || '',
    task: taskSummary,
    tests,
    prs,
    blockers: blockerSet,
    reason: ctx.reason || '',
    updated_at: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Git context — branch + diffstat for the digest. execFileSync only (no shell
// interpolation), timeboxed, and silently tolerant of non-git / missing cwds.
// ─────────────────────────────────────────────────────────────────────────────

function gitContext(cwd) {
  const out = { branch: '', diffstat: '' };
  if (!cwd || typeof cwd !== 'string') return out;
  const opts = { cwd, timeout: 1500, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] };
  try {
    out.branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts).trim();
  } catch {
    return out; // not a git repo, git missing, or cwd gone — all fine
  }
  try {
    // Staged + unstaged vs HEAD, e.g. "3 files changed, 42 insertions(+)".
    out.diffstat = execFileSync('git', ['diff', 'HEAD', '--shortstat'], opts).trim().slice(0, 120);
  } catch {}
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ledger (JSONL, upsert-per-session-per-day)
//
// Writes are APPEND-ONLY: a read-filter-rewrite upsert is a read-modify-write
// race — two sessions hitting Stop/SessionEnd at the same moment would clobber
// each other's digests. appendFileSync of a single line is atomic enough
// (O_APPEND), and readLedger dedupes by session_id with last-write-wins, which
// gives identical upsert semantics without the lost-update window.
// ─────────────────────────────────────────────────────────────────────────────

function ledgerPath(date = today()) {
  return path.join(STANDUP_DIR(), `${date}.jsonl`);
}

function readLedger(date = today()) {
  try {
    const file = ledgerPath(date);
    if (!fs.existsSync(file)) return [];
    const stat = fs.statSync(file);
    let raw;
    if (stat.size > MAX_LEDGER_BYTES) {
      // Tail read: newest snapshots win anyway, so dropping the oldest is safe.
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(MAX_LEDGER_BYTES);
      fs.readSync(fd, buf, 0, MAX_LEDGER_BYTES, stat.size - MAX_LEDGER_BYTES);
      fs.closeSync(fd);
      raw = buf.toString('utf-8');
      raw = raw.slice(raw.indexOf('\n') + 1); // drop partial first line
    } else {
      raw = fs.readFileSync(file, 'utf-8');
    }
    const bySession = new Map();
    let anon = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || typeof row !== 'object') continue;
      const key = row.session_id || `__anon_${anon++}`;
      bySession.delete(key); // re-insert so row order follows last write
      bySession.set(key, row);
    }
    return [...bySession.values()];
  } catch {
    return [];
  }
}

// Upsert a digest keyed by session_id: append a fresh snapshot line; the
// latest one wins at read time. Safe under concurrent sessions.
function upsertLedger(digest, date = today()) {
  try {
    const dir = STANDUP_DIR();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(ledgerPath(date), JSON.stringify(digest) + '\n');
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
    if (!byRepo.has(key)) byRepo.set(key, { repo: key, tasks: [], prs: new Set(), blockers: new Set(), tests: [], diffstat: '' });
    const g = byRepo.get(key);
    if (r.task) g.tasks.push(r.task);
    if (r.diffstat) g.diffstat = r.diffstat; // latest snapshot wins
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
    diffstat: g.diffstat,
  }));
}

function renderCard(rows, date = today()) {
  const lines = [];
  lines.push('┌─────────────────────────────────────────────────────────┐');
  lines.push(`│  📋 STANDUP · ${date}${' '.repeat(Math.max(0, 42 - date.length))}│`);
  lines.push('└─────────────────────────────────────────────────────────┘');
  if (!rows.length) {
    lines.push('  (no sessions recorded) — run /standup-autopilot:standup again after your next session.');
    return lines.join('\n');
  }
  const summary = summarizeDay(rows);
  lines.push('Yesterday:');
  for (const s of summary) {
    const bits = [];
    if (s.task) bits.push(s.task.slice(0, 80));
    if (s.prs.length) bits.push(`PR ${s.prs.join(', ')}`);
    if (s.tests) bits.push(s.tests);
    if (s.diffstat) bits.push(s.diffstat);
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
const MAX_INJECTED_BLOCKERS = 8;

function renderResumeContext(rows) {
  const summary = summarizeDay(rows);
  const blockers = summary.flatMap((s) => s.blockers.map((b) => `[${s.repo}] ${b}`));
  if (!blockers.length) return '';
  const lines = ['Unresolved blockers / open threads from your last standup session(s):'];
  blockers.slice(0, MAX_INJECTED_BLOCKERS).forEach((b) => lines.push(`- ${b}`));
  if (blockers.length > MAX_INJECTED_BLOCKERS) {
    lines.push(`- …and ${blockers.length - MAX_INJECTED_BLOCKERS} more (run \`node standup-autopilot.js --card\` for the full list)`);
  }
  lines.push('If any of these are still relevant to the current work, consider resuming them.');
  return lines.join('\n');
}

// Most recent prior LOCAL day that has a ledger, searching back up to
// `lookback` days — so a Monday standup naturally pulls Friday's ledger.
function findPreviousLedgerDate(fromDate = today(), lookback = 7) {
  for (let i = 1; i <= lookback; i++) {
    const ds = shiftDate(fromDate, -i);
    if (fs.existsSync(ledgerPath(ds))) return ds;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event handlers
// ─────────────────────────────────────────────────────────────────────────────

function handleStopOrEnd(data) {
  const messages = readTranscript(data.transcript_path);
  const git = gitContext(data.cwd);
  const digest = buildDigest(messages, {
    session_id: data.session_id,
    cwd: data.cwd,
    reason: data.reason,
    branch: git.branch,
    diffstat: git.diffstat,
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
  // `--render` is an accepted alias for `--card` (matches the render line used by
  // the other six plugin skills).
  let idx = argv.indexOf('--card');
  if (idx === -1) idx = argv.indexOf('--render');
  const slack = argv.includes('--slack');
  let date = argv[idx + 1];
  // Strict YYYY-MM-DD only — the date lands in a filesystem path.
  if (!date || !DATE_RE.test(date)) date = findPreviousLedgerDate(today(), 30) || today();
  const rows = readLedger(date);
  process.stdout.write((slack ? renderSlack(rows, date) : renderCard(rows, date)) + '\n');
}

// On-demand standup card for the plugin skill (`node standup-autopilot.js --card`).
// Prints the same card the SessionStart hook shows, straight to stdout, so you
// never have to wait for a session boundary. Never throws: on any failure it
// degrades to a friendly empty-state card (plain text, never a hook JSON envelope).
function renderCli() {
  try {
    runCli(process.argv.slice(2));
  } catch {
    try { process.stdout.write(renderCard([], today()) + '\n'); } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
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
  if (process.argv.includes('--card') || process.argv.includes('--render')) {
    renderCli();
  } else {
    main();
  }
} else {
  module.exports = {
    readTranscript,
    messageText,
    role,
    extractToolEvents,
    parseTestCounts,
    redactSecrets,
    gitContext,
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
    shiftDate,
    runCli,
    renderCli,
  };
}
