#!/usr/bin/env node
/**
 * Nerf Receipts - a personal flight recorder for Claude Code quality
 *
 * Silently records YOUR own per-session quality signals, keyed by model ID and
 * Claude Code version, so that when the next "they nerfed it" wave hits you have
 * data instead of vibes. Zero interaction required. Signals tracked per session:
 *   - tool-failure rate         (failed tool calls / total tool calls)
 *   - same-file edit churn      (edit -> fail -> re-edit loops on one file)
 *   - stop-event count          (Stop/SubagentStop fires — turn-end frequency)
 *   - tokens-per-completed-task (transcript token usage / prompts answered)
 * On SessionStart it renders a weekly sparkline trend card and flags
 * statistically meaningful shifts that coincide with a model/version change
 * ("retry rate +82% since claude-x-2 rollout, n=140 sessions").
 *
 * Registers on 4 events (branch on hook_event_name):
 *   - PostToolUse  (all matchers) : fingerprint every tool failure + churn
 *   - Stop                        : snapshot the session outcome
 *   - SessionEnd                  : finalize + append the session record to the ledger
 *   - SessionStart                : render the trend card via additionalContext
 *
 * COST/TOKEN CAVEAT (verified, GitHub issue #11008): hooks do NOT receive
 * token/cost numbers in their input. Token counts are parsed from the transcript
 * JSONL at input.transcript_path (usage lives on assistant messages). When the
 * transcript is absent/unparseable, token signals degrade to null (omitted),
 * never faked.
 *
 * Persists a JSONL ledger under ~/.claude/nerf-receipts/ (zero deps, no SQLite).
 * Logs meaningful events to ~/.claude/hooks-logs/<YYYY-MM-DD>.jsonl
 *
 * Setup in .claude/settings.json:
 * {
 *   "hooks": {
 *     "PostToolUse":   [{ "matcher": "*",  "hooks": [{ "type": "command", "command": "node /path/to/nerf-receipts.js" }] }],
 *     "Stop":          [{                    "hooks": [{ "type": "command", "command": "node /path/to/nerf-receipts.js" }] }],
 *     "SessionEnd":    [{                    "hooks": [{ "type": "command", "command": "node /path/to/nerf-receipts.js" }] }],
 *     "SessionStart":  [{                    "hooks": [{ "type": "command", "command": "node /path/to/nerf-receipts.js" }] }]
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || process.env.USERPROFILE || '';
const LOG_DIR = path.join(HOME, '.claude', 'hooks-logs');
const DATA_DIR = path.join(HOME, '.claude', 'nerf-receipts');
const LEDGER = path.join(DATA_DIR, 'sessions.jsonl');
const STATE_DIR = path.join(DATA_DIR, 'sessions'); // per-session in-flight state

// Cost/latency discipline: never scan more than this many transcript lines.
const MAX_TRANSCRIPT_LINES = 20000;
// Only tell a version/model story once we have at least this many sessions.
const MIN_SESSIONS_FOR_TREND = 6;
// Trend card considers at most this many recent sessions.
const TREND_WINDOW = 200;

function log(data) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), hook: 'nerf-receipts', ...data }) + '\n');
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (unit-tested)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect whether a PostToolUse tool_response represents a failure.
 * Claude Code marks failures a few different ways depending on the tool; be
 * defensive and treat any of the common failure shapes as a failure.
 */
function isToolFailure(toolResponse) {
  if (toolResponse == null) return false;
  if (typeof toolResponse === 'string') {
    return /\berror\b|\bfailed\b|exception|traceback|not found|permission denied/i.test(toolResponse);
  }
  if (typeof toolResponse !== 'object') return false;
  if (toolResponse.success === false) return true;
  if (toolResponse.is_error === true || toolResponse.isError === true) return true;
  if (toolResponse.error) return true;
  if (typeof toolResponse.exit_code === 'number' && toolResponse.exit_code !== 0) return true;
  if (typeof toolResponse.status === 'number' && toolResponse.status !== 0) return true;
  // Bash-style: stderr present and no meaningful stdout
  if (toolResponse.stderr && !toolResponse.stdout &&
      /\berror\b|\bfailed\b|command not found|permission denied/i.test(String(toolResponse.stderr))) {
    return true;
  }
  return false;
}

