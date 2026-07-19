# pr-provenance-stamp

> Stamps a provenance receipt — prompts, estimated spend, tests run with exit codes, and a truthful agent-authored line split — into your PR body on `gh pr create`.

A PostToolUse hook keeps a per-session ledger: tool-call count, agent-authored line count, and every test/typecheck/lint command with its real exit code. When Claude runs `gh pr create` (or `glab mr create`), a PreToolUse (Bash) hook reads the session transcript for the real prompt count, estimated token/dollar spend, and models, asks git for the branch's total added lines to derive an agent-vs-human split, then appends a one-line receipt to the PR `--body`. If the command builds its body with a heredoc, `$(...)`, backticks, or process substitution, the hook defers and leaves the command untouched rather than risk corrupting it.

## Install

```
/plugin marketplace add karanb192/claude-code-hooks   # once per machine
/plugin install pr-provenance-stamp@claude-code-hooks
```

Restart Claude Code — done. (Or from a shell: `claude plugin install pr-provenance-stamp@claude-code-hooks`.)

## What it does

| Event | Runs | What happens |
|-------|------|--------------|
| PostToolUse (`Edit\|MultiEdit\|Write\|Bash`) | async (zero added latency) | Updates the session ledger — tool-call count, agent-authored line count, and each test/typecheck command with its real exit code. |
| PreToolUse (`Bash`) | sync | On `gh pr create` / `glab mr create`, rewrites the `--body` to append the receipt (prompt count, est. spend, test tally, agent-vs-human line split). Defers on unsafe shell constructs. |

`/pr-provenance-stamp:provenance` — renders the current session's receipt exactly as it would be stamped into a PR body, without creating one.

## Configuration

No configuration needed. State is stored per session at `~/.claude/pr-provenance-stamp/<session_id>.json` (hook logs at `~/.claude/hooks-logs/`).

## Data & privacy

Records tool-call counts, test commands with exit codes, agent line counts, and transcript-derived prompt/spend estimates. Everything is read and computed on your machine — the hook makes no network calls of its own; it only shells out to `git` for the line diff. It does rewrite the `--body` of your `gh pr create` command, so the receipt text becomes part of the public PR description that gets published to GitHub.

## Uninstall

```
/plugin uninstall pr-provenance-stamp@claude-code-hooks
```
