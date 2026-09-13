#!/usr/bin/env node
/**
 * Subagent Spawn Cap - PreToolUse Hook for Agent|Task
 * A total-spawns-per-session budget for subagents. Counts every Agent
 * tool call in a session (nested calls made from inside subagents
 * included; they carry the same session_id), asks for approval at spawn
 * SPAWN_CAP_ASK (default 20) and again every SPAWN_CAP_ASK_STEP spawns
 * (default 10), and denies at SPAWN_CAP_DENY (default 60). With the
 * defaults: prompts at 20, 30, 40, 50; hard stop at 60.
 * Logs to: ~/.claude/hooks-logs/  State: ~/.claude/subagent-spawn-cap/
 *
 * Why this hook exists: Claude Code 2.1.212 added a per-session spawn cap
 * (CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION, default 200) and 2.1.224 removed
 * it again; what remains native is a concurrency cap
 * (CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, default 20) and a nesting-depth
 * cap. Neither bounds the total: a delegation loop that spawns 20 at a
 * time, forever, stays inside both. The runaway reports in
 * anthropics/claude-code (325 agents for a settings audit in #92349, 160
 * subagents exhausting a session limit in #91942) are the failure mode
 * this closes. Session-scoped budgets belong to the user, not the model.
 *
 * State model: one append-only JSONL file per session_id, one line per
 * allowed or asked spawn. Parallel tool calls in one assistant turn fire
 * parallel hook processes, so a read-modify-write counter file would
 * lose increments; O_APPEND writes do not. Count = number of lines.
 * Denied calls are not recorded. An asked call IS recorded before the
 * user answers (PreToolUse cannot see the answer), so a declined ask
 * still consumed one budget unit. Files older than 7 days are pruned
 * opportunistically (at most once a day, never fatal).
 *
 * Tunables (env, validated, safe fallback):
 *   SPAWN_CAP_ASK       positive integer, default 20: first spawn number
 *                       that returns permissionDecision "ask"
 *   SPAWN_CAP_ASK_STEP  positive integer, default 10: ask again every
 *                       this many spawns after SPAWN_CAP_ASK; spawns in
 *                       between pass silently (already approved)
 *   SPAWN_CAP_DENY      positive integer, default 60: spawn number that
 *                       returns "deny"; clamped up to SPAWN_CAP_ASK if set
 *                       lower, so the hard cap can never sit below the
 *                       ask threshold. Equal to SPAWN_CAP_ASK = no asks.
 *   SPAWN_CAP_ALLOW     the literal string "true" lets spawns through
 *                       past both thresholds for as long as it is set
 *                       (each is still counted and logged ALLOW_OVERRIDE)
 * Hook processes inherit the environment Claude Code was launched with,
 * so changing any of these means editing the settings.json env block and
 * restarting. The mid-session reset is deleting the session's ledger.
 * HOOK_SAFETY_LEVEL is deliberately NOT read: the repo's levels pick
 * pattern sets, not numeric budgets, and two explicit integers are
 * clearer than a level-to-number table nobody can see.
 *
 * Headless and dontAsk: a run with nobody to answer the prompt turns
 * every "ask" into a deny, so the effective hard stop there is
 * SPAWN_CAP_ASK. Set SPAWN_CAP_ASK equal to SPAWN_CAP_DENY for
 * unattended runs.
 *
 * Fail-open: any error prints {} and exits 0; the agent loop never
 * stalls on this hook. Tools other than Agent/Task return {} before any
 * filesystem work.
 *
 * Known limits: only spawns that go through the Agent tool are seen; a
 * Workflow script or any other non-tool path that starts agents is
 * invisible to PreToolUse. Counts key on session_id, so a resumed
 * session continues its count. Parallel calls in the same turn each
 * read the count before any of them appends, so a batch can overshoot
 * a threshold by up to the native concurrency limit; the next call is
 * judged on the full count. The ledger is a plain file an agent with
 * Bash could delete. A user can raise the caps; that is the point.
 *
 * Setup (plugin, recommended):
 *   /plugin marketplace add karanb192/claude-code-hooks
 *   /plugin install subagent-spawn-cap@claude-code-hooks
 * The plugin's hooks/hooks.json registers this script automatically.
 *
 * Setup (classic): copy this file somewhere stable and register it in
 * .claude/settings.json:
 * {
 *   "hooks": {
 *     "PreToolUse": [{
 *       "matcher": "Agent|Task",
 *       "hooks": [{ "type": "command", "command": "node /path/to/subagent-spawn-cap.js" }]
 *     }]
 *   }
 * }
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const STATE_DIR = path.join(HOME, '.claude', 'subagent-spawn-cap');
const LOG_DIR = path.join(HOME, '.claude', 'hooks-logs');
const PRUNE_STAMP = path.join(STATE_DIR, '.last-prune');

// `Agent` is the subagent tool on current builds; older builds called it
// `Task` (the 2.1.212 changelog still says "Task tool"). Match both.
const SPAWN_TOOLS = ['Agent', 'Task'];

const DEFAULT_ASK = 20;
const DEFAULT_ASK_STEP = 10;
const DEFAULT_DENY = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_AFTER_MS = 7 * DAY_MS;
const PRUNE_EVERY_MS = DAY_MS;

const EMOJIS = { ask: '⚠️', deny: '🚨' };

// Shared by the standalone main() and guard-pack (which requires this
// module), so audit lines for bypass, clamp, and missing session_id land
// in hooks-logs on both paths.
function log(data) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), hook: 'subagent-spawn-cap', ...data }) + '\n');
  } catch {}
}

// A positive integer or the fallback. "20", " 20 " pass; "0", "-1", "2e1",
// "twenty", "" fall back.
function parsePositiveInt(raw, fallback) {
  if (typeof raw !== 'string') return fallback;
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return fallback;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

// Resolve the thresholds from env. Exported so tests can pin the fallback
// rules without spawning.
function readThresholds(env = process.env) {
  const ask = parsePositiveInt(env.SPAWN_CAP_ASK, DEFAULT_ASK);
  const step = parsePositiveInt(env.SPAWN_CAP_ASK_STEP, DEFAULT_ASK_STEP);
  let deny = parsePositiveInt(env.SPAWN_CAP_DENY, DEFAULT_DENY);
  let clamped = false;
  if (deny < ask) { deny = ask; clamped = true; }
  return { ask, step, deny, clamped };
}

const isSpawnTool = (toolName) => SPAWN_TOOLS.includes(toolName);

// session_id becomes a file name; keep it to a safe charset and length.
function sessionFile(sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
  return path.join(STATE_DIR, `${safe}.jsonl`);
}

// The ledger path as a human would type it: ~/.claude/... when under HOME.
function displayPath(file) {
  return file.startsWith(HOME + path.sep) ? '~' + file.slice(HOME.length) : file;
}

// Lines already in the ledger = spawns already allowed or asked.
function countLines(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return 0;
    throw e;
  }
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function appendLine(file, record) {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + '\n');
}

// Remove session ledgers untouched for PRUNE_AFTER_MS. Runs at most once
// per PRUNE_EVERY_MS (a stamp file's mtime), never throws.
function pruneStale(now = Date.now()) {
  try {
    try {
      if (now - fs.statSync(PRUNE_STAMP).mtimeMs < PRUNE_EVERY_MS) return 0;
    } catch { /* no stamp yet: prune */ }
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    let removed = 0;
    for (const name of fs.readdirSync(STATE_DIR)) {
      if (!name.endsWith('.jsonl')) continue;
      const full = path.join(STATE_DIR, name);
      try {
        if (now - fs.statSync(full).mtimeMs > PRUNE_AFTER_MS) { fs.unlinkSync(full); removed++; }
      } catch {}
    }
    fs.writeFileSync(PRUNE_STAMP, String(now));
    return removed;
  } catch {
    return 0;
  }
}

