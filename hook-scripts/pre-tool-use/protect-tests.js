#!/usr/bin/env node
/**
 * Protect Tests - PreToolUse Hook for Bash|Edit|MultiEdit|Write
 * Blocks the "fake green" failure mode: an agent that makes a suite pass by
 * deleting, renaming-away, or disabling (skip/xfail/ignore) test cases instead
 * of fixing the code. Logs to: ~/.claude/hooks-logs/
 *
 * SAFETY_LEVEL: 'critical' | 'high' | 'strict'
 *   critical - deleting test files or whole test directories (rm / git rm)
 *   high     - + renaming a test file to a disabled name, + introducing a
 *              skip/xfail/ignore marker into an existing test (Edit/MultiEdit)
 *   strict   - + writing a whole test file that is already skipped (Write)
 *
 * It does NOT block writing new, real tests, refactor-renaming a test to another
 * test name, or editing test bodies — only removal and disabling.
 *
 * Setup in .claude/settings.json:
 * {
 *   "hooks": {
 *     "PreToolUse": [{
 *       "matcher": "Bash|Edit|MultiEdit|Write",
 *       "hooks": [{ "type": "command", "command": "node /path/to/protect-tests.js" }]
 *     }]
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');

const SAFETY_LEVEL = 'high';

const LEVELS = { critical: 1, high: 2, strict: 3 };
const EMOJIS = { critical: '🚨', high: '⛔', strict: '⚠️' };
const LOG_DIR = path.join(process.env.HOME || '/tmp', '.claude', 'hooks-logs');

// A path that looks like a test file (many languages / conventions).
const TEST_PATH = new RegExp(
  [
    '(^|/)(tests?|__tests__|spec|specs)/',        // inside a test directory
    '(^|/)test_[^/]+\\.py$',                        // pytest / unittest
    '_test\\.(py|go|rb|js|jsx|ts|tsx|mjs|cjs)$',    // *_test.*
    '\\.(test|spec)\\.(js|jsx|ts|tsx|mjs|cjs)$',    // *.test.* / *.spec.*
    '(^|/)[^/]+_spec\\.rb$',                        // rspec
    '(^|/)[^/]*Test\\.(java|kt|cs)$',               // JUnit / xUnit
    '(^|/)Test[^/]*\\.(java|kt|cs)$',
  ].join('|'),
  'i'
);

// The same, but as it would appear as a token inside a shell command.
const TEST_TOKEN =
  /(test_[\w.-]+\.\w+|[\w.-]+_test\.\w+|[\w.-]+\.(test|spec)\.\w+|[\w.-]+_spec\.rb|(^|[\s'"/])(tests?|__tests__|specs?)\/)/;

const DELETE_VERB = /(\brm\b|\bunlink\b|\bshred\b|\btrash\b|\bgit\s+rm\b)/;
const RENAME_VERB = /\bmv\b/;
const DISABLED_DEST = /(\.bak|\.old|\.orig|\.disabled|\.skip|\.ignore|\.tmp|~)(["'\s]|$)/i;

// Markers that turn an existing test off in place.
const SKIP_MARKERS = [
  /@pytest\.mark\.(skip|xfail)/,          // pytest
  /@unittest\.skip/,                       // unittest
  /\bpytest\.skip\s*\(/,
  /@Disabled\b/,                           // JUnit 5
  /@Ignore\b/,                             // JUnit 4 / TestNG
  /\b(it|test|describe|context)\.skip\s*\(/, // jest / mocha / vitest
  /\bx(it|describe|test|context)\s*\(/,      // xit / xdescribe ...
  /\bt\.Skip(Now)?\s*\(/,                   // Go
  /#\[ignore\]/,                           // Rust
  /\[Ignore\]/,                            // NUnit / MSTest
];

function log(data) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...data }) + '\n');
  } catch {}
}

function addedMarker(oldStr, newStr) {
  const before = oldStr || '';
  for (const m of SKIP_MARKERS) {
    if (m.test(newStr) && !m.test(before)) return true;
  }
  return false;
}

// Returns { blocked, id, level, reason } — pure, so it is unit-testable.
function checkTool(toolName, toolInput = {}, safetyLevel = SAFETY_LEVEL) {
  const threshold = LEVELS[safetyLevel] || 2;
  const allow = () => ({ blocked: false });
  const deny = (level, id, reason) =>
    LEVELS[level] <= threshold ? { blocked: true, id, level, reason } : allow();

  if (toolName === 'Bash') {
    const cmd = toolInput.command || '';
    if (!TEST_TOKEN.test(cmd)) return allow();
    if (DELETE_VERB.test(cmd)) return deny('critical', 'delete-test', 'deleting test file(s) or test directory');
    if (RENAME_VERB.test(cmd) && DISABLED_DEST.test(cmd))
      return deny('high', 'rename-test', 'renaming a test file to a disabled name');
    return allow();
  }

  if (toolName === 'Edit') {
    if (TEST_PATH.test(toolInput.file_path || '') && addedMarker(toolInput.old_string, toolInput.new_string))
      return deny('high', 'skip-test', 'adding a skip/xfail/ignore marker to an existing test');
    return allow();
  }

  if (toolName === 'MultiEdit') {
    if (TEST_PATH.test(toolInput.file_path || '')) {
      for (const e of toolInput.edits || []) {
        if (addedMarker(e.old_string, e.new_string))
          return deny('high', 'skip-test', 'adding a skip/xfail/ignore marker to an existing test');
      }
    }
    return allow();
  }

  if (toolName === 'Write') {
    if (TEST_PATH.test(toolInput.file_path || '') && addedMarker('', toolInput.content || ''))
      return deny('strict', 'write-skipped-test', 'writing a test file that is already skipped/ignored');
    return allow();
  }

  return allow();
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  try {
    const data = JSON.parse(input);
    const { tool_name, tool_input, session_id, cwd, permission_mode } = data;
    const result = checkTool(tool_name, tool_input || {});

    if (result.blocked) {
      log({ level: 'BLOCKED', id: result.id, priority: result.level, tool: tool_name, session_id, cwd, permission_mode });
      return console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `${EMOJIS[result.level]} [${result.id}] ${result.reason}. Fix the code, don't disable the test — or run this manually if the removal is intentional.`
        }
      }));
    }
    console.log('{}');
  } catch (e) {
    log({ level: 'ERROR', error: e.message });
    console.log('{}');
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = { SKIP_MARKERS, TEST_PATH, LEVELS, SAFETY_LEVEL, checkTool };
}
