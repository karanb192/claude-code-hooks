#!/usr/bin/env node
/**
 * Subagent Spawn Cap - PreToolUse Hook for Agent|Task
 * A total-spawns-per-session budget for subagents. Counts every Agent
 * tool call in a session (nested calls made from inside subagents
 * included, since hooks fire there too and carry the same session_id),
 * asks for approval once the count reaches SPAWN_CAP_ASK (default 20)
 * and denies once it reaches SPAWN_CAP_DENY (default 60).
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
 * Denied calls are not recorded. Files older than 7 days are pruned
 * opportunistically (at most once a day, never fatal).
 *
 * Tunables (env, validated, safe fallback):
 *   SPAWN_CAP_ASK   positive integer, default 20: spawn number that
 *                   triggers permissionDecision "ask"
 *   SPAWN_CAP_DENY  positive integer, default 60: spawn number that
 *                   triggers permissionDecision "deny"; clamped up to
 *                   SPAWN_CAP_ASK if set lower, so the hard cap can never
 *                   sit below the ask threshold
 *   SPAWN_CAP_ALLOW the literal string "true" lets this one call through
 *                   (still counted, so the budget stays truthful)
 * HOOK_SAFETY_LEVEL is deliberately NOT read: the repo's levels pick
 * pattern sets, not numeric budgets, and two explicit integers are
 * clearer than a level-to-number table nobody can see.
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
 * the cap by up to the native concurrency limit; the next call is
 * denied. A user can raise the caps; that is the point of env tunables.
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
const DEFAULT_DENY = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_AFTER_MS = 7 * DAY_MS;
const PRUNE_EVERY_MS = DAY_MS;

const EMOJIS = { ask: '⚠️', deny: '🚨' };

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

// Resolve both thresholds from env. Exported so tests can pin the fallback
// rules without spawning.
function readThresholds(env = process.env) {
  const ask = parsePositiveInt(env.SPAWN_CAP_ASK, DEFAULT_ASK);
  let deny = parsePositiveInt(env.SPAWN_CAP_DENY, DEFAULT_DENY);
  let clamped = false;
  if (deny < ask) { deny = ask; clamped = true; }
  return { ask, deny, clamped };
}

const isSpawnTool = (toolName) => SPAWN_TOOLS.includes(toolName);

// session_id becomes a file name; keep it to a safe charset and length.
function sessionFile(sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
  return path.join(STATE_DIR, `${safe}.jsonl`);
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

function buildReason(decision, n, t) {
  if (decision === 'deny') {
    return `[spawn-cap] Subagent spawn #${n} in this session reached the hard cap (SPAWN_CAP_DENY=${t.deny}). Runaway fan-outs burn tokens fast. Raise SPAWN_CAP_DENY for a bigger budget, or set SPAWN_CAP_ALLOW=true for this one call.`;
  }
  return `[spawn-cap] Subagent spawn #${n} in this session reached the ask threshold (SPAWN_CAP_ASK=${t.ask}; hard cap SPAWN_CAP_DENY=${t.deny}). Approve to continue, raise SPAWN_CAP_ASK to stop being asked, or set SPAWN_CAP_ALLOW=true for this one call.`;
}

// The whole decision for one event. Returns
//   { decision: 'allow' | 'ask' | 'deny', count, thresholds, reason, bypass }
// and appends to the session ledger for allow/ask. Touches the filesystem
// only when the tool is a spawn tool. Throws on I/O errors other than a
// missing ledger; main() and guard-pack turn that into fail-open.
function evaluateSpawn(event, env = process.env, now = Date.now()) {
  const toolName = event?.tool_name;
  if (!isSpawnTool(toolName)) return { decision: 'allow', skipped: true };
  const sessionId = event.session_id;
  if (!sessionId) return { decision: 'allow', skipped: true, reason: 'no session_id' };

  const thresholds = readThresholds(env);
  const file = sessionFile(sessionId);
  const count = countLines(file) + 1;
  const bypass = env.SPAWN_CAP_ALLOW === 'true';

  let decision = 'allow';
  if (!bypass && count >= thresholds.deny) decision = 'deny';
  else if (!bypass && count >= thresholds.ask) decision = 'ask';

  if (decision !== 'deny') {
    const input = event.tool_input || {};
    const record = { ts: new Date(now).toISOString(), n: count, decision: bypass ? 'bypass' : decision };
    if (event.agent_id) record.agent_id = event.agent_id;
    if (event.agent_type) record.agent_type = event.agent_type;
    if (typeof input.subagent_type === 'string') record.subagent_type = input.subagent_type;
    if (typeof input.description === 'string') record.description = input.description.slice(0, 80);
    appendLine(file, record);
    pruneStale(now);
  }

  return {
    decision, count, thresholds, bypass,
    reason: decision === 'allow' ? null : buildReason(decision, count, thresholds),
  };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  try {
    const data = JSON.parse(input);
    if (!isSpawnTool(data.tool_name)) return console.log('{}');

    const r = evaluateSpawn(data);
    const { session_id, agent_id, agent_type, cwd, permission_mode } = data;
    if (r.thresholds?.clamped) log({ level: 'WARN', msg: 'SPAWN_CAP_DENY below SPAWN_CAP_ASK; clamped', ...r.thresholds, session_id });
    if (r.bypass) log({ level: 'ALLOW_OVERRIDE', count: r.count, session_id, agent_id, agent_type, cwd, permission_mode });
    if (r.decision === 'allow') return console.log('{}');

    log({ level: r.decision === 'ask' ? 'ASK' : 'BLOCKED', id: 'spawn-cap', decision: r.decision, count: r.count, ...r.thresholds, tool: data.tool_name, subagent_type: data.tool_input?.subagent_type, session_id, agent_id, agent_type, cwd, permission_mode });
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
    SPAWN_TOOLS, DEFAULT_ASK, DEFAULT_DENY, EMOJIS, STATE_DIR,
    isSpawnTool, readThresholds, parsePositiveInt, sessionFile, countLines,
    pruneStale, buildReason, evaluateSpawn,
  };
}
