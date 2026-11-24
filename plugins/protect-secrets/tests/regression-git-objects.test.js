#!/usr/bin/env node
/**
 * Regression: git commands that print a protected file's contents from the repository's objects
 * (show REV:path, cat-file, blame, archive, grep, and diff, show or log with a patch) are refused.
 *
 * Run: node --test plugins/protect-secrets/tests/regression-git-objects.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const standalone = require('../protect-secrets.js');
const bundled = require('../../guard-pack/lib/protect-secrets.js');

const REFUSED = [
  ['git show HEAD:.env', 'high'],
  ['git show main:config/.env.production', 'high'],
  ['git show :.env', 'high'],
  ['git show :0:.env', 'high'],
  ['git -C repo show HEAD:.env', 'high'],
  ['git --no-pager show HEAD~3:.npmrc', 'high'],
  ['git cat-file -p HEAD:.env', 'high'],
  ['git cat-file blob HEAD:.env', 'high'],
  ['git log -p -- .env', 'high'],
  ['git log --patch -- ~/.aws/credentials', 'high'],
  ['git log -L 1,5:.env', 'high'],
  ['git diff HEAD~1 -- .env', 'high'],
  ['git diff HEAD~1:.env HEAD:.env', 'high'],
  ['git blame .env', 'high'],
  ['git show HEAD:.npmrc', 'high'],
  // --exit-code and --check still print lines, and a patch flag wins over a stat.
  ['git diff --exit-code -- .env', 'high'],
  ['git diff --check -- .env', 'high'],
  ['git diff --stat --patch -- .env', 'high'],
  ['git log --stat --patch -- .npmrc', 'high'],
  ['git grep -e TOKEN -- .npmrc', 'high'],
  ['git grep -f .npmrc README.md', 'high'],
];

const ALLOWED = [
  ['git show HEAD', 'high'],
  ['git show HEAD:README.md', 'high'],
  ['git show HEAD:.env.example', 'high'],
  ['git cat-file -s HEAD:.env', 'high'],
  ['git log -- .env', 'high'],
  ['git log --oneline .env', 'high'],
  ['git diff --stat -- .env', 'high'],
  ['git log -p', 'high'],
  ['git diff main...feature -- src/', 'high'],
  // A stat of two blobs prints no contents, and search text or an author is not a path.
  ['git diff --stat HEAD:.env HEAD~1:.env', 'high'],
  ['git diff --name-only HEAD~1:.npmrc HEAD:.npmrc', 'high'],
  ['git grep -e .npmrc README.md', 'high'],
  ['git grep --regexp .npmrc README.md', 'high'],
  ['git log -p --author .npmrc', 'high'],
  ['git log -p --grep .npmrc', 'high'],
];

for (const [name, mod] of [['protect-secrets', standalone], ['guard-pack copy', bundled]]) {
  describe(`${name}: git reads of a protected file are refused`, () => {
    for (const [command, level] of REFUSED) {
      it(`${level}: ${JSON.stringify(command)}`, () => {
        const r = mod.check('Bash', { command }, level);
        assert.strictEqual(r.blocked, true, `allowed: ${command}`);
      });
    }
  });

  describe(`${name}: neighbouring commands stay allowed`, () => {
    for (const [command, level] of ALLOWED) {
      it(`${level}: ${JSON.stringify(command)}`, () => {
        const r = mod.check('Bash', { command }, level);
        assert.strictEqual(r.blocked, false, `refused as ${r.pattern && r.pattern.id}: ${command}`);
      });
    }
  });
}
