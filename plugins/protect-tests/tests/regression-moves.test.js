#!/usr/bin/env node
/**
 * Regression tests for protect-tests.js: moving tests away
 *
 * Run: node --test plugins/protect-tests/tests/regression-moves.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { checkTool } = require('../protect-tests.js');

function shouldBlock(toolName, toolInput, expectedId = null, safetyLevel = undefined) {
  const result = checkTool(toolName, toolInput, safetyLevel);
  assert.strictEqual(result.blocked, true, `Expected BLOCKED but was ALLOWED: ${JSON.stringify(toolInput)}`);
  if (expectedId) assert.strictEqual(result.id, expectedId, `Expected id '${expectedId}' but got '${result.id}'`);
}

function shouldAllow(toolName, toolInput, safetyLevel = undefined) {
  const result = checkTool(toolName, toolInput, safetyLevel);
  assert.strictEqual(result.blocked, false, `Expected ALLOWED but was BLOCKED by '${result.id}': ${JSON.stringify(toolInput)}`);
}

// Moves that once took tests out of the run: a separator or brace right
// after the disabled name, other disabled names, a rename to a name no
// runner collects, mv -t, and temp folders the old list missed.
describe('Regression: moving tests away', () => {
  it('denies a disabled name followed by ; | ) or written as a brace list', () => {
    for (const command of ['mv tests/a.test.js tests/a.test.js.bak; npm test', '(mv tests/a.test.js tests/a.test.js.bak)',
      'mv tests/a.test.js tests/a.test.js.bak|cat', 'mv src/math_test.go src/math_test.go.bak;go test ./...', 'mv tests/a.test.js{,.bak}']) {
      shouldBlock('Bash', { command }, 'rename-test');
    }
  });

  it('denies other disabled names and renames to a name the runner skips', () => {
    for (const command of ['mv tests/a.test.js tests/a.test.js.off', 'mv tests/a.test.js tests/a.test.js.backup', 'mv tests/a.test.js tests/a.test.js.skipped',
      'mv tests/a.test.js tests/a.js', 'mv tests/test_math.py tests/math_disabled.py', 'mv tests ../graveyard', 'git mv tests attic']) {
      shouldBlock('Bash', { command }, 'rename-test');
    }
  });

  it('denies mv -t and moves into mktemp or /private/var/tmp', () => {
    for (const command of ['mv -t /tmp tests', 'mv -t /tmp tests/test_a.py', 'mv tests "$(mktemp -d)"', 'mv tests /private/var/tmp/x']) {
      shouldBlock('Bash', { command }, 'delete-test');
    }
  });

  it('still allows renames between test names and moves inside the project', () => {
    for (const command of ['mv tests/test_a.py tests/test_b.py', 'mv test tests', 'mv tests/conftest.py tests/conftest_old.py',
      'git mv src/app.test.js src/__tests__/app.js', 'mv -v tests/test_a.py tests/unit/', 'mv dist /tmp/dist-old', 'mv README.md docs/']) {
      shouldAllow('Bash', { command });
    }
  });
});

describe('Regression: move verdicts across a whole command', () => {
  it('still denies a delete at the critical level after a rename earlier in the command', () => {
    shouldBlock('Bash', { command: 'mv tests/a.test.js a.js && rm tests/b.test.js' }, 'delete-test', 'critical');
    shouldAllow('Bash', { command: 'mv tests/a.test.js a.js' }, 'critical');
  });

  it('reports the most severe of several moves', () => {
    shouldBlock('Bash', { command: 'mv tests/a.test.js a.js; mv tests /tmp' }, 'delete-test');
  });

  it('treats mv as a command only in command position, and honours git mv dry runs', () => {
    for (const command of ['echo mv example.test.js example.js', 'git mv -n example.test.js example.js', 'git mv --dry-run tests attic']) shouldAllow('Bash', { command });
    shouldBlock('Bash', { command: 'sudo mv tests ../graveyard' }, 'rename-test');
  });
});
