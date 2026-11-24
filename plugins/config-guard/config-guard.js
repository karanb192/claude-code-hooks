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
 *              anything under .claude/hooks/, scripts that settings
 *              register as hook commands, hooks.json manifests,
 *              installed plugins under ~/.claude/plugins/ (or
 *              $CLAUDE_CONFIG_DIR/plugins/), the Claude config dir itself,
 *              and the spawn cap's ledger under ~/.claude/subagent-spawn-cap/
 *   high     - + config supply chain: .mcp.json, ~/.claude.json, .claude-plugin/,
 *              `claude config set|add|remove`, `claude mcp add|remove`, and
 *              `claude plugin install|uninstall|enable|disable|marketplace`,
 *              their aliases, and global options before the subcommand
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
// The CLI also takes `plugins` for `plugin`, `i` for install, `remove` and
// `rm` for uninstall, `autoremove` for prune, and global options such as
// --debug before the subcommand.
const CLI_VALUE = '(?:"[^"\\n]*"|\'[^\'\\n]*\'|[^\\s"\';|&]+)';
const CLAUDE_OPTION = `-[\\w-]+(?:=${CLI_VALUE})?(?:\\s+(?!-|(?:plugins?|mcp|config)\\b)${CLI_VALUE})?`;
const CLAUDE_CLI_WRITE = new RegExp(`\\bclaude(?:\\s+${CLAUDE_OPTION})*\\s+(?:config\\s+(?:set|add|remove|rm)|mcp\\s+(?:add|add-json|add-from-claude-desktop|remove|rm)|plugins?\\s+(?:install|i|uninstall|remove|rm|enable|disable|update|prune|autoremove|marketplace\\s+(?:add|remove|rm|update)))\\b`, 'i');
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

// A classic install can keep a hook script anywhere, so the scripts that the
// user, project and managed settings register as hook commands are protected
// wherever they live. Words with an expansion other than ~, $HOME or
// $CLAUDE_PROJECT_DIR are skipped: their target cannot be known here.
const REGISTERED_HOOK = { level: 'critical', id: 'hook-script', reason: 'a script registered as a hook is a guardrail itself' };

function settingsFiles(project) {
  const files = [path.join(CLAUDE_HOME, 'settings.json'), path.join(CLAUDE_HOME, 'settings.local.json'),
    path.join(project, '.claude', 'settings.json'), path.join(project, '.claude', 'settings.local.json')];
  if (process.platform === 'darwin') files.push('/Library/Application Support/ClaudeCode/managed-settings.json');
  else if (process.platform === 'win32') files.push('C:\\Program Files\\ClaudeCode\\managed-settings.json');
  else files.push('/etc/claude-code/managed-settings.json');
  return files;
}

// One hook call is one process, so the settings are read once per project.
const hookScriptCache = new Map();
const MAX_SETTINGS_BYTES = 1024 * 1024;
const SCRIPT_EXT = /\.(?:[cm]?js|ts|py|sh|bash|zsh|rb|pl|php)$/i;

function readSettings(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_SETTINGS_BYTES) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// The code a hook command runs: each simple command's program when it is a
// path, or an interpreter's script operand (node gate.js, bash ~/g.sh).
// Other arguments and redirect targets are data the hook reads or writes.
const INTERPRETERS = /^(?:node|nodejs|deno|bun|tsx|ts-node|python[0-9.]*|bash|sh|zsh|dash|ksh|ruby|perl|php)$/;

