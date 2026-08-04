#!/usr/bin/env node
/**
 * Case-Insensitive Filesystem Guard - PreToolUse Hook for Bash
 * On case-insensitive filesystems (APFS default, exFAT, NTFS), `Content` and
 * `content` are the same path — so `rm -rf content` silently destroys
 * `Content` (see anthropics/claude-code#37875). This hook resolves the real
 * target directory of destructive commands and denies the ones that would hit
 * a case-variant of what was typed. Logs to: ~/.claude/hooks-logs/
 *
 * Idea credit: @yurukusa (https://github.com/karanb192/claude-code-hooks/pull/8)
 *
 * Covered commands: rm, rmdir, mv, mkdir, touch, and `find <path> … -delete`
 * (also `find … -exec rm/unlink`). Directory context is modeled as a set of
 * candidate cwds plus the last command's exit status: `cd`/`pushd` move it
 * (honoring whether the target directory exists — including directories a
 * `mkdir` earlier in the same command line would create), `popd` restores the
 * matching `pushd`'s directory, a subshell `( … )` restores the outer cwd at
 * `)`, and connectors gate execution (`&&` runs only after success, `||` only
 * after failure, `;`/newline/`|`/`&` regardless — with `cd` in a background
 * (`&`) or pipeline (`|`) position not moving the parent shell). Heredoc
 * bodies are stripped before analysis, and wrapper prefixes (`nohup`, `exec`,
 * `command`, `env`, `sudo`, …) are peeled off.
 *
 * SAFETY_LEVEL: 'critical' | 'high' | 'strict'
 *   critical - recursive `rm -r/-rf` (and `find -delete`) onto a case-variant
 *   high     - + non-recursive deletes that really remove something
 *              (`rm` of a case-variant FILE, `rm -d`/`rmdir` of a case-variant
 *              dir, `mv` overwriting a case-variant FILE)
 *   strict   - + mkdir/touch onto an existing case-variant (usually a no-op,
 *              but often a sign the agent has the wrong name in mind)
 *
 * Ask mode (opt-in, per level): set HOOK_ASK_CRITICAL / HOOK_ASK_HIGH /
 * HOOK_ASK_STRICT to the literal string "true" to prompt instead of deny.
 *
 * Design notes (what is deliberately NOT flagged):
 * - Glob targets (`rm -rf Cont*`): the shell expands globs against real
 *   directory entries with case-SENSITIVE matching (bash default), so a
 *   miscased glob matches nothing and cannot case-collide. (Limitation:
 *   `shopt -s nocaseglob` defeats this; not modeled.)
 * - `$VAR`, `$(…)`, backticks: not statically resolvable → conservatively
 *   allowed rather than guessed at.
 * - Exact-case targets: `rm -rf Content` when `Content` exists as typed is an
 *   intentional delete, not a collision.
 * - A case-only rename (`mv readme.md README.md`) is the CANONICAL fix for a
 *   miscapitalized name — allowed, not blocked. `mv -t DIR`/`--target-directory`
 *   moves INTO a directory (contents preserved) — allowed.
 * - Plain `rm` (no -r/-d) of a case-variant DIRECTORY: `rm` refuses to remove
 *   a directory, so nothing is destroyed → allowed.
 * - Heredoc bodies (`cat <<EOF … EOF`) are document text, not commands.
 * - Quoted `~` is a literal path character to the shell, so it is not
 *   tilde-expanded here either.
 * - When the semantics leave the run-directory ambiguous, every candidate
 *   directory is checked (fail-closed): a rare over-block is preferred to a
 *   silent data-loss miss.
 * - No probe files: case-insensitivity is proven by the collision itself —
 *   the typed name is absent from readdir() yet the path still exists.
 *
 * Setup in .claude/settings.json:
 * {
 *   "hooks": {
 *     "PreToolUse": [{
 *       "matcher": "Bash",
 *       "hooks": [{ "type": "command", "command": "node /path/to/case-insensitive-guard.js" }]
 *     }]
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SAFETY_LEVEL = 'high';

const LEVELS = { critical: 1, high: 2, strict: 3 };
const EMOJIS = { critical: '🚨', high: '⛔', strict: '⚠️' };

// Ask mode per level: if true, prompts the user instead of blocking outright.
// Env overrides: HOOK_ASK_CRITICAL, HOOK_ASK_HIGH, HOOK_ASK_STRICT
const envBool = (key, fallback) => key in process.env ? process.env[key] === 'true' : fallback;
const ASK = {
  critical: envBool('HOOK_ASK_CRITICAL', false),
  high:     envBool('HOOK_ASK_HIGH', false),
  strict:   envBool('HOOK_ASK_STRICT', false),
};

const LOG_DIR = path.join(process.env.HOME || os.homedir(), '.claude', 'hooks-logs');

function log(entry) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), hook: 'case-insensitive-guard', ...entry }) + '\n');
  } catch { /* logging must never break the hook */ }
}

