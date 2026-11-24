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
// A value may mix quoted and plain parts (core.editor="code --wait") and
// escaped spaces (my\ repo).
const GIT_VAL = '(?:[^\\s"\'\\\\]|\\\\[\\s\\S]|"[^"]*"|\'[^\']*\')+';
const GIT_LONG_VAL = '(?:git-dir|work-tree|namespace|exec-path|super-prefix|config-env)';
const GIT = '\\bgit(?:\\s+(?:-[Cc]\\s*' + GIT_VAL + '|--' + GIT_LONG_VAL + '(?:=|\\s+)' + GIT_VAL + '|--(?!' + GIT_LONG_VAL + '\\b)[\\w-]+(?:=\\S+)?|-(?![Cc])[A-Za-z]))*\\s+';
const MAIN_REF = '(?:[\\s:"\']|refs\\/heads\\/)(?:main|master)(?=$|[\\s;&|)<>"\'])';
// A shell word, not the "sh" in a *.sh file name; optional path (/bin/bash).
// It starts only at the start of a word, so a long run of path characters is
// scanned once, not once per position.
const SHELL = '(?<![^\\s|;&()<>"\'`$])(?:[^\\s|;&()<>"\'`$]*\\/)?(?:ba|z|da|k)?sh(?![\\w.-])';
const FETCH = '(?:[^\\s|;&(]*\\/)?(?:curl|wget)\\b';
// Shell options before -c or a script argument; never a word with c in it, so
// a run of them stays linear before the -c check.
const SHELL_FLAGS = '(?:\\s+[-+][abd-zA-Z]+)*';
const SUBST = '(?:\\$\\(|`)\\s*';
// docker with global options before the subcommand (docker --context prod volume rm).
// An option that takes a value never matches the plain-flag branch, so a long
// option run stays linear.
const DOCKER_VALUE = '(?:-[cHl]|--(?:context|host|config|log-level|tlscacert|tlscert|tlskey))';
const DOCKER = '\\bdocker(?:\\s+(?:' + DOCKER_VALUE + '(?:=|\\s+)\\S+|--(?!(?:context|host|config|log-level|tlscacert|tlscert|tlskey)(?:[=\\s]|$))[\\w-]+|-(?![cHl](?:[=\\s]|$))[A-Za-z][\\w-]*))*\\s+';
// docker compose with its own options before the subcommand, so down is the
// subcommand and not a service name (docker compose run down ls -v).
const COMPOSE_VALUE = '(?:file|project-name|project-directory|env-file|profile|ansi|progress|parallel|context|host|log-level|tlscacert|tlscert|tlskey)';
const COMPOSE = '\\bdocker(?:-compose|\\s+compose)(?:\\s+(?:(?:-[fpcH]|--' + COMPOSE_VALUE + ')(?:=|\\s+)\\S+|--(?!' + COMPOSE_VALUE + '(?:[=\\s]|$))[\\w-]+(?:=\\S*)?|-(?![fpcH](?:[=\\s]|$))[A-Za-z]\\S*))*\\s+';
// chmod with its own options before the mode, so a file named 0777 is not the mode.
const CHMOD = '\\bchmod(?:\\s+(?:-[RfvchHLP]+|--(?:recursive|verbose|changes|silent|quiet|dereference|no-dereference|preserve-root|no-preserve-root)?)(?=\\s))*\\s+';
// -f alone or in a short-flag cluster (-fu, -uf, -vf). -o takes the rest of
// its word as a value, so an f after it is not a flag.
// Whole disks and partitions, including SD cards and by-id or mapper links.
const DISK = '\\/dev\\/(?:sd[a-z]|nvme|hd[a-z]|x?vd[a-z]|r?disk\\d|mmcblk\\d|disk\\/|mapper\\/)';
const FORCE_FLAG = '\\s["\']?(?:--force|-[A-Za-np-z0-9]*f[A-Za-z0-9]*)["\']?(?=\\s|$|[;&|)<>"\'])';

