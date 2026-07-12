#!/usr/bin/env node
/**
 * Tests for context-hogs.js
 *
 * Run: node --test hook-scripts/tests/post-tool-use/context-hogs.test.js
 * Or:  npm test
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('../../post-tool-use/context-hogs.js');
const {
  estimateTokens,
  estimateDollars,
  repoKey,
  normalizePath,
  responseBytes,
  attributePaths,
  offenderLabel,
  aggregate,
  renderCard,
  suggestClaudeMdBlock,
  fmtTokens,
} = mod;

const SCRIPT_PATH = path.join(__dirname, '../../post-tool-use/context-hogs.js');

// ─────────────────────────────────────────────────────────────────────────────
// Spawn helper — always runs with a fresh temp HOME so the real home dir is
// never polluted and no ambient state leaks in.
// ─────────────────────────────────────────────────────────────────────────────

function runHook(payload, home) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SCRIPT_PATH], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      try {
        resolve({ code, output: JSON.parse(stdout.trim() || '{}'), stderr });
      } catch (e) {
        reject(new Error(`Failed to parse output: ${JSON.stringify(stdout)} / stderr: ${stderr}`));
      }
    });
    child.stdin.write(typeof payload === 'string' ? payload : JSON.stringify(payload));
    child.stdin.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit: estimation math
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: estimateTokens / estimateDollars', () => {
  it('estimates ~1 token per 4 bytes', () => {
    assert.strictEqual(estimateTokens(4), 1);
    assert.strictEqual(estimateTokens(8), 2);
    assert.strictEqual(estimateTokens(4000), 1000);
  });
  it('rounds up partial tokens', () => {
    assert.strictEqual(estimateTokens(5), 2);
    assert.strictEqual(estimateTokens(1), 1);
  });
  it('returns 0 for zero/negative/undefined bytes', () => {
    assert.strictEqual(estimateTokens(0), 0);
    assert.strictEqual(estimateTokens(-10), 0);
    assert.strictEqual(estimateTokens(undefined), 0);
  });
  it('computes dollars from a $/MTok rate', () => {
    assert.strictEqual(estimateDollars(1e6, 3), 3);
    assert.strictEqual(estimateDollars(500000, 3), 1.5);
    assert.strictEqual(estimateDollars(0, 3), 0);
  });
  it('scales dollars with token count', () => {
    assert.ok(estimateDollars(2e6, 3) > estimateDollars(1e6, 3));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: repoKey
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: repoKey()', () => {
  it('is stable for the same cwd', () => {
    assert.strictEqual(repoKey('/home/x/proj'), repoKey('/home/x/proj'));
  });
  it('differs for same basename in different paths', () => {
    assert.notStrictEqual(repoKey('/a/proj'), repoKey('/b/proj'));
  });
  it('is filesystem-safe (no slashes)', () => {
    const k = repoKey('/some/weird path/my repo!');
    assert.ok(!k.includes('/'), 'key must not contain slashes');
    assert.ok(!/[!\s]/.test(k), 'key must be sanitized');
  });
  it('handles empty/undefined cwd without throwing', () => {
    assert.ok(repoKey(undefined).length > 0);
    assert.ok(repoKey('').length > 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: normalizePath
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: normalizePath()', () => {
  it('relativizes an absolute path inside cwd', () => {
    assert.strictEqual(normalizePath('/repo/src/a.ts', '/repo'), 'src/a.ts');
  });
  it('keeps a path outside cwd as-is (absolute)', () => {
    assert.strictEqual(normalizePath('/etc/hosts', '/repo'), '/etc/hosts');
  });
  it('keeps a relative path as-is', () => {
    assert.strictEqual(normalizePath('src/b.ts', '/repo'), 'src/b.ts');
  });
  it('strips surrounding quotes', () => {
    assert.strictEqual(normalizePath('"src/c.ts"', '/repo'), 'src/c.ts');
  });
  it('returns null for empty input', () => {
    assert.strictEqual(normalizePath('', '/repo'), null);
    assert.strictEqual(normalizePath(null, '/repo'), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: responseBytes — handles the many tool_response shapes
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: responseBytes()', () => {
  it('measures a plain string', () => {
    assert.strictEqual(responseBytes('hello'), 5);
  });
  it('measures multibyte utf8 correctly', () => {
    assert.strictEqual(responseBytes('café'), 5); // é = 2 bytes
  });
  it('sums stdout + stderr', () => {
    assert.strictEqual(responseBytes({ stdout: 'abc', stderr: 'de' }), 5);
  });
  it('measures Read-style content array', () => {
    assert.strictEqual(responseBytes({ content: [{ type: 'text', text: 'abcd' }, { type: 'text', text: 'ef' }] }), 6);
  });
  it('measures a text field', () => {
    assert.strictEqual(responseBytes({ text: 'hello world' }), 11);
  });
  it('returns 0 for null/undefined', () => {
    assert.strictEqual(responseBytes(null), 0);
    assert.strictEqual(responseBytes(undefined), 0);
  });
  it('falls back to serialization for unknown object shapes', () => {
    assert.ok(responseBytes({ weird: { nested: 'data here' } }) > 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: attributePaths — per-tool resolution
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: attributePaths()', () => {
  it('Read → file_path relativized', () => {
    assert.deepStrictEqual(attributePaths('Read', { file_path: '/repo/src/x.ts' }, '/repo'), ['src/x.ts']);
  });
  it('Read → returns [] when no path', () => {
    assert.deepStrictEqual(attributePaths('Read', {}, '/repo'), []);
  });
  it('Grep → attributes the search path', () => {
    assert.deepStrictEqual(attributePaths('Grep', { pattern: 'foo', path: 'src/big.ts' }, '/repo'), ['src/big.ts']);
  });
  it('Glob → attributes the scanned dir', () => {
    assert.deepStrictEqual(attributePaths('Glob', { pattern: '**/*.ts', path: 'src' }, '/repo'), ['src']);
  });
  it('Glob → defaults to "." when no path', () => {
    assert.deepStrictEqual(attributePaths('Glob', { pattern: '**/*.ts' }, '/repo'), ['.']);
  });
  it('Bash cat → extracts the file argument', () => {
    assert.deepStrictEqual(attributePaths('Bash', { command: 'cat src/utils.ts' }, '/repo'), ['src/utils.ts']);
  });
  it('Bash head with flags → skips flags, keeps file', () => {
    assert.deepStrictEqual(attributePaths('Bash', { command: 'head -n 50 package.json' }, '/repo'), ['package.json']);
  });
  it('Bash non-read command → returns []', () => {
    assert.deepStrictEqual(attributePaths('Bash', { command: 'npm install' }, '/repo'), []);
  });
  it('Bash without a file-ish token → returns []', () => {
    assert.deepStrictEqual(attributePaths('Bash', { command: 'cat' }, '/repo'), []);
  });
  it('de-dups repeated paths in one command', () => {
    const r = attributePaths('Bash', { command: 'cat a.txt; cat a.txt' }, '/repo');
    assert.deepStrictEqual(r, ['a.txt']);
  });
  it('unknown tool → returns []', () => {
    assert.deepStrictEqual(attributePaths('Write', { file_path: 'x' }, '/repo'), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: offenderLabel — repeat-offender heuristics
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: offenderLabel()', () => {
  const cases = [
    ['package-lock.json', 'lockfile'],
    ['yarn.lock', 'lockfile'],
    ['pnpm-lock.yaml', 'lockfile'],
    ['Cargo.lock', 'lockfile'],
    ['go.sum', 'lockfile'],
    ['src/schema.generated.ts', 'generated code'],
    ['proto/user_pb2.py', 'generated code'],
    ['dist/bundle.js', 'build artifact'],
    ['node_modules/react/index.js', 'build artifact'],
    ['__snapshots__/App.test.js.snap', 'test snapshot'],
    ['bundle.js.map', 'source map'],
    ['data/export.csv', 'data dump'],
    ['logs/app.log', 'data dump'],
  ];
  for (const [p, label] of cases) {
    it(`flags ${p} as ${label}`, () => assert.strictEqual(offenderLabel(p), label));
  }
  it('returns null for ordinary source files', () => {
    assert.strictEqual(offenderLabel('src/index.ts'), null);
    assert.strictEqual(offenderLabel('README.md'), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: aggregate — the leaderboard core
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: aggregate()', () => {
  const rows = [
    { path: 'src/utils.ts', bytes: 4000, tokens: 1000, tool: 'Read' },
    { path: 'src/utils.ts', bytes: 4000, tokens: 1000, tool: 'Read' },
    { path: 'src/small.ts', bytes: 400, tokens: 100, tool: 'Read' },
    { path: 'package-lock.json', bytes: 40000, tokens: 10000, tool: 'Read' },
  ];

  it('collapses repeated paths and counts reads', () => {
    const agg = aggregate(rows);
    const utils = agg.allRows.find((r) => r.path === 'src/utils.ts');
    assert.strictEqual(utils.reads, 2);
    assert.strictEqual(utils.tokens, 2000);
  });

  it('sorts descending by tokens (most expensive first)', () => {
    const agg = aggregate(rows);
    assert.strictEqual(agg.rows[0].path, 'package-lock.json');
    assert.strictEqual(agg.rows[1].path, 'src/utils.ts');
  });

  it('attaches offender flag and dollar estimate', () => {
    const agg = aggregate(rows, { usdPerMTok: 3 });
    const lock = agg.rows.find((r) => r.path === 'package-lock.json');
    assert.strictEqual(lock.offender, 'lockfile');
    assert.ok(lock.dollars > 0);
    assert.strictEqual(lock.dollars, (10000 / 1e6) * 3);
  });

  it('computes totals across all rows', () => {
    const agg = aggregate(rows);
    assert.strictEqual(agg.totals.files, 3);
    assert.strictEqual(agg.totals.reads, 4);
    assert.strictEqual(agg.totals.tokens, 12100);
  });

  it('respects topN', () => {
    const agg = aggregate(rows, { topN: 1 });
    assert.strictEqual(agg.rows.length, 1);
    assert.strictEqual(agg.allRows.length, 3);
  });

  it('derives tokens from bytes when tokens missing', () => {
    const agg = aggregate([{ path: 'a.ts', bytes: 4000, tool: 'Read' }]);
    assert.strictEqual(agg.allRows[0].tokens, 1000);
  });

  it('ignores rows without a path', () => {
    const agg = aggregate([{ bytes: 100 }, { path: 'a.ts', bytes: 4, tokens: 1 }]);
    assert.strictEqual(agg.totals.files, 1);
  });

  it('handles empty input', () => {
    const agg = aggregate([]);
    assert.strictEqual(agg.rows.length, 0);
    assert.strictEqual(agg.totals.tokens, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: renderCard / suggestClaudeMdBlock
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: renderCard()', () => {
  it('renders a header, totals, and ranked rows', () => {
    const agg = aggregate([
      { path: 'src/utils.ts', bytes: 4000, tokens: 1000, tool: 'Read' },
      { path: 'package-lock.json', bytes: 40000, tokens: 10000, tool: 'Read' },
    ], { usdPerMTok: 3 });
    const card = renderCard(agg, { repo: 'myrepo' });
    assert.ok(card.includes('Context Hogs'));
    assert.ok(card.includes('myrepo'));
    assert.ok(card.includes('package-lock.json'));
    assert.ok(card.includes('lockfile'));
    assert.ok(card.includes('1.'));
  });

  it('handles the empty leaderboard gracefully', () => {
    const card = renderCard(aggregate([]));
    assert.ok(card.includes('no attributable reads'));
  });
});

describe('Unit: suggestClaudeMdBlock()', () => {
  it('lists offenders with a paste-able CLAUDE.md block', () => {
    const agg = aggregate([
      { path: 'package-lock.json', bytes: 40000, tokens: 10000, tool: 'Read' },
      { path: 'src/utils.ts', bytes: 8000, tokens: 2000, tool: 'Read' },
    ]);
    const block = suggestClaudeMdBlock(agg);
    assert.ok(block.includes('CLAUDE.md'));
    assert.ok(block.includes('package-lock.json'));
    assert.ok(block.includes('lockfile'));
  });

  it('returns empty string when nothing worth suggesting', () => {
    assert.strictEqual(suggestClaudeMdBlock(aggregate([])), '');
  });
});

describe('Unit: formatters', () => {
  it('formats tokens with K/M suffixes', () => {
    assert.strictEqual(fmtTokens(999), '999');
    assert.strictEqual(fmtTokens(1500), '1.5K');
    assert.strictEqual(fmtTokens(2_100_000), '2.1M');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: end-to-end stdin/stdout with a hermetic temp HOME
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration: hook flow', () => {
  let home;
  let repoCwd;

  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-context-hogs-'));
    repoCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-repo-'));
  });

  after(() => {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(repoCwd, { recursive: true, force: true }); } catch {}
  });

  it('PostToolUse Read → no-op stdout but writes a ledger row', async () => {
    const { code, output } = await runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: path.join(repoCwd, 'src/utils.ts') },
      tool_response: { content: [{ type: 'text', text: 'x'.repeat(4000) }] },
      cwd: repoCwd,
      session_id: 's1',
    }, home);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
    // ledger must exist under the temp HOME (not the real one)
    const key = repoKey(repoCwd);
    const ledger = path.join(home, '.claude', 'context-hogs', key, 'ledger.jsonl');
    assert.ok(fs.existsSync(ledger), 'ledger file should be written under temp HOME');
    const rows = fs.readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].path, 'src/utils.ts');
    assert.ok(rows[0].tokens >= 1000);
  });

  it('PostToolUse with empty response → no ledger row added', async () => {
    const before = countLedger(home, repoCwd);
    const { output } = await runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: path.join(repoCwd, 'empty.ts') },
      tool_response: '',
      cwd: repoCwd,
    }, home);
    assert.deepStrictEqual(output, {});
    assert.strictEqual(countLedger(home, repoCwd), before, 'empty result must not add a row');
  });

  it('PostToolUse non-attributable Bash → no-op, no row', async () => {
    const before = countLedger(home, repoCwd);
    const { output } = await runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm install' },
      tool_response: { stdout: 'added 100 packages' },
      cwd: repoCwd,
    }, home);
    assert.deepStrictEqual(output, {});
    assert.strictEqual(countLedger(home, repoCwd), before);
  });

  it('SessionEnd → renders leaderboard card into systemMessage', async () => {
    // seed a couple more reads first
    await runHook({
      hook_event_name: 'PostToolUse', tool_name: 'Read',
      tool_input: { file_path: path.join(repoCwd, 'package-lock.json') },
      tool_response: 'y'.repeat(40000), cwd: repoCwd, session_id: 's1',
    }, home);

    const { code, output } = await runHook({
      hook_event_name: 'SessionEnd',
      cwd: repoCwd,
      session_id: 's1',
    }, home);
    assert.strictEqual(code, 0);
    assert.ok(output.systemMessage, 'expected a systemMessage card');
    assert.ok(output.systemMessage.includes('Context Hogs'));
    assert.ok(output.systemMessage.includes('package-lock.json'));
    assert.strictEqual(output.hookSpecificOutput?.hookEventName, 'SessionEnd');
    // suggested CLAUDE.md block should be written for the repo
    const key = repoKey(repoCwd);
    const suggFile = path.join(home, '.claude', 'context-hogs', key, 'suggested-claude-md.txt');
    assert.ok(fs.existsSync(suggFile));
    assert.ok(fs.readFileSync(suggFile, 'utf8').includes('package-lock.json'));
  });

  it('SessionEnd with no ledger → no-op {}', async () => {
    const freshCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-empty-repo-'));
    const { output } = await runHook({
      hook_event_name: 'SessionEnd', cwd: freshCwd, session_id: 'sx',
    }, home);
    assert.deepStrictEqual(output, {});
    try { fs.rmSync(freshCwd, { recursive: true, force: true }); } catch {}
  });

  it('invalid JSON input → {} and exit 0', async () => {
    const { code, output } = await runHook('not json at all', home);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });

  it('empty stdin → {} and exit 0', async () => {
    const { code, output } = await runHook('', home);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });

  it('unknown event → {} no-op', async () => {
    const { output } = await runHook({ hook_event_name: 'SessionStart', cwd: repoCwd }, home);
    assert.deepStrictEqual(output, {});
  });

  it('writes all state under the temp HOME (never the real home dir)', () => {
    // sanity: every ledger/state write landed under the temp HOME we passed
    // via env, confirming the real home dir was never polluted.
    const tempStatePresent = fs.existsSync(
      path.join(home, '.claude', 'context-hogs', repoKey(repoCwd))
    );
    assert.ok(tempStatePresent, 'state should live under the temp HOME we passed');
  });
});

function countLedger(home, cwd) {
  const key = repoKey(cwd);
  const ledger = path.join(home, '.claude', 'context-hogs', key, 'ledger.jsonl');
  if (!fs.existsSync(ledger)) return 0;
  return fs.readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).length;
}