/**
 * Resolve the file path an Edit/Write-family tool acted on (for churn tracking).
 */
function editTargetPath(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
  if (!EDIT_TOOLS.has(toolName)) return null;
  return toolInput.file_path || toolInput.notebook_path || toolInput.path || null;
}

/**
 * Fold a single PostToolUse event into a mutable in-flight session state.
 * Returns the same state object (mutated) for convenience.
 */
function applyToolEvent(state, toolName, toolInput, toolResponse) {
  state.toolCalls = (state.toolCalls || 0) + 1;
  const failed = isToolFailure(toolResponse);
  if (failed) state.toolFailures = (state.toolFailures || 0) + 1;

  const target = editTargetPath(toolName, toolInput);
  if (target) {
    state.fileEdits = state.fileEdits || {};
    const f = state.fileEdits[target] || { edits: 0, fails: 0, churn: 0, lastFailed: false };
    f.edits += 1;
    // edit -> fail -> re-edit loop: a re-edit that arrives right after a failure
    // on the same file counts as one unit of churn.
    if (f.lastFailed) f.churn += 1;
    f.lastFailed = failed;
    if (failed) f.fails += 1;
    state.fileEdits[target] = f;
  } else if (failed) {
    // A failure on a non-edit tool clears any pending "re-edit" expectation is
    // intentionally NOT done here; churn only tracks same-file edit loops.
  }
  return state;
}

/**
 * Sum edit-churn across all files in an in-flight session state.
 */
function totalChurn(state) {
  const files = state.fileEdits || {};
  return Object.values(files).reduce((n, f) => n + (f.churn || 0), 0);
}

/**
 * Parse a transcript JSONL string into token/prompt aggregates.
 * Returns { inputTokens, outputTokens, totalTokens, userPrompts } or nulls when
 * nothing usable is found. Bounded by MAX_TRANSCRIPT_LINES.
 */
function parseTranscript(raw) {
  const out = { inputTokens: 0, outputTokens: 0, totalTokens: 0, userPrompts: 0, sawUsage: false };
  if (!raw || typeof raw !== 'string') return { inputTokens: null, outputTokens: null, totalTokens: null, userPrompts: 0 };
  const lines = raw.split('\n');
  const limit = Math.min(lines.length, MAX_TRANSCRIPT_LINES);
  for (let i = 0; i < limit; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (!msg || typeof msg !== 'object') continue;

    // Count genuine user prompts (not tool_result echoes).
    const role = msg.role || (msg.message && msg.message.role);
    if (msg.type === 'user' || role === 'user') {
      const content = (msg.message && msg.message.content) || msg.content;
      const isToolResultOnly = Array.isArray(content) &&
        content.length > 0 && content.every((c) => c && c.type === 'tool_result');
      if (!isToolResultOnly) out.userPrompts += 1;
    }

    // Usage lives on assistant messages.
    const usage = (msg.message && msg.message.usage) || msg.usage;
    if (usage && typeof usage === 'object') {
      const inTok = (usage.input_tokens || 0) +
        (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
      const outTok = usage.output_tokens || 0;
      out.inputTokens += inTok;
      out.outputTokens += outTok;
      out.sawUsage = true;
    }
  }
  if (!out.sawUsage) {
    return { inputTokens: null, outputTokens: null, totalTokens: null, userPrompts: out.userPrompts };
  }
  out.totalTokens = out.inputTokens + out.outputTokens;
  return out;
}

/**
 * Read a transcript file from disk into parsed aggregates. Degrades to nulls.
 */
function readTranscriptStats(transcriptPath) {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      return { inputTokens: null, outputTokens: null, totalTokens: null, userPrompts: 0 };
    }
    const raw = fs.readFileSync(transcriptPath, 'utf-8');
    return parseTranscript(raw);
  } catch {
    return { inputTokens: null, outputTokens: null, totalTokens: null, userPrompts: 0 };
  }
}

