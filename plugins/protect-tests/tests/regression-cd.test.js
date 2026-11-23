#!/usr/bin/env node
/**
 * Regression tests for protect-tests.js: a cd earlier in the command
 *
 * Run: node --test plugins/protect-tests/tests/regression-cd.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkTool } = require('../protect-tests.js');



// After a cd into a test folder the operands no longer name it. These
// inputs once passed.
describe('Regression: a cd earlier in the command', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protect-tests-cd-'));
  for (const d of ['tests/unit', 'test', 'src/__tests__']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests', 'a.test.js'), "it('adds', () => {});\n");
  fs.writeFileSync(path.join(dir, 'tests', 'a.js'), "it('adds', () => {});\n");
  fs.writeFileSync(path.join(dir, 'test', 'api.js'), "it('gets', () => {});\n");
  fs.writeFileSync(path.join(dir, 'src', 'math.test.js'), "it('adds', () => {});\n");
  const run = (command) => checkTool('Bash', { command }, undefined, dir);

  it('denies deletes after cd or pushd into a test folder', () => {
    for (const command of ['cd tests && rm -r unit integration conftest.py', 'cd tests && rm -rf *', '(cd tests; rm -r unit)', 'cd src/__tests__ && rm helpers.js', 'pushd tests && rm x.py']) {
      assert.strictEqual(run(command).id, 'delete-test', command);
    }
  });

  it('denies an in-place skip after cd into a test folder', () => {
    assert.strictEqual(run("cd test && sed -i 's/it(/it.skip(/' api.js").id, 'skip-test');
    assert.strictEqual(run("cd tests && sed -i 's/it(/it.skip(/' a.js").id, 'skip-test');
  });

  it('reads a redirect target from the directory the cd moved to, and $PWD', () => {
    assert.strictEqual(run(`cd tests && printf "it.skip('adds', () => {})\\n" > a.test.js`).id, 'skip-test');
    assert.strictEqual(run(`cd src && printf "it.skip('adds', () => {})\\n" > math.test.js`).id, 'skip-test');
    assert.strictEqual(run(`printf "it.skip('adds', () => {})\\n" > "$PWD/tests/a.test.js"`).id, 'skip-test');
  });

  it('still allows cleanup, test runs and commands after leaving the folder', () => {
    for (const command of ['cd tests && rm -rf __pycache__', 'cd tests && rm -f *.pyc .pytest_cache', 'cd tests && pytest -q', 'cd src && rm old.js',
      'cd tests; cd ..; rm foo.txt', '(cd tests && npm test) && rm -rf build', 'cd tests && echo hi > notes.txt', 'cd tests && sed -i s/foo/bar/ a.js']) {
      assert.strictEqual(run(command).blocked, false, command);
    }
  });
});
