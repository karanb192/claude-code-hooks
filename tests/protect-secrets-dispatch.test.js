const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'secret hooks with spaces '));
const BASH = process.platform === 'win32'
  ? path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe')
  : 'bash';
after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

function environment(home, overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(HOOK_|CONFIG_GUARD_|SPAWN_CAP_)/.test(key)) delete env[key];
  }
  return { ...env, HOME: home, USERPROFILE: home, ...overrides };
}

function outputOf(child) {
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  return JSON.parse(child.stdout);
}

const cases = [
  ...['Read', 'Edit', 'Write'].map(tool => ({
    name: tool + ' blocks a Windows .env',
    tool, input: {
      file_path: 'C:\\project\\.env',
      ...(tool === 'Edit' ? { old_string: 'KEY=old', new_string: 'KEY=new' } : {}),
      ...(tool === 'Write' ? { content: 'KEY=new' } : {}),
    }, id: 'env-file',
  })),
  { name: 'UNC path', input: { path: '\\\\server\\share\\.env' }, id: 'env-file' },
  { name: 'relative path', input: { path: '.\\config\\.env.local' }, id: 'env-file' },
  { name: 'mixed separators', input: { path: 'C:/project\\.env' }, id: 'env-file' },
  { name: 'Windows glob', input: { path: 'C:/project', glob: '**\\.env' }, id: 'env-file' },
  { name: 'legacy include', input: { include: '**\\.aws\\credentials' }, id: 'aws-credentials' },
  { name: 'directory plus filename', input: { path: 'C:\\Users\\me\\.aws', glob: 'credentials' }, id: 'aws-credentials' },
  { name: 'directory with trailing separator', input: { path: 'C:\\Users\\me\\.kube\\', glob: 'config' }, id: 'kube-config' },
  { name: 'POSIX directory plus filename', input: { path: '/home/me/.aws/', glob: 'credentials' }, id: 'aws-credentials' },
  { name: 'later secret survives allowlist', input: { path: '/app/.env.example', glob: '.env' }, id: 'env-file' },
  { name: 'later secret survives threshold', input: { path: '/app/credentials.json', glob: '.env' }, env: { HOOK_SAFETY_LEVEL: 'critical' }, id: 'env-file' },
  { name: 'critical target wins over high ask', input: { path: '/app/credentials.json', glob: '.env' }, env: { HOOK_ASK_HIGH: 'true' }, id: 'env-file' },
  { name: 'critical ask', input: { path: 'C:\\app\\.env' }, env: { HOOK_ASK_CRITICAL: 'true' }, id: 'env-file', decision: 'ask' },
  { name: 'high ask', input: { path: 'C:\\Users\\me\\.npmrc' }, env: { HOOK_ASK_HIGH: 'true' }, id: 'npmrc', decision: 'ask' },
  { name: 'strict ask', input: { path: 'C:\\Users\\me\\.ssh\\known_hosts' }, env: { HOOK_SAFETY_LEVEL: 'strict', HOOK_ASK_STRICT: 'true' }, id: 'ssh-known-hosts', decision: 'ask' },
  { name: 'critical allows high', input: { path: 'C:\\Users\\me\\.npmrc' }, env: { HOOK_SAFETY_LEVEL: 'critical' } },
  { name: 'high allows strict', input: { path: 'C:\\Users\\me\\.ssh\\known_hosts' } },
  { name: 'template read', tool: 'Read', input: { file_path: 'C:\\project\\.env.example' } },
  { name: 'template search', input: { path: 'C:/project', glob: '**/.env.example' } },
  { name: 'ordinary source', input: { path: 'C:\\project\\src', glob: '*.js', pattern: 'SECRET_KEY' } },
  { name: 'broad search remains outside path coverage', input: { pattern: 'SECRET_KEY', path: '/project', glob: '*' } },
  { name: 'missing input', input: undefined },
  { name: 'null input', input: null },
  { name: 'non-string fields', input: { path: {}, glob: [], include: 42 } },
  { name: 'non-string path does not mask a valid glob', input: { path: {}, glob: '.env' }, id: 'env-file' },
  { name: 'Bash .env read', tool: 'Bash', input: { command: 'cat .env' }, id: 'cat-env' },
  { name: 'ordinary Bash', tool: 'Bash', input: { command: 'git status' } },
];

for (const plugin of ['protect-secrets', 'guard-pack']) {
  describe(plugin + ' through its installed hook command', () => {
    const pluginRoot = path.join(TEMP, plugin);
    const home = path.join(TEMP, plugin + '-home');
    fs.cpSync(path.join(ROOT, 'plugins', plugin), pluginRoot, { recursive: true });
    fs.mkdirSync(home);
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks/hooks.json'), 'utf8'));

    function dispatch(tool, input, overrides = {}, raw) {
      const entries = manifest.hooks.PreToolUse.filter(entry => new RegExp(entry.matcher).test(tool));
      assert.equal(entries.length, 1, tool + ' must reach exactly one registration');
      assert.equal(entries[0].hooks.length, 1);
      const hook = entries[0].hooks[0];
      assert.equal(hook.type, 'command');
      assert.equal(hook.async, undefined);
      const env = environment(home, { CLAUDE_PLUGIN_ROOT: pluginRoot, ...overrides });
      return outputOf(spawnSync(BASH, ['-c', hook.command], {
        env, cwd: home, encoding: 'utf8', timeout: 5000,
        input: raw ?? JSON.stringify({
          hook_event_name: 'PreToolUse', tool_name: tool,
          tool_input: tool === 'Grep' && input ? { pattern: 'KEY', ...input } : input,
          session_id: 'dispatch-test', cwd: home, permission_mode: 'default',
        }),
      }));
    }

    for (const fixture of cases) {
      it(fixture.name, () => {
        const output = dispatch(fixture.tool || 'Grep', fixture.input, fixture.env);
        if (!fixture.id) return assert.deepEqual(output, {});
        const verdict = output.hookSpecificOutput;
        assert.equal(verdict?.hookEventName, 'PreToolUse');
        assert.equal(verdict.permissionDecision, fixture.decision || 'deny');
        assert.ok(verdict.permissionDecisionReason.includes('[' + fixture.id + ']'), verdict.permissionDecisionReason);
        if (!fixture.tool) assert.match(verdict.permissionDecisionReason, /Cannot search:/);
      });
    }

    it('invalid JSON preserves the fail-open contract', () => {
      assert.deepEqual(dispatch('Grep', undefined, {}, '{invalid'), {});
    });

    it('starts without HOME when USERPROFILE is set', () => {
      const env = environment(home);
      delete env.HOME;
      const output = outputOf(spawnSync(process.execPath, [path.join(pluginRoot, plugin + '.js')], {
        env, cwd: home, encoding: 'utf8', timeout: 5000,
        input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'C:\\project\\.env' } }),
      }));
      assert.equal(output.hookSpecificOutput?.permissionDecision, 'deny');
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /\[env-file\]/);
    });
  });
}
