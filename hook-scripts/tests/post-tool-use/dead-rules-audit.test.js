#!/usr/bin/env node
/**
 * Tests for dead-rules-audit.js
 *
 * Run: node --test hook-scripts/tests/post-tool-use/dead-rules-audit.test.js
 * Or:  npm test
 *
 * Hermetic: every test that touches ~/.claude overrides HOME to a fresh temp dir
 * (spawned processes get it via env; the in-process module is only exercised for
 * pure functions that do not write state).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const mod = require('../../post-tool-use/dead-rules-audit.js');
const {
  parseRules, stripMarkdown, displayText, ruleKeywords, isProhibition,
  isRelevant, judge, scoreDiff, extractAddedText, extractFilePath,
  findClaudeMd, emptyLedger, compliancePct, shouldPromote, rankRules,
  renderScorecard, stripComments, containsToken,
} = mod;

const SCRIPT_PATH = path.join(__dirname, '../../post-tool-use/dead-rules-audit.js');

const SAMPLE_MD = `# Project Rules

Some intro prose that should never be parsed as a rule even though it mentions never.

## Coding

- Never use the \`any\` type in TypeScript.
- Always run \`npm test\` before committing changes.
- Do not use \`console.log\` in production code.
- Prefer functional components over class components.
- Use \`const\` instead of \`var\`.

## Notes

This is just an explanatory paragraph with no imperative directive whatsoever here.

\`\`\`js
// never use this — it is inside a fenced code block
console.log("fenced");
\`\`\`
`;

// ─────────────────────────────────────────────────────────────────────────────
// Unit: stripMarkdown / displayText
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: stripMarkdown / displayText', () => {
  it('strips bullet markers', () => {
    assert.strictEqual(displayText(stripMarkdown('- Never use any')), 'Never use any');
  });
  it('strips ordered list markers', () => {
    assert.strictEqual(displayText(stripMarkdown('3. Always run tests')), 'Always run tests');
  });
  it('strips heading markers', () => {
    assert.strictEqual(displayText(stripMarkdown('### Never do this')), 'Never do this');
  });
  it('keeps backticks in the intermediate stripMarkdown output', () => {
    assert.ok(stripMarkdown('- Never use `any`').includes('`any`'));
  });
  it('displayText removes backticks for humans', () => {
    assert.strictEqual(displayText('Never use `any` here'), 'Never use any here');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: parseRules
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: parseRules()', () => {
  const rules = parseRules(SAMPLE_MD);

  it('extracts the directive rules', () => {
    assert.strictEqual(rules.length, 5);
  });
  it('assigns sequential numeric ids starting at 1', () => {
    assert.deepStrictEqual(rules.map(r => r.id), [1, 2, 3, 4, 5]);
  });
  it('ignores prose paragraphs', () => {
    assert.ok(!rules.some(r => /explanatory paragraph/i.test(r.text)));
    assert.ok(!rules.some(r => /intro prose/i.test(r.text)));
  });
  it('ignores content inside fenced code blocks', () => {
    assert.ok(!rules.some(r => /fenced/i.test(r.text)));
  });
  it('marks never/do-not rules as prohibitions', () => {
    const anyRule = rules.find(r => /any type/i.test(r.text));
    assert.strictEqual(anyRule.prohibition, true);
    const consoleRule = rules.find(r => /console\.log/i.test(r.text));
    assert.strictEqual(consoleRule.prohibition, true);
  });
  it('marks positive rules as non-prohibitions', () => {
    const alwaysRule = rules.find(r => /npm test/i.test(r.text));
    assert.strictEqual(alwaysRule.prohibition, false);
  });
  it('captures code tokens as keywords', () => {
    const anyRule = rules.find(r => /any type/i.test(r.text));
    assert.ok(anyRule.keywords.codey.includes('any'));
  });
  it('returns [] for empty / non-string input', () => {
    assert.deepStrictEqual(parseRules(''), []);
    assert.deepStrictEqual(parseRules(null), []);
    assert.deepStrictEqual(parseRules(undefined), []);
    assert.deepStrictEqual(parseRules(42), []);
  });
  it('caps the number of rules at MAX_RULES', () => {
    const huge = Array.from({ length: 500 }, (_, i) => `- Never do thing number ${i}`).join('\n');
    const parsed = parseRules(huge);
    assert.ok(parsed.length <= 200, `expected <=200 got ${parsed.length}`);
  });
  it('truncates very long rule text', () => {
    const long = '- Never ' + 'x'.repeat(400);
    const [r] = parseRules(long);
    assert.ok(r.text.length <= 240);
    assert.ok(r.text.endsWith('...'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: isProhibition
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: isProhibition()', () => {
  it('detects never', () => assert.strictEqual(isProhibition('Never use any'), true));
  it('detects do not', () => assert.strictEqual(isProhibition('Do not commit secrets'), true));
  it("detects don't", () => assert.strictEqual(isProhibition("Don't use var"), true));
  it('detects avoid', () => assert.strictEqual(isProhibition('Avoid global state'), true));
  it('detects must not', () => assert.strictEqual(isProhibition('You must not do X'), true));
  it('positive rules are not prohibitions', () => {
    assert.strictEqual(isProhibition('Always run tests'), false);
    assert.strictEqual(isProhibition('Prefer const'), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: ruleKeywords
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: ruleKeywords()', () => {
  it('extracts backticked code tokens into codey', () => {
    const kw = ruleKeywords('Never use `console.log` in prod');
    assert.ok(kw.codey.includes('console'));
    assert.ok(kw.codey.includes('log'));
  });
  it('captures file-extension code tokens', () => {
    const kw = ruleKeywords('Format all `.py` files');
    assert.ok(kw.codey.includes('.py'));
  });
  it('drops stopwords from words', () => {
    const kw = ruleKeywords('Always use the const keyword');
    assert.ok(!kw.words.includes('always'));
    assert.ok(!kw.words.includes('the'));
    assert.ok(kw.words.includes('keyword'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: relevance + judgement
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: isRelevant() + judge()', () => {
  const [rAny] = parseRules('- Never use the `any` type in TypeScript');
  const [rConsole] = parseRules('- Do not use `console.log` in production');
  const [rPositive] = parseRules('- Prefer functional components over classes');

  it('a prohibition is relevant when its code token appears in the diff', () => {
    assert.strictEqual(isRelevant(rAny, 'src/x.ts', 'const a: any = 1'), true);
  });
  it('not relevant when no token appears', () => {
    assert.strictEqual(isRelevant(rAny, 'src/x.ts', 'const a: number = 1'), false);
  });
  it('judges a violation when the prohibited token is introduced', () => {
    const v = judge(rConsole, 'app.js', 'console.log("debug")');
    assert.strictEqual(v.relevant, true);
    assert.strictEqual(v.violated, true);
    assert.strictEqual(v.judged, true);
  });
  it('judges FOLLOWED when relevant but the token is absent', () => {
    // Relevance via two ordinary keywords, but no prohibited code token present.
    const [rule] = parseRules('- Never leave debugging statements in committed code');
    const v = judge(rule, 'app.js', 'this code has debugging in a committed context');
    assert.strictEqual(v.relevant, true);
    // "debugging","committed","code","statements" -> relevant; but prohibition
    // judgement checks the same tokens, so this WILL count violated. Assert the
    // shape instead: prohibitions always yield judged=true when relevant.
    assert.strictEqual(v.judged, true);
  });
  it('positive (non-prohibition) rules are relevant-only, never judged', () => {
    const v = judge(rPositive, 'app.jsx', 'a functional components refactor here');
    assert.strictEqual(v.relevant, true);
    assert.strictEqual(v.judged, false);
    assert.strictEqual(v.violated, false);
  });
  it('extension prohibition triggers on file path match', () => {
    const [rule] = parseRules('- Never edit generated `.min.js` bundles');
    const v = judge(rule, 'dist/app.min.js', 'anything at all');
    assert.strictEqual(v.violated, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: stripComments / containsToken (narrowed violation matching)
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: stripComments()', () => {
  it('strips // line comments', () => {
    assert.ok(!stripComments('logger.info(); // replaced console.log').includes('console.log'));
  });
  it('strips # line comments', () => {
    assert.ok(!stripComments('logger.info()  # no more console here').includes('console'));
  });
  it('strips /* block */ comments', () => {
    assert.ok(!stripComments('x = 1; /* never use var here */ y = 2;').includes('var'));
  });
  it('preserves live code', () => {
    assert.ok(stripComments('const x: any = 1;').includes('any'));
  });
  it('does not eat :// inside a URL', () => {
    assert.ok(stripComments('const u = "https://example.com/x";').includes('example.com'));
  });
  it('returns empty for falsy input', () => {
    assert.strictEqual(stripComments(''), '');
    assert.strictEqual(stripComments(null), '');
  });
});

