#!/usr/bin/env node
/**
 * PR Provenance Stamp - PreToolUse (Bash) + PostToolUse (Edit|MultiEdit|Write|Bash) + PostToolUseFailure (Bash) Hook
 *
 * Embeds a reviewer-facing provenance receipt into the PR body when Claude runs
 * `gh pr create` (or `glab mr create`). PostToolUse hooks append to a per-session
 * ledger under ~/.claude/pr-provenance-stamp/<session_id>.jsonl: a tool-call
 * counter, agent-authored line count, and every test/typecheck command with its
 * result (PostToolUseFailure supplies the exit code of a failed one; a
 * PostToolUse means the command line exited 0). When `gh pr create` fires, the PreToolUse branch reads the
 * transcript for the real prompt count / token+dollar spend / models, asks git
 * for the branch's total added lines to derive a TRUTHFUL agent-vs-human split,
 * then rewrites the `--body` argument via hookSpecificOutput.updatedInput,
 * appending a stamp like:
 *
 *   Built with Claude Code: 23 prompts · $3.84 · tests 4/4 green · 92% agent-authored
 *
 * SAFE-OUTPUT GUARANTEE: if the command uses a heredoc, `$(...)` command
 * substitution, backticks, or process substitution to build the body (the
 * dominant forms the ship skill and Claude Code emit), the hook DEFERS: it
 * returns {} and never rewrites: because re-quoting those would literalize and
 * corrupt the real description. A missed stamp is acceptable; a mangled PR body
 * is not.
 *
 * HONEST PERCENTAGES: the agent-authored % is computed only when git yields a
 * real total-added-lines denominator (human_lines = git_total − agent_lines).
 * When git is unavailable the percentage is SUPPRESSED (never defaulted to
 * 100%); the stamp shows the absolute agent line count instead.
 *
 * Logs to: ~/.claude/hooks-logs/   State: ~/.claude/pr-provenance-stamp/
 *
 * PLUGIN INSTALL (recommended): this hook also ships as an installable plugin -
 * `/plugin install pr-provenance-stamp@claude-code-hooks`: which wires both
 * events automatically and adds a `/pr-provenance-stamp:provenance` command to
 * preview the receipt on demand. The classic settings.json snippet below still
 * works for copy-paste users.
 *
 * COST/TOKEN CAVEAT (GitHub issue #11008): hooks do NOT receive token/cost in
 * their input, so spend is parsed from the transcript JSONL at transcript_path
 * and priced from a static table: figures are ESTIMATES and rendered as such
 * (`~$` / "Spend (est.)"). When the transcript is absent/unparseable, token &
 * dollar figures degrade to omitted (never faked).
 *
 * updatedInput SCHEMA (docs: https://code.claude.com/docs/en/hooks: "PreToolUse:
 * `updatedInput` directly under `hookSpecificOutput` replaces a tool's arguments
 * before it runs"): this hook emits the documented shape,
 *
 *   { "hookSpecificOutput": { "hookEventName": "PreToolUse",
 *       "permissionDecision": "ask", "permissionDecisionReason": "...",
 *       "updatedInput": { ...tool_input, "command": <rewritten> } } }
 *
 * The docs pair `updatedInput` with "allow" (auto-approve) or "ask" (show the
 * modified input to the user); they do not define it with the decision
 * omitted. This hook returns "ask": a stamping hook must not grant a
 * permission the user's own rules did not, and its shell scanner cannot
 * prove that nothing else rides along in the command (ANSI-C quoting, odd
 * separators). Consequences worth knowing:
 *   - Every stamped `gh pr create` / `glab mr create` shows a permission
 *     prompt with the rewritten command, even if a rule would have allowed it.
 *     The hook only appends to the --body argument.
 *   - GitHub issue #15897 (updatedInput silently dropped) was a MULTI-hook
 *     aggregation bug: a later PreToolUse hook's empty result clobbered an
 *     earlier hook's updatedInput: reported fixed as of Claude Code v2.1.168.
 *     On affected older versions with multiple Bash PreToolUse hooks the
 *     failure mode is a MISSED STAMP (the original command runs unmodified),
 *     never a corrupted command.
 *
 * Setup in .claude/settings.json:
 * {
 *   "hooks": {
 *     "PostToolUse": [{
 *       "matcher": "Edit|MultiEdit|Write|Bash",
 *       "hooks": [{ "type": "command", "command": "node /path/to/pr-provenance-stamp.js", "async": true }]
 *     }],
 *     "PostToolUseFailure": [{
 *       "matcher": "Bash",
 *       "hooks": [{ "type": "command", "command": "node /path/to/pr-provenance-stamp.js", "async": true }]
 *     }],
 *     "PreToolUse": [{
 *       "matcher": "Bash",
 *       "hooks": [{ "type": "command", "command": "node /path/to/pr-provenance-stamp.js" }]
 *     }]
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = process.env.HOME || require('os').homedir();
const LOG_DIR = path.join(HOME, '.claude', 'hooks-logs');
const STATE_DIR = path.join(HOME, '.claude', 'pr-provenance-stamp');

// Cost per 1M tokens (USD). Rough public list-price anchors; used only when the
// transcript exposes usage. Unknown models fall back to DEFAULT_PRICING.
const PRICING = {
  'claude-opus':   { input: 15, output: 75 },
  'claude-sonnet': { input: 3,  output: 15 },
  'claude-haiku':  { input: 0.8, output: 4 },
};
const DEFAULT_PRICING = { input: 3, output: 15 };

const STAMP_BEGIN = '<!-- pr-provenance-stamp:begin -->';
const STAMP_END = '<!-- pr-provenance-stamp:end -->';

// Commands we count as "tests" for the green/total tally.
const TEST_CMD_RE = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|lint|tsc)\b|\bnpx\s+(?:tsc|jest|vitest|eslint)\b|\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b|\bnode\s+--test\b|\bpython\s+-m\s+(?:pytest|unittest)\b|\brspec\b|\bmvn\s+test\b/;

// ─────────────────────────────────────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────────────────────────────────────

function log(data) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), hook: 'pr-provenance-stamp', ...data }) + '\n');
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Ledger persistence (pure-ish helpers, parameterized on dir for tests)
// ─────────────────────────────────────────────────────────────────────────────

function emptyLedger(sessionId) {
  return {
    session_id: sessionId || 'unknown',
    // Number of Post-tool-use events seen this session. NOT a user-prompt count
    // (the real prompt count comes from the transcript at stamp time). Named
    // `tool_calls` to avoid the earlier misleading `prompts` field.
    tool_calls: 0,
    edits: 0,
    writes: 0,
    agent_lines: 0,
    // Human-authored added lines. Left 0 here; the truthful value is derived at
    // stamp time from the git branch diff (see buildProvenance).
    human_lines: 0,
    tests: [], // { cmd, exit, ok }
    models: [], // list of model ids seen
  };
}

function ledgerPath(sessionId, dir = STATE_DIR) {
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120) || 'unknown';
  return path.join(dir, `${safe}.json`);
}

function eventsPath(sessionId, dir = STATE_DIR) {
  return ledgerPath(sessionId, dir) + 'l';
}

const COUNTERS = ['tool_calls', 'edits', 'writes', 'agent_lines'];

// The ledger is the sum of one appended line per hook event. The hooks run
// async and in parallel, so a read-modify-write of one JSON file lost events;
// an append does not. A <session>.json snapshot written by 1.0.x is the base.
function loadLedger(sessionId, dir = STATE_DIR) {
  let ledger = emptyLedger(sessionId);
  try {
    ledger = { ...ledger, ...JSON.parse(fs.readFileSync(ledgerPath(sessionId, dir), 'utf-8')) };
  } catch {}
  if (!Array.isArray(ledger.tests)) ledger.tests = [];
  let lines = [];
  try {
    lines = fs.readFileSync(eventsPath(sessionId, dir), 'utf-8').split('\n');
  } catch {}
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || typeof event !== 'object') continue;
    for (const k of COUNTERS) if (Number.isFinite(event[k])) ledger[k] = (ledger[k] || 0) + event[k];
    if (event.test && typeof event.test === 'object') ledger.tests.push(event.test);
  }
  return ledger;
}

/** Append what one hook event added (a ledger built from that event alone). */
function appendLedgerEvent(sessionId, delta, dir = STATE_DIR) {
  const event = {};
  for (const k of COUNTERS) if (delta[k]) event[k] = delta[k];
  if (delta.tests && delta.tests.length) event.test = delta.tests[0];
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(eventsPath(sessionId, dir), JSON.stringify(event) + '\n');
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure ledger-update logic
// ─────────────────────────────────────────────────────────────────────────────

/** Count non-empty added lines produced by an Edit/Write tool_input. */
function countAddedLines(toolName, toolInput) {
  if (!toolInput) return 0;
  const countNonEmpty = (s) => (typeof s === 'string' ? s.split('\n').filter((l) => l.trim() !== '').length : 0);
  if (toolName === 'Write') return countNonEmpty(toolInput.content);
  if (toolName === 'Edit') {
    // MultiEdit-style edits array, or a single old/new_string pair.
    if (Array.isArray(toolInput.edits)) {
      return toolInput.edits.reduce((n, e) => n + countNonEmpty(e && e.new_string), 0);
    }
    return countNonEmpty(toolInput.new_string);
  }
  return 0;
}

/**
 * Redact secret-looking material from a command line before it is stored in
 * the ledger (and later rendered into a PUBLIC PR body). Over-redacts by
 * design: `AUTHOR=x` losing its value is fine, a leaked token is not.
 */
function redactSecrets(s) {
  if (typeof s !== 'string') return s;
  return s
    // KEY=value / KEY: value env-style assignments with secret-ish names.
    .replace(/([A-Za-z0-9_-]*(?:key|token|secret|passwd|password|pwd|credential|auth)[A-Za-z0-9_-]*\s*[=:]\s*)\S+/gi, '$1[redacted]')
    // --token xyz / -p xyz style flags.
    .replace(/(--?(?:token|password|passwd|pwd|api-?key|secret|auth)[A-Za-z-]*)([ =])\S+/gi, '$1$2[redacted]')
    // Authorization: Bearer xyz.
    .replace(/\b(bearer)\s+\S+/gi, '$1 [redacted]')
    // Bare credential tokens that carry no secret-ish key name: parity with
    // standup-autopilot's REDACTION_RES. This receipt lands in a PUBLIC PR body,
    // so prefer over-redaction.
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/g, '[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[redacted]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, '[redacted]');
}

// A runner's own verdict that tests failed. Every pattern is anchored to the
// start of a line, so a test name or log line that merely contains "error" or
// "BUILD FAILURE" never matches.
const RUNNER_FAILED = new RegExp([
  String.raw`^(?:=+ )?(?:\d+ [a-z]+, )*[1-9]\d* (?:failed|errors?)\b.*\bin [\d.]+s`, // pytest
  String.raw`^FAILED \((?:failures|errors)=`,                                         // unittest
  String.raw`^\s*Tests?(?: Suites| Files)?:?\s+.*\b[1-9]\d* failed\b`,                // jest, vitest
  String.raw`^\s*[1-9]\d* failing\b`,                                                 // mocha
  String.raw`^(?:#|ℹ) fail [1-9]`,                                                    // node --test
  String.raw`^--- FAIL:|^\s*FAIL\b`,                                                  // go test, jest
  String.raw`^test result: FAILED`,                                                   // cargo test
  String.raw`^not ok\b(?!.*#\s*(?:TODO|SKIP)\b)`,                                     // TAP
  String.raw`^\d+ examples?, [1-9]\d* failures?\b`,                                   // rspec
  String.raw`^✖ \d+ problems? \([1-9]\d* errors?, \d+ warnings?\)`,                   // eslint
  String.raw`^(?:\S+\(\d+,\d+\): |\S+:\d+:\d+ - )?error TS\d+:|^Found [1-9]\d* errors?\b`, // tsc
  String.raw`^(?:\[\w+\] )?(?:BUILD FAILURE\b|Tests run: \d+, Failures: (?:[1-9]|\d+, Errors: [1-9]))`, // maven
].join('|'), 'm');

// A runner's own verdict on the whole run: the only evidence of a pass when the
// exit status is hidden. One test's "ok" line is not a verdict, so TAP has none.
const RUNNER_PASSED = new RegExp([
  String.raw`^(?:=+ )?(?:\d+ [a-z]+, )*\d+ passed\b.*\bin [\d.]+s`,   // pytest
  String.raw`^OK\b`,                                                  // unittest
  String.raw`^\s*Tests?(?: Suites| Files)?:?\s+.*\b\d+ passed\b`,     // jest, vitest
  String.raw`^\s*\d+ passing\b`,                                      // mocha
  String.raw`^(?:#|ℹ) fail 0\b`,                                      // node --test
  String.raw`^ok\s+\S+\s+(?:[\d.]+s|\(cached\))`,                     // go test
  String.raw`^test result: ok\.`,                                     // cargo test
  String.raw`^\d+ examples?, 0 failures\b`,                           // rspec
  String.raw`^✖ \d+ problems? \(0 errors, \d+ warnings?\)`,           // eslint
  String.raw`^Found 0 errors\b`,                                      // tsc
  String.raw`^(?:\[\w+\] )?BUILD SUCCESS\b`,                          // maven
].join('|'), 'm');

// A line the runner marked as passed, or as a TAP todo/skip (which does not
// fail a run). Its text is a test name, never evidence of a failure.
const PASS_LINE = /^\s*(?:[✓✔√]|ok\b|PASS(?:ED)?\b|--- PASS\b)|\bPASSED\s*(?:\[\s*\d+%\s*\]\s*)?$|\.\.\.\s+ok\s*$|#\s*(?:TODO|SKIP)\b/;
// Looser failure words, trusted only when the exit status is hidden.
const FAILURE_WORDS = /\b(FAIL|FAILED|failed|failing|error:|Error:|ERROR|not ok)\b|\b[1-9]\d*\s+errors?\b|command not found|No such file or directory/;

function outputHasFailureWords(lines) {
  return lines.some((line) => {
    // "0 failed", "0 failing" and node --test's "fail 0" are not failures.
    const cleaned = line
      .replace(/\b0\s+(?:tests?\s+)?fail(?:ed|ing|ures?)?\b/gi, '')
      .replace(/\bfail(?:ed|ing|ures?)?[:\s]+0\b/gi, '')
      .replace(/\b(?:errors?)[:\s]+0\b/gi, '')
      .replace(/\b0\s+errors?\b/gi, '');
    return FAILURE_WORDS.test(cleaned);
  });
}

const HIDES_STATUS = /[|;&\n`]|\$\(|(?:^|\s)!\s/;
const withoutChainsAndRedirects = (s) => s.replace(/\d*[<>]&\d*-?|&>>?/g, ' ').replace(/&&/g, ' ');

// True when the command line's exit status may not be the test runner's: a
// pipe, `;`, `||`, a background `&`, a second line, a substitution or a leading
// `!` can each replace it. `&&` chains and fd redirects (2>&1) keep it. Quoted
// text is an argument, unless the test command itself sits inside the quotes
// (sh -c 'npm test || true'), where the same rule applies to the quoted script.
function exitStatusMayBeHidden(command) {
  let hidden = false;
  const bare = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (quoted) => {
    const inner = quoted.slice(1, -1);
    if (TEST_CMD_RE.test(inner) && HIDES_STATUS.test(withoutChainsAndRedirects(inner))) hidden = true;
    return quoted[0] === '"' && /\$\(|`/.test(inner) ? ' $( ' : ' ';
  });
  return hidden || HIDES_STATUS.test(withoutChainsAndRedirects(bare));
}

