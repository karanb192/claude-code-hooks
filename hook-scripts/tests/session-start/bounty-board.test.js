#!/usr/bin/env node
/**
 * Tests for bounty-board.js
 *
 * Run: node --test hook-scripts/tests/session-start/bounty-board.test.js
 * Or:  npm test
 *
 * Hermetic: every spawn/state-touching test overrides HOME to a fresh temp dir
 * and uses a fresh temp git repo. No ambient env, no real home-dir pollution.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('../../session-start/bounty-board.js');
const {
  RULES,
  SEVERITY_XP,
  classifyLine,
  extractBounties,
  bountyId,
  priceBounty,
  ageLabel,
  renderBoard,
  renderSideQuests,
  renderPayout,
  reconcileFile,
  scanRepo,
} = mod;

const SCRIPT_PATH = path.join(__dirname, '../../session-start/bounty-board.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initGitRepo(dir) {
  const opts = { cwd: dir, stdio: 'ignore' };
  execFileSync('git', ['init', '-q'], opts);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], opts);
  execFileSync('git', ['config', 'user.name', 'Test'], opts);
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], opts);
}

function commitAll(dir, msg) {
  const opts = { cwd: dir, stdio: 'ignore' };
  execFileSync('git', ['add', '-A'], opts);
  execFileSync('git', ['commit', '-q', '-m', msg], opts);
}

/** Spawn the hook with a temp HOME + payload; resolve parsed stdout JSON. */
function runHook(payload, homeDir) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, HOME: homeDir };
    delete env.CCH_SLA_WEBHOOK;
    const child = spawn('node', [SCRIPT_PATH], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      try {
        resolve({ code, output: JSON.parse(stdout.trim()), stderr });
      } catch (e) {
        reject(new Error(`Failed to parse output: ${JSON.stringify(stdout)} / stderr: ${stderr}`));
      }
    });
    child.stdin.write(typeof payload === 'string' ? payload : JSON.stringify(payload));
    child.stdin.end();
  });
}

// ── Unit: classifyLine ────────────────────────────────────────────────────────

describe('Unit: classifyLine()', () => {
  it('detects FIXME', () => assert.strictEqual(classifyLine('  // FIXME: broken').id, 'FIXME'));
  it('detects TODO', () => assert.strictEqual(classifyLine('# TODO refactor this').id, 'TODO'));
  it('detects HACK', () => assert.strictEqual(classifyLine('// HACK around bug').id, 'HACK'));
  it('detects XXX', () => assert.strictEqual(classifyLine('/* XXX revisit */').id, 'XXX'));
  it('detects BUG', () => assert.strictEqual(classifyLine('// BUG: off by one').id, 'BUG'));
  it('detects skipped mocha/jest test', () => assert.strictEqual(classifyLine('it.skip("x", () => {})').id, 'SKIPPED_TEST'));
  it('detects xit', () => assert.strictEqual(classifyLine('xit("later")').id, 'SKIPPED_TEST'));
  it('detects pytest skip', () => assert.strictEqual(classifyLine('@pytest.mark.skip').id, 'SKIPPED_TEST'));
  it('detects rust ignore', () => assert.strictEqual(classifyLine('#[ignore]').id, 'SKIPPED_TEST'));
  it('detects eslint-disable', () => assert.strictEqual(classifyLine('// eslint-disable-next-line').id, 'LINT_SUPPRESS'));
  it('detects ts-ignore', () => assert.strictEqual(classifyLine('// @ts-ignore').id, 'LINT_SUPPRESS'));
  it('detects python noqa', () => assert.strictEqual(classifyLine('import os  # noqa').id, 'LINT_SUPPRESS'));
  it('detects type: ignore', () => assert.strictEqual(classifyLine('x = 1  # type: ignore').id, 'LINT_SUPPRESS'));

  it('ignores clean code', () => assert.strictEqual(classifyLine('const x = 1;'), null));
  it('ignores empty line', () => assert.strictEqual(classifyLine(''), null));
  it('ignores null', () => assert.strictEqual(classifyLine(null), null));
  it('does not match TODO inside a larger word', () => assert.strictEqual(classifyLine('const methodOlogy = 1;'), null));
  it('ignores absurdly long (minified) lines', () => {
    const long = '// TODO ' + 'x'.repeat(1000);
    assert.strictEqual(classifyLine(long), null);
  });

  it('severity ordering: FIXME beats TODO on the same line', () => {
    // FIXME rule comes before TODO in RULES, so a line with both classifies as FIXME.
    assert.strictEqual(classifyLine('// FIXME and TODO both here').id, 'FIXME');
  });
});

