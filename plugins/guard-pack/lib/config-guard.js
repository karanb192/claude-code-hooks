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
 * SAFETY_LEVEL: 'critical' | 'high' | 'strict' (default 'high'; override via
 * the HOOK_SAFETY_LEVEL env var - plugin updates overwrite installed files,
 * so edit env, not this file; invalid values fall back to the default)
 *   critical - the enforcement chain: .claude/settings.json,
 *              .claude/settings.local.json, managed-settings.json,
 *              anything under .claude/hooks/, hooks.json manifests,
 *              installed plugins under ~/.claude/plugins/ (or
 *              $CLAUDE_CONFIG_DIR/plugins/), the Claude config dir itself,
 *              and the spawn cap's ledger under ~/.claude/subagent-spawn-cap/
 *   high     - + config supply chain: .mcp.json, ~/.claude.json, .claude-plugin/,
 *              `claude config set|add|remove`, `claude mcp add|remove`, and
 *              `claude plugin install|uninstall|enable|disable|marketplace`
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
 * command block it even if the verb technically targets another argument,
 * except in the body of a cat/tee heredoc or a git/gh "$(cat <<'EOF' ...)"
 * message, which is text, not commands (see stripTextHeredocs);
 * interpreter one-liners (python -c "open(...).write(...)"), git
 * checkout/restore of a config path, chmod, and paths built from variables
 * ("$DIR/settings.json") are not caught. Edit/MultiEdit/Write paths are
 * resolved through symlinks before checking (a write through
 * `ln -s ~/.claude /tmp/x` is still caught), but shell command strings are
 * matched as text, so a Bash redirect through a symlinked directory is not.
 * PreToolUse only sees the agent's own tool calls; out-of-band writes are
 * config-watch.js territory.
 *
 * Setup (plugin, recommended):
 *   /plugin marketplace add karanb192/claude-code-hooks
 *   /plugin install config-guard@claude-code-hooks
 * The plugin's hooks/hooks.json registers this script automatically.
 *
 * Setup (classic): copy this file somewhere stable and register it in
 * .claude/settings.json:
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

