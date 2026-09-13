#!/usr/bin/env node
/**
 * bench/read-replay/replay.mjs: hermetic replay over a synthetic project dir.
 *
 * Run: node --test tests/read-replay.test.js
 * Or:  npm test
 *
 * Builds a fake ~/.claude/projects tree in a temp HOME with one main transcript
 * and one subagent transcript, each holding Read tool_use/tool_result pairs of
 * known shape, then asserts the JSON counts.
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
  return { type: 'assistant', version: '2.1.270', message: { id, model, role: 'assistant', usage, content } };
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

// A text Read result: `lines` numbered lines of `width` chars each.
function readResult(id, { lines, totalLines = lines, startLine = 1, width = 40 }) {
  const body = Array.from({ length: lines }, (_, i) => `${startLine + i}\t${'x'.repeat(width)}`).join('\n');
  return {
    type: 'user',
    version: '2.1.270',
    message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: body }] },
    toolUseResult: { type: 'text', file: { filePath: '/repo/file.js', content: body, numLines: lines, startLine, totalLines } },
  };
}

function imageResult(id) {
  return {
    type: 'user',
    version: '2.1.270',
    message: {
      role: 'user',
      content: [{ tool_use_id: id, type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }],
    },
    toolUseResult: { type: 'image', file: { base64: 'AAAA', type: 'image/png' } },
  };
}

const compactBoundary = () => ({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', version: '2.1.270' });

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

// ---------------------------------------------------------------------------
// Fixture: two transcripts under one project
// ---------------------------------------------------------------------------

// Main transcript: 400-line full read (qualifies), 30-line small read, targeted
// read with offset, image read, a compact boundary, then more turns.
const BIG_LINES = 400;
const BIG_TOKENS = Math.ceil(readResult('x', { lines: BIG_LINES }).message.content[0].content.length / 4);

function mainTranscript() {
  const bigId = 'toolu_big';
  const smallId = 'toolu_small';
  const targetedId = 'toolu_targeted';
  const imageId = 'toolu_image';
  return jsonl([
    readCall(bigId, { file_path: '/repo/big.js' }),
    readResult(bigId, { lines: BIG_LINES }),
    // Two assistant turns after the big read before compaction: carried = tokens x 2.
    assistant({ usage: usage(50, 200, 1000) }),
    readCall(smallId, { file_path: '/repo/small.js' }),
    readResult(smallId, { lines: 30 }),
    compactBoundary(),
    // After the boundary the big read is no longer carried.
    assistant({ usage: usage(50, 0, 3000) }),
    readCall(targetedId, { file_path: '/repo/big.js', offset: 100, limit: 500 }),
    readResult(targetedId, { lines: 500, totalLines: 5000, startLine: 100 }),
    readCall(imageId, { file_path: '/repo/shot.png' }),
    imageResult(imageId),
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
  const limitId = 'toolu_limit';
  const edgeId = 'toolu_edge';
  const bashId = 'toolu_bash';
  return jsonl([
    readCall(limitId, { file_path: '/repo/a.js', limit: 50 }),
    readResult(limitId, { lines: 50, totalLines: 900 }),
    readCall(edgeId, { file_path: '/repo/edge.js' }),
    readResult(edgeId, { lines: 349 }),
    assistant({
      usage: usage(20, 0, 0),
      content: [{ type: 'tool_use', id: bashId, name: 'Bash', input: { command: 'cat /repo/notes.txt' } }],
    }),
    { type: 'user', message: { role: 'user', content: [{ tool_use_id: bashId, type: 'tool_result', content: 'y'.repeat(400) }] } },
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

function run(args, home) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('replay counts reads, exclusions, tokens and carry across main + subagent transcripts', () => {
  const { home, projects } = buildFixture();
  try {
    const res = run([`--projects=${projects}`, '--json'], home);
    assert.strictEqual(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);

    assert.strictEqual(out.scan.files, 2, 'main + subagent, stale file skipped');
    assert.deepStrictEqual(out.scan.versions, ['2.1.270']);

    // 4 reads in main + 2 in subagent.
    assert.strictEqual(out.reads.total, 6);
    assert.strictEqual(out.reads.images, 1);
    assert.strictEqual(out.reads.targeted, 2, 'offset-only and limit-only both count as targeted');
    assert.strictEqual(out.reads.qualifying, 1, 'only the 400-line full read');
    assert.strictEqual(out.reads.smallFull, 2, '30-line and 349-line full reads');
    assert.strictEqual(out.reads.pctQualifyingOfNonImage, 20, '1 of 5 non-image reads');
    assert.deepStrictEqual(out.reads.histogram, { '<100': 1, '100-349': 1, '350-999': 1 });

    // Tokens: chars/4 of the big result, carried over exactly two assistant
    // turns before the compact boundary; nothing after it.
    assert.strictEqual(out.wouldGate.oneShotTokens, BIG_TOKENS);
    assert.strictEqual(out.wouldGate.carriedTokens, BIG_TOKENS * 2);

    // Context tokens: every non-synthetic assistant usage, deduped by id.
    // main: 100 (big call) + 1250 + 100 (small call) + 3050 + 100 (targeted) + 100 (image) + 7 (dup once)
    // sub:  100 (limit) + 100 (edge) + 20 (bash)
    assert.strictEqual(out.tokens.context, 100 + 1250 + 100 + 3050 + 100 + 100 + 7 + 100 + 100 + 20);

    assert.strictEqual(out.bashReads.calls, 1);
    assert.strictEqual(out.bashReads.tokens, 100);
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
    assert.match(res.stdout, /\| Reads that would qualify \(> 350 lines or > 100,000 chars\) \| 1 \(20% of non-image\) \|/);
    assert.match(res.stdout, /ceil\(chars \/ 4\)/);
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
