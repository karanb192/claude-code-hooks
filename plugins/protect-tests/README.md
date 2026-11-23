# protect-tests

> Stops "fake green": blocks an agent from making a suite pass by deleting, renaming-away, or skip-disabling tests instead of fixing the code.

A `PreToolUse` hook fires before every `Bash`, `Edit`, `MultiEdit`, and `Write` call and denies the ones that remove or disable tests: `rm` / `git rm` of a test file or test directory, `mv` of a test file to a disabled name (`.bak`, `.disabled`, ...), an edit that introduces a skip/xfail/ignore marker into an existing test (through `Edit`, a whole-file `Write`, or a shell in-place edit or redirect such as `sed -i`, `perl -pi`, `>`, `>>` or `tee`), and (at the `strict` level) writing a brand-new test file that is already skipped. Test paths and skip markers are matched across pytest, unittest, jest/mocha/vitest, Go, JUnit/TestNG, NUnit/MSTest, RSpec, and Rust. A file counts as a test by its folder (`tests/`, `__tests__/`, `spec/`, a .NET `*.Tests/` project), by its name (`*.test.*`, `*_test.*`, `test_*.py`, `*_spec.rb`, `*Test.java`, `*Tests.cs` and the like), and, for skip markers added by an edit, by test definitions in its own text (`#[test]`, `@Test`, `[Test]`, `def test_`), so ignoring a Rust unit test inline in `src/` is caught. Shell operands may be globs: `rm *.test.js` and `rm test_*.py` are deletes of tests when the glob is an operand of the delete itself. It does NOT block writing new, real tests, refactor-renaming a test to another test name, or editing test bodies: only removal and disabling.

## Install

```
/plugin marketplace add karanb192/claude-code-hooks   # once per machine
/plugin install protect-tests@claude-code-hooks
```

Restart Claude Code, done. (Or from a shell: `claude plugin install protect-tests@claude-code-hooks`.)

## Codex CLI

```sh
codex plugin marketplace add karanb192/claude-code-hooks
codex plugin add protect-tests@claude-code-hooks
```

