/**
 * Host adapter: turns one agent's PreToolUse event into the Claude-shaped tool
 * calls the guards already check, and renders a verdict in that agent's format.
 *
 * Claude Code needs no translation. Codex sends shell calls as Claude does
 * (tool_name "Bash", tool_input.command) but makes every file edit through one
 * tool, apply_patch, whose tool_input.command is the whole patch text. Each
 * file in a patch becomes a Write (added file), an Edit (changed file, removed
 * lines as old_string, added lines as new_string) or an rm / mv shell call.
 *
 * parsePatch follows Codex's own parser (codex-rs/apply-patch, parser.rs and
 * streaming_parser.rs at rust-v0.169.0) line for line, including which lines
 * are fully trimmed and which only lose trailing whitespace. A reader that
 * splits a patch differently from Codex can be shown one file while Codex
 * writes another, so anything it does not read exactly is refused.
 */

const HOSTS = ['claude', 'codex'];

function hostFromArgv(argv) {
  const i = argv.indexOf('--host');
  const name = i >= 0 ? argv[i + 1] : undefined;
  return HOSTS.includes(name) ? name : 'claude';
}

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const ADD = '*** Add File: ';
const UPDATE = '*** Update File: ';
const DELETE = '*** Delete File: ';
const MOVE = '*** Move to: ';
const ENV_ID = '*** Environment ID: ';
const EOF_MARKER = '*** End of File';

// Rust's str::trim uses the Unicode White_Space property, which includes
// U+0085 and excludes U+FEFF; JavaScript's trim differs on both.
const WS = '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const LEAD = new RegExp(`^[${WS}]+`);
const TRAIL = new RegExp(`[${WS}]+$`);
const trimEnd = (s) => s.replace(TRAIL, '');
const trim = (s) => trimEnd(s).replace(LEAD, '');