/**
 * Detect a test/typecheck command and its result from a Bash PostToolUse.
 * Claude Code sends PostToolUse only when the command line exited 0 and gives
 * no exit code. So a runner's own failure summary overrules the zero exit (a
 * script that swallows the status), and a line that may hide the runner's
 * status needs evidence in the output either way: a failure, a passing summary,
 * or neither, which is no result (exit null, as for a backgrounded run). A
 * result read from the output rather than the exit status is `inferred`.
 */
function extractTestResult(command, toolResponse, toolInput) {
  if (typeof command !== 'string' || !TEST_CMD_RE.test(command)) return null;
  const cmd = testCommandLabel(command);
  const r = toolResponse && typeof toolResponse === 'object' ? toolResponse : null;
  if (!r) return { cmd, exit: null, ok: false };
  for (const key of ['exit_code', 'exitCode', 'returnCode']) {
    if (typeof r[key] === 'number') return { cmd, exit: r[key], ok: r[key] === 0 };
  }
  if (r.interrupted === true) return { cmd, exit: 130, ok: false };
  if (r.backgroundTaskId || (toolInput && toolInput.run_in_background === true)) return { cmd, exit: null, ok: false };
  const output = `${typeof r.stdout === 'string' ? r.stdout : ''}\n${typeof r.stderr === 'string' ? r.stderr : ''}`
    .replace(/\x1b\[[0-9;]*m/g, '');
  const unmarked = output.split('\n').filter((line) => !PASS_LINE.test(line));
  const hidden = exitStatusMayBeHidden(command);
  if (RUNNER_FAILED.test(unmarked.join('\n')) || (hidden && outputHasFailureWords(unmarked))) return { cmd, exit: 1, ok: false, inferred: true };
  if (!hidden) return { cmd, exit: 0, ok: true };
  if (RUNNER_PASSED.test(output)) return { cmd, exit: 0, ok: true, inferred: true };
  return { cmd, exit: null, ok: false };
}

// Collapsed to one line (the receipt renders it in a markdown list) and
// redacted: this string ends up in a PUBLIC PR body.
function testCommandLabel(command) {
  return redactSecrets(command.trim().replace(/\s+/g, ' ')).slice(0, 200);
}

// Claude Code reports a non-zero Bash exit as PostToolUseFailure, whose `error`
// starts with "Exit code N". The rest of the string is display text.
function exitCodeFromFailure(error, isInterrupt) {
  if (isInterrupt === true) return 130;
  const m = typeof error === 'string' ? /^\s*Exit code (\d+)/.exec(error) : null;
  const code = m ? Number(m[1]) : NaN;
  return Number.isInteger(code) && code > 0 ? code : 1;
}

/** Apply a single PostToolUse event to the ledger, returning the mutated ledger. */
function applyPostToolUse(ledger, toolName, toolInput, toolResponse) {
  ledger.tool_calls = (ledger.tool_calls || 0) + 1; // event counter, NOT prompts
  if (toolName === 'Write') {
    ledger.writes += 1;
    ledger.agent_lines += countAddedLines('Write', toolInput);
  } else if (toolName === 'Edit' || toolName === 'MultiEdit') {
    ledger.edits += 1;
    ledger.agent_lines += countAddedLines('Edit', toolInput);
  } else if (toolName === 'Bash') {
    const test = extractTestResult(toolInput && toolInput.command, toolResponse, toolInput);
    if (test) ledger.tests.push(test);
  }
  return ledger;
}

/** Apply a PostToolUseFailure event: a test command that failed is recorded red. */
function applyPostToolUseFailure(ledger, toolName, toolInput, error, isInterrupt) {
  ledger.tool_calls = (ledger.tool_calls || 0) + 1;
  const command = toolInput && toolInput.command;
  if (toolName === 'Bash' && typeof command === 'string' && TEST_CMD_RE.test(command)) {
    const exit = exitCodeFromFailure(error, isInterrupt);
    ledger.tests.push({ cmd: testCommandLabel(command), exit, ok: false });
  }
  return ledger;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transcript parsing: prompt count, models, token/dollar spend (issue #11008)
// ─────────────────────────────────────────────────────────────────────────────

function normalizeModel(model) {
  if (typeof model !== 'string') return null;
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'claude-opus';
  if (m.includes('sonnet')) return 'claude-sonnet';
  if (m.includes('haiku')) return 'claude-haiku';
  return model;
}

function priceFor(model) {
  return PRICING[normalizeModel(model)] || DEFAULT_PRICING;
}

/**
 * Parse a transcript JSONL string. Returns { userPrompts, models, tokens, dollars }.
 * Robust to malformed lines; degrades to zeros. usage lives on assistant messages.
 */
function parseTranscript(text) {
  const out = { userPrompts: 0, models: [], inputTokens: 0, outputTokens: 0, dollars: 0, hasUsage: false };
  if (typeof text !== 'string' || !text.trim()) return out;
  const modelSet = new Set();
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let msg;
    try { msg = JSON.parse(t); } catch { continue; }
    if (!msg || typeof msg !== 'object') continue;

    // Count genuine user prompts (exclude tool_result-only user turns).
    const role = msg.type || msg.role || (msg.message && msg.message.role);
    if (role === 'user') {
      const inner = msg.message || msg;
      const content = inner.content;
      let isRealPrompt = false;
      if (typeof content === 'string' && content.trim()) isRealPrompt = true;
      else if (Array.isArray(content)) {
        isRealPrompt = content.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim());
      }
      // Skip synthetic/meta turns.
      if (msg.isMeta || inner.isMeta) isRealPrompt = false;
      if (isRealPrompt) out.userPrompts += 1;
    }

    // Usage + model live on assistant messages.
    const inner = msg.message || msg;
    if (inner && inner.model) modelSet.add(normalizeModel(inner.model) || inner.model);
    const usage = (inner && inner.usage) || msg.usage;
    if (usage && typeof usage === 'object') {
      const inp = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
      const outp = usage.output_tokens || 0;
      if (inp || outp) {
        out.hasUsage = true;
        out.inputTokens += inp;
        out.outputTokens += outp;
        const price = priceFor(inner && inner.model);
        out.dollars += (inp / 1e6) * price.input + (outp / 1e6) * price.output;
      }
    }
  }
  out.models = [...modelSet];
  return out;
}

function readTranscript(transcriptPath) {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
    const stat = fs.statSync(transcriptPath);
    // Cost/latency guard: cap transcript read at 16MB.
    if (stat.size > 16 * 1024 * 1024) return null;
    return fs.readFileSync(transcriptPath, 'utf-8');
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Human-line detection: agent-authored % needs a real total from the git diff.
//
// The ledger only ever sees lines the AGENT wrote (via Edit/Write tool calls),
// so agent_lines alone can never yield a non-100% split. To get a truthful
// denominator we ask git for the TOTAL added lines on this branch vs its merge
// base, then attribute the remainder to humans:
//     human_lines = max(0, totalBranchAdded - agent_lines)
// This is a real, computed signal (pre-existing hand edits, teammate commits,
// or lines the agent added before the hook was installed all surface as human).
//
// Injectable via the `runGit` param so tests never shell out. Degrades to null
// (→ percentage suppressed, absolute agent count shown instead) whenever git is
// unavailable, this isn't a repo, or numstat can't be parsed.
// ─────────────────────────────────────────────────────────────────────────────

function defaultRunGit(args, cwd) {
  return execFileSync('git', args, {
    cwd: cwd || process.cwd(),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 3000, // latency guard
    maxBuffer: 8 * 1024 * 1024,
  });
}

/** Sum added lines across a `git diff --numstat` blob (binary rows → skipped). */
function sumNumstatAdditions(numstat) {
  if (typeof numstat !== 'string') return 0;
  let total = 0;
  for (const line of numstat.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const cols = t.split('\t');
    // format: <added>\t<removed>\t<path>. Binary files show '-'.
    const added = parseInt(cols[0], 10);
    if (Number.isFinite(added)) total += added;
  }
  return total;
}

/**
 * Total lines ADDED on the current branch relative to its merge base with the
 * default remote branch (origin/HEAD → main/master). Returns null on any
 * failure so callers can degrade gracefully. `runGit(args, cwd)` is injectable.
 */
function totalBranchAddedLines(cwd, runGit = defaultRunGit) {
  const bases = [];
  // Prefer the symbolic default branch; fall back to common names.
  try {
    const ref = runGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], cwd).trim();
    if (ref) bases.push(ref.replace(/^refs\/remotes\//, '').trim());
  } catch {}
  bases.push('origin/main', 'origin/master', 'main', 'master');

  for (const base of bases) {
    try {
      const mergeBase = runGit(['merge-base', base, 'HEAD'], cwd).trim();
      if (!mergeBase) continue;
      const numstat = runGit(['diff', '--numstat', `${mergeBase}...HEAD`], cwd);
      const committed = sumNumstatAdditions(numstat);
      // Include not-yet-committed work so a stamp created before the final
      // commit still reflects the real diff.
      let uncommitted = 0;
      try { uncommitted = sumNumstatAdditions(runGit(['diff', '--numstat', 'HEAD'], cwd)); } catch {}
      let staged = 0;
      try { staged = sumNumstatAdditions(runGit(['diff', '--numstat', '--cached'], cwd)); } catch {}
      return committed + uncommitted + staged;
    } catch {
      // try next candidate base
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stamp rendering
// ─────────────────────────────────────────────────────────────────────────────

/** Dollar figures are list-price ESTIMATES: always rendered with a `~`. */
function fmtDollars(d) {
  if (!(d > 0)) return null;
  if (d < 0.01) return '<$0.01';
  return `~$${d.toFixed(2)}`;
}

function fmtTokens(n) {
  if (!(n > 0)) return null;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/**
 * Build the provenance summary object from a ledger + parsed transcript.
 *
 * `totalAddedLines` (optional): total lines added on the branch per git. When
 * provided (and >= agent lines) it becomes the denominator for a TRUTHFUL
 * agent-authored percentage: human_lines = totalAddedLines - agent_lines.
 * When absent/unusable, we do NOT fabricate a 100% figure: agentPct stays null
 * and callers surface the absolute agent line count instead.
 */
function buildProvenance(ledger, transcript, totalAddedLines = null) {
  const tests = Array.isArray(ledger.tests) ? ledger.tests : [];
  // A run with no captured result (backgrounded, or cut off by a pipe) is
  // neither green nor failing.
  const known = tests.filter((t) => t.exit != null);
  const passed = known.filter((t) => t.ok).length;
  const total = known.length;

  // Prefer transcript-derived prompt count; fall back to ledger proxy.
  const prompts = transcript && transcript.userPrompts > 0 ? transcript.userPrompts : null;

  const agent = Math.max(0, ledger.agent_lines || 0);

  // Determine a real human line count. Precedence:
  //   1. An explicit ledger.human_lines (e.g. a future explicit detector/tests).
  //   2. git branch total minus agent lines.
  //   3. Unknown → no percentage (avoid the always-100% lie).
  let human = null;
  if (Number.isFinite(ledger.human_lines) && ledger.human_lines > 0) {
    human = Math.max(0, ledger.human_lines);
  } else if (Number.isFinite(totalAddedLines) && totalAddedLines >= agent && (totalAddedLines > 0 || agent > 0)) {
    human = Math.max(0, totalAddedLines - agent);
  }

  // A percentage is only meaningful when we have a real denominator that isn't
  // just the agent's own lines. If human is unknown, suppress the percentage.
  let agentPct = null;
  const denom = human == null ? null : agent + human;
  if (denom != null && denom > 0) agentPct = Math.round((agent / denom) * 100);

  const models = (transcript && transcript.models.length ? transcript.models : ledger.models || [])
    .map((m) => String(m).replace(/^claude-/, ''));

  return {
    prompts,
    dollars: transcript ? transcript.dollars : 0,
    tokens: transcript ? transcript.inputTokens + transcript.outputTokens : 0,
    hasUsage: !!(transcript && transcript.hasUsage),
    testsPassed: passed,
    testsTotal: total,
    testsNotCaptured: tests.length - total,
    tests,
    agentPct,
    agentLines: agent,
    humanLines: human,
    models: [...new Set(models)],
  };
}

/** One-line human summary (used in the header / logs / viral screenshot line). */
function renderSummaryLine(p) {
  const parts = [];
  if (p.prompts != null) parts.push(`${p.prompts} prompt${p.prompts === 1 ? '' : 's'}`);
  const d = fmtDollars(p.dollars);
  if (d) parts.push(d);
  const missing = p.testsNotCaptured > 0 ? `${p.testsNotCaptured} not captured` : '';
  if (p.testsTotal > 0) {
    const glyph = p.testsPassed === p.testsTotal ? 'green' : `${p.testsTotal - p.testsPassed} failing`;
    parts.push(`tests ${p.testsPassed}/${p.testsTotal} ${glyph}${missing && `, ${missing}`}`);
  } else if (missing) {
    parts.push(`tests ${missing}`);
  }
  if (p.agentPct != null) parts.push(`${p.agentPct}% agent-authored`);
  else if (p.agentLines > 0) parts.push(`${p.agentLines} agent-authored lines`);
  return `Built with Claude Code: ${parts.length ? parts.join(' · ') : 'session receipt'}`;
}

/** Full markdown card wrapped in idempotency sentinels. */
function renderStamp(p) {
  const lines = [];
  lines.push(STAMP_BEGIN);
  lines.push('---');
  lines.push('### 🔎 Provenance');
  lines.push('');
  lines.push(`> **${renderSummaryLine(p)}**`);
  lines.push('');
  lines.push('| Signal | Value |');
  lines.push('| --- | --- |');
  if (p.prompts != null) lines.push(`| Prompts | ${p.prompts} |`);
  const d = fmtDollars(p.dollars);
  const tk = fmtTokens(p.tokens);
  if (d && tk) lines.push(`| Spend (est.) | ${d} (${tk} tokens) |`);
  else if (d) lines.push(`| Spend (est.) | ${d} |`);
  if (p.models.length) lines.push(`| Models | ${p.models.join(', ')} |`);
  const missing = p.testsNotCaptured > 0 ? `${p.testsNotCaptured} not captured` : '';
  if (p.testsTotal > 0) {
    const glyph = p.testsPassed === p.testsTotal ? '✓' : '✗';
    lines.push(`| Tests | ${p.testsPassed}/${p.testsTotal} ${glyph}${missing && ` (${missing})`} |`);
  } else if (missing) {
    lines.push(`| Tests | ${missing} |`);
  }
  if (p.agentPct != null) lines.push(`| Agent-authored | ${p.agentPct}% (${p.agentLines} of ${p.agentLines + (p.humanLines || 0)} added lines) |`);
  else if (p.agentLines > 0) lines.push(`| Agent-authored | ${p.agentLines} lines |`);
  if (p.tests.length > 0) {
    lines.push('');
    lines.push('<details><summary>Test commands & exit codes</summary>');
    lines.push('');
    for (const t of p.tests) {
      // Redact again at render time (defense in depth: ledgers written by older
      // versions of this hook may hold unredacted commands).
      const cmd = redactSecrets(String(t.cmd || '')).replace(/`/g, '').replace(/\s+/g, ' ');
      let result = `exit ${t.exit} ${t.ok ? '✓' : '✗'}`;
      if (t.exit == null) result = 'result not captured';
      else if (t.inferred) result = t.ok ? 'passed per its output ✓' : 'failures in its output ✗';
      lines.push(`- \`${cmd}\` → ${result}`);
    }
    lines.push('');
    lines.push('</details>');
  }
  lines.push('');
  lines.push('<sub>Generated by the pr-provenance-stamp Claude Code hook.</sub>');
  lines.push(STAMP_END);
  return lines.join('\n');
}

/** Idempotently splice the stamp into an existing PR body (replace prior stamp). */
function applyStampToBody(body, stampBlock) {
  const base = typeof body === 'string' ? body : '';
  const startIdx = base.indexOf(STAMP_BEGIN);
  const endIdx = base.indexOf(STAMP_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = base.slice(0, startIdx).replace(/\s+$/, '');
    const after = base.slice(endIdx + STAMP_END.length).replace(/^\s+/, '');
    const middle = [before, stampBlock, after].filter((s) => s !== '').join('\n\n');
    return middle;
  }
  return base.trim() ? `${base.trim()}\n\n${stampBlock}` : stampBlock;
}

// ─────────────────────────────────────────────────────────────────────────────
// PR-create command detection + --body argument rewriting
// ─────────────────────────────────────────────────────────────────────────────

const PR_CREATE_RE = /\bgh\s+pr\s+create\b/;
const MR_CREATE_RE = /\bglab\s+mr\s+create\b/;

function isPrCreate(command) {
  return typeof command === 'string' && (PR_CREATE_RE.test(command) || MR_CREATE_RE.test(command));
}

/**
 * Tokenize a shell command respecting single/double quotes. Returns array of
 * { text, quote, start, end } where quote is '', '"' or "'" and start/end are
 * the token's SOURCE offsets in the original string. The offsets are what make
 * safe rewriting possible: we only ever splice the body value's exact source
 * range and leave every other byte of the command untouched.
 */
function tokenizeShell(command) {
  const tokens = [];
  let i = 0;
  const n = command.length;
  while (i < n) {
    while (i < n && /\s/.test(command[i])) i++;
    if (i >= n) break;
    const start = i;
    let text = '';
    let quote = '';
    while (i < n && !/\s/.test(command[i])) {
      const ch = command[i];
      if (ch === '"' || ch === "'") {
        quote = quote || ch;
        i++;
        while (i < n && command[i] !== ch) {
          if (ch === '"' && command[i] === '\\' && i + 1 < n) { text += command[i + 1]; i += 2; continue; }
          text += command[i]; i++;
        }
        i++; // closing quote
      } else {
        text += ch; i++;
      }
    }
    tokens.push({ text, quote, start, end: Math.min(i, n) });
  }
  return tokens;
}

function shellQuote(s) {
  // Single-quote wrapping is safest for arbitrary markdown bodies.
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Quote-aware scan for shell constructs whose presence (outside single quotes,
 * where everything is literal) makes rewriting unsafe: heredocs, `$(...)`,
 * backticks, process substitution. Single-quoted occurrences are LITERAL text
 * (e.g. backticks inside an already-stamped, single-quoted --body) and are not
 * flagged: that is what keeps re-stamping idempotent. Returns a reason string
 * or null.
 */
function findUnsafeConstruct(command) {
  let inS = false;
  let inD = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (inS) { if (ch === "'") inS = false; continue; }
    if (ch === '\\') { i++; continue; }
    if (ch === '`') return 'backtick';
    if (ch === '$' && command[i + 1] === '(') return 'command-substitution';
    // ANSI-C ($'..') and locale ($"..") quoting have escape rules the tokenizer does not model.
    if (ch === '$' && (command[i + 1] === "'" || command[i + 1] === '"') && !inD) return 'ansi-c-quote';
    if (inD) { if (ch === '"') inD = false; continue; }
    if (ch === "'") { inS = true; continue; }
    if (ch === '"') { inD = true; continue; }
    if (ch === '<' && command[i + 1] === '<') return 'heredoc';
    if ((ch === '<' || ch === '>') && command[i + 1] === '(') return 'process-substitution';
  }
  return null;
}

/**
 * Detect shell constructs that make body rewriting unsafe (heredocs, `$(...)`,
 * backticks, process substitution: the DOMINANT forms Claude Code and the
 * ship skill use to author PR bodies). When present, the hook MUST defer
 * (no-op) rather than emit safe-but-wrong output. We intentionally over-defer:
 * a false "unsafe" is a missed stamp, a false "safe" is a corrupted PR body.
 */
function hasUnsafeShellConstruct(command) {
  if (typeof command !== 'string') return false;
  return findUnsafeConstruct(command) !== null;
}

/** Does `src` contain a char matching `re` OUTSIDE any quotes? */
function containsUnquoted(src, re) {
  let inS = false;
  let inD = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inS) { if (ch === "'") inS = false; continue; }
    if (ch === '\\') { i++; continue; }
    if (inD) { if (ch === '"') inD = false; continue; }
    if (ch === "'") { inS = true; continue; }
    if (ch === '"') { inD = true; continue; }
    if (re.test(ch)) return true;
  }
  return false;
}

/**
 * Is the RAW source of a body value safe to extract and re-emit single-quoted?
 * Safe = its literal text survives the round trip exactly. Unsafe: any `$` or
 * backtick outside single quotes (live expansion would be literalized), any
 * backslash (escape semantics differ per quoting context), any unquoted shell
 * metacharacter, or unbalanced quotes.
 */
function bodyValueRegionSafe(raw) {
  let inS = false;
  let inD = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inS) { if (ch === "'") inS = false; continue; }
    if (ch === '\\') return false;
    if (ch === '$' || ch === '`') return false;
    if (inD) { if (ch === '"') inD = false; continue; }
    if (ch === "'") { inS = true; continue; }
    if (ch === '"') { inD = true; continue; }
    if (!/[A-Za-z0-9@%+=:,._/-]/.test(ch)) return false;
  }
  return !inS && !inD;
}

/** Token text that could carry a PR body by another route than a clean `--body`/`-b value` pair. */
function isBodyLikeToken(t) {
  if (t.text.startsWith('--body')) return true; // --body, --body=, --body-file, --body-file=
  if (t.text === '-b' || t.text.startsWith('-F')) return true;
  // Single-dash cluster / attached value containing lowercase b (-db, -bTEXT).
  if (/^-[a-zA-Z]/.test(t.text) && !t.text.startsWith('--') && t.text.includes('b')) return true;
  return false;
}

/**
 * Find `gh pr create` / `glab mr create` in COMMAND POSITION (start of string,
 * after a separator, after a newline, or after leading VAR=val assignments) as
 * three consecutive unquoted tokens. Quoted occurrences: `echo "gh pr create"`
 *: never match. Returns the index of the `create` token, or -1.
 */
function findCreateCommand(tokens, command) {
  const SEQS = [['gh', 'pr', 'create'], ['glab', 'mr', 'create']];
  for (let i = 0; i + 2 < tokens.length; i++) {
    for (const seq of SEQS) {
      if (tokens[i].quote !== '' || tokens[i].text !== seq[0]) continue;
      if (tokens[i + 1].quote !== '' || tokens[i + 1].text !== seq[1]) continue;
      if (tokens[i + 2].quote !== '' || tokens[i + 2].text !== seq[2]) continue;
      const gap1 = command.slice(tokens[i].end, tokens[i + 1].start);
      const gap2 = command.slice(tokens[i + 1].end, tokens[i + 2].start);
      if (/[\n\\]/.test(gap1) || /[\n\\]/.test(gap2)) continue;
      if (isCommandPosition(tokens, i, command)) return i + 2;
    }
  }
  return -1;
}

function isCommandPosition(tokens, i, command) {
  let j = i - 1;
  // Walk back over leading environment assignments (GH_TOKEN=x gh pr create).
  while (j >= 0 && tokens[j].quote === '' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[j].text)) j--;
  if (j < 0) return true;
  const prev = tokens[j];
  const gap = command.slice(prev.end, tokens[j + 1].start);
  // A bare (non-continuation) newline starts a new command.
  if (/\n/.test(gap) && !/\\/.test(gap)) return true;
  if (prev.quote === '') {
    if (['&&', '||', ';', '|', '&', '('].includes(prev.text)) return true;
    // A token whose RAW source ends in an unescaped separator (`git push;`).
    const prevRaw = command.slice(prev.start, prev.end);
    if (/[;&|(]$/.test(prevRaw) && !/\\[;&|(]$/.test(prevRaw)) return true;
  }
  return false;
}

/**
 * Rewrite the --body / -b argument (or add one) in a `gh pr create` command by
 * SPLICING only the body value's source range: every other byte of the command
 * (other args, `&&` chains, newlines, `$VAR` references elsewhere) is preserved
 * verbatim. Returns { command, changed, deferred?, reason? }.
 *
 * Defers (returns the command unchanged) whenever a rewrite could not be
 * byte-faithful: unsafe shell constructs, `gh pr create` not in command
 * position, --body-file / -F / --fill* flows, ambiguous short-flag clusters
 * (-db, -bTEXT), a body value containing live expansion (`$`, backslash) or
 * unquoted metacharacters, a missing body value, or a body-like flag we cannot
 * bind to the gh command. A missed stamp is acceptable; a mangled command or a
 * clobbered PR body is not.
 */
function rewriteBodyArg(command, stampBlock) {
  if (typeof command !== 'string') return { command, changed: false };

  const unsafe = findUnsafeConstruct(command);
  if (unsafe) {
    return { command, changed: false, deferred: true, reason: `unsafe-shell-construct:${unsafe}` };
  }

  const tokens = tokenizeShell(command);
  const createIdx = findCreateCommand(tokens, command);
  if (createIdx === -1) {
    return { command, changed: false, deferred: true, reason: 'no-command-position-pr-create' };
  }

  // The gh command's argument window: tokens after `create` up to the first
  // separator (unquoted ; & | < > ( ) #, a newline, or a line continuation).
  const win = [];
  for (let k = createIdx + 1; k < tokens.length; k++) {
    const gapBefore = command.slice(tokens[k - 1].end, tokens[k].start);
    if (/[\n\\]/.test(gapBefore)) break;
    const raw = command.slice(tokens[k].start, tokens[k].end);
    if (containsUnquoted(raw, /[;&|<>()#]/)) break;
    win.push(k);
  }
  const winSet = new Set(win);

  // Body-routing flags we refuse to touch. Flag names are identified by each
  // token's UNQUOTED RAW PREFIX (the flag part of `--body="x"` is unquoted even
  // though the token contains quotes).
  for (const k of win) {
    const t = tokens[k];
    const raw = command.slice(t.start, t.end);
    const qi = raw.search(/['"]/);
    const pre = qi === -1 ? raw : raw.slice(0, qi);
    if (/^--body-file(=|$)/.test(pre) || /^-F/.test(pre) || /^--fill/.test(pre)) {
      return { command, changed: false, deferred: true, reason: 'body-from-file-or-fill' };
    }
    // A fully-quoted token that *reads* like a body flag ('--body') is still a
    // flag to gh but ambiguous to us: defer.
    if (pre === '' && isBodyLikeToken(t)) {
      return { command, changed: false, deferred: true, reason: 'quoted-body-flag' };
    }
    // Short-flag cluster / attached value containing b (-db, -bTEXT, -b"TEXT").
    if (/^-[a-zA-Z]/.test(pre) && !pre.startsWith('--') && pre !== '-b' && pre.includes('b')) {
      return { command, changed: false, deferred: true, reason: 'ambiguous-short-flag' };
    }
    if (pre === '-b' && raw.length > 2) {
      return { command, changed: false, deferred: true, reason: 'ambiguous-short-flag' };
    }
  }

  // Locate the LAST inline body flag in the window (gh: last flag value wins).
  let bodyIdx = -1;
  let bodyEq = false;
  for (const k of win) {
    const t = tokens[k];
    const raw = command.slice(t.start, t.end);
    if (raw.startsWith('--body=')) { bodyIdx = k; bodyEq = true; }
    else if (t.quote === '' && (t.text === '--body' || t.text === '-b')) { bodyIdx = k; bodyEq = false; }
  }

  if (bodyIdx === -1) {
    // Append a stamp-only --body: but ONLY if no body-like token exists
    // anywhere else in the command (a second --body would win gh's
    // last-flag-wins and silently clobber the real one).
    if (tokens.some((t, k) => !winSet.has(k) && k !== createIdx && isBodyLikeToken(t))) {
      return { command, changed: false, deferred: true, reason: 'body-flag-outside-window' };
    }
    const insertAt = tokens[createIdx].end;
    const newBody = applyStampToBody('', stampBlock);
    const rewritten = command.slice(0, insertAt) + ` --body ${shellQuote(newBody)}` + command.slice(insertAt);
    return { command: rewritten, changed: true };
  }

  const tok = tokens[bodyIdx];
  let valueStart;
  let valueEnd;
  let existing;
  if (bodyEq) {
    const raw = command.slice(tok.start, tok.end);
    valueStart = tok.start + raw.indexOf('=') + 1;
    valueEnd = tok.end;
    existing = tok.text.slice('--body='.length);
  } else {
    if (!winSet.has(bodyIdx + 1)) {
      return { command, changed: false, deferred: true, reason: 'missing-body-value' };
    }
    const vTok = tokens[bodyIdx + 1];
    valueStart = vTok.start;
    valueEnd = vTok.end;
    existing = vTok.text;
  }

  const rawValue = command.slice(valueStart, valueEnd);
  if (!bodyValueRegionSafe(rawValue)) {
    return { command, changed: false, deferred: true, reason: 'unsafe-body-value' };
  }

  const stamped = applyStampToBody(existing, stampBlock);
  const rewritten = command.slice(0, valueStart) + shellQuote(stamped) + command.slice(valueEnd);
  return { command: rewritten, changed: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Event handlers
// ─────────────────────────────────────────────────────────────────────────────

function handlePostToolUse(data, dir = STATE_DIR) {
  const { tool_name, tool_input, tool_response, session_id } = data;
  if (!['Edit', 'Write', 'MultiEdit', 'Bash'].includes(tool_name)) return {};
  appendLedgerEvent(session_id, applyPostToolUse(emptyLedger(session_id), tool_name, tool_input, tool_response), dir);
  return {};
}

function handlePostToolUseFailure(data, dir = STATE_DIR) {
  const { tool_name, tool_input, error, is_interrupt, session_id } = data;
  if (tool_name !== 'Bash') return {};
  appendLedgerEvent(session_id, applyPostToolUseFailure(emptyLedger(session_id), tool_name, tool_input, error, is_interrupt), dir);
  return {};
}

function handlePreToolUse(data, dir = STATE_DIR, runGit = defaultRunGit) {
  const { tool_name, tool_input, session_id, transcript_path, cwd } = data;
  if (tool_name !== 'Bash') return {};
  const command = tool_input && tool_input.command;
  if (!isPrCreate(command)) return {};

  const ledger = loadLedger(session_id, dir);
  const transcript = parseTranscript(readTranscript(transcript_path) || '');
  // Real human/agent split needs a git denominator. Degrades to
  // null → percentage suppressed rather than a fake 100%.
  let totalAdded = null;
  if (cwd) {
    try { totalAdded = totalBranchAddedLines(cwd, runGit); } catch { totalAdded = null; }
  }
  const prov = buildProvenance(ledger, transcript, totalAdded);
  const stampBlock = renderStamp(prov);
  const { command: newCommand, changed, deferred, reason } = rewriteBodyArg(command, stampBlock);

  if (!changed) {
    log({ level: 'SKIP', reason: reason || (deferred ? 'deferred flow' : 'no rewrite'), session_id });
    return {};
  }

  log({
    level: 'STAMPED',
    session_id,
    summary: renderSummaryLine(prov),
    prompts: prov.prompts,
    dollars: Number(prov.dollars.toFixed(4)),
    tests: `${prov.testsPassed}/${prov.testsTotal}`,
    agentPct: prov.agentPct,
  });

  // "ask", never "allow": see the updatedInput SCHEMA caveat in the header.
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: 'pr-provenance-stamp: appended provenance receipt to the --body argument',
      updatedInput: { ...tool_input, command: newCommand },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let data;
  try {
    data = JSON.parse(input);
  } catch (e) {
    return console.log('{}');
  }

  try {
    const event = data && data.hook_event_name;
    let out = {};
    if (event === 'PreToolUse') out = handlePreToolUse(data);
    else if (event === 'PostToolUse') out = handlePostToolUse(data);
    else if (event === 'PostToolUseFailure') out = handlePostToolUseFailure(data);
    else {
      // Fallback: infer from presence of tool_response (PostToolUse has it).
      if (Object.prototype.hasOwnProperty.call(data, 'tool_response')) out = handlePostToolUse(data);
      else out = handlePreToolUse(data);
    }
    console.log(JSON.stringify(out || {}));
  } catch (e) {
    log({ level: 'ERROR', error: e && e.message });
    console.log('{}');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// --render CLI: preview the receipt for the most recent session ledger.
//
// Powers `/pr-provenance-stamp:provenance`. Prints the EXACT stamp block the
// PreToolUse branch would splice into a PR body, built from the newest ledger
// under STATE_DIR (via the same buildProvenance/renderStamp helpers: no logic
// is duplicated). There is no transcript at render time, so prompt/spend/model
// figures degrade to omitted rather than faked; the git denominator is taken
// from the current repo so the agent-authored % is still real when available.
// Never throws; falls back to a friendly no-ledger-yet message on empty state.
// ─────────────────────────────────────────────────────────────────────────────

/** Absolute path of the most-recently-modified ledger file, or null. */
function findLatestLedger(dir = STATE_DIR) {
  try {
    const files = fs.readdirSync(dir).filter((f) => /\.jsonl?$/.test(f));
    let best = null;
    for (const f of files) {
      const full = path.join(dir, f);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
      if (!best || mtime > best.mtime) best = { full, mtime };
    }
    return best ? best.full : null;
  } catch {
    return null;
  }
}

function renderCli(dir = STATE_DIR, cwd = process.cwd(), runGit = defaultRunGit) {
  try {
    const file = findLatestLedger(dir);
    if (!file) {
      process.stdout.write(
        'No provenance ledger recorded yet.\n' +
        'Keep working in Claude Code (the PostToolUse hook records edits and test\n' +
        'runs as you go), then run /pr-provenance-stamp:provenance again: or just\n' +
        '`gh pr create` and the receipt is stamped into the PR body automatically.\n'
      );
      return;
    }
    const ledger = loadLedger(path.basename(file).replace(/\.jsonl?$/, ''), dir);
    // Real human/agent split needs a git denominator; degrades to null (→ the
    // absolute agent line count is shown instead of a fabricated percentage).
    let totalAdded = null;
    try { totalAdded = totalBranchAddedLines(cwd, runGit); } catch { totalAdded = null; }
    const prov = buildProvenance(ledger, parseTranscript(''), totalAdded);
    process.stdout.write(renderStamp(prov) + '\n');
  } catch (e) {
    process.stdout.write('pr-provenance-stamp: could not render receipt (' + (e && e.message) + ')\n');
  }
}

if (require.main === module) {
  if (process.argv.includes('--render')) {
    renderCli();
  } else {
    main();
  }
} else {
  module.exports = {
    emptyLedger,
    ledgerPath,
    eventsPath,
    loadLedger,
    appendLedgerEvent,
    countAddedLines,
    redactSecrets,
    extractTestResult,
    exitStatusMayBeHidden,
    applyPostToolUse,
    applyPostToolUseFailure,
    exitCodeFromFailure,
    normalizeModel,
    priceFor,
    parseTranscript,
    buildProvenance,
    renderSummaryLine,
    renderStamp,
    applyStampToBody,
    isPrCreate,
    tokenizeShell,
    shellQuote,
    hasUnsafeShellConstruct,
    findUnsafeConstruct,
    bodyValueRegionSafe,
    findCreateCommand,
    sumNumstatAdditions,
    totalBranchAddedLines,
    rewriteBodyArg,
    handlePostToolUse,
    handlePostToolUseFailure,
    handlePreToolUse,
    findLatestLedger,
    renderCli,
    STAMP_BEGIN,
    STAMP_END,
    TEST_CMD_RE,
  };
}
