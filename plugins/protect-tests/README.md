# protect-tests

> Stops "fake green": blocks an agent from making a suite pass by deleting, renaming-away, or skip-disabling tests instead of fixing the code.

A `PreToolUse` hook fires before every `Bash`, `Edit`, `MultiEdit`, and `Write` call and denies the ones that remove or disable tests: `rm` / `git rm` of a test file or test directory, `mv` of a test file to a disabled name (`.bak`, `.disabled`, ...), an edit that introduces a skip/xfail/ignore marker into an existing test, and (at the `strict` level) writing a brand-new test file that is already skipped. Test paths and skip markers are matched across pytest, unittest, jest/mocha/vitest, Go, JUnit/TestNG, NUnit/MSTest, RSpec, and Rust. It does NOT block writing new, real tests, refactor-renaming a test to another test name, or editing test bodies: only removal and disabling.

## Install

```
/plugin marketplace add karanb192/claude-code-hooks   # once per machine
/plugin install protect-tests@claude-code-hooks
```

Restart Claude Code, done. (Or from a shell: `claude plugin install protect-tests@claude-code-hooks`.)

## What it does

| Tool | Blocked when | Level | Deny id |
|------|--------------|-------|---------|
| `Bash` | `rm` / `unlink` / `shred` / `trash` / `git rm` targets a test file or test directory | `critical` | `delete-test` |
| `Bash` | `mv` renames a test file to a disabled name (`.bak`, `.old`, `.orig`, `.disabled`, `.skip`, `.ignore`, `.tmp`, `~`) | `high` | `rename-test` |
| `Edit` / `MultiEdit` | the edit adds a skip/xfail/ignore marker to an existing test file | `high` | `skip-test` |
| `Write` | the new test file's content is already skipped/ignored | `strict` | `write-skipped-test` |

Anything at or below the active safety level is denied with a reason Claude sees ("Fix the code, don't disable the test"); everything else passes through. On malformed input the hook fails open (emits `{}`), so it can never wedge a session.

## Safety levels

| Level | Blocks |
|-------|--------|
| `critical` | deleting test files or whole test directories (rm / git rm) |
| `high` (default) | + renaming a test file to a disabled name, + adding a skip/xfail/ignore marker to an existing test |
| `strict` | + writing a whole test file that is already skipped |

## Configuration

One optional environment variable:

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOOK_SAFETY_LEVEL` | `high` | Safety level: `critical`, `high`, or `strict`. Any other value falls back to `high`. Set it via env (shell profile, or inline in a hook command), not by editing the installed script: plugin updates overwrite plugin files. |

## How it registers

`hooks/hooks.json` registers one `PreToolUse` hook with matcher `Bash|Edit|MultiEdit|Write`, running synchronously (a deny decision has to land before the tool executes).

## Data & privacy

Blocked calls and parse errors are logged as JSONL to `~/.claude/hooks-logs/YYYY-MM-DD.jsonl` (deny id, level, tool name, session id, cwd, permission mode; no commands or file contents, though a parse error's message can quote the first few characters of a malformed payload). The script only uses `fs` and `path`, so nothing leaves your machine.

## Uninstall

```
/plugin uninstall protect-tests@claude-code-hooks
```

Part of [claude-code-hooks](https://github.com/karanb192/claude-code-hooks), a marketplace of production-ready Claude Code hooks.