// Env-overridable because plugin updates overwrite installed files; an
// invalid HOOK_SAFETY_LEVEL falls back to the default 'high'.
const VALID_SAFETY_LEVELS = ['critical', 'high', 'strict'];
const SAFETY_LEVEL = VALID_SAFETY_LEVELS.includes(process.env.HOOK_SAFETY_LEVEL)
  ? process.env.HOOK_SAFETY_LEVEL
  : 'high';

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
  { level: 'critical', id: 'codex-config', regex: /(^|\/)\.codex(?:\/config\.toml|\/plugins(?:\/.*)?)?$/i, reason: 'Codex configuration and installed plugins control hook enforcement' },
  { level: 'critical', id: 'claude-plugins',   regex: /(^|\/)\.claude\/plugins(\/|$)/i,             reason: 'installed plugins are the guardrails\' own code' },
  { level: 'critical', id: 'spawn-cap-state',  regex: /(^|\/)\.claude\/subagent-spawn-cap(\/|$)/i,  reason: 'the spawn cap ledger is the session\'s subagent budget' },

  // HIGH - config supply chain
  { level: 'high',     id: 'mcp-config',       regex: /(^|\/)\.mcp\.json$/i,                        reason: '.mcp.json adds MCP servers (new tools)' },
  { level: 'high',     id: 'claude-json',      regex: /(^|\/)\.claude\.json$/i,                     reason: '~/.claude.json holds user and local MCP servers (new tools)' },
  { level: 'high',     id: 'plugin-manifest',  regex: /(^|\/)\.claude-plugin(\/|$)/i,               reason: 'plugin manifests install hooks and skills' },
  { level: 'high', id: 'codex-plugin-manifest', regex: /(^|\/)\.codex-plugin(\/|$)/i, reason: 'Codex plugin manifests register hooks' },

  // STRICT - instruction files that steer the agent
  { level: 'strict',   id: 'claude-md',        regex: /(^|\/)CLAUDE(\.local)?\.md$/i,               reason: 'CLAUDE.md instructions steer the agent' },
  { level: 'strict', id: 'agents-md', regex: /(^|\/)AGENTS(?:\.override)?\.md$/i, reason: 'AGENTS.md instructions steer the agent' },
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
  { level: 'critical', id: 'spawn-cap-state',  regex: /\.claude\/subagent-spawn-cap(?=[/\s'";|&)`]|$)/i, reason: 'the spawn cap ledger is the session\'s subagent budget' },
  { level: 'high',     id: 'mcp-config',       regex: /\.mcp\.json/i,                                 reason: '.mcp.json adds MCP servers (new tools)' },
  // An expansion may leave the filename unchanged. Only a literal suffix rules it out.
  { level: 'high',     id: 'claude-json',      regex: /(^|[\s'"/=])\.claude\.json(?=$|[\s'";&|<>()`$\\*?{},\[]|[+@!]\()/i,                  reason: '~/.claude.json holds user and local MCP servers (new tools)' },
  { level: 'high',     id: 'plugin-manifest',  regex: /\.claude-plugin([/\s'"]|$)/i,                  reason: 'plugin manifests install hooks and skills' },
  { level: 'strict',   id: 'claude-md',        regex: /(^|[\s'"/=])CLAUDE(\.local)?\.md/i,            reason: 'CLAUDE.md instructions steer the agent' },
  { level: 'strict',   id: 'rules-dir',        regex: /\.claude\/(rules|agents|commands)([/\s'"]|$)/i, reason: 'rules, agents, and commands steer the agent' },
];

// Mutation forms in shell commands. Reads (cat, jq, grep, ls, diff, node) pass.
// All case-insensitive: on the case-insensitive filesystems macOS and Windows
// default to, `RM` and `SED` resolve to the same binaries.
const DELETE_VERB    = /(\brm\b|\bunlink\b|\bshred\b|\btrash\b|\bgit\s+rm\b)/i;
const MOVE_COPY_VERB = /\b(mv|cp|rsync|install|ln)\b/i;
const WRITE_VERB     = /\b(tee|truncate|dd)\b/i;
const INPLACE_EDIT   = /\b(sed|gsed)\s+[^|;&]*-i\b|\bperl\s+[^|;&]*-\w*i\b|\bgawk\s+[^|;&]*-i\s*inplace\b/i;

// CLI commands that rewrite agent config without naming a settings path.
// `claude plugin install` registers arbitrary hooks and skills, so it is a
// config write in everything but name; list/get/read forms stay allowed.
const CLAUDE_CLI_WRITE = /\bclaude\s+(config\s+(set|add|remove|rm)|mcp\s+(add|add-json|add-from-claude-desktop|remove|rm)|plugin\s+(install|uninstall|enable|disable|update|marketplace\s+(add|remove|rm|update)))\b/i;
const CLI_VALUE = '(?:"[^"\\n]*"|\'[^\'\\n]*\'|[^\\s"\';|&]+)';
const CODEX_OPTION = `(?:--(?:profile|cd|model|config|sandbox|ask-for-approval|enable|disable|add-dir|image|local-provider|remote|remote-auth-token-env)(?:=|\\s+)${CLI_VALUE}|-[pCmcsai]\\s*${CLI_VALUE}|--(?:search|no-alt-screen|oss|strict-config|approve-for-me|dangerously-bypass-approvals-and-sandbox|dangerously-bypass-hook-trust|yolo|worktree|no-daemon|full-auto))`;
const CODEX_CLI_WRITE = new RegExp(`\\bcodex(?:\\s+${CODEX_OPTION})*\\s+(?:plugin\\s+(?:add|remove|marketplace\\s+(?:add|remove|upgrade))|mcp\\s+(?:add|remove)|features\\s+(?:enable|disable))\\b`, 'i');

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || require('os').homedir();
const CODEX_HOME = path.resolve(process.env.CODEX_HOME || path.join(HOME_DIR, '.codex'));
const CLAUDE_HOME = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(HOME_DIR, '.claude'));
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const codexPrefix = `(?:\\.codex|\\$CODEX_HOME|\\$\\{CODEX_HOME\\}|${escapeRegex(CODEX_HOME.replace(/\\/g, '/'))})`;
// Only home-anchored spellings count for the bare Claude dir: a project's own
// .claude/ is routinely copied into and listed next to unrelated deletes.
const claudePrefix = `(?:(?:~|\\$HOME|\\$\\{HOME\\})/\\.claude|\\$CLAUDE_CONFIG_DIR|\\$\\{CLAUDE_CONFIG_DIR\\}|${escapeRegex(CLAUDE_HOME.replace(/\\/g, '/'))})`;
BASH_TOKENS.push(
  { level: 'critical', id: 'codex-config', regex: new RegExp(`(?:^|[\\s'"/=])${codexPrefix}(?:/config\\.toml|/plugins(?:/[^\\s'";|&]*)?|/\\*?)?(?=[\\s'";|&]|$)`, 'i'), reason: 'Codex configuration and installed plugins control hook enforcement' },
  { level: 'critical', id: 'claude-plugins', regex: new RegExp(`\\.claude/plugins(?=[/\\s'";|&)\`]|$)|(?:^|[\\s'"=(\`])${claudePrefix}(?:/plugins(?:/[^\\s'";|&)\`]*)?|/\\*?)?(?=[\\s'";|&)\`]|$)`, 'i'), reason: 'installed plugins are the guardrails\' own code' },
  { level: 'high', id: 'codex-plugin-manifest', regex: /\.codex-plugin([/\s'"]|$)/i, reason: 'Codex plugin manifests register hooks' },
  { level: 'strict', id: 'agents-md', regex: /(^|[\s'"/=])AGENTS(?:\.override)?\.md(?=[\s'";|&]|$)/i, reason: 'AGENTS.md instructions steer the agent' },
);

const LEVELS = { critical: 1, high: 2, strict: 3 };
const EMOJIS = { critical: '🔒', high: '🛡️', strict: '⚠️' };
const LOG_DIR = path.join(process.env.HOME || process.env.USERPROFILE || require('os').homedir(), '.claude', 'hooks-logs');

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

// The typed path plus its symlink-resolved form: a write through
// `ln -s ~/.claude /tmp/x` must be judged by where it really lands. When the
// file does not exist yet, resolve its nearest existing ancestor.
function resolveCandidates(filePath) {
  const candidates = [filePath];
  try {
    candidates.push(fs.realpathSync.native(filePath));
  } catch {
    let ancestor = path.dirname(filePath);
    while (true) {
      try {
        candidates.push(path.join(fs.realpathSync.native(ancestor), path.relative(ancestor, filePath)));
        break;
      } catch {}
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }
  return [...new Set(candidates)];
}

// Check for Edit/MultiEdit/Write file paths - unit-testable (touches the
// filesystem only to resolve symlinks; unresolvable paths check as typed).
function checkFilePath(filePath, safetyLevel = SAFETY_LEVEL, cwd = process.cwd()) {
  if (!filePath) return { blocked: false };
  const threshold = LEVELS[safetyLevel] || 2;
  const homes = resolveCandidates(CODEX_HOME).map((p) => p.replace(/\\/g, '/'));
  const claudeHomes = resolveCandidates(CLAUDE_HOME).map((p) => p.replace(/\\/g, '/'));
  for (const raw of resolveCandidates(path.resolve(cwd, filePath))) {
    const candidate = raw.replace(/\\/g, '/');
    if (homes.some((home) => candidate === home || candidate === `${home}/config.toml` || candidate === `${home}/plugins` || candidate.startsWith(`${home}/plugins/`))) {
      return { blocked: true, id: 'codex-config', level: 'critical', reason: 'Codex configuration and installed plugins control hook enforcement' };
    }
    if (claudeHomes.some((home) => candidate === `${home}/plugins` || candidate.startsWith(`${home}/plugins/`))) {
      return { blocked: true, id: 'claude-plugins', level: 'critical', reason: 'installed plugins are the guardrails\' own code' };
    }
    for (const p of PROTECTED_PATHS) {
      if (LEVELS[p.level] <= threshold && p.regex.test(candidate)) {
        return { blocked: true, id: p.id, level: p.level, reason: p.reason };
      }
    }
  }
  return { blocked: false };
}

// A heredoc fed to cat or tee is text going into a file or an argument (a
// report, a commit or PR body), the same as a Write tool call, whose content
// this guard never inspects either. Dropping that body keeps a path that is
// only mentioned there from pairing with a verb word like "install" or "rm".
// Only two whole-command shapes qualify, built from plain words (no
// expansions, comments or operators), so a quote or comment cannot fake the
// heredoc start and nothing can run after it:
//   cat > report.md <<'EOF' ... EOF
//   git commit -m "$(cat <<'EOF' ... EOF
//   )"
// An unquoted delimiter qualifies only when the body has no $ or backtick,
// since the shell would expand those.
const WORD = /(?:[\w./=:@+,%~^-]|"[^"$`\\\n]*"|'[^'\n]*')+/.source;
const DELIM = /<<-?[ \t]*(['"]?)(?<delim>[A-Za-z_][\w.-]*)\1/.source;
const CAT_HEREDOC = new RegExp(`^\\s*(?:cat|tee)(?:\\s+(?:>{1,2}\\s*)?${WORD})*\\s+${DELIM}(?:\\s+(?:>{1,2}\\s*)?${WORD})*\\s*$`);
const GIT_HEREDOC = new RegExp(`^\\s*(?:(?:git|gh)(?:\\s+${WORD})*\\s*&&\\s*)*(?:git|gh)(?:\\s+${WORD})*\\s+(?:${WORD})?"\\$\\(cat\\s+${DELIM}\\s*$`);
const GIT_HEREDOC_CLOSE = new RegExp(`^\\s*\\)"(?:\\s+${WORD})*\\s*$`);

function stripTextHeredocs(cmd) {
  const lines = cmd.split('\n');
  const cat = CAT_HEREDOC.exec(lines[0]);
  const m = cat || GIT_HEREDOC.exec(lines[0]);
  if (!m) return cmd;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === m.groups.delim);
  if (end < 0) return cmd;
  if (!m[1] && /[$`]/.test(lines.slice(1, end).join('\n'))) return cmd;
  const rest = lines.slice(end + 1).filter((l) => l.trim());
  const closes = cat ? rest.length === 0 : rest.length === 1 && GIT_HEREDOC_CLOSE.test(rest[0]);
  return closes ? [lines[0], ...rest].join('\n') : cmd;
}

// Pure check for Bash commands - unit-testable.
function checkBashCommand(rawCmd, safetyLevel = SAFETY_LEVEL) {
  if (!rawCmd) return { blocked: false };
  const cmd = stripTextHeredocs(rawCmd);
  const threshold = LEVELS[safetyLevel] || 2;

  if (LEVELS.high <= threshold && CLAUDE_CLI_WRITE.test(cmd)) {
    return { blocked: true, id: 'claude-cli-config', level: 'high', reason: 'claude config/mcp CLI write rewrites agent config' };
  }
  if (LEVELS.high <= threshold && CODEX_CLI_WRITE.test(cmd)) {
    return { blocked: true, id: 'codex-cli-config', level: 'high', reason: 'Codex CLI write changes plugin or agent configuration' };
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
function checkTool(toolName, toolInput = {}, safetyLevel = SAFETY_LEVEL, cwd = process.cwd()) {
  if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write') {
    return checkFilePath(toolInput.file_path || '', safetyLevel, cwd);
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

    const result = checkTool(tool_name, tool_input || {}, SAFETY_LEVEL, cwd);

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
    checkTool, checkFilePath, checkBashCommand, stripTextHeredocs,
  };
}
