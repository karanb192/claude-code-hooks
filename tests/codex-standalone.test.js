const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const names = ['block-dangerous-commands', 'protect-secrets', 'protect-tests', 'git-safety', 'config-guard', 'case-insensitive-guard', 'subagent-spawn-cap'];
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-standalone-'));
const home = path.join(temp, 'home');
const work = path.join(temp, 'work');
const codexHome = path.join(home, 'custom-agent-home');
fs.mkdirSync(work, { recursive: true });
spawnSync('git', ['init', '-q', '-b', 'test-fixture', temp]);
fs.mkdirSync(path.join(codexHome, 'plugins'), { recursive: true });
fs.symlinkSync(codexHome, path.join(work, 'agent-link'), 'dir');
fs.writeFileSync(path.join(work, 'notes.txt'), 'hi\n');
for (const name of names) fs.cpSync(path.join(root, 'plugins', name), path.join(temp, name), { recursive: true });
after(() => fs.rmSync(temp, { recursive: true, force: true }));

const shell = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const patch = (...lines) => ({ tool_name: 'apply_patch', tool_input: { command: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') } });
const spawn = (session_id) => ({ tool_name: 'spawn_agent', session_id, tool_input: { message: 'Inspect the source' } });
function run(name, payload, extra = {}, cwd = work) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome };
  for (const key of Object.keys(env)) if (/^(HOOK_|CONFIG_GUARD_|SPAWN_CAP_)/.test(key)) delete env[key];
  Object.assign(env, extra);
  const script = name === 'guard-pack' ? path.join(root, 'plugins', name, 'guard-pack.js') : path.join(temp, name, 'codex.js');
  const args = name === 'guard-pack' ? [script, '--host', 'codex'] : [script];
  const r = spawnSync(process.execPath, args, { env, cwd: temp, input: JSON.stringify({ cwd, ...payload }), encoding: 'utf8' });
  assert.equal(r.error, undefined);
  assert.equal(r.stdout, '');
  return r;
}
function blocked(r, id) {
  assert.equal(r.status, 2, r.stderr);
  assert.ok(r.stderr.includes(`[${id}]`), r.stderr);
}
function allowed(r) { assert.equal(r.status, 0, r.stderr); assert.equal(r.stderr, ''); }

describe('isolated Codex plugin installations', () => {
  for (const name of names) {
    it(`${name}: standalone files and manifest load without the marketplace checkout`, () => {
      const dir = path.join(temp, name);
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.codex-plugin/plugin.json')));
      const claude = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin/plugin.json')));
      assert.equal(manifest.version, claude.version);
      assert.equal(manifest.name, name);
      const groups = JSON.parse(fs.readFileSync(path.join(dir, manifest.hooks))).hooks.PreToolUse;
      assert.equal(groups.length, 1);
      assert.equal(groups[0].matcher, name === 'subagent-spawn-cap' ? 'spawn_agent|collaborationspawn_agent' : 'Bash|apply_patch');
      assert.equal(groups[0].hooks[0].command, 'node "${PLUGIN_ROOT}/codex.js"');
      allowed(run(name, shell('cat notes.txt')));
      allowed(run(name, { tool_name: 'mcp__demo__read', tool_input: {} }));
    });
    it(`${name}: shared adapter and dispatcher match the pack`, () => {
      for (const f of ['host.js', 'dispatch.js', 'codex-runner.js']) {
        assert.equal(fs.readFileSync(path.join(temp, name, 'lib', f), 'utf8'), fs.readFileSync(path.join(root, 'plugins/guard-pack/lib', f), 'utf8'), `${name}/${f}`);
      }
    });
  }
  it('denies dangerous commands, secret reads, test edits and destructive git commands', () => {
    blocked(run('block-dangerous-commands', shell('chmod 777 notes.txt')), 'chmod-777');
    blocked(run('protect-secrets', shell('cat .env')), 'cat-env');
    blocked(run('protect-secrets', patch('*** Add File: .env.production', '+KEY=placeholder')), 'env-file');
    blocked(run('protect-tests', patch('*** Update File: tests/demo.test.js', '@@', "-test('demo', () => {});", "+test.skip('demo', () => {});")), 'skip-test');
    blocked(run('git-safety', shell('git push --force origin main')), 'push-main');
  });
  it('keeps the case guard tied to the filesystem of the event cwd', () => {
    const r = run('case-insensitive-guard', shell('rm NOTES.TXT'));
    if (fs.existsSync(path.join(work, 'NOTES.TXT'))) blocked(r, 'case-collision');
    else allowed(r);
  });
  it('allows an ordinary patch and blocks unreadable patches', () => {
    for (const name of names.filter((n) => n !== 'subagent-spawn-cap')) {
      allowed(run(name, patch('*** Add File: hello.js', '+const hello = 1;')));
      blocked(run(name, { tool_name: 'apply_patch', tool_input: { command: 'broken patch' } }), 'unreadable-patch');
    }
  });
  it('converts ask to a Codex block with a useful reason', () => {
    const r = run('block-dangerous-commands', shell('chmod 777 notes.txt'), { HOOK_ASK_HIGH: 'true' });
    blocked(r, 'chmod-777');
    assert.match(r.stderr, /Codex hooks cannot ask/);
  });
});

describe('literal shell patch mentions', () => {
  it('allows searches, printed text and commit messages', () => {
    for (const command of ['grep -c apply_patch notes.txt', 'rg -ic applypatch .', 'git commit -m "then apply_patch"', 'echo "do apply_patch"', "printf '%s' 'then apply_patch'", "rg -e '$(apply_patch)' ."]) {
      allowed(run('guard-pack', shell(command)));
    }
  });
  it('still refuses substitutions, mixed commands and shell-running rg options', () => {
    for (const command of ['grep -c "$(apply_patch < p.txt)" .', 'echo `apply_patch < p.txt`', 'git commit -m "$(apply_patch < p.txt)"', 'rg -c apply_patch .; apply_patch < p.txt', 'printf x | apply_patch', 'rg --pre "bash -c apply_patch" foo']) {
      blocked(run('guard-pack', shell(command)), 'unreadable-patch');
    }
  });
});

describe('Codex configuration protection', () => {
  for (const name of ['config-guard', 'guard-pack']) {
    it(`${name}: checks native add, update, move and delete paths in the event cwd`, () => {
      for (const event of [
        patch('*** Add File: .codex/config.toml', '+x = true'),
        patch('*** Update File: .codex/plugins/cache/guard.js', '@@', '-old', '+new'),
        patch('*** Update File: notes.txt', '*** Move to: .codex/config.toml', '@@', '-hi', '+x = true'),
        patch('*** Delete File: .codex/config.toml'),
        patch('*** Add File: agent-link/plugins/new/nested/guard.js', '+x'),
      ]) blocked(run(name, event), 'codex-config');
      blocked(run(name, patch('*** Add File: config.toml', '+x = true'), {}, codexHome), 'codex-config');
      blocked(run(name, patch('*** Delete File: config.toml'), {}, codexHome), 'codex-config');
      blocked(run(name, patch(`*** Delete File: ${codexHome}/plugins/guard.js`)), 'codex-config');
    });
    it(`${name}: stops literal shell mutations and CLI config writes but allows reads`, () => {
      for (const command of ['echo x > ~/.codex/config.toml', 'rm -rf ~/.codex/plugins/cache', 'rm -rf "$CODEX_HOME"', 'echo x > "${CODEX_HOME}/config.toml"', `rm '${codexHome}/plugins/data/installed.json'`, 'codex plugin remove config-guard@claude-code-hooks', 'codex plugin marketplace upgrade', 'codex mcp add demo -- node server.js', 'codex features disable hooks']) {
        blocked(run(name, shell(command)), command.startsWith('codex ') ? 'codex-cli-config' : 'codex-config');
      }
      for (const command of ['cat ~/.codex/config.toml', 'codex plugin marketplace list', 'codex features list', 'mv notes.codex notes.txt']) allowed(run(name, shell(command)));
    });
    it(`${name}: respects levels and the config override`, () => {
      const manifest = patch('*** Add File: .codex-plugin/plugin.json', '+{}');
      blocked(run(name, manifest), 'codex-plugin-manifest');
      allowed(run(name, manifest, { HOOK_SAFETY_LEVEL: 'critical' }));
      const instructions = patch('*** Add File: AGENTS.override.md', '+Instructions');
      allowed(run(name, instructions));
      blocked(run(name, instructions, { HOOK_SAFETY_LEVEL: 'strict' }), 'agents-md');
      allowed(run(name, patch('*** Add File: .codex/config.toml', '+x = true'), { CONFIG_GUARD_ALLOW: 'true' }));
    });
  }
});

describe('Codex spawn budget', () => {
  for (const name of ['subagent-spawn-cap', 'guard-pack']) {
    it(`${name}: counts the collaboration namespace spelling in the same thread`, () => {
      const fixture = JSON.parse(fs.readFileSync(path.join(root, 'plugins/guard-pack/tests/fixtures/codex-0.169.0/spawn-agent.json')));
      const event = { ...fixture, session_id: `namespaced-${name}` };
      allowed(run(name, { ...event, tool_name: 'spawn_agent' }, { SPAWN_CAP_DENY: '2' }));
      blocked(run(name, event, { SPAWN_CAP_DENY: '2' }), 'spawn-cap');
    });
    it(`${name}: ignores ask tiers, denies at the configured number and preserves the count on resume`, () => {
      const event = spawn(`budget-${name}`);
      const env = { SPAWN_CAP_ASK: '1', SPAWN_CAP_DENY: '3' };
      allowed(run(name, event, env));
      allowed(run(name, event, env));
      const r = run(name, event, env);
      blocked(r, 'spawn-cap');
      assert.match(r.stderr, /spawn #3/);
      assert.doesNotMatch(r.stderr, /cannot ask|settings.json/);
      blocked(run(name, event, env), 'spawn-cap');
      allowed(run(name, spawn(`different-${name}`), env));
      allowed(run(name, event, { ...env, SPAWN_CAP_ALLOW: 'true' }));
      blocked(run(name, event, env), 'spawn-cap');
    });
    it(`${name}: cap one denies the first spawn even with the default ask threshold`, () => {
      blocked(run(name, spawn(`one-${name}`), { SPAWN_CAP_DENY: '1' }), 'spawn-cap');
    });
  }
});
