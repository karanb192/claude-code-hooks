#!/usr/bin/env node
/**
 * Tests for git-safety.js
 *
 * Run: node --test hook-scripts/tests/pre-tool-use/git-safety.test.js
 * Or:  npm test
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const { PATTERNS, PROTECTED_BRANCHES, LEVELS, checkCommand } = require('../../pre-tool-use/git-safety.js');

const SCRIPT_PATH = path.join(__dirname, '../../pre-tool-use/git-safety.js');

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

function shouldBlock(cmd, expectedId = null, branch = null, level = undefined) {
  const result = checkCommand(cmd, branch, level);
  assert.strictEqual(result.blocked, true, `Expected BLOCKED but was ALLOWED: ${cmd}`);
  if (expectedId) {
    assert.strictEqual(result.pattern.id, expectedId, `Expected pattern '${expectedId}' but got '${result.pattern.id}'`);
  }
}

function shouldAllow(cmd, branch = null, level = undefined) {
  const result = checkCommand(cmd, branch, level);
  assert.strictEqual(result.blocked, false, `Expected ALLOWED but was BLOCKED by '${result.pattern?.id}': ${cmd}`);
}

function runHook(command) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SCRIPT_PATH]);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });

    child.on('close', (code) => {
      try {
        const output = JSON.parse(stdout.trim());
        resolve({ code, output, stderr });
      } catch (e) {
        reject(new Error(`Failed to parse output: ${stdout}`));
      }
    });

    const hookInput = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command },
      session_id: 'test-session',
      cwd: '/tmp',
      permission_mode: 'default'
    });
    child.stdin.write(hookInput);
    child.stdin.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit Tests - checkCommand function
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: checkCommand()', () => {

  // ── Force push ─────────────────────────────────────────────────────────
  // At the default 'high' level, plain force-push is delegated to
  // block-dangerous-commands.js (no overlap). It is only blocked here at 'strict'.

  describe('Force push', () => {
    it('allows plain force push at high (delegated to sibling hook)', () => shouldAllow('git push --force origin feature', 'feature-branch'));
    it('allows git push -f at high (delegated to sibling hook)', () => shouldAllow('git push -f origin feature', 'feature-branch'));
    it('still blocks force push to main at high (via push-main)', () => shouldBlock('git push --force origin main', 'push-main'));
    it('still blocks force push to master at high (via push-master)', () => shouldBlock('git push --force origin master', 'push-master'));

    it('blocks git push --force at strict', () => shouldBlock('git push --force origin feature', 'force-push', 'feature-branch', 'strict'));
    it('blocks git push -f at strict', () => shouldBlock('git push -f origin feature', 'force-push', 'feature-branch', 'strict'));
    it('blocks force push with extra args at strict', () => shouldBlock('git push --force origin feature --no-verify', 'force-push', 'feature-branch', 'strict'));
    it('allows git push --force-with-lease at strict', () => shouldAllow('git push --force-with-lease origin feature', 'feature-branch', 'strict'));
  });

  describe('Push to main/master (always blocked)', () => {
    it('blocks git push origin main', () => shouldBlock('git push origin main', 'push-main'));
    it('blocks git push main', () => shouldBlock('git push main', 'push-main'));
    it('blocks git push origin master', () => shouldBlock('git push origin master', 'push-master'));
    it('blocks git push master', () => shouldBlock('git push master', 'push-master'));
    it('blocks push to main with extra flags', () => shouldBlock('git push origin main --tags', 'push-main'));
  });

  // ── Deleting protected branches ────────────────────────────────────────

  describe('Branch delete protected (always blocked)', () => {
    it('blocks git branch -d main', () => shouldBlock('git branch -d main', 'branch-delete-protected'));
    it('blocks git branch -D main', () => shouldBlock('git branch -D main', 'branch-delete-protected'));
    it('blocks git branch -d master', () => shouldBlock('git branch -d master', 'branch-delete-protected'));
    it('blocks git branch -D master', () => shouldBlock('git branch -D master', 'branch-delete-protected'));
    it('blocks git branch --delete main', () => shouldBlock('git branch --delete main', 'branch-delete-protected'));
    it('allows git branch -d feature-branch', () => shouldAllow('git branch -d feature-branch', 'feature-branch'));
    it('allows git branch -D old-branch', () => shouldAllow('git branch -D old-branch', 'feature-branch'));
    it('allows git branch main-backup (not deleting)', () => shouldAllow('git branch main-backup', 'feature-branch'));
  });

  // ── Direct changes on protected branches ───────────────────────────────

  describe('Commit on protected branch', () => {
    it('blocks git commit on main', () => shouldBlock('git commit -m "fix"', 'commit-on-protected', 'main'));
    it('blocks git commit on master', () => shouldBlock('git commit -m "fix"', 'commit-on-protected', 'master'));
    it('blocks git commit --amend on main', () => shouldBlock('git commit --amend', 'commit-on-protected', 'main'));
    it('blocks git commit -a on main', () => shouldBlock('git commit -a -m "msg"', 'commit-on-protected', 'main'));
    it('blocks git commit with no flags on main', () => shouldBlock('git commit', 'commit-on-protected', 'main'));
    it('allows git commit on feature branch', () => shouldAllow('git commit -m "fix"', 'feature-branch'));
    it('allows git commit on develop', () => shouldAllow('git commit -m "fix"', 'develop'));
  });

  describe('Merge on protected branch', () => {
    it('blocks git merge on main', () => shouldBlock('git merge feature-x', 'merge-on-protected', 'main'));
    it('blocks git merge on master', () => shouldBlock('git merge feature-x', 'merge-on-protected', 'master'));
    it('blocks git merge --no-ff on main', () => shouldBlock('git merge --no-ff feature-x', 'merge-on-protected', 'main'));
    it('blocks git merge --squash on main', () => shouldBlock('git merge --squash feature-x', 'merge-on-protected', 'main'));
    it('allows git merge main on feature branch', () => shouldAllow('git merge main', 'feature-branch'));
    it('allows git merge origin/main on feature branch', () => shouldAllow('git merge origin/main', 'feature-branch'));
    it('allows git merge --abort on any branch', () => shouldAllow('git merge --abort', 'feature-branch'));
  });

  describe('Rebase on protected branch', () => {
    it('blocks git rebase on main', () => shouldBlock('git rebase feature-x', 'rebase-on-protected', 'main'));
    it('blocks git rebase on master', () => shouldBlock('git rebase feature-x', 'rebase-on-protected', 'master'));
    it('blocks git rebase -i on main', () => shouldBlock('git rebase -i HEAD~3', 'rebase-on-protected', 'main'));
    it('blocks git rebase --onto on main', () => shouldBlock('git rebase --onto new-base old-base', 'rebase-on-protected', 'main'));
    it('allows git rebase main on feature branch', () => shouldAllow('git rebase main', 'feature-branch'));
    it('allows git rebase origin/main on feature branch', () => shouldAllow('git rebase origin/main', 'feature-branch'));
    it('allows git rebase --abort on any branch', () => shouldAllow('git rebase --abort', 'feature-branch'));
    it('allows git rebase --continue on any branch', () => shouldAllow('git rebase --continue', 'feature-branch'));
  });

  describe('Reset on protected branch', () => {
    it('blocks git reset --hard on main', () => shouldBlock('git reset --hard HEAD~1', 'reset-on-protected', 'main'));
    it('blocks git reset --soft on main', () => shouldBlock('git reset --soft HEAD~1', 'reset-on-protected', 'main'));
    it('blocks git reset --mixed on main', () => shouldBlock('git reset --mixed HEAD~1', 'reset-on-protected', 'main'));
    it('blocks git reset (no flags) on main', () => shouldBlock('git reset HEAD~1', 'reset-on-protected', 'main'));
    it('blocks git reset on master', () => shouldBlock('git reset --hard', 'reset-on-protected', 'master'));
    it('allows git reset --hard on feature branch', () => shouldAllow('git reset --hard HEAD~1', 'feature-branch'));
    it('allows git reset --soft on feature branch', () => shouldAllow('git reset --soft HEAD~1', 'feature-branch'));
  });

  describe('Push on protected branch', () => {
    it('blocks git push on main', () => shouldBlock('git push origin feature', 'push-on-protected', 'main'));
    it('blocks git push on master', () => shouldBlock('git push origin feature', 'push-on-protected', 'master'));
    it('allows git push on feature branch', () => shouldAllow('git push origin feature', 'feature-branch'));
  });

  // ── Destructive gh CLI operations ──────────────────────────────────────

  describe('gh pr merge (always blocked)', () => {
    it('blocks gh pr merge', () => shouldBlock('gh pr merge', 'gh-pr-merge'));
    it('blocks gh pr merge with number', () => shouldBlock('gh pr merge 123', 'gh-pr-merge'));
    it('blocks gh pr merge --squash', () => shouldBlock('gh pr merge --squash', 'gh-pr-merge'));
    it('blocks gh pr merge --rebase', () => shouldBlock('gh pr merge --rebase 42', 'gh-pr-merge'));
    it('blocks gh pr merge --merge', () => shouldBlock('gh pr merge --merge', 'gh-pr-merge'));
  });

  describe('gh pr close (always blocked)', () => {
    it('blocks gh pr close', () => shouldBlock('gh pr close 123', 'gh-pr-close'));
    it('blocks gh pr close with comment', () => shouldBlock('gh pr close 123 --comment "stale"', 'gh-pr-close'));
    it('blocks gh pr close with delete-branch', () => shouldBlock('gh pr close 123 --delete-branch', 'gh-pr-close'));
  });

  describe('gh issue close (always blocked)', () => {
    it('blocks gh issue close', () => shouldBlock('gh issue close 456', 'gh-issue-close'));
    it('blocks gh issue close with reason', () => shouldBlock('gh issue close 456 --reason "not planned"', 'gh-issue-close'));
    it('blocks gh issue close with comment', () => shouldBlock('gh issue close 456 --comment "done"', 'gh-issue-close'));
  });

  describe('gh release delete (always blocked)', () => {
    it('blocks gh release delete', () => shouldBlock('gh release delete v1.0.0', 'gh-release-delete'));
    it('blocks gh release delete with --yes', () => shouldBlock('gh release delete v1.0.0 --yes', 'gh-release-delete'));
    it('blocks gh release delete with cleanup-tag', () => shouldBlock('gh release delete v1.0.0 --cleanup-tag', 'gh-release-delete'));
  });

  describe('gh repo delete (always blocked)', () => {
    it('blocks gh repo delete', () => shouldBlock('gh repo delete', 'gh-repo-delete'));
    it('blocks gh repo delete with name', () => shouldBlock('gh repo delete owner/repo', 'gh-repo-delete'));
    it('blocks gh repo delete with --yes', () => shouldBlock('gh repo delete owner/repo --yes', 'gh-repo-delete'));
  });

  // ── Safe commands ──────────────────────────────────────────────────────

  describe('Safe git commands (on feature branch)', () => {
    const safeCommands = [
      'git status',
      'git log --oneline',
      'git diff',
      'git diff --staged',
      'git pull origin main',
      'git fetch --all',
      'git fetch origin',
      'git checkout -b new-branch',
      'git checkout main',
      'git switch main',
      'git branch -d old-branch',
      'git stash',
      'git stash pop',
      'git merge main',
      'git merge origin/main',
      'git rebase main',
      'git rebase origin/main',
      'git reset --hard HEAD~1',
      'git cherry-pick abc123',
      'git tag v1.0.0',
      'git remote -v',
    ];
    for (const cmd of safeCommands) {
      it(`allows: ${cmd}`, () => shouldAllow(cmd, 'feature-branch'));
    }
  });

  describe('Safe gh commands', () => {
    const safeCommands = [
      'gh pr create --title "feat: new thing"',
      'gh pr list',
      'gh pr view 123',
      'gh pr checkout 123',
      'gh pr diff 123',
      'gh pr status',
      'gh issue create --title "bug"',
      'gh issue list',
      'gh issue view 456',
      'gh issue status',
      'gh release create v1.0.0',
      'gh release list',
      'gh release view v1.0.0',
      'gh repo view',
      'gh repo clone owner/repo',
    ];
    for (const cmd of safeCommands) {
      it(`allows: ${cmd}`, () => shouldAllow(cmd, 'feature-branch'));
    }
  });

  describe('Non-git commands', () => {
    const safeCommands = ['npm install', 'ls -la', 'cat README.md', 'node index.js'];
    for (const cmd of safeCommands) {
      it(`allows: ${cmd}`, () => shouldAllow(cmd, 'feature-branch'));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SAFETY_LEVEL tiers
// ─────────────────────────────────────────────────────────────────────────────

describe('SAFETY_LEVEL tiers', () => {
  it('high (default) delegates plain force-push to the sibling hook (allowed)', () => shouldAllow('git push --force origin feature', 'feature-branch', 'high'));
  it('strict blocks plain force-push (self-sufficient)', () => shouldBlock('git push --force origin feature', 'force-push', 'feature-branch', 'strict'));
  it('critical applies no git-safety rules (gh pr merge allowed)', () => shouldAllow('gh pr merge 1', null, 'critical'));
  it('high still blocks the complementary coverage (gh pr merge)', () => shouldBlock('gh pr merge 1', 'gh-pr-merge', null, 'high'));
  it('strict still blocks the complementary coverage (gh pr merge)', () => shouldBlock('gh pr merge 1', 'gh-pr-merge', null, 'strict'));
  it('unknown level falls back to high (default) behavior', () => shouldAllow('git push --force origin feature', 'feature-branch', 'bogus'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration Tests - actual stdin/stdout flow
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration: stdin/stdout hook flow', () => {
  it('returns deny for git push to main', async () => {
    const { code, output } = await runHook('git push origin main');
    assert.strictEqual(code, 0);
    assert.strictEqual(output.hookSpecificOutput?.permissionDecision, 'deny');
    assert.ok(output.hookSpecificOutput?.permissionDecisionReason.includes('push-main'));
  });

  it('returns deny for gh pr merge', async () => {
    const { code, output } = await runHook('gh pr merge 123');
    assert.strictEqual(code, 0);
    assert.strictEqual(output.hookSpecificOutput?.permissionDecision, 'deny');
    assert.ok(output.hookSpecificOutput?.permissionDecisionReason.includes('gh-pr-merge'));
  });

  it('returns deny for gh pr close', async () => {
    const { code, output } = await runHook('gh pr close 123');
    assert.strictEqual(code, 0);
    assert.strictEqual(output.hookSpecificOutput?.permissionDecision, 'deny');
    assert.ok(output.hookSpecificOutput?.permissionDecisionReason.includes('gh-pr-close'));
  });

  it('returns deny for gh repo delete', async () => {
    const { code, output } = await runHook('gh repo delete owner/repo --yes');
    assert.strictEqual(code, 0);
    assert.strictEqual(output.hookSpecificOutput?.permissionDecision, 'deny');
    assert.ok(output.hookSpecificOutput?.permissionDecisionReason.includes('gh-repo-delete'));
  });

  it('returns deny for git branch -D main', async () => {
    const { code, output } = await runHook('git branch -D main');
    assert.strictEqual(code, 0);
    assert.strictEqual(output.hookSpecificOutput?.permissionDecision, 'deny');
    assert.ok(output.hookSpecificOutput?.permissionDecisionReason.includes('branch-delete-protected'));
  });

  it('returns empty object for safe command', async () => {
    const { code, output } = await runHook('git status');
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });

  it('returns empty object for non-Bash tool', async () => {
    const child = spawn('node', [SCRIPT_PATH]);
    let stdout = '';

    const result = await new Promise((resolve) => {
      child.stdout.on('data', (data) => { stdout += data; });
      child.on('close', (code) => {
        resolve({ code, output: JSON.parse(stdout.trim()) });
      });

      child.stdin.write(JSON.stringify({
        tool_name: 'Read',
        tool_input: { file_path: '/etc/passwd' }
      }));
      child.stdin.end();
    });

    assert.deepStrictEqual(result.output, {});
  });

  it('includes emoji in deny reason', async () => {
    const { output } = await runHook('git push origin main');
    const reason = output.hookSpecificOutput?.permissionDecisionReason;
    assert.ok(reason.includes('⛔'));
  });

  it('returns empty object for invalid JSON input', async () => {
    const child = spawn('node', [SCRIPT_PATH]);
    let stdout = '';

    const result = await new Promise((resolve) => {
      child.stdout.on('data', (data) => { stdout += data; });
      child.on('close', (code) => {
        resolve({ code, output: JSON.parse(stdout.trim()) });
      });

      child.stdin.write('not json');
      child.stdin.end();
    });

    assert.deepStrictEqual(result.output, {});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Config Tests - verify PATTERNS structure
// ─────────────────────────────────────────────────────────────────────────────

describe('Config: PATTERNS structure', () => {
  it('has unique id for each pattern', () => {
    const ids = PATTERNS.map(p => p.id);
    const unique = [...new Set(ids)];
    assert.strictEqual(ids.length, unique.length, 'Duplicate pattern IDs found');
  });

  it('has regex and reason for each pattern', () => {
    for (const p of PATTERNS) {
      assert.ok(p.regex instanceof RegExp, `Pattern ${p.id} missing regex`);
      assert.ok(typeof p.reason === 'string' && p.reason.length > 0, `Pattern ${p.id} missing reason`);
    }
  });

  it('has a valid level for each pattern', () => {
    for (const p of PATTERNS) {
      assert.ok(LEVELS[p.level], `Pattern ${p.id} has invalid level: ${p.level}`);
    }
  });

  it('branchOnly patterns have {branch} placeholder in reason', () => {
    for (const p of PATTERNS.filter(p => p.branchOnly)) {
      assert.ok(p.reason.includes('{branch}'), `Pattern ${p.id} is branchOnly but reason lacks {branch} placeholder`);
    }
  });

  it('non-branchOnly patterns do not have {branch} placeholder', () => {
    for (const p of PATTERNS.filter(p => !p.branchOnly)) {
      assert.ok(!p.reason.includes('{branch}'), `Pattern ${p.id} is not branchOnly but reason has {branch} placeholder`);
    }
  });

  it('PROTECTED_BRANCHES includes main and master', () => {
    assert.ok(PROTECTED_BRANCHES.includes('main'));
    assert.ok(PROTECTED_BRANCHES.includes('master'));
  });
});
