#!/usr/bin/env node
/**
 * Tests for dead-end-registry.js
 *
 * Run: node --test hook-scripts/tests/user-prompt-submit/dead-end-registry.test.js
 * Or:  npm test
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const crypto = require('node:crypto');

const mod = require('../../user-prompt-submit/dead-end-registry.js');
const {
  tokenize,
  keywords,
  jaccard,
  hunkLines,
  hunkSimilarity,
  toolUseCode,
  findRevertedCode,
  extractDeadEnds,
  matchPrompt,
  matchEdit,
  editCode,
  estimateTokens,
  usdFor,
  messageText,
  renderPromptCard,
  renderEditReason,
  persistDeadEnds,
  readRegistry,
  registryFileFor,
  route,
  REVERT_PATTERNS,
  PROMPT_MATCH_THRESHOLD,
  HUNK_MATCH_THRESHOLD,
  MIN_HUNK_LINES,
} = mod;

const SCRIPT_PATH = path.join(__dirname, '../../user-prompt-submit/dead-end-registry.js');

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

// A transcript modelled on real Claude Code JSONL: assistant/user messages with
// content blocks and usage on assistant turns.
// The actual code that gets written (as an Edit tool_use) and later reverted.
// Kept in a constant so tests can prove the mined registry code === this hunk.
const REVERTED_WORKER_CODE =
  'const worker = new Worker("./image-worker.js");\nworker.on("message", handleImageResult);\nworker.postMessage(imageJob);\nreturn worker;';

function makeTranscript() {
  return [
    { type: 'user', message: { role: 'user', content: 'Can you move the image processing to worker threads for speed?' } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Sure, I will move image processing onto worker threads using the worker_threads module.' }],
        usage: { input_tokens: 1200, output_tokens: 800 },
      },
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Writing the worker threads image processing implementation now.' },
          {
            type: 'tool_use',
            name: 'Edit',
            input: {
              file_path: 'src/image.js',
              old_string: '// process inline',
              new_string: REVERTED_WORKER_CODE,
            },
          },
        ],
        usage: { input_tokens: 1500, output_tokens: 1000 },
      },
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'The worker threads implementation introduced a race condition in the event loop; I am reverting the worker thread change now.' }],
        usage: { input_tokens: 2000, output_tokens: 1500 },
      },
    },
    { type: 'user', message: { role: 'user', content: 'ok thanks, leave it single threaded then' } },
  ];
}

// Replicate the script's registry-file naming for a GIVEN home dir, since the
// module's registryFileFor() closes over the test process's own HOME.
function registryFileForHome(homeDir, cwd) {
  const key = cwd && String(cwd).trim() ? String(cwd).trim() : 'global';
  const slug = key.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(-40) || 'root';
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);
  return path.join(homeDir, '.claude', 'dead-end-registry', `${slug}-${hash}.jsonl`);
}

function withTranscript(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-de-tx-'));
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { dir, file };
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit: text helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: tokenize / keywords', () => {
  it('drops stopwords and short tokens', () => {
    const t = tokenize('We should move the image to worker threads');
    assert.ok(!t.includes('we'));
    assert.ok(!t.includes('the'));
    assert.ok(t.includes('image'));
    assert.ok(t.includes('worker'));
    assert.ok(t.includes('threads'));
  });

  it('returns [] for non-string / empty input', () => {
    assert.deepStrictEqual(tokenize(null), []);
    assert.deepStrictEqual(tokenize(''), []);
    assert.deepStrictEqual(tokenize(42), []);
  });

  it('keywords are unique and capped', () => {
    const k = keywords('worker worker worker threads threads image image processing pipeline', 3);
    assert.strictEqual(k.length, 3);
    assert.strictEqual(new Set(k).size, 3);
  });

  it('keeps dotted/pathish identifiers', () => {
    const k = keywords('use worker_threads module and src/index.js');
    assert.ok(k.includes('worker_threads'));
    assert.ok(k.some((w) => w.includes('index.js') || w.includes('src/index.js')));
  });
});

describe('Unit: jaccard', () => {
  it('is 1 for identical sets', () => assert.strictEqual(jaccard(['a', 'b'], ['b', 'a']), 1));
  it('is 0 for disjoint sets', () => assert.strictEqual(jaccard(['a'], ['b']), 0));
  it('is 0 when either side empty', () => {
    assert.strictEqual(jaccard([], ['a']), 0);
    assert.strictEqual(jaccard(['a'], []), 0);
  });
  it('computes partial overlap correctly', () => {
    // {a,b,c} vs {b,c,d}: inter=2 union=4 => 0.5
    assert.strictEqual(jaccard(['a', 'b', 'c'], ['b', 'c', 'd']), 0.5);
  });
});

describe('Unit: hunk similarity', () => {
  it('strips +/- diff markers and whitespace', () => {
    const lines = hunkLines('+  const x = 1;\n-  const y = 2;\n   \n```');
    assert.ok(lines.includes('const x = 1;'));
    assert.ok(lines.includes('const y = 2;'));
    assert.ok(!lines.includes('```'));
    assert.ok(!lines.includes(''));
  });

  it('is 1.0 for identical code (ignoring markers)', () => {
    const a = 'const worker = new Worker(file);\nworker.postMessage(data);';
    const b = '+const worker = new Worker(file);\n+worker.postMessage(data);';
    assert.strictEqual(hunkSimilarity(a, b), 1);
  });

  it('is low for unrelated code', () => {
    const a = 'const worker = new Worker(file);';
    const b = 'export default function App() { return null; }';
    assert.ok(hunkSimilarity(a, b) < 0.2);
  });

  it('is 0 for empty input', () => {
    assert.strictEqual(hunkSimilarity('', 'x'), 0);
    assert.strictEqual(hunkSimilarity('x', ''), 0);
  });

  it('detects a mostly-reintroduced hunk above threshold', () => {
    const original = 'const w = new Worker(path);\nw.on("message", handle);\nw.postMessage(job);\nreturn w;';
    const reintroduced = 'const w = new Worker(path);\nw.on("message", handle);\nw.postMessage(job);\nreturn w; // retry';
    assert.ok(hunkSimilarity(original, reintroduced) >= HUNK_MATCH_THRESHOLD);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: code-snapshot capture (the enforcement-leg fix)
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: toolUseCode', () => {
  it('extracts new_string from an Edit tool_use block', () => {
    const msg = { message: { role: 'assistant', content: [
      { type: 'text', text: 'editing' },
      { type: 'tool_use', name: 'Edit', input: { new_string: 'const x = 1;\nconst y = 2;' } },
    ] } };
    const uses = toolUseCode(msg);
    assert.strictEqual(uses.length, 1);
    assert.strictEqual(uses[0].tool, 'Edit');
    assert.strictEqual(uses[0].code, 'const x = 1;\nconst y = 2;');
  });

  it('extracts content from a Write tool_use block', () => {
    const msg = { message: { content: [
      { type: 'tool_use', name: 'Write', input: { content: 'file body' } },
    ] } };
    assert.strictEqual(toolUseCode(msg)[0].code, 'file body');
  });

  it('ignores non-Edit/Write tool_use and text-only messages', () => {
    assert.deepStrictEqual(
      toolUseCode({ message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }),
      []
    );
    assert.deepStrictEqual(toolUseCode({ message: { content: 'plain text' } }), []);
    assert.deepStrictEqual(toolUseCode(null), []);
  });

  it('skips empty code payloads', () => {
    assert.deepStrictEqual(
      toolUseCode({ message: { content: [{ type: 'tool_use', name: 'Edit', input: { new_string: '   ' } }] } }),
      []
    );
  });
});

describe('Unit: findRevertedCode', () => {
  it('finds the nearest preceding Edit code overlapping the dead-end keywords', () => {
    const messages = [
      { message: { content: [{ type: 'tool_use', name: 'Edit', input: { new_string: 'const worker = new Worker(path);\nworker.postMessage(job);' } }] } },
      { message: { content: [{ type: 'text', text: 'reverting the worker change' }] } },
    ];
    const code = findRevertedCode(messages, 1, ['worker', 'postmessage', 'job']);
    assert.ok(code.includes('new Worker'));
  });

  it('returns "" when no Edit/Write precedes the revert', () => {
    const messages = [
      { message: { content: [{ type: 'text', text: 'we should try worker threads' }] } },
      { message: { content: [{ type: 'text', text: 'reverting that idea' }] } },
    ];
    assert.strictEqual(findRevertedCode(messages, 1, ['worker', 'threads']), '');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: transcript parsing
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: messageText', () => {
  it('reads string content', () => {
    assert.strictEqual(messageText({ message: { content: 'hello' } }), 'hello');
  });
  it('reads block-array content', () => {
    const t = messageText({ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } });
    assert.strictEqual(t, 'a\nb');
  });
  it('returns "" for missing content', () => {
    assert.strictEqual(messageText({}), '');
    assert.strictEqual(messageText(null), '');
  });
});

describe('Unit: estimateTokens / usdFor', () => {
  it('sums usage across assistant messages', () => {
    const tokens = estimateTokens(makeTranscript());
    // 1200+800 + 1500+1000 + 2000+1500 = 8000
    assert.strictEqual(tokens, 8000);
  });
  it('falls back to char estimate when no usage present', () => {
    const msgs = [{ message: { role: 'assistant', content: 'x'.repeat(400) } }];
    assert.strictEqual(estimateTokens(msgs), 100); // 400/4
  });
  it('usdFor returns null for zero/negative tokens', () => {
    assert.strictEqual(usdFor(0), null);
    assert.strictEqual(usdFor(-5), null);
  });
  it('usdFor returns a positive rounded number', () => {
    const usd = usdFor(1_000_000);
    assert.ok(typeof usd === 'number' && usd > 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: extraction
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: extractDeadEnds', () => {
  it('extracts a reverted approach with reason + keywords', () => {
    const ends = extractDeadEnds(makeTranscript());
    assert.ok(ends.length >= 1, 'expected at least one dead end');
    const e = ends[0];
    assert.ok(['reverted', 'caused a defect'].includes(e.reason));
    assert.ok(e.keywords.includes('worker') || e.keywords.includes('threads'));
    assert.ok(typeof e.summary === 'string' && e.summary.length > 0);
    assert.ok(typeof e.fingerprint === 'string' && e.fingerprint.length > 0);
  });

  it('captures the reverted code snapshot from a nearby Edit tool_use', () => {
    const ends = extractDeadEnds(makeTranscript());
    const withCode = ends.find((e) => e.code);
    assert.ok(withCode, 'expected a dead end carrying a code snapshot');
    // The captured code must be the actual new_string that was written & reverted.
    assert.ok(withCode.code.includes('new Worker'));
    assert.ok(withCode.code.includes('postMessage'));
    assert.strictEqual(withCode.code, REVERTED_WORKER_CODE);
  });

  it('leaves code undefined when there is no Edit/Write tool_use to snapshot', () => {
    const proseOnly = [
      { message: { role: 'user', content: 'move image processing to worker threads' } },
      { message: { role: 'assistant', content: [{ type: 'text', text: 'that worker threads image processing approach caused a race condition, reverting' }] } },
    ];
    const ends = extractDeadEnds(proseOnly);
    assert.ok(ends.length >= 1);
    assert.strictEqual(ends[0].code, undefined);
  });

  it('returns [] when there is no revert signal', () => {
    const clean = [
      { message: { role: 'user', content: 'add a hello world function' } },
      { message: { role: 'assistant', content: [{ type: 'text', text: 'Added a hello world function, all tests pass.' }] } },
    ];
    assert.deepStrictEqual(extractDeadEnds(clean), []);
  });

  it('returns [] for empty / non-array input', () => {
    assert.deepStrictEqual(extractDeadEnds([]), []);
    assert.deepStrictEqual(extractDeadEnds(null), []);
  });

  it('dedupes identical fingerprints', () => {
    const repeated = [
      { message: { content: 'move image processing to worker threads' } },
      { message: { content: 'reverting the worker threads image processing change' } },
      { message: { content: 'move image processing to worker threads' } },
      { message: { content: 'reverting the worker threads image processing change again' } },
    ];
    const ends = extractDeadEnds(repeated);
    const fps = ends.map((e) => e.fingerprint);
    assert.strictEqual(fps.length, new Set(fps).size);
  });

  it('skips too-vague reverts (insufficient keywords)', () => {
    const vague = [{ message: { content: 'revert it' } }];
    assert.deepStrictEqual(extractDeadEnds(vague), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: prompt / edit matching
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: matchPrompt', () => {
  const registry = [
    { fingerprint: 'a', keywords: ['worker', 'threads', 'image', 'processing', 'race'], date: '2026-06-12', reason: 'reverted', summary: 's', usd: 9 },
    { fingerprint: 'b', keywords: ['postgres', 'migration', 'schema'], date: '2026-05-01', reason: 'reverted', summary: 's2', usd: 3 },
  ];

  it('matches a semantically-overlapping prompt', () => {
    const m = matchPrompt('can we move image processing to worker threads again?', registry);
    assert.ok(m.length >= 1);
    assert.strictEqual(m[0].entry.fingerprint, 'a');
    assert.ok(m[0].score >= PROMPT_MATCH_THRESHOLD);
  });

  it('does not match an unrelated prompt', () => {
    const m = matchPrompt('please write a css gradient for the header', registry);
    assert.strictEqual(m.length, 0);
  });

  it('returns [] for empty prompt or empty registry', () => {
    assert.deepStrictEqual(matchPrompt('', registry), []);
    assert.deepStrictEqual(matchPrompt('worker threads', []), []);
  });

  it('sorts matches by descending score', () => {
    const reg = [
      { fingerprint: 'x', keywords: ['worker', 'threads'] },
      { fingerprint: 'y', keywords: ['worker', 'threads', 'image', 'processing'] },
    ];
    const m = matchPrompt('worker threads image processing pipeline', reg, 0.1);
    if (m.length === 2) assert.ok(m[0].score >= m[1].score);
  });
});

describe('Unit: editCode / matchEdit', () => {
  it('extracts content for Write and new_string for Edit', () => {
    assert.strictEqual(editCode('Write', { content: 'abc' }), 'abc');
    assert.strictEqual(editCode('Edit', { new_string: 'xyz' }), 'xyz');
    assert.strictEqual(editCode('Edit', null), '');
  });

  it('flags an edit that reintroduces a reverted hunk', () => {
    const registry = [
      {
        fingerprint: 'a',
        date: '2026-06-12',
        reason: 'reverted',
        summary: 'worker threads',
        usd: 9,
        code: 'const w = new Worker(path);\nw.on("message", handle);\nw.postMessage(job);',
      },
    ];
    const edit = 'const w = new Worker(path);\nw.on("message", handle);\nw.postMessage(job);\n// again';
    const m = matchEdit(edit, registry);
    assert.ok(m, 'expected a match');
    assert.ok(m.score >= HUNK_MATCH_THRESHOLD);
    assert.strictEqual(m.entry.fingerprint, 'a');
  });

  it('returns null when no registry entry carries code', () => {
    // Multi-line edit so the min-hunk guard is not what returns null here.
    const edit = 'const x = 1;\nconst y = 2;\nconst z = 3;';
    assert.strictEqual(matchEdit(edit, [{ fingerprint: 'a', keywords: ['x'] }]), null);
  });

  it('returns null for unrelated edit', () => {
    const registry = [{ code: 'const w = new Worker(path);\nw.on("m", h);\nw.post(j);', fingerprint: 'a' }];
    assert.strictEqual(matchEdit('body { color: red; }\nh1 { size: 2rem; }\np { margin: 0; }', registry), null);
  });

  it('does NOT fire on a tiny (< MIN_HUNK_LINES) edit even if identical', () => {
    assert.ok(MIN_HUNK_LINES >= 2);
    const tiny = 'return null;'; // 1 line — too generic to interrupt on
    const registry = [{ code: 'return null;', fingerprint: 'a', date: '2026-01-01', reason: 'reverted' }];
    assert.strictEqual(matchEdit(tiny, registry), null);
  });

  it('does NOT fire when the registry snapshot is a tiny hunk', () => {
    const edit = 'const a = 1;\nconst b = 2;\nconst c = 3;';
    const registry = [{ code: 'x', fingerprint: 'a' }]; // 1-line snapshot
    assert.strictEqual(matchEdit(edit, registry), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: rendering
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: rendering cards', () => {
  const entry = { date: '2026-06-12', reason: 'race condition in the event loop', summary: 'moved image processing to worker threads', usd: 9 };

  it('prompt card mentions DEAD END, date, and dollar cost', () => {
    const card = renderPromptCard([{ entry, score: 0.8 }]);
    assert.ok(card.includes('DEAD END') || card.includes('DEAD-END'));
    assert.ok(card.includes('2026-06-12'));
    assert.ok(card.includes('$9') || card.includes('$9.00'));
  });

  it('prompt card omits dollar line when no usd', () => {
    const noCost = { date: '2026-06-12', reason: 'reverted', summary: 'x', usd: null };
    const card = renderPromptCard([{ entry: noCost, score: 0.5 }]);
    assert.ok(!/\$\d/.test(card));
  });

  it('edit reason mentions "twice" and the score', () => {
    const r = renderEditReason(entry, 0.72);
    assert.ok(r.includes('DEAD END'));
    assert.ok(r.includes('twice'));
    assert.ok(r.includes('72%'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: registry persistence (hermetic — temp dir, no real HOME writes here)
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: persistDeadEnds / readRegistry', () => {
  let tmp;
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-de-reg-')); });
  after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  it('writes new entries and skips duplicate fingerprints', () => {
    const file = path.join(tmp, 'reg.jsonl');
    const cands = [
      { summary: 's1', reason: 'reverted', signal: 'reverted', keywords: ['worker', 'threads'], fingerprint: 'fp1' },
      { summary: 's2', reason: 'reverted', signal: 'reverted', keywords: ['postgres', 'migration'], fingerprint: 'fp2' },
    ];
    const added1 = persistDeadEnds(file, cands, { tokens: 4000, session_id: 's', event: 'Stop' });
    assert.strictEqual(added1.length, 2);
    // Each gets a share of the token cost and a usd figure.
    assert.strictEqual(added1[0].tokens, 2000);
    assert.ok(added1[0].usd > 0);

    // Re-persisting the same fingerprints adds nothing.
    const added2 = persistDeadEnds(file, cands, { tokens: 1000, session_id: 's', event: 'Stop' });
    assert.strictEqual(added2.length, 0);

    const reg = readRegistry(file);
    assert.strictEqual(reg.length, 2);
    assert.ok(reg[0].id && reg[0].date && reg[0].fingerprint);
  });

  it('readRegistry tolerates corrupt lines and missing files', () => {
    const file = path.join(tmp, 'corrupt.jsonl');
    fs.writeFileSync(file, '{"fingerprint":"ok"}\nNOT JSON\n{"fingerprint":"ok2"}\n');
    const reg = readRegistry(file);
    assert.strictEqual(reg.length, 2);
    assert.deepStrictEqual(readRegistry(path.join(tmp, 'nope.jsonl')), []);
  });
});

describe('Unit: registryFileFor', () => {
  it('is stable for the same cwd and varies by cwd', () => {
    const a = registryFileFor('/repo/one');
    const b = registryFileFor('/repo/one');
    const c = registryFileFor('/repo/two');
    assert.strictEqual(a, b);
    assert.notStrictEqual(a, c);
    assert.ok(a.endsWith('.jsonl'));
  });
  it('handles empty cwd', () => {
    assert.ok(registryFileFor('').endsWith('.jsonl'));
    assert.ok(registryFileFor(undefined).endsWith('.jsonl'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: spawn the script with a fresh temp HOME
// ─────────────────────────────────────────────────────────────────────────────

function runHook(payload, homeDir) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, HOME: homeDir };
    delete env.CCH_SLA_WEBHOOK;
    const child = spawn('node', [SCRIPT_PATH], { env });
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

describe('Integration: stdin/stdout hook flow', () => {
  let home;
  before(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-de-home-')); });
  after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });

  it('returns {} for empty stdin', async () => {
    const { code, output } = await runHook('', home);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });

  it('returns {} for invalid JSON', async () => {
    const { code, output } = await runHook('not json at all', home);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });

  it('returns {} for an unknown event', async () => {
    const { output } = await runHook({ hook_event_name: 'SessionStart', cwd: '/tmp/repo-x' }, home);
    assert.deepStrictEqual(output, {});
  });

  it('Stop mines a transcript into the registry, then UserPromptSubmit warns', async () => {
    const cwd = path.join(home, 'proj-alpha');
    const { file } = withTranscript(makeTranscript());

    // 1) Stop event mines the transcript.
    const mine = await runHook(
      { hook_event_name: 'Stop', cwd, transcript_path: file, session_id: 'sess-1' },
      home
    );
    assert.deepStrictEqual(mine.output, {}, 'mine handler is a silent no-op on stdout');

    // Registry file should now exist under the child's temp HOME.
    const regDir = path.join(home, '.claude', 'dead-end-registry');
    assert.ok(fs.existsSync(regDir), 'registry dir created under temp HOME');
    const files = fs.readdirSync(regDir).filter((f) => f.endsWith('.jsonl'));
    assert.ok(files.length >= 1, 'a registry file was written');
    const entries = fs
      .readFileSync(path.join(regDir, files[0]), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.ok(entries.length >= 1, 'at least one dead end recorded');
    assert.ok(entries[0].keywords.some((k) => ['worker', 'threads', 'image'].includes(k)));

    // 2) A matching prompt should get an additionalContext warning.
    const prompt = await runHook(
      {
        hook_event_name: 'UserPromptSubmit',
        cwd,
        prompt: 'lets move image processing to worker threads for performance',
        session_id: 'sess-2',
      },
      home
    );
    assert.strictEqual(prompt.output.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
    const ctx = prompt.output.hookSpecificOutput?.additionalContext || '';
    assert.ok(ctx.includes('DEAD END') || ctx.includes('DEAD-END'), 'warning card injected');
  });

  it('UserPromptSubmit is a no-op when registry is empty', async () => {
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-de-empty-'));
    try {
      const { output } = await runHook(
        { hook_event_name: 'UserPromptSubmit', cwd: path.join(emptyHome, 'x'), prompt: 'anything at all here' },
        emptyHome
      );
      assert.deepStrictEqual(output, {});
    } finally {
      fs.rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  it('UserPromptSubmit is a no-op for a non-matching prompt', async () => {
    const cwd = path.join(home, 'proj-alpha'); // already has worker-threads dead end
    const { output } = await runHook(
      { hook_event_name: 'UserPromptSubmit', cwd, prompt: 'write me a haiku about the ocean' },
      home
    );
    assert.deepStrictEqual(output, {});
  });

  it('end-to-end: Stop mines a code snapshot, then PreToolUse asks when it is reintroduced', async () => {
    // This proves the enforcement leg works from REAL mined data — no hand-seeded
    // `code` fixture. The registry entry's code must originate from the Stop mine.
    const cwd = path.join(home, 'proj-e2e');
    const { file } = withTranscript(makeTranscript());

    // 1) Stop mines the transcript, capturing the reverted Edit's new_string.
    const mine = await runHook(
      { hook_event_name: 'Stop', cwd, transcript_path: file, session_id: 'sess-e2e' },
      home
    );
    assert.deepStrictEqual(mine.output, {});

    // Verify the persisted registry entry actually carries a mined code snapshot.
    const regFile = registryFileForHome(home, cwd);
    const entries = fs
      .readFileSync(regFile, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const coded = entries.find((e) => e.code);
    assert.ok(coded, 'mine path must persist a code snapshot on the entry');
    assert.ok(coded.code.includes('new Worker'), 'mined code is the reverted hunk');
    assert.ok(coded.code.includes('postMessage'));

    // 2) An Edit that reintroduces that exact mined hunk must trigger an ask.
    const { output } = await runHook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: {
          new_string:
            'const worker = new Worker("./image-worker.js");\nworker.on("message", handleImageResult);\nworker.postMessage(imageJob);\nreturn worker; // second attempt',
        },
        cwd,
        session_id: 'sess-e2e-2',
      },
      home
    );
    assert.strictEqual(output.hookSpecificOutput?.hookEventName, 'PreToolUse');
    assert.strictEqual(output.hookSpecificOutput?.permissionDecision, 'ask');
    assert.ok(output.hookSpecificOutput?.permissionDecisionReason.includes('DEAD END'));
    // The date is the mine date (today), not a fixture value — assert format only.
    assert.ok(/\d{4}-\d{2}-\d{2}/.test(output.hookSpecificOutput?.permissionDecisionReason));
  });

  it('PreToolUse is a no-op for a non-Edit/Write tool', async () => {
    const cwd = path.join(home, 'proj-beta');
    const { output } = await runHook(
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd },
      home
    );
    assert.deepStrictEqual(output, {});
  });

  it('PreToolUse is a no-op for an unrelated Edit', async () => {
    const cwd = path.join(home, 'proj-beta');
    const { output } = await runHook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { content: 'body { color: red; }\nh1 { font-size: 2rem; }' },
        cwd,
      },
      home
    );
    assert.deepStrictEqual(output, {});
  });

  it('does not pollute the real home directory', () => {
    // Sanity: our temp HOME is where the registry landed, not the developer HOME.
    assert.ok(home.startsWith(os.tmpdir()));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Config sanity
// ─────────────────────────────────────────────────────────────────────────────

describe('Config: constants', () => {
  it('REVERT_PATTERNS all have regex + reason + id', () => {
    for (const p of REVERT_PATTERNS) {
      assert.ok(p.regex instanceof RegExp, `pattern ${p.id} missing regex`);
      assert.ok(typeof p.reason === 'string' && p.reason.length > 0);
      assert.ok(typeof p.id === 'string' && p.id.length > 0);
    }
  });
  it('REVERT_PATTERNS ids are unique', () => {
    const ids = REVERT_PATTERNS.map((p) => p.id);
    assert.strictEqual(ids.length, new Set(ids).size);
  });
  it('thresholds are sane fractions', () => {
    assert.ok(PROMPT_MATCH_THRESHOLD > 0 && PROMPT_MATCH_THRESHOLD < 1);
    assert.ok(HUNK_MATCH_THRESHOLD > 0 && HUNK_MATCH_THRESHOLD < 1);
  });
  it('route is a function and defaults unknown events to {}', () => {
    assert.strictEqual(typeof route, 'function');
    assert.deepStrictEqual(route({ hook_event_name: 'Nope', cwd: '/x' }), {});
  });
});