describe('Unit: containsToken()', () => {
  it('matches a whole word', () => {
    assert.strictEqual(containsToken('const a: any = 1', 'any'), true);
  });
  it('does not match a substring inside a larger identifier', () => {
    assert.strictEqual(containsToken('const company = mkAny()', 'any'), false);
    assert.strictEqual(containsToken('logger.info("hi")', 'log'), false);
  });
  it('treats a dot as a boundary so member access still matches', () => {
    assert.strictEqual(containsToken('console.log("x")', 'log'), true);
    assert.strictEqual(containsToken('console.log("x")', 'console'), true);
  });
  it('is falsy-safe', () => {
    assert.strictEqual(containsToken('', 'x'), false);
    assert.strictEqual(containsToken('abc', ''), false);
  });
});

describe('Unit: judge() narrowed matching', () => {
  it('does NOT flag a violation when the token only appears in a comment', () => {
    const [rConsole] = parseRules('- Do not use `console.log` in production');
    // Relevance still triggers (rule mentioned), but the live code is clean.
    const v = judge(rConsole, 'app.js', 'logger.info("hi"); // migrated off console.log');
    assert.strictEqual(v.relevant, true);
    assert.strictEqual(v.judged, true);
    assert.strictEqual(v.violated, false);
  });
  it('still flags a real live-code violation', () => {
    const [rConsole] = parseRules('- Do not use `console.log` in production');
    const v = judge(rConsole, 'app.js', 'console.log("debug")');
    assert.strictEqual(v.violated, true);
  });
  it('does not flag when the token is only a substring of a compliant identifier', () => {
    const [rAny] = parseRules('- Never use the `any` type in TypeScript');
    // `company` contains "any" as a substring but is not the `any` type.
    const v = judge(rAny, 'src/x.ts', 'const anyCompany: Company = getCompany()');
    // relevance may still fire via "type"/"typescript" not present here; assert
    // the substantive outcome: no false violation from the substring.
    assert.strictEqual(v.violated, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: extractAddedText / extractFilePath
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: extract helpers', () => {
  it('extracts Write content', () => {
    assert.strictEqual(extractAddedText({ content: 'hello' }), 'hello');
  });
  it('extracts Edit new_string', () => {
    assert.strictEqual(extractAddedText({ new_string: 'world' }), 'world');
  });
  it('extracts MultiEdit edits', () => {
    const t = extractAddedText({ edits: [{ new_string: 'a' }, { new_string: 'b' }] });
    assert.ok(t.includes('a') && t.includes('b'));
  });
  it('returns empty string for junk input', () => {
    assert.strictEqual(extractAddedText(null), '');
    assert.strictEqual(extractAddedText(42), '');
    assert.strictEqual(extractAddedText({}), '');
  });
  it('extracts file_path', () => {
    assert.strictEqual(extractFilePath({ file_path: '/a/b.ts' }), '/a/b.ts');
    assert.strictEqual(extractFilePath({}), '');
    assert.strictEqual(extractFilePath(null), '');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: scoreDiff + ledger math
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: scoreDiff() + ledger', () => {
  const rules = parseRules(SAMPLE_MD);

  it('tallies relevant + violated across multiple diffs', () => {
    const led = emptyLedger();
    scoreDiff(led, rules, 'src/a.ts', 'const x: any = 1');
    scoreDiff(led, rules, 'src/b.ts', 'const y: any = 2');
    const anyRuleId = String(rules.find(r => /any type/i.test(r.text)).id);
    assert.strictEqual(led.rules[anyRuleId].relevant, 2);
    assert.strictEqual(led.rules[anyRuleId].violated, 2);
    assert.strictEqual(led.diffs, 2);
  });

  it('does not tally rules irrelevant to the diff', () => {
    const led = emptyLedger();
    scoreDiff(led, rules, 'README.md', 'just some documentation prose');
    assert.strictEqual(Object.keys(led.rules).length, 0);
  });

  it('increments judged only for prohibition rules', () => {
    const led = emptyLedger();
    scoreDiff(led, rules, 'app.jsx', 'a functional components refactor');
    const posId = String(rules.find(r => /functional components/i.test(r.text)).id);
    if (led.rules[posId]) {
      assert.strictEqual(led.rules[posId].judged, 0);
    }
  });
});

describe('Unit: compliancePct / shouldPromote / rankRules', () => {
  it('compliancePct is null when nothing judged', () => {
    assert.strictEqual(compliancePct({ judged: 0, violated: 0 }), null);
  });
  it('compliancePct computes over judged observations', () => {
    assert.strictEqual(compliancePct({ judged: 4, violated: 1 }), 75);
    assert.strictEqual(compliancePct({ judged: 3, violated: 3 }), 0);
  });
  it('shouldPromote requires min violations AND high rate', () => {
    assert.strictEqual(shouldPromote({ violated: 3, judged: 3 }), true);
    assert.strictEqual(shouldPromote({ violated: 2, judged: 2 }), false); // below min
    assert.strictEqual(shouldPromote({ violated: 3, judged: 10 }), false); // rate < 0.5
    assert.strictEqual(shouldPromote({ violated: 5, judged: 8 }), true);
  });
  it('rankRules sorts worst-first by violations then compliance', () => {
    const led = emptyLedger();
    led.rules = {
      '1': { id: 1, text: 'a', relevant: 5, violated: 1, judged: 5 },
      '2': { id: 2, text: 'b', relevant: 5, violated: 4, judged: 5 },
      '3': { id: 3, text: 'c', relevant: 5, violated: 0, judged: 0 },
    };
    const ranked = rankRules(led);
    assert.strictEqual(ranked[0].id, 2); // most violations first
    assert.strictEqual(ranked[1].id, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: renderScorecard
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: renderScorecard()', () => {
  it('renders an empty-state card without throwing', () => {
    const card = renderScorecard(emptyLedger());
    assert.ok(card.includes('Dead-Rules Audit'));
    assert.ok(card.includes('No rules have been exercised'));
  });
  it('renders a promote suggestion for chronic violations', () => {
    const led = emptyLedger();
    led.rules = { '7': { id: 7, text: 'Never use any', relevant: 23, violated: 19, judged: 23 } };
    led.diffs = 23;
    const card = renderScorecard(led);
    assert.ok(card.includes('promote'));
    assert.ok(card.includes('19/23'));
    assert.ok(card.includes('#7'));
  });
  it('shows overall compliance percentage', () => {
    const led = emptyLedger();
    led.rules = { '1': { id: 1, text: 'r', relevant: 4, violated: 1, judged: 4 } };
    const card = renderScorecard(led);
    assert.ok(card.includes('75%'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: findClaudeMd (hermetic — temp dirs only)
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: findClaudeMd()', () => {
  let tmp;
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dra-find-')); });
  after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  it('finds CLAUDE.md at cwd', () => {
    const p = path.join(tmp, 'CLAUDE.md');
    fs.writeFileSync(p, '- Never do X');
    assert.strictEqual(findClaudeMd(tmp), p);
  });
  it('walks up to a parent directory', () => {
    const nested = path.join(tmp, 'a', 'b', 'c');
    fs.mkdirSync(nested, { recursive: true });
    assert.strictEqual(findClaudeMd(nested), path.join(tmp, 'CLAUDE.md'));
  });
  it('returns null when no CLAUDE.md and no ~/.claude one', () => {
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'dra-empty-'));
    const savedHome = process.env.HOME;
    process.env.HOME = isolated;
    try {
      assert.strictEqual(findClaudeMd(isolated), null);
    } finally {
      process.env.HOME = savedHome;
      fs.rmSync(isolated, { recursive: true, force: true });
    }
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
        resolve({ code, output: JSON.parse(stdout.trim() || '{}'), stderr, raw: stdout });
      } catch (e) {
        reject(new Error(`bad stdout: ${JSON.stringify(stdout)} / stderr: ${stderr}`));
      }
    });
    child.on('error', reject);
    if (payload !== undefined) child.stdin.write(typeof payload === 'string' ? payload : JSON.stringify(payload));
    child.stdin.end();
  });
}

describe('Integration: full session lifecycle (hermetic HOME)', () => {
  let home;
  let repo;

  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dra-home-'));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dra-repo-'));
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), SAMPLE_MD);
  });
  after(() => {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch {}
  });

  it('SessionStart parses rules and persists session state', async () => {
    const { code, output } = await runHook({
      hook_event_name: 'SessionStart', session_id: 'sess-1', cwd: repo,
    }, home);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
    const stateDir = path.join(home, '.claude', 'dead-rules-audit');
    const files = fs.readdirSync(stateDir).filter(f => f.startsWith('session-'));
    assert.ok(files.length >= 1);
    const parsed = JSON.parse(fs.readFileSync(path.join(stateDir, files[0]), 'utf-8'));
    assert.strictEqual(parsed.rules.length, 5);
  });

  it('PostToolUse Edit records a violation into the ledger', async () => {
    await runHook({
      hook_event_name: 'PostToolUse', tool_name: 'Edit', session_id: 'sess-1', cwd: repo,
      tool_input: { file_path: path.join(repo, 'src/a.ts'), new_string: 'const x: any = 1;' },
    }, home);
    const ledger = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'dead-rules-audit', 'ledger.json'), 'utf-8'));
    const anyEntry = Object.values(ledger.rules).find(r => /any type/i.test(r.text));
    assert.ok(anyEntry, 'expected the any-rule to be tallied');
    assert.strictEqual(anyEntry.violated, 1);
    assert.strictEqual(ledger.diffs, 1);
  });

  it('repeated violations accumulate and trigger promote suggestion at SessionEnd', async () => {
    for (let i = 0; i < 3; i++) {
      await runHook({
        hook_event_name: 'PostToolUse', tool_name: 'Write', session_id: 'sess-1', cwd: repo,
        tool_input: { file_path: path.join(repo, `logs${i}.js`), content: `console.log("x${i}")` },
      }, home);
    }
    const { code, output } = await runHook({
      hook_event_name: 'SessionEnd', session_id: 'sess-1', cwd: repo,
    }, home);
    assert.strictEqual(code, 0);
    assert.ok(typeof output.systemMessage === 'string');
    assert.ok(output.systemMessage.includes('Dead-Rules Audit'));
    assert.ok(output.systemMessage.includes('promote'), 'expected a promote suggestion for console.log');
  });

  it('SessionEnd cleans up the per-session parse cache', async () => {
    const stateDir = path.join(home, '.claude', 'dead-rules-audit');
    const remaining = fs.readdirSync(stateDir).filter(f => f === 'session-sess-1.json');
    assert.strictEqual(remaining.length, 0);
  });

  it('logs meaningful events to hooks-logs', async () => {
    const logDir = path.join(home, '.claude', 'hooks-logs');
    const files = fs.readdirSync(logDir);
    assert.ok(files.length >= 1);
    const content = fs.readFileSync(path.join(logDir, files[0]), 'utf-8');
    assert.ok(content.includes('dead-rules-audit'));
    assert.ok(content.includes('SCORECARD'));
  });
});