function hookScriptWords(command) {
  const found = [];
  for (const simple of command.split(/&&|\|\||[;|\n]/)) {
    const words = simple.match(/\d*[<>]{1,2}&?|"[^"]*"|'[^']*'|[^\s"';|&<>()]+/g) || [];
    const plain = [];
    for (let i = 0; i < words.length; i++) {
      if (/^\d*[<>]/.test(words[i])) { i++; continue; }
      plain.push(words[i]);
    }
    let i = 0;
    while (i < plain.length && /^[A-Za-z_]\w*=/.test(plain[i])) i++;
    const program = (plain[i] || '').replace(/^(["'])(.*)\1$/s, '$2');
    if (!program) continue;
    if (/[\\/]/.test(program) || SCRIPT_EXT.test(program)) { found.push(plain[i]); continue; }
    if (!INTERPRETERS.test(path.basename(program))) continue;
    for (i++; i < plain.length; i++) {
      if (/^-[ce]$/.test(plain[i])) break;
      if (plain[i].startsWith('-')) continue;
      found.push(plain[i]);
      break;
    }
  }
  return found;
}

function registeredHookScripts(cwd = process.cwd()) {
  const project = path.resolve(process.env.CLAUDE_PROJECT_DIR || cwd || process.cwd());
  if (hookScriptCache.has(project)) return hookScriptCache.get(project);
  const scripts = new Set();
  for (const file of settingsFiles(project)) {
    const settings = readSettings(file);
    const events = settings && typeof settings.hooks === 'object' && settings.hooks ? Object.values(settings.hooks) : [];
    for (const groups of events) {
      for (const group of Array.isArray(groups) ? groups : []) {
        for (const hook of Array.isArray(group && group.hooks) ? group.hooks : []) {
          if (typeof (hook && hook.command) !== 'string') continue;
          for (const word of hookScriptWords(hook.command)) {
            const expanded = word.replace(/^(["'])(.*)\1$/s, '$2')
              .replace(/^~(?=[\\/])/, HOME_DIR)
              .replace(/\$(?:HOME|\{HOME\})(?=[\\/])/g, HOME_DIR)
              .replace(/\$(?:CLAUDE_PROJECT_DIR|\{CLAUDE_PROJECT_DIR\})(?=[\\/])/g, project);
            if (/[$`*?]/.test(expanded)) continue;
            for (const p of resolveCandidates(path.resolve(project, expanded))) scripts.add(p.replace(/\\/g, '/'));
          }
        }
      }
    }
  }
  hookScriptCache.set(project, [...scripts]);
  return hookScriptCache.get(project);
}

const hookTokenCache = new Map();

// Shell spellings of the registered scripts: the absolute path, ~ and $HOME
// forms under the home directory, and paths relative to the working
// directory (scripts/check.js, ./scripts/check.js).
function registeredHookTokens(cwd = process.cwd()) {
  const scripts = registeredHookScripts(cwd);
  if (hookTokenCache.has(scripts)) return hookTokenCache.get(scripts);
  const home = HOME_DIR.replace(/\\/g, '/');
  const here = path.resolve(cwd || process.cwd()).replace(/\\/g, '/');
  const tokens = scripts.map((script) => {
    const spellings = [escapeRegex(script)];
    if (script.startsWith(`${home}/`)) {
      const rest = escapeRegex(script.slice(home.length));
      spellings.push(`~${rest}`, `\\$HOME${rest}`, `\\$\\{HOME\\}${rest}`);
    }
    if (script.startsWith(`${here}/`)) {
      const rel = escapeRegex(script.slice(here.length + 1));
      spellings.push(`(?:\\./)?${rel}`);
    }
    return { ...REGISTERED_HOOK, regex: new RegExp(`(?:^|[\\s'"=(\`])(?:${spellings.join('|')})(?=[\\s'";|&)\`]|$)`) };
  });
  hookTokenCache.set(scripts, tokens);
  return tokens;
}

// Check for Edit/MultiEdit/Write file paths - unit-testable (touches the
// filesystem only to resolve symlinks; unresolvable paths check as typed).
function checkFilePath(filePath, safetyLevel = SAFETY_LEVEL, cwd = process.cwd()) {
  if (!filePath) return { blocked: false };
  const threshold = LEVELS[safetyLevel] || 2;
  const homes = resolveCandidates(CODEX_HOME).map((p) => p.replace(/\\/g, '/'));
  const claudeHomes = resolveCandidates(CLAUDE_HOME).map((p) => p.replace(/\\/g, '/'));
  const hookScripts = registeredHookScripts(cwd);
  for (const raw of resolveCandidates(path.resolve(cwd, filePath))) {
    const candidate = raw.replace(/\\/g, '/');
    if (homes.some((home) => candidate === home || candidate === `${home}/config.toml` || candidate === `${home}/plugins` || candidate.startsWith(`${home}/plugins/`))) {
      return { blocked: true, id: 'codex-config', level: 'critical', reason: 'Codex configuration and installed plugins control hook enforcement' };
    }
    if (claudeHomes.some((home) => candidate === `${home}/plugins` || candidate.startsWith(`${home}/plugins/`))) {
      return { blocked: true, id: 'claude-plugins', level: 'critical', reason: 'installed plugins are the guardrails\' own code' };
    }
    if (hookScripts.includes(candidate)) {
      const { level, id, reason } = REGISTERED_HOOK;
      return { blocked: true, id, level, reason };
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

// Commands of one Bash call, split at ; && || | & newlines and parentheses
// outside quotes. Enough to pair a verb with its own operands and to follow
// cd; not a shell parser.
function shellSegments(cmd) {
  const out = [];
  let cur = '', quote = '';
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) { if (c === quote) quote = ''; cur += c; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '\\') { cur += c + (cmd[i + 1] || ''); i++; continue; }
    if (/[;&|\n()]/.test(c) && !(c === '&' && (cmd[i - 1] === '>' || cmd[i + 1] === '>'))) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

// Deleting or moving a project's .claude folder itself, or everything in it,
// removes its settings and hooks. Only the verb's own command counts, so
// copying .claude elsewhere next to an unrelated rm still passes.
const CLAUDE_DIR_OPERAND = /(?:^|\s)["']?(?:[^\s"';|&()]*\/)?\.claude\/?\*?["']?(?=\s|$)/;
const DIR_MUTATION = /^(?:(?:sudo|command|env|nice|nohup)\s+(?:-\S+\s+)*)*(?:rm|unlink|trash|shred|mv|git\s+rm|git\s+mv)\b/i;

// Moving files into an existing .claude folder does not remove it: judge
// where each source lands instead. Anything unclear (globs, expansions,
// -T, a missing folder that mv would create by renaming) counts as removal.
// With judgeMoves off, a move into a .claude folder is left for the pass
// that knows the folder the move runs in; a removal is still refused.
function claudeDirChange(cmd, cwd, judgeMoves = true) {
  const landings = [];
  for (const seg of shellSegments(cmd)) {
    const verb = seg.match(DIR_MUTATION);
    if (!verb) continue;
    const args = seg.slice(verb[0].length);
    if (!CLAUDE_DIR_OPERAND.test(args)) continue;
    const into = /mv$/i.test(verb[0]) ? movesIntoClaudeDir(args, cwd, judgeMoves) : null;
    if (!into) return true;
    landings.push(...into);
  }
  return landings;
}

function movesIntoClaudeDir(args, cwd, judge = true) {
  const words = args.trim().split(/\s+/).map((w) => w.replace(/^(["'])(.*)\1$/, '$2'));
  if (words.some((w) => !w || /["'`$*?[\]{}\\<>]/.test(w))) return null;
  const operands = [];
  let target = null, options = true;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (options && w === '--') { options = false; continue; }
    if (options && w.startsWith('-') && w !== '-') {
      if (w === '-T' || w === '--no-target-directory') return null;
      const t = w.match(/^-t(.*)$|^--target-directory(?:=(.*))?$/);
      if (t) { target = (t[1] || t[2]) || words[++i]; continue; }
      if (w === '-S' || w === '--suffix') i++;
      continue;
    }
    operands.push(w);
  }
  const dest = target || operands.pop();
  const isDir = (w) => CLAUDE_DIR_OPERAND.test(` ${w}`);
  if (!dest || !operands.length || !isDir(dest) || /\*$/.test(dest) || operands.some(isDir)) return null;
  if (!judge) return [];
  const abs = path.resolve(cwd || process.cwd(), dest.replace(/^~(?=\/|$)/, HOME_DIR));
  try { if (!fs.statSync(abs).isDirectory()) return null; } catch { return null; }
  const base = dest.replace(/\/+$/, '');
  const out = [];
  for (const src of operands) {
    const name = path.posix.basename(src.replace(/\/+$/, ''));
    if (!name || name === '.' || name === '..') return null;
    out.push(`mv ${src} ${base}/${name}`);
  }
  return out;
}

// After `cd .claude` or `cd ~/.codex`, a bare `settings.json` or `hooks` is
// the protected path. Later relative words are rewritten with the directory
// in front, and the rewritten command is checked as well. The command name
// of each segment is left alone. A cd inside ( ) or $( ) ends with it, a cd
// in the background or before a pipe never moves the shell, and relative
// cds build on the directory before them. A cd at the end of a pipe moves
// zsh's shell but not bash's, so both directories are checked.
const CD_SEGMENT = /^(?:cd|pushd)(?:\s+-[LPe@]+)*\s+(?:--\s+)?(["']?)([^\s"';|&()]+)\1$/;
const HOME_START = /^(?:~|\$HOME|\$\{HOME\})(?:\/|$)/;

function shellSteps(cmd) {
  const out = [];
  let cur = '', quote = '';
  const flush = () => { const t = cur.trim(); if (t) out.push({ seg: t }); cur = ''; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) { if (c === quote) quote = ''; cur += c; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '\\') { cur += c + (cmd[i + 1] || ''); i++; continue; }
    if (c === '(' || c === ')') { flush(); out.push({ paren: c }); continue; }
    if ((c === '&' && (cmd[i - 1] === '>' || cmd[i + 1] === '>')) || (c === '|' && cmd[i - 1] === '>')) { cur += c; continue; }
    if (/[;&|\n]/.test(c)) {
      let op = c;
      if ((c === '&' || c === '|' || c === ';') && cmd[i + 1] === c) { op += c; i++; }
      else if (c === '|' && cmd[i + 1] === '&') { i++; }
      flush(); out.push({ sep: op }); continue;
    }
    cur += c;
  }
  flush();
  return out;
}

function joinDir(dir, target) {
  const full = HOME_START.test(target) || target.startsWith('/') || !dir ? target : `${dir}/${target}`;
  if (full.length > 4096) return target;
  const parts = [];
  for (const p of full.split('/')) {
    if (p === '' && parts.length) continue;
    if (p === '.') continue;
    if (p === '..' && parts.length && !['..', '', '~', '$HOME', '${HOME}'].includes(parts[parts.length - 1])) { parts.pop(); continue; }
    if (p === '..' && parts.length === 1 && parts[0] === '') continue;
    parts.push(p);
  }
  // Past a sane depth, judge by the last target alone, as a single cd would.
  if (parts.length > 32) return target;
  const out = parts.join('/');
  return out === '' && full.startsWith('/') ? '/' : out;
}

// The command name stays as typed, with sudo-style wrappers and a git
// subcommand, so `git mv` and `sudo rm` are still recognised.
const COMMAND_HEAD = /^(?:(?:sudo|command|env|nice|nohup|time)\s+(?:-\S+\s+)*)*(?:git\s+(?:-C\s+\S+\s+|-\S+\s+)*\S+|\S+)/i;
function prefixWords(seg, dir) {
  const head = (seg.match(COMMAND_HEAD) || [''])[0];
  return head + prefixArgs(seg.slice(head.length), dir);
}
function prefixArgs(seg, dir) {
  let first = false;
  // Quoted words and ./ or ../ paths are relative too.
  return seg.replace(/(^|[\s>])(["']?)((?:\.{1,2}\/|[A-Za-z0-9_]|\.[\w-])[\w.\/-]*)/g, (m, pre, quote, word) => {
    if (first && pre === '') { first = false; return m; }
    first = false;
    return `${pre}${quote}${dir.replace(/\/$/, '')}/${word}`;
  });
}

function withCdTargets(cmd) {
  let dirs = [''], prev = [''];
  // The pushd stack is a linked list, so a subshell saves it by reference.
  const subshells = [];
  let pushed = null;
  let inCase = 0, changed = false;
  const parts = [];
  const steps = shellSteps(cmd);
  const sepAt = (k) => (steps[k] && steps[k].sep) || '';
  for (let k = 0; k < steps.length; k++) {
    const step = steps[k];
    // A subshell gets copies of the folder, the previous folder and the
    // pushd stack; none of its changes reach the parent.
    if (step.paren === '(') { subshells.push([dirs, prev, pushed]); continue; }
    // In a case statement `pattern)` closes nothing, so stay in scope.
    if (step.paren === ')') {
      if (!inCase && subshells.length) [dirs, prev, pushed] = subshells.pop();
      continue;
    }
    if (!step.seg) continue;
    const seg = step.seg;
    if (/^case\s/.test(seg)) inCase++;
    else if (/^esac\b/.test(seg) && inCase) inCase--;

    let next = null, stackOp = null;
    const cd = seg.match(CD_SEGMENT);
    if (cd) {
      if (/^pushd/.test(seg)) stackOp = 'push';
      const target = cd[2];
      if (target === '-') next = prev;
      else if (target.startsWith('-')) next = dirs;
      else if (HOME_START.test(target) || /^[^$`]+$/.test(target)) next = [...new Set(dirs.map((d) => joinDir(d, target.replace(/(.)\/+$/, '$1'))))];
      else next = [''];
    } else if (/^cd$/.test(seg)) next = ['~'];
    else if (/^popd$/.test(seg)) { stackOp = 'pop'; next = pushed ? pushed.dirs : dirs; }
    if (next) {
      const after = sepAt(k + 1);
      // Before & or | the cd runs in a subshell and changes nothing here.
      if (after !== '&' && after !== '|') {
        if (sepAt(k - 1) === '|') {
          // Maybe moved (zsh) or not (bash): keep both, newest few only.
          const both = (a, b) => [...new Set([...a, ...b])].slice(-4);
          if (stackOp === 'push') pushed = { dirs, next: pushed };
          if (stackOp === 'pop' && pushed && pushed.next) pushed = { dirs: both(pushed.next.dirs, pushed.dirs), next: pushed.next.next };
          dirs = both(dirs, next);
        } else {
          if (stackOp === 'push') pushed = { dirs, next: pushed };
          if (stackOp === 'pop' && pushed) pushed = pushed.next;
          prev = dirs; dirs = next;
        }
      }
      parts.push(seg);
      continue;
    }
    if (dirs.includes('')) parts.push(seg);
    for (const d of dirs) {
      if (d === '') continue;
      changed = true;
      parts.push(prefixWords(seg, d));
    }
  }
  return changed ? parts.join(' ; ') : null;
}

// Pure check for Bash commands - unit-testable.
function checkBashCommand(rawCmd = '', safetyLevel = SAFETY_LEVEL, cwd = process.cwd()) {
  if (typeof rawCmd !== 'string') throw new TypeError('Bash command must be a string');
  if (!rawCmd) return { blocked: false };
  const viaCd = withCdTargets(stripTextHeredocs(rawCmd));
  // Whether a move's .claude destination exists depends on the folder the
  // move runs in, so after a cd only the rewritten command judges it.
  const direct = checkCommandText(rawCmd, safetyLevel, cwd, !viaCd);
  if (direct.blocked) return direct;
  return viaCd ? checkCommandText(viaCd, safetyLevel, cwd, true) : direct;
}

function checkCommandText(rawCmd, safetyLevel, cwd, dirMoves = true) {
  const cmd = stripTextHeredocs(rawCmd);
  const threshold = LEVELS[safetyLevel] || 2;

  if (LEVELS.high <= threshold && CLAUDE_CLI_WRITE.test(cmd)) {
    return { blocked: true, id: 'claude-cli-config', level: 'high', reason: 'claude config/mcp CLI write rewrites agent config' };
  }
  if (LEVELS.high <= threshold && CODEX_CLI_WRITE.test(cmd)) {
    return { blocked: true, id: 'codex-cli-config', level: 'high', reason: 'Codex CLI write changes plugin or agent configuration' };
  }

  for (const t of [...BASH_TOKENS, ...registeredHookTokens(cwd)]) {
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
  const dirChange = claudeDirChange(cmd, cwd, dirMoves);
  if (dirChange === true) {
    return { blocked: true, id: 'claude-dir', level: 'critical', reason: 'deleting or moving a .claude folder removes its settings and hooks' };
  }
  for (const landing of dirChange) {
    const r = checkCommandText(landing, safetyLevel, cwd);
    if (r.blocked) return r;
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
    return checkBashCommand(toolInput.command, safetyLevel, cwd);
  }
  return { blocked: false };
}

// A check that throws must not read as an allow, so the call is denied.
// HOOK_FAIL_OPEN=true restores the old allow-on-error behaviour.
function guardError(e) {
  if (process.env.HOOK_FAIL_OPEN === 'true') return '{}';
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `🚨 [guard-error] config-guard could not check this call (${String(e && e.message).slice(0, 200)}), so it is blocked. Run it yourself if you meant it, or set HOOK_FAIL_OPEN=true to let calls through when a guard fails.`,
    },
  });
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let data;
  try {
    data = JSON.parse(input);
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
    console.log(data !== null && typeof data === 'object' ? guardError(e) : '{}');
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    PROTECTED_PATHS, BASH_TOKENS, LEVELS, SAFETY_LEVEL, ASK,
    checkTool, checkFilePath, checkBashCommand, stripTextHeredocs, registeredHookScripts,
  };
}
