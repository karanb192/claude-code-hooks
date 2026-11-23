#!/usr/bin/env node
/**
 * Tests for case-insensitive-guard.js
 *
 * Run: node --test plugins/case-insensitive-guard/tests/case-insensitive-guard.test.js
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
  preprocess,
  analyzeCommand,
  checkCommand,
  LEVELS,
  ASK,
} = require('../case-insensitive-guard.js');

const SCRIPT_PATH = path.join(__dirname, '../case-insensitive-guard.js');

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

describe('Unit: analyzeCommand(): catches (true positives)', () => {
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

describe('Unit: analyzeCommand(): allows (true negatives)', () => {
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
  it('never blocks: the miscased command fails harmlessly on its own', () => {
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

describe('Config: HOOK_SAFETY_LEVEL env override', () => {
  // The level is read at module load, so each case spawns a fresh process.
  function exportedLevel(envOverrides) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, ...envOverrides };
      if (!('HOOK_SAFETY_LEVEL' in envOverrides)) delete env.HOOK_SAFETY_LEVEL;
      const child = spawn('node', ['-p', `require(${JSON.stringify(SCRIPT_PATH)}).SAFETY_LEVEL`], { env });
      let stdout = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.on('error', reject);
      child.on('close', () => resolve(stdout.trim()));
    });
  }
  it('defaults to high when the env var is unset', async () => {
    assert.strictEqual(await exportedLevel({}), 'high');
  });
  it('respects a valid override', async () => {
    assert.strictEqual(await exportedLevel({ HOOK_SAFETY_LEVEL: 'strict' }), 'strict');
    assert.strictEqual(await exportedLevel({ HOOK_SAFETY_LEVEL: 'critical' }), 'critical');
    assert.strictEqual(await exportedLevel({ HOOK_SAFETY_LEVEL: 'high' }), 'high');
  });
  it('falls back to the default on an invalid value', async () => {
    assert.strictEqual(await exportedLevel({ HOOK_SAFETY_LEVEL: 'paranoid' }), 'high');
    assert.strictEqual(await exportedLevel({ HOOK_SAFETY_LEVEL: 'HIGH' }), 'high');
    assert.strictEqual(await exportedLevel({ HOOK_SAFETY_LEVEL: '' }), 'high');
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
      if ((key.startsWith('HOOK_ASK_') || key === 'HOOK_SAFETY_LEVEL') && !(key in envOverrides)) delete env[key];
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
  it('HOOK_SAFETY_LEVEL=strict denies a mkdir collision the default allows', () =>
    withRepo(async (d) => {
      assert.deepStrictEqual((await runHook(bash('mkdir -p Content', d))).output, {});
      assert.strictEqual(deny((await runHook(bash('mkdir -p Content', d), { HOOK_SAFETY_LEVEL: 'strict' })).output), 'deny');
    }));
  it('HOOK_SAFETY_LEVEL=critical allows a high-level file delete the default denies', () =>
    withRepo(async (d) => {
      assert.strictEqual(deny((await runHook(bash('rm Notes.txt', d))).output), 'deny');
      assert.deepStrictEqual((await runHook(bash('rm Notes.txt', d), { HOOK_SAFETY_LEVEL: 'critical' })).output, {});
    }));
  it('an invalid HOOK_SAFETY_LEVEL behaves exactly like the default (high)', () =>
    withRepo(async (d) => {
      assert.strictEqual(deny((await runHook(bash('rm -rf Content', d), { HOOK_SAFETY_LEVEL: 'bogus' })).output), 'deny');
      assert.deepStrictEqual((await runHook(bash('mkdir -p Content', d), { HOOK_SAFETY_LEVEL: 'bogus' })).output, {});
    }));
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: round-2 hardening: shell-state model (background &, subshells,
// pushd/popd stack, exit-status gating, heredocs, mv -t, quoted ~)
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: round-2 hardening: bypasses closed', () => {
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
  it('numeric << is arithmetic, not a heredoc: following lines stay live', () => {
    const hit = analyzeCommand('echo $((1<<2))\nrm -rf CONTENT', '/repo', ciFsx());
    assert.strictEqual(hit?.level, 'critical');
  });
});

describe('Unit: round-2 hardening: false positives removed', () => {
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

describe('Unit: preprocess()', () => {
  it('removes the body but keeps commands after the terminator', () => {
    const out = preprocess('cat <<EOF\nrm -rf x\nEOF\necho done');
    assert.ok(!out.includes('rm -rf x'));
    assert.ok(out.includes('echo done'));
  });
  it('handles <<- with tab-indented terminators', () => {
    const out = preprocess('cat <<-END\nrm -rf x\n\tEND\necho after');
    assert.ok(!out.includes('rm -rf x'));
    assert.ok(out.includes('echo after'));
  });
  it('queues multiple heredocs on one line in order', () => {
    const out = preprocess('diff <(cat) - <<A <<B\nbody a\nA\nbody b\nB\necho tail');
    assert.ok(!out.includes('body a') && !out.includes('body b'));
    assert.ok(out.includes('echo tail'));
  });
  it('leaves <<< here-strings and quoted << alone', () => {
    assert.ok(preprocess('grep x <<< "input"').includes('<<<'));
    assert.ok(preprocess('echo "a << b"').includes('a << b'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression: recorded inputs that used to pass. The layout has `Content`
// (holding keep.txt and sub/f.txt), `build` and README.md; every command types
// `content`. Each group also lists the form that was already blocked.
// ─────────────────────────────────────────────────────────────────────────────

const CASEFS_GROUPS = {
  'a miscased parent directory, not just the last component': ["rm -rf content/sub","rm content/keep.txt","cd content && rm -rf sub","rmdir content/sub","find content/sub -delete","rm -rf content"],
  'wrapper options that take a value': ["sudo -u root rm -rf content","sudo -E -u root rm -rf content","env -u DEBUG rm -rf content","exec -a x rm -rf content","sudo A=1 rm -rf content","sudo -n rm -rf content"],
  'more wrappers: timeout, nice, doas, stdbuf, xargs fed by echo': ["timeout 30 rm -rf content","nice -n 5 rm -rf content","doas rm -rf content","stdbuf -o0 rm -rf content","echo content | xargs rm -rf","nohup rm -rf content"],
  'comments, escaped quotes, arithmetic and spaced heredoc delimiters': ["# don't keep the old output\nrm -rf content","echo cleaning # it's stale\nrm -rf content","echo it\\'s gone; rm -rf content","echo $((1<<n))\nrm -rf content","cat <<\"E OF\"\nhi\nE OF\nrm -rf content","# do not keep the old output\nrm -rf content"],
  'line continuations, brace expansion and glued redirects': ["rm -rf \\\n  content","rm \\\n -rf content","rm -rf {content,build}","rm -rf content{,-old}","rm -rf content>/dev/null","rm -rf content \\\n  build"],
  'a literal target beside a command substitution': ["rm -rf content build-$(date +%F)","rm -rf content \"$(mktemp -d)\"","rm -rf content `cat old.txt`","rm -rf content build-$STAMP"],
  'find options before the paths, -exec by full path, find piped to xargs rm': ["find -L content -delete","find -H content -delete","find content -exec /bin/rm -rf {} +","find content -type f | xargs rm","find content -delete"],
};

function casefsFsx(root = '/casefs') {
  return makeFsx(
    { [root]: ['build', 'Content', 'README.md'], [`${root}/Content`]: ['keep.txt', 'sub'], [`${root}/Content/sub`]: ['f.txt'], [`${root}/build`]: [] },
    [root, `${root}/Content`, `${root}/Content/sub`, `${root}/build`],
  );
}

describe('Unit: recorded case-collision inputs are denied at the default level', () => {
  const fsx = casefsFsx();
  for (const [group, commands] of Object.entries(CASEFS_GROUPS)) {
    it(group, () => {
      for (const cmd of commands) {
        const r = checkCommand(cmd, '/casefs', 'high', fsx);
        assert.strictEqual(r.blocked, true, JSON.stringify(cmd));
        assert.strictEqual(r.hit.actual, 'Content', JSON.stringify(cmd));
      }
    });
  }
});

describe('Unit: the same shapes with the exact case still pass', () => {
  const fsx = casefsFsx();
  const at = (cmd, cwd = '/casefs') => analyzeCommand(cmd, cwd, fsx);
  it('exact-case forms of the recorded inputs', () => {
    for (const cmd of [
      'rm -rf Content/sub', 'rm Content/keep.txt', 'cd Content && rm -rf sub', 'find Content/sub -delete',
      'sudo -u root rm -rf Content', 'env -u DEBUG rm -rf Content', 'timeout 30 rm -rf Content', 'echo Content | xargs rm -rf',
      "# don't keep the old output\nrm -rf Content", 'rm -rf \\\n  Content', 'rm -rf {Content,build}', 'rm -rf Content>/dev/null',
      'rm -rf Content build-$(date +%F)', 'find -L Content -delete', 'find Content -type f | xargs rm',
    ]) assert.strictEqual(at(cmd), null, JSON.stringify(cmd));
  });
  it('a session cwd spelled in another case is trusted, not flagged', () => {
    assert.strictEqual(at('rm -rf sub', '/casefs/content'), null);
    assert.strictEqual(at('rm -rf ../build', '/casefs/content'), null);
  });
  it('a miscased name in a comment or quoted text is not a target', () => {
    assert.strictEqual(at('rm -rf build # not content'), null);
    assert.strictEqual(at('echo "rm -rf content"'), null);
    assert.strictEqual(at('echo content'), null);
  });
  it('env -C and sudo -D run the command in that directory', () => {
    assert.strictEqual(at('env -C build rm -rf content'), null);
    assert.ok(at('env -C /casefs rm -rf content', '/elsewhere'));
    assert.ok(at('sudo -D /casefs rm -rf content', '/elsewhere'));
  });
});

describe('Unit: parsing details behind the recorded inputs', () => {
  const fsx = casefsFsx();
  const at = (cmd) => analyzeCommand(cmd, '/casefs', fsx);
  it('# inside a word is not a comment', () => {
    assert.ok(at('echo x\\ #; rm -rf content'));
    assert.ok(at('echo a#b; rm -rf content'));
  });
  it('xargs -I substitutes the piped words', () => {
    assert.ok(at('echo content | xargs -I{} rm -rf {}'));
    assert.ok(at('echo content | xargs -I X rm -rf X'));
  });
  it('an operator inside $( ) does not split the segment', () => {
    assert.ok(at('rm -rf content $(cd /tmp; pwd)'));
  });
  it('cd into a command substitution keeps checking the current directory', () => {
    assert.ok(at('cd "$(git rev-parse --show-toplevel)" && rm -rf content'));
  });
  it('tokenize drops redirect operators and their targets', () => {
    assert.deepStrictEqual(tokenize('rm -rf x>/dev/null 2>&1').map(t => t.text), ['rm', '-rf', 'x']);
  });
  it('tokenize expands unquoted brace lists only', () => {
    assert.deepStrictEqual(tokenize('rm a{,-old} "b{c,d}" {}').map(t => t.text), ['rm', 'a', 'a-old', 'b{c,d}', '{}']);
  });
  it('preprocess joins continuations and drops comments', () => {
    assert.strictEqual(preprocess('rm \\\n -rf x # gone'), 'rm  -rf x ');
  });
});

describe('Integration: recorded inputs on a real case-insensitive folder', { skip: !TMP_IS_CASE_INSENSITIVE && 'tmpdir is case-sensitive' }, () => {
  let dir;
  const setup = () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cig-casefs-')));
    fs.mkdirSync(path.join(dir, 'Content', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'build'));
    fs.writeFileSync(path.join(dir, 'Content', 'keep.txt'), '');
    fs.writeFileSync(path.join(dir, 'Content', 'sub', 'f.txt'), '');
    fs.writeFileSync(path.join(dir, 'README.md'), '');
  };
  const { before, after } = require('node:test');
  before(setup);
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [group, commands] of Object.entries(CASEFS_GROUPS)) {
    it(group, async () => {
      for (const cmd of commands) {
        const { output } = await runHook(bash(cmd, dir));
        assert.strictEqual(output.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(cmd));
      }
      assert.ok(fs.existsSync(path.join(dir, 'Content', 'sub', 'f.txt')), 'the hook must never touch the folder');
    });
  }
});