// ─── shell-aware parsing ─────────────────────────────────────────────────────

// Remove heredoc bodies (`<<EOF … EOF`) so document text is never analyzed as
// commands. Honors quoted delimiters, `<<-` tab stripping, and multiple
// heredocs queued on one line. A purely numeric "delimiter" is treated as
// arithmetic (`$((1<<2))`), not a heredoc.
function stripHeredocs(command) {
  let out = '', i = 0, quote = null;
  const pending = []; // delimiters whose bodies start at the next newline
  while (i < command.length) {
    const c = command[i];
    if (quote) {
      out += c;
      if (c === quote && command[i - 1] !== '\\') quote = null;
      i++; continue;
    }
    if (c === "'" || c === '"') { quote = c; out += c; i++; continue; }
    if (c === '<' && command[i + 1] === '<' && command[i + 2] !== '<' && command[i - 1] !== '<') {
      let j = i + 2;
      if (command[j] === '-') j++;
      while (command[j] === ' ' || command[j] === '\t') j++;
      let q = null;
      if (command[j] === "'" || command[j] === '"') { q = command[j]; j++; }
      let delim = '';
      while (j < command.length && /[^\s'"();&|<>]/.test(command[j])) { delim += command[j]; j++; }
      if (q && command[j] === q) j++;
      if (delim && !/^\d+$/.test(delim)) { pending.push(delim); out += ' '; i = j; continue; }
      out += c; i++; continue;
    }
    if (c === '\n' && pending.length) {
      out += '\n'; i++;
      while (pending.length && i < command.length) {
        let eol = command.indexOf('\n', i);
        if (eol === -1) eol = command.length;
        if (command.slice(i, eol).replace(/^\t+/, '') === pending[0]) pending.shift();
        i = eol + 1;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

// Split a command line into { text, connector } segments, where connector is
// the operator that PRECEDES the segment (null for the first). Operators inside
// single/double quotes are ignored. A single `&` (background) is a separator
// too — the command after it still runs; `&>`, `>&`, `<&` redirects are not.
function splitSegments(command) {
  const segments = [];
  let cur = '', quote = null, connector = null;
  const push = (nextConnector) => {
    const text = cur.trim();
    if (text) segments.push({ text, connector });
    cur = '';
    connector = nextConnector;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      cur += c;
      if (c === quote && command[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === '&' && command[i + 1] === '&') { push('&&'); i++; continue; }
    if (c === '&' && command[i + 1] !== '>' && command[i - 1] !== '>' && command[i - 1] !== '<') { push('&'); continue; }
    if (c === '|' && command[i + 1] === '|') { push('||'); i++; continue; }
    if (c === ';') { push(';'); continue; }
    if (c === '|') { push('|'); continue; }
    if (c === '\n') { push('\n'); continue; }
    cur += c;
  }
  push(null);
  return segments;
}

// Tokenize one segment on whitespace, respecting quotes. Each token records
// whether any part was quoted (quoted globs are literal to the shell). Unquoted
// `(` / `)` are shell operators and become standalone tokens even unspaced.
function tokenize(segment) {
  const tokens = [];
  let text = '', quoted = false, quote = null, started = false;
  const push = () => { if (started) tokens.push({ text, quoted }); text = ''; quoted = false; started = false; };
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote) {
      if (c === quote) { quote = null; } else { text += c; }
      continue;
    }
    if (c === "'" || c === '"') { quote = c; quoted = true; started = true; continue; }
    if (c === '(' || c === ')') { push(); tokens.push({ text: c, quoted: false }); continue; }
    if (/\s/.test(c)) { push(); continue; }
    if (c === '\\' && i + 1 < segment.length) { text += segment[i + 1]; started = true; i++; continue; }
    text += c; started = true;
  }
  push();
  return tokens;
}

const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', '{', '}']);
// Wrappers that just run their argument as the real command.
const PREFIX_CMDS = new Set(['command', 'builtin', 'exec', 'time', 'nohup', 'env', 'sudo']);

// Strip subshell parens, leading env assignments (FOO=bar) and `sudo`.
function commandTokens(tokens) {
  let toks = tokens.filter(t => t.text !== '(' && t.text !== ')');
  let i = 0;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i].text)) i++;
  if (i < toks.length && toks[i].text === 'sudo') {
    i++;
    while (i < toks.length && toks[i].text.startsWith('-')) i++;
  }
  return toks.slice(i);
}

function hasUnresolvable(text) { return /[$`]/.test(text); }
function hasGlob(tok) { return !tok.quoted && /[*?[]/.test(tok.text); }

function resolveTarget(text, cwd, quoted = false) {
  if (hasUnresolvable(text)) return null;
  let t = text;
  if (!quoted) { // a quoted ~ is a literal character to the shell
    if (t === '~') t = os.homedir();
    else if (t.startsWith('~/')) t = path.join(os.homedir(), t.slice(2));
  }
  if (!path.isAbsolute(t) && !cwd) return null;
  return path.resolve(cwd || '/', t);
}

// ─── collision analysis ──────────────────────────────────────────────────────

// Real filesystem operations, injectable for hermetic cross-platform tests.
const realFsx = {
  listDir(dir) { try { return fs.readdirSync(dir); } catch { return null; } },
  pathExists(p) { try { return fs.existsSync(p); } catch { return false; } },
  isDirectory(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
};

// A collision exists when the typed basename is NOT an on-disk entry of the
// parent, yet a differently-cased entry is — and the typed path still exists
// (proving the volume folds case, no probe file needed).
function findCollision(resolved, fsx) {
  const parent = path.dirname(resolved);
  const base = path.basename(resolved);
  if (!base || base === '.' || base === '..') return null;
  const entries = fsx.listDir(parent);
  if (!entries || entries.includes(base)) return null;
  const variant = entries.find(e => e.toLowerCase() === base.toLowerCase());
  if (!variant) return null;
  if (!fsx.pathExists(resolved)) return null; // case-sensitive volume: harmless miss
  const isDir = fsx.isDirectory(path.join(parent, variant));
  return { typed: base, actual: variant, parent, actualIsDir: isDir };
}

const RECURSIVE_FLAG = (f) => /^-[A-Za-z]*[rR]/.test(f) || f === '--recursive';
const DIR_FLAG = (f) => /^-[A-Za-z]*d/.test(f) || f === '--dir';

// Split flags from operands for a token list (POSIX `--` ends option parsing).
function splitArgs(tokens) {
  const flags = [], operands = [];
  let sawDoubleDash = false;
  for (const t of tokens) {
    if (!sawDoubleDash && t.text === '--' && !t.quoted) { sawDoubleDash = true; continue; }
    if (!sawDoubleDash && t.text.startsWith('-') && !t.quoted && t.text !== '-') { flags.push(t.text); continue; }
    operands.push(t);
  }
  return { flags, operands };
}

// Analyze one full command string. Returns the first destructive collision:
// { level, cmd, typed, actual, parent } — or null when nothing provable.
//
// State model: `shell` is the set of candidate cwds the shell could be in
// (null = unknown), `lastStatus` is the last command's exit status
// ('ok' | 'fail' | 'unknown') and gates `&&` / `||` segments. `dirStack`
// mirrors pushd/popd; `subStack` snapshots the cwd at `(` and restores it at
// `)`; `createdDirs` remembers `mkdir` targets from earlier in the same line
// so a following `cd` into a not-yet-existing directory is still tracked.
function analyzeCommand(command, cwd, fsx = realFsx) {
  if (typeof command !== 'string' || !command.trim()) return null;
  let shell = cwd && path.isAbsolute(cwd) ? [cwd] : null;
  let lastStatus = 'ok';
  const dirStack = [], subStack = [], createdDirs = new Set();

  // Merge candidate sets; null means "no further information", so the known
  // side wins (its candidates still get checked — fail-closed).
  const union = (a, b) => {
    if (a === null) return b;
    if (b === null) return a;
    return [...new Set([...a, ...b])];
  };

  const segs = splitSegments(stripHeredocs(command));
  for (let si = 0; si < segs.length; si++) {
    const { text, connector } = segs[si];
    const nextConn = si + 1 < segs.length ? segs[si + 1].connector : null;

    const runs = connector === '&&' ? (lastStatus === 'ok' ? true : lastStatus === 'fail' ? false : 'maybe')
               : connector === '||' ? (lastStatus === 'fail' ? true : lastStatus === 'ok' ? false : 'maybe')
               : true;
    if (runs === false) continue; // this segment cannot execute

    if (/\$\(|`/.test(text)) { lastStatus = 'unknown'; continue; } // command substitution: not resolvable

    const raw = tokenize(text);
    let lo = 0, hi = raw.length;
    while (lo < hi && raw[lo].text === '(') { subStack.push(shell); lo++; }
    let closers = 0;
    while (hi > lo && raw[hi - 1].text === ')') { closers++; hi--; }
    const closeSubshells = () => {
      while (closers-- > 0) {
        if (subStack.length) shell = subStack.pop(); // `( … )` never moves the parent
        lastStatus = 'unknown';
      }
    };

    let tokens = commandTokens(raw.slice(lo, hi));
    let negated = false;
    for (let guard = 0; guard < raw.length && tokens.length; guard++) {
      const t = tokens[0].text;
      if (SHELL_KEYWORDS.has(t) || t === '!') {
        if (t === '!') negated = true;
        tokens = tokens.slice(1);
      } else if (PREFIX_CMDS.has(t)) {
        tokens = tokens.slice(1);
        while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0].text)) tokens = tokens.slice(1);
        while (tokens.length && tokens[0].text.startsWith('-')) tokens = tokens.slice(1);
      } else break;
    }
    if (!tokens.length) { closeSubshells(); continue; }
    const cmd = path.basename(tokens[0].text);

    // A `cd` followed by `&` (background) or `|` (pipeline) runs in a subshell
    // and never moves the parent — keep the old cwd, add the new fail-closed.
    const detached = nextConn === '&' || nextConn === '|';

    if (cmd === 'cd' || cmd === 'pushd') {
      const before = shell;
      const target = tokens[1];
      let afters = null, exists;
      if (cmd === 'cd' && !target) { afters = [os.homedir()]; exists = true; }
      else if (!target || hasUnresolvable(target.text) || target.text === '-') { afters = null; exists = undefined; }
      else {
        const dirs = shell === null ? [null] : shell;
        afters = [...new Set(dirs.map(d => resolveTarget(target.text, d, target.quoted)).filter(Boolean))];
        if (!afters.length) afters = null;
        if (afters === null) exists = undefined;
        else {
          const ex = afters.map(a => fsx.isDirectory(a) ? true : createdDirs.has(a) ? undefined : false);
          exists = ex.every(v => v === true) ? true : ex.every(v => v === false) ? false : undefined;
        }
      }
      if (cmd === 'pushd') dirStack.push(before);
      let newShell, newStatus;
      if (afters === null) { newShell = null; newStatus = 'unknown'; }
      else if (exists === true) { newShell = afters; newStatus = 'ok'; }
      else if (exists === false) { newShell = before; newStatus = 'fail'; }
      else { newShell = union(before, afters); newStatus = 'unknown'; }
      if (detached) { shell = union(before, newShell); lastStatus = 'ok'; }
      else if (runs === 'maybe') { shell = union(before, newShell); lastStatus = 'unknown'; }
      else { shell = newShell; lastStatus = negated ? 'unknown' : newStatus; }
      closeSubshells();
      continue;
    }
    if (cmd === 'popd') {
      if (dirStack.length) {
        const popped = dirStack.pop();
        shell = (runs === true && !detached) ? popped : union(popped, shell);
      } // popd on an empty stack fails: cwd unchanged
      lastStatus = 'unknown';
      closeSubshells();
      continue;
    }

    if (!['rm', 'rmdir', 'mv', 'mkdir', 'touch', 'find'].includes(cmd)) {
      lastStatus = 'unknown';
      closeSubshells();
      continue;
    }

    const dirs = shell === null ? [null] : shell;
    const check = (tok) => {
      if (hasGlob(tok) || hasUnresolvable(tok.text)) return null;
      for (const d of dirs) {
        const resolved = resolveTarget(tok.text, d, tok.quoted);
        if (!resolved) continue;
        const hit = findCollision(resolved, fsx);
        if (hit) return hit;
      }
      return null;
    };

    const { flags, operands } = splitArgs(tokens.slice(1));

    if (cmd === 'rm') {
      const recursive = flags.some(RECURSIVE_FLAG);
      const removesDirs = recursive || flags.some(DIR_FLAG);
      for (const tok of operands) {
        const hit = check(tok);
        if (!hit) continue;
        // Plain rm cannot remove a directory, so a dir-only collision is a no-op.
        if (hit.actualIsDir && !removesDirs) continue;
        return { level: recursive ? 'critical' : 'high', cmd: recursive ? 'rm -r' : 'rm', ...hit };
      }
    } else if (cmd === 'rmdir') {
      for (const tok of operands) {
        const hit = check(tok);
        if (hit) return { level: 'high', cmd: 'rmdir', ...hit };
      }
    } else if (cmd === 'mv' && operands.length >= 2) {
      // `mv -t DIR` / `--target-directory=DIR` moves INTO a directory
      // (contents preserved) and its last operand is a SOURCE — skip.
      const intoDir = flags.some(f => /^-[A-Za-z]*t$/.test(f) || f.startsWith('--target-directory'));
      if (!intoDir) {
        const dest = operands[operands.length - 1];
        // A case-only self-rename (source folds to dest) is the intended fix.
        const selfRename = operands.slice(0, -1).some((src) => {
          for (const d of dirs) {
            const s = resolveTarget(src.text, d, src.quoted), t = resolveTarget(dest.text, d, dest.quoted);
            if (s && t && path.dirname(s) === path.dirname(t) && path.basename(s).toLowerCase() === path.basename(t).toLowerCase()) return true;
          }
          return false;
        });
        if (!selfRename) {
          const hit = check(dest);
          // Overwriting a case-variant FILE clobbers data; moving INTO a
          // case-variant directory preserves contents.
          if (hit && !hit.actualIsDir) return { level: 'high', cmd: 'mv', ...hit };
        }
      }
    } else if (cmd === 'mkdir' || cmd === 'touch') {
      for (const tok of operands) {
        const hit = check(tok);
        if (hit) return { level: 'strict', cmd, ...hit };
      }
      if (cmd === 'mkdir') {
        // Remember what this line creates so a later `cd` into it is tracked.
        for (const tok of operands) for (const d of dirs) {
          const r = resolveTarget(tok.text, d, tok.quoted);
          if (r) createdDirs.add(r);
        }
      }
    } else if (cmd === 'find') {
      // `find <paths…> <expression>`: paths are the operands before the first
      // predicate (a token starting with '-'). Only destructive if the
      // expression deletes.
      const rest = tokens.slice(1);
      const predicateIdx = rest.findIndex(t => t.text.startsWith('-'));
      const paths = (predicateIdx === -1 ? rest : rest.slice(0, predicateIdx));
      const expr = predicateIdx === -1 ? [] : rest.slice(predicateIdx);
      const deletes = expr.some((t, i) =>
        t.text === '-delete' ||
        ((t.text === '-exec' || t.text === '-execdir') && /^(rm|unlink)$/.test(expr[i + 1]?.text || '')));
      if (deletes) {
        for (const tok of paths) {
          const hit = check(tok);
          if (hit) return { level: 'critical', cmd: 'find -delete', ...hit };
        }
      }
    }
    lastStatus = 'unknown';
    closeSubshells();
  }
  return null;
}

