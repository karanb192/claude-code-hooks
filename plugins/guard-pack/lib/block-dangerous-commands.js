#!/usr/bin/env node
/**
 * Block Dangerous Commands - PreToolUse Hook for Bash
 * Blocks dangerous patterns before execution. Logs to: ~/.claude/hooks-logs/
 *
 * SAFETY_LEVEL: 'critical' | 'high' | 'strict' (default: 'high')
 *   critical - Only catastrophic: rm -rf ~, dd to disk, fork bombs
 *   high     - + risky: force push main, secrets exposure, git reset --hard
 *   strict   - + cautionary: any force push, sudo rm, docker prune
 * Override via HOOK_SAFETY_LEVEL in the hook command; invalid values fall
 * back to the default (don't edit this file: plugin updates overwrite it).
 *
 * Ask mode (opt-in, per level): set HOOK_ASK_CRITICAL / HOOK_ASK_HIGH /
 * HOOK_ASK_STRICT to the literal string "true" in the hook command to have
 * that level prompt the user ("ask") instead of blocking outright ("deny").
 * e.g. "command": "HOOK_ASK_STRICT=true node /path/to/block-dangerous-commands.js"
 *
 * Install as a plugin (recommended):
 *   /plugin install block-dangerous-commands@claude-code-hooks
 * This auto-wires the PreToolUse hook on Bash; configure via the env vars above.
 *
 * Or wire it up the classic way (copy the script, then in .claude/settings.json):
 * {
 *   "hooks": {
 *     "PreToolUse": [{
 *       "matcher": "Bash",
 *       "hooks": [{ "type": "command", "command": "node /path/to/block-dangerous-commands.js" }]
 *     }]
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');

// Safety level, env-overridable via HOOK_SAFETY_LEVEL. Invalid or unset values
// fall back to the default.
const DEFAULT_SAFETY_LEVEL = 'high';
const SAFETY_LEVEL = ['critical', 'high', 'strict'].includes(process.env.HOOK_SAFETY_LEVEL)
  ? process.env.HOOK_SAFETY_LEVEL
  : DEFAULT_SAFETY_LEVEL;

// Ask mode per level: if true, prompts the user instead of blocking outright.
// When ask=true, the hook returns decision "ask" so Claude Code shows the
// reason and lets the user decide. When ask=false (default), the hook denies.
// Env overrides: HOOK_ASK_CRITICAL, HOOK_ASK_HIGH, HOOK_ASK_STRICT
const envBool = (key, fallback) => key in process.env ? process.env[key] === 'true' : fallback;
const ASK = {
  critical: envBool('HOOK_ASK_CRITICAL', false),
  high:     envBool('HOOK_ASK_HIGH', false),
  strict:   envBool('HOOK_ASK_STRICT', false),
};

// git with global options before the subcommand (git -C repo push, git -c k=v push).
// Option values may be quoted, attached (-C/repo) or a separate word (--git-dir /repo).
// The alternatives never match the same text, so a long option run stays linear.
const GIT_VAL = '(?:"[^"]*"|\'[^\']*\'|[^\\s"\'][^\\s]*)';
const GIT_LONG_VAL = '(?:git-dir|work-tree|namespace|exec-path|super-prefix|config-env)';
const GIT = '\\bgit(?:\\s+(?:-[Cc]\\s*' + GIT_VAL + '|--' + GIT_LONG_VAL + '(?:=|\\s+)' + GIT_VAL + '|--(?!' + GIT_LONG_VAL + '\\b)[\\w-]+(?:=\\S+)?|-(?![Cc])[A-Za-z]))*\\s+';
const MAIN_REF = '(?:[\\s:"\']|refs\\/heads\\/)(?:main|master)(?=$|[\\s;&|"\'])';
// A shell word, not the "sh" in a *.sh file name; optional path (/bin/bash).
const SHELL = '(?<![\\w.\\/-])(?:[^\\s|;&]*\\/)?(?:ba|z|da|k)?sh(?![\\w.-])';
const FETCH = '(?:[^\\s|;&(]*\\/)?(?:curl|wget)\\b';
const FORCE_FLAG = '\\s["\']?(?:--force|-f)["\']?(?=\\s|$|[;&|"\'])';

const PATTERNS = [
  // CRITICAL - Catastrophic, unrecoverable
  // A trailing /. or /.. (~/., /Users/alice/..) still names the home directory or above.
  { level: 'critical', id: 'rm-home',          regex: /\brm\s+(-.+\s+)*["']?~(\/\.{1,2})*\/?["']?(\s|$|[;&|])/,             reason: 'rm targeting home directory' },
  { level: 'critical', id: 'rm-home-var',      regex: /\brm\s+(-.+\s+)*["']?\$(HOME|\{HOME\})(\/\.{1,2})*\/?["']?(\s|$|[;&|])/, reason: 'rm targeting $HOME' },
  { level: 'critical', id: 'rm-home-trailing', regex: /\brm\s+.+\s+["']?(~|\$(HOME|\{HOME\}))(\/\.{1,2})*\/?["']?(\s*$|[;&|])/, reason: 'rm with trailing ~/ or $HOME' },
  { level: 'critical', id: 'rm-home-abs',      regex: /\brm\s+(-.+\s+)*["']?\/(home|Users)(\/[^\/\s"';&|]+)?(\/\.{1,2})*\/?["']?(\s|$|[;&|])/, reason: 'rm targeting a home directory by absolute path' },
  { level: 'critical', id: 'rm-root',          regex: /\brm\s+(-.+\s+)*\/(\*|\s|$|[;&|])/,                                 reason: 'rm targeting root filesystem' },
  { level: 'critical', id: 'rm-system',        regex: /\brm\s+(-.+\s+)*\/(etc|usr|var|bin|sbin|lib|boot|dev|proc|sys)(\/|\s|$)/, reason: 'rm targeting system directory' },
  { level: 'critical', id: 'rm-cwd',           regex: /\brm\s+(-.+\s+)*(\.\/?|\*|\.\/\*)(\s|$|[;&|])/,                     reason: 'rm deleting current directory contents' },
  { level: 'critical', id: 'rm-parent',        regex: /\brm\s+(-.+\s+)*["']?([^\s"';&|]*\/)?\.\.(\/\.{1,2})*\/?(\*)?["']?(\s|$|[;&|])/, reason: 'rm of a path ending in .. deletes a parent directory' },
  { level: 'critical', id: 'dd-disk',          regex: /\bdd\b.+of=\/dev\/(sd[a-z]|nvme|hd[a-z]|vd[a-z]|xvd[a-z]|r?disk\d)/,         reason: 'dd writing to disk device' },
  { level: 'critical', id: 'mkfs',             regex: /\bmkfs(\.\w+)?\s+\/dev\/(sd[a-z]|nvme|hd[a-z]|vd[a-z]|r?disk\d)/,    reason: 'mkfs formatting disk' },
  { level: 'critical', id: 'fork-bomb',        regex: /:\(\)\s*\{.*:\s*\|\s*:.*&/,                                         reason: 'fork bomb detected' },

  // HIGH - Significant risk, data loss, security
  // The regex finds a fetch piped somewhere; pipesToShell walks the stages.
  { level: 'high', id: 'curl-pipe-sh',   regex: new RegExp(FETCH + '.*\\|'), confirm: pipesToShell,                    reason: 'piping URL to shell (RCE risk)' },
  { level: 'high', id: 'curl-subst-sh',  regex: new RegExp('(?:' + SHELL + '|(?<![\\w.\\/-])source|(?:^|[;&|(]\\s*)\\.)\\s+<\\(\\s*' + FETCH + '|(?:' + SHELL + '\\s+-c|(?<![\\w.\\/-])eval)\\s+["\']?\\$\\(\\s*' + FETCH), reason: 'running a downloaded script through process or command substitution (RCE risk)' },
  // Flag and branch in either order, within one command segment; +main is a force refspec.
  // A bare --force-with-lease never matches the (?=\s|...) after --force, so it needs no exception.
  { level: 'high', id: 'git-force-main', segment: true, regex: new RegExp(GIT + 'push\\b(?=[^;&|\\n]*' + FORCE_FLAG + ')(?=[^;&|\\n]*' + MAIN_REF + ')|' + GIT + 'push\\b[^;&|\\n]*\\s["\']?\\+(?:[^\\s:]*:)?(?:refs\\/heads\\/)?(?:main|master)(?=$|[\\s;&|"\'])'), reason: 'force push to main/master' },
  { level: 'high', id: 'git-reset-hard', regex: new RegExp(GIT + 'reset\\b[^;&|\\n]*\\s--hard\\b'),                       reason: 'git reset --hard loses uncommitted work' },
  { level: 'high', id: 'git-clean-f',    regex: new RegExp(GIT + 'clean\\s+(-\\w*f|-f)'),                                 reason: 'git clean -f deletes untracked files' },
  { level: 'high', id: 'chmod-777',      regex: /\bchmod\b.+\b777\b/,                                                     reason: 'chmod 777 is a security risk' },
  { level: 'high', id: 'docker-vol-rm',  regex: /\bdocker\s+volume\s+(rm|prune)/,                                         reason: 'docker volume deletion loses data' },

  // STRICT - Cautionary, context-dependent
  { level: 'strict', id: 'git-force-any',    segment: true, regex: new RegExp(GIT + 'push\\b(?=[^;&|\\n]*' + FORCE_FLAG + ')'), reason: 'force push (use --force-with-lease)' },
  { level: 'strict', id: 'git-checkout-dot', regex: new RegExp(GIT + 'checkout\\s+\\.'),                                     reason: 'git checkout . discards changes' },
  { level: 'strict', id: 'sudo-rm',          regex: /\bsudo\s+rm\b/,                                                       reason: 'sudo rm has elevated privileges' },
  { level: 'strict', id: 'docker-prune',     regex: /\bdocker\s+(system|image)\s+prune/,                                   reason: 'docker prune removes images' },
  { level: 'strict', id: 'crontab-r',        regex: /\bcrontab\s+-r/,                                                      reason: 'removes all cron jobs' },
];

const LEVELS = { critical: 1, high: 2, strict: 3 };
const EMOJIS = { critical: '🚨', high: '⛔', strict: '⚠️' };
const LOG_DIR = path.join(process.env.HOME || process.env.USERPROFILE || require('os').homedir(), '.claude', 'hooks-logs');

function log(data) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...data }) + '\n');
  } catch {}
}

// Separators inside quotes are argument text, not command boundaries, and an
// unquoted # starts a comment, so segment-scoped patterns run on a copy with
// quoted and escaped separators blanked and comments dropped. A quote that
// opens right after = (--push-option="x;main") is an option value: its text is
// blanked too, so it cannot pose as a ref. A quoted whole word ("main") or
// a quoted refspec side (HEAD:"main") stays.
function maskQuotedSeparators(cmd) {
  let out = '';
  let q = '';
  let blank = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === '\\' && q !== "'" && i + 1 < cmd.length) {
      const next = cmd[++i];
      out += blank || /[;&|]/.test(next) ? '__' : ch + next;
      continue;
    }
    if (q) {
      if (ch === q) { q = ''; blank = false; }
      else if (blank) { out += '_'; continue; }
      // A placeholder, not a space: "topic;main" is one ref word, not topic and main.
      else if (/[;&|]/.test(ch)) { out += '_'; continue; }
      else if (ch === '\n') { out += ' '; continue; }
    } else if (ch === '"' || ch === "'") {
      q = ch;
      blank = out[out.length - 1] === '=';
    } else if (ch === '#' && (i === 0 || /\s/.test(cmd[i - 1]))) {
      while (i + 1 < cmd.length && cmd[i + 1] !== '\n') i++;
      continue;
    }
    out += ch;
  }
  return out;
}

// Wrappers that run the next command, with the short and long flags that take
// a value. Walking words instead of matching one regex keeps this linear and
// lets any depth of wrappers (sudo env FOO=1 nice -n 5 bash) reach the shell.
const WRAPPERS = {
  sudo: ['ugCDhprtUT', ['user', 'group', 'chdir', 'prompt', 'close-from', 'role', 'type', 'other-user', 'host', 'command-timeout']],
  doas: ['uC', []],
  env: ['uCS', ['unset', 'chdir', 'split-string']],
  command: ['', []],
  exec: ['a', []],
  nohup: ['', []],
  nice: ['n', ['adjustment']],
  time: ['', []],
  timeout: ['sk', ['signal', 'kill-after']],
  stdbuf: ['ioe', ['input', 'output', 'error']],
};
const SHELL_NAME = /^(?:ba|z|da|k)?sh$/;

// The first command of a pipe stage ends at an unquoted separator or redirect.
function firstCommand(stage) {
  let q = '';
  for (let i = 0; i < stage.length; i++) {
    const ch = stage[i];
    if (ch === '\\' && q !== "'") { i++; continue; }
    if (q) { if (ch === q) q = ''; continue; }
    if (ch === '"' || ch === "'") q = ch;
    else if (/[;&<>()\n]/.test(ch)) return stage.slice(0, i);
  }
  return stage;
}

function pipesToShell(cmd) {
  const fetch = new RegExp(FETCH).exec(cmd);
  if (!fetch) return false;
  for (const raw of cmd.slice(fetch.index).split('|').slice(1)) {
    // `bash; echo`, `bash>out`, `|& bash`, `(bash)`; a quoted `FOO="a;b"` does not end it.
    const stage = firstCommand(raw.replace(/^[\s&(]+/, ''));
    const words = stage.trim().split(/\s+/).map(w => w.replace(/^["']+|["']+$/g, ''));
    let i = 0;
    while (i < words.length) {
      const name = words[i].slice(words[i].lastIndexOf('/') + 1);
      if (SHELL_NAME.test(name)) return true;
      const wrapper = Object.prototype.hasOwnProperty.call(WRAPPERS, name) ? WRAPPERS[name] : null;
      if (!wrapper) break;
      const [shortValue, longValue] = wrapper;
      i++;
      while (i < words.length) {
        const w = words[i];
        if (w === '--') { i++; break; }
        if (name === 'env' && /^[A-Za-z_]\w*=/.test(w)) { i++; continue; }
        // env -S / --split-string splits its value into more env arguments, so
        // its words are walked like the rest: env -S PATH=1 bash runs bash.
        if (name === 'env' && (w === '-S' || w === '--split-string')) { i++; continue; }
        if (name === 'env' && /^--split-string=|^-S./.test(w)) {
          words[i] = w.slice(w.startsWith('--') ? w.indexOf('=') + 1 : 2).replace(/^["']+/, '');
          continue;
        }
        if (name === 'timeout' && /^\d/.test(w)) { i++; break; }
        if (!w.startsWith('-') || w === '-') break;
        if (w.startsWith('--')) {
          i += !w.includes('=') && longValue.includes(w.slice(2)) ? 2 : 1;
          continue;
        }
        // A value flag at the end of a cluster takes the next word; -uroot carries its own.
        const letters = w.slice(1);
        const at = [...letters].findIndex(c => shortValue.includes(c));
        i += at === letters.length - 1 ? 2 : 1;
      }
    }
  }
  return false;
}

function checkCommand(cmd, safetyLevel = SAFETY_LEVEL) {
  const threshold = LEVELS[safetyLevel] || 2;
  // bash removes a backslash-newline outright, joining the two lines.
  cmd = cmd.replace(/\\\r?\n/g, '');
  const masked = maskQuotedSeparators(cmd);
  for (const p of PATTERNS) {
    if (LEVELS[p.level] <= threshold && p.regex.test(p.segment ? masked : cmd) && (!p.confirm || p.confirm(cmd))) {
      return { blocked: true, pattern: p };
    }
  }
  return { blocked: false, pattern: null };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  try {
    const data = JSON.parse(input);
    const { tool_name, tool_input, session_id, cwd, permission_mode } = data;
    if (tool_name !== 'Bash') return console.log('{}');

    const cmd = tool_input?.command || '';
    const result = checkCommand(cmd);

    if (result.blocked) {
      const p = result.pattern;
      const shouldAsk = ASK[p.level] === true;
      const decision = shouldAsk ? 'ask' : 'deny';
      log({ level: shouldAsk ? 'ASK' : 'BLOCKED', id: p.id, priority: p.level, decision, cmd, session_id, cwd, permission_mode });
      return console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: decision,
          permissionDecisionReason: `${EMOJIS[p.level]} [${p.id}] ${p.reason}`
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
  module.exports = { PATTERNS, LEVELS, SAFETY_LEVEL, ASK, checkCommand };
}
