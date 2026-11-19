#!/usr/bin/env node
/**
 * The shell-reading block that block-dangerous-commands, git-safety and
 * protect-secrets each carry between the `>>> shell-reading` and
 * `<<< shell-reading` markers. Each plugin installs on its own, so the block
 * is copied, not shared at run time; this file pins the copies and tests what
 * the block reads. tests/shell-rewrites.test.js holds the command record.
 *
 * Run: node --test tests/shell-reading.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const GUARDS = ['block-dangerous-commands', 'git-safety', 'protect-secrets'];
const file = (g) => path.join(ROOT, 'plugins', g, `${g}.js`);
const block = (g) => {
  const s = fs.readFileSync(file(g), 'utf8');
  const a = s.indexOf('// >>> shell-reading');
  const b = s.indexOf('// <<< shell-reading');
  assert.ok(a >= 0 && b > a, `${g}: shell-reading markers missing`);
  return s.slice(a, b);
};
const mods = GUARDS.map((g) => require(file(g)));
const { shellViews } = mods[0];
const views = (cmd) => shellViews(cmd).map((v) => v.text);
const dropped = (cmd) => views(cmd)[0];
const read = (cmd) => views(cmd)[1];

describe('the copies agree', () => {
  it('the marked block is byte-identical in the three guards', () => {
    const first = block(GUARDS[0]);
    for (const g of GUARDS.slice(1)) assert.strictEqual(block(g), first, `${g} drifted from ${GUARDS[0]}; copy the block over`);
  });
  it('each guard answers the same views', () => {
    for (const cmd of ["r''m -rf ~", "cat > a.md <<'EOF'\nx\nEOF", 'git commit -m "a; b"']) {
      const want = JSON.stringify(shellViews(cmd));
      for (const m of mods) assert.strictEqual(JSON.stringify(m.shellViews(cmd)), want);
    }
  });
});

describe('reading words as bash splits them', () => {
  it('a command with no quotes, escapes, expansions or heredoc has one view', () => {
    assert.deepStrictEqual(views('git status && ls -la src/'), ['git status && ls -la src/']);
  });
  it('removes quotes and escapes inside a word', () => {
    assert.strictEqual(read("r''m -rf ~").trim(), 'rm -rf ~');
    assert.strictEqual(read('g\\it "push" origin ma\'in\'').trim(), 'git push origin main');
    assert.strictEqual(read("$'\\x72\\155' -rf ~").trim(), 'rm -rf ~');
  });
  it('keeps a quoted word with a space as typed, so prose stays prose', () => {
    assert.strictEqual(views('gemini -p "explain ~/.kube/config"').length, 1);
  });
  it('replaces $name with a value assigned earlier in the line', () => {
    assert.match(read('g=git; $g push'), /\bgit push\b/);
    assert.match(read("G='git push'; ${G} origin main"), /\bgit push origin main\b/);
    assert.match(read('export G=git; "$G" push'), /\bgit push\b/);
  });
  it('puts each substitution and the program of sh -c, eval or a shell heredoc on its own line', () => {
    assert.match(read('echo "$(r\'\'m -rf ~)"'), /^rm -rf ~$/m);
    assert.match(read("bash -lc \"r'm' -rf ~\""), /^rm -rf ~$/m);
    assert.match(read("eval 'r''m' -rf ~"), /^rm -rf ~$/m);
    assert.match(read("bash <<'EOF'\nr''m -rf ~\nEOF"), /^rm -rf ~$/m);
    assert.match(read('cat <<EOF\n$(rm -rf ~)\nEOF'), /^rm -rf ~$/m);
  });
});

describe('dropping text that only mentions a command', () => {
  it('drops a quoted heredoc body fed to a reader', () => {
    assert.strictEqual(dropped("cat > notes.md <<'EOF'\ngit push --force\nEOF"), "cat > notes.md <<'EOF'\nEOF");
    assert.strictEqual(dropped("cat <<-\"EOF\" | tee a.md\n\tgit push --force\n\tEOF"), 'cat <<-"EOF" | tee a.md\n\tEOF');
  });
  it('drops the quoted text of echo, printf, git commit and gh messages', () => {
    assert.strictEqual(dropped("echo 'rm -rf ~'"), "echo ''");
    assert.strictEqual(dropped("printf '%s' 'rm -rf ~' >&2"), "printf '' '' >&2");
    assert.strictEqual(dropped('git -C . commit -m "rm -rf ~"'), 'git -C . commit -m ""');
    assert.strictEqual(dropped("gh pr comment 3 --body 'gh pr merge'"), "gh pr comment 3 --body ''");
  });
  it('drops a heredoc inside the message of git commit', () => {
    assert.strictEqual(dropped("git commit -m \"$(cat <<'EOF'\nrm -rf ~\nEOF\n)\""), "git commit -m \"$(cat <<'EOF'\nEOF\n)\"");
  });
  it('keeps text that a shell can still run', () => {
    for (const cmd of [
      "echo 'rm -rf ~' | sh",                       // piped into a program
      "echo 'rm -rf ~' > run.txt",                  // echo into a file
      "echo 'rm -rf ~' | tee run.txt",              // the same through tee
      "cat <<EOF\n$HOME\nEOF",                      // an unquoted body expands
      "bash <<'EOF'\nrm -rf ~\nEOF",                // fed to a shell
      "python3 - <<'EOF'\nrm -rf ~\nEOF",           // fed to an interpreter
      "sudo tee /x <<'EOF'\nrm -rf ~\nEOF",         // behind a wrapper
      "cat > hook.sh <<'EOF'\nrm -rf ~\nEOF",       // into a script
      "$(cat <<'EOF'\nrm -rf ~\nEOF\n)",            // a substitution used as the command
      "cmd \"$(echo 'rm -rf ~')\"",                 // a substitution passed to an unknown command
      'git commit -m "$HOME rm -rf ~"',             // a message that expands
      "echo 'x'; bash run.sh",                      // a shell elsewhere in the line
      "echo() { :; }; echo 'rm -rf ~'",             // a function can redefine echo
      "alias e=echo\ne 'rm -rf ~'",                 // an alias can too
      "for x in 1; do echo 'rm -rf ~'; done",       // inside a loop
      "(echo 'rm -rf ~')",                          // inside a subshell
      "echo 'rm -rf ~",                             // an open quote
      "cat <<'EOF'\nrm -rf ~",                      // a heredoc with no end line
      "case x in x) echo 'rm -rf ~';; esac",        // case is not read
      "printf -v c 'rm -rf ~'",                     // printf into a variable
      "echo 'rm -rf ~' > >(cat)",                   // a process substitution
      "cat > x <<'EOF'\nrm -rf ~\nEOF\nPATH=.:$PATH x",  // run by name through PATH
      "cat > p <<'EOF'\nrm -rf ~\nEOF\nhash -p ./p git", // a name pointed at the file
      "cat > x <<'EOF'\nrm -rf ~\nEOF\nnohup ./x",      // a wrapper runs it
      "cat > x <<'EOF'\nrm -rf ~\nEOF\nfind . -exec ./x \\;", // find runs it
      "cat > /etc/cron.d/x <<'EOF'\nrm -rf ~\nEOF",     // the system runs it
      "cat >> .git/config <<'EOF'\nrm -rf ~\nEOF",      // git runs aliases and pagers from it
      "cat > x.mk <<'EOF'\nrm -rf ~\nEOF\nmake -f x.mk", // make runs it
      "cat > r <<'EOF'\nrm -rf ~\nEOF\nawk '{system($0)}' r", // awk runs it
      "git commit -m 'rm -rf ~' && npm test",           // any command outside the inert list
      "git -c core.pager=less commit -m 'rm -rf ~'",    // git with a config override
      "GIT_EDITOR=vi git commit -m 'rm -rf ~'",         // an assignment before the command
    ]) assert.strictEqual(dropped(cmd), cmd, JSON.stringify(cmd));
  });
});

// About 10k characters each: linear reading takes a few ms, a quadratic step
// would take seconds, and the bound leaves room for a loaded machine.
describe('reading stays linear and never throws', () => {
  const inputs = [
    '$('.repeat(1000) + 'x' + ')'.repeat(1000),
    '"$('.repeat(600),
    '`'.repeat(2000),
    "echo 'a'; ".repeat(1000),
    'a | '.repeat(1000) + 'sh',
    "cat <<'EOF'\n".repeat(400),
    'x=1; $x '.repeat(600),
    '( '.repeat(1000) + 'echo x',
    '{ '.repeat(1000) + 'echo x',
    'sh -c '.repeat(600) + "'x'",
    'eval '.repeat(600) + 'x',
    "$'".repeat(1000),
    '\\'.repeat(2001),
    '${'.repeat(1000),
    '$(('.repeat(1000),
    "cat <<'EOF'\nEOF\n".repeat(600) + 'echo "x"',
  ];
  for (const [n, input] of inputs.entries()) {
    it(`hostile input ${n + 1} (${JSON.stringify(input.slice(0, 16))}...) in under 500ms`, () => {
      const start = process.hrtime.bigint();
      for (const m of mods) m.shellViews(input);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      assert.ok(ms < 500, `${ms}ms`);
    });
  }
});
