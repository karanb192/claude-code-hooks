#!/usr/bin/env node
/**
 * Subagent Spawn Cap - PreToolUse Hook for Agent|Task
 * A total-spawns-per-session budget for subagents: counts every Agent
 * tool call per session_id (nested spawns from inside subagents included),
 * asks at spawn SPAWN_CAP_ASK and every SPAWN_CAP_ASK_STEP after it, denies
 * at SPAWN_CAP_DENY. Defaults prompt at 20, 30, 40, 50 and stop at 60.
 * State: one append-only JSONL per session under ~/.claude/subagent-spawn-cap/
 * (parallel hook processes append safely; count = line count). Denied calls
 * are not recorded. Logs to: ~/.claude/hooks-logs/
 *
 * Env (validated positive integers, invalid values fall back):
 *   SPAWN_CAP_ASK=20  SPAWN_CAP_ASK_STEP=10  SPAWN_CAP_DENY=60 (clamped up
 *   to SPAWN_CAP_ASK if lower; equal to it = no asks)
 *   SPAWN_CAP_ALLOW=true lets spawns through while set (still counted).
 * Unattended (-p, dontAsk) runs turn asks into denies: set ASK equal to DENY.
 * HOOK_SAFETY_LEVEL is not read; a budget is a number, not a pattern set.
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

// `Agent` on current builds, `Task` on older ones.
const SPAWN_TOOLS = ['Agent', 'Task'];

const DEFAULT_ASK = 20;
const DEFAULT_ASK_STEP = 10;
const DEFAULT_DENY = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_AFTER_MS = 7 * DAY_MS;
const PRUNE_EVERY_MS = DAY_MS;

const EMOJIS = { ask: '⚠️', deny: '🚨' };

// Shared with guard-pack (which requires this module), so both paths log.
function log(data) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), hook: 'subagent-spawn-cap', ...data }) + '\n');
  } catch {}
}

function parsePositiveInt(raw, fallback) {
  if (typeof raw !== 'string') return fallback;
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return fallback;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function readThresholds(env = process.env) {
  const ask = parsePositiveInt(env.SPAWN_CAP_ASK, DEFAULT_ASK);
  const step = parsePositiveInt(env.SPAWN_CAP_ASK_STEP, DEFAULT_ASK_STEP);
  let deny = parsePositiveInt(env.SPAWN_CAP_DENY, DEFAULT_DENY);
  let clamped = false;
  if (deny < ask) { deny = ask; clamped = true; }
  return { ask, step, deny, clamped };
}

const isSpawnTool = (toolName) => SPAWN_TOOLS.includes(toolName);

// session_id becomes a file name: safe charset, bounded length.
function sessionFile(sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
  return path.join(STATE_DIR, `${safe}.jsonl`);
}

function displayPath(file) {
  return file.startsWith(HOME + path.sep) ? '~' + file.slice(HOME.length) : file;
}

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

// Drop ledgers untouched for 7 days; at most once a day (stamp mtime), never throws.
function pruneStale(now = Date.now()) {
  try {
    try {
      if (now - fs.statSync(PRUNE_STAMP).mtimeMs < PRUNE_EVERY_MS) return 0;
    } catch {}
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

function shouldAsk(count, t) {
  return count >= t.ask && (count - t.ask) % t.step === 0;
}

// Ask reasons are shown to the user, deny reasons to Claude (hooks reference).
function buildReason(decision, n, t, file) {
  const ledger = displayPath(file);
  if (decision === 'deny') {
    return `[spawn-cap] Subagent spawn #${n} in this session hit the hard cap (SPAWN_CAP_DENY=${t.deny}). Do not retry: finish with the results you already have and tell the user the session's spawn budget is spent. The user can reset it by deleting ${ledger}, or raise SPAWN_CAP_DENY in the settings.json env block and restart.`;
  }
  const silent = Math.min(t.step - 1, t.deny - n - 1);
  const nextCheck = n + t.step < t.deny ? `next check at #${n + t.step}, ` : '';
  const after = silent > 0
    ? `the next ${silent} spawn${silent === 1 ? '' : 's'} then pass without asking.`
    : `spawn #${t.deny} is then denied.`;
  return `[spawn-cap] Subagent spawn #${n} in this session (ask threshold SPAWN_CAP_ASK=${t.ask}, ${nextCheck}hard cap SPAWN_CAP_DENY=${t.deny}). Approve to continue; ${after} Deny to stop the fan-out. Reset this session's count by deleting ${ledger}; change the cadence via SPAWN_CAP_ASK / SPAWN_CAP_ASK_STEP in the settings.json env block (restart needed).`;
}

// Returns { decision: 'allow'|'ask'|'deny', count, thresholds, reason, bypass, file, logFields };
// appends to the ledger for allow/ask. Touches the filesystem only for spawn tools.
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