// ── Unit: extractBounties ─────────────────────────────────────────────────────

describe('Unit: extractBounties()', () => {
  const content = [
    'const a = 1;',
    '// TODO: rename this',
    'function f() {}',
    '  // FIXME urgent',
    'it.skip("pending", () => {})',
    'clean();',
  ].join('\n');

  it('finds all three bounties with correct line numbers', () => {
    const b = extractBounties('src/x.js', content);
    assert.strictEqual(b.length, 3);
    assert.strictEqual(b[0].rule, 'TODO');
    assert.strictEqual(b[0].line, 2);
    assert.strictEqual(b[1].rule, 'FIXME');
    assert.strictEqual(b[1].line, 4);
    assert.strictEqual(b[2].rule, 'SKIPPED_TEST');
    assert.strictEqual(b[2].line, 5);
  });

  it('carries the file path and trimmed text', () => {
    const b = extractBounties('src/x.js', content);
    assert.strictEqual(b[1].file, 'src/x.js');
    assert.strictEqual(b[1].text, '// FIXME urgent');
  });

  it('returns [] for clean content', () => {
    assert.deepStrictEqual(extractBounties('a.js', 'const x = 1;\nreturn x;'), []);
  });

  it('assigns stable ids for identical lines', () => {
    const b1 = extractBounties('a.js', '// TODO x')[0];
    const b2 = extractBounties('a.js', '// TODO x')[0];
    assert.strictEqual(b1.id, b2.id);
  });

  it('assigns different ids for different files', () => {
    const b1 = extractBounties('a.js', '// TODO x')[0];
    const b2 = extractBounties('b.js', '// TODO x')[0];
    assert.notStrictEqual(b1.id, b2.id);
  });
});

// ── Unit: priceBounty ─────────────────────────────────────────────────────────

describe('Unit: priceBounty()', () => {
  it('new debt gets the base severity XP', () => {
    assert.strictEqual(priceBounty(5, 0), SEVERITY_XP[5]);
    assert.strictEqual(priceBounty(2, 0), SEVERITY_XP[2]);
  });

  it('older debt is worth strictly more (aging economy)', () => {
    assert.ok(priceBounty(5, 365) > priceBounty(5, 0));
    assert.ok(priceBounty(5, 800) > priceBounty(5, 100));
  });

  it('caps the age multiplier at 4x the base', () => {
    const maxed = priceBounty(5, 100000);
    assert.ok(maxed <= SEVERITY_XP[5] * 4);
    // 600 days would already exceed the cap → equals the ceiling.
    assert.strictEqual(priceBounty(5, 100000), priceBounty(5, 5000));
  });

  it('higher severity is worth more at the same age', () => {
    assert.ok(priceBounty(5, 100) > priceBounty(2, 100));
  });

  it('handles NaN / negative age as base', () => {
    assert.strictEqual(priceBounty(4, NaN), SEVERITY_XP[4]);
    assert.strictEqual(priceBounty(4, -50), SEVERITY_XP[4]);
  });

  it('rounds to a clean multiple of 10', () => {
    assert.strictEqual(priceBounty(5, 137) % 10, 0);
  });
});

// ── Unit: ageLabel ────────────────────────────────────────────────────────────

describe('Unit: ageLabel()', () => {
  it('labels unknown age as new', () => assert.strictEqual(ageLabel(NaN), 'new'));
  it('labels zero as new', () => assert.strictEqual(ageLabel(0), 'new'));
  it('labels sub-day as today', () => assert.strictEqual(ageLabel(0.5), 'today'));
  it('labels days', () => assert.strictEqual(ageLabel(12), '12d old'));
  it('labels months', () => assert.strictEqual(ageLabel(60), '2mo old'));
  it('labels years', () => assert.strictEqual(ageLabel(730), '2.0y old'));
});

// ── Unit: reconcileFile (the verify-then-reward core) ────────────────────────

