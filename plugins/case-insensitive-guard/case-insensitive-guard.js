#!/usr/bin/env node
/**
 * Case-Insensitive Filesystem Guard - PreToolUse Hook for Bash
 * On case-insensitive filesystems (APFS default, exFAT, NTFS), `Content` and
 * `content` are the same path: so `rm -rf content` silently destroys
 * `Content` (see anthropics/claude-code#37875). This hook resolves the real
 * target directory of destructive commands and denies the ones that would hit
 * a case-variant of what was typed. Logs to: ~/.claude/hooks-logs/
 *
 * Idea credit: @yurukusa (https://github.com/karanb192/claude-code-hooks/pull/8)
 *
 * Covered commands: rm, rmdir, mv, mkdir, touch, `find <path> … -delete`
 * (also `find … -exec rm/unlink/rmdir`, by any path), and `xargs` fed by a
 * literal `echo` or by `find` (`find content -type f | xargs rm`). Every
 * component of a typed path is compared with the disk, so a miscased parent
 * (`content/sub` for `Content/sub`) counts too. Directory context is modeled
 * as a set of candidate cwds plus the last command's exit status: `cd`/`pushd`
 * move it
 * (honoring whether the target directory exists: including directories a
 * `mkdir` earlier in the same command line would create), `popd` restores the
 * matching `pushd`'s directory, a subshell `( … )` restores the outer cwd at
 * `)`, and connectors gate execution (`&&` runs only after success, `||` only
 * after failure, `;`/newline/`|`/`&` regardless: with `cd` in a background
 * (`&`) or pipeline (`|`) position not moving the parent shell). Heredoc
 * bodies, `#` comments and backslash-newline continuations are handled before
 * analysis, brace lists (`{a,b}`) are expanded, redirects are not targets, and
 * wrapper prefixes (`sudo`, `doas`, `env`, `exec`, `nohup`, `nice`, `timeout`,
 * `stdbuf`, `ionice`, `xargs`, …) are peeled off together with their options
 * (`sudo -u root`, `timeout 30`; `env -C DIR` moves the command's cwd).
 *
 * SAFETY_LEVEL: 'critical' | 'high' | 'strict' (default 'high')
 *   critical - recursive `rm -r/-rf` (and `find -delete`) onto a case-variant
 *   high     - + non-recursive deletes that really remove something
 *              (`rm` of a case-variant FILE, `rm -d`/`rmdir` of a case-variant
 *              dir, `mv` overwriting a case-variant FILE)
 *   strict   - + mkdir/touch onto an existing case-variant (usually a no-op,
 *              but often a sign the agent has the wrong name in mind)
 * Override via HOOK_SAFETY_LEVEL=critical|high|strict: prefer the env var over
 * editing this file (plugin updates overwrite it). Anything else falls back to
 * the default.
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
 *   allowed rather than guessed at. Literal targets beside them are checked.
 * - The session cwd as reported, and the home dir, are trusted as spelled:
 *   only path components beyond them are compared with the disk.
 * - Exact-case targets: `rm -rf Content` when `Content` exists as typed is an
 *   intentional delete, not a collision.
 * - A case-only rename (`mv readme.md README.md`) is the CANONICAL fix for a
 *   miscapitalized name: allowed, not blocked. `mv -t DIR`/`--target-directory`
 *   moves INTO a directory (contents preserved): allowed.
 * - Plain `rm` (no -r/-d) of a case-variant DIRECTORY: `rm` refuses to remove
 *   a directory, so nothing is destroyed → allowed.
 * - Heredoc bodies (`cat <<EOF … EOF`) are document text, not commands.
 * - Quoted `~` is a literal path character to the shell, so it is not
 *   tilde-expanded here either.
 * - When the semantics leave the run-directory ambiguous, every candidate
 *   directory is checked (fail-closed): a rare over-block is preferred to a
 *   silent data-loss miss.
 * - No probe files: case-insensitivity is proven by the collision itself -
 *   the typed name is absent from readdir() yet the path still exists.
 *
 * Install as a plugin (registration is automatic):
 *   /plugin install case-insensitive-guard@claude-code-hooks
 *
 * Or the classic way: copy the script and register it in .claude/settings.json:
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

// Default 'high'. HOOK_SAFETY_LEVEL overrides it without editing this file
// (plugin updates overwrite installed files; env survives them). Invalid
// values fall back to the default.
const DEFAULT_SAFETY_LEVEL = 'high';
const SAFETY_LEVEL = ['critical', 'high', 'strict'].includes(process.env.HOOK_SAFETY_LEVEL)
  ? process.env.HOOK_SAFETY_LEVEL
  : DEFAULT_SAFETY_LEVEL;

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

// Index just past a span the shell reads as one unit, starting at i: '…',
// "…", $'…', $(…), ${…}, `…`, <(…), >(…). -1 when none starts there. An
// unterminated span runs to the end (the shell rejects the line anyway).
function spanEnd(s, i) {
  const c = s[i], n = s[i + 1];
  if (c === "'") { const e = s.indexOf("'", i + 1); return e === -1 ? s.length : e + 1; }
  let j, close, open = null, nests;
  if (c === '"') { j = i + 1; close = '"'; nests = 'subst'; }
  else if (c === '`') { j = i + 1; close = '`'; nests = 'none'; }
  else if (c === '$' && n === "'") { j = i + 2; close = "'"; nests = 'none'; }
  else if ((c === '$' || c === '<' || c === '>') && n === '(') { j = i + 2; open = '('; close = ')'; nests = 'all'; }
  else if (c === '$' && n === '{') { j = i + 2; open = '{'; close = '}'; nests = 'all'; }
  else return -1;
  let depth = 0;
  while (j < s.length) {
    const d = s[j];
    if (d === '\\') { j += 2; continue; }
    if (depth === 0 && d === close) return j + 1;
    // Inside "…" only $(…), ${…} and `…` nest: a ' there is a literal character.
    if (nests === 'all' || (nests === 'subst' && (d === '`' || (d === '$' && (s[j + 1] === '(' || s[j + 1] === '{'))))) {
      const e = spanEnd(s, j);
      if (e !== -1) { j = e; continue; }
    }
    if (d === open) depth++;
    else if (d === close) depth--;
    j++;
  }
  return s.length;
}

// Prepare a command line for segmenting: join backslash-newline
// continuations, drop `#` comments, and remove heredoc bodies (`<<EOF … EOF`)
// so document text is never analyzed as commands. Honors quoted delimiters
// (spaces included), `<<-` tab stripping, and several heredocs queued on one
// line. A purely numeric "delimiter" is arithmetic (`((1<<2))`), not a heredoc.
function preprocess(command) {
  let out = '', i = 0, wordStart = true;
  const pending = []; // delimiters whose bodies start at the next newline
  while (i < command.length) {
    const c = command[i];
    if (c === '\\') {
      if (command[i + 1] !== '\n') { out += command.slice(i, i + 2); wordStart = false; }
      i += 2; continue;
    }
    const e = spanEnd(command, i);
    if (e !== -1) { out += command.slice(i, e); i = e; wordStart = false; continue; }
    // `#` opens a comment only at the start of a word (not `a#b`, `$#`, `\ #`).
    if (c === '#' && wordStart) {
      while (i < command.length && command[i] !== '\n') i++;
      continue;
    }
    if (c === '<' && command[i + 1] === '<' && command[i + 2] !== '<' && command[i - 1] !== '<') {
      let j = i + 2;
      if (command[j] === '-') j++;
      while (command[j] === ' ' || command[j] === '\t') j++;
      let delim = '';
      while (j < command.length && !/[\s;&|()<>]/.test(command[j])) {
        const d = command[j];
        if (d === "'" || d === '"') {
          let q = command.indexOf(d, j + 1);
          if (q === -1) q = command.length;
          delim += command.slice(j + 1, q); j = q + 1; continue;
        }
        if (d === '\\') { delim += command[j + 1] || ''; j += 2; continue; }
        delim += d; j++;
      }
      if (delim && !/^\d+$/.test(delim)) { pending.push(delim); out += ' '; i = j; continue; }
      out += c; i++; continue;
    }
    if (c === '\n' && pending.length) {
      out += '\n'; i++; wordStart = true;
      while (pending.length && i < command.length) {
        let eol = command.indexOf('\n', i);
        if (eol === -1) eol = command.length;
        if (command.slice(i, eol).replace(/^\t+/, '') === pending[0]) pending.shift();
        i = eol + 1;
      }
      continue;
    }
    out += c; i++;
    wordStart = /[\s;&|()<>]/.test(c);
  }
  return out;
}

// Split a command line into { text, connector } segments, where connector is
// the operator that PRECEDES the segment (null for the first). Operators inside
// quotes, substitutions or after a backslash are ignored. A single `&`
// (background) is a separator too: the command after it still runs; `&>`,
// `>&`, `<&` redirects are not.
function splitSegments(command) {
  const segments = [];
  let cur = '', connector = null;
  const push = (nextConnector) => {
    const text = cur.trim();
    if (text) segments.push({ text, connector });
    cur = '';
    connector = nextConnector;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '\\') { cur += command.slice(i, i + 2); i++; continue; }
    const e = spanEnd(command, i);
    if (e !== -1) { cur += command.slice(i, e); i = e - 1; continue; }
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

// Expand unquoted brace lists (`{a,b}`, `x{,-old}`) the way the shell does
// before the command sees them. Sequences (`{1..3}`) are left literal. Returns
// null past BRACE_LIMIT words: a partial list would leave the rest unchecked.
const BRACE_LIMIT = 64;
function expandBraces(word) {
  for (let a = 0; a < word.length; a++) {
    if (word[a] !== '{') continue;
    let depth = 0, b = -1;
    const commas = [];
    for (let k = a; k < word.length; k++) {
      if (word[k] === '{') depth++;
      else if (word[k] === '}') { if (--depth === 0) { b = k; break; } }
      else if (word[k] === ',' && depth === 1) commas.push(k);
    }
    if (b === -1) return [word];
    if (!commas.length) continue;
    const pre = word.slice(0, a), post = word.slice(b + 1), out = [];
    let from = a + 1;
    for (const k of [...commas, b]) {
      const sub = expandBraces(pre + word.slice(from, k) + post);
      if (!sub || out.length + sub.length > BRACE_LIMIT) return null;
      out.push(...sub);
      from = k + 1;
    }
    return out;
  }
  return [word];
}

// Tokenize one segment into words, respecting quotes, escapes and
// substitutions. Each token records whether any part was quoted or escaped
// (quoted globs and `~` are literal to the shell). Substitutions stay raw, so
// their `$` or backtick marks the word unresolvable, as does a brace list too
// large to expand (`unresolvable: true`). Unquoted `(` / `)` are
// shell operators and become standalone tokens even unspaced. Redirections
// (`>out`, `2>&1`, `<<<word`) and their targets are not arguments: dropped.
function tokenize(segment) {
  const tokens = [];
  let text = '', quoted = false, started = false, redirect = false;
  const push = () => {
    if (started) {
      if (redirect) redirect = false;
      else if (quoted || /[$`]/.test(text)) tokens.push({ text, quoted });
      else {
        const words = expandBraces(text);
        if (!words) tokens.push({ text, quoted, unresolvable: true });
        else for (const t of words) tokens.push({ text: t, quoted });
      }
    }
    text = ''; quoted = false; started = false;
  };
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (c === '\\') {
      if (i + 1 < segment.length) { text += segment[i + 1]; quoted = true; started = true; i++; }
      continue;
    }
    const e = spanEnd(segment, i);
    if (e !== -1) {
      const closed = e - 1 > i && segment[e - 1] === c;
      if (c === "'") text += segment.slice(i + 1, closed ? e - 1 : e);
      else if (c === '"') text += segment.slice(i + 1, closed ? e - 1 : e).replace(/\\([$`"\\\n])/g, (m, ch) => ch === '\n' ? '' : ch);
      else text += segment.slice(i, e);
      if (c === "'" || c === '"') quoted = true;
      started = true; i = e - 1; continue;
    }
    if (c === '<' || c === '>') {
      if (!quoted && /^(\d+|&)$/.test(text)) { text = ''; started = false; } else push();
      while (/[<>&|]/.test(segment[i + 1] || '')) i++;
      redirect = true;
      continue;
    }
    if (c === '(' || c === ')') { push(); tokens.push({ text: c, quoted: false }); continue; }
    if (/\s/.test(c)) { push(); continue; }
    text += c; started = true;
  }
  push();
  return tokens;
}

const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', '{', '}']);

// Wrappers that run their argument as the real command. `arg`: short options
// that take a value (so the value is not mistaken for the command); `long`:
// long options that take one as the next word; `skip`: positionals before the
// command (timeout's duration); `chdir`: options that set the command's cwd.
const TIMEOUT_OPTS = { arg: 'sk', long: ['signal', 'kill-after'], skip: 1 };
const WRAPPERS = {
  command: {}, builtin: {}, nohup: {},
  exec: { arg: 'a' },
  time: { arg: 'fo', long: ['format', 'output'] },
  env: { arg: 'uCSP', long: ['unset', 'chdir', 'split-string'], chdir: ['-C', '--chdir'] },
  sudo: { arg: 'ugpChrtTUDR', long: ['user', 'group', 'prompt', 'close-from', 'host', 'role', 'type', 'command-timeout', 'other-user', 'chdir', 'chroot'], chdir: ['-D', '--chdir'] },
  doas: { arg: 'uC' },
  nice: { arg: 'n', long: ['adjustment'] },
  timeout: TIMEOUT_OPTS, gtimeout: TIMEOUT_OPTS,
  stdbuf: { arg: 'ioe', long: ['input', 'output', 'error'] },
  ionice: { arg: 'cnp', long: ['class', 'classdata', 'pid'] },
  caffeinate: { arg: 'tw' },
  xargs: { arg: 'IJELnPsdaRS', long: ['arg-file', 'delimiter', 'max-args', 'max-procs', 'max-chars', 'process-slot-var'] },
};
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Peel env assignments, shell keywords, `!` and wrapper prefixes (with their
// options) off a token list. Reports a wrapper's working-directory option and,
// for xargs, its replacement string, since both change what the command hits.
function peelWrappers(tokens) {
  let chdir = null, xargs = null, negated = false;
  for (let guard = 0; guard < 1000 && tokens.length; guard++) {
    let lead = 0;
    while (lead < tokens.length && ENV_ASSIGN.test(tokens[lead].text)) lead++;
    tokens = tokens.slice(lead);
    if (!tokens.length) break;
    const t = tokens[0].text;
    if (SHELL_KEYWORDS.has(t) || t === '!') {
      if (t === '!') negated = true;
      tokens = tokens.slice(1);
      continue;
    }
    const name = path.basename(t);
    const w = WRAPPERS[name];
    if (!w) break;
    const opts = [];
    let i = 1;
    while (i < tokens.length) {
      const a = tokens[i].text;
      if (a === '--') { i++; break; }
      if (!a.startsWith('-') || a === '-') break;
      i++;
      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        const nm = a.slice(0, eq === -1 ? undefined : eq);
        if (eq !== -1) opts.push([nm, a.slice(eq + 1)]);
        else if ((w.long || []).includes(nm.slice(2))) { opts.push([nm, tokens[i]?.text]); i++; }
        else opts.push([nm, null]);
        continue;
      }
      if (name === 'xargs' && /^-[iel]/.test(a)) { opts.push([a.slice(0, 2), a.slice(2)]); continue; }
      for (let k = 1; k < a.length; k++) {
        if (!(w.arg || '').includes(a[k])) { opts.push(['-' + a[k], null]); continue; }
        if (k + 1 < a.length) opts.push(['-' + a[k], a.slice(k + 1)]);
        else { opts.push(['-' + a[k], tokens[i]?.text]); i++; }
        break;
      }
    }
    for (let s = 0; s < (w.skip || 0) && i < tokens.length; s++) i++;
    for (const [f, v] of opts) if ((w.chdir || []).includes(f) && v) chdir = v;
    if (name === 'xargs') {
      // How input splits into arguments: on blanks by default (-L and -J
      // too), whole lines for -I/-i/--replace, NULs for -0, a given -d char.
      xargs = { repl: null, split: 'blank', delim: null };
      for (const [f, v] of opts) {
        if ((f === '-I' || f === '-i' || f === '--replace') && (v || f !== '-I')) { xargs.repl = v || '{}'; xargs.split = 'line'; }
        else if (f === '-J' && v) xargs.repl = v;
        else if (f === '-0' || f === '--null') xargs.split = 'nul';
        else if ((f === '-d' || f === '--delimiter') && v) { xargs.split = 'delim'; xargs.delim = v === '\\n' ? '\n' : v === '\\t' ? '\t' : v[0]; }
      }
    }
    tokens = tokens.slice(i);
  }
  return { tokens, chdir, xargs, negated };
}

// `find [-H|-L|-P|-E|-X|-s|-x|-d|-D opts|-O<n>|-f path]… <paths…> <expression>`:
// leading options come before the paths, which run to the first predicate,
// `(` or `!`.
function findArgs(rest) {
  const paths = [];
  let i = 0;
  while (i < rest.length) {
    const t = rest[i].text;
    if (/^-[HLPEXsxd]+$/.test(t) || /^-O\d*$/.test(t)) { i++; continue; }
    if (t === '-D') { i += 2; continue; }
    if (t === '-f') { if (rest[i + 1]) paths.push(rest[i + 1]); i += 2; continue; }
    break;
  }
  while (i < rest.length && !/^[-(!]/.test(rest[i].text)) paths.push(rest[i++]);
  return { paths, expr: rest.slice(i) };
}

const DELETERS = /^(rm|unlink|rmdir)$/;
const FIND_EXEC = /^-(exec|execdir|ok|okdir)$/;

// The -exec/-ok clauses of a find expression: { at, cmd, args } up to `;`/`+`.
function findExecs(expr) {
  const out = [];
  for (let i = 0; i < expr.length; i++) {
    if (!FIND_EXEC.test(expr[i].text)) continue;
    let j = i + 1;
    while (j < expr.length && expr[j].text !== ';' && expr[j].text !== '+') j++;
    out.push({ at: i, end: j, cmd: path.basename(expr[i + 1]?.text || ''), args: expr.slice(i + 2, j) });
    i = j;
  }
  return out;
}

// Does find write the matched paths to stdout? -print, -print0, a -printf
// with %p/%P, an -exec/-ok that passes {} on, or no action at all (the
// implicit -print). A fixed -printf or -fprint string is not a matched path.
function findPrintsPaths(expr) {
  const execs = findExecs(expr);
  if (execs.some(e => e.args.some(a => a.text.includes('{}')))) return true;
  let action = execs.length > 0;
  for (let i = 0; i < expr.length; i++) {
    const t = expr[i].text;
    const ex = execs.find(e => e.at === i);
    if (ex) { i = ex.end; continue; }
    if (t === '-print' || t === '-print0') return true;
    if (t === '-printf' && /%[pP]/.test(expr[i + 1]?.text || '')) return true;
    if (/^-(printf|fprint0?|fprintf|ls|fls|delete|quit)$/.test(t)) action = true;
    if (/^-(printf|fprint0?|fls)$/.test(t)) i++;
    else if (t === '-fprintf') i += 2;
  }
  return !action;
}

// What `echo ARGS` writes, split the way xargs reads it. Records the shell
// output cannot pin down (globbed args, backslashes that some echos expand,
// quotes xargs would reinterpret) are left out.
function xargsItems(echoArgs, mode) {
  let k = 0, newline = true;
  while (k < echoArgs.length && /^-[neE]+$/.test(echoArgs[k].text)) { if (echoArgs[k].text.includes('n')) newline = false; k++; }
  let args = echoArgs.slice(k);
  if (args.some(hasGlob)) {
    if (mode.split !== 'blank') return [];
    args = args.filter(t => !hasGlob(t));
  }
  const output = args.map(t => t.text).join(' ') + (newline ? '\n' : '');
  let records;
  if (mode.split === 'nul') records = output.split('\0');
  else if (mode.split === 'delim') records = output.split(mode.delim);
  else if (mode.split === 'line') records = output.split('\n').flatMap(l => [l.replace(/^[ \t]+/, ''), l.trim()]);
  else records = output.split(/[ \t\n]+/);
  const literal = mode.split === 'nul' || mode.split === 'delim';
  return [...new Set(records)]
    .filter(r => r && !r.includes('\\') && (literal || !/['"]/.test(r)))
    .map(text => ({ text, quoted: true })); // xargs never globs or expands ~
}

function hasUnresolvable(text) { return /[$`]|^[<>]\(/.test(text); }
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

// A collision exists when some component of the typed path is NOT an on-disk
// entry of its parent, yet a differently-cased entry is: and the typed path
// still exists (proving the volume folds case, no probe file needed). A
// miscased parent (`content/sub` for `Content/sub`) counts as much as a
// miscased leaf. Components shared with a trusted root (the session cwd, the
// home dir) are not checked: that cwd can itself be spelled in another case
// than the disk (`cd ~/github` into `GitHub`), and that is not the agent's typo.
function findCollision(resolved, fsx, roots = []) {
  const { root } = path.parse(resolved);
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let trusted = 0;
  for (const r of roots) {
    if (!r || !path.isAbsolute(r) || path.parse(r).root !== root) continue;
    const rp = r.slice(root.length).split(path.sep).filter(Boolean);
    let k = 0;
    while (k < rp.length && k < parts.length && rp[k] === parts[k]) k++;
    trusted = Math.max(trusted, k);
  }
  for (let i = trusted; i < parts.length; i++) {
    const parent = root + parts.slice(0, i).join(path.sep);
    const entries = fsx.listDir(parent);
    if (!entries || entries.includes(parts[i])) continue;
    const variant = entries.find(e => e.toLowerCase() === parts[i].toLowerCase());
    if (!variant) return null;
    if (!fsx.pathExists(resolved)) return null; // case-sensitive volume: harmless miss
    return { typed: parts[i], actual: variant, parent, actualIsDir: fsx.isDirectory(resolved) };
  }
  return null;
}

const RECURSIVE_FLAG = (f) => /^-[A-Za-z]*[rR]/.test(f) || f === '--recursive';
const DIR_FLAG = (f) => /^-[A-Za-z]*d/.test(f) || f === '--dir';

// Split flags from operands for a token list (POSIX `--` ends option parsing).
// Quoting does not matter here: the command still sees `"-rf"` as a flag.
function splitArgs(tokens) {
  const flags = [], operands = [];
  let sawDoubleDash = false;
  for (const t of tokens) {
    if (!sawDoubleDash && t.text === '--') { sawDoubleDash = true; continue; }
    if (!sawDoubleDash && t.text.startsWith('-') && t.text !== '-') { flags.push(t.text); continue; }
    operands.push(t);
  }
  return { flags, operands };
}

// Analyze one full command string. Returns the first destructive collision:
// { level, cmd, typed, actual, parent }: or null when nothing provable.
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
  // side wins (its candidates still get checked: fail-closed).
  const union = (a, b) => {
    if (a === null) return b;
    if (b === null) return a;
    return [...new Set([...a, ...b])];
  };

  const roots = [cwd, os.homedir()];
  const segs = splitSegments(preprocess(command));
  let pipeSrc = null; // the previous segment's command, read by a piped xargs
  for (let si = 0; si < segs.length; si++) {
    const { text, connector } = segs[si];
    const nextConn = si + 1 < segs.length ? segs[si + 1].connector : null;
    const src = connector === '|' ? pipeSrc : null;
    pipeSrc = null;

    const runs = connector === '&&' ? (lastStatus === 'ok' ? true : lastStatus === 'fail' ? false : 'maybe')
               : connector === '||' ? (lastStatus === 'fail' ? true : lastStatus === 'ok' ? false : 'maybe')
               : true;
    if (runs === false) continue; // this segment cannot execute

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

    const peeled = peelWrappers(raw.slice(lo, hi).filter(t => t.quoted || (t.text !== '(' && t.text !== ')')));
    let tokens = peeled.tokens;
    const negated = peeled.negated;
    if (!tokens.length) { closeSubshells(); continue; }
    const cmd = path.basename(tokens[0].text);
    pipeSrc = { cmd, args: tokens.slice(1) };

    // A `cd` followed by `&` (background) or `|` (pipeline) runs in a subshell
    // and never moves the parent: keep the old cwd, add the new fail-closed.
    const detached = nextConn === '&' || nextConn === '|';

    if (cmd === 'cd' || cmd === 'pushd') {
      const before = shell;
      const target = tokens[1];
      // `cd "$(git rev-parse --show-toplevel)"` usually lands where we already
      // are, so keep checking the current cwd rather than forgetting it.
      if (target && /\$\(|`/.test(target.text)) { lastStatus = 'unknown'; closeSubshells(); continue; }
      let afters = null, exists;
      if (cmd === 'cd' && !target) { afters = [os.homedir()]; exists = true; }
      else if (!target || target.unresolvable || hasUnresolvable(target.text) || target.text === '-') { afters = null; exists = undefined; }
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

    let dirs = shell === null ? [null] : shell;
    if (peeled.chdir) { // `env -C DIR` / `sudo -D DIR` run the command there
      dirs = [...new Set(dirs.map(d => resolveTarget(peeled.chdir, d)).filter(Boolean))];
      if (!dirs.length) dirs = [null];
    }
    const check = (tok) => {
      if (tok.unresolvable || hasGlob(tok) || hasUnresolvable(tok.text)) return null;
      for (const d of dirs) {
        const resolved = resolveTarget(tok.text, d, tok.quoted);
        if (!resolved) continue;
        const hit = findCollision(resolved, fsx, roots);
        if (hit) return hit;
      }
      return null;
    };

    // xargs appends what the pipe feeds it, or substitutes it for -I's string.
    // Only literal feeds are modeled: `echo WORDS`, and `find PATHS …`, whose
    // output lies under PATHS, so deleting it is a delete under those paths.
    if (peeled.xargs && src) {
      const found = src.cmd === 'find' ? findArgs(src.args) : null;
      if (found && DELETERS.test(cmd) && findPrintsPaths(found.expr)) {
        for (const tok of found.paths) {
          const hit = check(tok);
          if (hit) return { level: 'critical', cmd: `find | xargs ${cmd}`, ...hit };
        }
      } else if (src.cmd === 'echo') {
        const items = xargsItems(src.args, peeled.xargs);
        const repl = peeled.xargs.repl;
        tokens = repl
          ? [tokens[0], ...tokens.slice(1).flatMap(t => t.text.includes(repl)
            ? items.map(it => ({ text: t.text.split(repl).join(it.text), quoted: t.quoted || it.quoted }))
            : [t])]
          : [...tokens, ...items];
      }
    }

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
      // (contents preserved) and its last operand is a SOURCE: skip.
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
      // Only destructive if the expression deletes: -delete, or -exec /
      // -execdir / -ok / -okdir running rm, unlink or rmdir (any path to them)
      // with {} among its arguments; without {} it never sees a matched path.
      const { paths, expr } = findArgs(tokens.slice(1));
      const deletes = expr.some(t => t.text === '-delete') ||
        findExecs(expr).some(e => DELETERS.test(e.cmd) && e.args.some(a => a.text.includes('{}')));
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

// A check that throws must not read as an allow, so the call is denied.
// HOOK_FAIL_OPEN=true restores the old allow-on-error behaviour.
function guardError(e) {
  if (process.env.HOOK_FAIL_OPEN === 'true') return '{}';
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `🚨 [guard-error] case-insensitive-guard could not check this call (${String(e && e.message).slice(0, 200)}), so it is blocked. Run it yourself if you meant it, or set HOOK_FAIL_OPEN=true to let calls through when a guard fails.`,
    },
  });
}

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
      permissionDecisionReason: `${EMOJIS[hit.level]} [case-collision] ${hit.cmd} targets '${hit.typed}' but this case-insensitive directory contains '${hit.actual}': same path on disk, so the differently-cased entry would be hit`,
    },
  }));
}

if (require.main === module) {
  main().catch((e) => {
    log({ level: 'ERROR', error: e.message });
    console.log(guardError(e));
  });
} else {
  module.exports = { SAFETY_LEVEL, LEVELS, ASK, preprocess, splitSegments, tokenize, peelWrappers, resolveTarget, findCollision, analyzeCommand, checkCommand, realFsx };
}