// Ask on the first threshold and then every `step` spawns until deny.
function shouldAsk(count, t) {
  return count >= t.ask && (count - t.ask) % t.step === 0;
}

// Per the hooks reference an "ask" reason is shown to the user, a "deny"
// reason to Claude. So the ask text talks to the human, the deny text to
// the model, and both name the mid-session reset (delete the ledger) as
// well as the env knobs, which need a settings edit and a restart.
function buildReason(decision, n, t, file) {
  const ledger = displayPath(file);
  if (decision === 'deny') {
    return `[spawn-cap] Subagent spawn #${n} in this session hit the hard cap (SPAWN_CAP_DENY=${t.deny}). Do not retry: finish with the results you already have and tell the user the session's spawn budget is spent. The user can reset it by deleting ${ledger}, or raise SPAWN_CAP_DENY in the settings.json env block and restart.`;
  }
  // Spawns between this prompt and the next check (or the hard cap) pass
  // silently; say how many, or say the cap is next when nothing is left.
  const silent = Math.min(t.step - 1, t.deny - n - 1);
  const nextCheck = n + t.step < t.deny ? `next check at #${n + t.step}, ` : '';
  const after = silent > 0
    ? `the next ${silent} spawn${silent === 1 ? '' : 's'} then pass without asking.`
    : `spawn #${t.deny} is then denied.`;
  return `[spawn-cap] Subagent spawn #${n} in this session (ask threshold SPAWN_CAP_ASK=${t.ask}, ${nextCheck}hard cap SPAWN_CAP_DENY=${t.deny}). Approve to continue; ${after} Deny to stop the fan-out. Reset this session's count by deleting ${ledger}; change the cadence via SPAWN_CAP_ASK / SPAWN_CAP_ASK_STEP in the settings.json env block (restart needed).`;
}