describe('Unit: reconcileFile()', () => {
  const open = [
    { id: '1', file: 'a.js', line: 2, rule: 'TODO', text: '// TODO x', xp: 100 },
    { id: '2', file: 'a.js', line: 5, rule: 'FIXME', text: '// FIXME y', xp: 500 },
    { id: '3', file: 'b.js', line: 1, rule: 'HACK', text: '// HACK z', xp: 350 },
  ];

  it('pays out a bounty whose text disappeared from the file', () => {
    const { cleared, survived } = reconcileFile(open, 'a.js', 'const x = 1;\n// FIXME y\n');
    assert.strictEqual(cleared.length, 1);
    assert.strictEqual(cleared[0].id, '1');
    // The untouched FIXME in a.js and the b.js bounty both survive.
    assert.strictEqual(survived.length, 2);
  });

  it('does NOT pay out when the marker text still exists', () => {
    const { cleared } = reconcileFile(open, 'a.js', '// TODO x\n// FIXME y\n');
    assert.strictEqual(cleared.length, 0);
  });

  it('leaves bounties in other files untouched', () => {
    const { survived } = reconcileFile(open, 'a.js', '');
    // Clearing everything in a.js still keeps b.js's bounty.
    assert.ok(survived.some((b) => b.file === 'b.js'));
  });

  it('clears all matching bounties when the file is emptied', () => {
    const { cleared, survived } = reconcileFile(open, 'a.js', '');
    assert.strictEqual(cleared.length, 2);
    assert.strictEqual(survived.length, 1);
  });

  it('treats null content as fully cleared for that file', () => {
    const { cleared } = reconcileFile(open, 'b.js', null);
    assert.strictEqual(cleared.length, 1);
    assert.strictEqual(cleared[0].file, 'b.js');
  });
});

// ── Unit: rendering ───────────────────────────────────────────────────────────

describe('Unit: renderBoard()', () => {
  const bounties = [
    { file: 'a.js', line: 2, rule: 'TODO', xp: 100, ageDays: 3 },
    { file: 'b.js', line: 9, rule: 'FIXME', xp: 900, ageDays: 400 },
  ];

  it('renders a card mentioning WANTED and the bounties', () => {
    const card = renderBoard(bounties, 'my-repo');
    assert.ok(card.includes('BOUNTY BOARD'));
    assert.ok(card.includes('WANTED'));
    assert.ok(card.includes('FIXME'));
    assert.ok(card.includes('my-repo'));
  });

  it('shows a clean-repo message when empty', () => {
    assert.ok(renderBoard([], 'clean').includes('squeaky clean'));
  });

  it('sorts by XP so the fattest bounty appears first', () => {
    const card = renderBoard(bounties, 'r');
    assert.ok(card.indexOf('FIXME') < card.indexOf('TODO'));
  });
});

describe('Unit: renderSideQuests()', () => {
  it('offers at most the top 3 by XP and frames them as opportunistic', () => {
    const bounties = [
      { file: 'a', line: 1, rule: 'TODO', xp: 100, ageDays: 1, text: 'lowest-quest' },
      { file: 'b', line: 2, rule: 'FIXME', xp: 900, ageDays: 1, text: 'top-quest' },
      { file: 'c', line: 3, rule: 'HACK', xp: 500, ageDays: 1, text: 'mid-quest' },
      { file: 'd', line: 4, rule: 'XXX', xp: 350, ageDays: 1, text: 'third-quest' },
    ];
    const q = renderSideQuests(bounties);
    assert.ok(q.includes('side quest'));
    assert.ok(q.includes('already editing'));
    assert.ok(q.includes('top-quest')); // highest XP included
    assert.ok(q.includes('third-quest')); // 3rd place still included
    assert.ok(!q.includes('lowest-quest')); // 4th place (lowest XP) excluded
  });

  it('returns empty string with no bounties', () => {
    assert.strictEqual(renderSideQuests([]), '');
  });
});

describe('Unit: renderPayout()', () => {
  it('summarises cleared count, XP, and remaining', () => {
    const card = renderPayout([{ rule: 'TODO', file: 'a.js', line: 1, xp: 100 }], 100, 4);
    assert.ok(card.includes('BOUNTY PAYOUT'));
    assert.ok(card.includes('100'));
    assert.ok(card.includes('TODO'));
  });

  it('renders even with no clears', () => {
    const card = renderPayout([], 0, 7);
    assert.ok(card.includes('BOUNTY PAYOUT'));
    assert.ok(card.includes('7'));
  });
});