// Rust's str::lines: split on \n, drop one trailing \r per line, no final empty line.
function rustLines(s) {
  if (s === '') return [];
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

const strictOk = (lines) => lines.length > 0 && trim(lines[0]) === BEGIN && trim(lines[lines.length - 1]) === END;

function patchLines(text) {
  const lines = rustLines(trim(text));
  if (strictOk(lines)) return lines;
  const [first] = lines;
  const last = lines[lines.length - 1];
  if (lines.length >= 4 && (first === '<<EOF' || first === "<<'EOF'" || first === '<<"EOF"') && last.endsWith('EOF')) {
    const inner = lines.slice(1, -1);
    if (strictOk(inner)) return inner;
  }
  return null;
}

// Returns { ok: true, ops } or { ok: false } for anything Codex itself would
// reject or that this reader cannot follow exactly.
function parsePatch(text) {
  if (typeof text !== 'string') return { ok: false };
  const lines = patchLines(text);
  if (!lines) return { ok: false };

  const ops = [];
  let mode = 'start';
  let op = null;
  let envSeen = false;
  // Update hunks keep Codex's chunk list: a chunk is empty until it gets a
  // context, added or removed line.
  const lastChunk = () => op.chunks[op.chunks.length - 1];
  const updateIsEmpty = () => mode === 'update' && (op.chunks.length === 0 || !lastChunk().lines);
  const header = (t) => {
    if (mode === 'started' && t.startsWith(ENV_ID)) {
      if (envSeen || trim(t.slice(ENV_ID.length)) === '') return 'bad';
      envSeen = true;
      return 'ok';
    }
    for (const [marker, kind] of [[END, 'end'], [ADD, 'add'], [DELETE, 'delete'], [UPDATE, 'update']]) {
      if (kind === 'end' ? t !== END : !t.startsWith(marker)) continue;
      if (updateIsEmpty()) return 'bad';
      if (kind === 'end') { mode = 'ended'; return 'ok'; }
      op = { kind, path: t.slice(marker.length), added: [], removed: [], chunks: [] };
      if (!op.path) return 'bad';
      ops.push(op);
      mode = kind;
      return 'ok';
    }
    return 'none';
  };
  const chunk = () => { if (op.chunks.length === 0) op.chunks.push({ lines: false, eof: false }); const c = lastChunk(); c.lines = true; return c; };

  for (const [i, line] of lines.entries()) {
    if (mode === 'start') { if (trim(line) !== BEGIN) return { ok: false }; mode = 'started'; continue; }
    // Codex hands the final line to finish(), which trims it fully before
    // comparing it with End Patch, whatever mode the parser is in.
    if (i === lines.length - 1 && trim(line) === END) {
      if (mode !== 'ended' && updateIsEmpty()) return { ok: false };
      mode = 'ended';
      continue;
    }
    if (mode === 'ended') { if (trim(line) !== '') return { ok: false }; continue; }
    if (mode !== 'update') {
      const h = header(trim(line));
      if (h === 'bad') return { ok: false };
      if (h === 'ok') continue;
      if (mode === 'add' && line.startsWith('+')) { op.added.push(line.slice(1)); continue; }
      return { ok: false };
    }
    // Update hunk: only trailing whitespace is ignored, so " *** End Patch" is a
    // context line here, exactly as in Codex.
    const u = trimEnd(line);
    const h = header(u);
    if (h === 'bad') return { ok: false };
    if (h === 'ok') continue;
    const last = op.chunks.length ? lastChunk() : null;
    if (last && last.eof) {
      if (u === '') continue;
      if (u !== '@@' && !u.startsWith('@@ ')) return { ok: false };
    }
    if (op.chunks.length === 0 && op.moveTo === undefined && u.startsWith(MOVE)) { op.moveTo = u.slice(MOVE.length); continue; }
    if (u === '@@' || u.startsWith('@@ ')) {
      if (last && !last.lines) return { ok: false };
      op.chunks.push({ lines: false, eof: false });
      continue;
    }
    if (u === EOF_MARKER) {
      if (last && !last.lines) return { ok: false };
      if (last) last.eof = true;
      continue;
    }
    if (line === '' || line.startsWith(' ')) { chunk(); continue; }
    if (line.startsWith('+')) { chunk(); op.added.push(line.slice(1)); continue; }
    if (line.startsWith('-')) { chunk(); op.removed.push(line.slice(1)); continue; }
    return { ok: false };
  }
  if (mode !== 'ended' || ops.length === 0) return { ok: false };
  return { ok: true, ops: ops.map(({ chunks, ...o }) => (o.moveTo === undefined ? (delete o.moveTo, o) : o)) };
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function callsForOps(ops) {
  const calls = [];
  for (const o of ops) {
    if (o.kind === 'add') calls.push({ tool: 'Write', input: { file_path: o.path, content: o.added.join('\n') } });
    if (o.kind === 'delete') {
      calls.push({ tool: 'Write', input: { file_path: o.path, content: '' } });
      calls.push({ tool: 'Bash', input: { command: `rm -- ${shellQuote(o.path)}` } });
    }
    if (o.kind === 'update') {
      calls.push({ tool: 'Edit', input: { file_path: o.path, old_string: o.removed.join('\n'), new_string: o.added.join('\n') } });
      if (o.moveTo) {
        calls.push({ tool: 'Bash', input: { command: `mv -- ${shellQuote(o.path)} ${shellQuote(o.moveTo)}` } });
        calls.push({ tool: 'Write', input: { file_path: o.moveTo, content: o.added.join('\n') } });
      }
    }
  }
  return calls;
}

// Detection is conservative, not a shell interpreter. Only the literal
// heredoc grammar below can supply patch text without shell evaluation.
// Any program that runs its arguments (timeout, eval, stdbuf, doas, env -S,
// find -exec, ...) can start apply_patch, and no list of such programs is
// complete, so the name counts wherever it stands as a word, including glued
// to a short option.
const RUNS_APPLY_PATCH = /(?:^|[^\w.-]|(?:^|[\s=])-[A-Za-z]+)(?:apply_patch|applypatch)(?![\w./-])/;

// Searches, listings and lookups read their arguments as text or file names
// and never run them.
const LITERAL_COMMANDS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'echo', 'printf', 'cat', 'head', 'tail', 'ls', 'which']);
const LITERAL_GIT = new Set(['commit', 'grep', 'log', 'show', 'diff', 'blame']);

