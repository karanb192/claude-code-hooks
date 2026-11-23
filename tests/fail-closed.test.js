#!/usr/bin/env node
/**
 * A guard that fails must refuse the call it was guarding, not allow it.
 * Three ways a guard fails: its check throws, it runs past the hook timeout,
 * or it cannot start (node missing from PATH). HOOK_FAIL_OPEN=true restores
 * the old allow-on-error behaviour for the first.
 *
 * Run: node --test tests/fail-closed.test.js
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const GUARDS = ['block-dangerous-commands', 'case-insensitive-guard', 'config-guard', 'git-safety', 'protect-secrets', 'protect-tests', 'subagent-spawn-cap'];
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fail-closed-'));
const home = path.join(temp, 'home');
const noNode = path.join(temp, 'no-node-bin');
fs.mkdirSync(home);
fs.mkdirSync(noNode);
after(() => fs.rmSync(temp, { recursive: true, force: true }));

// Loaded with node -r: every tool_input the hook parses throws on first read,
// which stands in for any bug in a guard's decision code.
const preload = path.join(temp, 'throw-in-guard.js');
fs.writeFileSync(preload, `
const parse = JSON.parse;
JSON.parse = function (...args) {
  const value = parse.apply(this, args);
  if (value && typeof value === 'object' && 'tool_input' in value) {
    value.tool_input = new Proxy({}, { get() { throw new Error('injected guard failure'); } });
  }
  return value;
};
`);

function environment(extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex') };
  for (const key of Object.keys(env)) if (/^(HOOK_|CONFIG_GUARD_|SPAWN_CAP_)/.test(key)) delete env[key];
  return { ...env, ...extra };
}

function payload(name, host) {
  if (name === 'subagent-spawn-cap') {
    return { tool_name: host === 'codex' ? 'spawn_agent' : 'Agent', session_id: 'fail-closed', cwd: home, tool_input: { prompt: 'look' } };
  }
  return { tool_name: 'Bash', session_id: 'fail-closed', cwd: home, tool_input: { command: 'ls' } };
}

function run(args, input, extra = {}, nodeArgs = []) {
  return spawnSync(process.execPath, [...nodeArgs, ...args], {
    env: environment(extra), cwd: home, encoding: 'utf8', timeout: 10000,
    input: typeof input === 'string' ? input : JSON.stringify(input),
  });
}

const claudeScript = (name) => name === 'guard-pack' ? ['plugins/guard-pack/guard-pack.js'] : [`plugins/${name}/${name}.js`];
const codexScript = (name) => name === 'guard-pack' ? ['plugins/guard-pack/guard-pack.js', '--host', 'codex'] : [`plugins/${name}/codex.js`];
const abs = (args) => [path.join(ROOT, args[0]), ...args.slice(1)];

function claudeDeny(r, id) {
  assert.equal(r.error, undefined);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out?.permissionDecision, 'deny', r.stdout);
  assert.ok(out.permissionDecisionReason.includes(`[${id}]`), out.permissionDecisionReason);
  return out.permissionDecisionReason;
}

function codexBlock(r, id) {
  assert.equal(r.error, undefined);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stdout, '');
  assert.ok(r.stderr.includes(`[${id}]`), r.stderr);
  return r.stderr;
}

describe('a guard whose check throws denies the call', () => {
  for (const name of [...GUARDS, 'guard-pack']) {
    it(`${name} on Claude Code`, () => {
      const reason = claudeDeny(run(abs(claudeScript(name)), payload(name, 'claude'), {}, ['-r', preload]), 'guard-error');
      assert.match(reason, /could not check this call \(injected guard failure\)/);
      assert.match(reason, /HOOK_FAIL_OPEN=true/);
    });
    it(`${name} on Codex`, () => {
      const stderr = codexBlock(run(abs(codexScript(name)), payload(name, 'codex'), {}, ['-r', preload]), 'guard-error');
      assert.match(stderr, /injected guard failure/);
    });
    it(`${name} allows again with HOOK_FAIL_OPEN=true`, () => {
      const claude = run(abs(claudeScript(name)), payload(name, 'claude'), { HOOK_FAIL_OPEN: 'true' }, ['-r', preload]);
      assert.equal(claude.status, 0, claude.stderr);
      assert.deepEqual(JSON.parse(claude.stdout), {});
      const codex = run(abs(codexScript(name)), payload(name, 'codex'), { HOOK_FAIL_OPEN: 'true' }, ['-r', preload]);
      assert.equal(codex.status, 0, codex.stderr);
      assert.equal(codex.stderr, '');
    });
  }

  it('guard-pack keeps a real deny from a later guard ahead of an earlier guard error', () => {
    const { GUARDS, evaluate } = require(path.join(ROOT, 'plugins/guard-pack/guard-pack.js'));
    const broken = GUARDS.find((g) => g.name === 'block-dangerous-commands');
    const run = broken.run;
    const saved = process.env.HOOK_FAIL_OPEN;
    delete process.env.HOOK_FAIL_OPEN;
    broken.run = () => { throw new Error('injected guard failure'); };
    try {
      assert.equal(evaluate('Bash', { command: 'cat .env' }, home, {})?.id, 'cat-env');
      const hit = evaluate('Bash', { command: 'ls' }, home, {});
      assert.equal(hit?.id, 'guard-error');
      assert.equal(hit.guard, 'block-dangerous-commands');
      assert.equal(hit.ask, false);
      process.env.HOOK_FAIL_OPEN = 'true';
      assert.equal(evaluate('Bash', { command: 'ls' }, home, {}), null);
    } finally {
      broken.run = run;
      if (saved === undefined) delete process.env.HOOK_FAIL_OPEN; else process.env.HOOK_FAIL_OPEN = saved;
    }
  });

  it('input that is not JSON still passes: there is no call to guard', () => {
    for (const name of [...GUARDS, 'guard-pack']) {
      const claude = run(abs(claudeScript(name)), 'not json');
      assert.deepEqual(JSON.parse(claude.stdout), {}, name);
      const codex = run(abs(codexScript(name)), 'not json');
      assert.equal(codex.status, 0, `${name}: ${codex.stderr}`);
    }
  });
});

describe('a guard that cannot start blocks the call', () => {
  for (const name of [...GUARDS, 'guard-pack']) {
    const dir = path.join(ROOT, 'plugins', name);

    it(`${name}: every Claude Code registration blocks on failure and times out at 10 s`, () => {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'hooks', 'hooks.json'), 'utf8'));
      for (const group of manifest.hooks.PreToolUse) {
        for (const hook of group.hooks) {
          assert.equal(hook.onFailure, 'block', `${name}: a guard that crashes, times out or cannot start must not allow`);
          assert.equal(hook.timeout, 10, name);
          assert.equal(hook.async, undefined, name);
        }
      }
    });

    // Codex has no onFailure setting and runs the command through a shell, so
    // the command itself turns a missing node into exit 2 with a reason.
    it(`${name}: the Codex command blocks when node is missing`, { skip: process.platform === 'win32' && 'POSIX shell' }, () => {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'hooks', 'codex-hooks.json'), 'utf8'));
      const [hook] = manifest.hooks.PreToolUse[0].hooks;
      const shell = (PATH, input) => spawnSync('/bin/sh', ['-c', hook.command], {
        env: { ...environment(), PATH, PLUGIN_ROOT: dir }, cwd: home, encoding: 'utf8', timeout: 10000,
        input: JSON.stringify(input),
      });
      const missing = shell(noNode, payload(name, 'codex'));
      assert.equal(missing.status, 2, `${name}: exit ${missing.status}, stderr ${missing.stderr}`);
      assert.notEqual(missing.stderr.trim(), '', 'Codex ignores an exit 2 without a reason on stderr');

      const withNode = `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`;
      const allowed = shell(withNode, payload(name, 'codex'));
      assert.equal(allowed.status, 0, `${name}: ${allowed.stderr}`);
      assert.equal(allowed.stderr, '');
      const deny = { 'block-dangerous-commands': ['rm -rf ~', 'rm-home'], 'protect-secrets': ['cat .env', 'cat-env'], 'guard-pack': ['cat .env', 'cat-env'] }[name];
      if (deny) {
        const denied = shell(withNode, { tool_name: 'Bash', cwd: home, tool_input: { command: deny[0] } });
        assert.equal(denied.status, 2, `${name}: ${denied.stderr}`);
        assert.ok(denied.stderr.includes(`[${deny[1]}]`), denied.stderr);
      }
    });
  }
});

describe('a slow input cannot run a guard past its timeout', () => {
  const flags = (n) => '-a '.repeat(n);
  const reported = `rm ${flags(27)}x && cat .env`;

  it('guard-pack answers the reported command with the cat-env deny, well inside 10 s', () => {
    const start = Date.now();
    claudeDeny(run(abs(claudeScript('guard-pack')), { tool_name: 'Bash', cwd: home, tool_input: { command: reported } }), 'cat-env');
    assert.ok(Date.now() - start < 3000, `took ${Date.now() - start} ms`);
  });

  it('guard-pack on Codex blocks the same command quickly', () => {
    const start = Date.now();
    codexBlock(run(abs(codexScript('guard-pack')), { tool_name: 'Bash', cwd: home, tool_input: { command: reported } }), 'cat-env');
    assert.ok(Date.now() - start < 3000, `took ${Date.now() - start} ms`);
  });

  // This exact line once ran block-dangerous-commands past any hook timeout.
  const resetAfterFlags = `rm ${'-f '.repeat(40)}build/out.o && git reset --hard`;
  for (const name of ['block-dangerous-commands', 'guard-pack']) {
    it(`${name} denies git reset --hard after 40 repeated rm flags, well inside 10 s`, () => {
      const start = Date.now();
      claudeDeny(run(abs(claudeScript(name)), { tool_name: 'Bash', cwd: home, tool_input: { command: resetAfterFlags } }), 'git-reset-hard');
      assert.ok(Date.now() - start < 3000, `took ${Date.now() - start} ms`);
    });
  }

  // In a child with a deadline: on the exponential regex this never returns.
  it('block-dangerous-commands still catches rm after a long flag run, in linear time', () => {
    const cases = [
      [`rm ${flags(60)}-rf ~`, 'rm-home'],
      [`rm ${flags(60)}-rf /`, 'rm-root'],
      [`rm ${flags(60)}-rf build /`, 'rm-root'],
      [`rm -rf ${flags(60)}$HOME`, 'rm-home-var'],
      [`rm -rf ${'a '.repeat(60)}~`, 'rm-home'],
      [`rm ${flags(60)}..`, 'rm-parent'],
      [`rm ${flags(60)}x`, null],
      [`rm${' '.repeat(5000)}x`, null],
      [`rm -${' '.repeat(5000)}x`, null],
    ];
    const script = `
      const { checkCommand } = require(${JSON.stringify(path.join(ROOT, 'plugins/block-dangerous-commands/block-dangerous-commands.js'))});
      const out = [];
      for (const [cmd] of ${JSON.stringify(cases)}) {
        const start = process.hrtime.bigint();
        const r = checkCommand(cmd, 'strict');
        out.push({ id: r.blocked ? r.pattern.id : null, ms: Number(process.hrtime.bigint() - start) / 1e6 });
      }
      process.stdout.write(JSON.stringify(out));
    `;
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.error, undefined, 'checkCommand did not finish within 5 s');
    const out = JSON.parse(child.stdout);
    cases.forEach(([cmd, id], i) => {
      assert.equal(out[i].id, id, cmd.slice(0, 60));
      assert.ok(out[i].ms < 200, `${cmd.slice(0, 40)}: ${out[i].ms} ms`);
    });
  });
});
