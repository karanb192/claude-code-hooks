#!/usr/bin/env node
/**
 * Regression tests for git-safety: the branch rules read the branch of the
 * folder the command runs in (the payload's cwd), not the folder the hook
 * process started in, in the standalone hook, guard-pack and the Codex runner.
 *
 * Run: node --test plugins/git-safety/tests/regression-payload-cwd.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

delete process.env.HOOK_SAFETY_LEVEL;

const { checkCommand } = require('../git-safety.js');

const ROOT = path.join(__dirname, '../../..');
const SCRIPTS = {
  'git-safety': [path.join(ROOT, 'plugins/git-safety/git-safety.js'), false],
  'guard-pack': [path.join(ROOT, 'plugins/guard-pack/guard-pack.js'), false],
  'git-safety on Codex': [path.join(ROOT, 'plugins/git-safety/codex.js'), true],
};

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-safety-cwd-')));
const dir = (name) => path.join(temp, name);
const home = dir('home');

function git(...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
}

before(() => {
  for (const [name, branch] of [['on-main', 'main'], ['on-feature', 'feature']]) {
    git('init', '-q', '-b', branch, dir(name));
    git('-C', dir(name), 'commit', '-q', '--allow-empty', '-m', 'init');
  }
  fs.mkdirSync(path.join(dir('on-feature'), 'sub'));
  fs.mkdirSync(dir('plain'));
  fs.mkdirSync(home);
});
after(() => fs.rmSync(temp, { recursive: true, force: true }));

// Runs a hook script with its process in `proc` and the payload cwd `cwd`.
function verdict(name, proc, cwd, command) {
  const [script, codex] = SCRIPTS[name];
  const payload = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, session_id: 'cwd-test' };
  if (cwd !== undefined) payload.cwd = cwd;
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home };
  const r = spawnSync(process.execPath, [script], { cwd: proc, env, input: JSON.stringify(payload), encoding: 'utf8' });
  if (codex) return r.status === 2 ? 'refuse' : 'allow';
  return /"permissionDecision":"deny"/.test(r.stdout) ? 'refuse' : 'allow';
}

describe('the payload cwd decides the branch, in every host', () => {
  const cases = [
    ['on-feature', 'on-main', 'git push origin HEAD', 'refuse'],
    ['on-feature', 'on-main', 'git commit -m x', 'refuse'],
    ['on-feature', 'does-not-exist', 'git push origin HEAD', 'refuse'],
    ['on-main', 'on-feature', 'git push origin HEAD', 'allow'],
    ['on-feature', 'plain', 'git push origin HEAD', 'allow'],
  ];
  for (const name of Object.keys(SCRIPTS)) {
    for (const [proc, cwd, command, want] of cases) {
      it(`${name}: process in ${proc}, cwd ${cwd}, ${command}: ${want}`, () =>
        assert.strictEqual(verdict(name, dir(proc), dir(cwd), command), want));
    }
    it(`${name}: with no cwd in the payload, the process folder still decides`, () => {
      assert.strictEqual(verdict(name, dir('on-main'), undefined, 'git push origin HEAD'), 'refuse');
      assert.strictEqual(verdict(name, dir('on-feature'), undefined, 'git push origin HEAD'), 'allow');
    });
  }
});

describe('checkCommand with a cwd', () => {
  it('reads the branch of the cwd, not of the test process folder', () => {
    assert.strictEqual(checkCommand('git commit -m x', null, 'high', dir('on-main')).pattern?.id, 'commit-on-protected');
    assert.strictEqual(checkCommand('git commit -m x', null, 'high', dir('on-feature')).blocked, false);
  });
  it('a cwd whose branch cannot be read refuses the branch rules', () => {
    const r = checkCommand('git commit -m x', null, 'high', dir('does-not-exist'));
    assert.strictEqual(r.pattern?.id, 'commit-on-protected');
  });
  it('a cwd that is not a git repository has no branch to protect', () =>
    assert.strictEqual(checkCommand('git commit -m x', null, 'high', dir('plain')).blocked, false));
  it('cd and -C in the command resolve from the cwd', () => {
    assert.strictEqual(checkCommand('cd ../on-main && git commit -m x', null, 'high', dir('on-feature')).pattern?.id, 'commit-on-protected');
    assert.strictEqual(checkCommand('git -C ../on-main commit -m x', null, 'high', dir('on-feature')).pattern?.id, 'commit-on-protected');
    assert.strictEqual(checkCommand('cd sub && git commit -m x', null, 'high', dir('on-feature')).blocked, false);
    assert.strictEqual(checkCommand('git -C ../on-feature commit -m x', null, 'high', dir('on-main')).pattern?.id, 'commit-on-protected');
  });
  it('a switch to a new branch first still lifts the refusal from a cwd on main', () =>
    assert.strictEqual(checkCommand('git checkout -b fix && git commit -m x', null, 'high', dir('on-main')).blocked, false));
});