const PATTERNS = [
  // CRITICAL - Catastrophic, unrecoverable
  // A trailing /. or /.. (~/., /Users/alice/..) still names the home directory or above;
  // a /* (~/*) or a doubled slash (~//) still deletes everything in it.
  { level: 'critical', id: 'rm-home',          regex: /\brm\s+(?:-.+\s)?["']?~(\/(\.{1,2}|\*+)?)*["']?(\s|$|[;&|)<>])/,             reason: 'rm targeting home directory' },
  { level: 'critical', id: 'rm-home-var',      regex: /\brm\s+(?:-.+\s)?["']?\$(HOME|\{HOME\})(\/(\.{1,2}|\*+)?)*["']?(\s|$|[;&|)<>])/, reason: 'rm targeting $HOME' },
  { level: 'critical', id: 'rm-home-trailing', regex: /\brm\s.*\s["']?(~|\$(HOME|\{HOME\}))(\/(\.{1,2}|\*+)?)*["']?(\s*$|[;&|)<>])/, reason: 'rm with trailing ~/ or $HOME' },
  { level: 'critical', id: 'rm-home-abs',      regex: /\brm\s+(?:-.+\s)?["']?\/(home|Users)(\/[^\/\s"';&|]+)?(\/(\.{1,2}|\*+)?)*["']?(\s|$|[;&|)<>])/, reason: 'rm targeting a home directory by absolute path' },
  { level: 'critical', id: 'rm-root',          regex: /\brm\s+(?:-.+\s)?\/+(\*|\s|$|[;&|)<>])/,                               reason: 'rm targeting root filesystem' },
  { level: 'critical', id: 'rm-system',        regex: /\brm\s+(?:-.+\s)?\/(etc|usr|var|bin|sbin|lib|boot|dev|proc|sys)(\/|\s|$|[;&|)<>])/, reason: 'rm targeting system directory' },
  // Only a glob that matches every name: stars with at most one ? (*, **, ?*, *?). ??* skips one-letter names.
  { level: 'critical', id: 'rm-cwd',           regex: /\brm\s+(?:-.+\s)?(\.\/?|(\.\/)?(?:\*+(?:\?\**)?|\?\*+))(\s|$|[;&|)<>])/,          reason: 'rm deleting current directory contents' },
  { level: 'critical', id: 'rm-parent',        regex: /\brm\s+(?:-.+\s)?["']?([^\s"';&|]*\/)?\.\.(\/\.{1,2})*\/?(\*)?["']?(\s|$|[;&|)<>])/, reason: 'rm of a path ending in .. deletes a parent directory' },
  { level: 'critical', id: 'dd-disk',          regex: new RegExp('\\bdd\\b.+of=' + DISK),                                                     reason: 'dd writing to disk device' },
  { level: 'critical', id: 'mkfs',             regex: new RegExp('\\bmkfs(?:\\.\\w+)?\\b(?:[^;&|\\n<>]|[<>]&?|&>)*\\s' + DISK), confirm: mkfsWrites,          reason: 'mkfs formatting disk' },
  // A function of any name that pipes itself into itself in the background.
  // Quoted text and comments in the body are skipped whole, so a message or a
  // note that spells the name (echo ' build | build &') is not a call. The classic :(){ ... } spelling is
  // refused as it always was.
  { level: 'critical', id: 'fork-bomb',        regex: /(?<![^\s;&|({])([^\s;&|(){}<>]+)\s*\(\)\s*\{(?:\\[\s\S]|[^{}'"\\#]|(?<![^\s;&|{(])(?=(#[^\n]*))\2|(?<=[^\s;&|{(])#|'[^']*'|"(?:\\[\s\S]|[^"\\])*")*(?<![^\s;&|{])\1\s*\|\s*\1\s*&|:\(\)\s*\{.*:\s*\|\s*:.*&/, reason: 'fork bomb detected' },

  // HIGH - Significant risk, data loss, security
  // The regex finds a fetch piped somewhere; pipesToShell walks the stages.
  { level: 'high', id: 'curl-pipe-sh',   regex: new RegExp(FETCH + '.*\\|'), confirm: (t) => pipesToShell(t) || pipesToInterpreter(t),                    reason: 'piping URL to shell (RCE risk)' },
  // Shell flags may come first (bash -x <(curl ...), bash -lc "$(curl ...)"); the
  // download may arrive as a file, on stdin (< <(...), <<< "$(...)") or as -c
  // text, in $(...) or backticks.
  { level: 'high', id: 'curl-subst-sh',  regex: new RegExp('(?:' + SHELL + SHELL_FLAGS + '|(?<![\\w.\\/-])source|(?:^|[;&|(]\\s*)\\.)\\s+(?:<\\s*)?<\\(\\s*' + FETCH + '|' + SHELL + SHELL_FLAGS + '\\s+<<<\\s*["\']?' + SUBST + FETCH + '|(?:' + SHELL + SHELL_FLAGS + '\\s+-[A-Za-z]*c[A-Za-z]*|(?<![\\w.\\/-])eval)\\s+["\']?' + SUBST + FETCH), reason: 'running a downloaded script through process or command substitution (RCE risk)' },
  // Flag and branch in either order, within one command segment; +main is a force refspec.
  // A bare --force-with-lease never matches the (?=\s|...) after --force, so it needs no exception.
  { level: 'high', id: 'git-force-main', segment: true, regex: new RegExp(GIT + 'push\\b(?=[^;&|\\n]*' + FORCE_FLAG + ')(?=[^;&|\\n]*' + MAIN_REF + ')|' + GIT + 'push\\b[^;&|\\n]*\\s["\']?\\+(?:[^\\s:]*:)?(?:refs\\/heads\\/)?(?:main|master)(?=$|[\\s;&|)<>"\'])'), reason: 'force push to main/master' },
  { level: 'high', id: 'git-reset-hard', regex: new RegExp(GIT + 'reset\\b[^;&|\\n]*\\s--h(?:a(?:rd?)?)?(?![\\w-])'),     reason: 'git reset --hard loses uncommitted work' },
  { level: 'high', id: 'git-clean-f',    regex: new RegExp(GIT + 'clean\\s+(-\\w*f|-f)|' + GIT + 'clean\\b(?:[^;&|\\n<>]|[<>]&?|&>)*\\s["\']?(?:--f(?:o(?:r(?:ce?)?)?)?(?![\\w-])|-[A-Za-df-z]*f)'), confirm: (t) => cleanForces(t), reason: 'git clean -f deletes untracked files' },
  // 777 with a leading 0 or a special bit (0777, 1777), or rwx for everyone spelled symbolically (a+rwx), as the mode.
  { level: 'high', id: 'chmod-777',      regex: new RegExp('\\bchmod\\b.+\\b777\\b|' + CHMOD + '["\']?(?:0*[1-7]?777|(?:a|ugo|uog|gou|guo|ogu|oug)[+=](?=[rwxXst]*r)(?=[rwxXst]*w)(?=[rwxXst]*x)[rwxXst]+)["\']?(?=\\s|$|[;&|)<>])'), reason: 'chmod 777 is a security risk' },
  // docker volume rm|remove|prune after global options, compose down -v, system prune --volumes.
  { level: 'high', id: 'docker-vol-rm',  regex: new RegExp(DOCKER + '(?:volume\\s+(?:rm|remove|prune)\\b|system\\s+prune\\b[^;&|\\n]*\\s--volumes(?![\\w-]))|' + COMPOSE + 'down(?![\\w-])(?=[^;&|\\n]*\\s(?:-[A-Za-z]*v[A-Za-z]*|--volumes)(?![\\w-]))'), reason: 'docker volume deletion loses data' },

  // STRICT - Cautionary, context-dependent
  // A +ref refspec force-pushes that ref like --force does; pushForces reads
  // the push options so the value of -o or --push-option (-o +build) is not a refspec.
  { level: 'strict', id: 'git-force-any',    segment: true, regex: new RegExp(GIT + 'push\\b(?=[^;&|\\n]*' + FORCE_FLAG + ')|' + GIT + 'push\\b[^;&|\\n]*\\s["\']?\\+[^\\s;&|]'), confirm: (t) => pushForces(t), reason: 'force push (use --force-with-lease)' },
  { level: 'strict', id: 'git-checkout-dot', regex: new RegExp(GIT + 'checkout\\s+\\.'),                                     reason: 'git checkout . discards changes' },
  { level: 'strict', id: 'sudo-rm',          regex: /\bsudo\s+rm\b|\bsudo\b(?:[^;&|\n<>]|[<>]&?|&>)*\brm\b/, confirm: (t) => /\bsudo\s+rm\b/.test(t) || sudoRunsRm(t), reason: 'sudo rm has elevated privileges' },
  { level: 'strict', id: 'docker-prune',     regex: /\bdocker\s+(system|image|container|builder|buildx|network)\s+prune/,      reason: 'docker prune removes unused images, containers, networks or build cache' },
  { level: 'strict', id: 'crontab-r',        regex: /\bcrontab\s+-r/,                                                      reason: 'removes all cron jobs' },
];

// The glob forms of the rm rules (~/*, ?*) read a * or ? as a glob, but one
// that rm gets inside quotes or after a backslash is a literal character:
// rm -f '??*' and rm -rf "$HOME/*" each name one file. The rendered view drops
// quotes, so a line with such a character is judged twice: the glob forms on a
// copy with it blanked, and the forms without a glob on the views as read.
for (const p of PATTERNS) {
  if (p.regex.source.includes('|\\*+)')) p.plain = new RegExp(p.regex.source.replace('|\\*+)', ')'), p.regex.flags);
}
PATTERNS.find((p) => p.id === 'rm-cwd').plain = /\brm\s+(?:-.+\s)?(\.\/?|\*|\.\/\*)(\s|$|[;&|)<>])/;

// A ) < or > after a target is an operator only outside quotes: rm -f '$HOME>bak'
// names one file, and so does rm -f "$b" when b holds that text. On a line with
// quotes or escapes every view reads the target as ending only at a space,
// ; & | or the end; the rendered view of that line sets every real operator
// apart with spaces, so a quoted target before a real ) or > is still caught.
for (const p of PATTERNS) {
  if (!/^(?:rm-|git-force-)/.test(p.id)) continue;
  if (p.regex.source.includes(')<>')) p.quoted = new RegExp(p.regex.source.split(')<>').join(''), p.regex.flags);
  if (p.plain && p.plain.source.includes(')<>')) p.plainQuoted = new RegExp(p.plain.source.split(')<>').join(''), p.plain.flags);
}

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

// >>> shell-reading: kept identical in block-dangerous-commands, git-safety and
// protect-secrets; tests/shell-reading.test.js pins the three copies.

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

const SHELL_NAME = /^(?:ba|z|da|k)?sh$/;
// Readers that never run what arrives on stdin (not sort: --compress-program runs one).
const DATA_READERS = new Set(['cat', 'tee', 'head', 'tail', 'wc', 'uniq', 'tr', 'cut', 'nl', 'fold']);
const KEYWORDS = new Set(['!', '{', '}', '(', ')', 'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'select', 'time', 'export', 'local', 'declare', 'typeset', 'readonly']);
const OPENERS = new Set(['{', 'if', 'for', 'while', 'until', 'select', 'case']);
const CLOSERS = new Set(['}', 'fi', 'done', 'esac']);
// The mention exceptions hold only for a line in which no command can make the
// dropped text run. Every command must be one of these, which run nothing they
// are handed: the readers above, the commands below, and the git and gh calls
// below. git runs hooks (commit, push, ref and index updates all can, from any
// directory core.hooksPath names), so a line with git or gh pr must not write,
// copy, move, link, delete or chmod any file, since that file could be a hook.
// No line may write to a path a shell, git or the system runs, or write after
// cd or pushd, which hides the real path from that check.
const INERT = new Set(['cd', 'pushd', 'popd', 'pwd', 'ls', 'mkdir', 'true', 'false', ':', 'test', '[', 'sleep', 'date', 'grep', 'echo', 'printf']);
const WRITERS = new Set(['tee', 'cp', 'mv', 'ln', 'rm', 'touch', 'chmod']);
const GIT_INERT = /^(?:add|status|diff|log|show|commit|branch|switch|checkout|restore|stash|rm|mv|tag|push|fetch|pull)$/;
const GIT_INERT_GLOBALS = new Set(['-C', '-P', '--no-pager']);
const GIT_RUNS = /^--?(?:upload-pack|receive-pack|exec|ext-diff|textconv)\b/;
const WRITE_REDIRECT = new Set(['>', '>>', '>|', '&>', '&>>', '<>', '>&']);
const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);
const SAFE_TARGET = /^(?:\/dev\/(?:null|stdout|stderr)|[12]|-)$/;
// Paths a shell, git or the system runs.
const SCRIPT_FILE = /(?:^|\/)(?:\.git\/(?:hooks\/[^/]+|config)|\.?(?:husky|githooks)\/[^/]+|\.gitconfig|\.(?:bash|zsh|ksh|csh|tcsh)rc|\.(?:bash_)?profile|\.bash_login|\.z(?:profile|shenv|login))$|^\/etc\/|cron|Launch(?:Agents|Daemons)\/|systemd\/|\.(?:sh|bash|zsh|ksh|command)$/;
const REDIRECT = /^\d*(?:<<<|<<-|<<|&>>|&>|>>|>\||>&|<&|<>|<|>)/;
const ANSI = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
const MAX_DEPTH = 6;

// Reads a command line the way bash splits it: words with their quotes
// removed, operators, redirects, heredoc bodies, and each command
// substitution as a nested frame. It never runs anything. sure is false when
// the text is not plain enough to read with certainty (an open quote, an
// unmatched paren, a function definition, nesting past MAX_DEPTH).
function readShell(src) {
  const frames = [];
  const heredocs = [];
  let pending = [];
  let sure = true;
  let i = 0;
  const n = src.length;

  const readBodies = () => {
    for (const h of pending) {
      h.bodyStart = i;
      h.bodyEnd = -1;
      while (i < n) {
        const eol = src.indexOf('\n', i);
        const next = eol === -1 ? n : eol + 1;
        let line = src.slice(i, eol === -1 ? n : eol);
        if (h.dash) line = line.replace(/^\t+/, '');
        if (line === h.delim) { h.bodyEnd = i; i = next; break; }
        i = next;
      }
      if (h.bodyEnd < 0) { h.bodyEnd = n; sure = false; }
    }
    pending = [];
  };

  // The raw text of a balanced ${...} or $((...)).
  const balanced = (open, close) => {
    const start = i;
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === open) depth++;
      else if (c === close && --depth === 0) return src.slice(start, ++i);
      i++;
    }
    sure = false;
    return src.slice(start);
  };

  function readWord(depth, cmd, tick) {
    const w = { start: i, value: '', lead: '', parts: [], spans: [], dynamic: false, frames: [] };
    const push = (s) => {
      if (typeof w.parts[w.parts.length - 1] === 'string') w.parts[w.parts.length - 1] += s;
      else w.parts.push(s);
    };
    const text = (s, quoted) => {
      if (!quoted && !w.spans.length && !w.dynamic) w.lead += s;
      if (quoted && /\s/.test(s)) w.prose = true;
      w.value += s;
      push(quoted ? s.replace(/[\s;&|<>()'"`\\#$]/g, '_') : s);
    };
    const raw = (s) => { w.value += s; push(s); w.dynamic = true; };
    const nested = (close, kind, open) => {
      w.dynamic = true;
      if (depth >= MAX_DEPTH) { sure = false; raw(open + src.slice(i)); i = n; return; }
      const from = i;
      const f = parseFrame(kind, close, depth + 1, { cmd, word: w });
      w.value += open + src.slice(from, Math.max(from, i - 1)) + close;
      w.parts.push({ frame: f, open, close, from, to: Math.max(from, i - 1) });
      w.frames.push(f);
    };
    const dollar = (quoted) => {
      const c = src[i + 1];
      if (c === '(' && src[i + 2] === '(') { i++; raw('$' + balanced('(', ')')); return; }
      if (c === '(') { i += 2; nested(')', 'subst', '$('); return; }
      if (c === '{') { i++; raw('$' + balanced('{', '}')); return; }
      const m = /^\$(?:[A-Za-z_]\w*|[0-9@*#?$!-])/.exec(src.slice(i, i + 64));
      if (m) { i += m[0].length; raw(m[0]); return; }
      i++;
      text('$', quoted);
    };
    while (i < n) {
      const c = src[i];
      if ((c === '<' || c === '>') && src[i + 1] === '(' && !w.parts.length) { i += 2; nested(')', 'proc', c + '('); continue; }
      if (/[ \t\r\n;&|<>()]/.test(c) || (tick && c === '`')) break;
      if (c === '\\') {
        if (src[i + 1] === '\n') { i += 2; continue; }
        if (i + 1 < n) { const e = src[i + 1]; w.spans.push({ start: i, end: i + 2, kind: 'esc' }); i += 2; text(e, !/[\w.\/~:@%+,=-]/.test(e)); continue; }
        i++;
        continue;
      }
      if (c === "'") {
        const e = src.indexOf("'", i + 1);
        const end = e < 0 ? n : e;
        if (e < 0) sure = false;
        w.spans.push({ start: i + 1, end, kind: 'sq' });
        text(src.slice(i + 1, end), true);
        i = end + 1;
        continue;
      }
      if (c === '$' && src[i + 1] === "'") {
        let j = i + 2;
        let s = '';
        while (j < n && src[j] !== "'") {
          if (src[j] === '\\' && j + 1 < n) {
            const e = src[j + 1];
            const num = /^(?:x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|U([0-9A-Fa-f]{1,8})|([0-7]{1,3}))/.exec(src.slice(j + 1, j + 10));
            if (num) {
              const code = num[4] !== undefined ? parseInt(num[4], 8) : parseInt(num[1] || num[2] || num[3], 16);
              if (code <= 0x10ffff) s += String.fromCodePoint(code);
              j += 1 + num[0].length;
            } else if (e === 'c' && j + 2 < n) { s += String.fromCharCode(src.charCodeAt(j + 2) & 31); j += 3; }
            else { s += ANSI[e] || e; j += 2; }
            continue;
          }
          s += src[j++];
        }
        if (j >= n) sure = false;
        w.spans.push({ start: i + 2, end: j, kind: 'ansi' });
        text(s, true);
        i = j + 1;
        continue;
      }
      if (c === '"' || (c === '$' && src[i + 1] === '"')) {
        i += c === '$' ? 2 : 1;
        const span = { start: i, end: n, kind: 'dq', exp: false };
        w.spans.push(span);
        while (i < n && src[i] !== '"') {
          const d = src[i];
          if (d === '\\' && i + 1 < n && '$`"\\\n'.includes(src[i + 1])) {
            if (src[i + 1] !== '\n') text(src[i + 1], true);
            i += 2;
            continue;
          }
          if (d === '$' && /[({A-Za-z_0-9@*#?$!-]/.test(src[i + 1] || '')) { span.exp = true; dollar(true); continue; }
          if (d === '`') { span.exp = true; i++; nested('`', 'subst', '`'); continue; }
          text(d, true);
          i++;
        }
        if (i >= n) sure = false;
        span.end = i++;
        continue;
      }
      if (c === '$') { dollar(false); continue; }
      if (c === '`') { i++; nested('`', 'subst', '`'); continue; }
      text(c, false);
      i++;
    }
    w.end = i;
    return w;
  }

  function parseFrame(kind, close, depth, parent) {
    const frame = { kind, parent, cmds: [] };
    frames.push(frame);
    let cmd = null;
    let group = 0;
    let head = true;
    const start = () => cmd || (cmd = { words: [], op: '', group, frame, index: frame.cmds.length });
    const end = (op) => {
      head = true;
      if (cmd) { cmd.op = op; frame.cmds.push(cmd); cmd = null; } else if (op && op !== '\n') sure = false;
    };
    const op = (t) => start().words.push({ op: t, value: t, lead: t, parts: [t], spans: [], frames: [] });
    while (i < n) {
      const c = src[i];
      if (close && c === close && (close === '`' || group === 0)) { i++; end(''); return frame; }
      if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
      if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
      if (c === '\n') { i++; end('\n'); if (pending.length) readBodies(); continue; }
      if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === ';') { const t = /^;(?:;&|;|&)?/.exec(src.slice(i, i + 3))[0]; i += t.length; end(t); continue; }
      if (c === '|') { const t = /^\|[|&]?/.exec(src.slice(i, i + 2))[0]; i += t.length; end(t); continue; }
      if (c === '&' && src[i + 1] !== '>') { const t = src[i + 1] === '&' ? '&&' : '&'; i += t.length; end(t); continue; }
      if (c === '(') {
        if (!head) sure = false;
        group++;
        i++;
        op('(');
        start().group = group;
        continue;
      }
      if (c === ')') { i++; if (group > 0) group--; else sure = false; op(')'); continue; }
      const redirect = src[i + 1] === '(' ? null : REDIRECT.exec(src.slice(i, i + 8));
      if (redirect && (c !== '&' || src[i + 1] === '>')) {
        i += redirect[0].length;
        const cur = start();
        const t = redirect[0].replace(/^\d+/, '');
        op(t);
        while (src[i] === ' ' || src[i] === '\t') i++;
        if (i >= n || /[;&|<>()\n]/.test(src[i])) continue;
        const target = readWord(depth, cur, close === '`');
        target.target = t;
        cur.words.push(target);
        if (t === '<<' || t === '<<-') {
          const h = { cmd: cur, frame, dash: t === '<<-', delim: target.value, quoted: target.spans.length > 0 };
          heredocs.push(h);
          pending.push(h);
        }
        continue;
      }
      const cur = start();
      const w = readWord(depth, cur, close === '`');
      if (w.start === w.end) {
        sure = false;
        i = n;
        break;
      }
      cur.words.push(w);
      if (head && !w.spans.length && !w.dynamic) {
        if (OPENERS.has(w.value)) cur.group = ++group;
        else if (CLOSERS.has(w.value) && group > 0) group--;
      }
      head = head && !w.spans.length && KEYWORDS.has(w.value);
    }
    if (close) sure = false;
    end('');
    return frame;
  }

  const top = parseFrame('top', '', 0, null);
  if (pending.length) sure = false;
  return { top, frames, heredocs, sure };
}

const base = (s) => s.slice(s.lastIndexOf('/') + 1);
const argv = (cmd) => cmd.words.filter(w => !w.op && !w.target);

// The command word: past keywords, grouping and assignments.
function commandIndex(words) {
  let k = 0;
  while (k < words.length && ((!words[k].spans.length && KEYWORDS.has(words[k].value)) || /^[A-Za-z_]\w*\+?=/.test(words[k].lead || ''))) k++;
  return k;
}

// Index of the first argument whose quoted text is a message, or -1.
function textArgsFrom(cmd) {
  const words = argv(cmd);
  const k = commandIndex(words);
  const w = words[k];
  if (!w || w.dynamic) return -1;
  if (w.value === 'echo') return k + 1;
  if (w.value === 'printf') return words.some(x => /^-v/.test(x.value)) ? -1 : k + 1;
  if (w.value === 'gh') return /^(?:pr|issue)$/.test(words[k + 1]?.value) && /^(?:create|edit|comment)$/.test(words[k + 2]?.value) ? k + 3 : -1;
  if (w.value !== 'git') return -1;
  let j = k + 1;
  while (j < words.length && words[j].value.startsWith('-')) j += GIT_VALUE_OPTS.has(words[j].value) ? 2 : 1;
  return words[j]?.value === 'commit' ? j + 1 : -1;
}

function readsAsData(cmd) {
  const words = argv(cmd);
  const w = words[commandIndex(words)];
  return !!w && !w.dynamic && (DATA_READERS.has(w.value) || textArgsFrom(cmd) >= 0);
}

// Every later stage of this command's pipeline only reads data.
function pipesToData(cmd) {
  const cmds = cmd.frame.cmds;
  for (let k = cmd.index; cmds[k] && (cmds[k].op === '|' || cmds[k].op === '|&'); k++) {
    if (!cmds[k + 1] || cmds[k + 1].group || !readsAsData(cmds[k + 1])) return false;
  }
  return true;
}

// Output of this frame ends up as data: the top level, or a substitution that
// is an argument of a message command whose own output is data.
function frameIsData(frame) {
  for (let f = frame; f.parent; f = f.parent.cmd.frame) {
    const { cmd, word } = f.parent;
    const words = argv(cmd);
    if (f.kind !== 'subst' || cmd.group || textArgsFrom(cmd) < 0 || words.indexOf(word) <= commandIndex(words) || !pipesToData(cmd)) return false;
  }
  return true;
}

const scriptPath = (v) => SCRIPT_FILE.test(v.replace(/\/(?:\.\/)+/g, '/').replace(/\/{2,}/g, '/'));

// { runs, writes, git } for one command; runs is true unless it is one of the
// commands above.
function effects(cmd) {
  const words = argv(cmd);
  const k = commandIndex(words);
  const writes = cmd.words.some(w => w.target && WRITE_REDIRECT.has(w.target) && !SAFE_TARGET.test(w.value));
  const ran = { runs: true, writes, git: false };
  if (words.slice(0, k).some(w => /^[A-Za-z_]\w*\+?=/.test(w.lead))) return ran;
  const w = words[k];
  if (!w) return { runs: false, writes, git: false };
  if (w.dynamic || w.spans.length) return ran;
  if (INERT.has(w.value) || DATA_READERS.has(w.value)) return { runs: false, writes: writes || w.value === 'tee', git: false };
  if (WRITERS.has(w.value)) return { runs: false, writes: true, git: false };
  if (w.value === 'gh') return /^(?:pr|issue|api)$/.test(words[k + 1]?.value || '') ? { runs: false, writes, git: words[k + 1].value === 'pr' } : ran;
  if (w.value !== 'git') return ran;
  let j = k + 1;
  while (j < words.length && words[j].value.startsWith('-')) {
    if (!GIT_INERT_GLOBALS.has(words[j].value)) return ran;
    j += words[j].value === '-C' ? 2 : 1;
  }
  if (!GIT_INERT.test(words[j]?.value || '') || words.slice(j + 1).some(x => GIT_RUNS.test(x.value))) return ran;
  return { runs: false, writes, git: true };
}

function lineIsPlain(read) {
  if (!read.sure) return false;
  let writes = false;
  let git = false;
  let moves = false;
  for (const f of read.frames) {
    if (f.kind === 'proc') return false;
    for (const cmd of f.cmds) {
      const e = effects(cmd);
      if (e.runs || (e.writes && cmd.words.some(w => scriptPath(w.value)))) return false;
      const words = argv(cmd);
      moves = moves || /^(?:cd|pushd|popd)$/.test(words[commandIndex(words)]?.value || '');
      writes = writes || e.writes;
      git = git || e.git;
    }
  }
  return !(writes && (git || moves));
}

// The command with text that only mentions commands taken out: the body of a
// heredoc fed to a reader that never runs it, and the quoted text of echo,
// printf, git commit and gh pr/issue create|edit|comment, on a line where no
// command can make them run (see INERT). A pipe into a program, echo into a
// file and a substitution used as the command keep their text too.
function dropMentions(cmd, read = readShell(cmd)) {
  if (!lineIsPlain(read)) return cmd;
  const cuts = [];
  for (const h of read.heredocs) {
    if (!h.quoted && /[$`\\]/.test(cmd.slice(h.bodyStart, h.bodyEnd))) continue;
    if (h.cmd.group || !readsAsData(h.cmd) || !pipesToData(h.cmd) || !frameIsData(h.frame)) continue;
    cuts.push([h.bodyStart, h.bodyEnd]);
  }
  for (const f of read.frames) {
    if (!frameIsData(f)) continue;
    for (const c of f.cmds) {
      const from = textArgsFrom(c);
      if (from < 0 || c.group || !pipesToData(c) || c.words.some(w => w.frames.length)) continue;
      const words = argv(c);
      const name = words[commandIndex(words)].value;
      if ((name === 'echo' || name === 'printf') && (c.op === '|' || c.op === '|&' || c.words.some(w => w.target && !SAFE_TARGET.test(w.value)))) continue;
      for (const w of words.slice(from)) {
        for (const s of w.spans) if (s.kind !== 'esc' && !s.exp) cuts.push([s.start, s.end]);
      }
    }
  }
  if (!cuts.length) return cmd;
  cuts.sort((a, b) => a[0] - b[0]);
  let out = '';
  let at = 0;
  for (const [s, e] of cuts) if (s >= at) { out += cmd.slice(at, s); at = e; }
  return out + cmd.slice(at);
}

// The words as bash will see them: quotes removed ("push", r''m, .e"nv",
// $'\x72m'), $name replaced by a value assigned earlier in the line, each
// substitution (in a word or an unquoted heredoc body) on a line of its own
// with $() left in its place, and the program given to sh -c, eval or a heredoc fed to a shell read
// the same way. A word whose quotes hold
// a space is prose (a prompt, a message) and stays as typed, so the patterns
// treat it as they always have.
function renderShell(src, depth = 0) {
  const read = readShell(src);
  const vars = new Map();
  const programs = [];
  const sub = (s) => s.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (m, name) => (vars.has(name) ? vars.get(name) : m));
  const word = (w) => {
    if (!w.prose) return w.parts.map(p => (typeof p === 'string' ? sub(p) : p.open + p.close)).join('');
    let out = '';
    let at = w.start;
    for (const p of w.parts) if (p.frame) { out += src.slice(at, p.from); at = p.to; }
    return out + src.slice(at, w.end);
  };
  function frame(f) {
    let out = '';
    for (const cmd of f.cmds) {
      const words = argv(cmd);
      const k = commandIndex(words);
      for (const w of words.slice(0, k)) {
        const m = /^([A-Za-z_]\w*)\+?=([\s\S]*)$/.exec(w.value);
        if (m) vars.set(m[1], sub(m[2]));
      }
      out += cmd.words.map(word).join(' ') + (cmd.op && cmd.op !== '\n' ? ' ' + cmd.op + ' ' : '\n');
      if (depth >= 2) continue;
      for (let j = 0; j < words.length; j++) {
        if (!SHELL_NAME.test(base(words[j].value))) continue;
        let m = j + 1;
        while (m < words.length && /^[-+][A-Za-z]+$/.test(words[m].value) && !words[m].value.includes('c')) m++;
        if (/^-[A-Za-z]*c[A-Za-z]*$/.test(words[m]?.value || '') && words[m + 1]) programs.push(words[m + 1].value);
      }
      if (words[k]?.value === 'eval') programs.push(words.slice(k + 1).map(w => w.value).join(' '));
    }
    return out;
  }
  let out = '';
  for (const f of read.frames) out += frame(f);
  for (const h of read.heredocs) {
    const words = argv(h.cmd);
    const body = src.slice(h.bodyStart, h.bodyEnd);
    if (depth >= 2) continue;
    if (SHELL_NAME.test(base(words[commandIndex(words)]?.value || ''))) programs.push(body);
    // An unquoted body expands like a double-quoted string, so its $(...) runs.
    else if (!h.quoted && /[$`]/.test(body)) programs.push('"' + body.replace(/"/g, '\\"') + '"');
  }
  for (const p of programs) out += renderShell(p, depth + 1);
  return out;
}

// What the patterns read: the command with mentions dropped, plus, when it has
// quotes, escapes or expansions, the same command as bash will split it. Each
// view carries a masked copy for segment-scoped patterns.
function shellViews(cmd) {
  if (!/['"\\$`]|<</.test(cmd)) return [{ text: cmd, masked: maskQuotedSeparators(cmd) }];
  const text = dropMentions(cmd);
  const views = [{ text, masked: maskQuotedSeparators(text) }];
  if (/['"\\$`]/.test(text)) {
    const words = renderShell(text);
    if (words.trim() !== text.trim()) views.push({ text: words, masked: maskQuotedSeparators(words) });
  }
  return views;
}
// <<< shell-reading

// Shells that run a script read on stdin. Wider than SHELL_NAME in the shared
// reader, which only decides which -c programs it reads.
const PIPE_SHELL = /^(?:ba|z|da|k|mk|a|c|tc|fi|y)?sh$/;

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
  setsid: ['', []],
  unbuffer: ['', []],
  busybox: ['', []],
};
// Shell words with quotes removed: "type your password" is one word.
function shellWords(text) {
  const words = [];
  let word = null;
  let q = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!q && /\s/.test(ch)) { if (word !== null) words.push(word); word = null; continue; }
    if (word === null) word = '';
    if (ch === '\\' && q !== "'" && i + 1 < text.length) { word += text[++i]; continue; }
    if (q) { if (ch === q) q = ''; else word += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    word += ch;
  }
  if (word !== null) words.push(word);
  return words;
}

// The first command of a pipe stage ends at an unquoted separator or redirect.
function firstCommand(stage) {
  let q = '';
  for (let i = 0; i < stage.length; i++) {
    const ch = stage[i];
    if (ch === '\\' && q !== "'") { i++; continue; }
    if (q) { if (ch === q) q = ''; continue; }
    if (ch === '"' || ch === "'") q = ch;
    else if (/[<>]/.test(ch)) return stage.slice(0, i).replace(/(^|\s)\d+$/, '$1');
    else if (/[;&()\n]/.test(ch)) return stage.slice(0, i);
  }
  return stage;
}

const COMPOUND = /^(?:[({!]|(?:if|while|until|for|select|case)(?=\s|$))/;

// The commands of one pipe stage that read the pipe: the first one, or every
// command of a compound stage ({ ...; }, ( ... ), if, while) up to the close
// that ends it. A command after that close (curl x | (cat) && bash y) runs
// after the pipeline and does not read it. Each opener waits for its own
// closer ({ if ...; fi; bash; } still reads the pipe at bash), and in a case
// body ) ends a pattern. A closer that matches nothing leaves the stage open
// to its end, so every later command still counts.
const OPENERS_OF = { '}': ['{'], fi: ['if'], done: ['while', 'until', 'for', 'select'], esac: ['case'] };
const STAGE_OPENER = /^(?:\{|if|while|until|for|select|case)$/;
const STAGE_PREFIX = /^(?:then|do|else|elif|!|time)$/;
function stageCommands(stage) {
  const head = stage.replace(/^[\s&]+/, '');
  if (!COMPOUND.test(head)) return [firstCommand(head)];
  const out = [];
  const open = [];
  let lost = false;
  let q = '';
  let start = 0;
  for (let i = 0; i <= head.length; i++) {
    const ch = head[i];
    if (i < head.length) {
      if (ch === '\\' && q !== "'") { i++; continue; }
      if (q) { if (ch === q) q = ''; continue; }
      if (ch === '"' || ch === "'") { q = ch; continue; }
      if (!/[;&()\n]/.test(ch)) continue;
    }
    const segment = head.slice(start, i);
    for (const word of segment.trim().split(/\s+/)) {
      if (STAGE_OPENER.test(word)) open.push(word);
      else if (Object.prototype.hasOwnProperty.call(OPENERS_OF, word)) {
        if (OPENERS_OF[word].includes(open[open.length - 1])) open.pop();
        else lost = true;
      } else if (!STAGE_PREFIX.test(word)) break;
    }
    out.push(firstCommand(segment));
    if (ch === '(') open.push('(');
    else if (ch === ')' && open[open.length - 1] !== 'case') {
      if (open[open.length - 1] === '(') open.pop();
      else lost = true;
    }
    start = i + 1;
    if (!open.length && !lost) break;
  }
  return out;
}

// Interpreters that run a program read on stdin when they get no script and
// no code option (python3, perl, node, curl ... | python3 -). Per interpreter:
// short options that carry the program (code), ones that only print or check
// and exit (exit; perl -c is not one, since it runs BEGIN blocks), ones that
// take a value in the rest of their word or the next word (value), ones that
// take only the rest of their word (attached), and long options of each kind.
// node's long options that take a separate value (node --max-http-header-size 16384 app.js).
const NODE_VALUE = ['require', 'import', 'loader', 'experimental-loader', 'input-type', 'conditions', 'env-file', 'env-file-if-exists', 'title',
  'max-http-header-size', 'max-old-space-size', 'max-semi-space-size', 'stack-size', 'stack-trace-limit', 'inspect-port', 'debug-port',
  'icu-data-dir', 'openssl-config', 'tls-cipher-list', 'tls-keylog', 'tls-min-v1.0', 'diagnostic-dir', 'report-dir', 'report-directory',
  'report-filename', 'report-signal', 'heapsnapshot-signal', 'heapsnapshot-near-heap-limit', 'secure-heap', 'secure-heap-min',
  'unhandled-rejections', 'dns-result-order', 'disable-proto', 'disable-warning', 'redirect-warnings', 'trace-event-categories',
  'trace-event-file-pattern', 'cpu-prof-dir', 'cpu-prof-name', 'cpu-prof-interval', 'heap-prof-dir', 'heap-prof-name', 'heap-prof-interval',
  'policy-integrity', 'experimental-policy', 'experimental-sea-config', 'experimental-default-type', 'watch-path', 'test-name-pattern',
  'test-skip-pattern', 'test-reporter', 'test-reporter-destination', 'test-shard', 'test-timeout', 'test-concurrency',
  'test-coverage-include', 'test-coverage-exclude', 'test-coverage-branches', 'test-coverage-functions', 'test-coverage-lines',
  'snapshot-blob', 'localstorage-file', 'run', 'use-largepages', 'network-family-autoselection-attempt-timeout', 'experimental-config-file'];
const INTERPRETERS = [
  [/^(?:python|pypy)(?:\d+(?:\.\d+)*)?$/, { code: 'cm', exit: 'hV', value: 'WX', attached: '', longCode: ['help', 'help-all', 'help-env', 'help-xoptions', 'version'], longValue: ['check-hash-based-pycs'] }],
  [/^(?:node|nodejs)$/, { code: 'ep', exit: 'hvc', value: 'rC', attached: '', longCode: ['eval', 'print', 'help', 'version', 'check', 'v8-options'], longValue: NODE_VALUE }],
  [/^perl(?:\d+(?:\.\d+)*)?$/, { code: 'eE', exit: 'hvV', value: 'I', attached: 'MmxlC0idD', longCode: ['help', 'version'], longValue: [] }],
  [/^ruby(?:\d+(?:\.\d+)*)?$/, { code: 'e', exit: 'hvc', value: 'rICE', attached: 'xF0KTW', longCode: ['help', 'version'], longValue: [] }],
  [/^irb$/, { code: '', exit: 'v', value: 'rI', attached: '', longCode: ['help', 'version'], longValue: [] }],
  [/^php(?:\d+(?:\.\d+)*)?(?:-cli)?$/, { code: 'rRBEFf', exit: 'hvilms', value: 'cdzt', attached: '', longCode: ['help', 'version'], longValue: [] }],
  [/^(?:lua(?:\d+(?:\.\d+)*)?|luajit)$/, { code: 'e', exit: 'v', value: 'lj', attached: 'O', longCode: [], longValue: [] }],
  [/^tclsh(?:\d+(?:\.\d+)*)?$/, { code: '', exit: '', value: '', attached: '', longCode: [], longValue: [], word: ['-encoding'] }],
  [/^osascript$/, { code: 'e', exit: '', value: 'ls', attached: '', longCode: [], longValue: [] }],
];

// The interpreter's own words: true when it gets neither a script nor a code
// or exit option, or names stdin with -.
function readsCodeFromStdin(spec, words) {
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    if (w === '-') return true;
    if (w === '--') return k + 1 >= words.length || words[k + 1] === '-';
    if ((spec.word || []).includes(w)) { k++; continue; }
    if (w.startsWith('--')) {
      const name = w.slice(2).split('=')[0];
      if (spec.longCode.includes(name)) return false;
      if (spec.longValue.includes(name) && !w.includes('=')) k++;
      continue;
    }
    if (w.startsWith('-')) {
      for (let j = 1; j < w.length; j++) {
        if (spec.code.includes(w[j]) || spec.exit.includes(w[j])) return false;
        if (spec.attached.includes(w[j])) break;
        if (spec.value.includes(w[j])) { if (j === w.length - 1) k++; break; }
      }
      continue;
    }
    return false;
  }
  return true;
}

// The program one pipe stage runs, past assignments, keywords and wrappers:
// { shell: true } for a shell, { interpreter, rest } for an interpreter and the
// words after it, or null.
function stageProgram(command) {
  // `bash; echo`, `bash>out`, `|& bash`, `(bash)`; a quoted `FOO="a;b"` does not end it.
  // Words sit on a stack (next word on top), so expanding env -S is O(words), not a splice.
  const stack = shellWords(command).reverse();
  const expand = (text) => { const more = shellWords(text); for (let k = more.length - 1; k >= 0; k--) stack.push(more[k]); };
  while (stack.length) {
    const word = stack.pop();
    // VAR=x sh -, { bash; }, if ...; then bash; fi. A for, select or case word list is not a command.
    if (/^(?:for|select|case)$/.test(word)) return null;
    if (KEYWORDS.has(word) || /^[A-Za-z_]\w*\+?=/.test(word)) continue;
    const name = word.slice(word.lastIndexOf('/') + 1);
    if (PIPE_SHELL.test(name)) return { shell: true };
    const interpreter = INTERPRETERS.find(([re]) => re.test(name));
    if (interpreter) return { interpreter: interpreter[1], rest: stack.slice().reverse() };
    const wrapper = Object.prototype.hasOwnProperty.call(WRAPPERS, name) ? WRAPPERS[name] : null;
    if (!wrapper) return null;
    const [shortValue, longValue] = wrapper;
    while (stack.length) {
      const w = stack[stack.length - 1];
      if (w === '--') { stack.pop(); break; }
      if (name === 'env' && /^[A-Za-z_]\w*=/.test(w)) { stack.pop(); continue; }
      // env -S / --split-string splits its value into more env arguments, so
      // its words are walked like the rest: env -S PATH=1 bash runs bash.
      if (name === 'env' && (w === '-S' || w === '--split-string')) {
        stack.pop();
        if (stack.length) expand(stack.pop());
        continue;
      }
      if (name === 'env' && /^--split-string=|^-S./.test(w)) {
        stack.pop();
        expand(w.slice(w.startsWith('--') ? w.indexOf('=') + 1 : 2));
        continue;
      }
      if (name === 'timeout' && /^\d/.test(w)) { stack.pop(); break; }
      if (!w.startsWith('-') || w === '-') break;
      stack.pop();
      if (w.startsWith('--')) {
        if (!w.includes('=') && longValue.includes(w.slice(2))) stack.pop();
        continue;
      }
      // A value flag at the end of a cluster takes the next word; -uroot carries its own.
      const letters = w.slice(1);
      if ([...letters].findIndex(c => shortValue.includes(c)) === letters.length - 1) stack.pop();
    }
  }
  return null;
}

// The pipe stages after the first fetch on the line, read as text.
function fetchStages(cmd) {
  const fetch = new RegExp(FETCH).exec(cmd);
  return fetch ? cmd.slice(fetch.index).split('|').slice(1).flatMap(stageCommands) : [];
}

function pipesToShell(cmd) {
  return fetchStages(cmd).some((command) => { const r = stageProgram(command); return !!(r && r.shell); });
}

const runsFromStdin = (r) => !!(r && r.interpreter && readsCodeFromStdin(r.interpreter, r.rest));

// The file descriptor a redirect right before this word acts on ('' is the
// default), read from the source text, since the reader keeps only the operator.
function redirectFd(src, word) {
  const m = /(\d*)(?:<<<|<<-|<<|&>>|&>|>>|>\||>&|<>|<&|<|>)\s*$/.exec(src.slice(Math.max(0, word.start - 64), word.start));
  return m ? m[1] : null;
}

// A curl or wget whose stdout is piped into an interpreter that reads its
// program from stdin. The line is read with the shell reader: the pipeline
// starts at a command whose program is curl or wget and runs only through its
// own | stages, a stage whose stdin comes from a file or heredoc
// (python3 < local.py) does not read the download, and a redirect between
// options and the script (python3 2>/dev/null x.py) is set apart. A line the
// reader is not sure of, or a stage that opens a compound command ((...), { },
// if, while, until, for, select, case), is walked as text instead.
const PIPE_OP = /^\|&?$/;
const FETCHER = /^(?:curl|wget)$/;
function pipesToInterpreter(src) {
  const read = readShell(src);
  if (!read.sure) return fetchStages(src).some((command) => runsFromStdin(stageProgram(command)));
  const stage = (c) => {
    if (c.words.some((w) => w.target && /^(?:<|<<|<<-|<<<|<>)$/.test(w.target) && ['', '0'].includes(redirectFd(src, w)))) return false;
    return runsFromStdin(stageProgram(argv(c).map((w) => src.slice(w.start, w.end)).join(' ')));
  };
  const compound = (c) => { const w = c.words[0]; return !!w && (w.op === '(' || (!w.op && !w.spans.length && OPENERS.has(w.value))); };
  for (const f of read.frames) {
    const cmds = f.cmds;
    for (let i = 0; i < cmds.length; i++) {
      const p = programWord(argv(cmds[i]));
      if (!p || p.dynamic || !FETCHER.test(base(p.value)) || !PIPE_OP.test(cmds[i].op)) continue;
      for (let j = i + 1; j < cmds.length; j++) {
        if (compound(cmds[j])) return fetchStages(src).some((command) => runsFromStdin(stageProgram(command)));
        if (stage(cmds[j])) return true;
        if (!PIPE_OP.test(cmds[j].op)) break;
      }
    }
  }
  return false;
}

// mkfs writes unless the selected program is asked for a dry run: -n for the
// ext family (mkfs.ext4, or mkfs with -t ext4 or no type, which defaults to
// ext2) and -N for xfs. Each letter that takes a value ends its cluster, so the
// -n of mkfs.xfs (naming options) and of mkfs.fat (a volume label) is a value,
// not a dry run. A device right after mkfs is refused as it always was. The
// arguments come from the shell reader, which sets redirects and their targets
// apart (mkfs.ext4 2>/dev/null /dev/sdb1 still names the device). A line the
// reader is not sure of, or a mkfs it does not find as a command, is refused.
const MKFS_FIRST = /\bmkfs(\.\w+)?\s+\/dev\/(sd[a-z]|nvme|hd[a-z]|vd[a-z]|r?disk\d)/;
const MKFS_DRY = {
  ext: { dry: 'n', value: 'bdegilmorstCEGIJLMNORTUz' },
  xfs: { dry: 'N', value: 'bdilLmnprs' },
};
const DISK_WORD = new RegExp('^' + DISK);
const MKFS_NAME = /^mkfs(?:\.(\w+))?$/;
function mkfsWrites(cmd) {
  if (MKFS_FIRST.test(cmd)) return true;
  const read = readShell(cmd);
  if (!read.sure) return true;
  let found = 0;
  for (const f of read.frames) {
    for (const c of f.cmds) {
      const all = argv(c);
      const at = all.findIndex((w) => MKFS_NAME.test(base(w.value)));
      if (at < 0) continue;
      found++;
      if (mkfsArgsWrite(MKFS_NAME.exec(base(all[at].value))[1], all.slice(at + 1).map((w) => w.value))) return true;
    }
  }
  return found < (cmd.match(/\bmkfs(?:\.\w+)?\b/g) || []).length;
}

function mkfsArgsWrite(suffix, words) {
  let type = suffix;
  if (!type) {
    const t = words.findIndex((w) => w === '-t' || w === '--type' || w.startsWith('--type='));
    type = t < 0 ? 'ext2' : words[t].startsWith('--type=') ? words[t].slice(7) : words[t + 1] || '';
  }
  const opts = /^ext[234]$/.test(type) ? MKFS_DRY.ext : type === 'xfs' ? MKFS_DRY.xfs : null;
  let dry = false;
  for (let k = 0; opts && k < words.length; k++) {
    const w = words[k];
    if (w === '--') break;
    if (!/^-[A-Za-z]/.test(w)) continue;
    for (let j = 1; j < w.length; j++) {
      if (w[j] === opts.dry) dry = true;
      if (opts.value.includes(w[j])) { if (j === w.length - 1) k++; break; }
    }
  }
  return !dry && words.some((w) => DISK_WORD.test(w));
}

// The program a command runs: past assignments, keywords and wrappers (sudo,
// env, nice ...) with their options and option values. A wrapper option this
// does not know ends the walk on a word that is not rm, which keeps the glob.
function programWord(words) {
  let k = commandIndex(words);
  while (k < words.length && !words[k].dynamic && Object.prototype.hasOwnProperty.call(WRAPPERS, base(words[k].value))) {
    const name = base(words[k].value);
    const [shortValue, longValue] = WRAPPERS[name];
    k++;
    while (k < words.length) {
      const w = words[k].value;
      if (w === '--') { k++; break; }
      if (name === 'env' && /^[A-Za-z_]\w*=/.test(w)) { k++; continue; }
      if (name === 'timeout' && /^\d/.test(w)) { k++; break; }
      if (!w.startsWith('-') || w === '-') break;
      k++;
      if (w.startsWith('--')) { if (!w.includes('=') && longValue.includes(w.slice(2))) k++; continue; }
      const letters = w.slice(1);
      if ([...letters].findIndex((c) => shortValue.includes(c)) === letters.length - 1) k++;
    }
  }
  return words[k];
}

// The line with each * or ? that an rm argument holds inside quotes or after a
// backslash replaced by _, for a command whose program is rm itself, so a file
// named sh or eval is just a name. A shell or eval that runs text (sh -c
// 'rm -rf ~/*'), an assigned value, which globs where it is expanded, and a
// $(...) inside double quotes, whose words are read on their own, keep theirs.
function quotedGlobsBlanked(cmd) {
  if (!/[*?]/.test(cmd) || !/['"\\]/.test(cmd)) return cmd;
  const read = readShell(cmd);
  const at = [];
  for (const f of read.frames) {
    for (const c of f.cmds) {
      const words = argv(c);
      const program = programWord(words);
      if (!program || program.dynamic || base(program.value) !== 'rm') continue;
      for (const w of words) {
        if (/^[A-Za-z_]\w*\+?=/.test(w.lead)) continue;
        const nested = w.parts.filter((p) => p.frame);
        let j = 0;
        for (const s of w.spans) {
          for (let i = s.start; i < s.end; i++) {
            while (j < nested.length && nested[j].to <= i) j++;
            if (j < nested.length && i >= nested[j].from) { i = nested[j].to - 1; continue; }
            if (cmd[i] === '*' || cmd[i] === '?') at.push(i);
          }
        }
      }
    }
  }
  if (!at.length) return cmd;
  const chars = cmd.split('');
  for (const i of at) chars[i] = '_';
  return chars.join('');
}

// sudo's own options (-n, -u root, --) and a path to rm still run rm, and sudo
// named by its path (/usr/bin/sudo) is still sudo. The words are read twice:
// as text up to the next separator, and with the shell reader, which sets a
// redirect and its target apart, so sudo 2>/dev/null rm x and
// sudo -n >/dev/null rm x still run rm. A line the reader is not sure of is refused.
function sudoWordsRunRm(words) {
  const [shortValue, longValue] = WRAPPERS.sudo;
  let k = 0;
  while (k < words.length) {
    const w = words[k];
    if (w === '--') { k++; break; }
    if (/^[A-Za-z_]\w*=/.test(w)) { k++; continue; }
    if (!w.startsWith('-') || w === '-') break;
    k++;
    if (w.startsWith('--')) { if (!w.includes('=') && longValue.includes(w.slice(2))) k++; continue; }
    const letters = w.slice(1);
    if ([...letters].findIndex(c => shortValue.includes(c)) === letters.length - 1) k++;
  }
  return words[k] !== undefined && base(words[k]) === 'rm';
}

function sudoRunsRm(cmd) {
  for (const m of cmd.matchAll(/(?<![\w.-])sudo(?=\s)/g)) {
    if (sudoWordsRunRm(shellWords(firstCommand(cmd.slice(m.index + 4).split('|')[0])))) return true;
  }
  const read = readShell(cmd);
  if (!read.sure) return true;
  for (const f of read.frames) {
    for (const c of f.cmds) {
      const words = argv(c).map((w) => w.value);
      for (let j = 0; j < words.length; j++) {
        if (base(words[j]) === 'sudo' && sudoWordsRunRm(words.slice(j + 1))) return true;
      }
    }
  }
  return false;
}

// The arguments after <sub> of each git command the shell reader finds, with
// redirects and their targets set apart; each list's .early counts the
// arguments before the first redirect. null, so the caller refuses, when the
// reader is not sure of the line or finds fewer such commands than the text names.
function gitArgs(cmd, sub, textRegex) {
  const read = readShell(cmd);
  if (!read.sure) return null;
  const lists = [];
  for (const f of read.frames) {
    for (const c of f.cmds) {
      const words = argv(c).map((w) => w.value);
      const g = words.findIndex((w) => base(w) === 'git');
      const s = g < 0 ? -1 : words.indexOf(sub, g + 1);
      if (s < 0) continue;
      const redirect = c.words.findIndex((w) => w.op && w.op !== '(' && w.op !== ')');
      const list = words.slice(s + 1);
      list.early = redirect < 0 ? list.length : Math.max(0, c.words.slice(0, redirect).filter((w) => !w.op && !w.target).length - s - 1);
      lists.push(list);
    }
  }
  return lists.length < (cmd.match(textRegex) || []).length ? null : lists;
}

// git clean deletes only with a force flag and no dry run. The value of -e or
// --exclude is a pattern (-e -foo), not a flag. A force flag in the first word
// after clean (-f, -nf, -fn, -efoo) counts on its own, as it always has, and a
// force flag after a redirect counts too; a dry run after a redirect is not read.
const GIT_CLEAN = new RegExp(GIT + 'clean\\b', 'g');
const GIT_CLEAN_FIRST = new RegExp(GIT + 'clean\\s+(-\\w*f|-f)');
function cleanForces(cmd) {
  if (GIT_CLEAN_FIRST.test(cmd)) return true;
  const lists = gitArgs(cmd, 'clean', GIT_CLEAN);
  return !lists || lists.some((words) => {
    let force = false;
    let dry = false;
    for (let k = 0; k < words.length; k++) {
      const w = words[k];
      if (w === '--') break;
      if (w.startsWith('--')) {
        const neg = w.startsWith('--no-');
        const name = w.slice(neg ? 5 : 2);
        if (!neg && /^e(?:x(?:c(?:l(?:u(?:de?)?)?)?)?)?$/.test(name)) k++;
        else if (/^f(?:o(?:r(?:ce?)?)?)?$/.test(name)) force = !neg;
        else if (/^d(?:r(?:y(?:-(?:r(?:un?)?)?)?)?)?$/.test(name)) dry = (!neg && k < words.early) || (neg ? false : dry);
        continue;
      }
      if (!w.startsWith('-')) continue;
      for (let j = 1; j < w.length; j++) {
        if (w[j] === 'e') { if (j === w.length - 1) k++; break; }
        if (w[j] === 'f') force = true;
        if (w[j] === 'n' && k < words.early) dry = true;
      }
    }
    return force && !dry;
  });
}

// A force flag, or a +ref refspec once each option has taken exactly its own
// value: -o and --push-option take one word (-o +build), an attached value
// (-ofoo, -oo) takes none, so -oo +topic and -o -o +x still push +refs.
const GIT_PUSH = new RegExp(GIT + 'push\\b', 'g');
const PUSH_FORCE_FLAG = new RegExp(GIT + 'push\\b(?=[^;&|\\n]*' + FORCE_FLAG + ')');
const PUSH_VALUE = new Set(['-o', '--push-option']);
function pushForces(cmd) {
  if (PUSH_FORCE_FLAG.test(maskQuotedSeparators(cmd))) return true;
  const lists = gitArgs(cmd, 'push', GIT_PUSH);
  return !lists || lists.some((words) => {
    for (let k = 0; k < words.length; k++) {
      const w = words[k];
      if (w === '--') return words.slice(k + 1).some((x) => x.startsWith('+'));
      if (PUSH_VALUE.has(w)) { k++; continue; }
      if (w.startsWith('--')) continue;
      if (/^-./.test(w)) { if (w.indexOf('o') === w.length - 1) k++; continue; }
      if (w.startsWith('+')) return true;
    }
    return false;
  });
}

function checkCommand(cmd, safetyLevel = SAFETY_LEVEL) {
  const threshold = LEVELS[safetyLevel] || 2;
  // bash removes a backslash-newline outright, joining the two lines.
  cmd = cmd.replace(/\\\r?\n/g, '');
  const views = shellViews(cmd);
  const quoted = /["'\\]/.test(cmd);
  const blanked = quotedGlobsBlanked(cmd);
  const globViews = blanked === cmd ? null : shellViews(blanked);
  const hit = (p, regex, vs) => vs.some((v) => regex.test(p.segment ? v.masked : v.text) && (!p.confirm || p.confirm(v.text)));
  for (const p of PATTERNS) {
    if (LEVELS[p.level] > threshold) continue;
    const full = quoted && p.quoted ? p.quoted : p.regex;
    const plain = p.plain && (quoted && p.plainQuoted ? p.plainQuoted : p.plain);
    const found = plain && globViews ? hit(p, plain, views) || hit(p, full, globViews) : hit(p, full, views);
    if (found) return { blocked: true, pattern: p };
  }
  return { blocked: false, pattern: null };
}

// A check that throws must not read as an allow, so the call is denied.
// HOOK_FAIL_OPEN=true restores the old allow-on-error behaviour.
function guardError(e) {
  if (process.env.HOOK_FAIL_OPEN === 'true') return '{}';
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `🚨 [guard-error] block-dangerous-commands could not check this call (${String(e && e.message).slice(0, 200)}), so it is blocked. Run it yourself if you meant it, or set HOOK_FAIL_OPEN=true to let calls through when a guard fails.`,
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
    console.log(data !== null && typeof data === 'object' ? guardError(e) : '{}');
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = { PATTERNS, LEVELS, SAFETY_LEVEL, ASK, checkCommand, shellViews };
}