/**
 * Build the finalized per-session ledger record from in-flight state + transcript.
 */
function buildSessionRecord(state, transcriptStats, meta) {
  const toolCalls = state.toolCalls || 0;
  const toolFailures = state.toolFailures || 0;
  const churn = totalChurn(state);
  const stopEvents = state.stopEvents || 0;
  const tokens = transcriptStats && transcriptStats.totalTokens;
  const prompts = (transcriptStats && transcriptStats.userPrompts) || 0;
  const tokensPerTask = tokens != null && prompts > 0 ? Math.round(tokens / prompts) : null;

  return {
    ts: new Date().toISOString(),
    session_id: meta.session_id || null,
    model: meta.model || 'unknown',
    cc_version: meta.cc_version || 'unknown',
    cwd: meta.cwd || null,
    tool_calls: toolCalls,
    tool_failures: toolFailures,
    failure_rate: toolCalls > 0 ? +(toolFailures / toolCalls).toFixed(4) : 0,
    edit_churn: churn,
    stop_events: stopEvents,
    total_tokens: tokens != null ? tokens : null,
    prompts,
    tokens_per_task: tokensPerTask,
  };
}

/**
 * Extract model + Claude Code version from a hook payload (best-effort).
 */
function extractMeta(data) {
  const model =
    data.model ||
    (data.tool_input && data.tool_input.model) ||
    (data.transcript_meta && data.transcript_meta.model) ||
    process.env.CLAUDE_MODEL_ID ||
    'unknown';
  const cc_version =
    data.cc_version || data.claude_code_version || data.version ||
    process.env.CLAUDE_CODE_VERSION || 'unknown';
  return { model, cc_version, session_id: data.session_id, cwd: data.cwd };
}

// ─────────────────────────────────────────────────────────────────────────────
// Trend analysis (unit-tested)
// ─────────────────────────────────────────────────────────────────────────────

