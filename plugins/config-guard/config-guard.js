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
  { level: 'critical', id: 'hooks-manifest',   regex: /(^|[\s'"/=>])hooks\.json/i,                     reason: 'hooks.json manifests register hooks' },
  { level: 'critical', id: 'spawn-cap-state',  regex: /\.claude\/subagent-spawn-cap(?=[/\s'";|&)`]|$)/i, reason: 'the spawn cap ledger is the session\'s subagent budget' },
  { level: 'high',     id: 'mcp-config',       regex: /\.mcp\.json/i,                                 reason: '.mcp.json adds MCP servers (new tools)' },
  // An expansion may leave the filename unchanged. Only a literal suffix rules it out.
  { level: 'high',     id: 'claude-json',      regex: /(^|[\s'"/=])\.claude\.json(?=$|[\s'";&|<>()`$\\*?{},\[]|[+@!]\()/i,                  reason: '~/.claude.json holds user and local MCP servers (new tools)' },
  { level: 'high',     id: 'plugin-manifest',  regex: /\.claude-plugin([/\s'"]|$)/i,                  reason: 'plugin manifests install hooks and skills' },
  { level: 'strict',   id: 'claude-md',        regex: /(^|[\s'"/=>])CLAUDE(\.local)?\.md/i,            reason: 'CLAUDE.md instructions steer the agent' },
  { level: 'strict',   id: 'rules-dir',        regex: /\.claude\/(rules|agents|commands)([/\s'"]|$)/i, reason: 'rules, agents, and commands steer the agent' },
];

// Mutation forms in shell commands. Reads (cat, jq, grep, ls, diff, node) pass.
// All case-insensitive: on the case-insensitive filesystems macOS and Windows
// default to, `RM` and `SED` resolve to the same binaries.
const DELETE_VERB    = /(\brm\b|\bunlink\b|\bshred\b|\btrash\b|\bgit\s+rm\b|\bfind\b[^|;&]*\s-delete\b)/i;
const MOVE_COPY_VERB = /\b(mv|cp|rsync|install|ln|ditto)\b/i;
// Tools that take the file to write as an argument: downloaders with an
// output flag, sponge, touch (creating counts) and archive extraction. patch
// and tar -C depend on their mode, so patchWrites and tarWrites judge them.
const WRITE_VERB     = /\b(tee|truncate|dd|sponge|touch)\b|\bcurl\b[^|;&]*\s(?:-[a-zA-Z]*o|--output(?:-dir)?)\b|\bwget\b[^|;&]*\s(?:-[a-zA-Z]*[OP]|--output-document|--directory-prefix)|\bunzip\b[^|;&]*\s-[a-zA-Z]*[dxC]\b/i;
// Short flags cluster (-Ei, -ni), GNU spells it --in-place, ruby takes -pi
// like perl, and GNU awk is often installed as plain awk. BSD sed's -I is
// in-place too, so sed stays case-insensitive.
// A quote or backslash before the flag ("-i", \-i) does not change it.
const INPLACE_EDIT   = /\b(?:sed|gsed)\b[^|;&]*\s["'\\]*(?:-[a-zA-Z]*i|--in-place)\b|\bg?awk\b[^|;&]*\s["'\\]*-i["']?\s*["']?inplace\b/i;
// For perl and ruby only lowercase -i edits in place: -I is the library path.
// A switch that takes a value (-I, -M, -e, ruby's -r, ...) swallows the rest
// of its cluster, and with nothing left in the cluster -e, -E and -I (and
// ruby's -r and -C) take the next word. Words after `--` are files, not
// switches. Any other letter, known or not, lets the cluster go on.
const SCRIPT_VALUE     = { perl: 'eEIMmxF', ruby: 'eEIrCxF' };
const SCRIPT_SEPARATE  = { perl: 'eEI', ruby: 'eEIrC' };
function scriptWords(text) {
  const words = [];
  let cur = '', quote = '', inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = ''; else cur += c; continue; }
    if (c === '"' || c === "'") { quote = c; inWord = true; continue; }
    if (c === '\\') { cur += text[++i] || ''; inWord = true; continue; }
    if (/\s/.test(c)) { if (inWord) words.push(cur); cur = ''; inWord = false; continue; }
    cur += c; inWord = true;
  }
  if (inWord) words.push(cur);
  return words;
}
function scriptInplace(cmd) {
  for (const piece of cmd.split(/[|;&\n]/)) {
    if (!/\b(?:perl|ruby)\b/i.test(piece)) continue;
    const words = scriptWords(piece);
    let interp = null, switches = false;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const name = w.match(/\b(perl|ruby)\b/i);
      if (name) { interp = name[1].toLowerCase(); switches = true; continue; }
      if (!interp || !switches) continue;
      if (w === '--') { switches = false; continue; }
      if (!/^-[a-zA-Z0-9]/.test(w)) continue;
      for (let k = 1; k < w.length; k++) {
        const ch = w[k];
        if (ch === 'i') return true;
        if (!/[a-zA-Z0-9]/.test(ch)) break;
        // perl's -0 takes octal digits or x and hex digits, then goes on.
        if (ch === '0' && interp === 'perl' && w[k + 1] === 'x') { k++; while (/[0-9a-fA-F]/.test(w[k + 1] || '')) k++; continue; }
        if (SCRIPT_VALUE[interp].includes(ch)) {
          if (k === w.length - 1 && SCRIPT_SEPARATE[interp].includes(ch)) i++;
          break;
        }
      }
    }
  }
  return false;
}

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
  { level: 'strict', id: 'agents-md', regex: /(^|[\s'"/=>])AGENTS(?:\.override)?\.md(?=[\s'";|&]|$)/i, reason: 'AGENTS.md instructions steer the agent' },
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

// What the log keeps of a refused call: the guard, the rule and, for Bash,
// the command name alone. No argument text is logged, so a token or
// password typed into the command never reaches the log file.
function commandName(command) {
  if (typeof command !== 'string') return undefined;
  const first = command.trim().split(/\s+/)[0] || '';
  return /^[\w./-]{1,32}$/.test(first) ? path.posix.basename(first) : undefined;
}

// True when the command redirects output into a protected token:
// "> path", ">> path", "2> path", ">| path" (with optional quoting/prefix).
function redirectsInto(cmd, tokenRegex) {
  const re = new RegExp(`(^|[^<>])>{1,2}[|&]?\\s*['"]?[^'"\\s;|&]*(${tokenRegex.source})`, 'i');
  // A target glued to the operator (>hooks.json) reads like one after a space.
  return re.test(cmd.replace(/(>[|&]?)(?=[^\s>|&])/g, '$1 '));
}

// patch the program writes its target unless a --dry-run or --check follows
// it before any `--`. A command that is git diff, show, log or whatchanged
// only prints, so its --patch option and a pathspec named fix.patch do not
// count; --patch on checkout, restore or stash still writes.
const PATCH_OPTION = /(^|['"=])--?(?:no-)?patch\b/gi;
const GIT_READ     = /^\s*(?:\w+=\S*\s+)*(?:(?:sudo|command|nice|nohup|time|env)\s+)*git\b(?:\s+-(?:[Cc]\s+[^\s-]\S*|[Cc]\S+|[^\sCc]\S*))*\s+(?:diff|show|log|whatchanged)\b/i;
function patchWrites(cmd) {
  for (const piece of cmd.split(/[|;&\n#()`]/)) {
    // A pager or config value before the subcommand can still run patch.
    const git = GIT_READ.exec(piece);
    const seg = git ? git[0] : piece;
    if (!/\bpatch\b/i.test(seg)) continue;
    const words = seg.trim().split(/\s+/);
    let dryRun = false;
    for (let i = words.length - 1; i >= 0; i--) {
      const w = words[i];
      if (w === '--') dryRun = false;
      else if (w === '--dry-run' || w === '--check') dryRun = true;
      if (!/\bpatch\b/i.test(w)) continue;
      if (!/\bpatch\b/i.test(w.replace(PATCH_OPTION, '$1')) || !dryRun) return true;
    }
  }
  return false;
}

// tar -C only names the directory tar works in. It writes there when tar
// extracts, and not when it creates or lists an archive. Creating or
// appending writes the -f archive, and any mode writes the -g snapshot,
// index and volume files, so those operands are checked instead.
// --remove-files deletes what it archived.
const TAR_RUN       = /(?<![\w.])(?:tar|bsdtar)\b([\s\S]*)/i;
const TAR_CD        = /\s-[a-zA-Z]*C|\s--(?:cd|directory)\b/;
// Short options that take no argument, so a mode letter after them in one
// cluster is still a mode letter. Long options count by prefix, as GNU tar
// accepts --extr for --extract.
const TAR_NOARG     = 'ahijklmnopqvwyzABDEGJMOPQRSUWYZ';
const TAR_EXTRACT   = new RegExp(`\\s-[a-zA-Z0-9]*x|\\s--(?:ext|ge)|^\\s+[a-zA-Z]*x`);
const TAR_MODE      = new RegExp(`\\s-[${TAR_NOARG}]*[ctruA]|\\s--(?:create|list|append|update|catenate|concatenate|delete)\\b|^\\s+[a-zA-Z]*[ctruA]`);
const TAR_ARCHIVING = new RegExp(`\\s-[${TAR_NOARG}]*[cruA]|\\s--(?:create|append|update|catenate|concatenate|delete)\\b|^\\s+[a-zA-Z]*[cruA]`);
// Shell words with quotes and backslashes resolved, so a quoted path with
// spaces is judged whole. Unquoted separators end the list.
function shellWords(text) {
  const words = [];
  let cur = '', quote = '', inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"' && /["\\$`]/.test(text[i + 1] || '')) cur += text[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; inWord = true; continue; }
    if (c === '\\') { cur += text[++i] || ''; inWord = true; continue; }
    if (/\s/.test(c)) { if (inWord) words.push(cur); cur = ''; inWord = false; continue; }
    cur += c; inWord = true;
  }
  if (inWord) words.push(cur);
  return words;
}

// Split at ; | & and newlines that are not inside quotes.
function unquotedSegments(cmd) {
  const out = [];
  let cur = '', quote = '';
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) { if (c === quote) quote = ''; else if (c === '\\' && quote === '"') { cur += c + (cmd[i + 1] || ''); i++; continue; } cur += c; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '\\') { cur += c + (cmd[i + 1] || ''); i++; continue; }
    if (/[;&|\n]/.test(c)) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// The files a tar call writes besides its directory: the -f archive and the
// -g, --listed-incremental, --index-file and --volno-file targets. A short
// option takes the rest of its word, or the next word when nothing is left.
function tarOutputs(args) {
  const words = shellWords(args);
  const archive = [], side = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const long = w.match(/^--(file|listed-incremental|index-file|volno-file)(?:=(.*))?$/);
    if (long) {
      const v = long[2] !== undefined ? long[2] : words[i + 1];
      if (v !== undefined) (long[1] === 'file' ? archive : side).push(v);
      continue;
    }
    const dashless = i === 0 && /^[a-zA-Z]+$/.test(w) && !w.startsWith('-');
    if (dashless) {
      if (w.includes('f') && words[1] !== undefined) archive.push(words[1]);
      continue;
    }
    if (!/^-[^-]/.test(w)) continue;
    for (const [letter, list] of [['f', archive], ['g', side]]) {
      const at = w.indexOf(letter, 1);
      if (at < 0 || !/^[a-zA-Z]*$/.test(w.slice(1, at))) continue;
      const rest = w.slice(at + 1);
      const v = rest || words[i + 1];
      if (v !== undefined) list.push(v);
    }
  }
  return { archive, side };
}

function tarWrites(cmd, tokenRegex) {
  for (const seg of cmd.split(/[|;&]/)) {
    const m = /\b(?:tar|bsdtar)\b/i.exec(seg);
    if (m && /\s-[a-zA-Z]*[dx]\b/i.test(seg.slice(m.index + m[0].length))) return true;
  }
  const named = (list) => list.some((v) => tokenRegex.test(' ' + v));
  for (const seg of unquotedSegments(cmd.replace(/\\\r?\n/g, ' '))) {
    const m = TAR_RUN.exec(seg);
    if (!m) continue;
    const args = m[1];
    const extracts = TAR_EXTRACT.test(args);
    if (extracts ? TAR_CD.test(args) || /\s-[a-zA-Z]*c\b/i.test(args) : TAR_CD.test(args) && !TAR_MODE.test(args)) return true;
    const { archive, side } = tarOutputs(args);
    if (/\s--rem/.test(args) || named(side)) return true;
    if (!extracts && TAR_ARCHIVING.test(args) && named(archive)) return true;
  }
  return false;
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
const WRAPPERS = /^(?:(?:sudo|command|env|nice|nohup|time)\s+(?:-\S+\s+)*)*/i;

// Shell words of a command with their raw end offsets; quotes are removed.
function rawWords(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    const start = i;
    let value = '', quote = '';
    for (; i < text.length; i++) {
      const c = text[i];
      if (quote) { if (c === quote) quote = ''; else value += c; continue; }
      if (/\s/.test(c)) break;
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '\\') { value += text[++i] || ''; continue; }
      value += c;
    }
    out.push({ start, end: i, value });
  }
  return out;
}

// git's global options before the subcommand: -C <dir> moves where paths
// are read, and -c, --git-dir, --work-tree, --namespace, --super-prefix and
// --config-env take a value. Returns the subcommand, where it ends, the -C
// folders and whether any other value-taking option was given.
const GIT_VALUE_OPTION = /^--(?:git-dir|work-tree|namespace|super-prefix|config-env)$/;
function gitHead(text) {
  const words = rawWords(text);
  if (!words.length || !/^git$/i.test(words[0].value)) return null;
  const dirs = [];
  let other = false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i], v = w.value;
    if (v === '-C' || v === '-c' || GIT_VALUE_OPTION.test(v)) {
      const val = words[++i];
      if (!val) return null;
      if (v === '-C') dirs.push(val); else other = true;
      continue;
    }
    if (/^-C./.test(v)) { dirs.push({ start: w.start + 2, end: w.end, value: v.slice(2) }); continue; }
    if (/^-c./.test(v) || /^--(?:git-dir|work-tree|namespace|super-prefix|config-env)=/.test(v)) { other = true; continue; }
    if (v.startsWith('-')) continue;
    return { sub: v, end: w.end, dirs, other };
  }
  return null;
}

// The removal or move a segment runs, past wrappers and git's global options.
function dirMutation(seg) {
  const rest = seg.slice(seg.match(WRAPPERS)[0].length);
  const plain = rest.match(/^(rm|unlink|trash|shred|mv)\b/i);
  if (plain) return { move: /^mv$/i.test(plain[1]), args: rest.slice(plain[0].length), dir: '', other: false };
  const git = gitHead(rest);
  if (!git || !/^(?:rm|mv)$/i.test(git.sub)) return null;
  let dir = '', unknown = false;
  for (const d of git.dirs) {
    if (/[$`]/.test(d.value)) unknown = true;
    dir = !dir || d.value.startsWith('/') || /^~(?:\/|$)/.test(d.value) ? d.value : `${dir}/${d.value}`;
  }
  return { move: /^mv$/i.test(git.sub), args: rest.slice(git.end), dir, other: git.other || unknown };
}

// Moving files into an existing .claude folder does not remove it: judge
// where each source lands instead. Anything unclear (globs, expansions,
// -T, a missing folder that mv would create by renaming) counts as removal.
// With judgeMoves off, a move into a .claude folder is left for the pass
// that knows the folder the move runs in; a removal is still refused.
function claudeDirChange(cmd, cwd, judgeMoves = true) {
  const landings = [];
  for (const seg of shellSegments(cmd)) {
    const op = dirMutation(seg);
    if (!op) continue;
    const { args } = op;
    if (!CLAUDE_DIR_OPERAND.test(args)) continue;
    // Other git options can move the work tree, so such a move stays refused.
    const into = op.move && !op.other ? movesIntoClaudeDir(args, cwd, judgeMoves, op.dir) : null;
    if (!into) return true;
    landings.push(...into);
  }
  return landings;
}

function movesIntoClaudeDir(args, cwd, judge = true, inDir = '') {
  if (/[`$*?[\]{}\\<>]/.test(args)) return null;
  const words = rawWords(args).map((w) => w.value);
  if (words.some((w) => !w)) return null;
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
  const home = (p) => p.replace(/^~(?=\/|$)/, HOME_DIR);
  const abs = path.resolve(cwd || process.cwd(), home(inDir), home(dest));
  try { if (!fs.statSync(abs).isDirectory()) return null; } catch { return null; }
  const base = (inDir && !/^[/~]/.test(dest) ? `${inDir}/` : '') + dest.replace(/\/+$/, '');
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
function prefixWords(seg, dir) {
  const wrap = seg.match(WRAPPERS)[0];
  const rest = seg.slice(wrap.length);
  const git = gitHead(rest);
  const head = git ? rest.slice(0, git.end) : (rest.match(/^\S*/) || [''])[0];
  return wrap + head + prefixArgs(rest.slice(head.length), dir);
}

// git -C <dir> works like a cd for its own paths: drop the -C options and
// prefix the paths with the folder they resolve in. Null when a -C value is
// not literal, or the segment has no -C.
function rewriteGitDir(seg, dir) {
  const wrap = seg.match(WRAPPERS)[0];
  const rest = seg.slice(wrap.length);
  const git = gitHead(rest);
  if (!git || !git.dirs.length || git.dirs.some((d) => /[$`"'\\]/.test(d.value))) return null;
  let eff = dir;
  for (const d of git.dirs) eff = joinDir(eff, d.value.replace(/(.)\/+$/, '$1'));
  const words = rawWords(rest.slice(0, git.end));
  const kept = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i].value === '-C') { i++; continue; }
    if (/^-C./.test(words[i].value)) continue;
    kept.push(rest.slice(words[i].start, words[i].end));
  }
  const args = rest.slice(git.end);
  return wrap + kept.join(' ') + (eff && eff !== '.' ? prefixArgs(args, eff) : args);
}
function prefixArgs(seg, dir) {
  const base = dir.replace(/\/$/, '');
  // A folder with spaces is quoted, so the rewritten word stays one word.
  const open = /[^\w.\/~-]/.test(base) ? '"' : '';
  // Quoted words and ./ or ../ paths are relative too.
  return seg.replace(/(^|[\s>])(["']?)((?:\.{1,2}\/|[A-Za-z0-9_]|\.[\w-])[\w.\/-]*)/g, (m, pre, quote, word) =>
    quote ? `${pre}${quote}${base}/${word}` : `${pre}${open}${base}/${word}${open}`);
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
    if (gitHead(seg.slice(seg.match(WRAPPERS)[0].length))?.dirs.length && rewriteGitDir(seg, '') !== null) {
      for (const d of dirs) {
        const r = rewriteGitDir(seg, d);
        if (r !== seg) changed = true;
        parts.push(r);
      }
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
  // Quotes around part of a word do not change the path: .claude/"settings.json".
  const cmd = stripTextHeredocs(rawCmd).replace(/(?<=[\w./~-])(["'])([^"'\s]*)\1|(["'])([^"'\s]*)\3(?=[\w./-])/g, '$2$4');
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
    if (INPLACE_EDIT.test(cmd) || scriptInplace(cmd))
      return { blocked: true, id: t.id, level: t.level, reason: `in-place edit of protected config: ${t.reason}` };
    if (DELETE_VERB.test(cmd))
      return { blocked: true, id: t.id, level: t.level, reason: `deleting protected config: ${t.reason}` };
    if (MOVE_COPY_VERB.test(cmd))
      return { blocked: true, id: t.id, level: t.level, reason: `moving/copying/linking a protected config path: ${t.reason}` };
    if (WRITE_VERB.test(cmd) || patchWrites(cmd) || tarWrites(cmd, t.regex))
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
      const command = tool_name === 'Bash' ? commandName(tool_input?.command) : undefined;
      log({ level: shouldAsk ? 'ASK' : 'BLOCKED', guard: 'config-guard', id: result.id, priority: result.level, decision, tool: tool_name, command, session_id, cwd, permission_mode });
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
    checkTool, checkFilePath, checkBashCommand, stripTextHeredocs, registeredHookScripts, commandName,
  };
}
