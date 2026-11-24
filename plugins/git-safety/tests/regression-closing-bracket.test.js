#!/usr/bin/env node
/**
 * Regression tests for git-safety: a ref or force flag right before a closing paren or redirect still counts.
 *
 * Run: node --test plugins/git-safety/tests/regression-closing-bracket.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

delete process.env.HOOK_SAFETY_LEVEL;

const { checkCommand } = require('../git-safety.js');

function shouldBlock(cmd, expectedId, branch, level) {
  const result = checkCommand(cmd, branch, level);
  assert.strictEqual(result.blocked, true, `Expected BLOCKED but was ALLOWED: ${cmd}`);
  assert.strictEqual(result.pattern.id, expectedId, `Expected pattern '${expectedId}' but got '${result.pattern.id}'`);
}

function shouldAllow(cmd, branch, level) {
  const result = checkCommand(cmd, branch, level);
  assert.strictEqual(result.blocked, false, `Expected ALLOWED but was BLOCKED by '${result.pattern?.id}': ${cmd}`);
}

describe('push to main or master right before a closing paren or redirect', () => {
  it('blocks the recorded inputs', () => {
    for (const c of ['(cd repo && git push origin main)', '(git push origin HEAD:main)', 'git push origin main>/dev/null'])
      shouldBlock(c, 'push-main', 'feature');
  });
  it('blocks master in the same positions', () => {
    for (const c of ['(git push origin master)', 'git push origin master<input', 'echo `git push origin master`'])
      shouldBlock(c, 'push-master', 'feature');
  });
  it('a main-like branch before a closing paren is still not main', () =>
    shouldAllow('(cd repo && git push origin main-menu-fix)', 'main-menu-fix'));
});

describe('a paren or angle bracket inside quotes is part of the ref', () => {
  it('allows a push to the branch main)fix', () => shouldAllow("git push origin 'main)fix'", 'feature'));
  it('allows a push to the branch master<preview', () => shouldAllow("git push origin 'master<preview'", 'feature'));
  it('allows the same names double-quoted, escaped or as a refspec side', () => {
    for (const c of ['git push origin "main)fix"', 'git push origin main\\)fix', "git push origin 'HEAD:main)fix'", "git push origin HEAD:'main>x'"])
      shouldAllow(c, 'feature');
  });
  it('still blocks main before an unquoted paren or redirect on a line with quotes', () => {
    for (const c of [`echo "x" ; (git push origin 'main')`, 'git commit -m "it is" && (git push origin main)', "git push origin 'main'>log", "cat <<EOF\nit's\nEOF\n(git push origin main)"])
      shouldBlock(c, 'push-main', 'feature');
  });
});

describe('force push right before a closing paren or redirect (strict)', () => {
  it('blocks the recorded input', () => shouldBlock('(git push --force)', 'force-push', 'feature', 'strict'));
  it('blocks -f before a redirect', () => shouldBlock('git push origin feature -f>/dev/null', 'force-push', 'feature', 'strict'));
  it('allows --force-with-lease before a closing paren', () => shouldAllow('(git push --force-with-lease)', 'feature', 'strict'));
  it('high still delegates it to the sibling hook', () => shouldAllow('(git push --force)', 'feature', 'high'));
});
