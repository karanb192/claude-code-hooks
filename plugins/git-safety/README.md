# git-safety

> Branch-aware git guardrails plus destructive gh CLI protection: denies the operations that rewrite shared history or close things you didn't mean to close.

A `PreToolUse` hook fires before every `Bash` call and checks the command against a tiered pattern list. On a match it returns `permissionDecision: "deny"` with the pattern id and reason, so Claude sees exactly why the command was refused. Branch-aware rules (`git commit`, `merge`, `rebase`, `reset`, `push` while on a protected branch) resolve the current branch via `git branch --show-current` at check time; everything else matches on the command text alone. Protected branches are `main` and `master`.

## Install

```
/plugin marketplace add karanb192/claude-code-hooks   # once per machine
/plugin install git-safety@claude-code-hooks
```

Restart Claude Code, done. (Or from a shell: `claude plugin install git-safety@claude-code-hooks`.)

## What it does

| Event | Runs | What happens |
|-------|------|--------------|
| PreToolUse (`Bash`) | sync | Checks the command against the active safety level's patterns; on a match, denies with the pattern id and reason, and appends a log row. Non-matching commands pass through untouched (`{}`). |

Blocked at the default `high` level:

- `git push` naming `main` or `master` (any flags)
- `git branch -d` / `-D` / `--delete` on `main` or `master`
- `git commit`, `git merge`, `git rebase`, `git reset`, `git push` while the current branch **is** `main` or `master`
- `gh pr merge`, `gh pr close`, `gh issue close`, `gh release delete`, `gh repo delete`

`strict` adds any force-push (`--force` or `-f`; `--force-with-lease` stays allowed). `critical` applies no git-safety rules at all, deferring entirely to `block-dangerous-commands`.

**Composition with `block-dangerous-commands`:** that hook already blocks force-push (any, and to main/master) and `git reset --hard` on any branch, so at `high` the two don't overlap. Run git-safety at `strict` if you use it on its own.

## Configuration

Optional, set via environment variable:

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOOK_SAFETY_LEVEL` | `high` | Safety level: `critical`, `high`, or `strict`. Invalid values fall back to `high`. |

| Level | What's blocked |
|-------|----------------|
| `critical` | Nothing from this hook (defer entirely to `block-dangerous-commands`) |
| `high` | Branch-aware guardrails, protected-branch deletion, pushes to main/master by name, destructive gh CLI operations |
| `strict` | All of `high` plus any force-push, so the hook is self-sufficient standalone |

The `SAFETY_LEVEL` constant in the script still exists, but prefer the env var: plugin updates overwrite installed files, so edits don't survive. This hook always denies; it has no ask mode.

## Data & privacy

Blocked commands are logged (with timestamp, pattern id, session id, cwd, and permission mode) to `~/.claude/hooks-logs/<date>.jsonl`. The only command it runs is `git branch --show-current`, locally; it makes no network calls.

## Uninstall

```
/plugin uninstall git-safety@claude-code-hooks
```

Part of [claude-code-hooks](https://github.com/karanb192/claude-code-hooks).