Open `/hooks` in Codex and approve this plugin. Re-approve after every update; Codex skips unapproved or changed hooks. Do not install it alongside [guard-pack](../guard-pack#codex-cli), which includes this guard.

This entry point checks `Bash` and native `apply_patch` calls. Patch files are checked individually; unreadable patches are blocked. Shell patches must use a plain command with a quoted heredoc; `apply_patch` anywhere else in a command, such as behind `timeout` or `eval`, is blocked. Literal searches and commit messages mentioning `apply_patch` pass. See [the shared adapter's limits](../guard-pack#codex-cli), including shell sessions and dynamically constructed commands.

Export configuration variables before launching Codex. An ask-mode match becomes a block because Codex hooks cannot ask. Logs stay in `~/.claude/hooks-logs/` with `host: "codex"`, including on Codex-only machines.

## What it does

| Tool | Blocked when | Level | Deny id |
|------|--------------|-------|---------|
| `Bash` | `rm` / `unlink` / `shred` / `trash` / `git rm` targets a test file or test directory (`tests/` or a bare `tests`), `find` deletes test files (`-delete`, `-exec rm`), or `mv` / `git mv` moves tests into `/tmp`, `/var/tmp`, `/private/var/tmp`, `$TMPDIR`, `$(mktemp -d)`, `~/.Trash` or `/dev/null` (including `mv -t DIR`) | `critical` | `delete-test` |
| `Bash` | `mv` / `git mv` renames a test file to a disabled name (`.bak`, `.backup`, `.old`, `.orig`, `.disabled`, `.off`, `.skip`, `.skipped`, `.ignore`, `.ignored`, `.tmp`, `~`, also as `a.test.js{,.bak}`), renames it from a test name to a name the runner does not collect (`a.test.js` to `a.js`), or renames a test folder to a non-test name | `high` | `rename-test` |
| `Edit` / `MultiEdit` | the edit adds a skip/xfail/ignore marker to an existing test file, judged on the file as it will be after the edit (so `.skip` inserted right after `it` counts) | `high` | `skip-test` |
| `Write` | it rewrites an existing test file and the new content has more skip/xfail/ignore markers than the file on disk | `high` | `skip-test` |
| `Bash` | `sed -i`, `perl -pi`, `ruby -pi` or `awk -i inplace` writes a marker into a test file named in the same command (a glob such as `find -name '*.test.js' \| xargs sed -i` counts), or `>`, `>>`, `>\|` or `tee` (any flags, any file operand) writes one into a test file, or a script's output is moved, copied or redirected back over a test file | `high` | `skip-test` |
| `Write` | a brand-new test file's content is already skipped/ignored | `strict` | `write-skipped-test` |

The markers recognised include pytest `@pytest.mark.skip`/`skipif`/`xfail` (also as `pytestmark = ...` and `@mark.skip`) and `pytest.skip(`/`pytest.xfail(`; unittest `@unittest.skip*`, `@unittest.expectedFailure` and `self.skipTest(`; jest/mocha/vitest `.skip`, `.skipIf`, `.todo` (also after `.each` or `.concurrent`), `xit(` and `this.skip()`; Go `t.Skip(`, `t.Skipf(`, `t.SkipNow(`; JUnit `@Disabled*` and `@Ignore`, TestNG `@Test(enabled = false)`; NUnit/MSTest `[Ignore]` with or without a reason, xUnit `Skip =`; RSpec `xit 'name'`, `skip '...'` and `pending '...'`; Rust `#[ignore]` and `#[ignore = "..."]`. A line break or spaces around a dot do not hide one.

Markers are counted, not just detected, so adding a second `it.skip(` to a file that already has one still counts. Direct edits that remove skips are allowed. For `Write` and shell redirects the hook reads the target file (relative paths resolve against the session's working directory; files over 2 MB are not read). Each complete command joined by `;`, `&&`, `||` or `&` is judged on its own, in the directory an earlier `cd` or `pushd` in the same command moved to: after `cd tests`, `rm -r unit` is a delete of tests and `> a.test.js` writes `tests/a.test.js`. Clearing build and cache output there (`__pycache__`, `*.pyc`, `node_modules`, `coverage`, `*.log`) is allowed. Groups and continued pipelines, including a comment after `|`, keep their output with the destination. Literal braces in command arguments do not join unrelated commands.

For a small, literal `sed` substitution, `perl -pe` substitution, or `grep` filter with one source file and one redirect or `tee` destination, the hook reads the source and compares the resulting content. This allows a command that removes all skips while still denying a positive `grep` that copies skipped tests. Output inference supports a restricted pattern syntax and ASCII text, with limits on command length, matching work and output size. Unsupported commands use the command-text heuristic, so they may be conservatively denied. Search-looking text inside `printf` arguments or heredocs is always treated as literal content, not stripped away.

An in-place replacement counts when it completes a marker with the text around it (`s/test/test.skip/` on `test(`) or through a backreference (`s/^(it)\(/\1.skip(/`, `s/^it/x&/`). The script is read for `s` commands with any delimiter and perl's `s{}{}`, sed `a`, `i` and `c` text commands, perl `print`, and ruby or awk `sub`/`gsub`. This remains a guardrail, not a shell evaluator or sandbox: arbitrary language scripts, `cp` of a skipped file over a test, and a heredoc that creates a brand-new skipped file still pass at `high`.

Anything at or below the active safety level is denied with a reason Claude sees ("Fix the code, don't disable the test"); everything else passes through. On malformed input the hook fails open (emits `{}`), so it can never wedge a session.

## Safety levels

| Level | Blocks |
|-------|--------|
| `critical` | deleting test files or whole test directories (rm / git rm) |
| `high` (default) | + renaming a test file to a disabled name, + adding a skip/xfail/ignore marker to an existing test, by any of Edit, Write or a shell edit |
| `strict` | + writing a whole new test file that is already skipped |

## Configuration

One optional environment variable:

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOOK_SAFETY_LEVEL` | `high` | Safety level: `critical`, `high`, or `strict`. Any other value falls back to `high`. Set it via env (shell profile, or inline in a hook command), not by editing the installed script: plugin updates overwrite plugin files. |
| `HOOK_FAIL_OPEN` | unset (deny) | The literal string `true` lets the call through when the guard's own check throws, instead of denying it. See [When the guard fails](#when-the-guard-fails). |

## How it registers

`hooks/hooks.json` registers one `PreToolUse` hook with matcher `Bash|Edit|MultiEdit|Write`, running synchronously (a deny decision has to land before the tool executes).

## When the guard fails

From 1.3.0, a guard that cannot finish its check refuses the call instead of allowing it. A check that throws is denied with a `[guard-error]` reason. A timeout (10 s) or a missing `node` is blocked by `"onFailure": "block"` on Claude Code v2.1.295 or later; older versions ignore that key and let the call run. On Codex a missing `node` is blocked by the command's `|| exit 2`, but a timeout still lets the call run, because Codex has no setting for it. Set `HOOK_FAIL_OPEN=true` to let the call through when the check throws; [When a guard fails](../../README.md#-when-a-guard-fails) covers the rest of the way back.

## Data & privacy

Blocked calls and parse errors are logged as JSONL to `~/.claude/hooks-logs/YYYY-MM-DD.jsonl` (deny id, level, tool name, session id, cwd, permission mode; no commands or file contents, though a parse error's message can quote the first few characters of a malformed payload). The script reads the target test file and, for supported literal shell transformations, the source file. It never runs the proposed command, and nothing leaves your machine.

## Uninstall

```
/plugin uninstall protect-tests@claude-code-hooks
```

Part of [claude-code-hooks](https://github.com/karanb192/claude-code-hooks), a marketplace of production-ready Claude Code hooks.
