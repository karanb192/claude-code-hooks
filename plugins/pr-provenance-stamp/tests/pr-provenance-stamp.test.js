#!/usr/bin/env node
/**
 * Tests for pr-provenance-stamp.js
 *
 * Run: node --test plugins/pr-provenance-stamp/tests/pr-provenance-stamp.test.js
 * Or:  npm test
 *
 * Hermetic: every filesystem touch is redirected to a fresh temp dir; spawned
 * integration tests get a temp HOME. No ambient env, no real ~/.claude writes.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('../pr-provenance-stamp.js');
const {
  emptyLedger,
  ledgerPath,
  loadLedger,
  saveLedger,
  countAddedLines,
  extractTestResult,
  applyPostToolUse,
  normalizeModel,
  priceFor,
  parseTranscript,
  buildProvenance,
  renderSummaryLine,
  renderStamp,
  applyStampToBody,
  isPrCreate,
  tokenizeShell,
  hasUnsafeShellConstruct,
  sumNumstatAdditions,
  totalBranchAddedLines,
  rewriteBodyArg,
  handlePostToolUse,
  handlePreToolUse,
  STAMP_BEGIN,
  STAMP_END,
} = mod;

const SCRIPT_PATH = path.join(__dirname, '../pr-provenance-stamp.js');

// ─────────────────────────────────────────────────────────────────────────────
// Fresh temp dir per describe-block that needs the filesystem
// ─────────────────────────────────────────────────────────────────────────────

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pps-test-'));
}

// ─────────────────────────────────────────────────────────────────────────────
// isPrCreate
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: isPrCreate()', () => {
  it('matches gh pr create', () => assert.strictEqual(isPrCreate('gh pr create --title x'), true));
  it('matches gh pr create with flags before', () => assert.strictEqual(isPrCreate('gh  pr   create -t "x"'), true));
  it('matches glab mr create', () => assert.strictEqual(isPrCreate('glab mr create --fill'), true));
  it('does not match gh pr view', () => assert.strictEqual(isPrCreate('gh pr view 12'), false));
  it('does not match gh pr list', () => assert.strictEqual(isPrCreate('gh pr list'), false));
  it('does not match git commit', () => assert.strictEqual(isPrCreate('git commit -m x'), false));
  it('handles non-string', () => assert.strictEqual(isPrCreate(undefined), false));
  it('handles number', () => assert.strictEqual(isPrCreate(42), false));
});

// ─────────────────────────────────────────────────────────────────────────────
// countAddedLines
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: countAddedLines()', () => {
  it('counts non-empty Write content lines', () => {
    assert.strictEqual(countAddedLines('Write', { content: 'a\n\nb\nc\n' }), 3);
  });
  it('counts Edit new_string lines', () => {
    assert.strictEqual(countAddedLines('Edit', { new_string: 'x\ny' }), 2);
  });
  it('counts MultiEdit edits array', () => {
    assert.strictEqual(countAddedLines('Edit', { edits: [{ new_string: 'a\nb' }, { new_string: 'c' }] }), 3);
  });
  it('returns 0 for empty content', () => assert.strictEqual(countAddedLines('Write', { content: '\n\n' }), 0));
  it('returns 0 for missing input', () => assert.strictEqual(countAddedLines('Write', null), 0));
  it('returns 0 for unknown tool', () => assert.strictEqual(countAddedLines('Bash', { content: 'x' }), 0));
});

// ─────────────────────────────────────────────────────────────────────────────
// extractTestResult
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: extractTestResult()', () => {
  it('detects npm test with exit_code 0', () => {
    const r = extractTestResult('npm test', { exit_code: 0 });
    assert.deepStrictEqual({ ok: r.ok, exit: r.exit }, { ok: true, exit: 0 });
  });
  it('detects failing pytest via exitCode', () => {
    const r = extractTestResult('pytest -q', { exitCode: 1 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.exit, 1);
  });
  it('detects npm run typecheck', () => {
    assert.ok(extractTestResult('npm run typecheck', { exit_code: 0 }));
  });
  it('detects npx tsc', () => assert.ok(extractTestResult('npx tsc --noEmit', { exit_code: 0 })));
  it('detects go test', () => assert.ok(extractTestResult('go test ./...', { exit_code: 0 })));
  it('detects cargo test', () => assert.ok(extractTestResult('cargo test', { exit_code: 0 })));
  it('detects node --test', () => assert.ok(extractTestResult('node --test foo.test.js', { exit_code: 0 })));
  it('returns null for non-test bash', () => assert.strictEqual(extractTestResult('ls -la', { exit_code: 0 }), null));
  it('returns null for git status', () => assert.strictEqual(extractTestResult('git status', {}), null));
  it('infers exit 0 from clean stdout when code absent', () => {
    const r = extractTestResult('npm test', { stdout: 'ok 12 tests passed' });
    assert.strictEqual(r.ok, true);
  });
  it('infers exit 1 from FAIL marker when code absent', () => {
    const r = extractTestResult('npm test', { stdout: '1) FAIL should work' });
    assert.strictEqual(r.ok, false);
  });
  it('maps command-not-found stderr to 127', () => {
    const r = extractTestResult('pytest', { stderr: 'pytest: command not found' });
    assert.strictEqual(r.exit, 127);
    assert.strictEqual(r.ok, false);
  });
  it('handles non-string command', () => assert.strictEqual(extractTestResult(42, {}), null));
});

// ─────────────────────────────────────────────────────────────────────────────
// applyPostToolUse ledger mutation
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: applyPostToolUse()', () => {
  it('increments writes and agent_lines on Write', () => {
    const l = emptyLedger('s');
    applyPostToolUse(l, 'Write', { content: 'a\nb\nc' }, {});
    assert.strictEqual(l.writes, 1);
    assert.strictEqual(l.agent_lines, 3);
  });
  it('increments edits on Edit', () => {
    const l = emptyLedger('s');
    applyPostToolUse(l, 'Edit', { new_string: 'x' }, {});
    assert.strictEqual(l.edits, 1);
    assert.strictEqual(l.agent_lines, 1);
  });
  it('records a passing test on Bash', () => {
    const l = emptyLedger('s');
    applyPostToolUse(l, 'Bash', { command: 'npm test' }, { exit_code: 0 });
    assert.strictEqual(l.tests.length, 1);
    assert.strictEqual(l.tests[0].ok, true);
  });
  it('records a failing test on Bash', () => {
    const l = emptyLedger('s');
    applyPostToolUse(l, 'Bash', { command: 'pytest' }, { exit_code: 2 });
    assert.strictEqual(l.tests[0].ok, false);
    assert.strictEqual(l.tests[0].exit, 2);
  });
  it('does not record non-test Bash', () => {
    const l = emptyLedger('s');
    applyPostToolUse(l, 'Bash', { command: 'ls' }, { exit_code: 0 });
    assert.strictEqual(l.tests.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ledger persistence (temp dir)
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: ledger persistence', () => {
  let dir;
  before(() => { dir = freshDir(); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('loadLedger returns empty for missing session', () => {
    const l = loadLedger('never-seen', dir);
    assert.strictEqual(l.tool_calls, 0);
    assert.deepStrictEqual(l.tests, []);
  });

  it('save then load round-trips', () => {
    const l = emptyLedger('round');
    l.writes = 3;
    l.tests.push({ cmd: 'npm test', exit: 0, ok: true });
    assert.strictEqual(saveLedger(l, dir), true);
    const loaded = loadLedger('round', dir);
    assert.strictEqual(loaded.writes, 3);
    assert.strictEqual(loaded.tests.length, 1);
  });

  it('sanitizes session id in the path (no traversal escape)', () => {
    const p = ledgerPath('../../etc/passwd', dir);
    assert.ok(p.startsWith(dir + path.sep), 'path must stay inside dir');
    // Resolved path must still be contained in dir (slashes were stripped).
    assert.strictEqual(path.dirname(path.resolve(p)), path.resolve(dir));
  });

  it('handlePostToolUse persists across calls', () => {
    const sid = 'accumulate';
    handlePostToolUse({ tool_name: 'Write', tool_input: { content: 'a\nb' }, session_id: sid }, dir);
    handlePostToolUse({ tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { exit_code: 0 }, session_id: sid }, dir);
    const l = loadLedger(sid, dir);
    assert.strictEqual(l.writes, 1);
    assert.strictEqual(l.agent_lines, 2);
    assert.strictEqual(l.tests.length, 1);
  });

  it('handlePostToolUse ignores unrelated tools', () => {
    const out = handlePostToolUse({ tool_name: 'Read', tool_input: { file_path: '/x' }, session_id: 'r' }, dir);
    assert.deepStrictEqual(out, {});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Transcript parsing
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: parseTranscript()', () => {
  it('returns zeros for empty', () => {
    const r = parseTranscript('');
    assert.strictEqual(r.userPrompts, 0);
    assert.strictEqual(r.hasUsage, false);
  });

  it('handles malformed lines gracefully', () => {
    const r = parseTranscript('not json\n{bad\n\n');
    assert.strictEqual(r.userPrompts, 0);
  });

  it('counts real user prompts and skips tool_result-only turns', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'do the thing' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'now this' }] } }),
    ].join('\n');
    const r = parseTranscript(lines);
    assert.strictEqual(r.userPrompts, 2);
  });

  it('skips meta user turns', () => {
    const lines = [
      JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'system reminder' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'real' } }),
    ].join('\n');
    assert.strictEqual(parseTranscript(lines).userPrompts, 1);
  });

  it('sums usage into tokens and dollars and collects models', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-4', usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } } }),
    ].join('\n');
    const r = parseTranscript(lines);
    assert.strictEqual(r.hasUsage, true);
    assert.strictEqual(r.inputTokens, 1_000_000);
    assert.strictEqual(r.outputTokens, 1_000_000);
    // sonnet: $3 in + $15 out per 1M => $18
    assert.ok(Math.abs(r.dollars - 18) < 0.001, `dollars=${r.dollars}`);
    assert.deepStrictEqual(r.models, ['claude-sonnet']);
  });

  it('includes cache tokens in input cost', () => {
    const line = JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku', usage: { input_tokens: 0, cache_read_input_tokens: 1_000_000, output_tokens: 0 } } });
    const r = parseTranscript(line);
    assert.strictEqual(r.inputTokens, 1_000_000);
    assert.ok(r.dollars > 0);
  });
});

describe('Unit: pricing', () => {
  it('normalizes model families', () => {
    assert.strictEqual(normalizeModel('claude-opus-4-1'), 'claude-opus');
    assert.strictEqual(normalizeModel('claude-3-5-sonnet'), 'claude-sonnet');
    assert.strictEqual(normalizeModel('claude-haiku-4'), 'claude-haiku');
  });
  it('passes through unknown model ids', () => assert.strictEqual(normalizeModel('gpt-x'), 'gpt-x'));
  it('handles non-string', () => assert.strictEqual(normalizeModel(null), null));
  it('opus is priced higher than haiku', () => {
    assert.ok(priceFor('claude-opus-4').output > priceFor('claude-haiku-4').output);
  });
  it('unknown model gets default pricing', () => {
    assert.deepStrictEqual(priceFor('mystery'), priceFor('some-other'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildProvenance + rendering
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: buildProvenance() + render', () => {
  function sampleLedger() {
    const l = emptyLedger('s');
    l.agent_lines = 92;
    l.human_lines = 8;
    l.tests = [
      { cmd: 'npm test', exit: 0, ok: true },
      { cmd: 'npm run typecheck', exit: 0, ok: true },
    ];
    return l;
  }

  it('computes agent percentage', () => {
    const p = buildProvenance(sampleLedger(), parseTranscript(''));
    assert.strictEqual(p.agentPct, 92);
    assert.strictEqual(p.testsPassed, 2);
    assert.strictEqual(p.testsTotal, 2);
  });

  it('prefers transcript prompt count', () => {
    const transcript = parseTranscript(JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }));
    const p = buildProvenance(sampleLedger(), transcript);
    assert.strictEqual(p.prompts, 1);
  });

  it('null agentPct when no lines', () => {
    const p = buildProvenance(emptyLedger('s'), parseTranscript(''));
    assert.strictEqual(p.agentPct, null);
  });

  it('summary line contains signals', () => {
    const transcript = parseTranscript([
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'a' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'b' } }),
    ].join('\n'));
    const p = buildProvenance(sampleLedger(), transcript);
    const line = renderSummaryLine(p);
    assert.ok(line.includes('2 prompts'), line);
    assert.ok(line.includes('tests 2/2 green'), line);
    assert.ok(line.includes('92% agent-authored'), line);
  });

  it('summary shows failing count', () => {
    const l = sampleLedger();
    l.tests.push({ cmd: 'pytest', exit: 1, ok: false });
    const line = renderSummaryLine(buildProvenance(l, parseTranscript('')));
    assert.ok(line.includes('tests 2/3 1 failing'), line);
  });

  it('renderStamp is wrapped in sentinels and has a table', () => {
    const stamp = renderStamp(buildProvenance(sampleLedger(), parseTranscript('')));
    assert.ok(stamp.startsWith(STAMP_BEGIN));
    assert.ok(stamp.trim().endsWith(STAMP_END));
    assert.ok(stamp.includes('| Signal | Value |'));
    assert.ok(stamp.includes('Provenance'));
    assert.ok(stamp.includes('exit 0'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyStampToBody idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: applyStampToBody()', () => {
  const stamp = `${STAMP_BEGIN}\nSTAMP\n${STAMP_END}`;

  it('appends to a non-empty body', () => {
    const out = applyStampToBody('My PR description', stamp);
    assert.ok(out.startsWith('My PR description'));
    assert.ok(out.includes('STAMP'));
  });

  it('uses stamp alone for empty body', () => {
    assert.strictEqual(applyStampToBody('', stamp), stamp);
  });

  it('replaces a prior stamp (idempotent)', () => {
    const first = applyStampToBody('Body', stamp);
    const stamp2 = `${STAMP_BEGIN}\nSTAMP2\n${STAMP_END}`;
    const second = applyStampToBody(first, stamp2);
    assert.ok(second.includes('STAMP2'));
    assert.ok(!second.includes('STAMP\n'), 'old stamp body removed');
    // Exactly one sentinel pair remains.
    assert.strictEqual(second.split(STAMP_BEGIN).length - 1, 1);
    assert.ok(second.startsWith('Body'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// tokenizeShell + rewriteBodyArg
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: tokenizeShell()', () => {
  it('splits plain args', () => {
    assert.deepStrictEqual(tokenizeShell('gh pr create').map((t) => t.text), ['gh', 'pr', 'create']);
  });
  it('keeps quoted content together', () => {
    const toks = tokenizeShell(`gh pr create --title "my feature"`);
    assert.deepStrictEqual(toks.map((t) => t.text), ['gh', 'pr', 'create', '--title', 'my feature']);
  });
  it('handles single quotes', () => {
    const toks = tokenizeShell(`gh pr create --body 'hello world'`);
    assert.strictEqual(toks[toks.length - 1].text, 'hello world');
  });
});

describe('Unit: rewriteBodyArg()', () => {
  const stamp = `${STAMP_BEGIN}\nSTAMP\n${STAMP_END}`;

  it('adds a --body when none present', () => {
    const { command, changed } = rewriteBodyArg('gh pr create --title "x"', stamp);
    assert.strictEqual(changed, true);
    assert.ok(command.includes('--body'));
    assert.ok(command.includes('STAMP'));
  });

  it('appends into an existing --body', () => {
    const { command, changed } = rewriteBodyArg(`gh pr create --title "x" --body "original text"`, stamp);
    assert.strictEqual(changed, true);
    assert.ok(command.includes('original text'), command);
    assert.ok(command.includes('STAMP'), command);
  });

  it('handles --body=value form', () => {
    const { command, changed } = rewriteBodyArg(`gh pr create --body="inline body"`, stamp);
    assert.strictEqual(changed, true);
    assert.ok(command.includes('inline body'));
    assert.ok(command.includes('STAMP'));
  });

  it('handles -b short flag', () => {
    const { command, changed } = rewriteBodyArg(`gh pr create -b "short"`, stamp);
    assert.strictEqual(changed, true);
    assert.ok(command.includes('short'));
    assert.ok(command.includes('STAMP'));
  });

  it('defers on --body-file flows', () => {
    const { changed, deferred } = rewriteBodyArg('gh pr create --body-file body.md', stamp);
    assert.strictEqual(changed, false);
    assert.strictEqual(deferred, true);
  });

  it('defers on --fill flows', () => {
    const { changed, deferred } = rewriteBodyArg('gh pr create --fill', stamp);
    assert.strictEqual(changed, false);
    assert.strictEqual(deferred, true);
  });

  it('is idempotent: re-stamping replaces rather than duplicates', () => {
    const once = rewriteBodyArg(`gh pr create --body "orig"`, stamp).command;
    const stamp2 = `${STAMP_BEGIN}\nSTAMP2\n${STAMP_END}`;
    const twice = rewriteBodyArg(once, stamp2).command;
    assert.ok(twice.includes('STAMP2'));
    assert.strictEqual(twice.split(STAMP_BEGIN).length - 1, 1, 'only one stamp block');
  });

  it('handles non-string command', () => {
    assert.strictEqual(rewriteBodyArg(null, stamp).changed, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial: command-rewrite safety (splice must never corrupt a command)
// ─────────────────────────────────────────────────────────────────────────────

describe('Adversarial: rewriteBodyArg() command-position detection', () => {
  const stamp = `${STAMP_BEGIN}\nSTAMP\n${STAMP_END}`;

  it('does NOT touch echo "gh pr create" (quoted substring)', () => {
    const cmd = 'echo "gh pr create"';
    const r = rewriteBodyArg(cmd, stamp);
    assert.strictEqual(r.changed, false);
    assert.strictEqual(r.command, cmd, 'command left byte-for-byte unchanged');
  });

  it('does NOT touch echo gh pr create (not in command position)', () => {
    const cmd = 'echo gh pr create';
    const r = rewriteBodyArg(cmd, stamp);
    assert.strictEqual(r.changed, false);
    assert.strictEqual(r.command, cmd);
  });

  it('matches gh pr create after && in a compound command', () => {
    const r = rewriteBodyArg('git push && gh pr create --body "x" && echo done', stamp);
    assert.strictEqual(r.changed, true);
    assert.ok(r.command.startsWith('git push && gh pr create --body '), r.command);
    assert.ok(r.command.endsWith(' && echo done'), 'suffix preserved verbatim: ' + r.command);
    assert.ok(r.command.includes('STAMP'));
  });

  it('matches gh pr create on its own line of a multi-line command', () => {
    const r = rewriteBodyArg('git push\ngh pr create --body "x"', stamp);
    assert.strictEqual(r.changed, true);
    assert.ok(r.command.startsWith('git push\ngh pr create'), 'newline preserved: ' + JSON.stringify(r.command));
    assert.ok(r.command.includes('STAMP'));
  });

  it('matches with leading env assignments', () => {
    const r = rewriteBodyArg('GH_TOKEN=x gh pr create --body "y"', stamp);
    assert.strictEqual(r.changed, true);
    assert.ok(r.command.startsWith('GH_TOKEN=x gh pr create'), r.command);
  });

  it('handlePreToolUse no-ops on echo "gh pr create"', () => {
    const dir = freshDir();
    try {
      const out = handlePreToolUse({ tool_name: 'Bash', tool_input: { command: 'echo "gh pr create"' }, session_id: 'echo-s' }, dir);
      assert.deepStrictEqual(out, {});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Adversarial: rewriteBodyArg() splices only the body value', () => {
  const stamp = `${STAMP_BEGIN}\nSTAMP\n${STAMP_END}`;

  it('leaves a $VAR in ANOTHER argument untouched', () => {
    const r = rewriteBodyArg(`gh pr create --title "$BRANCH" --body 'plain'`, stamp);
    assert.strictEqual(r.changed, true);
    assert.ok(r.command.includes('--title "$BRANCH"'), 'title expansion preserved verbatim: ' + r.command);
    assert.ok(r.command.includes('STAMP'));
  });

  it('defers when the body value itself contains $VAR (would literalize)', () => {
    const cmd = 'gh pr create --body "Version $VERSION done"';
    const r = rewriteBodyArg(cmd, stamp);
    assert.strictEqual(r.changed, false);
    assert.strictEqual(r.command, cmd);
    assert.strictEqual(r.deferred, true);
  });

  it('defers on a backslash inside a double-quoted body (escape semantics)', () => {
    const cmd = 'gh pr create --body "path C:\\new"';
    const r = rewriteBodyArg(cmd, stamp);
    assert.strictEqual(r.changed, false);
    assert.strictEqual(r.command, cmd);
  });

  it('handles single quotes inside a double-quoted body', () => {
    const r = rewriteBodyArg(`gh pr create --body "don't panic"`, stamp);
    assert.strictEqual(r.changed, true);
    assert.ok(r.command.includes(`don'\\''t panic`), 'apostrophe re-quoted safely: ' + r.command);
    assert.ok(r.command.includes('STAMP'));
  });

  it('handles a mixed-quoting body value', () => {
    const r = rewriteBodyArg(`gh pr create --body "part one"' and two'`, stamp);
    assert.strictEqual(r.changed, true);
    assert.ok(r.command.includes('part one and two'), r.command);
  });

  it('stamps the LAST --body when the flag repeats (gh last-wins semantics)', () => {
    const r = rewriteBodyArg('gh pr create --body "a" --body "b"', stamp);
    assert.strictEqual(r.changed, true);
    assert.ok(r.command.includes('--body "a"'), 'first body untouched: ' + r.command);
    const last = r.command.lastIndexOf('--body');
    assert.ok(r.command.slice(last).includes('b'), r.command);
    assert.ok(r.command.slice(last).includes('STAMP'), 'stamp lives in the winning body: ' + r.command);
  });

  it('defers when --body has no value (malformed command left as-is)', () => {
    const cmd = 'gh pr create --title t --body';
    const r = rewriteBodyArg(cmd, stamp);
    assert.strictEqual(r.changed, false);
    assert.strictEqual(r.command, cmd);
  });

  it('defers when the unquoted body value carries a shell metacharacter', () => {
    const cmd = 'gh pr create --body hi;rm -rf /tmp/x';
    const r = rewriteBodyArg(cmd, stamp);
    assert.strictEqual(r.changed, false);
    assert.strictEqual(r.command, cmd);
  });
});

describe('Adversarial: body-file / fill / short-flag forms', () => {
  const stamp = `${STAMP_BEGIN}\nSTAMP\n${STAMP_END}`;

  for (const cmd of [
    'gh pr create --body-file=notes.md',
    'gh pr create -F notes.md',
    'gh pr create -Fnotes.md',
    'gh pr create --fill-first',
    'gh pr create --fill-verbose',
    'gh pr create -bhello --title t', // attached short-flag value
    'gh pr create -db "x"', // short-flag cluster containing b
  ]) {
    it(`defers on: ${cmd}`, () => {
      const r = rewriteBodyArg(cmd, stamp);
      assert.strictEqual(r.changed, false, cmd);
      assert.strictEqual(r.command, cmd, 'left byte-for-byte unchanged');
      assert.strictEqual(r.deferred, true);
    });
  }

  it('defers append when a body-like flag exists outside the gh window', () => {
    const cmd = 'gh pr create --title t && other-tool --body x';
    const r = rewriteBodyArg(cmd, stamp);
    assert.strictEqual(r.changed, false);
    assert.strictEqual(r.command, cmd);
  });

  it('append path inserts --body right after create, not at command end', () => {
    const r = rewriteBodyArg('gh pr create --title t && echo done', stamp);
    assert.strictEqual(r.changed, true);
    assert.ok(/^gh pr create --body '/.test(r.command), 'inserted after create: ' + r.command);
    assert.ok(r.command.endsWith('--title t && echo done'), 'tail preserved verbatim: ' + r.command);
  });
});

describe('Adversarial: idempotency with a REAL stamp (backticks, $ amounts)', () => {
  it('re-stamps a previously stamped command instead of deferring or duplicating', () => {
    const l = emptyLedger('re');
    l.agent_lines = 5;
    l.tests = [{ cmd: 'npm test -- --grep smoke', exit: 0, ok: true }];
    const realStamp = renderStamp(buildProvenance(l, parseTranscript(
      JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4', usage: { input_tokens: 1_000_000, output_tokens: 0 } } })
    )));
    assert.ok(realStamp.includes('`'), 'real stamp contains markdown backticks');
    assert.ok(realStamp.includes('$'), 'real stamp contains a dollar figure');

    const once = rewriteBodyArg('gh pr create --body "orig"', realStamp);
    assert.strictEqual(once.changed, true);
    const twice = rewriteBodyArg(once.command, realStamp);
    assert.strictEqual(twice.changed, true, 'single-quoted stamp content must not trip the unsafe scan');
    assert.strictEqual(twice.command.split(STAMP_BEGIN).length - 1, 1, 'exactly one stamp block');
    assert.ok(twice.command.includes('orig'), 'original body survives the round trip');
  });

  it('body containing the sentinel inside quotes is replaced, not doubled', () => {
    const stamp = `${STAMP_BEGIN}\nNEW\n${STAMP_END}`;
    const prior = `gh pr create --body 'desc\n\n${STAMP_BEGIN}\nOLD \`code\`\n${STAMP_END}'`;
    const r = rewriteBodyArg(prior, stamp);
    assert.strictEqual(r.changed, true);
    assert.ok(r.command.includes('NEW'));
    assert.ok(!r.command.includes('OLD'));
    assert.strictEqual(r.command.split(STAMP_BEGIN).length - 1, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Security: nothing secret-shaped may reach the public PR body
// ─────────────────────────────────────────────────────────────────────────────

describe('Security: secret redaction in ledger test commands', () => {
  it('redacts env-style secrets from a recorded test command', () => {
    const r = extractTestResult('API_KEY=sk-live-abc123 npm test', { exit_code: 0 });
    assert.ok(!r.cmd.includes('sk-live-abc123'), r.cmd);
    assert.ok(r.cmd.includes('[redacted]'), r.cmd);
    assert.ok(r.cmd.includes('npm test'), r.cmd);
  });

  it('redacts --token style flags', () => {
    const r = extractTestResult('npm test --token ghp_secret123', { exit_code: 0 });
    assert.ok(!r.cmd.includes('ghp_secret123'), r.cmd);
  });

  it('collapses newlines in recorded commands (markdown-safe)', () => {
    const r = extractTestResult('cd /tmp/x &&\n  npm test', { exit_code: 0 });
    assert.ok(!r.cmd.includes('\n'), JSON.stringify(r.cmd));
    assert.ok(r.cmd.includes('npm test'), r.cmd);
  });

  it('redacts at render time too (ledgers written by older versions)', () => {
    const l = emptyLedger('old');
    l.tests = [{ cmd: 'GITHUB_TOKEN=ghp_oldleak npm test', exit: 0, ok: true }];
    const stamp = renderStamp(buildProvenance(l, parseTranscript('')));
    assert.ok(!stamp.includes('ghp_oldleak'), stamp);
    assert.ok(stamp.includes('[redacted]'), stamp);
  });

  it('stamped body never escapes its single-quote context', () => {
    const l = emptyLedger('sec');
    l.tests = [{ cmd: "npm test -- --grep 'it'", exit: 0, ok: true }];
    l.agent_lines = 1;
    const stampBlock = renderStamp(buildProvenance(l, parseTranscript('')));
    const r = rewriteBodyArg('gh pr create --body "x"', stampBlock);
    assert.strictEqual(r.changed, true);
    // Every single quote in the spliced value must be the '\'' escape form.
    const spliced = r.command.slice(r.command.indexOf("--body '") + '--body '.length);
    const bare = spliced.replace(/'\\''/g, '');
    // After removing escape sequences, only the outer wrapping quotes remain.
    assert.strictEqual(bare.split("'").length - 1, 2, 'no unescaped quote breaks out: ' + spliced);
  });
});

describe('Unit: exit-code inference does not misread zero-count summaries', () => {
  it('"0 failed" is a pass', () => {
    const r = extractTestResult('npm test', { stdout: 'Tests: 12 passed, 0 failed' });
    assert.strictEqual(r.ok, true);
  });
  it('"0 failing" is a pass', () => {
    const r = extractTestResult('npm test', { stdout: '12 passing\n0 failing' });
    assert.strictEqual(r.ok, true);
  });
  it('node --test style "fail 0" is a pass', () => {
    const r = extractTestResult('node --test x.test.js', { stdout: 'pass 12\nfail 0' });
    assert.strictEqual(r.ok, true);
  });
  it('a real failure still fails', () => {
    const r = extractTestResult('npm test', { stdout: 'Tests: 1 failed, 11 passed' });
    assert.strictEqual(r.ok, false);
  });
});

describe('Unit: dollar figures are labeled as estimates', () => {
  it('summary and table mark spend as approximate', () => {
    const transcript = parseTranscript(JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-sonnet-4', usage: { input_tokens: 1_000_000, output_tokens: 0 } },
    }));
    const p = buildProvenance(emptyLedger('d'), transcript);
    assert.ok(renderSummaryLine(p).includes('~$'), renderSummaryLine(p));
    const stamp = renderStamp(p);
    assert.ok(stamp.includes('Spend (est.)'), stamp);
    assert.ok(stamp.includes('~$'), stamp);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// must-fix #1: defer on shell constructs the re-quoter would corrupt
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: hasUnsafeShellConstruct()', () => {
  it('flags command substitution $( )', () => {
    assert.strictEqual(hasUnsafeShellConstruct('gh pr create --body "$(cat notes.md)"'), true);
  });
  it('flags backticks', () => {
    assert.strictEqual(hasUnsafeShellConstruct('gh pr create --body "`date`"'), true);
  });
  it('flags a heredoc (<<EOF)', () => {
    assert.strictEqual(hasUnsafeShellConstruct('gh pr create --body "$(cat <<EOF\nhi\nEOF\n)"'), true);
  });
  it('flags a quoted heredoc marker', () => {
    assert.strictEqual(hasUnsafeShellConstruct("cat <<'EOF'\nx\nEOF"), true);
  });
  it('flags process substitution', () => {
    assert.strictEqual(hasUnsafeShellConstruct('diff <(a) <(b)'), true);
  });
  it('does not flag a plain quoted body', () => {
    assert.strictEqual(hasUnsafeShellConstruct('gh pr create --body "a normal description"'), false);
  });
  it('does not flag simple flags', () => {
    assert.strictEqual(hasUnsafeShellConstruct('gh pr create --title x --body y'), false);
  });
  it('handles non-string', () => assert.strictEqual(hasUnsafeShellConstruct(42), false));
});

describe('Unit: rewriteBodyArg() defers on unsafe constructs', () => {
  const stamp = `${STAMP_BEGIN}\nSTAMP\n${STAMP_END}`;

  it('defers on a heredoc body (does not corrupt it)', () => {
    const cmd = `gh pr create --title "x" --body "$(cat <<'EOF'\nreal body line\nEOF\n)"`;
    const r = rewriteBodyArg(cmd, stamp);
    assert.strictEqual(r.changed, false);
    assert.strictEqual(r.deferred, true);
    assert.strictEqual(r.command, cmd, 'command left byte-for-byte unchanged');
    assert.ok(!r.command.includes('STAMP'), 'no stamp spliced');
  });

  it('defers on command substitution in the body', () => {
    const cmd = 'gh pr create --body "closes $(git log -1 --format=%H)"';
    const r = rewriteBodyArg(cmd, stamp);
    assert.strictEqual(r.changed, false);
    assert.strictEqual(r.deferred, true);
    assert.strictEqual(r.command, cmd);
  });

  it('defers on backtick substitution', () => {
    const cmd = 'gh pr create --body "built on `hostname`"';
    const r = rewriteBodyArg(cmd, stamp);
    assert.strictEqual(r.changed, false);
    assert.ok(r.command.includes('`hostname`'), 'backticks preserved');
  });

  it('still stamps a plain body (regression guard)', () => {
    const r = rewriteBodyArg('gh pr create --body "plain text"', stamp);
    assert.strictEqual(r.changed, true);
    assert.ok(r.command.includes('STAMP'));
  });
});

describe('Unit: handlePreToolUse() defers on heredoc bodies', () => {
  let dir;
  before(() => { dir = freshDir(); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns {} (no-op) when body uses a heredoc', () => {
    const l = emptyLedger('hd'); l.agent_lines = 10; saveLedger(l, dir);
    const cmd = `gh pr create --body "$(cat <<'EOF'\nhello\nEOF\n)"`;
    const out = handlePreToolUse({ tool_name: 'Bash', tool_input: { command: cmd }, session_id: 'hd' }, dir);
    assert.deepStrictEqual(out, {});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// must-fix #2: real human/agent line split via git numstat
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: sumNumstatAdditions()', () => {
  it('sums the added column across rows', () => {
    assert.strictEqual(sumNumstatAdditions('10\t2\ta.js\n5\t0\tb.js'), 15);
  });
  it('skips binary (-) rows', () => {
    assert.strictEqual(sumNumstatAdditions('-\t-\timg.png\n7\t1\tc.js'), 7);
  });
  it('returns 0 for empty/non-string', () => {
    assert.strictEqual(sumNumstatAdditions(''), 0);
    assert.strictEqual(sumNumstatAdditions(null), 0);
  });
});

describe('Unit: totalBranchAddedLines() with injected git', () => {
  it('computes committed + staged + unstaged additions', () => {
    const fakeGit = (args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return 'refs/remotes/origin/main\n';
      if (j.startsWith('merge-base')) return 'abc123\n';
      if (j === 'diff --numstat abc123...HEAD') return '40\t3\tsrc.js\n';
      if (j === 'diff --numstat HEAD') return '5\t0\twork.js\n';
      if (j === 'diff --numstat --cached') return '5\t0\tstaged.js\n';
      return '';
    };
    assert.strictEqual(totalBranchAddedLines('/repo', fakeGit), 50);
  });

  it('falls back to origin/master when origin/HEAD is missing', () => {
    const fakeGit = (args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) throw new Error('no head');
      if (j === 'merge-base origin/main HEAD') throw new Error('no branch');
      if (j === 'merge-base origin/master HEAD') return 'base\n';
      if (j === 'diff --numstat base...HEAD') return '12\t0\tx.js\n';
      return '';
    };
    assert.strictEqual(totalBranchAddedLines('/repo', fakeGit), 12);
  });

  it('returns null when git is unavailable', () => {
    const fakeGit = () => { throw new Error('git not found'); };
    assert.strictEqual(totalBranchAddedLines('/repo', fakeGit), null);
  });
});

describe('Unit: buildProvenance() honest agent percentage', () => {
  it('suppresses percentage when only agent lines are known (no fake 100%)', () => {
    const l = emptyLedger('s'); l.agent_lines = 42;
    const p = buildProvenance(l, parseTranscript('')); // no git total
    assert.strictEqual(p.agentPct, null, 'must not claim 100%');
    assert.strictEqual(p.agentLines, 42);
  });

  it('computes a real split from a git total', () => {
    const l = emptyLedger('s'); l.agent_lines = 80;
    const p = buildProvenance(l, parseTranscript(''), 100); // 20 human lines
    assert.strictEqual(p.humanLines, 20);
    assert.strictEqual(p.agentPct, 80);
  });

  it('git total below agent lines does not go negative or exceed 100', () => {
    const l = emptyLedger('s'); l.agent_lines = 90;
    const p = buildProvenance(l, parseTranscript(''), 50); // stale/smaller total
    // totalAdded < agent → ignored, percentage suppressed rather than >100.
    assert.strictEqual(p.agentPct, null);
  });

  it('summary shows absolute agent lines when percentage unknown', () => {
    const l = emptyLedger('s'); l.agent_lines = 7;
    const line = renderSummaryLine(buildProvenance(l, parseTranscript('')));
    assert.ok(line.includes('7 agent-authored lines'), line);
    assert.ok(!line.includes('100%'), line);
  });

  it('renderStamp shows real denominator when git total present', () => {
    const l = emptyLedger('s'); l.agent_lines = 60;
    const stamp = renderStamp(buildProvenance(l, parseTranscript(''), 75));
    assert.ok(stamp.includes('80% (60 of 75 added lines)'), stamp);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// handlePreToolUse (pure, temp dir)
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: handlePreToolUse()', () => {
  let dir;
  before(() => { dir = freshDir(); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns {} for non-Bash', () => {
    assert.deepStrictEqual(handlePreToolUse({ tool_name: 'Read', tool_input: {} }, dir), {});
  });

  it('returns {} for a non-PR bash command', () => {
    assert.deepStrictEqual(handlePreToolUse({ tool_name: 'Bash', tool_input: { command: 'ls' } }, dir), {});
  });

  it('returns updatedInput with a stamped body for gh pr create', () => {
    // Seed a ledger for this session.
    const sid = 'pre-1';
    const l = emptyLedger(sid);
    l.agent_lines = 90; l.human_lines = 10;
    l.tests = [{ cmd: 'npm test', exit: 0, ok: true }];
    saveLedger(l, dir);

    const transcriptPath = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'build it' } }),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4', usage: { input_tokens: 500000, output_tokens: 100000 } } }),
    ].join('\n'));

    const out = handlePreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --title "feat" --body "hello"' },
      session_id: sid,
      transcript_path: transcriptPath,
    }, dir);

    assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    const cmd = out.hookSpecificOutput.updatedInput.command;
    assert.ok(cmd.includes('hello'), 'preserves original body');
    assert.ok(cmd.includes('Provenance'), 'includes stamp');
    assert.ok(cmd.includes('90% agent-authored') || cmd.includes('90%'), cmd);
    // Documented schema: updatedInput under hookSpecificOutput WITH
    // permissionDecision "allow" (the only combination the docs illustrate;
    // issue #15897 was a multi-hook aggregation bug, fixed in >= 2.1.168).
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'allow');
    assert.ok(typeof out.hookSpecificOutput.permissionDecisionReason === 'string');
  });

  it('returns {} (skips) for --fill PR create', () => {
    const out = handlePreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --fill' },
      session_id: 'pre-2',
    }, dir);
    assert.deepStrictEqual(out, {});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: spawn the script with a temp HOME
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration: stdin/stdout hook flow', () => {
  let home;
  before(() => { home = freshDir(); });
  after(() => { fs.rmSync(home, { recursive: true, force: true }); });

  function runHook(payload) {
    return new Promise((resolve, reject) => {
      const child = spawn('node', [SCRIPT_PATH], { env: { ...process.env, HOME: home } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => {
        try {
          resolve({ code, output: JSON.parse(stdout.trim()), stderr });
        } catch (e) {
          reject(new Error(`Failed to parse output: ${stdout} :: ${stderr}`));
        }
      });
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    });
  }

  it('PostToolUse Write records a ledger and returns {}', async () => {
    const { code, output } = await runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { content: 'line1\nline2\nline3' },
      session_id: 'int-session',
    });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
    const ledgerFile = path.join(home, '.claude', 'pr-provenance-stamp', 'int-session.json');
    assert.ok(fs.existsSync(ledgerFile), 'ledger persisted under temp HOME');
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf-8'));
    assert.strictEqual(ledger.agent_lines, 3);
  });

  it('PostToolUse Bash test records exit code', async () => {
    await runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { exit_code: 0 },
      session_id: 'int-session',
    });
    const ledger = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'pr-provenance-stamp', 'int-session.json'), 'utf-8'));
    assert.strictEqual(ledger.tests.length, 1);
    assert.strictEqual(ledger.tests[0].ok, true);
  });

  it('PreToolUse gh pr create returns updatedInput with a stamp', async () => {
    const transcriptPath = path.join(home, 'tp.jsonl');
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'ship it' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'again' } }),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4', usage: { input_tokens: 2000000, output_tokens: 500000 } } }),
    ].join('\n'));

    const { code, output } = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --title "feat: x" --body "Original description"' },
      session_id: 'int-session',
      transcript_path: transcriptPath,
    });
    assert.strictEqual(code, 0);
    assert.strictEqual(output.hookSpecificOutput.hookEventName, 'PreToolUse');
    const cmd = output.hookSpecificOutput.updatedInput.command;
    assert.ok(cmd.includes('Original description'), cmd);
    assert.ok(cmd.includes('Provenance'), cmd);
    assert.ok(cmd.includes('2 prompts'), cmd);
    assert.ok(cmd.includes('tests 1/1'), cmd);
    assert.ok(/\$\d/.test(cmd), 'includes a dollar figure: ' + cmd);
  });

  it('PreToolUse non-PR bash returns {}', async () => {
    const { output } = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
      session_id: 'int-session',
    });
    assert.deepStrictEqual(output, {});
  });

  it('malformed JSON input returns {}', async () => {
    const child = spawn('node', [SCRIPT_PATH], { env: { ...process.env, HOME: home } });
    let stdout = '';
    const result = await new Promise((resolve) => {
      child.stdout.on('data', (d) => { stdout += d; });
      child.on('close', () => resolve(JSON.parse(stdout.trim())));
      child.stdin.write('not json at all');
      child.stdin.end();
    });
    assert.deepStrictEqual(result, {});
  });

  it('empty stdin returns {}', async () => {
    const child = spawn('node', [SCRIPT_PATH], { env: { ...process.env, HOME: home } });
    let stdout = '';
    const result = await new Promise((resolve) => {
      child.stdout.on('data', (d) => { stdout += d; });
      child.on('close', () => resolve(JSON.parse(stdout.trim())));
      child.stdin.end();
    });
    assert.deepStrictEqual(result, {});
  });

  it('PreToolUse with missing transcript still stamps (degrades gracefully)', async () => {
    const { output } = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --body "b"' },
      session_id: 'fresh-no-transcript',
      transcript_path: '/nonexistent/path.jsonl',
    });
    assert.ok(output.hookSpecificOutput);
    const cmd = output.hookSpecificOutput.updatedInput.command;
    assert.ok(cmd.includes('Provenance'), cmd);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: --render CLI (powers the /pr-provenance-stamp:provenance command)
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration: --render CLI', () => {
  let home;
  before(() => { home = freshDir(); });
  after(() => { fs.rmSync(home, { recursive: true, force: true }); });

  // Feed a hook payload on stdin (writes the ledger under this temp HOME).
  function runHookHome(payload, homeDir) {
    return new Promise((resolve, reject) => {
      const child = spawn('node', [SCRIPT_PATH], { env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    });
  }

  // Spawn `--render` with a real cwd. The receipt reads the newest ledger under
  // HOME/.claude/pr-provenance-stamp; cwd only affects the git denominator.
  function runRender(homeDir, cwd) {
    return new Promise((resolve) => {
      const child = spawn('node', [SCRIPT_PATH, '--render'], {
        cwd,
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  }

  it('prints a friendly no-ledger message and exits 0 when nothing is recorded', async () => {
    // realpathSync: macOS mktemp lives under /var → /private/var; canonicalize the
    // spawned cwd so any git-denominator lookup is stable (observed live).
    const emptyHome = fs.realpathSync(freshDir());
    const cwd = fs.realpathSync(freshDir());
    try {
      const { code, stdout } = await runRender(emptyHome, cwd);
      assert.strictEqual(code, 0);
      assert.match(stdout, /No provenance ledger recorded yet/i);
      assert.doesNotMatch(stdout.trim(), /^\{/, 'friendly message is plain text, not JSON');
    } finally {
      fs.rmSync(emptyHome, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('renders the receipt block after a real hook records a ledger', async () => {
    const cwd = fs.realpathSync(freshDir());
    try {
      // Seed the ledger via real PostToolUse invocations (Write + a passing test).
      await runHookHome({
        hook_event_name: 'PostToolUse', tool_name: 'Write',
        tool_input: { content: 'a\nb\nc' }, session_id: 'render-seed',
      }, home);
      await runHookHome({
        hook_event_name: 'PostToolUse', tool_name: 'Bash',
        tool_input: { command: 'npm test' }, tool_response: { exit_code: 0 },
        session_id: 'render-seed',
      }, home);

      const { code, stdout } = await runRender(home, cwd);
      assert.strictEqual(code, 0);
      assert.ok(stdout.includes('Provenance'), stdout);
      assert.ok(stdout.includes('npm test'), stdout);
      assert.ok(stdout.includes('1/1'), stdout);
      assert.ok(stdout.includes(STAMP_BEGIN) && stdout.includes(STAMP_END), 'wrapped in sentinels');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('never throws — render output is plain text, not a hook JSON envelope', async () => {
    const cwd = fs.realpathSync(freshDir());
    try {
      const { code, stdout } = await runRender(home, cwd);
      assert.strictEqual(code, 0);
      assert.doesNotMatch(stdout.trim(), /^\{/, 'render output is a human receipt, not JSON');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
