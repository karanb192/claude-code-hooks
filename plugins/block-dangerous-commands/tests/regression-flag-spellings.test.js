#!/usr/bin/env node
/**
 * Regression tests for block-dangerous-commands: flags in any spelling git and sudo accept
 *
 * Run: node --test plugins/block-dangerous-commands/tests/regression-flag-spellings.test.js
 * Or:  npm test
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

// A HOOK_SAFETY_LEVEL leaking in from the runner's shell would change the default level.
delete process.env.HOOK_SAFETY_LEVEL;

const { checkCommand } = require('../block-dangerous-commands.js');

function shouldBlock(cmd, expectedId, safetyLevel = undefined) {
  const result = checkCommand(cmd, safetyLevel);
  assert.strictEqual(result.blocked, true, `Expected BLOCKED but was ALLOWED: ${cmd}`);
  assert.strictEqual(result.pattern.id, expectedId, `Expected pattern '${expectedId}' but got '${result.pattern.id}'`);
}

function shouldAllow(cmd, safetyLevel = undefined) {
  const result = checkCommand(cmd, safetyLevel);
  assert.strictEqual(result.blocked, false, `Expected ALLOWED but was BLOCKED by '${result.pattern?.id}': ${cmd}`);
}

describe('force push with -f inside a short-flag cluster', () => {
  it('blocks a force push to main', () => {
    for (const c of ['git push -fu origin main', 'git push -uf origin main', 'git push origin main -fq', 'git push -vf origin main'])
      shouldBlock(c, 'git-force-main');
  });
  it('blocks a force push to any branch at strict', () => {
    shouldBlock('git push -uf origin feature', 'git-force-any', 'strict');
    shouldBlock('git push -fu origin feature', 'git-force-any', 'strict');
  });
  it('allows clusters without f, and an f inside the -o value', () => {
    for (const c of ['git push -u origin main', 'git push -ofoo origin main', 'git push --follow-tags origin main']) shouldAllow(c);
    shouldAllow('git push -u origin feature', 'strict');
  });
});

describe('git clean -f in any position or spelling', () => {
  it('blocks -f after other options, --force and an abbreviation', () => {
    for (const c of ['git clean -d -f', 'git clean --force', 'git clean -d --force', 'git clean -x -f', 'git clean -q -f', 'git clean -e tmp -f', 'git clean --forc'])
      shouldBlock(c, 'git-clean-f');
  });
  it('allows git clean without force', () => {
    for (const c of ['git clean -n', 'git clean -nd', 'git clean -e foo', 'git clean --dry-run']) shouldAllow(c);
  });
});

describe('git reset with an abbreviation of --hard', () => {
  it('blocks --har and --h', () => {
    shouldBlock('git reset --har HEAD~3', 'git-reset-hard');
    shouldBlock('git reset --h', 'git-reset-hard');
  });
  it('allows other reset modes and --help', () => {
    shouldAllow('git reset --soft HEAD~1');
    shouldAllow('git reset --help');
  });
});

describe('sudo rm behind sudo options or a path (strict)', () => {
  it('blocks sudo options, -- and a path to rm', () => {
    for (const c of ['sudo -n rm -rf build', 'sudo -u root rm -rf build', 'sudo /bin/rm -rf build', 'sudo -- rm -rf build'])
      shouldBlock(c, 'sudo-rm', 'strict');
  });
  it('allows rm as an option value, an argument or a later command', () => {
    for (const c of ['sudo -u rm ls', 'sudo apt remove rm', 'sudo ls; rm x']) shouldAllow(c, 'strict');
  });
});

describe('git clean reads option values and dry runs', () => {
  it('allows an exclude pattern that looks like a flag, and a dry run', () => {
    for (const c of ['git clean -e -foo', 'git clean --exclude -f', 'git clean -n -f', 'git clean --dry-run --force', 'git clean -d -- -f']) shouldAllow(c);
  });
  it('still blocks force after an exclude pattern, a cancelled dry run and a force flag first', () => {
    for (const c of ['git clean -e -foo -f', 'git clean -n --no-dry-run -f', 'git clean -nf', 'git clean -f -n']) shouldBlock(c, 'git-clean-f');
  });
});

describe('sudo named by its path (strict)', () => {
  it('blocks /usr/bin/sudo rm with or without sudo options', () => {
    for (const c of ['/usr/bin/sudo rm -rf build', '/usr/bin/sudo -n rm x']) shouldBlock(c, 'sudo-rm', 'strict');
  });
});

describe('git clean with a redirect between its operands', () => {
  it('still sees a force flag after a redirect', () => {
    for (const c of ['git clean 2>/dev/null -f', 'git clean -d >log -f', 'git clean 2>&1 -f']) shouldBlock(c, 'git-clean-f');
  });
  it('still refuses these dry runs, which main or the earlier reading refused', () => {
    for (const c of ['git clean -efoo', 'git clean -f --dry-run', 'git clean --force 2>/dev/null -n']) shouldBlock(c, 'git-clean-f');
  });
  it('still allows a dry run before any redirect', () => shouldAllow('git clean -n 2>/dev/null -f'));
});
