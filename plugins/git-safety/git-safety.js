#!/usr/bin/env node
/**
 * Git Safety - PreToolUse Hook for Bash
 * Blocks destructive git and gh CLI operations. Logs to: ~/.claude/hooks-logs/
 *
 * SAFETY_LEVEL: 'critical' | 'high' | 'strict' (default 'high')
 *   Override via the HOOK_SAFETY_LEVEL env var; invalid values fall back to the
 *   default. Prefer the env var over editing this file: plugin updates
 *   overwrite installed files.
 *   critical - no git-safety rules apply (defer entirely to block-dangerous-commands.js)
 *   high     - branch-aware guardrails (commit/merge/rebase/reset/push while on a
 *              protected branch), protected-branch deletion, direct pushes to
 *              main/master by name, and destructive gh CLI operations
 *   strict   - + force-push, so this hook is self-sufficient standalone
 *
 * Composition with block-dangerous-commands.js:
 *   That hook already blocks force-push (any, and to main/master) and
 *   `git reset --hard` on any branch. At the default 'high' level this hook adds
 *   only the complementary coverage above, so the two do not overlap. Raise this
 *   hook to 'strict' (or leave the sibling out) if you run git-safety on its own.
 *
 * Setup (plugin, recommended):
 *   /plugin marketplace add karanb192/claude-code-hooks
 *   /plugin install git-safety@claude-code-hooks
 *
 * Classic setup still works: copy the script somewhere stable and register it
 * in .claude/settings.json:
 * {
 *   "hooks": {
 *     "PreToolUse": [{
 *       "matcher": "Bash",
 *       "hooks": [{ "type": "command", "command": "node /path/to/git-safety.js" }]
 *     }]
 *   }
 * }
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_SAFETY_LEVEL = 'high';
const SAFETY_LEVEL = ['critical', 'high', 'strict'].includes(process.env.HOOK_SAFETY_LEVEL)
  ? process.env.HOOK_SAFETY_LEVEL
  : DEFAULT_SAFETY_LEVEL;

const PROTECTED_BRANCHES = ['main', 'master'];

// git with global options before the subcommand (git -C repo push, git -c k=v push).
// Option values may be quoted, attached (-C/repo) or a separate word (--git-dir /repo).
// A value is one shell word, so quotes and escapes may sit anywhere in it
// (user.name="Ada Lovelace", my\ repo). The alternatives never match the same
// text, so a long option run stays linear.
const GIT_VAL = '(?:[^\\s"\'\\\\]|\\\\[\\s\\S]|"[^"]*"|\'[^\']*\')+';
const GIT_LONG_VAL = '(?:git-dir|work-tree|namespace|exec-path|super-prefix|config-env|attr-source)';
const GIT = '\\bgit(?:\\s+(?:-[Cc]\\s*' + GIT_VAL + '|--' + GIT_LONG_VAL + '(?:=|\\s+)' + GIT_VAL + '|--(?!' + GIT_LONG_VAL + '\\b)[\\w-]+(?:=' + GIT_VAL + ')?|-(?![Cc])[A-Za-z]))*\\s+';

// gh pr|issue|release|repo <verb>, with group flags such as -R owner/repo between the two words.
const gh = (group, verb) => new RegExp('\\bgh\\s+' + group + '(?:\\s+-[^\\s;&|]*(?:\\s+[^-\\s;&|][^\\s;&|]*)?)*\\s+' + verb + '\\b');

const PATTERNS = [
  // STRICT - force-push is normally handled by block-dangerous-commands.js.
  // Only enforced here at 'strict' so git-safety is self-sufficient standalone.
  // -f may sit in a short-flag cluster (-fu, -uf), but not after -o, whose value is the rest of the word.
  // A refspec with a leading + (origin +feature) force-updates that ref. flags is the rule without
  // that branch: when only a + word matched, plusIsPushOption may waive it.
  { level: 'strict', id: 'force-push',              segment: true, regex: new RegExp(GIT + 'push\\b[^;&|\\n]*\\s["\']?(?:(?:--force|-[A-Za-eg-np-z0-9]*f[A-Za-z0-9]*)["\']?(?=\\s|$|[;&|"\')<>])|\\+[^\\s;&|])'), flags: new RegExp(GIT + 'push\\b[^;&|\\n]*\\s["\']?(?:--force|-[A-Za-eg-np-z0-9]*f[A-Za-z0-9]*)["\']?(?=\\s|$|[;&|"\')<>])'), reason: 'Force-pushing is not allowed' },

  // HIGH - complementary coverage the sibling hook does not provide

  // Block pushing directly to a protected branch by name
  // The branch as a whole ref (origin main, HEAD:main, +main, refs/heads/main, heads/main), so my-main-feature is not main.
  // A ref ends at a space, separator, quote, closing paren or redirect: (cd repo && git push origin main).
  { level: 'high', id: 'push-main',                 segment: true, regex: new RegExp(GIT + 'push\\b[^;&|\\n]*[\\s:+"\'](?:(?:refs\\/)?heads\\/)?main(?=$|[\\s;&|:"\')<>])'),   reason: 'Pushing to main is not allowed' },
  { level: 'high', id: 'push-master',               segment: true, regex: new RegExp(GIT + 'push\\b[^;&|\\n]*[\\s:+"\'](?:(?:refs\\/)?heads\\/)?master(?=$|[\\s;&|:"\')<>])'), reason: 'Pushing to master is not allowed' },

  // Block deleting protected branches locally: a delete flag anywhere in the call (-d, -D, -Dq,
  // --delete) and main or master as any whole branch word (-d -f main, -D old main, -D -- main).
  { level: 'high', id: 'branch-delete-protected',   segment: true, regex: new RegExp(GIT + 'branch\\b(?=[^;&|\\n]*\\s["\']?(?:-[A-CE-Za-ce-z]*[dD]|--delete\\b))[^;&|\\n]*[\\s"\'](?:main|master)(?=$|[\\s;&|)"\'<>])'), reason: 'Deleting a protected branch is not allowed' },

  // Block direct changes when on a protected branch
  { level: 'high', id: 'commit-on-protected',       regex: new RegExp(GIT + 'commit\\b'),                                reason: 'Committing directly on {branch} is not allowed', branchOnly: true },
  { level: 'high', id: 'merge-on-protected',        regex: new RegExp(GIT + 'merge\\b'),                                 reason: 'Merging into {branch} is not allowed', branchOnly: true },
  { level: 'high', id: 'rebase-on-protected',       regex: new RegExp(GIT + 'rebase\\b'),                                reason: 'Rebasing {branch} is not allowed', branchOnly: true },
  { level: 'high', id: 'reset-on-protected',        regex: new RegExp(GIT + 'reset\\b'),                                 reason: 'Resetting {branch} is not allowed', branchOnly: true },
  { level: 'high', id: 'push-on-protected',         regex: new RegExp(GIT + 'push\\b'),                                  reason: 'Pushing from {branch} is not allowed', branchOnly: true },

  // Block destructive gh CLI operations
  { level: 'high', id: 'gh-pr-merge',               regex: gh('pr', 'merge'),                                 reason: 'Merging PRs via gh CLI is not allowed' },
  { level: 'high', id: 'gh-pr-close',               regex: gh('pr', 'close'),                                 reason: 'Closing PRs via gh CLI is not allowed' },
  { level: 'high', id: 'gh-issue-close',            regex: gh('issue', 'close'),                              reason: 'Closing issues via gh CLI is not allowed' },
  { level: 'high', id: 'gh-release-delete',         regex: gh('release', 'delete'),                           reason: 'Deleting releases via gh CLI is not allowed' },
  { level: 'high', id: 'gh-repo-delete',            regex: gh('repo', 'delete'),                              reason: 'Deleting repos via gh CLI is not allowed' },
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

function getCurrentBranch() {
  try {
    return execFileSync('git', ['branch', '--show-current'], { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
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

const BRANCH_RULES = { commit: 'commit-on-protected', merge: 'merge-on-protected', rebase: 'rebase-on-protected', reset: 'reset-on-protected', push: 'push-on-protected' };

// Another repository the command names is not trusted yet (its config can name
// programs git runs), so its branch is read from files and nothing is run there.
// Only small regular files are read: a FIFO or device would hang the hook.
function readSmall(file, max = 4096) {
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size <= max ? fs.readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

// The git dir that serves a work directory: a .git directory, or the gitdir:
// line of a .git file (a linked worktree), in it or the nearest parent.
function findGitDir(start) {
  try { if (!fs.statSync(start).isDirectory()) return null; } catch { return null; }
  for (let d = start; ; d = path.dirname(d)) {
    const dotgit = path.join(d, '.git');
    let st = null;
    try { st = fs.statSync(dotgit); } catch {}
    if (st && st.isDirectory()) return dotgit;
    if (st && st.isFile()) {
      const m = /^gitdir: *(.+?)\s*$/m.exec(readSmall(dotgit) || '');
      return m ? path.resolve(d, m[1]) : null;
    }
    if (path.dirname(d) === d) return null;
  }
}

// The branch HEAD names, or '' when it is detached or cannot be read.
function headBranch(gitDir) {
  const m = gitDir ? /^ref: refs\/heads\/(.+?)\s*$/.exec(readSmall(path.join(gitDir, 'HEAD')) || '') : null;
  return m ? m[1] : '';
}

// A local branch of that name exists: a loose ref or a packed-refs line, in
// the git dir or, for a linked worktree, its common dir.
function hasBranch(gitDir, name) {
  if (!gitDir || !/^[\w./-]+$/.test(name) || /(?:^|\/)\.|\/$/.test(name)) return false;
  const common = (readSmall(path.join(gitDir, 'commondir')) || '').trim();
  for (const d of new Set([gitDir, common ? path.resolve(gitDir, common) : gitDir])) {
    try { if (fs.statSync(path.join(d, 'refs', 'heads', name)).isFile()) return true; } catch {}
    const packed = readSmall(path.join(d, 'packed-refs'), 1 << 20) || '';
    if (packed.split('\n').some(l => l.endsWith(' refs/heads/' + name))) return true;
  }
  return false;
}

// A checkout that leaves the branch as it was, or moves only to a branch that
// is not protected: git checkout -- file, git checkout main -- file, or a name
// that may be a file, a tag or a new tracking branch.
const KEEP = Symbol('keep');
// git checkout - and @{-1}: back to the branch before the last switch.
const BACK = Symbol('back');

// The branch the target of a checkout or switch leaves checked out: the new
// branch of -b/-c, '' for --detach, KEEP, BACK, or null for an older @{-N}.
// A protected name in any letter case counts as protected: on a
// case-insensitive disk, MAIN and main are one ref file.
function switchTarget(sub, args, isBranch) {
  const norm = (t) => (typeof t === 'string' && PROTECTED_BRANCHES.includes(t.toLowerCase()) ? t.toLowerCase() : t);
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // checkout -- names files; switch -- only ends the options before the branch.
    if (a === '--') {
      if (sub === 'checkout' && i < args.length - 1) return KEEP;
      if (sub === 'switch') pos.push(...args.slice(i + 1));
      break;
    }
    const m = /^(?:-[bBcC]|--(?:create|force-create|orphan))(?:=(.*))?$/.exec(a);
    if (m) return norm(m[1] !== undefined ? m[1] : (args[i + 1] ?? KEEP));
    if (a === '--detach' || (sub === 'switch' && a === '-d')) return '';
    if (sub === 'checkout' && /^(?:-p|--patch|--pathspec-from-file(?:=.*)?)$/.test(a)) return KEEP;
    if (a === '-' || !a.startsWith('-')) pos.push(a);
  }
  // Paths only, several names or none: git restores files, or fails, and stays put.
  if (pos.length !== 1) return KEEP;
  if (pos[0] === '-' || pos[0] === '@{-1}') return BACK;
  if (/^@\{-\d+\}$/.test(pos[0])) return null;
  // --track origin/main creates and checks out the local branch main.
  if (args.some(a => /^(?:--track(?:=.*)?|-[A-Za-z]*t[A-Za-z]*)$/.test(a))) return norm(pos[0].replace(/^(?:refs\/)?(?:remotes\/)?[^/]+\//, ''));
  const t = norm(pos[0]);
  return sub === 'switch' || PROTECTED_BRANCHES.includes(t) || isBranch(t) ? t : KEEP;
}

// Commands a line may hold and still have its target branch known for
// certain: they run nothing else and cannot move HEAD.
const STEADY = new Set([...INERT, ...DATA_READERS].filter(c => c !== 'tee'));
const STEADY_GIT = /^(?:add|status|diff|log|show|commit|merge|reset|push|fetch|pull|restore|rm|mv|tag|stash|cherry-pick|revert|checkout|switch|rebase)$/;
const LIST_END = new Set([';', '\n']);

// Commit, merge, rebase, reset and push reach the branch of the repository the
// command runs in, not always the session's. Walk each command list in order:
// cd and pushd move the directory, git -C, --git-dir and --work-tree name
// another repository, and an earlier checkout or switch changes the branch.
// A cd ends with a ( ) subshell; { }, if and loop bodies run in the current
// shell, so a cd there stays. A checkout changes the repository and outlives
// any group. Returns every branch-rule call with the branch it reaches, and
// known: false when anything in the line could run git out of sight, move
// HEAD another way or name a directory that cannot be read.
function resolveBranches(cmd, sessionBranch) {
  const out = { ops: [], known: false };
  if (!/\bgit\b/.test(cmd)) return out;
  const read = readShell(cmd);
  const session = process.cwd();
  let known = read.sure && read.frames.length === 1 && !read.heredocs.length && !/\$\(|`|[<>]\(/.test(cmd);
  for (const f of read.frames) {
    let dir = session;
    const groups = [];
    const switched = new Map();
    const before = new Map();
    // A switch counts as made for a later call only when an && chain joins
    // them and no || or pipe earlier in the same list can skip the switch.
    let listClean = true;
    let lastBreak = -1;
    const close = (sub) => {
      const top = groups[groups.length - 1];
      if (!top || top.sub !== sub) return;
      groups.pop();
      if (sub) dir = top.dir;
    };
    const visit = (c, n) => {
      if (c.op === '&' || c.words.some(x => x.target && WRITE_REDIRECT.has(x.target) && !SAFE_TARGET.test(x.value))) known = false;
      const words = argv(c);
      const k = commandIndex(words);
      if (words.slice(0, k).some(x => /^[A-Za-z_]\w*\+?=/.test(x.lead || ''))) known = false;
      const w = words[k];
      if (!w) return;
      if (w.dynamic || w.spans.length) { known = false; return; }
      if (w.value === 'cd' || w.value === 'pushd' || w.value === 'popd') {
        const t = words.slice(k + 1).find(x => !x.value.startsWith('-'));
        dir = w.value !== 'popd' && dir && t && !t.dynamic && t.value !== '-' && !t.value.startsWith('~') ? path.resolve(dir, t.value) : null;
        // Past any real path length the directory is unknown, which keeps a long cd run linear.
        if (dir && dir.length > 4096) dir = null;
        return;
      }
      if (w.value !== 'git') { if (!STEADY.has(w.value)) known = false; return; }
      if (!dir) { known = false; return; }
      let where = dir;
      let gitDirArg = null;
      let j = k + 1;
      for (; j < words.length && words[j].value.startsWith('-'); j++) {
        const v = words[j].value;
        const m = /^--(git-dir|work-tree)(?:=([\s\S]*))?$/.exec(v);
        if (v === '-C' || m) {
          const val = m && m[2] !== undefined ? words[j] : words[++j];
          if (!val || val.dynamic) { where = null; break; }
          const value = m && m[2] !== undefined ? m[2] : val.value;
          if (v === '-C') where = path.resolve(where, value);
          else if (m[1] === 'git-dir') gitDirArg = value;
        } else if (/^(?:-c|--(?:namespace|super-prefix|config-env|attr-source))$/.test(v)) { j++; known = false; }
        else if (/^--(?:namespace|super-prefix|config-env|attr-source)=|^-c./.test(v)) known = false;
      }
      const sub = words[j];
      if (!where || !sub || sub.dynamic) { known = false; return; }
      const args = words.slice(j + 1).map(x => x.value);
      if (!STEADY_GIT.test(sub.value) || (sub.value === 'rebase' && (args.filter(a => !a.startsWith('-')).length > 1 || args.some(a => /^(?:-x|--exec|--onto|--root)/.test(a))))) known = false;
      // git resolves --git-dir against the directory every -C leads to.
      const own = where === session && gitDirArg === null;
      const gitDir = gitDirArg !== null ? path.resolve(where, gitDirArg) : findGitDir(where);
      const repo = gitDir || where;
      // A switch is made for this call when an && chain joins them and nothing
      // earlier in its list can skip it. One away from a protected branch that
      // may not have run (a ; or || before this call, a switch that can fail)
      // leaves the call on that protected branch.
      const made = (rec) => rec.at >= 0 && lastBreak < rec.at;
      const effective = (rec) => {
        if (rec && rec.from && !made(rec)) return rec.from;
        return rec && rec.branch !== null ? rec.branch : own ? sessionBranch() : headBranch(gitDir);
      };
      if (sub.value === 'checkout' || sub.value === 'switch') {
        const now = effective(switched.get(repo));
        const from = PROTECTED_BRANCHES.includes(now) ? now : null;
        const at = listClean && !c.words.some(x => !x.op && !x.spans.length && x.value === '!') ? n : -1;
        // An expansion, glob, brace list or ~ in any operand is known only when
        // the shell runs, so the branch may become anything, main included: a
        // protected branch already reached stays, and nothing counts as certain.
        if (words.slice(j + 1).some(x => x.dynamic || /[*?[~]|\{[^}]*(?:,|\.\.)/.test(x.value))) {
          if (from) switched.set(repo, { branch: from, at: -1, from: null });
          else switched.delete(repo);
          before.set(repo, now);
          known = false;
          return;
        }
        let t = switchTarget(sub.value, args, (name) => hasBranch(gitDir, name));
        if (t === KEEP) return;
        if (t === BACK) t = before.has(repo) ? before.get(repo) : null;
        switched.set(repo, { branch: t, at, from });
        before.set(repo, now);
        return;
      }
      const id = BRANCH_RULES[sub.value];
      if (!id) return;
      const rec = switched.get(repo);
      out.ops.push({ id, branch: effective(rec), certain: !!rec && rec.branch !== null && made(rec) });
    };
    f.cmds.forEach((c, n) => {
      let h = 0;
      for (; h < c.words.length; h++) {
        const x = c.words[h];
        if (x.op === '(') groups.push({ sub: true, dir });
        else if (!x.op && !x.target && !x.spans.length && !x.dynamic && KEYWORDS.has(x.value)) {
          if (OPENERS.has(x.value)) groups.push({ sub: false });
          else if (CLOSERS.has(x.value)) close(false);
        } else break;
      }
      visit(c, n);
      for (; h < c.words.length; h++) if (c.words[h].op === ')') close(true);
      if (c.op !== '&&') lastBreak = n;
      if (LIST_END.has(c.op)) listClean = true;
      else if (c.op !== '&&') listClean = false;
    });
  }
  out.known = known;
  return out;
}

// Inside quotes, ( ) < > are part of the ref, not shell operators: git accepts
// 'main)fix' and 'master<preview' as branch names, so they cannot end a ref.
// Only the push rules read this copy, and each also runs without the paren and
// redirect boundary on the unmasked copy, so a quote this reader pairs
// differently from bash ($'\'', an apostrophe in a heredoc) cannot hide a push.
const REF_RULES = new Set(['force-push', 'push-main', 'push-master']);
const unbounded = (re) => re && new RegExp(re.source.split(')<>]').join(']'));
for (const p of PATTERNS) if (REF_RULES.has(p.id)) { p.plain = unbounded(p.regex); p.plainFlags = unbounded(p.flags); }
function maskQuotedOperators(s) {
  let out = '';
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && q !== "'" && i + 1 < s.length) { out += ch + s[++i]; continue; }
    if (q) {
      if (ch === q) q = '';
      else if (/[()<>]/.test(ch)) { out += '_'; continue; }
    } else if (ch === '"' || ch === "'") q = ch;
    out += ch;
  }
  return out;
}

const PUSH_FLAGS = new Set(['--verbose', '--quiet', '--dry-run', '--porcelain', '--all', '--branches', '--mirror', '--tags', '--follow-tags', '--no-follow-tags', '--atomic', '--no-atomic', '--verify', '--no-verify', '--set-upstream', '--thin', '--no-thin', '--progress', '--no-progress', '--prune', '--no-prune', '--force', '--force-with-lease', '--no-force-with-lease', '--force-if-includes', '--no-force-if-includes', '--delete', '--ipv4', '--ipv6', '--signed', '--no-signed', '--no-recurse-submodules']);
const PUSH_VALUE_OPTS = new Set(['--repo', '--receive-pack', '--exec', '--recurse-submodules']);

// git push -o +build: every + word is the value of -o or --push-option, so no
// refspec forces anything. Read only a plain line (no quotes, escapes,
// expansions, groups, redirects, comments or newlines), whose words are
// exactly what git gets, and parse each push once, one value per option. Any
// other git call, global option, unknown long option or + word keeps the refusal.
function plusIsPushOption(cmd) {
  if (/['"\\$`<>(){}\n\r#*?[~]/.test(cmd)) return false;
  for (const seg of cmd.split(/[;&|]+/)) {
    const words = seg.trim().split(/[ \t]+/);
    if (!/\bgit\b/.test(seg)) continue;
    if (words[0] !== 'git' || words.slice(1).includes('git') || (words[1] || '').startsWith('-')) return false;
    if (words[1] !== 'push') continue;
    for (let i = 2; i < words.length; i++) {
      const a = words[i];
      if (a === '--') { if (words.slice(i + 1).some(x => x.startsWith('+'))) return false; break; }
      if (a.startsWith('+')) return false;
      if (a === '--push-option' || /^-[vqnfdu46]*o$/.test(a)) { i++; continue; }
      if (/^--[\w-]+=/.test(a) || /^-[vqnfdu46]*o./.test(a)) continue;
      if (PUSH_VALUE_OPTS.has(a)) { if ((words[i + 1] || '').startsWith('+')) return false; i++; continue; }
      if (a.startsWith('--')) { if (!PUSH_FLAGS.has(a)) return false; continue; }
      if (a.startsWith('-') && !/^-[vqnfdu46]+$/.test(a)) return false;
    }
  }
  return true;
}

function checkCommand(cmd, branch = null, safetyLevel = SAFETY_LEVEL) {
  const threshold = LEVELS[safetyLevel] || LEVELS.high;
  // bash removes a backslash-newline outright, joining the two lines.
  cmd = cmd.replace(/\\\r?\n/g, '');
  const views = shellViews(cmd).map(v => ({ ...v, ref: maskQuotedOperators(v.masked) }));
  const sessionBranch = () => (branch === null ? (branch = getCurrentBranch()) : branch);
  let resolved = null;
  const resolve = () => resolved || (resolved = resolveBranches(cmd, sessionBranch));
  for (const p of PATTERNS) {
    if (LEVELS[p.level] > threshold) continue;
    const view = (v) => (!p.segment ? v.text : REF_RULES.has(p.id) ? v.ref : v.masked);
    if (!views.some(v => p.regex.test(view(v)) || (p.plain && p.plain.test(v.masked)))) continue;
    if (p.flags && !views.some(v => p.flags.test(view(v)) || p.plainFlags.test(v.masked)) && plusIsPushOption(cmd)) continue;

    if (p.branchOnly) {
      if (!branch) branch = getCurrentBranch();
      if (!PROTECTED_BRANCHES.includes(branch)) continue;
      // The session is on a protected branch, but every such call in the line
      // runs only after a switch to a branch that is not protected.
      const r = resolve();
      const mine = r.ops.filter(o => o.id === p.id);
      if (r.known && mine.length && mine.every(o => o.certain && !PROTECTED_BRANCHES.includes(o.branch))) continue;
    }

    const reason = p.reason.replace('{branch}', branch || '');
    return { blocked: true, pattern: p, reason };
  }

  if (LEVELS.high <= threshold) {
    const hit = resolve().ops.find(o => PROTECTED_BRANCHES.includes(o.branch));
    if (hit) {
      const p = PATTERNS.find(x => x.id === hit.id);
      return { blocked: true, pattern: p, reason: p.reason.replace('{branch}', hit.branch) };
    }
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
      permissionDecisionReason: `🚨 [guard-error] git-safety could not check this call (${String(e && e.message).slice(0, 200)}), so it is blocked. Run it yourself if you meant it, or set HOOK_FAIL_OPEN=true to let calls through when a guard fails.`,
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
      log({ level: 'BLOCKED', id: p.id, priority: p.level, cmd, session_id, cwd, permission_mode });
      return console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `${EMOJIS[p.level]} [${p.id}] ${result.reason}`
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
  module.exports = { PATTERNS, PROTECTED_BRANCHES, LEVELS, SAFETY_LEVEL, checkCommand, shellViews };
}
