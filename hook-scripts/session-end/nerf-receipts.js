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
 * On SessionStart it renders a recent-sessions sparkline trend card and flags
 * meaningful shifts (>=25% relative change in the mean, heuristic — not a
 * significance test) that coincide with a model change
 * ("retry rate +82% since claude-x-2 rollout, n=140 sessions" — n is the real
 * count of sessions in the two compared runs).
 *
 * Registers on 6 events (branch on hook_event_name):
 *   - PostToolUse / PostToolUseFailure : count every tool call, failure + churn
 *   - Stop / SubagentStop              : count turn-end events
 *   - SessionEnd                       : finalize + append the record to the ledger
 *   - SessionStart                     : render the trend card via additionalContext
 *
 * MODEL/VERSION SOURCING (verified against the hooks docs): hook input carries
 * a `model` field ONLY on SessionStart, and even there it is optional. So the
 * model is primarily recovered from the transcript JSONL — assistant lines
 * carry message.model (the dominant one across the session wins) and every
 * line carries a top-level `version` (the Claude Code version). Sessions with
 * no recoverable model bucket as "unknown"; the trend card says so and shift
 * detection excludes them rather than claiming a shift "since unknown".
 *
 * COST/TOKEN CAVEAT (verified, GitHub issue #11008): hooks do NOT receive
 * token/cost numbers in their input. Token counts are parsed from the transcript
 * JSONL at input.transcript_path (usage lives on assistant messages; a message
 * split across several JSONL lines repeats the same usage, so usage is deduped
 * by message id). When the transcript is absent/unparseable, token signals
 * degrade to null (omitted), never faked. Reads are capped (tail window) so a
 * huge transcript never blows up SessionEnd.
 *
 * Persists a JSONL ledger under ~/.claude/nerf-receipts/ (zero deps, no SQLite).
 * In-flight per-session state is an append-only JSONL event log (safe under
 * concurrent PostToolUse hooks — no read-modify-write races). Only counts and
 * edited file paths are persisted; tool inputs/commands/transcript text never
 * are, so secrets in commands cannot land in the ledger.
 * Logs meaningful events to ~/.claude/hooks-logs/<YYYY-MM-DD>.jsonl
 *
 * Setup in .claude/settings.json:
 * {
 *   "hooks": {
 *     "PostToolUse":        [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /path/to/nerf-receipts.js" }] }],
 *     "PostToolUseFailure": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /path/to/nerf-receipts.js" }] }],
 *     "Stop":               [{ "hooks": [{ "type": "command", "command": "node /path/to/nerf-receipts.js" }] }],
 *     "SubagentStop":       [{ "hooks": [{ "type": "command", "command": "node /path/to/nerf-receipts.js" }] }],
 *     "SessionEnd":         [{ "hooks": [{ "type": "command", "command": "node /path/to/nerf-receipts.js" }] }],
 *     "SessionStart":       [{ "hooks": [{ "type": "command", "command": "node /path/to/nerf-receipts.js" }] }]
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || process.env.USERPROFILE || '';
const LOG_DIR = path.join(HOME, '.claude', 'hooks-logs');
const DATA_DIR = path.join(HOME, '.claude', 'nerf-receipts');
const LEDGER = path.join(DATA_DIR, 'sessions.jsonl');
const STATE_DIR = path.join(DATA_DIR, 'sessions'); // per-session in-flight event logs

// Cost/latency discipline: never parse more than this many transcript lines...
const MAX_TRANSCRIPT_LINES = 20000;
// ...and never read more than this many bytes (tail window on huge transcripts).
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
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
 * Fold one already-classified tool event ({failed, target}) into a mutable
 * in-flight session state. Returns the same state object (mutated).
 */
function applyFoldedTool(state, failed, target) {
  state.toolCalls = (state.toolCalls || 0) + 1;
  if (failed) state.toolFailures = (state.toolFailures || 0) + 1;

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
  }
  return state;
}

/**
 * Fold a single PostToolUse event into a mutable in-flight session state.
 * Returns the same state object (mutated) for convenience.
 */
function applyToolEvent(state, toolName, toolInput, toolResponse) {
  return applyFoldedTool(state, isToolFailure(toolResponse), editTargetPath(toolName, toolInput));
}

/**
 * Fold an append-only event log (see appendStateEvent) into a session state.
 */
function foldState(events) {
  const state = { toolCalls: 0, toolFailures: 0, fileEdits: {}, stopEvents: 0 };
  for (const ev of events || []) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.t === 'tool') {
      applyFoldedTool(state, !!ev.failed, typeof ev.target === 'string' && ev.target ? ev.target : null);
    } else if (ev.t === 'stop') {
      state.stopEvents += 1;
    } else if (ev.t === 'meta') {
      if (typeof ev.model === 'string' && ev.model) state.model = ev.model;
      if (typeof ev.cc_version === 'string' && ev.cc_version) state.cc_version = ev.cc_version;
    }
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

const EMPTY_TRANSCRIPT_STATS = Object.freeze({
  inputTokens: null, outputTokens: null, totalTokens: null, userPrompts: 0, model: null, ccVersion: null,
});

/**
 * Parse a transcript JSONL string into token/prompt/model aggregates.
 * Returns { inputTokens, outputTokens, totalTokens, userPrompts, model, ccVersion }
 * with nulls when nothing usable is found. Bounded by MAX_TRANSCRIPT_LINES.
 *
 * Real-transcript quirks handled (verified against ~/.claude/projects JSONL):
 *   - one assistant message spans several lines (one per content block), each
 *     repeating the same message.usage -> dedupe usage by message id;
 *   - sidechain (subagent) and isMeta "user" lines are not genuine prompts;
 *   - assistant lines carry message.model ("<synthetic>" entries are skipped);
 *   - every line carries a top-level `version` = the Claude Code version.
 */
function parseTranscript(raw) {
  if (!raw || typeof raw !== 'string') return { ...EMPTY_TRANSCRIPT_STATS };
  let lines = raw.split('\n');
  if (lines.length > MAX_TRANSCRIPT_LINES) lines = lines.slice(-MAX_TRANSCRIPT_LINES);

  const usageById = new Map();
  const modelCounts = new Map();
  let userPrompts = 0;
  let ccVersion = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (!msg || typeof msg !== 'object') continue;

    if (typeof msg.version === 'string' && msg.version) ccVersion = msg.version;

    const role = msg.role || (msg.message && msg.message.role);

    // Count genuine user prompts (not tool_result echoes, subagent sidechains,
    // or synthetic isMeta lines).
    if ((msg.type === 'user' || role === 'user') && !msg.isSidechain && !msg.isMeta) {
      const content = (msg.message && msg.message.content) || msg.content;
      const isToolResultOnly = Array.isArray(content) &&
        content.length > 0 && content.every((c) => c && c.type === 'tool_result');
      if (!isToolResultOnly) userPrompts += 1;
    }

    if (msg.type === 'assistant' || role === 'assistant') {
      const model = msg.message && msg.message.model;
      if (typeof model === 'string' && model && !model.startsWith('<')) {
        modelCounts.set(model, (modelCounts.get(model) || 0) + 1);
      }
    }

    // Usage lives on assistant messages. Dedupe by message id: a message split
    // across N content-block lines repeats the same usage N times.
    const usage = (msg.message && msg.message.usage) || msg.usage;
    if (usage && typeof usage === 'object') {
      const key = (msg.message && msg.message.id) || msg.uuid || `line-${i}`;
      usageById.set(key, usage);
    }
  }

  // Dominant assistant model across the session (ties -> last seen wins).
  let model = null;
  let best = 0;
  for (const [m, c] of modelCounts) {
    if (c >= best) { best = c; model = m; }
  }

  if (usageById.size === 0) {
    return { ...EMPTY_TRANSCRIPT_STATS, userPrompts, model, ccVersion };
  }
  let inputTokens = 0;
  let outputTokens = 0;
  for (const usage of usageById.values()) {
    inputTokens += (usage.input_tokens || 0) +
      (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
    outputTokens += usage.output_tokens || 0;
  }
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, userPrompts, model, ccVersion };
}

/**
 * Read a transcript file from disk into parsed aggregates. Degrades to nulls.
 * Huge transcripts are read as a bounded tail window (dropping the first
 * partial line) so memory and latency stay flat; tokens and prompts remain
 * self-consistent because both come from the same window.
 */
function readTranscriptStats(transcriptPath) {
  try {
    if (!transcriptPath || typeof transcriptPath !== 'string' || !fs.existsSync(transcriptPath)) {
      return { ...EMPTY_TRANSCRIPT_STATS };
    }
    const size = fs.statSync(transcriptPath).size;
    let raw;
    if (size > MAX_TRANSCRIPT_BYTES) {
      const fd = fs.openSync(transcriptPath, 'r');
      try {
        const buf = Buffer.alloc(MAX_TRANSCRIPT_BYTES);
        const read = fs.readSync(fd, buf, 0, MAX_TRANSCRIPT_BYTES, size - MAX_TRANSCRIPT_BYTES);
        raw = buf.toString('utf-8', 0, read);
      } finally {
        fs.closeSync(fd);
      }
      const nl = raw.indexOf('\n');
      raw = nl >= 0 ? raw.slice(nl + 1) : '';
    } else {
      raw = fs.readFileSync(transcriptPath, 'utf-8');
    }
    return parseTranscript(raw);
  } catch {
    return { ...EMPTY_TRANSCRIPT_STATS };
  }
}

/**
 * Build the finalized per-session ledger record from in-flight state + transcript.
 * Model/version precedence: transcript (what actually generated) > hook input /
 * SessionStart-provided > "unknown".
 */
function buildSessionRecord(state, transcriptStats, meta) {
  const toolCalls = state.toolCalls || 0;
  const toolFailures = state.toolFailures || 0;
  const churn = totalChurn(state);
  const stopEvents = state.stopEvents || 0;
  const tokens = transcriptStats && transcriptStats.totalTokens;
  const prompts = (transcriptStats && transcriptStats.userPrompts) || 0;
  const tokensPerTask = tokens != null && prompts > 0 ? Math.round(tokens / prompts) : null;
  const model = (transcriptStats && transcriptStats.model) ||
    (meta.model && meta.model !== 'unknown' ? meta.model : null) || 'unknown';
  const ccVersion = (transcriptStats && transcriptStats.ccVersion) ||
    (meta.cc_version && meta.cc_version !== 'unknown' ? meta.cc_version : null) || 'unknown';

  return {
    ts: new Date().toISOString(),
    session_id: meta.session_id || null,
    model,
    cc_version: ccVersion,
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
 * Per the hooks docs only SessionStart (optionally) carries `model`; there is
 * no model env var, so no env fallback — the transcript is the real source.
 */
function extractMeta(data) {
  const model = typeof data.model === 'string' && data.model ? data.model : 'unknown';
  const cc_version = data.cc_version || data.claude_code_version || 'unknown';
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
 * Compare the most-recent model run against the run just before it and report
 * shifts on failure_rate and tokens_per_task (>= threshold relative change in
 * the mean, both runs >= minPerGroup sessions). Runs are CONTIGUOUS stretches
 * of the same model in chronological order — this keeps eras honest when a
 * user bounces between models (A, B, A never blames B for A's numbers), and n
 * is the real session count of the two compared runs. Sessions with an
 * unknown model are never used to claim a shift.
 */
function detectShifts(records, opts = {}) {
  const minPerGroup = opts.minPerGroup !== undefined ? opts.minPerGroup : 3;
  const threshold = opts.threshold !== undefined ? opts.threshold : 0.25; // 25% relative change

  const runs = [];
  for (const r of records) {
    const key = r.model || 'unknown';
    const last = runs[runs.length - 1];
    if (last && last.model === key) last.records.push(r);
    else runs.push({ model: key, records: [r] });
  }
  if (runs.length < 2) return [];

  const curr = runs[runs.length - 1];
  const prev = runs[runs.length - 2];
  if (curr.model === 'unknown' || prev.model === 'unknown') return [];
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

  // Clamp every body row to the card width (matching the 64-char borders) so
  // long values can't break the frame.
  const row = (text) => ('│ ' + text).slice(0, 62).padEnd(62) + ' │';

  const lines = [];
  lines.push('╭─ NERF RECEIPTS ── your own session flight recorder ──────────╮');
  lines.push(row(`sessions recorded: ${String(records.length).padEnd(6)}   window: last ${recent.length}`));
  lines.push('├──────────────────────────────────────────────────────────────┤');
  lines.push(row(`failure rate   ${sparkline(failSeries).padEnd(16)} avg ${avgFail != null ? (avgFail * 100).toFixed(1) + '%' : 'n/a'}`));
  lines.push(row(`tokens/task    ${sparkline(tokenSeries).padEnd(16)} avg ${avgTokens != null ? Math.round(avgTokens) : 'n/a'}`));
  lines.push(row(`edit churn     ${sparkline(churnSeries).padEnd(16)} avg ${avgChurn != null ? avgChurn.toFixed(1) : 'n/a'}`));

  const shifts = detectShifts(recent);
  lines.push('├──────────────────────────────────────────────────────────────┤');
  if (shifts.length) {
    for (const s of shifts) {
      let detail;
      if (s.metric === 'failure_rate') {
        detail = `${s.label} ${pct(s.relChange)} (${(s.before * 100).toFixed(1)}% → ${(s.after * 100).toFixed(1)}%)`;
      } else {
        detail = `${s.label} ${pct(s.relChange)} (${Math.round(s.before)} → ${Math.round(s.after)})`;
      }
      lines.push(row(`⚠ ${detail} since ${s.toModel}, n=${s.n}`));
    }
    lines.push(row(`  it's not in your head — you have the receipts.`));
  } else {
    lines.push(row('no meaningful model/version shift detected.'));
  }

  // Be honest about degraded data: unknown-model sessions never drive claims.
  const unknownCount = recent.filter((r) => !r.model || r.model === 'unknown').length;
  if (unknownCount > 0) {
    lines.push(row(`note: ${unknownCount}/${recent.length} sessions missing a model id`));
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
  return path.join(STATE_DIR, `${safe}.jsonl`);
}

/**
 * Append one event to the per-session in-flight log. Append-only JSONL: safe
 * under concurrent hook invocations (parallel tool calls), unlike a
 * read-modify-write state blob which would drop events.
 * Events: {t:'tool', failed, target} | {t:'stop'} | {t:'meta', model?, cc_version?}
 */
function appendStateEvent(sessionId, event) {
  try {
    ensureDirs();
    fs.appendFileSync(statePath(sessionId), JSON.stringify(event) + '\n');
  } catch {}
}

function readStateEvents(sessionId) {
  try {
    const p = statePath(sessionId);
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e && typeof e === 'object');
  } catch {
    return [];
  }
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

function handlePostToolUse(data, forceFailed = false) {
  const failed = forceFailed || isToolFailure(data.tool_response);
  const target = editTargetPath(data.tool_name, data.tool_input);
  // Only the failure bit + edit target path are persisted — never tool
  // inputs/commands (which can contain secrets).
  appendStateEvent(data.session_id, { t: 'tool', failed, target });
  return '{}';
}

function handleStop(data) {
  appendStateEvent(data.session_id, { t: 'stop' });
  return '{}';
}

function handleSessionEnd(data) {
  const state = foldState(readStateEvents(data.session_id));
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
  // SessionStart is the only event documented to (optionally) carry the model
  // id — stash it so SessionEnd can attribute the session even when the
  // transcript is missing or unreadable.
  if (typeof data.model === 'string' && data.model) {
    appendStateEvent(data.session_id, { t: 'meta', model: data.model });
  }
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
      case 'PostToolUseFailure':
        return console.log(handlePostToolUse(data, true));
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
    foldState,
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
    MAX_TRANSCRIPT_BYTES,
    // persistence (exported for hermetic integration-ish unit tests)
    appendLedger,
    readLedger,
    appendStateEvent,
    readStateEvents,
    clearState,
    LEDGER,
    DATA_DIR,
  };
}
