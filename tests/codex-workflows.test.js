const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-workflows-')));
const home = path.join(temp, 'home');
const codexHome = path.join(home, 'codex');
const names = ['auto-stage', 'format-code', 'session-logger'];
fs.mkdirSync(codexHome, { recursive: true });
for (const name of names) fs.cpSync(path.join(root, 'plugins', name), path.join(temp, name), { recursive: true });
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome };
delete env.CC_SESSION_LOG_DIR;
delete env.CC_SESSION_BASH_TRUNCATE;
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
function repo() {
  const dir = fs.mkdtempSync(path.join(temp, 'repo-'));
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'old.txt'), 'old\n');
  fs.writeFileSync(path.join(dir, 'move.txt'), 'move\n');
  fs.mkdirSync(path.join(dir, 'gone'));
  fs.writeFileSync(path.join(dir, 'gone/last.txt'), 'delete\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.txt\n');
  git(dir, 'add', '.');
  git(dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  return dir;
}
const patch = (...lines) => ({ hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: { command: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') } });
function run(name, data, extra = {}) {
  const result = spawnSync(process.execPath, [path.join(temp, name, 'codex.js')], {
    env: { ...env, ...extra }, cwd: temp, input: JSON.stringify({ cwd: temp, session_id: 'fixture', ...data }), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
}

for (const name of names) {
  test(`${name} installs alone with native manifests and identical vendored adapters`, () => {
    const dir = path.join(temp, name);
    const m = JSON.parse(fs.readFileSync(path.join(dir, '.codex-plugin/plugin.json')));
    assert.equal(m.version, JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin/plugin.json'))).version);
    const h = JSON.parse(fs.readFileSync(path.join(dir, m.hooks))).hooks;
    assert.equal(h.PostToolUse[0].hooks[0].command, 'node "${PLUGIN_ROOT}/codex.js"');
    assert.equal(h.PostToolUse[0].hooks[0].async, undefined);
    if (name === 'session-logger') assert.deepEqual(Object.keys(h), ['SessionStart', 'PostToolUse', 'SessionEnd']);
    for (const f of ['host.js', 'codex-workflow.js']) {
      const source = f === 'host.js' ? 'guard-pack' : 'auto-stage';
      assert.equal(fs.readFileSync(path.join(dir, 'lib', f), 'utf8'), fs.readFileSync(path.join(root, 'plugins', source, 'lib', f), 'utf8'));
    }
    run(name, { hook_event_name: 'Unrelated', tool_name: 'Read', tool_input: {} });
  });
}

test('stages native add/update/delete/move paths and no unrelated edits', () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'new.txt'), 'new\n');
  fs.writeFileSync(path.join(dir, 'old.txt'), 'changed\n');
  fs.renameSync(path.join(dir, 'move.txt'), path.join(dir, 'moved.txt'));
  fs.rmSync(path.join(dir, 'gone'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'untouched');
  run('auto-stage', { cwd: dir, ...patch('*** Add File: new.txt', '+new', '*** Update File: old.txt', '@@', '-old', '+changed', '*** Delete File: gone/last.txt', '*** Update File: move.txt', '*** Move to: moved.txt', '@@', '-move', '+move') });
  assert.deepEqual(git(dir, 'diff', '--cached', '--name-only', '--no-renames', '-z').split('\0').filter(Boolean).sort(), ['gone/last.txt', 'move.txt', 'moved.txt', 'new.txt', 'old.txt']);
});

test('staging treats metacharacters and git pathspecs as literal filenames', () => {
  const dir = repo();
  const files = ['odd[1].txt', 'odd1.txt', '-option.txt', '$(touch pwned).txt', 'quote\"file.txt'];
  for (const file of files) fs.writeFileSync(path.join(dir, file), 'value');
  const selected = files.filter((f) => f !== 'odd1.txt');
  run('auto-stage', { cwd: dir, ...patch(...selected.flatMap((f) => [`*** Add File: ${f}`, '+value'])) });
  assert.deepEqual(git(dir, 'diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean).sort(), selected.sort());
  assert.equal(fs.existsSync(path.join(dir, 'pwned')), false);
});

test('staging respects ignores and skips shell writes, failure events and unreadable patches', () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'ignored.txt'), 'private');
  fs.writeFileSync(path.join(dir, 'old.txt'), 'changed');
  run('auto-stage', { cwd: dir, ...patch('*** Add File: ignored.txt', '+private') });
  run('auto-stage', { cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'echo changed > old.txt' } });
  run('auto-stage', { cwd: dir, ...patch('*** Update File: old.txt', '@@', '-old', '+changed'), hook_event_name: 'PostToolUseFailure' });
  run('auto-stage', { cwd: dir, ...patch('not a patch') });
  assert.equal(git(dir, 'diff', '--cached', '--name-only'), '');
});

test('formatting sends only existing patch targets to local executables without a shell', () => {
  const dir = repo(), bin = path.join(dir, 'bin'), calls = path.join(dir, 'calls.jsonl');
  fs.mkdirSync(bin);
  const script = `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(1))+'\\n');\n`;
  for (const command of ['ruff', 'prettier']) fs.writeFileSync(path.join(bin, command), script, { mode: 0o755 });
  for (const name of ['new.py', 'out.js', 'unrelated.js', 'note.txt', '$(touch pwned).json']) fs.writeFileSync(path.join(dir, name), 'value');
  fs.symlinkSync(path.join(dir, 'unrelated.js'), path.join(dir, 'link.js'));
  run('format-code', { cwd: dir, ...patch('*** Add File: new.py', '+value', '*** Update File: old.js', '*** Move to: out.js', '@@', '-old', '+value', '*** Delete File: deleted.py', '*** Add File: note.txt', '+value', '*** Add File: $(touch pwned).json', '+value', '*** Add File: link.js', '+value') }, { PATH: bin });
  const args = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(args.length, 4);
  assert.deepEqual(args.map((a) => path.basename(a[0])), ['ruff', 'ruff', 'prettier', 'prettier']);
  assert.deepEqual(args.map((a) => path.basename(a.at(-1))), ['new.py', 'new.py', 'out.js', '$(touch pwned).json']);
  assert.equal(fs.existsSync(path.join(dir, 'pwned')), false);
});

test('a missing formatter does not block or alter the file', () => {
  const dir = repo(); fs.writeFileSync(path.join(dir, 'new.py'), 'value');
  run('format-code', { cwd: dir, ...patch('*** Add File: new.py', '+value') }, { PATH: '/nonexistent' });
  assert.equal(fs.readFileSync(path.join(dir, 'new.py'), 'utf8'), 'value');
});

test('a directory target cannot stage unrelated files beneath it', () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, 'directory'));
  fs.writeFileSync(path.join(dir, 'directory/unrelated.txt'), 'unrelated');
  run('auto-stage', { cwd: dir, ...patch('*** Delete File: directory') });
  assert.equal(git(dir, 'diff', '--cached', '--name-only'), '');
});

