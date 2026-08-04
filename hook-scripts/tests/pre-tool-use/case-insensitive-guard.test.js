#!/usr/bin/env node
/**
 * Tests for case-insensitive-guard.js
 *
 * Run: node --test hook-scripts/tests/pre-tool-use/case-insensitive-guard.test.js
 * Or:  npm test
 *
 * Unit tests inject a fake filesystem, so collision logic runs deterministically
 * on every platform (Linux CI included). Integration tests that need a REAL
 * case-insensitive volume self-skip where the tmpdir is case-sensitive.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const {
  splitSegments,
  tokenize,
  stripHeredocs,
  analyzeCommand,
  checkCommand,
  LEVELS,
  ASK,
} = require('../../pre-tool-use/case-insensitive-guard.js');

const SCRIPT_PATH = path.join(__dirname, '../../pre-tool-use/case-insensitive-guard.js');

// ─────────────────────────────────────────────────────────────────────────────
// Fake filesystem builder. `dirs`: map of dir -> entries[]. `dirPaths`: set of
// paths that are directories (everything else present is a file). caseInsensitive
// controls whether pathExists folds case.
// ─────────────────────────────────────────────────────────────────────────────

function makeFsx(dirs, dirPaths, { caseInsensitive = true } = {}) {
  const fold = (p) => caseInsensitive ? p.toLowerCase() : p;
  const dirKey = Object.fromEntries(Object.keys(dirs).map(d => [fold(d), d]));
  const allPaths = new Set();
  for (const [d, entries] of Object.entries(dirs)) {
    allPaths.add(fold(d));
    for (const e of entries) allPaths.add(fold(path.join(d, e)));
  }
  const dirSet = new Set([...dirPaths].map(fold));
  return {
    listDir: (d) => dirs[dirKey[fold(d)]] ?? null,
    pathExists: (p) => allPaths.has(fold(p)),
    isDirectory: (p) => dirSet.has(fold(p)),
  };
}

// Case-INSENSITIVE /repo with dir 'content' and file 'notes.txt', plus /repo/src
// (empty dir) and /other (dir 'stuff'). Used by most unit tests.
function ciFsx() {
  return makeFsx(
    { '/repo': ['content', 'notes.txt', 'src'], '/repo/content': [], '/repo/src': [], '/other': ['stuff'], '/other/stuff': [] },
    ['/repo', '/repo/content', '/repo/src', '/other', '/other/stuff'],
    { caseInsensitive: true },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit: parsing helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: splitSegments()', () => {
  it('records the connector preceding each segment', () => {
    assert.deepStrictEqual(splitSegments('a && b; c || d | e'), [
      { text: 'a', connector: null },
      { text: 'b', connector: '&&' },
      { text: 'c', connector: ';' },
      { text: 'd', connector: '||' },
      { text: 'e', connector: '|' },
    ]);
  });
  it('ignores operators inside quotes', () => {
    assert.deepStrictEqual(splitSegments('echo "a && b" && c'), [
      { text: 'echo "a && b"', connector: null },
      { text: 'c', connector: '&&' },
    ]);
  });
  it('splits on newlines', () => {
    assert.deepStrictEqual(splitSegments('a\nb').map(s => s.text), ['a', 'b']);
  });
});

describe('Unit: tokenize()', () => {
  it('keeps quoted strings as one token and marks them quoted', () => {
    const t = tokenize('rm -rf "My Dir"');
    assert.strictEqual(t.length, 3);
    assert.strictEqual(t[2].text, 'My Dir');
    assert.strictEqual(t[2].quoted, true);
  });
  it('handles escaped spaces', () => {
    assert.strictEqual(tokenize('rm My\\ Dir')[1].text, 'My Dir');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: collision analysis on the fake case-insensitive volume
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: analyzeCommand() — catches (true positives)', () => {
  const fsx = ciFsx();
  const at = (cmd, cwd = '/repo') => analyzeCommand(cmd, cwd, fsx);

  it('plain rm -rf onto a case-variant dir (critical)', () => {
    const hit = at('rm -rf Content');
    assert.strictEqual(hit?.level, 'critical');
    assert.strictEqual(hit.actual, 'content');
  });
  it('the compound form that sank PR #8: cd dir && rm -rf X', () => {
    assert.strictEqual(analyzeCommand('cd /repo && rm -rf Content', '/', fsx)?.typed, 'Content');
  });
  it('rm flag/operand orderings', () => {
    assert.ok(at('rm Content -rf'));
    assert.ok(at('rm -r -f Content'));
    assert.ok(at('rm --recursive Content'));
  });
  it('trailing slash and subdir paths', () => {
    assert.ok(at('rm -rf Content/'));
    const fsx2 = makeFsx({ '/repo': ['src'], '/repo/src': ['content'], '/repo/src/content': [] }, ['/repo', '/repo/src', '/repo/src/content']);
    assert.ok(analyzeCommand('rm -rf src/Content', '/repo', fsx2));
  });
  it('rm behind sudo and env assignments', () => {
    assert.ok(at('sudo rm -rf Content'));
    assert.ok(at('FOO=1 rm -rf Content'));
  });
  it('multi-arg rm (collision not first)', () => {
    assert.strictEqual(at('rm -rf notes.txt Content')?.typed, 'Content');
  });
  it('quoted, ./-relative and absolute targets', () => {
    assert.ok(at('rm -rf "Content"'));
    assert.ok(at('rm -rf ./Content'));
    assert.ok(analyzeCommand('rm -rf /repo/Content', '/', fsx));
  });
  it('rm after a pipe', () => assert.ok(at('echo done | rm -rf Content')));
  it('rmdir onto a case-variant dir (finding #2)', () => {
    const empty = makeFsx({ '/repo': ['content'], '/repo/content': [] }, ['/repo', '/repo/content']);
    assert.strictEqual(analyzeCommand('rmdir Content', '/repo', empty)?.cmd, 'rmdir');
  });
  it('rm -d onto a case-variant dir', () => {
    const empty = makeFsx({ '/repo': ['content'], '/repo/content': [] }, ['/repo', '/repo/content']);
    assert.ok(analyzeCommand('rm -d Content', '/repo', empty));
  });
  it('non-recursive rm of a case-variant FILE (high)', () => {
    assert.strictEqual(at('rm Notes.txt')?.level, 'high');
  });
  it('mv overwriting a case-variant FILE (high)', () => {
    const hit = at('mv content/x.txt Notes.txt');
    assert.strictEqual(hit?.level, 'high');
  });
  it('mkdir/touch collisions (strict)', () => {
    assert.strictEqual(at('mkdir -p Content')?.level, 'strict');
    assert.strictEqual(at('touch Notes.txt')?.level, 'strict');
  });
  it('pushd changes dir like cd (finding #3/#8)', () => {
    const fsx2 = makeFsx({ '/repo': ['src'], '/repo/src': ['content'], '/repo/src/content': [] }, ['/repo', '/repo/src', '/repo/src/content']);
    assert.ok(analyzeCommand('pushd src && rm -rf Content', '/repo', fsx2));
  });
  it('find <path> -delete (finding #4)', () => {
    assert.strictEqual(at('find Content -delete')?.cmd, 'find -delete');
    assert.ok(at('find Content -type f -delete'));
    assert.ok(at('find Content -exec rm {} +'));
  });
  it('cd to a MISSING dir then ; rm runs in the original dir (finding #1)', () => {
    // cd nope fails → with ; the rm executes in /repo, which has content.
    assert.ok(analyzeCommand('cd nope ; rm -rf Content', '/repo', fsx));
    assert.ok(analyzeCommand('cd nope || rm -rf Content', '/repo', fsx));
  });
});

describe('Unit: analyzeCommand() — allows (true negatives)', () => {
  const fsx = ciFsx();
  const at = (cmd, cwd = '/repo') => analyzeCommand(cmd, cwd, fsx);

  it('exact-case deletes (intentional)', () => {
    assert.strictEqual(at('rm -rf content'), null);
    assert.strictEqual(at('rm notes.txt'), null);
  });
  it('glob targets (shell glob matching is case-sensitive)', () => {
    assert.strictEqual(at('rm -rf Cont*'), null);
  });
  it('unresolvable targets: $VAR, $( ), backticks', () => {
    assert.strictEqual(at('rm -rf $DIR/Content'), null);
    assert.strictEqual(at('rm -rf $(pwd)/Content'), null);
    assert.strictEqual(at('rm -rf `pwd`/Content'), null);
  });
  it('relative targets when cwd is unknown', () => {
    assert.strictEqual(analyzeCommand('rm -rf Content', undefined, fsx), null);
    assert.strictEqual(analyzeCommand('cd $X && rm -rf Content', '/repo', fsx), null);
  });
  it('still checks absolute targets when cwd is unknown', () => {
    assert.ok(analyzeCommand('rm -rf /repo/Content', undefined, fsx));
  });
  it('cd AWAY from the collision dir via && (no false positive)', () => {
    assert.strictEqual(analyzeCommand('cd /other && rm -rf Content', '/repo', fsx), null);
  });
  it('mv INTO a case-variant directory (contents preserved)', () => {
    assert.strictEqual(at('mv notes.txt Content'), null);
  });
  it('case-only self-rename is the canonical fix (finding #5/#7)', () => {
    const one = makeFsx({ '/repo': ['notes.txt'] }, ['/repo']);
    assert.strictEqual(analyzeCommand('mv notes.txt Notes.txt', '/repo', one), null);
    assert.strictEqual(analyzeCommand('mv notes.txt NOTES.TXT', '/repo', one), null);
  });
  it('plain rm of a case-variant DIRECTORY is a no-op → allowed (finding #6)', () => {
    assert.strictEqual(at('rm Content'), null);
    assert.strictEqual(at('rm -f Content'), null);
  });
  it('subshell ( cd sub && rm ) is scoped correctly (finding #9)', () => {
    // src has no 'content', so this is harmless and must NOT be blocked.
    assert.strictEqual(analyzeCommand('( cd src && rm -rf Content )', '/repo', fsx), null);
  });
  it('find without a delete predicate', () => {
    assert.strictEqual(at('find Content -type f'), null);
  });
  it('unrelated safe commands', () => {
    for (const cmd of ['ls -la', 'git status', 'npm test', 'echo Content', 'cat notes.txt', 'grep -r Content .']) {
      assert.strictEqual(at(cmd), null, cmd);
    }
  });
});

describe('Unit: analyzeCommand() on a case-SENSITIVE volume', () => {
  it('never blocks — the miscased command fails harmlessly on its own', () => {
    const fsx = makeFsx({ '/repo': ['content', 'notes.txt'], '/repo/content': [] }, ['/repo', '/repo/content'], { caseInsensitive: false });
    assert.strictEqual(analyzeCommand('rm -rf Content', '/repo', fsx), null);
    assert.strictEqual(analyzeCommand('mkdir -p Content', '/repo', fsx), null);
    assert.strictEqual(analyzeCommand('rmdir Content', '/repo', fsx), null);
  });
});

describe('Unit: checkCommand() level gating', () => {
  const fsx = ciFsx();
  it('critical level only blocks recursive rm / find -delete', () => {
    assert.strictEqual(checkCommand('rm -rf Content', '/repo', 'critical', fsx).blocked, true);
    assert.strictEqual(checkCommand('rm Notes.txt', '/repo', 'critical', fsx).blocked, false);
    assert.strictEqual(checkCommand('mkdir Content', '/repo', 'critical', fsx).blocked, false);
  });
  it('high level blocks non-recursive file deletes and mv, not mkdir', () => {
    assert.strictEqual(checkCommand('rm Notes.txt', '/repo', 'high', fsx).blocked, true);
    assert.strictEqual(checkCommand('mkdir -p Content', '/repo', 'high', fsx).blocked, false);
  });
  it('strict level blocks mkdir/touch collisions too', () => {
    assert.strictEqual(checkCommand('mkdir -p Content', '/repo', 'strict', fsx).blocked, true);
  });
});

describe('Config: structure', () => {
  it('LEVELS are ordered', () => {
    assert.strictEqual(LEVELS.critical, 1);
    assert.strictEqual(LEVELS.high, 2);
    assert.strictEqual(LEVELS.strict, 3);
  });
  it('ASK has boolean values for each level', () => {
    for (const level of ['critical', 'high', 'strict']) assert.strictEqual(typeof ASK[level], 'boolean');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: real subprocess, real filesystem
// ─────────────────────────────────────────────────────────────────────────────

const TEST_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cig-home-')));

function runHook(hookData, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, HOME: TEST_HOME, ...envOverrides };
    for (const key of Object.keys(env)) {
      if (key.startsWith('HOOK_ASK_') && !(key in envOverrides)) delete env[key];
    }
    const child = spawn('node', [SCRIPT_PATH], { env });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', (code) => {
      try { resolve({ code, output: JSON.parse(stdout.trim() || '{}') }); }
      catch { reject(new Error(`Failed to parse output: ${stdout}`)); }
    });
    child.stdin.write(typeof hookData === 'string' ? hookData : JSON.stringify(hookData));
    child.stdin.end();
  });
}

const bash = (command, cwd) => ({ tool_name: 'Bash', tool_input: { command }, cwd, session_id: 'test', permission_mode: 'default' });

describe('Integration: defensive stdin', () => {
  it('garbage stdin yields {} exit 0', async () => {
    const { code, output } = await runHook('not json{{');
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });
  it('empty stdin yields {} exit 0', async () => {
    const { code, output } = await runHook('');
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });
  it('null payload yields {} exit 0', async () => {
    const { code, output } = await runHook('null');
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });
  it('non-Bash tools pass through', async () => {
    const { output } = await runHook({ tool_name: 'Read', tool_input: { file_path: '/x' } });
    assert.deepStrictEqual(output, {});
  });
  it('safe commands pass through', async () => {
    assert.deepStrictEqual((await runHook(bash('ls -la', '/tmp'))).output, {});
  });
});

// Does this machine's tmpdir fold case? (macOS APFS: yes; Linux CI ext4: no)
const TMP_IS_CASE_INSENSITIVE = (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cig-probe-'));
  try {
    fs.writeFileSync(path.join(d, 'casetest'), '');
    return fs.existsSync(path.join(d, 'CASETEST'));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
})();

describe('Integration: real collisions', { skip: !TMP_IS_CASE_INSENSITIVE && 'tmpdir is case-sensitive' }, () => {
  function withRepo(fn) {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cig-repo-')));
    fs.mkdirSync(path.join(d, 'content'));
    fs.writeFileSync(path.join(d, 'notes.txt'), 'x');
    return Promise.resolve(fn(d)).finally(() => fs.rmSync(d, { recursive: true, force: true }));
  }
  const deny = (o) => o.hookSpecificOutput?.permissionDecision;

  it('denies rm -rf onto a case-variant, both names in the reason', () =>
    withRepo(async (d) => {
      const { output } = await runHook(bash('rm -rf Content', d));
      assert.strictEqual(deny(output), 'deny');
      assert.match(output.hookSpecificOutput?.permissionDecisionReason ?? '', /\[case-collision\].*'Content'.*'content'/);
    }));
  it('denies the compound cd && rm form (PR #8 bypass)', () =>
    withRepo(async (d) => {
      assert.strictEqual(deny((await runHook(bash(`cd ${d} && rm -rf Content`, '/'))).output), 'deny');
    }));
  it('denies cd <missing> ; rm (the runs-in-original-dir bypass)', () =>
    withRepo(async (d) => {
      assert.strictEqual(deny((await runHook(bash('cd nope ; rm -rf Content', d))).output), 'deny');
    }));
  it('allows mkdir -p onto a case-variant (PR #8 false positive)', () =>
    withRepo(async (d) => {
      assert.deepStrictEqual((await runHook(bash('mkdir -p Content', d))).output, {});
    }));
  it('allows a case-only file rename', () =>
    withRepo(async (d) => {
      assert.deepStrictEqual((await runHook(bash('mv notes.txt Notes.txt', d))).output, {});
    }));
  it('allows exact-case rm', () =>
    withRepo(async (d) => {
      assert.deepStrictEqual((await runHook(bash('rm -rf content', d))).output, {});
    }));
  it('returns "ask" for a critical collision when HOOK_ASK_CRITICAL=true', () =>
    withRepo(async (d) => {
      const { output } = await runHook(bash('rm -rf Content', d), { HOOK_ASK_CRITICAL: 'true' });
      assert.strictEqual(deny(output), 'ask');
    }));
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: round-2 hardening — shell-state model (background &, subshells,
// pushd/popd stack, exit-status gating, heredocs, mv -t, quoted ~)
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: round-2 hardening — bypasses closed', () => {
  it('analyzes commands after a background & separator', () => {
    const hit = analyzeCommand('sleep 1 & rm -rf CONTENT', '/repo', ciFsx());
    assert.strictEqual(hit?.level, 'critical');
  });
  it('does not treat >&/2>&1 redirects as separators', () => {
    const hit = analyzeCommand('rm -rf CONTENT 2>&1', '/repo', ciFsx());
    assert.strictEqual(hit?.level, 'critical');
  });
  it('restores the pushd directory after popd', () => {
    const hit = analyzeCommand('pushd src; touch a.txt; popd; rm -rf CONTENT', '/repo', ciFsx());
    assert.strictEqual(hit?.level, 'critical');
  });
  it('keeps tracking through a failed-cd && chain followed by ;', () => {
    const hit = analyzeCommand('cd missing && cd src; rm -rf CONTENT', '/repo', ciFsx());
    assert.strictEqual(hit?.level, 'critical');
  });
  it('tracks cd into a directory mkdir creates on the same line', () => {
    const hit = analyzeCommand('mkdir build && cd build && rm -rf ../CONTENT', '/repo', ciFsx());
    assert.strictEqual(hit?.level, 'critical');
  });
  it('a cd inside ( … ) does not leak past the closing paren', () => {
    const hit = analyzeCommand('( cd src ); rm -rf CONTENT', '/repo', ciFsx());
    assert.strictEqual(hit?.level, 'critical');
  });
  it('handles unspaced subshell parens', () => {
    const hit = analyzeCommand('(cd src && ls); rm -rf CONTENT', '/repo', ciFsx());
    assert.strictEqual(hit?.level, 'critical');
  });
  it('a cd in a pipeline does not move the parent shell', () => {
    const hit = analyzeCommand('cd src | cat; rm -rf CONTENT', '/repo', ciFsx());
    assert.strictEqual(hit?.level, 'critical');
  });
  it('peels wrapper prefixes: nohup … &', () => {
    const hit = analyzeCommand('nohup rm -rf CONTENT &', '/repo', ciFsx());
    assert.strictEqual(hit?.level, 'critical');
  });
  it('peels wrapper prefixes: exec', () => {
    const hit = analyzeCommand('exec rm -rf CONTENT', '/repo', ciFsx());
    assert.strictEqual(hit?.level, 'critical');
  });
  it('! negation makes the gate uncertain, so the follow-up is still checked', () => {
    const hit = analyzeCommand('! cd missing && rm -rf CONTENT', '/repo', ciFsx());
    assert.strictEqual(hit?.level, 'critical');
  });
  it('a live command after a heredoc is still analyzed', () => {
    const hit = analyzeCommand('cat <<EOF\nhello\nEOF\nrm -rf CONTENT', '/repo', ciFsx());
    assert.strictEqual(hit?.level, 'critical');
  });
  it('numeric << is arithmetic, not a heredoc — following lines stay live', () => {
    const hit = analyzeCommand('echo $((1<<2))\nrm -rf CONTENT', '/repo', ciFsx());
    assert.strictEqual(hit?.level, 'critical');
  });
});

describe('Unit: round-2 hardening — false positives removed', () => {
  it('mv -t DIR treats operands as sources, not a destination', () => {
    assert.strictEqual(analyzeCommand('mv -t src Notes.txt', '/repo', ciFsx()), null);
  });
  it('mv --target-directory=DIR is a move into a directory', () => {
    assert.strictEqual(analyzeCommand('mv --target-directory=src Notes.txt', '/repo', ciFsx()), null);
  });
  it('heredoc bodies are document text, not commands', () => {
    assert.strictEqual(analyzeCommand('cat <<EOF > out.txt\nrm -rf CONTENT\nEOF', '/repo', ciFsx()), null);
  });
  it('quoted heredoc delimiters work too', () => {
    assert.strictEqual(analyzeCommand("cat <<'DOC'\nrm -rf CONTENT\nDOC", '/repo', ciFsx()), null);
  });
  it('a quoted ~ is a literal path, not the home directory', () => {
    assert.strictEqual(analyzeCommand("rm -rf '~/CONTENT'", '/repo', ciFsx()), null);
  });
});

describe('Unit: stripHeredocs()', () => {
  it('removes the body but keeps commands after the terminator', () => {
    const out = stripHeredocs('cat <<EOF\nrm -rf x\nEOF\necho done');
    assert.ok(!out.includes('rm -rf x'));
    assert.ok(out.includes('echo done'));
  });
  it('handles <<- with tab-indented terminators', () => {
    const out = stripHeredocs('cat <<-END\nrm -rf x\n\tEND\necho after');
    assert.ok(!out.includes('rm -rf x'));
    assert.ok(out.includes('echo after'));
  });
  it('queues multiple heredocs on one line in order', () => {
    const out = stripHeredocs('diff <(cat) - <<A <<B\nbody a\nA\nbody b\nB\necho tail');
    assert.ok(!out.includes('body a') && !out.includes('body b'));
    assert.ok(out.includes('echo tail'));
  });
  it('leaves <<< here-strings and quoted << alone', () => {
    assert.ok(stripHeredocs('grep x <<< "input"').includes('<<<'));
    assert.ok(stripHeredocs('echo "a << b"').includes('a << b'));
  });
});
