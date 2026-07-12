#!/usr/bin/env node
/**
 * PR Provenance Stamp - PreToolUse (Bash) + PostToolUse (Edit|Write|Bash) Hook
 *
 * Embeds a reviewer-facing provenance receipt into the PR body when Claude runs
 * `gh pr create` (or `glab mr create`). PostToolUse hooks maintain a per-session
 * ledger under ~/.claude/pr-provenance-stamp/<session_id>.json — a tool-call
 * counter, agent-authored line count, and every test/typecheck command with its
 * real exit code. When `gh pr create` fires, the PreToolUse branch reads the
 * transcript for the real prompt count / token+dollar spend / models, asks git
 * for the branch's total added lines to derive a TRUTHFUL agent-vs-human split,
 * then rewrites the `--body` argument via hookSpecificOutput.updatedInput,
 * appending a stamp like:
 *
 *   Built with Claude Code — 23 prompts · $3.84 · tests 4/4 green · 92% agent-authored
 *
 * SAFE-OUTPUT GUARANTEE: if the command uses a heredoc, `$(...)` command
 * substitution, backticks, or process substitution to build the body (the
 * dominant forms the ship skill and Claude Code emit), the hook DEFERS — it
 * returns {} and never rewrites — because re-quoting those would literalize and
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
 * COST/TOKEN CAVEAT (GitHub issue #11008): hooks do NOT receive token/cost in
 * their input, so spend is parsed from the transcript JSONL at transcript_path.
 * When the transcript is absent/unparseable, token & dollar figures degrade to
 * omitted (never faked).
 *
 * updatedInput CAVEAT (GitHub issue #15897): returning `permissionDecision:
 * "allow"` alongside updatedInput causes updatedInput to be ignored. This hook
 * therefore returns a BARE updatedInput (no permission decision), which is the
 * form Claude Code honors.
 *
 * Setup in .claude/settings.json:
 * {
 *   "hooks": {
 *     "PostToolUse": [{
 *       "matcher": "Edit|Write|Bash",
 *       "hooks": [{ "type": "command", "command": "node /path/to/pr-provenance-stamp.js" }]
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
    // stamp time from the git branch diff (see buildProvenance / must-fix #2).
    human_lines: 0,
    tests: [], // { cmd, exit, ok }
    models: [], // list of model ids seen
  };
}

function ledgerPath(sessionId, dir = STATE_DIR) {
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120) || 'unknown';
  return path.join(dir, `${safe}.json`);
}

function loadLedger(sessionId, dir = STATE_DIR) {
  try {
    const raw = fs.readFileSync(ledgerPath(sessionId, dir), 'utf-8');
    const parsed = JSON.parse(raw);
    return { ...emptyLedger(sessionId), ...parsed };
  } catch {
    return emptyLedger(sessionId);
  }
}

function saveLedger(ledger, dir = STATE_DIR) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ledgerPath(ledger.session_id, dir), JSON.stringify(ledger));
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

/** Detect a test/typecheck command and its exit code from a Bash PostToolUse. */
function extractTestResult(command, toolResponse) {
  if (typeof command !== 'string' || !TEST_CMD_RE.test(command)) return null;
  let exit = null;
  if (toolResponse && typeof toolResponse === 'object') {
    if (typeof toolResponse.exit_code === 'number') exit = toolResponse.exit_code;
    else if (typeof toolResponse.exitCode === 'number') exit = toolResponse.exitCode;
    else if (typeof toolResponse.returnCode === 'number') exit = toolResponse.returnCode;
    else if (toolResponse.interrupted === true) exit = 130;
    else if (typeof toolResponse.stderr === 'string' && /command not found|No such file/i.test(toolResponse.stderr)) exit = 127;
  }
  // If no explicit exit code is available, treat a present stdout with no error
  // marker as a pass (exit 0), otherwise unknown.
  if (exit === null) {
    const stdout = toolResponse && typeof toolResponse.stdout === 'string' ? toolResponse.stdout : '';
    const stderr = toolResponse && typeof toolResponse.stderr === 'string' ? toolResponse.stderr : '';
    const blob = `${stdout}\n${stderr}`;
    if (/\b(FAIL|failed|failing|error:|Error:|not ok)\b/.test(blob)) exit = 1;
    else if (blob.trim() !== '') exit = 0;
  }
  return { cmd: command.trim().slice(0, 200), exit, ok: exit === 0 };
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
    const test = extractTestResult(toolInput && toolInput.command, toolResponse);
    if (test) ledger.tests.push(test);
  }
  return ledger;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transcript parsing — prompt count, models, token/dollar spend (issue #11008)
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
// Human-line detection (must-fix #2): agent-authored % needs a real total.
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

function fmtDollars(d) {
  if (!(d > 0)) return null;
  if (d < 0.01) return '<$0.01';
  return `$${d.toFixed(2)}`;
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
 * When absent/unusable, we do NOT fabricate a 100% figure — agentPct stays null
 * and callers surface the absolute agent line count instead (must-fix #2).
 */
function buildProvenance(ledger, transcript, totalAddedLines = null) {
  const tests = Array.isArray(ledger.tests) ? ledger.tests : [];
  const passed = tests.filter((t) => t.ok).length;
  const total = tests.length;

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
  if (p.testsTotal > 0) {
    const glyph = p.testsPassed === p.testsTotal ? 'green' : `${p.testsTotal - p.testsPassed} failing`;
    parts.push(`tests ${p.testsPassed}/${p.testsTotal} ${glyph}`);
  }
  if (p.agentPct != null) parts.push(`${p.agentPct}% agent-authored`);
  else if (p.agentLines > 0) parts.push(`${p.agentLines} agent-authored lines`);
  return `Built with Claude Code — ${parts.length ? parts.join(' · ') : 'session receipt'}`;
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
  if (d && tk) lines.push(`| Spend | ${d} (${tk} tokens) |`);
  else if (d) lines.push(`| Spend | ${d} |`);
  if (p.models.length) lines.push(`| Models | ${p.models.join(', ')} |`);
  if (p.testsTotal > 0) {
    const glyph = p.testsPassed === p.testsTotal ? '✓' : '✗';
    lines.push(`| Tests | ${p.testsPassed}/${p.testsTotal} ${glyph} |`);
  }
  if (p.agentPct != null) lines.push(`| Agent-authored | ${p.agentPct}% (${p.agentLines} of ${p.agentLines + (p.humanLines || 0)} added lines) |`);
  else if (p.agentLines > 0) lines.push(`| Agent-authored | ${p.agentLines} lines |`);
  if (p.testsTotal > 0) {
    lines.push('');
    lines.push('<details><summary>Test commands & exit codes</summary>');
    lines.push('');
    for (const t of p.tests) {
      const code = t.exit == null ? '?' : t.exit;
      lines.push(`- \`${t.cmd.replace(/`/g, '')}\` → exit ${code} ${t.ok ? '✓' : '✗'}`);
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
 * { text, quote } where quote is '', '"' or "'". Good enough for arg rewriting;
 * we never execute the result — Claude Code re-parses the returned command.
 */
function tokenizeShell(command) {
  const tokens = [];
  let i = 0;
  const n = command.length;
  while (i < n) {
    while (i < n && /\s/.test(command[i])) i++;
    if (i >= n) break;
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
    tokens.push({ text, quote });
  }
  return tokens;
}

function shellQuote(s) {
  // Single-quote wrapping is safest for arbitrary markdown bodies.
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Detect shell constructs that our tokenize→re-quote pipeline cannot faithfully
 * reconstruct. Rewriting a command that contains any of these would literalize
 * live interpolation (destroying the real body) or silently mangle multi-line
 * input. These are the DOMINANT forms Claude Code and the ship skill use to
 * author PR bodies (heredocs, `$(cat <<'EOF' ...)`, command substitution).
 *
 * When present, the hook MUST defer (no-op) rather than emit safe-but-wrong
 * output. We intentionally over-defer: a false "unsafe" is a missed stamp,
 * a false "safe" is a corrupted PR description.
 */
function hasUnsafeShellConstruct(command) {
  if (typeof command !== 'string') return false;
  // Heredoc: `<<EOF`, `<<-EOF`, `<<'EOF'`, `<< "EOF"`.
  if (/<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*/.test(command)) return true;
  // Command substitution: `$(...)`.
  if (/\$\(/.test(command)) return true;
  // Backtick command substitution: `...`.
  if (/`/.test(command)) return true;
  // Process substitution: `<(...)` / `>(...)`.
  if (/[<>]\(/.test(command)) return true;
  return false;
}

/**
 * Rewrite the --body / -b argument (or add one) in a `gh pr create` command.
 * Returns { command, changed }. Leaves --body-file / --fill flows untouched
 * (we only splice into an inline --body to avoid clobbering file-based flows).
 */
function rewriteBodyArg(command, stampBlock) {
  if (typeof command !== 'string') return { command, changed: false };
  // Defer on constructs the re-quoting pipeline cannot faithfully reproduce
  // (heredoc / $(...) / backticks / process substitution). See must-fix #1.
  if (hasUnsafeShellConstruct(command)) {
    return { command, changed: false, deferred: true, reason: 'unsafe-shell-construct' };
  }
  const tokens = tokenizeShell(command);
  // If the author uses --body-file or --fill, do not attempt inline rewrite.
  const usesFile = tokens.some((t) => t.text === '--body-file' || t.text === '-F' || t.text === '--fill');

  let bodyIdx = -1;
  for (let k = 0; k < tokens.length; k++) {
    if (tokens[k].text === '--body' || tokens[k].text === '-b') { bodyIdx = k; break; }
    const m = tokens[k].text.match(/^--body=(.*)$/s);
    if (m) { bodyIdx = k; break; }
  }

  if (usesFile && bodyIdx === -1) {
    return { command, changed: false, deferred: true };
  }

  let newBody;
  if (bodyIdx === -1) {
    // No inline body: append one.
    newBody = applyStampToBody('', stampBlock);
    const insert = ` --body ${shellQuote(newBody)}`;
    return { command: command.replace(/\s*$/, '') + insert, changed: true };
  }

  const tok = tokens[bodyIdx];
  const eq = tok.text.match(/^--body=(.*)$/s);
  const existing = eq ? eq[1] : (tokens[bodyIdx + 1] ? tokens[bodyIdx + 1].text : '');
  const stamped = applyStampToBody(existing, stampBlock);

  // Rebuild the command from tokens (normalizes quoting, safe since CC re-parses).
  const rebuilt = tokens.map((t, k) => {
    if (eq && k === bodyIdx) return `--body=${shellQuote(stamped)}`;
    if (!eq && k === bodyIdx) return t.text; // the --body flag itself
    if (!eq && k === bodyIdx + 1) return shellQuote(stamped);
    return t.quote ? shellQuote(t.text) : t.text;
  }).join(' ');

  return { command: rebuilt, changed: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Event handlers
// ─────────────────────────────────────────────────────────────────────────────

function handlePostToolUse(data, dir = STATE_DIR) {
  const { tool_name, tool_input, tool_response, session_id } = data;
  if (!['Edit', 'Write', 'MultiEdit', 'Bash'].includes(tool_name)) return {};
  const ledger = loadLedger(session_id, dir);
  applyPostToolUse(ledger, tool_name, tool_input, tool_response);
  saveLedger(ledger, dir);
  return {};
}

function handlePreToolUse(data, dir = STATE_DIR, runGit = defaultRunGit) {
  const { tool_name, tool_input, session_id, transcript_path, cwd } = data;
  if (tool_name !== 'Bash') return {};
  const command = tool_input && tool_input.command;
  if (!isPrCreate(command)) return {};

  const ledger = loadLedger(session_id, dir);
  const transcript = parseTranscript(readTranscript(transcript_path) || '');
  // Real human/agent split needs a git denominator (must-fix #2). Degrades to
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

  // BARE updatedInput (no permissionDecision) — see issue #15897 caveat above.
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
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

if (require.main === module) {
  main();
} else {
  module.exports = {
    emptyLedger,
    ledgerPath,
    loadLedger,
    saveLedger,
    countAddedLines,
    extractTestResult,
    applyPostToolUse,
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
    sumNumstatAdditions,
    totalBranchAddedLines,
    rewriteBodyArg,
    handlePostToolUse,
    handlePreToolUse,
    STAMP_BEGIN,
    STAMP_END,
    TEST_CMD_RE,
  };
}
