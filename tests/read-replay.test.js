#!/usr/bin/env node
/**
 * bench/read-replay/replay.mjs: hermetic replay over a synthetic project dir.
 *
 * Run: node --test tests/read-replay.test.js
 * Or:  npm test
 *
 * Builds a fake ~/.claude/projects tree in a temp HOME with one main transcript
 * and one subagent transcript, each holding Read tool_use/tool_result pairs of
 * known shape, then asserts the JSON counts. Later tests feed single-transcript
 * fixtures for each parser branch and each CLI error path.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'bench', 'read-replay', 'replay.mjs');

// ---------------------------------------------------------------------------
// Transcript builders (shape matches what Claude Code writes to *.jsonl)
// ---------------------------------------------------------------------------

let counter = 0;
const nextId = (prefix) => `${prefix}_${String(++counter).padStart(3, '0')}`;

function assistant({ usage, content = [{ type: 'text', text: 'ok' }], model = 'claude-test', id = nextId('msg') }) {
  const message = { model, role: 'assistant', usage, content };
  if (id !== null) message.id = id;
  return { type: 'assistant', version: '2.1.270', message };
}

const usage = (input, cacheW, cacheR, output = 10) => ({
  input_tokens: input,
  cache_creation_input_tokens: cacheW,
  cache_read_input_tokens: cacheR,
  output_tokens: output,
});

function readCall(id, input) {
  return assistant({
    usage: usage(100, 0, 0),
    content: [{ type: 'tool_use', id, name: 'Read', input }],
  });
}

function bashCall(id, input) {
  return assistant({ usage: usage(20, 0, 0), content: [{ type: 'tool_use', id, name: 'Bash', input }] });
}

const body = (lines, width = 40, startLine = 1) =>
  Array.from({ length: lines }, (_, i) => `${startLine + i}\t${'x'.repeat(width)}`).join('\n');

// A text Read result: `lines` numbered lines of `width` chars each.
function readResult(id, { lines, totalLines = lines, startLine = 1, width = 40 }) {
  const text = body(lines, width, startLine);
  return {
    type: 'user',
    version: '2.1.270',
    message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: text }] },
    toolUseResult: { type: 'text', file: { filePath: '/repo/file.js', content: text, numLines: lines, startLine, totalLines } },
  };
}

// A raw tool_result line with whatever content and toolUseResult you pass.
function rawResult(id, content, toolUseResult, extra = {}) {
  const line = { type: 'user', version: '2.1.270', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content, ...extra }] } };
  if (toolUseResult !== undefined) line.toolUseResult = toolUseResult;
  return line;
}

function imageResult(id) {
  return rawResult(id, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }],
    { type: 'image', file: { base64: 'AAAA', type: 'image/png' } });
}

const compactBoundary = () => ({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', version: '2.1.270' });

const attachment = (content) => ({ type: 'attachment', attachment: { type: 'file', filename: '/repo/notes.md', content: { type: 'text', file: { filePath: '/repo/notes.md', content, numLines: 1, startLine: 1, totalLines: 1 } } } });

const jsonl = (rows) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

// ---------------------------------------------------------------------------
// Fixture: two transcripts under one project
// ---------------------------------------------------------------------------

// Main transcript: 400-line full read (qualifies), 30-line small read, targeted
// read with offset, image read, errored read, PDF read, a compact boundary,
// an @-mention attachment, a synthetic message and a duplicate message id.
const BIG_LINES = 400;
const BIG_TOKENS = Math.ceil(body(BIG_LINES).length / 4);

function mainTranscript() {
  return jsonl([
    readCall('toolu_big', { file_path: '/repo/big.js' }),
    readResult('toolu_big', { lines: BIG_LINES }),
    // Two assistant turns after the big read before compaction: carried = tokens x 2.
    assistant({ usage: usage(50, 200, 1000) }),
    readCall('toolu_small', { file_path: '/repo/small.js' }),
    readResult('toolu_small', { lines: 30 }),
    compactBoundary(),
    // After the boundary the big read is no longer carried.
    assistant({ usage: usage(50, 0, 3000) }),
    readCall('toolu_targeted', { file_path: '/repo/big.js', offset: 100, limit: 500 }),
    readResult('toolu_targeted', { lines: 500, totalLines: 5000, startLine: 100 }),
    readCall('toolu_image', { file_path: '/repo/shot.png' }),
    imageResult('toolu_image'),
    readCall('toolu_missing', { file_path: '/repo/nope.js' }),
    rawResult('toolu_missing', '<tool_use_error>File does not exist.</tool_use_error>', undefined, { is_error: true }),
    readCall('toolu_pdf', { file_path: '/repo/paper.pdf' }),
    rawResult('toolu_pdf', 'x'.repeat(200_000), { type: 'pdf', file: { filePath: '/repo/paper.pdf' } }),
    attachment('a'.repeat(400)),
    // Synthetic local message: must not count toward context tokens.
    assistant({ usage: usage(999999, 0, 0), model: '<synthetic>' }),
    // Duplicate message id: usage must count once.
    assistant({ usage: usage(7, 0, 0), id: 'msg_dup' }),
    assistant({ usage: usage(7, 0, 0), id: 'msg_dup' }),
  ]);
}

// Subagent transcript: one targeted read with only `limit`, one 349-line read
// (does not qualify at the default 350 threshold), one unpiped Bash cat.
function subagentTranscript() {
  return jsonl([
    readCall('toolu_limit', { file_path: '/repo/a.js', limit: 50 }),
    readResult('toolu_limit', { lines: 50, totalLines: 900 }),
    readCall('toolu_edge', { file_path: '/repo/edge.js' }),
    readResult('toolu_edge', { lines: 349 }),
    bashCall('toolu_bash', { command: 'cat /repo/notes.txt' }),
    rawResult('toolu_bash', 'y'.repeat(400)),
  ]);
}

function buildFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-read-replay-'));
  const projects = path.join(home, '.claude', 'projects');
  const project = path.join(projects, '-tmp-demo');
  const subDir = path.join(project, 'session-1', 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(project, 'session-1.jsonl'), mainTranscript());
  fs.writeFileSync(path.join(subDir, 'agent-1.jsonl'), subagentTranscript());
  // A stale transcript outside the window must be skipped.
  const stale = path.join(project, 'old.jsonl');
  fs.writeFileSync(stale, mainTranscript());
  const old = new Date(Date.now() - 90 * 86_400_000);
  fs.utimesSync(stale, old, old);
  return { home, projects };
}

// One project holding a single transcript built from `rows`.
function singleFixture(rows) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-read-replay-one-'));
  const projects = path.join(home, '.claude', 'projects');
  const project = path.join(projects, '-tmp-one');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 's.jsonl'), jsonl(rows));
  return { home, projects, project };
}

function run(args, home) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

// Runs the replay over rows and returns the parsed JSON; cleans up after itself.
function replay(rows, extraArgs = []) {
  const { home, projects } = singleFixture(rows);
  try {
    const res = run([`--projects=${projects}`, '--json', ...extraArgs], home);
    assert.strictEqual(res.status, 0, res.stderr);
    return JSON.parse(res.stdout);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Tests: the two-transcript fixture
// ---------------------------------------------------------------------------

test('replay counts reads, exclusions, tokens and carry across main + subagent transcripts', () => {
  const { home, projects } = buildFixture();
  try {
    const res = run([`--projects=${projects}`, '--json'], home);
    assert.strictEqual(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);

    assert.strictEqual(out.scan.files, 2, 'main + subagent, stale file skipped');
    assert.deepStrictEqual(out.scan.versions, ['2.1.270']);

    // 6 reads in main + 2 in subagent.
    assert.strictEqual(out.reads.total, 8);
    assert.strictEqual(out.reads.images, 1);
    assert.strictEqual(out.reads.pdfs, 1);
    assert.strictEqual(out.reads.errors, 1);
    assert.strictEqual(out.reads.targeted, 2, 'offset-only and limit-only both count as targeted');
    assert.strictEqual(out.reads.qualifying, 1, 'only the 400-line full read');
    assert.strictEqual(out.reads.smallFull, 2, '30-line and 349-line full reads');
    assert.strictEqual(out.reads.pctQualifyingOfText, 20, '1 of 5 text reads (8 minus image, pdf, error)');
    assert.strictEqual(out.reads.pctTargetedOfText, 40);
    assert.deepStrictEqual(out.reads.histogram, { '<100': 1, '100-349': 1, '350-999': 1 });

    // Tokens: chars/4 of the big result, carried over exactly two assistant
    // turns before the compact boundary; nothing after it.
    assert.strictEqual(out.wouldGate.oneShotTokens, BIG_TOKENS);
    assert.strictEqual(out.wouldGate.carriedTokens, BIG_TOKENS * 2);

    // Context tokens: every non-synthetic assistant usage, deduped by id.
    // main: 6 read calls x 100 + 1250 + 3050 + 7 (dup once)
    // sub:  2 read calls x 100 + 20 (bash)
    assert.strictEqual(out.tokens.context, 600 + 1250 + 3050 + 7 + 200 + 20);

    assert.strictEqual(out.bashReads.calls, 1);
    assert.strictEqual(out.bashReads.tokens, 100);
    assert.deepStrictEqual(out.atMentions, { files: 1, tokens: 100 });
    assert.match(out.tokens.estimate, /chars \/ 4/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('--min-lines moves the threshold', () => {
  const { home, projects } = buildFixture();
  try {
    const res = run([`--projects=${projects}`, '--json', '--min-lines=300'], home);
    assert.strictEqual(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.strictEqual(out.reads.qualifying, 2, '349-line read now qualifies too');
    assert.strictEqual(out.reads.smallFull, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('default output is a markdown receipt that names the estimate', () => {
  const { home, projects } = buildFixture();
  try {
    const res = run([`--projects=${projects}`], home);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /^## Read-gate replay receipt/m);
    assert.match(res.stdout, /\| Reads that would qualify \(> 350 lines or > 100,000 chars\) \| 1 \(20% of text reads\) \|/);
    assert.match(res.stdout, /\| Errored reads \(excluded\) \| 1 \|/);
    assert.match(res.stdout, /\| @-mentioned files .* \| 1 files, 100 tokens \(est\.\) \|/);
    assert.match(res.stdout, /ceil\(chars \/ 4\)/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests: parser branches
// ---------------------------------------------------------------------------

test('a result over 100,000 chars qualifies even with few lines', () => {
  const out = replay([
    readCall('t1', { file_path: '/repo/bundle.min.js' }),
    rawResult('t1', body(10, 12_000), { type: 'text', file: { filePath: '/repo/bundle.min.js', numLines: 10, startLine: 1, totalLines: 10 } }),
  ]);
  assert.strictEqual(out.reads.qualifying, 1);
  assert.deepStrictEqual(out.reads.histogram, { '<100': 1 });
});

test('array-of-blocks results count only their text parts', () => {
  const text = body(400);
  const out = replay([
    readCall('t1', { file_path: '/repo/big.js' }),
    rawResult('t1', [{ type: 'text', text }, { type: 'image', source: { type: 'base64', data: 'AAAA' } }],
      { type: 'text', file: { filePath: '/repo/big.js', numLines: 400, startLine: 1, totalLines: 400 } }),
  ]);
  assert.strictEqual(out.reads.qualifying, 1);
  assert.strictEqual(out.wouldGate.oneShotTokens, Math.ceil(text.length / 4));
});

test('two compact boundaries flush carried turns separately', () => {
  const out = replay([
    readCall('a', { file_path: '/repo/a.js' }),
    readResult('a', { lines: BIG_LINES }),
    assistant({ usage: usage(1, 0, 0) }),
    assistant({ usage: usage(1, 0, 0) }),
    compactBoundary(),
    readCall('b', { file_path: '/repo/b.js' }),
    readResult('b', { lines: BIG_LINES }),
    assistant({ usage: usage(1, 0, 0) }),
    compactBoundary(),
    assistant({ usage: usage(1, 0, 0) }),
  ]);
  assert.strictEqual(out.reads.qualifying, 2);
  assert.strictEqual(out.wouldGate.carriedTokens, BIG_TOKENS * 3, '2 turns for a, 1 turn for b');
});

test('malformed lines, null lines and null content blocks are skipped without crashing', () => {
  const out = replay([
    '﻿' + JSON.stringify(readCall('t1', { file_path: '/repo/big.js' })), // BOM on the first line
    'null',
    '42',
    '"str"',
    '{not json',
    { type: 'assistant', message: { id: 'x', model: 'claude-test', usage: usage(5, 0, 0), content: [null, { type: 'text', text: 'hi' }] } },
    { type: 'user', message: { role: 'user', content: [null, { tool_use_id: 't1', type: 'tool_result', content: [null, { type: 'text', text: body(400) }] }] },
      toolUseResult: { type: 'text', file: { numLines: 400, totalLines: 400 } } },
    { type: 'assistant', message: null },
    { type: 'user', message: { content: null } },
  ]);
  assert.strictEqual(out.reads.total, 1);
  assert.strictEqual(out.reads.qualifying, 1);
  assert.strictEqual(out.tokens.context, 100 + 5);
});

test('a result with no line metadata falls back to counting the lines of the text', () => {
  const out = replay([
    readCall('t1', { file_path: '/repo/x.js' }),
    rawResult('t1', body(351), { type: 'text', file: { filePath: '/repo/x.js' } }),
    readCall('t2', { file_path: '/repo/y.js' }),
    rawResult('t2', body(350)),
  ]);
  assert.strictEqual(out.reads.qualifying, 1, '351 lines qualifies, 350 does not');
  assert.strictEqual(out.reads.smallFull, 1);
});

test('assistant usage without a message id is counted every time', () => {
  const out = replay([
    assistant({ usage: usage(100, 0, 0), id: null }),
    assistant({ usage: usage(100, 0, 0), id: null }),
    assistant({ usage: usage(100, 0, 0), id: null }),
  ]);
  assert.strictEqual(out.tokens.context, 300);
});

test('a Bash call with an empty command is not mistaken for a Read', () => {
  const out = replay([
    bashCall('b1', {}),
    rawResult('b1', 'output'),
    bashCall('b2', { command: 'cat big.txt | head' }),
    rawResult('b2', 'piped'),
  ]);
  assert.strictEqual(out.reads.total, 0);
  assert.strictEqual(out.bashReads.calls, 0, 'piped cat is not an unpiped read');
});

// ---------------------------------------------------------------------------
// Tests: discovery robustness
// ---------------------------------------------------------------------------

test('an unreadable project dir and a subagents entry that is a file are skipped', () => {
  const { home, projects, project } = singleFixture([
    readCall('t1', { file_path: '/repo/big.js' }),
    readResult('t1', { lines: BIG_LINES }),
  ]);
  const locked = path.join(projects, '-locked');
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, 'x.jsonl'), '');
  fs.mkdirSync(path.join(project, 'sess'));
  fs.writeFileSync(path.join(project, 'sess', 'subagents'), 'not a dir');
  fs.chmodSync(locked, 0o000);
  try {
    const res = run([`--projects=${projects}`, '--json'], home);
    assert.strictEqual(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.strictEqual(out.reads.qualifying, 1);
  } finally {
    fs.chmodSync(locked, 0o755);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests: CLI
// ---------------------------------------------------------------------------

test('--help prints usage and exits 0 without scanning', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-read-replay-help-'));
  try {
    for (const flag of ['--help', '-h']) {
      const res = run([flag, `--projects=${path.join(home, 'nope')}`], home);
      assert.strictEqual(res.status, 0, res.stderr);
      assert.match(res.stdout, /^Usage: node bench\/read-replay\/replay\.mjs/);
      assert.match(res.stdout, /--min-lines=<n>/);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('unknown flags, positional arguments and bad numbers exit 1 with a message', () => {
  const { home, projects } = singleFixture([]);
  try {
    const cases = [
      [['--dyas=5'], /unknown option: --dyas=5/],
      [['--days', '30'], /--days needs a value/],
      [['--json=1'], /unknown option: --json=1/],
      [['30'], /unexpected argument: 30/],
      [['--days=abc'], /invalid --days/],
      [['--days=-1'], /invalid --days/],
      [['--days=0'], /invalid --days/],
      [['--days=1e3'], /invalid --days/],
      [['--min-lines=0'], /invalid --min-lines/],
      [['--min-lines=0x10'], /invalid --min-lines/],
    ];
    for (const [args, pattern] of cases) {
      const res = run([`--projects=${projects}`, ...args], home);
      assert.strictEqual(res.status, 1, `${args.join(' ')}: expected exit 1`);
      assert.match(res.stderr, pattern);
      assert.doesNotMatch(res.stderr, /at .*replay\.mjs/, 'no stack trace');
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('missing projects dir exits non-zero with a message', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-read-replay-empty-'));
  try {
    const res = run([`--projects=${path.join(home, 'nope')}`], home);
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /projects dir not found/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