// ── Unit: scanRepo against a real temp git repo ──────────────────────────────

describe('Unit: scanRepo()', () => {
  let repo;
  before(() => {
    repo = mkTmp('cch-bounty-scan-');
    initGitRepo(repo);
    fs.writeFileSync(path.join(repo, 'a.js'), 'const x = 1;\n// TODO clean up\n// FIXME broken\n');
    fs.writeFileSync(path.join(repo, 'clean.js'), 'export const ok = true;\n');
    fs.writeFileSync(path.join(repo, 'notes.txt'), '// TODO ignored: not a code ext\n');
    commitAll(repo, 'init');
  });
  after(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('finds bounties only in tracked, code-extension files', () => {
    const { bounties } = scanRepo(repo);
    const rules = bounties.map((b) => b.rule).sort();
    assert.deepStrictEqual(rules, ['FIXME', 'TODO']);
    assert.ok(bounties.every((b) => b.file === 'a.js'));
  });

  it('prices every bounty with a numeric XP and age', () => {
    const { bounties } = scanRepo(repo);
    for (const b of bounties) {
      assert.strictEqual(typeof b.xp, 'number');
      assert.ok(b.xp > 0);
      assert.ok('ageDays' in b);
    }
  });

  it('reports scan metadata within the time budget', () => {
    const { scannedFiles, elapsedMs } = scanRepo(repo);
    assert.ok(scannedFiles >= 1);
    assert.ok(elapsedMs < 5000, 'scan should be fast');
  });

  it('returns [] for a non-git directory', () => {
    const plain = mkTmp('cch-bounty-plain-');
    try {
      fs.writeFileSync(path.join(plain, 'a.js'), '// TODO x\n');
      const { bounties } = scanRepo(plain);
      assert.deepStrictEqual(bounties, []);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

// ── Integration: full stdin/stdout lifecycle, hermetic ───────────────────────

describe('Integration: SessionStart → PostToolUse → SessionEnd', () => {
  let home, repo;

  before(() => {
    home = mkTmp('cch-bounty-home-');
    repo = mkTmp('cch-bounty-repo-');
    initGitRepo(repo);
    fs.writeFileSync(path.join(repo, 'auth.js'), 'function login() {}\n// FIXME insecure token check\nconst y = 2;\n');
    fs.writeFileSync(path.join(repo, 'util.js'), '// TODO add caching\nexport const u = 1;\n');
    commitAll(repo, 'init');
  });

  after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('SessionStart returns a board + side quests in additionalContext', async () => {
    const { code, output } = await runHook(
      { hook_event_name: 'SessionStart', session_id: 'sess-int-1', cwd: repo, source: 'startup' },
      home
    );
    assert.strictEqual(code, 0);
    const ctx = output.hookSpecificOutput?.additionalContext;
    assert.strictEqual(output.hookSpecificOutput?.hookEventName, 'SessionStart');
    assert.ok(ctx.includes('BOUNTY BOARD'));
    assert.ok(ctx.includes('FIXME'));
    assert.ok(ctx.includes('side quest'));
  });

  it('persists a session ledger under the temp HOME (no real-home pollution)', () => {
    const ledger = path.join(home, '.claude', 'bounty-board', 'sess-int-1.json');
    assert.ok(fs.existsSync(ledger), 'ledger should exist for the session');
    const state = JSON.parse(fs.readFileSync(ledger, 'utf-8'));
    assert.strictEqual(state.open.length, 2);
    assert.strictEqual(state.earnedXp, 0);
  });

  it('PostToolUse pays out when the FIXME line is actually removed', async () => {
    // Simulate Claude fixing the debt: rewrite auth.js without the FIXME.
    fs.writeFileSync(path.join(repo, 'auth.js'), 'function login() { /* fixed */ }\nconst y = 2;\n');
    const { code, output } = await runHook(
      {
        hook_event_name: 'PostToolUse',
        session_id: 'sess-int-1',
        cwd: repo,
        tool_name: 'Edit',
        tool_input: { file_path: path.join(repo, 'auth.js') },
      },
      home
    );
    assert.strictEqual(code, 0);
    const ctx = output.hookSpecificOutput?.additionalContext || '';
    assert.ok(ctx.includes('Bounty cleared'), `expected payout, got: ${JSON.stringify(output)}`);
    assert.ok(ctx.includes('FIXME'));

    const state = JSON.parse(
      fs.readFileSync(path.join(home, '.claude', 'bounty-board', 'sess-int-1.json'), 'utf-8')
    );
    assert.strictEqual(state.open.length, 1); // only util.js TODO remains
    assert.ok(state.earnedXp > 0);
    assert.strictEqual(state.cleared.length, 1);
  });

  it('PostToolUse does NOT pay out again when nothing changed', async () => {
    const { output } = await runHook(
      {
        hook_event_name: 'PostToolUse',
        session_id: 'sess-int-1',
        cwd: repo,
        tool_name: 'Edit',
        tool_input: { file_path: path.join(repo, 'util.js') }, // TODO still present
      },
      home
    );
    // util.js TODO still present → no clear → no additionalContext.
    assert.deepStrictEqual(output, {});
  });

  it('SessionEnd renders a payout card and removes the ledger', async () => {
    const { code, output } = await runHook(
      { hook_event_name: 'SessionEnd', session_id: 'sess-int-1', cwd: repo },
      home
    );
    assert.strictEqual(code, 0);
    assert.ok(output.systemMessage.includes('BOUNTY PAYOUT'));
    assert.ok(output.systemMessage.includes('1')); // one cleared
    const ledger = path.join(home, '.claude', 'bounty-board', 'sess-int-1.json');
    assert.strictEqual(fs.existsSync(ledger), false, 'ledger should be cleaned up');
  });

  it('logs events to the temp HOME hooks-logs dir', () => {
    const logDir = path.join(home, '.claude', 'hooks-logs');
    const files = fs.readdirSync(logDir).filter((f) => f.endsWith('.jsonl'));
    assert.ok(files.length >= 1);
    const content = fs.readFileSync(path.join(logDir, files[0]), 'utf-8');
    assert.ok(content.includes('bounty-board'));
    assert.ok(content.includes('SessionStart'));
  });
});

// ── Integration: defensive / no-op paths ─────────────────────────────────────

describe('Integration: defensive behavior', () => {
  let home;
  before(() => (home = mkTmp('cch-bounty-def-')));
  after(() => fs.rmSync(home, { recursive: true, force: true }));

  it('returns {} for invalid JSON input', async () => {
    const { code, output } = await runHook('not json at all', home);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });

  it('returns {} for empty input', async () => {
    const { code, output } = await runHook('', home);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });

  it('returns {} for an unknown event name', async () => {
    const { output } = await runHook({ hook_event_name: 'Notification', session_id: 's' }, home);
    assert.deepStrictEqual(output, {});
  });

  it('PostToolUse with no known session returns {}', async () => {
    const { output } = await runHook(
      { hook_event_name: 'PostToolUse', session_id: 'nonexistent', tool_name: 'Edit', tool_input: { file_path: '/tmp/x.js' } },
      home
    );
    assert.deepStrictEqual(output, {});
  });

  it('SessionEnd with no session returns {}', async () => {
    const { output } = await runHook({ hook_event_name: 'SessionEnd', session_id: 'ghost' }, home);
    assert.deepStrictEqual(output, {});
  });

  it('SessionStart on a non-git directory returns {} (no bounties)', async () => {
    const plain = mkTmp('cch-bounty-nogit-');
    try {
      fs.writeFileSync(path.join(plain, 'a.js'), '// TODO x\n');
      const { output } = await runHook(
        { hook_event_name: 'SessionStart', session_id: 's-nogit', cwd: plain },
        home
      );
      assert.deepStrictEqual(output, {});
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

// ── Config: RULES structure ──────────────────────────────────────────────────

describe('Config: RULES structure', () => {
  it('has a unique id per rule', () => {
    const ids = RULES.map((r) => r.id);
    assert.strictEqual(ids.length, new Set(ids).size);
  });
  it('every rule has a RegExp and a severity with a mapped XP', () => {
    for (const r of RULES) {
      assert.ok(r.re instanceof RegExp, `${r.id} missing regex`);
      assert.ok(SEVERITY_XP[r.severity], `${r.id} severity ${r.severity} has no XP mapping`);
    }
  });
});