function checkCommand(command, cwd, safetyLevel = SAFETY_LEVEL, fsx = realFsx) {
  const hit = analyzeCommand(command, cwd, fsx);
  if (!hit) return { blocked: false };
  if (LEVELS[hit.level] > LEVELS[safetyLevel]) return { blocked: false };
  return { blocked: true, hit };
}

// ─── hook entrypoint ─────────────────────────────────────────────────────────

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    return console.log('{}');
  }
  if (data === null || typeof data !== 'object') data = {};

  const { tool_name, tool_input, session_id, cwd, permission_mode } = data;
  if (tool_name !== 'Bash' || !tool_input?.command) return console.log('{}');

  const result = checkCommand(tool_input.command, cwd);
  if (!result.blocked) return console.log('{}');

  const { hit } = result;
  const shouldAsk = ASK[hit.level] === true;
  const decision = shouldAsk ? 'ask' : 'deny';
  log({ level: shouldAsk ? 'ASK' : 'BLOCKED', id: 'case-collision', priority: hit.level, decision, cmd: tool_input.command, typed: hit.typed, actual: hit.actual, session_id, cwd, permission_mode });
  return console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: `${EMOJIS[hit.level]} [case-collision] ${hit.cmd} targets '${hit.typed}' but this case-insensitive directory contains '${hit.actual}' — same path on disk, so the differently-cased entry would be hit`,
    },
  }));
}

if (require.main === module) {
  main();
} else {
  module.exports = { SAFETY_LEVEL, LEVELS, ASK, stripHeredocs, splitSegments, tokenize, commandTokens, resolveTarget, findCollision, analyzeCommand, checkCommand, realFsx };
}
