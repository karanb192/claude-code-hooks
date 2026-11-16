#!/usr/bin/env node
/**
 * Tests for guard-pack under Codex CLI (--host codex) and for lib/host.js.
 *
 * Fixtures in fixtures/codex-0.167.1/ keep the field shape Codex CLI 0.167.1
 * sent to a PreToolUse hook; paths, ids and the model name are placeholders.
 * __CWD__ is replaced with a temp directory at run time.
 *
 * Run: node --test plugins/guard-pack/tests/codex.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PACK_DIR = path.join(__dirname, '..');
const SCRIPT_PATH = path.join(PACK_DIR, 'guard-pack.js');
const FIXTURES = path.join(__dirname, 'fixtures', 'codex-0.167.1');
const host = require(path.join(PACK_DIR, 'lib', 'host.js'));

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-pack-codex-home-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-pack-codex-work-'));
before(() => {
  fs.mkdirSync(path.join(WORK, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(WORK, 'sum.js'), 'function sum(a,b){return a+b}\nmodule.exports={sum}\n');
  fs.writeFileSync(path.join(WORK, 'tests', 'sum.test.js'), "test('adds',()=>{a.strictEqual(sum(2,3),5)});\n");
  fs.writeFileSync(path.join(WORK, '.env'), 'DB_PASSWORD=placeholder\n');
  fs.writeFileSync(path.join(WORK, 'notes.txt'), 'hi\n');
});
after(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
  fs.rmSync(WORK, { recursive: true, force: true });
});

function fixture(name) {
  const text = fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8').split('__CWD__').join(WORK.replace(/\\/g, '/'));
  return JSON.parse(text);
}

function run(payload, { args = ['--host', 'codex'], env: extra = {} } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, HOME: TMP_HOME, USERPROFILE: TMP_HOME, ...extra };
    for (const key of Object.keys(env)) {
      if ((key.startsWith('HOOK_ASK_') || key.startsWith('HOOK_SAFETY') || key.startsWith('CONFIG_GUARD_') || key.startsWith('SPAWN_CAP_')) && !(key in extra)) delete env[key];
    }
    const child = spawn(process.execPath, [SCRIPT_PATH, ...args], { env, cwd: WORK });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

async function expectBlock(name, id, opts) {
  const r = await run(fixture(name), opts);
  assert.strictEqual(r.code, 2, `${name}: exit ${r.code}, stderr ${r.stderr}`);
  assert.strictEqual(r.stdout, '', `${name}: Codex reads stdout on exit 2 as nothing, keep it empty`);
  assert.ok(r.stderr.includes(`[${id}]`), `${name}: expected [${id}] in ${r.stderr}`);
  assert.ok(r.stderr.trim().length > 0);
  return r;
}

async function expectAllow(name, opts) {
  const r = await run(fixture(name), opts);
  assert.strictEqual(r.code, 0, `${name}: exit ${r.code}, stderr ${r.stderr}`);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(r.stderr, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Recorded Codex payloads through the real script
// ─────────────────────────────────────────────────────────────────────────────

describe('Codex: shell commands', () => {
  it('blocks chmod 777', () => expectBlock('bash-chmod-777', 'chmod-777'));
  it('blocks reading .env', () => expectBlock('bash-cat-env', 'cat-env'));
  it('blocks deleting a test file', () => expectBlock('bash-rm-test', 'delete-test'));
  it('blocks git reset --hard', () => expectBlock('bash-git-reset-hard', 'git-reset-hard'));
  it('allows an ordinary read', () => expectAllow('bash-read-source'));
  it('checks a patch run through the shell', () => expectBlock('bash-embedded-patch', 'skip-test'));
});

describe('Codex: apply_patch edits', () => {
  it('blocks turning a test into test.skip', () => expectBlock('patch-update-test-skip', 'skip-test'));
  it('blocks creating .env.production', () => expectBlock('patch-add-env-production', 'env-file'));
  it('blocks deleting a test file', () => expectBlock('patch-delete-test', 'delete-test'));
  it('blocks renaming a test to a disabled name', async () => {
    // With absolute paths protect-tests sees the move as removing the suite's only test file.
    const r = await run(fixture('patch-move-test-disabled'));
    assert.strictEqual(r.code, 2);
    assert.match(r.stderr, /\[(rename-test|delete-test)\]/);
  });
  it('blocks writing a hooks.json', () => expectBlock('patch-add-codex-hooks', 'hooks-manifest'));
  it('blocks a patch when any one of its files is blocked', () => expectBlock('patch-two-files-one-bad', 'env-file'));
  it('allows an ordinary source edit', () => expectAllow('patch-update-source'));
  it('blocks a patch it cannot read, instead of letting it through', () => expectBlock('patch-unreadable', 'unreadable-patch'));
});

describe('Codex: answers', () => {
  it('sends an ask verdict as a block that says Codex cannot ask', async () => {
    const r = await expectBlock('bash-chmod-777', 'chmod-777', { env: { HOOK_ASK_HIGH: 'true' } });
    assert.ok(r.stderr.includes('Codex hooks cannot ask'), r.stderr);
  });

  it('has no opinion on a tool it does not check', () => expectAllow('mcp-tool'));

  it('lets the tool run on input it cannot parse, as on Claude Code', async () => {
    const r = await run('not json');
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.stdout, '');
  });

  it('logs the host and the lowered tool', async () => {
    await run(fixture('patch-add-env-production'));
    const dir = path.join(TMP_HOME, '.claude', 'hooks-logs');
    const lines = fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    const hit = lines.find((l) => l.host === 'codex' && l.id === 'env-file');
    assert.ok(hit, JSON.stringify(lines.slice(-3)));
    assert.strictEqual(hit.tool, 'apply_patch');
    assert.strictEqual(hit.checked, 'Write');
  });

  it('keeps the Claude Code answer unchanged without --host', async () => {
    const r = await run(fixture('bash-chmod-777'), { args: [] });
    assert.strictEqual(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes('[chmod-777]'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// lib/host.js
// ─────────────────────────────────────────────────────────────────────────────

describe('host.parsePatch()', () => {
  const p = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');

  it('reads add, update and delete hunks', () => {
    const r = host.parsePatch(p('*** Add File: a.txt', '+one', '+two', '*** Update File: b.js', '@@ fn', ' keep', '-old', '+new', '*** Delete File: c.js'));
    assert.deepStrictEqual(r, { ok: true, ops: [
      { kind: 'add', path: 'a.txt', added: ['one', 'two'], removed: [] },
      { kind: 'update', path: 'b.js', added: ['new'], removed: ['old'] },
      { kind: 'delete', path: 'c.js', added: [], removed: [] },
    ] });
  });

  it('reads a move', () => {
    const r = host.parsePatch(p('*** Update File: a.js', '*** Move to: b.js', '@@', '-x', '+y'));
    assert.strictEqual(r.ops[0].moveTo, 'b.js');
  });

  it('tolerates whitespace around markers, End of File and Environment ID lines', () => {
    const r = host.parsePatch('  *** Begin Patch  \n*** Environment ID: local\n*** Update File: a.js\n@@\n-x\n+y\n*** End of File\n  *** End Patch\n');
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.ops[0].added, ['y']);
  });

  it('accepts the heredoc wrapper Codex accepts', () => {
    assert.strictEqual(host.parsePatch(`<<'EOF'\n${p('*** Delete File: a.js')}\nEOF\n`).ok, true);
  });

  it('refuses text it cannot read in full', () => {
    assert.strictEqual(host.parsePatch('just text').ok, false);
    assert.strictEqual(host.parsePatch(p('*** Rename File: a.js')).ok, false);
    assert.strictEqual(host.parsePatch(p()).ok, false);
    assert.strictEqual(host.parsePatch('*** Begin Patch\n*** Add File: a\n+x').ok, false);
    assert.strictEqual(host.parsePatch(p('*** Move to: b.js')).ok, false);
    assert.strictEqual(host.parsePatch(p('*** Update File: a.js', '*** Move to: b.js')).ok, false, 'Codex rejects an update with no change lines');
    assert.strictEqual(host.parsePatch(p('*** Update File: a.js', '@@')).ok, false, 'Codex rejects an empty chunk');
    assert.strictEqual(host.parsePatch(`${p('*** Delete File: a')}\nmore`).ok, false, 'End Patch must be the last line');
    assert.strictEqual(host.parsePatch(p('stray line', '*** Add File: a', '+x')).ok, false);
    assert.strictEqual(host.parsePatch(undefined).ok, false);
  });
});

describe('host.parsePatch() splits lines the way Codex does', () => {
  const p = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');
  const paths = (r) => r.ops.map((o) => o.path);

  it('sees a header that starts with U+0085, which Codex trims', () => {
    assert.deepStrictEqual(paths(host.parsePatch(p('*** Add File: notes.md', '+hi', '\u0085*** Add File: .env.production', '+K=1'))), ['notes.md', '.env.production']);
  });

  it('treats a space-prefixed End Patch inside an update as context, as Codex does', () => {
    assert.deepStrictEqual(paths(host.parsePatch(p('*** Update File: a.js', '@@', ' *** End Patch', '*** Add File: .env', '+x'))), ['a.js', '.env']);
  });

  it('treats a space-prefixed header inside an update as context', () => {
    const r = host.parsePatch(p('*** Update File: a.js', '@@', ' *** Update File: b.js', '-x', '+y'));
    assert.deepStrictEqual(paths(r), ['a.js']);
    assert.deepStrictEqual(r.ops[0].added, ['y']);
  });

  it('allows a blank line after End of File but nothing else except a new chunk', () => {
    assert.strictEqual(host.parsePatch(p('*** Update File: a', '@@', '-x', '+y', '*** End of File', '', '@@', '-z', '+w')).ok, true);
    assert.strictEqual(host.parsePatch(p('*** Update File: a', '@@', '-x', '*** End of File', '+late')).ok, false);
  });
});

describe('host.codexCalls()', () => {
  it('passes a plain shell command through', () => {
    assert.deepStrictEqual(host.codexCalls({ tool_name: 'Bash', tool_input: { command: 'ls' } }), [{ tool: 'Bash', input: { command: 'ls' } }]);
  });

  it('turns each file in a patch into a Claude-shaped call', () => {
    const calls = host.codexCalls({ tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: a\n+x\n*** Update File: b\n*** Move to: c\n-y\n+z\n*** Delete File: d\n*** End Patch' } });
    assert.deepStrictEqual(calls, [
      { tool: 'Write', input: { file_path: 'a', content: 'x' } },
      { tool: 'Edit', input: { file_path: 'b', old_string: 'y', new_string: 'z' } },
      { tool: 'Bash', input: { command: "mv -- 'b' 'c'" } },
      { tool: 'Write', input: { file_path: 'c', content: 'z' } },
      { tool: 'Bash', input: { command: "rm -- 'd'" } },
    ]);
  });

  it('quotes paths so a crafted name stays one argument', () => {
    const [call] = host.codexCalls({ tool_name: 'apply_patch', tool_input: { command: "*** Begin Patch\n*** Delete File: a'; echo b\n*** End Patch" } });
    assert.strictEqual(call.input.command, "rm -- 'a'\\''; echo b'");
  });

  it('checks every patch block in a shell command', () => {
    const cmd = `apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: a.md\n+x\n*** End Patch\nEOF\napply_patch <<'EOF'\n*** Begin Patch\n*** Add File: .env.production\n+K=1\n*** End Patch\nEOF`;
    const files = host.codexCalls({ tool_name: 'Bash', tool_input: { command: cmd } }).filter((c) => c.tool === 'Write').map((c) => c.input.file_path);
    assert.deepStrictEqual(files, ['a.md', '.env.production']);
  });

  it('refuses a shell apply_patch whose patch is not inline', () => {
    for (const command of ['applypatch < p.txt', 'apply_patch "$(cat /tmp/p.txt)"', 'cat p.txt | apply_patch', "sh -c 'apply_patch < p.txt'", '/usr/local/bin/apply_patch < p.txt']) {
      assert.ok(host.codexCalls({ tool_name: 'Bash', tool_input: { command } }).some((c) => c.unreadable), command);
    }
  });

  it('keeps an End Patch context line inside the shell heredoc', async () => {
    const command = "apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: a.js\n@@\n keep\n *** End Patch\n*** Add File: .env.production\n+PLACEHOLDER=1\n*** End Patch\nEOF";
    const r = await run({ tool_name: 'Bash', tool_input: { command }, cwd: WORK });
    assert.strictEqual(r.code, 2);
    assert.match(r.stderr, /\[env-file\]/);
  });

  it('allows literal marker text and shell metacharacters in a quoted heredoc', async () => {
    const command = 'applypatch <<"PATCH"\n*** Begin Patch\n*** Add File: notes.md\n+*** End Patch\n+$HOME `date` $(date)\n*** End Patch\nPATCH';
    const r = await run({ tool_name: 'Bash', tool_input: { command }, cwd: WORK });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(host.patchBlocks(command)[0].split('\n').length, 5);
  });

  it('refuses a file-fed patch even beside an unrelated literal block', async () => {
    const patch = "<<'EOF'\n*** Begin Patch\n*** Add File: harmless.md\n+ok\n*** End Patch\nEOF";
    for (const command of [`apply_patch ${patch}\napply_patch < other.patch`, `cat ${patch}\napply_patch "$(cat other.patch)"`]) {
      const r = await run({ tool_name: 'Bash', tool_input: { command }, cwd: WORK });
      assert.strictEqual(r.code, 2, command);
      assert.match(r.stderr, /\[unreadable-patch\]/);
    }
  });

  it('refuses shell expansion and early heredoc termination', async () => {
    for (const command of [
      'TARGET=.env.production; apply_patch <<EOF\n*** Begin Patch\n*** Add File: $TARGET\n+X=1\n*** End Patch\nEOF',
      'apply_patch "*** Begin Patch\n*** Add File: $TARGET\n+X=1\n*** End Patch"',
      "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: a\n+x\nEOF\n*** End Patch\nEOF",
      "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: a\n+x\n*** End Patch\nEOF\ncat other.patch | apply_patch",
    ]) {
      const r = await run({ tool_name: 'Bash', tool_input: { command }, cwd: WORK });
      assert.strictEqual(r.code, 2, command);
      assert.match(r.stderr, /\[unreadable-patch\]/);
    }
  });

  it('refuses detected patch calls in shell control flow and wrappers', async () => {
    for (const command of [
      "bash -lc 'apply_patch < p.txt'", 'if true; then apply_patch < p.txt; fi',
      'for x in 1; do apply_patch < p.txt; done', '{ apply_patch < p.txt; }', '! apply_patch < p.txt',
      "'apply_patch' < p.txt", '\\apply_patch < p.txt', "ap'ply_'patch < p.txt",
      'apply_\\\npatch < p.txt', 'X=1 apply_patch < p.txt', 'env X=1 apply_patch < p.txt',
    ]) {
      const r = await run({ tool_name: 'Bash', tool_input: { command }, cwd: WORK });
      assert.strictEqual(r.code, 2, command);
      assert.match(r.stderr, /\[unreadable-patch\]/);
    }
  });

  it('does not treat patch text in an ordinary command as a patch', () => {
    for (const command of ['grep -rn "*** Begin Patch" src/', 'grep apply_patch src/', 'echo applypatch-notes > x']) {
      assert.deepStrictEqual(host.codexCalls({ tool_name: 'Bash', tool_input: { command } }), [{ tool: 'Bash', input: { command } }], command);
    }
  });

  it('has no opinion on other tools', () => {
    assert.deepStrictEqual(host.codexCalls({ tool_name: 'mcp__x__y', tool_input: {} }), []);
  });
});

describe('host.hostFromArgv()', () => {
  it('defaults to claude and accepts only known hosts', () => {
    assert.strictEqual(host.hostFromArgv(['node', 'x']), 'claude');
    assert.strictEqual(host.hostFromArgv(['node', 'x', '--host', 'codex']), 'codex');
    assert.strictEqual(host.hostFromArgv(['node', 'x', '--host', 'other']), 'claude');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Manifests
// ─────────────────────────────────────────────────────────────────────────────

describe('Codex manifest', () => {
  const codex = JSON.parse(fs.readFileSync(path.join(PACK_DIR, '.codex-plugin', 'plugin.json'), 'utf8'));
  const claude = JSON.parse(fs.readFileSync(path.join(PACK_DIR, '.claude-plugin', 'plugin.json'), 'utf8'));
  const hooks = JSON.parse(fs.readFileSync(path.join(PACK_DIR, codex.hooks), 'utf8'));

  it('shares the name and version with the Claude Code manifest', () => {
    assert.strictEqual(codex.name, claude.name);
    assert.strictEqual(codex.version, claude.version);
  });

  it('registers the Codex host on Bash and apply_patch', () => {
    const [group] = hooks.hooks.PreToolUse;
    assert.strictEqual(group.matcher, 'Bash|apply_patch');
    assert.ok(group.hooks[0].command.endsWith('--host codex'), group.hooks[0].command);
    assert.ok(group.hooks[0].command.includes('${PLUGIN_ROOT}/guard-pack.js'));
    assert.ok(!group.hooks[0].async);
  });
});