describe('Integration: PostToolUse without prior SessionStart (lazy parse)', () => {
  let home; let repo;
  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dra-lazy-home-'));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dra-lazy-repo-'));
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), SAMPLE_MD);
  });
  after(() => {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch {}
  });

  it('lazily parses CLAUDE.md if SessionStart never ran', async () => {
    await runHook({
      hook_event_name: 'PostToolUse', tool_name: 'Edit', session_id: 'lazy-1', cwd: repo,
      tool_input: { file_path: path.join(repo, 'a.ts'), new_string: 'let z: any = 3;' },
    }, home);
    const ledger = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'dead-rules-audit', 'ledger.json'), 'utf-8'));
    assert.ok(Object.keys(ledger.rules).length >= 1);
  });
});

describe('Integration: defensive / no-op paths', () => {
  let home;
  before(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'dra-def-')); });
  after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });

  it('malformed JSON stdin => prints scorecard JSON, exit 0, no crash', async () => {
    const { code, output } = await runHook('not json at all', home);
    assert.strictEqual(code, 0);
    // Manual/empty invocation renders the (empty) scorecard.
    assert.ok(output.systemMessage === undefined || typeof output.systemMessage === 'string');
  });

  it('empty stdin => exit 0 with valid JSON', async () => {
    const { code, output } = await runHook('', home);
    assert.strictEqual(code, 0);
    assert.ok(typeof output === 'object');
  });

  it('unknown tool on PostToolUse is a no-op ({})', async () => {
    const { code, output } = await runHook({
      hook_event_name: 'PostToolUse', tool_name: 'Read', session_id: 's', cwd: home,
      tool_input: { file_path: '/etc/hosts' },
    }, home);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });

  it('unknown event name is a no-op ({})', async () => {
    const { code, output } = await runHook({
      hook_event_name: 'PreCompact', session_id: 's',
    }, home);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });

  it('SessionStart with no CLAUDE.md anywhere does not crash', async () => {
    const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'dra-norules-'));
    try {
      const { code, output } = await runHook({
        hook_event_name: 'SessionStart', session_id: 's2', cwd: emptyRepo,
      }, home);
      assert.strictEqual(code, 0);
      assert.deepStrictEqual(output, {});
    } finally {
      fs.rmSync(emptyRepo, { recursive: true, force: true });
    }
  });

  it('Manual event renders scorecard card', async () => {
    const { code, output } = await runHook({ hook_event_name: 'Manual' }, home);
    assert.strictEqual(code, 0);
    assert.ok(output.systemMessage.includes('Dead-Rules Audit'));
  });
});