test('a busy session note is never written without its lock', () => {
  const notes = path.join(temp, 'locked');
  const extra = { CC_SESSION_LOG_DIR: notes };
  run('session-logger', { hook_event_name: 'SessionStart', session_id: 'locked' }, extra);
  const file = path.join(notes, fs.readdirSync(notes)[0]);
  const before = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file + '.lock', '');
  run('session-logger', { hook_event_name: 'SessionEnd', session_id: 'locked' }, extra);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  fs.unlinkSync(file + '.lock');
});

test('session notes cover lifecycle, patch paths and redacted commands without patch contents', () => {
  const dir = repo(), notes = path.join(dir, 'notes');
  const extra = { CC_SESSION_LOG_DIR: notes };
  run('session-logger', { cwd: dir, hook_event_name: 'SessionStart', source: 'startup' }, extra);
  run('session-logger', { cwd: dir, ...patch('*** Add File: new.txt', '+DO_NOT_RECORD_CONTENT', '*** Delete File: old.txt', '*** Update File: move.txt', '*** Move to: moved.txt', '@@', '-move', '+move') }, extra);
  run('session-logger', { cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'TOKEN=secret-value echo hi\nDO_NOT_RECORD_SECOND_LINE' } }, extra);
  run('session-logger', { cwd: dir, hook_event_name: 'SessionEnd' }, extra);
  run('session-logger', { cwd: dir, hook_event_name: 'SessionStart', source: 'resume' }, extra);
  const files = fs.readdirSync(notes); assert.equal(files.length, 1);
  const note = fs.readFileSync(path.join(notes, files[0]), 'utf8');
  for (const text of ['# Codex Session', 'startup', 'resume', 'Session ended.', 'new.txt', 'delete "old.txt"', 'move "moved.txt"', 'TOKEN=***']) assert.ok(note.includes(text), text);
  assert.doesNotMatch(note, /DO_NOT_RECORD|secret-value/);
});

test('full session IDs separate notes with the same timestamp prefix', () => {
  const notes = path.join(temp, 'distinct');
  for (const session_id of ['01abc123-first', '01abc123-second', '../../unsafe']) run('session-logger', { session_id, hook_event_name: 'SessionStart' }, { CC_SESSION_LOG_DIR: notes });
  assert.equal(fs.readdirSync(notes).length, 3);
  assert.ok(fs.readdirSync(notes).every((f) => /^codex-[a-f0-9]{64}\.md$/.test(f)));
});

test('parallel note appends retain every entry and create one header', async () => {
  const notes = path.join(temp, 'parallel');
  await Promise.all(Array.from({ length: 12 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(temp, 'session-logger/codex.js')], { env: { ...env, CC_SESSION_LOG_DIR: notes }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.on('error', reject); child.on('close', (code) => code === 0 ? resolve() : reject(new Error(String(code))));
    child.stdin.end(JSON.stringify({ cwd: temp, session_id: 'parallel', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: `echo entry-${i}` } }));
  })));
  const files = fs.readdirSync(notes); assert.equal(files.length, 1);
  const note = fs.readFileSync(path.join(notes, files[0]), 'utf8');
  assert.equal(note.match(/# Codex Session/g).length, 1);
  assert.equal(note.match(/command "echo entry-/g).length, 12);
});