// The whole decision for one event. Returns
//   { decision: 'allow' | 'ask' | 'deny', count, thresholds, reason, bypass, file, logFields }
// and appends to the session ledger for allow/ask. Touches the filesystem
// only when the tool is a spawn tool. Logs bypass, clamp, and a missing
// session_id itself so guard-pack gets the same audit trail. Throws on
// I/O errors other than a missing ledger; main() and guard-pack turn
// that into fail-open.
function evaluateSpawn(event, env = process.env, now = Date.now()) {
  const toolName = event?.tool_name;
  if (!isSpawnTool(toolName)) return { decision: 'allow', skipped: true };
  const sessionId = event.session_id;
  if (!sessionId) {
    log({ level: 'WARN', msg: 'spawn event without session_id; allowed uncounted', tool: toolName, agent_id: event.agent_id, cwd: event.cwd });
    return { decision: 'allow', skipped: true, reason: 'no session_id' };
  }

  const thresholds = readThresholds(env);
  const file = sessionFile(sessionId);
  const count = countLines(file) + 1;
  const bypass = env.SPAWN_CAP_ALLOW === 'true';
  const input = event.tool_input || {};
  const logFields = {
    count, ask: thresholds.ask, step: thresholds.step, deny: thresholds.deny,
    subagent_type: typeof input.subagent_type === 'string' ? input.subagent_type : undefined,
    agent_id: event.agent_id, agent_type: event.agent_type,
  };

  if (thresholds.clamped) log({ level: 'WARN', msg: 'SPAWN_CAP_DENY below SPAWN_CAP_ASK; clamped', ask: thresholds.ask, deny: thresholds.deny, session_id: sessionId });

  let decision = 'allow';
  if (!bypass && count >= thresholds.deny) decision = 'deny';
  else if (!bypass && shouldAsk(count, thresholds)) decision = 'ask';

  if (decision !== 'deny') {
    const record = { ts: new Date(now).toISOString(), n: count, decision: bypass ? 'bypass' : decision };
    if (event.agent_id) record.agent_id = event.agent_id;
    if (event.agent_type) record.agent_type = event.agent_type;
    if (logFields.subagent_type) record.subagent_type = logFields.subagent_type;
    if (typeof input.description === 'string') record.description = input.description.slice(0, 80);
    appendLine(file, record);
    pruneStale(now);
  }

  if (bypass) log({ level: 'ALLOW_OVERRIDE', ...logFields, session_id: sessionId, cwd: event.cwd, permission_mode: event.permission_mode });

  return {
    decision, count, thresholds, bypass, file, logFields,
    reason: decision === 'allow' ? null : buildReason(decision, count, thresholds, file),
  };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  try {
    const data = JSON.parse(input);
    if (!isSpawnTool(data.tool_name)) return console.log('{}');

    const r = evaluateSpawn(data);
    if (r.decision === 'allow') return console.log('{}');

    const { session_id, cwd, permission_mode } = data;
    log({ level: r.decision === 'ask' ? 'ASK' : 'BLOCKED', id: 'spawn-cap', decision: r.decision, ...r.logFields, tool: data.tool_name, session_id, cwd, permission_mode });
    return console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: r.decision,
        permissionDecisionReason: `${EMOJIS[r.decision]} ${r.reason}`,
      },
    }));
  } catch (e) {
    log({ level: 'ERROR', error: e.message });
    console.log('{}');
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    SPAWN_TOOLS, DEFAULT_ASK, DEFAULT_ASK_STEP, DEFAULT_DENY, EMOJIS, STATE_DIR,
    isSpawnTool, readThresholds, parsePositiveInt, sessionFile, displayPath, countLines,
    pruneStale, shouldAsk, buildReason, evaluateSpawn,
  };
}