function mean(arr) {
  const nums = arr.filter((n) => typeof n === 'number' && isFinite(n));
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

const SPARK_CHARS = '▁▂▃▄▅▆▇█';

/**
 * Render a unicode sparkline for a numeric series.
 */
function sparkline(series) {
  const nums = series.filter((n) => typeof n === 'number' && isFinite(n));
  if (nums.length === 0) return '';
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  return series
    .map((n) => {
      if (typeof n !== 'number' || !isFinite(n)) return ' ';
      const idx = Math.min(SPARK_CHARS.length - 1, Math.floor(((n - min) / span) * (SPARK_CHARS.length - 1)));
      return SPARK_CHARS[idx];
    })
    .join('');
}

/**
 * Compare the most-recent model rollout against the prior one and report shifts.
 * Groups sessions by model, orders by first-seen, and if there are >=2 model
 * groups it compares the newest against the previous one on failure_rate and
 * tokens_per_task, flagging shifts >= threshold.
 */
function detectShifts(records, opts = {}) {
  const minPerGroup = opts.minPerGroup || 3;
  const threshold = opts.threshold || 0.25; // 25% relative change

  const groups = new Map(); // model -> { records, firstIdx }
  records.forEach((r, i) => {
    const key = r.model || 'unknown';
    if (!groups.has(key)) groups.set(key, { model: key, records: [], firstIdx: i });
    groups.get(key).records.push(r);
  });

  const ordered = [...groups.values()].sort((a, b) => a.firstIdx - b.firstIdx);
  if (ordered.length < 2) return [];

  const prev = ordered[ordered.length - 2];
  const curr = ordered[ordered.length - 1];
  if (prev.records.length < minPerGroup || curr.records.length < minPerGroup) return [];

  const shifts = [];
  const metrics = [
    { key: 'failure_rate', label: 'retry/failure rate', pct: true },
    { key: 'tokens_per_task', label: 'tokens per task', pct: false },
  ];
  for (const m of metrics) {
    const before = mean(prev.records.map((r) => r[m.key]));
    const after = mean(curr.records.map((r) => r[m.key]));
    if (before == null || after == null || before === 0) continue;
    const rel = (after - before) / before;
    if (Math.abs(rel) >= threshold) {
      shifts.push({
        metric: m.key,
        label: m.label,
        before,
        after,
        relChange: rel,
        direction: rel > 0 ? 'up' : 'down',
        fromModel: prev.model,
        toModel: curr.model,
        n: curr.records.length + prev.records.length,
      });
    }
  }
  return shifts;
}

function pct(n) {
  const sign = n > 0 ? '+' : '';
  return `${sign}${Math.round(n * 100)}%`;
}

/**
 * Render the shareable trend card (plain text, screenshot-friendly).
 */
function renderTrendCard(records) {
  if (!records || records.length < MIN_SESSIONS_FOR_TREND) return null;
  const recent = records.slice(-TREND_WINDOW);
  const window = recent.slice(-14); // last ~14 sessions for the sparkline

  const failSeries = window.map((r) => (typeof r.failure_rate === 'number' ? r.failure_rate * 100 : NaN));
  const tokenSeries = window.map((r) => (typeof r.tokens_per_task === 'number' ? r.tokens_per_task : NaN));
  const churnSeries = window.map((r) => (typeof r.edit_churn === 'number' ? r.edit_churn : NaN));

  const avgFail = mean(recent.map((r) => r.failure_rate));
  const avgTokens = mean(recent.map((r) => r.tokens_per_task));
  const avgChurn = mean(recent.map((r) => r.edit_churn));

  const lines = [];
  lines.push('╭─ NERF RECEIPTS ── your own session flight recorder ──────────╮');
  lines.push(`│ sessions recorded: ${String(records.length).padEnd(6)}   window: last ${recent.length}`.padEnd(63) + ' │');
  lines.push('├──────────────────────────────────────────────────────────────┤');
  lines.push(`│ failure rate   ${sparkline(failSeries).padEnd(16)} avg ${avgFail != null ? (avgFail * 100).toFixed(1) + '%' : 'n/a'}`.padEnd(63) + ' │');
  lines.push(`│ tokens/task    ${sparkline(tokenSeries).padEnd(16)} avg ${avgTokens != null ? Math.round(avgTokens) : 'n/a'}`.padEnd(63) + ' │');
  lines.push(`│ edit churn     ${sparkline(churnSeries).padEnd(16)} avg ${avgChurn != null ? avgChurn.toFixed(1) : 'n/a'}`.padEnd(63) + ' │');

  const shifts = detectShifts(recent);
  if (shifts.length) {
    lines.push('├──────────────────────────────────────────────────────────────┤');
    for (const s of shifts) {
      let detail;
      if (s.metric === 'failure_rate') {
        detail = `${s.label} ${pct(s.relChange)} (${(s.before * 100).toFixed(1)}% → ${(s.after * 100).toFixed(1)}%)`;
      } else {
        detail = `${s.label} ${pct(s.relChange)} (${Math.round(s.before)} → ${Math.round(s.after)})`;
      }
      lines.push(`│ ⚠ ${detail} since ${s.toModel}, n=${s.n}`.slice(0, 63).padEnd(63) + ' │');
    }
    lines.push(`│   it's not in your head — you have the receipts.`.padEnd(63) + ' │');
  } else {
    lines.push('├──────────────────────────────────────────────────────────────┤');
    lines.push(`│ no statistically meaningful model/version shift detected.`.padEnd(63) + ' │');
  }
  lines.push('╰──────────────────────────────────────────────────────────────╯');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Ledger / state persistence
// ─────────────────────────────────────────────────────────────────────────────

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

function statePath(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(STATE_DIR, `${safe}.json`);
}

function loadState(sessionId) {
  try {
    const p = statePath(sessionId);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {}
  return { toolCalls: 0, toolFailures: 0, fileEdits: {}, stopEvents: 0 };
}

function saveState(sessionId, state) {
  try {
    ensureDirs();
    fs.writeFileSync(statePath(sessionId), JSON.stringify(state));
  } catch {}
}

function clearState(sessionId) {
  try { fs.unlinkSync(statePath(sessionId)); } catch {}
}

function appendLedger(record) {
  try {
    ensureDirs();
    fs.appendFileSync(LEDGER, JSON.stringify(record) + '\n');
  } catch {}
}

function readLedger() {
  try {
    if (!fs.existsSync(LEDGER)) return [];
    return fs.readFileSync(LEDGER, 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Event handlers
// ─────────────────────────────────────────────────────────────────────────────

function handlePostToolUse(data) {
  const state = loadState(data.session_id);
  const meta = extractMeta(data);
  if (meta.model && meta.model !== 'unknown') state.model = meta.model;
  if (meta.cc_version && meta.cc_version !== 'unknown') state.cc_version = meta.cc_version;
  applyToolEvent(state, data.tool_name, data.tool_input, data.tool_response);
  saveState(data.session_id, state);
  return '{}';
}

function handleStop(data) {
  const state = loadState(data.session_id);
  state.stopEvents = (state.stopEvents || 0) + 1;
  saveState(data.session_id, state);
  return '{}';
}

function handleSessionEnd(data) {
  const state = loadState(data.session_id);
  const meta = extractMeta(data);
  if (state.model) meta.model = state.model;
  if (state.cc_version) meta.cc_version = state.cc_version;
  const transcriptStats = readTranscriptStats(data.transcript_path);
  const record = buildSessionRecord(state, transcriptStats, meta);

  // Don't pollute the ledger with empty no-op sessions.
  if (record.tool_calls === 0 && record.stop_events === 0 && record.total_tokens == null) {
    clearState(data.session_id);
    return '{}';
  }

  appendLedger(record);
  clearState(data.session_id);
  log({
    level: 'RECORDED',
    session_id: record.session_id,
    model: record.model,
    failure_rate: record.failure_rate,
    edit_churn: record.edit_churn,
    tokens_per_task: record.tokens_per_task,
  });
  return '{}';
}

function handleSessionStart(data) {
  const records = readLedger();
  const card = renderTrendCard(records);
  if (!card) return '{}';
  log({ level: 'TREND_CARD', sessions: records.length });
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: card,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry
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
    if (!data || typeof data !== 'object') return console.log('{}');
    const event = data.hook_event_name;

    switch (event) {
      case 'PostToolUse':
        return console.log(handlePostToolUse(data));
      case 'Stop':
      case 'SubagentStop':
        return console.log(handleStop(data));
      case 'SessionEnd':
        return console.log(handleSessionEnd(data));
      case 'SessionStart':
        return console.log(handleSessionStart(data));
      default:
        return console.log('{}');
    }
  } catch (e) {
    log({ level: 'ERROR', error: e && e.message });
    return console.log('{}');
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    isToolFailure,
    editTargetPath,
    applyToolEvent,
    totalChurn,
    parseTranscript,
    readTranscriptStats,
    buildSessionRecord,
    extractMeta,
    mean,
    sparkline,
    detectShifts,
    renderTrendCard,
    MIN_SESSIONS_FOR_TREND,
    // persistence (exported for hermetic integration-ish unit tests)
    appendLedger,
    readLedger,
    loadState,
    saveState,
    clearState,
    LEDGER,
    DATA_DIR,
  };
}
