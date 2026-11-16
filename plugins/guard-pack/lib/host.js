/**
 * Host adapter: turns one agent's PreToolUse event into the Claude-shaped tool
 * calls the guards already check, and renders a verdict in that agent's format.
 *
 * Claude Code needs no translation. Codex sends shell calls as Claude does
 * (tool_name "Bash", tool_input.command) but makes every file edit through one
 * tool, apply_patch, whose tool_input.command is the whole patch text. Each
 * file in a patch becomes a Write (added file), an Edit (changed file, removed
 * lines as old_string, added lines as new_string) or an rm / mv shell call.
 */

const HOSTS = ['claude', 'codex'];

function hostFromArgv(argv) {
  const i = argv.indexOf('--host');
  const name = i >= 0 ? argv[i + 1] : undefined;
  return HOSTS.includes(name) ? name : 'claude';
}

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const FILE_MARKERS = [['*** Add File:', 'add'], ['*** Update File:', 'update'], ['*** Delete File:', 'delete']];
const MOVE = '*** Move to:';
const isIgnoredMarker = (t) => t === '*** End of File' || t.startsWith('*** Environment ID:');

// Returns { ok: true, ops } or { ok: false } when the text is not a patch
// guard-pack can read in full. Markers may carry surrounding whitespace, as
// Codex's own parser allows.
function parsePatch(text) {
  if (typeof text !== 'string') return { ok: false };
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === BEGIN);
  if (start < 0) return { ok: false };
  const ops = [];
  let op = null;
  let ended = false;
  for (let i = start + 1; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (t === END) { ended = true; break; }
    if (t.startsWith('***')) {
      const file = FILE_MARKERS.find(([m]) => t.startsWith(m));
      if (file) { op = { kind: file[1], path: t.slice(file[0].length).trim(), added: [], removed: [] }; ops.push(op); continue; }
      if (t.startsWith(MOVE)) {
        if (!op || op.kind !== 'update') return { ok: false };
        op.moveTo = t.slice(MOVE.length).trim();
        continue;
      }
      if (isIgnoredMarker(t)) continue;
      return { ok: false };
    }
    if (!op) { if (t === '') continue; return { ok: false }; }
    if (raw.startsWith('+')) op.added.push(raw.slice(1));
    else if (raw.startsWith('-')) op.removed.push(raw.slice(1));
  }
  if (!ended || ops.length === 0 || ops.some((o) => !o.path)) return { ok: false };
  return { ok: true, ops };
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function callsForOps(ops) {
  const calls = [];
  for (const o of ops) {
    if (o.kind === 'add') calls.push({ tool: 'Write', input: { file_path: o.path, content: o.added.join('\n') } });
    if (o.kind === 'delete') calls.push({ tool: 'Bash', input: { command: `rm -- ${shellQuote(o.path)}` } });
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

// A shell command can run apply_patch itself (apply_patch <<'EOF' ... EOF).
// Returns the patch text when the command carries one, else null.
function embeddedPatch(command) {
  if (typeof command !== 'string') return null;
  const s = command.indexOf(BEGIN);
  if (s < 0) return null;
  const e = command.indexOf(END, s);
  return e < 0 ? command.slice(s) : command.slice(s, e + END.length);
}

// Returns a list of { tool, input } calls to check, or [{ unreadable: true }]
// when an edit cannot be read. An empty list means no opinion.
function codexCalls(event) {
  const tool = event && event.tool_name;
  const input = (event && event.tool_input) || {};
  if (tool === 'Bash') {
    const calls = [{ tool: 'Bash', input }];
    const patch = embeddedPatch(input.command);
    if (patch !== null) {
      const parsed = parsePatch(patch);
      calls.push(...(parsed.ok ? callsForOps(parsed.ops) : [{ unreadable: true }]));
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

const UNREADABLE_REASON = '[unreadable-patch] guard-pack could not read this apply_patch input, so it cannot check the edit. Update guard-pack, or make the edit yourself.';

const ASK_ON_CODEX = ' This guard is set to ask, and Codex hooks cannot ask, so it is blocked. Run it yourself if you meant it.';

// Codex: block is exit 2 with a non-empty reason on stderr, allow is exit 0
// with nothing on stdout. Codex ignores a deny whose reason is empty.
function codexAnswer(reason) {
  return reason ? { exitCode: 2, stderr: reason.trim() + '\n', stdout: '' } : { exitCode: 0, stderr: '', stdout: '' };
}

module.exports = { HOSTS, hostFromArgv, parsePatch, callsForOps, embeddedPatch, codexCalls, codexAnswer, UNREADABLE_REASON, ASK_ON_CODEX };
