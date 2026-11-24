#!/usr/bin/env node
/**
 * Regression tests for git-safety: the branch-aware rules judge the branch the
 * command reaches (a checkout or switch earlier in the line, cd, git -C,
 * --git-dir), not only the session's branch. Another repository's branch is
 * read from its files: nothing runs there, whatever its config names.
 *
 * Run: node --test plugins/git-safety/tests/regression-target-branch.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

delete process.env.HOOK_SAFETY_LEVEL;

// Record every child process the guard starts. The guard takes its
// child_process functions at load, so the wrappers go in before the require.
const cp = require('node:child_process');
const started = [];
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const real = cp[name];
  cp[name] = function (...args) { started.push(`${name} ${args[0]}`); return real.apply(this, args); };
}

const SCRIPT_PATH = path.join(__dirname, '../git-safety.js');
const PACK_PATH = path.join(__dirname, '../../guard-pack/guard-pack.js');
const { checkCommand } = require('../git-safety.js');

// The session sits in a repository on feature; a sibling repository is on main.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-safety-target-'));
const onFeature = path.join(temp, 'on-feature');
const onMain = path.join(temp, 'on-main');
// A repository on main whose config and hooks name a script that writes MARKER.
const trapped = path.join(temp, 'trapped');
const marker = path.join(temp, 'MARKER');
// A linked worktree on main (its .git is a file) and a detached one.
const base = path.join(temp, 'wt-base');
const wtMain = path.join(temp, 'wt-main');
const wtDetached = path.join(temp, 'wt-detached');
const startDir = process.cwd();

function git(...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
}

before(() => {
  for (const [dir, branch] of [[onFeature, 'feature'], [onMain, 'main'], [trapped, 'main'], [base, 'feature']]) {
    fs.mkdirSync(dir);
    git('init', '-q', '-b', branch, dir);
  }
  git('-C', base, 'commit', '-q', '--allow-empty', '-m', 'init');
  git('-C', base, 'worktree', 'add', '-q', '-b', 'main', wtMain);
  git('-C', base, 'worktree', 'add', '-q', '--detach', wtDetached);

  const trap = path.join(temp, 'trap.sh');
  fs.writeFileSync(trap, `#!/bin/sh\necho "$0 $*" >> '${marker}'\n`, { mode: 0o755 });
  const hooks = path.join(temp, 'trap-hooks');
  fs.mkdirSync(hooks);
  for (const h of ['pre-commit', 'pre-push', 'post-checkout', 'reference-transaction', 'post-index-change']) fs.copyFileSync(trap, path.join(hooks, h));
  fs.chmodSync(hooks, 0o755);
  for (const h of fs.readdirSync(hooks)) fs.chmodSync(path.join(hooks, h), 0o755);
  for (const [key, value] of [
    ['core.fsmonitor', trap], ['core.hooksPath', hooks], ['core.pager', trap], ['core.editor', trap],
    ['core.sshCommand', trap], ['credential.helper', `!${trap}`], ['diff.external', trap],
  ]) git('-C', trapped, 'config', key, value);
  // Prove the trap is live: git status in that repository runs the fsmonitor script.
  fs.writeFileSync(path.join(trapped, 'a'), 'a');
  git('-C', trapped, 'add', 'a');
  spawnSync('git', ['-C', trapped, 'status'], { encoding: 'utf8' });
  assert.ok(fs.existsSync(marker), 'the fsmonitor trap did not fire for git status');
  fs.rmSync(marker);
  started.length = 0;

  process.chdir(onFeature);
});
after(() => {
  process.chdir(startDir);
  fs.rmSync(temp, { recursive: true, force: true });
});

function shouldBlock(cmd, expectedId) {
  const result = checkCommand(cmd);
  assert.strictEqual(result.blocked, true, `Expected BLOCKED but was ALLOWED: ${cmd}`);
  assert.strictEqual(result.pattern.id, expectedId, `Expected pattern '${expectedId}' but got '${result.pattern.id}'`);
  assert.ok(result.reason.includes('main'), result.reason);
}

function shouldAllow(cmd) {
  const result = checkCommand(cmd);
  assert.strictEqual(result.blocked, false, `Expected ALLOWED but was BLOCKED by '${result.pattern?.id}': ${cmd}`);
}

describe('a checkout or switch earlier in the line', () => {
  it('blocks the recorded inputs', () => {
    shouldBlock('git checkout main && git merge feature && git push', 'merge-on-protected');
    shouldBlock('git switch main && git commit -am wip', 'commit-on-protected');
  });
  it('blocks a push after switching to main', () => shouldBlock('git switch main; git push origin feature', 'push-on-protected'));
  it('allows work after leaving main for a new branch', () => {
    for (const c of ['git checkout main && git checkout -b fix && git commit -m x', 'git switch -c fix && git commit -m x', 'git checkout main && git pull'])
      shouldAllow(c);
  });
  it('a file checkout from main does not switch branch', () => shouldAllow('git checkout main -- a.txt && git commit -m x'));
});

describe('a checkout that only restores files keeps the branch', () => {
  it('blocks a commit after switching to main and restoring a file', () =>
    shouldBlock('git checkout main && git checkout -- a.txt && git commit -m x', 'commit-on-protected'));
  it('blocks the same after a file named without --, a patch checkout or a file from another branch', () => {
    for (const c of [
      'git checkout main && git checkout a.txt && git commit -m x',
      'git switch main && git checkout -p && git commit -m x',
      'git checkout main && git checkout feature a.txt && git commit -m x',
    ]) shouldBlock(c, 'commit-on-protected');
  });
  it('git checkout - returns to the branch before the last switch', () => {
    shouldAllow('git checkout main && git checkout - && git commit -m x');
    shouldAllow('git checkout -b fix && git checkout main && git checkout - && git commit -m x');
  });
  it('a tracking checkout of origin/main lands on main', () =>
    shouldBlock('git switch -t origin/main && git commit -m x', 'commit-on-protected'));
});

describe('a cd inside { } or an if body stays for the rest of the line', () => {
  it('blocks a commit after cd in a brace group', () =>
    shouldBlock('{ cd ../on-main; } && git commit -m x', 'commit-on-protected'));
  it('blocks a commit after cd in an if body', () =>
    shouldBlock('if true; then cd ../on-main; fi; git commit -m x', 'commit-on-protected'));
  it('a cd inside a ( ) subshell still ends with it', () => {
    for (const c of ['(cd ../on-main) && git commit -m x', '(cd ../on-main && git status); git commit -m x'])
      shouldAllow(c);
  });
});

describe('a session on main that switches to a new branch first', () => {
  const onMain = (c) => checkCommand(c, 'main');
  it('allows a commit chained after creating a new branch', () => {
    for (const c of ['git checkout -b feature2 && git commit -m x', 'git switch -c fix && git commit -am x', 'git checkout -b fix && git push -u origin fix'])
      assert.strictEqual(onMain(c).blocked, false, c);
  });
  it('blocks when the switch may not have happened or may be undone', () => {
    for (const c of [
      'git commit -m x',
      'git checkout -b fix; git commit -m x',
      'false || git checkout -b fix && git commit -m x',
      '! git checkout -b fix && git commit -m x',
      'git checkout -b fix | cat && git commit -m x',
      'git checkout main & git checkout -b fix && git commit -m x',
      'git checkout -b fix && git commit -m "$(git checkout main)"',
      'git checkout -b fix && git branch -M main && git commit -m x',
      'git checkout -b fix && echo "ref: refs/heads/main" > .git/HEAD && git commit -m x',
      'git checkout -b fix && sh -c "git checkout main" && git commit -m x',
      'git checkout -b fix && GIT_DIR=../on-main/.git git commit -m x',
      'git checkout -b fix && git rebase origin/fix main && git commit -m x',
      'git checkout -b fix && make && git commit -m x',
      'git checkout -b fix && git commit -m x && git checkout main && git commit -m y',
      'git checkout -b MAIN && git commit -m x',
      'git checkout something && git commit -m x',
    ]) assert.strictEqual(onMain(c).pattern?.id, 'commit-on-protected', c);
  });
  it('blocks when the new branch name is known only when the shell runs', () => {
    for (const c of [
      'git checkout -b "$b" && git commit -m x', 'git switch -c $b && git commit -m x', 'git switch "$b" && git commit -m x',
      'git checkout -b "${b:-main}" && git commit -m x', 'git switch -c $(echo main) && git commit -m x', 'git switch -- "$b" && git commit -m x',
      'git switch ma* && git commit -m x', 'git switch {main,x} && git commit -m x', 'git checkout -b fix && git checkout "$b" && git commit -m x',
    ]) assert.strictEqual(onMain(c).pattern?.id, 'commit-on-protected', c);
  });
  it('git switch -- names the branch after it', () => {
    assert.strictEqual(onMain('git switch -- fix && git commit -m x').blocked, false);
    shouldBlock('git switch -- main && git commit -m x', 'commit-on-protected');
  });
});

describe('a switch away from main that may not have run', () => {
  it('leaves the call on main after ; || or a pipe', () => {
    for (const c of [
      'git checkout main; git switch -- fix; git commit -m x',
      'git checkout main; git checkout -b fix; git commit -m x',
      'git checkout main || git switch -- fix && git commit -m x',
      'git checkout main | git switch -- fix && git commit -m x',
      'git checkout main && git checkout "$b" && git commit -m x',
    ]) shouldBlock(c, 'commit-on-protected');
  });
  it('allows the call when an && chain makes the switch certain', () =>
    shouldAllow('git checkout main && git switch -- fix && git commit -m x'));
});

describe('another repository named by cd, git -C or --git-dir', () => {
  it('blocks the recorded inputs', () => {
    shouldBlock('git -C ../on-main commit -m "wip"', 'commit-on-protected');
    shouldBlock('cd ../on-main && git commit -m "wip"', 'commit-on-protected');
    shouldBlock('git -C ../on-main reset HEAD~1', 'reset-on-protected');
    shouldBlock('git -C ../on-main merge feature', 'merge-on-protected');
    shouldBlock('git --git-dir=../on-main/.git --work-tree=../on-main commit -m wip', 'commit-on-protected');
  });
  it('blocks pushd and a separate --git-dir value', () => {
    shouldBlock('pushd ../on-main && git push origin feature', 'push-on-protected');
    shouldBlock('git --git-dir ../on-main/.git commit -m wip', 'commit-on-protected');
  });
  it('allows read-only calls there and work back in the session repository', () => {
    for (const c of [
      'git -C ../on-main status', 'git -C ../on-main log; git commit -m x',
      '(cd ../on-main && git status); git commit -m x', 'cd ../on-main; cd ../on-feature; git commit -m x',
      'git -C ../on-main checkout -b fix && git -C ../on-main commit -m x', 'git -C ../missing commit -m x',
    ]) shouldAllow(c);
  });
});

describe('a named repository is read from its files, never run', () => {
  const cases = [
    ['git -C ../trapped commit -m wip', 'commit-on-protected'],
    ['cd ../trapped && git push origin feature', 'push-on-protected'],
    ['git --git-dir=../trapped/.git --work-tree=../trapped commit -m wip', 'commit-on-protected'],
    ['git -C ../trapped rebase feature', 'rebase-on-protected'],
    ['git -C ../trapped reset HEAD~1', 'reset-on-protected'],
  ];
  for (const [cmd, id] of cases) {
    it(`blocks without starting a process: ${cmd}`, () => {
      started.length = 0;
      const result = checkCommand(cmd, 'feature');
      assert.strictEqual(result.blocked, true, cmd);
      assert.strictEqual(result.pattern.id, id);
      assert.deepStrictEqual(started, []);
      assert.ok(!fs.existsSync(marker), 'a program named by the repository config ran');
    });
  }
  it('the hook process leaves the trap untouched', () => {
    const env = { ...process.env, HOME: temp, USERPROFILE: temp };
    for (const key of Object.keys(env)) if (/^HOOK_/.test(key)) delete env[key];
    for (const script of [SCRIPT_PATH, PACK_PATH]) {
      const r = spawnSync(process.execPath, [script], {
        cwd: onFeature, env, encoding: 'utf8',
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git -C ../trapped commit -m wip' }, cwd: onFeature }),
      });
      assert.strictEqual(JSON.parse(r.stdout.trim()).hookSpecificOutput?.permissionDecision, 'deny', r.stdout);
    }
    assert.ok(!fs.existsSync(marker), 'a program named by the repository config ran');
  });
});

describe('linked worktrees and unknown branches', () => {
  it('reads the branch through a worktree .git file', () => {
    assert.ok(fs.statSync(path.join(wtMain, '.git')).isFile());
    shouldBlock('git -C ../wt-main commit -m wip', 'commit-on-protected');
    shouldBlock('cd ../wt-main && git merge feature', 'merge-on-protected');
    shouldAllow('git -C ../wt-base commit -m wip');
  });
  it('resolves --git-dir against the directory -C leads to', () =>
    shouldBlock('git --git-dir=.git -C ../on-main commit -m wip', 'commit-on-protected'));
  it('a detached HEAD there adds nothing on a feature session', () => shouldAllow('git -C ../wt-detached commit -m wip'));
  it('an unknown branch there keeps the session-branch verdict', () => {
    for (const c of ['git -C ../wt-detached commit -m wip', 'git -C ../missing commit -m wip'])
      assert.strictEqual(checkCommand(c, 'main').pattern?.id, 'commit-on-protected', c);
  });
});

describe('through the hook and guard-pack', () => {
  for (const [name, script] of [['git-safety', SCRIPT_PATH], ['guard-pack', PACK_PATH]]) {
    it(`${name} denies git -C ../on-main commit from a feature repository`, () => {
      const env = { ...process.env, HOME: temp, USERPROFILE: temp };
      for (const key of Object.keys(env)) if (/^HOOK_/.test(key)) delete env[key];
      const r = spawnSync(process.execPath, [script], {
        cwd: onFeature, env, encoding: 'utf8',
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git -C ../on-main commit -m "wip"' }, cwd: onFeature }),
      });
      const out = JSON.parse(r.stdout.trim());
      assert.strictEqual(out.hookSpecificOutput?.permissionDecision, 'deny', r.stdout);
      assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes('commit-on-protected'));
    });
  }
});
