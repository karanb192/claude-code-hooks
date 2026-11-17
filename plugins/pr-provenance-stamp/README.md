# pr-provenance-stamp

> Stamps a provenance receipt (prompts, estimated spend, tests run with exit codes, and a truthful agent-authored line split) into your PR body on `gh pr create`.

A PostToolUse hook keeps a per-session ledger: tool-call count, agent-authored line count, and every test/typecheck/lint command with whether it passed. A command that exits non-zero is recorded as failed with the exit code Claude Code reports, and one that exits zero is a pass; [the exceptions](#how-a-test-result-is-decided) are a runner that reports failures anyway and a command line that hides the exit status (`pytest | tail -3`). When Claude runs `gh pr create` (or `glab mr create`), a PreToolUse (Bash) hook reads the session transcript for the real prompt count, estimated token/dollar spend, and models, asks git for the branch's total added lines to derive an agent-vs-human split, then appends a one-line receipt to the PR `--body`. The hook never approves the command itself: it returns `ask`, so Claude Code shows you the rewritten command, receipt included, and you approve it. This means a stamped `gh pr create` prompts even when a permission rule would have allowed it. If the command builds its body with a heredoc, `$(...)`, backticks, or process substitution, the hook defers and leaves the command untouched rather than risk corrupting it.

## Install

```
/plugin marketplace add karanb192/claude-code-hooks   # once per machine
/plugin install pr-provenance-stamp@claude-code-hooks
```

Restart Claude Code, done. (Or from a shell: `claude plugin install pr-provenance-stamp@claude-code-hooks`.)

## What it does

| Event | Runs | What happens |
|-------|------|--------------|
| PostToolUse (`Edit\|MultiEdit\|Write\|Bash`) | async (zero added latency) | Appends to the session ledger: tool-call count, agent-authored line count, and each test/typecheck command that exited zero, checked against the runner's own summary. |
| PostToolUseFailure (`Bash`) | async (zero added latency) | Records a test/typecheck command that exited non-zero as failed, with the exit code Claude Code reports. |
| PreToolUse (`Bash`) | sync | On `gh pr create` / `glab mr create`, rewrites the `--body` to append the receipt (prompt count, est. spend, test tally, agent-vs-human line split). Defers on unsafe shell constructs. |

`/pr-provenance-stamp:provenance` renders the current session's receipt exactly as it would be stamped into a PR body, without creating one.

## How a test result is decided

Claude Code tells a hook the exit code only when a command fails, so the receipt reads each run this way:

| What happened | Receipt line |
|---|---|
| The command exited non-zero, or timed out | `exit N ✗`, with the code Claude Code reports |
| The command exited zero | `exit 0 ✓`, whatever words its output contains |
| The command exited zero but the runner's own summary reports failures (a script that swallows the status, such as `eslint . \|\| true`) | `failures in its output ✗` |
| The command line can hide the runner's status (a pipe, `;`, `\|\|`, `&`, a second line, a substitution or `!`, also inside a quoted script such as `sh -c 'npm test \|\| true'`) | Decided by the output: `failures in its output ✗`, `passed per its output ✓` when the runner's passing summary is there, otherwise `result not captured` |
| The command ran in the background, so no result reached the hook | `result not captured` |

A run whose result was not captured counts as neither green nor failing: `tests 3/3 green, 1 not captured`.

The summaries recognised are those of pytest, unittest, jest, vitest, mocha, `node --test`, `go test`, `cargo test`, rspec, eslint, tsc and Maven, matched only at the start of a line. A line the runner marked as passed is never read as a failure, so a passing test named "handles BUILD FAILURE" stays green. When the status is hidden, a failure is also read from words such as `FAILED` or `error:` on any other line. The check sees only what the pipe let through: `npm test | head -5` usually cuts the summary off and reads as not captured. Prefer `npm test 2>&1 | tail -20`, or no pipe at all.

## Configuration

No configuration needed. State is stored per session at `~/.claude/pr-provenance-stamp/<session_id>.jsonl`, one appended line per hook event, so hooks that run in parallel cannot overwrite each other (hook logs at `~/.claude/hooks-logs/`). A `<session_id>.json` ledger left by 1.0.x is still read.

## Data & privacy

Records tool-call counts, test commands with exit codes, agent line counts, and transcript-derived prompt/spend estimates. Everything is read and computed on your machine: the hook makes no network calls of its own; it only shells out to `git` for the line diff. It does rewrite the `--body` of your `gh pr create` command, so the receipt text becomes part of the public PR description that gets published to GitHub.

## Uninstall

```
/plugin uninstall pr-provenance-stamp@claude-code-hooks
```