// These commands consume literal arguments rather than shell programs. Only
// exempt simple commands joined by ; && || or newlines, never substitutions,
// redirects or pipelines, and only when every one naming apply_patch is one.
function literalMention(command) {
  const segments = [[]];
  let words = segments[0];
  let word = '', quote = null, started = false;
  const push = () => { if (started) words.push(word); word = ''; started = false; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") {
      if (c === quote) quote = null; else word += c;
      continue;
    }
    if (c === '$' || c === '`') return false;
    if (c === '\\') {
      if (i + 1 >= command.length || command[i + 1] === '\n') return false;
      word += command[++i]; started = true; continue;
    }
    if (quote === '"') {
      if (c === quote) quote = null; else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    const pair = (c === '&' || c === '|') && command[i + 1] === c;
    if (c === ';' || c === '\n' || pair) {
      push();
      if (pair) i++;
      words = [];
      segments.push(words);
      continue;
    }
    if (/[&|<>(){}\r]/.test(c)) return false;
    if (/[ \t]/.test(c)) { push(); continue; }
    word += c; started = true;
  }
  if (quote) return false;
  push();
  const literal = (w) => {
    if (w[0] === 'rg' && w.some((x) => /^--(?:pre|hostname-bin)(?:=|$)/.test(x))) return false;
    return LITERAL_COMMANDS.has(w[0]) || (w[0] === 'git' && LITERAL_GIT.has(w[1]));
  };
  return segments.every((w) => literal(w) || !w.some((x) => RUNS_APPLY_PATCH.test(x)));
}

// Consume the entire command as literal, quoted heredocs. Patch marker text
// inside file content must never delimit the shell's input.
function patchBlocks(command) {
  const blocks = [];
  let rest = command.replace(/^[ \t\n]+/, '');
  while (rest) {
    const start = /^(?:apply_patch|applypatch)[ \t]+<<[ \t]*(['"])([A-Za-z_]\w*)\1[ \t]*\n/.exec(rest);
    if (!start) return null;
    const lines = rest.slice(start[0].length).split('\n');
    const end = lines.indexOf(start[2]);
    if (end < 0) return null;
    blocks.push(lines.slice(0, end).join('\n'));
    rest = lines.slice(end + 1).join('\n').replace(/^[ \t\n]+/, '');
  }
  return blocks;
}

// Returns a list of { tool, input } calls to check, or a list holding
// { unreadable: true } when an edit cannot be read. An empty list means no opinion.
function codexCalls(event) {
  const tool = event && event.tool_name;
  const input = (event && event.tool_input) || {};
  if (tool === 'spawn_agent' || tool === 'collaborationspawn_agent') return [{ tool: 'Agent', input }];
  if (tool === 'Bash') {
    const calls = [{ tool: 'Bash', input }];
    const command = typeof input.command === 'string' ? input.command : '';
    const names = command.replace(/\\\r?\n/g, '').replace(/['"\\]/g, '');
    if (literalMention(command) || !RUNS_APPLY_PATCH.test(names)) return calls;
    const blocks = patchBlocks(command);
    if (!blocks || blocks.length === 0) return [...calls, { unreadable: true }];
    for (const block of blocks) {
      const parsed = parsePatch(block);
      if (!parsed.ok) return [...calls, { unreadable: true }];
      calls.push(...callsForOps(parsed.ops));
    }
    return calls;
  }
  if (tool === 'apply_patch') {
    const text = typeof input.command === 'string' ? input.command : input.input;
    const parsed = parsePatch(text);
    return parsed.ok ? callsForOps(parsed.ops) : [{ unreadable: true }];
  }
  return [];
}

const UNREADABLE_REASON = '[unreadable-patch] The guard could not read this patch in full, so it cannot check the edit. Use the native apply_patch tool or a plain apply_patch command with a quoted heredoc, or make the edit yourself.';

const ASK_ON_CODEX = ' This guard is set to ask, and Codex hooks cannot ask, so it is blocked. Run it yourself if you meant it.';

// Codex: block is exit 2 with a non-empty reason on stderr, allow is exit 0
// with nothing on stdout. Codex ignores a deny whose reason is empty.
function codexAnswer(reason) {
  return reason ? { exitCode: 2, stderr: reason.trim() + '\n', stdout: '' } : { exitCode: 0, stderr: '', stdout: '' };
}

module.exports = { HOSTS, hostFromArgv, parsePatch, callsForOps, patchBlocks, codexCalls, codexAnswer, RUNS_APPLY_PATCH, UNREADABLE_REASON, ASK_ON_CODEX };
