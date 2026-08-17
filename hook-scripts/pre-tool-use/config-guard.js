#!/usr/bin/env node
/**
 * Config Guard - PreToolUse Hook for Bash|Edit|MultiEdit|Write
 * Who guards the guards: blocks the agent from tampering with its own
 * guardrail configuration - settings files that wire hooks and permissions,
 * the hook scripts themselves, hook manifests, MCP and plugin config.
 * Reads always pass (agents legitimately read settings); only writes,
 * in-place edits, moves, copies onto, and deletes are stopped.
 * Logs to: ~/.claude/hooks-logs/
 *
 * Why this hook exists: the Aug 2026 CHAINDROP npm worm hid its payload in
 * .claude/settings.json, and CVE-2026-25725 let sandboxed code persist by
 * injecting a hooks entry into a settings.json that did not exist yet
 * (which is why CREATING a protected file counts as mutation here). An
 * agent that can rewrite its own hook config can switch every other
 * guardrail off; this hook closes that loop. Pair it with config-watch.js
 * (ConfigChange event) to also catch changes made from outside the agent.
 *
 * SAFETY_LEVEL: 'critical' | 'high' | 'strict'
 *   critical - the enforcement chain: .claude/settings.json,
 *              .claude/settings.local.json, managed-settings.json,
 *              anything under .claude/hooks/, hooks.json manifests
 *   high     - + config supply chain: .mcp.json, .claude-plugin/,
 *              `claude config set|add|remove` and `claude mcp add|remove`
 *   strict   - + instruction files: CLAUDE.md, CLAUDE.local.md,
 *              .claude/rules/, .claude/agents/, .claude/commands/
 *
 * Escape hatch: set CONFIG_GUARD_ALLOW to the literal string "true" for an
 * intentional, human-approved config change (e.g. prefix a single hook
 * command with it in settings.json, or export it for one shell call).
 * Ask mode (opt-in, per level): set HOOK_ASK_CRITICAL / HOOK_ASK_HIGH /
 * HOOK_ASK_STRICT to "true" to prompt the user instead of denying outright,
 * so intentional edits degrade to a question instead of a hard wall.
 *
 * Known limits (deliberately NOT a full shell parser, same trade as
 * protect-tests): a mutation verb and a protected path in the same Bash
 * command block it even if the verb technically targets another argument;
 * interpreter one-liners (python -c "open(...).write(...)"), git
 * checkout/restore of a config path, chmod, and paths built from variables
 * ("$DIR/settings.json") are not caught. PreToolUse only sees the agent's
 * own tool calls; out-of-band writes are config-watch.js territory.
 *
 * Setup in .claude/settings.json:
 * {
 *   "hooks": {
 *     "PreToolUse": [{
 *       "matcher": "Bash|Edit|MultiEdit|Write",
 *       "hooks": [{ "type": "command", "command": "node /path/to/config-guard.js" }]
 *     }]
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');

const SAFETY_LEVEL = 'high';

// Ask mode per level: if true, prompts the user instead of blocking outright.
// Env overrides: HOOK_ASK_CRITICAL, HOOK_ASK_HIGH, HOOK_ASK_STRICT
const envBool = (key, fallback) => key in process.env ? process.env[key] === 'true' : fallback;
const ASK = {
  critical: envBool('HOOK_ASK_CRITICAL', false),
  high:     envBool('HOOK_ASK_HIGH', false),
  strict:   envBool('HOOK_ASK_STRICT', false),
};

// Escape hatch for intentional, human-approved config edits (literal "true").
const ALLOW_OVERRIDE = envBool('CONFIG_GUARD_ALLOW', false);

// Guardrail config targets as file paths (Edit / MultiEdit / Write file_path).
const PROTECTED_PATHS = [
  // CRITICAL - the enforcement chain itself
  { level: 'critical', id: 'settings-file',    regex: /(^|\/)\.claude\/settings(\.local)?\.json$/i, reason: 'Claude Code settings wire hooks and permissions' },
  { level: 'critical', id: 'managed-settings', regex: /(^|\/)managed-settings\.json$/i,             reason: 'managed policy settings' },
  { level: 'critical', id: 'hook-script',      regex: /(^|\/)\.claude\/hooks(\/|$)/i,               reason: 'hook scripts are the guardrails themselves' },
  { level: 'critical', id: 'hooks-manifest',   regex: /(^|\/)hooks\.json$/i,                        reason: 'hooks.json manifests register hooks' },

  // HIGH - config supply chain
  { level: 'high',     id: 'mcp-config',       regex: /(^|\/)\.mcp\.json$/i,                        reason: '.mcp.json adds MCP servers (new tools)' },
  { level: 'high',     id: 'plugin-manifest',  regex: /(^|\/)\.claude-plugin(\/|$)/i,               reason: 'plugin manifests install hooks and skills' },

  // STRICT - instruction files that steer the agent
  { level: 'strict',   id: 'claude-md',        regex: /(^|\/)CLAUDE(\.local)?\.md$/i,               reason: 'CLAUDE.md instructions steer the agent' },
  { level: 'strict',   id: 'rules-dir',        regex: /(^|\/)\.claude\/(rules|agents|commands)\//i, reason: 'rules, agents, and commands steer the agent' },
];

// The same targets as they appear as tokens inside a shell command. Not
// end-anchored: a token ends at whitespace or a quote, and suffixed forms
// (settings.json.bak) are config-adjacent enough to guard too.
const BASH_TOKENS = [
  { level: 'critical', id: 'settings-file',    regex: /\.claude\/settings(\.local)?\.json/i,          reason: 'Claude Code settings wire hooks and permissions' },
  { level: 'critical', id: 'managed-settings', regex: /managed-settings\.json/i,                      reason: 'managed policy settings' },
  { level: 'critical', id: 'hook-script',      regex: /\.claude\/hooks([/\s'"]|$)/i,                  reason: 'hook scripts are the guardrails themselves' },
  { level: 'critical', id: 'hooks-manifest',   regex: /(^|[\s'"/=])hooks\.json/i,                     reason: 'hooks.json manifests register hooks' },
  { level: 'high',     id: 'mcp-config',       regex: /\.mcp\.json/i,                                 reason: '.mcp.json adds MCP servers (new tools)' },
  { level: 'high',     id: 'plugin-manifest',  regex: /\.claude-plugin([/\s'"]|$)/i,                  reason: 'plugin manifests install hooks and skills' },
  { level: 'strict',   id: 'claude-md',        regex: /(^|[\s'"/=])CLAUDE(\.local)?\.md/i,            reason: 'CLAUDE.md instructions steer the agent' },
  { level: 'strict',   id: 'rules-dir',        regex: /\.claude\/(rules|agents|commands)([/\s'"]|$)/i, reason: 'rules, agents, and commands steer the agent' },
];

// Mutation forms in shell commands. Reads (cat, jq, grep, ls, diff, node) pass.
const DELETE_VERB    = /(\brm\b|\bunlink\b|\bshred\b|\btrash\b|\bgit\s+rm\b)/;
const MOVE_COPY_VERB = /\b(mv|cp|rsync|install|ln)\b/;
const WRITE_VERB     = /\b(tee|truncate|dd)\b/;
const INPLACE_EDIT   = /\b(sed|gsed)\s+[^|;&]*-i\b|\bperl\s+[^|;&]*-\w*i\b|\bgawk\s+[^|;&]*-i\s*inplace\b/;

// CLI commands that rewrite agent config without naming a settings path.
const CLAUDE_CLI_WRITE = /\bclaude\s+(config\s+(set|add|remove|rm)|mcp\s+(add|add-json|add-from-claude-desktop|remove|rm))\b/;

const LEVELS = { critical: 1, high: 2, strict: 3 };
const EMOJIS = { critical: '🔒', high: '🛡️', strict: '⚠️' };
const LOG_DIR = path.join(process.env.HOME || '/tmp', '.claude', 'hooks-logs');

function log(data) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), hook: 'config-guard', ...data }) + '\n');
  } catch {}
}

// True when the command redirects output into a protected token:
// "> path", ">> path", "2> path", ">| path" (with optional quoting/prefix).
function redirectsInto(cmd, tokenRegex) {
  const re = new RegExp(`(^|[^<>])>{1,2}\\|?\\s*['"]?[^'"\\s;|&]*(${tokenRegex.source})`, 'i');
  return re.test(cmd);
}

// Pure check for Edit/MultiEdit/Write file paths - unit-testable.
function checkFilePath(filePath, safetyLevel = SAFETY_LEVEL) {
  if (!filePath) return { blocked: false };
  const threshold = LEVELS[safetyLevel] || 2;
  for (const p of PROTECTED_PATHS) {
    if (LEVELS[p.level] <= threshold && p.regex.test(filePath)) {
      return { blocked: true, id: p.id, level: p.level, reason: p.reason };
    }
  }
  return { blocked: false };
}

// Pure check for Bash commands - unit-testable.
function checkBashCommand(cmd, safetyLevel = SAFETY_LEVEL) {
  if (!cmd) return { blocked: false };
  const threshold = LEVELS[safetyLevel] || 2;

  if (LEVELS.high <= threshold && CLAUDE_CLI_WRITE.test(cmd)) {
    return { blocked: true, id: 'claude-cli-config', level: 'high', reason: 'claude config/mcp CLI write rewrites agent config' };
  }

  for (const t of BASH_TOKENS) {
    if (LEVELS[t.level] > threshold || !t.regex.test(cmd)) continue;
    if (redirectsInto(cmd, t.regex))
      return { blocked: true, id: t.id, level: t.level, reason: `shell redirect into protected config: ${t.reason}` };
    if (INPLACE_EDIT.test(cmd))
      return { blocked: true, id: t.id, level: t.level, reason: `in-place edit of protected config: ${t.reason}` };
    if (DELETE_VERB.test(cmd))
      return { blocked: true, id: t.id, level: t.level, reason: `deleting protected config: ${t.reason}` };
    if (MOVE_COPY_VERB.test(cmd))
      return { blocked: true, id: t.id, level: t.level, reason: `moving/copying/linking a protected config path: ${t.reason}` };
    if (WRITE_VERB.test(cmd))
      return { blocked: true, id: t.id, level: t.level, reason: `writing to protected config: ${t.reason}` };
  }
  return { blocked: false };
}

// Returns { blocked, id, level, reason } - pure, so it is unit-testable.
// Read (and any unrecognized tool) always passes: reading config is legitimate.
function checkTool(toolName, toolInput = {}, safetyLevel = SAFETY_LEVEL) {
  if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write') {
    return checkFilePath(toolInput.file_path || '', safetyLevel);
  }
  if (toolName === 'Bash') {
    return checkBashCommand(toolInput.command || '', safetyLevel);
  }
  return { blocked: false };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  try {
    const data = JSON.parse(input);
    const { tool_name, tool_input, session_id, cwd, permission_mode } = data;

    if (ALLOW_OVERRIDE) {
      log({ level: 'ALLOW_OVERRIDE', tool: tool_name, session_id, cwd, permission_mode });
      return console.log('{}');
    }

    const result = checkTool(tool_name, tool_input || {});

    if (result.blocked) {
      const shouldAsk = ASK[result.level] === true;
      const decision = shouldAsk ? 'ask' : 'deny';
      const target = tool_input?.file_path || tool_input?.command?.slice(0, 100);
      log({ level: shouldAsk ? 'ASK' : 'BLOCKED', id: result.id, priority: result.level, decision, tool: tool_name, target, session_id, cwd, permission_mode });
      return console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: decision,
          permissionDecisionReason: `${EMOJIS[result.level]} [${result.id}] ${result.reason}. Guardrail config is protected; if this change is intentional and human-approved, set CONFIG_GUARD_ALLOW=true for this call or edit the file yourself.`
        }
      }));
    }
    console.log('{}');
  } catch (e) {
    log({ level: 'ERROR', error: e.message });
    console.log('{}');
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    PROTECTED_PATHS, BASH_TOKENS, LEVELS, SAFETY_LEVEL, ASK,
    checkTool, checkFilePath, checkBashCommand,
  };
}
